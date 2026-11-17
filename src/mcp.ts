import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Config } from "./config";
import { exportGraphic } from "./export";
import { JobQueue, type Job } from "./jobs";
import { PRODUCT } from "./name";
import { checkCanvas, renderSvg } from "./render";
import { cleanSvg } from "./sanitize";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: unknown): Content => ({ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) });
const image = (png: Buffer): Content => ({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jobSummary(job: Job, withSvg: boolean) {
  return {
    job_id: job.id,
    state: job.state,
    progress: job.total ? `${job.step}/${job.total}` : "waiting",
    seconds: Math.round((Date.now() - job.started) / 1000),
    recent: job.log.slice(-6),
    error: job.error,
    folder: job.result?.dir,
    finalists: job.result?.finalists.map((f) => ({
      rank: f.rank,
      concept: f.concept,
      score: f.score,
      file: f.file,
      preview: f.preview,
      reviewer_notes: f.review?.problems,
      ...(withSvg ? { svg: f.svg } : {}),
    })),
  };
}

export async function runMcp(cfg: Config) {
  const queue = new JobQueue(cfg);
  const server = new McpServer({ name: PRODUCT.id, version: PRODUCT.version });

  server.registerTool(
    "make_graphic",
    {
      title: "Make a logo or icon",
      description:
        "Start drawing a logo/icon as SVG with local models: plans several directions, drafts each, renders and reviews them, " +
        "revises the weak ones, and keeps the best. Takes minutes, so it returns a job_id at once; then call graphic_status " +
        "until state is done. For changes to an existing result, pass start_svg plus feedback.",
      inputSchema: {
        brief: z.string().min(3).describe("What to draw: subject, feeling, where it will be used."),
        start_svg: z.string().optional().describe("Revision mode: the SVG to start from."),
        feedback: z.string().optional().describe("Revision mode: what to change."),
        candidates: z.number().int().min(1).max(8).optional().describe(`Directions to try (default ${cfg.candidates}).`),
        rounds: z.number().int().min(0).max(5).optional().describe(`Revision rounds per direction (default ${cfg.rounds}).`),
        keep: z.number().int().min(1).max(8).optional().describe(`Finalists to return (default ${cfg.keep}).`),
      },
    },
    async (a) => {
      const job = queue.start({ brief: a.brief, startSvg: a.start_svg, feedback: a.feedback, candidates: a.candidates, rounds: a.rounds, keep: a.keep });
      return { content: [text({ job_id: job.id, state: job.state, next: "Call graphic_status with this job_id (it waits up to wait_seconds for progress)." })] };
    },
  );

  server.registerTool(
    "graphic_status",
    {
      title: "Check a graphic job",
      description: "Progress of a make_graphic job. Waits up to wait_seconds for it to finish. When done, returns the finalists with SVG code and preview images.",
      inputSchema: {
        job_id: z.string(),
        wait_seconds: z.number().int().min(0).max(55).optional().describe("Wait this long for the job to finish (default 25)."),
        include_images: z.boolean().optional().describe("Attach preview PNGs of the finalists (default true)."),
      },
    },
    async (a) => {
      const job = queue.get(a.job_id);
      if (!job) return { isError: true, content: [text(`No job ${a.job_id}.`)] };
      const until = Date.now() + (a.wait_seconds ?? 25) * 1000;
      while (job.state === "running" && Date.now() < until) await sleep(500);
      const content: Content[] = [text(jobSummary(job, true))];
      if (job.state === "done" && a.include_images !== false) {
        for (const f of job.result!.finalists) content.push(image(renderSvg(f.svg, { size: 256, background: "white", fontDirs: cfg.fontDirs }).png));
      }
      return { content };
    },
  );

  server.registerTool(
    "stop_graphic",
    { title: "Stop a graphic job", description: "Stop a running make_graphic job.", inputSchema: { job_id: z.string() } },
    async (a) => {
      const job = queue.stop(a.job_id);
      return job ? { content: [text({ job_id: job.id, state: job.state, note: "Stopping after the current model call." })] } : { isError: true, content: [text(`No job ${a.job_id}.`)] };
    },
  );

  server.registerTool(
    "render_svg",
    {
      title: "Render SVG",
      description: "Clean an SVG, check it against the rules, and render it to PNG so you can look at it. Returns the cleaned SVG, problems found, and the images.",
      inputSchema: {
        svg: z.string(),
        sizes: z.array(z.number().int().min(8).max(1024)).max(4).optional().describe("Pixel sizes (default 32 and 256)."),
        background: z.string().optional().describe("CSS colour behind the drawing (default white)."),
      },
    },
    async (a) => {
      const c = cleanSvg(a.svg, { palette: cfg.palette, strictPalette: cfg.strictPalette, maxElements: cfg.maxElements, canvas: cfg.canvas });
      if (!c.svg) return { isError: true, content: [text({ errors: c.errors })] };
      const canvas = checkCanvas(c.svg, cfg.fontDirs);
      const sizes = a.sizes ?? [32, 256];
      const renders = sizes.map((size) => renderSvg(c.svg, { size, background: a.background ?? "white", fontDirs: cfg.fontDirs }));
      const dir = join(cfg.outDir, "renders");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `render-${Date.now()}.svg`);
      writeFileSync(file, c.svg);
      return {
        content: [
          text({ ok: c.ok && !canvas.problems.length, errors: c.errors, warnings: c.warnings, canvas: canvas.problems, colors: c.colors, shapes: c.elementCount, file, svg: c.svg }),
          ...renders.map((r) => image(r.png)),
        ],
      };
    },
  );

  server.registerTool(
    "export_graphic",
    {
      title: "Export a graphic",
      description: "Write the final files for an SVG: clean SVG, PNGs at standard sizes, a dark-mode variant (from the palette), and an .ico.",
      inputSchema: { svg: z.string(), name: z.string().min(1).describe("Base file name, e.g. 'acme-logo'.") },
    },
    async (a) => {
      try {
        const r = exportGraphic(cfg, a.svg, a.name);
        return { content: [text(r)] };
      } catch (e) {
        return { isError: true, content: [text((e as Error).message)] };
      }
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`${PRODUCT.title} MCP server ready (coder: ${cfg.coder.model}, vision: ${cfg.vision.model}).`);
}
