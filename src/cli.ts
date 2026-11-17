import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, requireModels } from "./config";
import { exportGraphic } from "./export";
import { makeGraphic } from "./loop";
import { chat } from "./model";
import { runMcp } from "./mcp";
import { PRODUCT } from "./name";
import { checkCanvas, renderSvg } from "./render";
import { cleanSvg } from "./sanitize";

const HELP = `${PRODUCT.title} ${PRODUCT.version}: logos and icons as SVG, drawn by your local models.

Usage:
  ${PRODUCT.id} make --brief "..." [--candidates 3] [--rounds 2] [--keep 2]
  ${PRODUCT.id} make --brief "..." --start logo.svg --feedback "rounder, less blue"
  ${PRODUCT.id} render <file.svg> [--sizes 32,256] [--out dir]
  ${PRODUCT.id} validate <file.svg>
  ${PRODUCT.id} export <file.svg> [--name acme-logo]
  ${PRODUCT.id} ping           check that the coder and vision endpoints answer
  ${PRODUCT.id} mcp            run as an MCP server over stdio

Options:
  --config <file>   config file (default: $${PRODUCT.envPrefix}_CONFIG, then ./${PRODUCT.configFile},
                    then ${PRODUCT.configFile} next to the program)
  --json            print results as JSON (for apps calling the command line)
  --version         print the version

Without a config file, set the model server with environment variables:
  ${PRODUCT.envPrefix}_BASE_URL   e.g. http://127.0.0.1:8080/v1 (any OpenAI-compatible server)
  ${PRODUCT.envPrefix}_MODEL      model name; it must accept images
  ${PRODUCT.envPrefix}_API_KEY    optional
  ${PRODUCT.envPrefix}_OUT_DIR    where results go (default: ~/${PRODUCT.outFolder})
`;

const { values: o, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    config: { type: "string" },
    brief: { type: "string" },
    start: { type: "string" },
    feedback: { type: "string" },
    candidates: { type: "string" },
    rounds: { type: "string" },
    keep: { type: "string" },
    sizes: { type: "string" },
    out: { type: "string" },
    name: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

const [cmd, file] = positionals;
const num = (s?: string) => (s === undefined ? undefined : Number(s));
const print = (human: string, data: unknown) => console.log(o.json ? JSON.stringify(data, null, 2) : human);

async function main() {
  if (o.version) { console.log(PRODUCT.version); return; }
  if (!cmd || o.help) { console.log(HELP); return; }
  const cfg = loadConfig(o.config);
  if (["mcp", "ping", "make"].includes(cmd)) requireModels(cfg);

  switch (cmd) {
    case "mcp":
      await runMcp(cfg);
      return;

    case "ping": {
      const out: Record<string, string> = {};
      for (const [role, ep] of [["coder", cfg.coder], ["vision", cfg.vision]] as const) {
        try {
          const t = Date.now();
          const r = await chat({ ...ep, maxTokens: 16, timeoutMs: 60_000 }, [{ role: "user", content: "Reply with the word ready." }]);
          out[role] = `ok in ${Date.now() - t} ms (${ep.model}): ${r.replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 40)}`;
        } catch (e) {
          out[role] = `FAILED: ${(e as Error).message}`;
          process.exitCode = 1;
        }
      }
      print(Object.entries(out).map(([k, v]) => `${k}: ${v}`).join("\n"), out);
      return;
    }

    case "make": {
      if (!o.brief) throw new Error("--brief is required.");
      const startSvg = o.start ? readFileSync(o.start, "utf8") : undefined;
      const r = await makeGraphic(
        cfg,
        { brief: o.brief, startSvg, feedback: o.feedback, candidates: num(o.candidates), rounds: num(o.rounds), keep: num(o.keep) },
        (e) => { if (!o.json) console.error(`[${e.step}/${e.total}] ${e.message}`); },
      );
      print(
        `\nDone in ${r.seconds}s with ${r.calls} model calls. Folder: ${r.dir}\n` +
          r.finalists.map((f) => `  #${f.rank} ${f.concept} (score ${f.score}): ${f.file}`).join("\n"),
        { dir: r.dir, seconds: r.seconds, calls: r.calls, finalists: r.finalists },
      );
      return;
    }

    case "validate": {
      if (!file) throw new Error("validate needs a file.");
      const c = cleanSvg(readFileSync(file, "utf8"), { palette: cfg.palette, strictPalette: cfg.strictPalette, maxElements: cfg.maxElements, canvas: cfg.canvas });
      const canvas = c.svg ? checkCanvas(c.svg, cfg.fontDirs) : undefined;
      const status = !c.ok ? "FAILED" : canvas?.problems.length ? "CHECK" : "OK";
      if (!c.ok) process.exitCode = 1;
      print(
        [`${status}: ${c.elementCount} shapes, colours ${c.colors.join(" ") || "none"}`,
          ...c.errors.map((e) => `error: ${e}`), ...c.warnings.map((w) => `warning: ${w}`),
          ...(canvas?.problems ?? []).map((p) => `canvas: ${p}`)].join("\n"),
        { ...c, canvas },
      );
      return;
    }

    case "render": {
      if (!file) throw new Error("render needs a file.");
      const c = cleanSvg(readFileSync(file, "utf8"), { canvas: cfg.canvas });
      if (!c.svg) throw new Error(c.errors.join(" "));
      const dir = o.out ?? join(cfg.outDir, "renders");
      mkdirSync(dir, { recursive: true });
      const sizes = (o.sizes ?? "32,256").split(",").map(Number);
      const files = sizes.map((size) => {
        const p = join(dir, `${basename(file, ".svg")}-${size}.png`);
        writeFileSync(p, renderSvg(c.svg, { size, fontDirs: cfg.fontDirs }).png);
        return p;
      });
      print(files.join("\n"), { files, warnings: c.warnings });
      return;
    }

    case "export": {
      if (!file) throw new Error("export needs a file.");
      const r = exportGraphic(cfg, readFileSync(file, "utf8"), o.name ?? basename(file, ".svg"), { dir: o.out });
      print(r.files.join("\n"), r);
      return;
    }

    default:
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`${PRODUCT.id}: ${(e as Error).message}`);
  process.exitCode = 1;
});
