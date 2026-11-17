import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig, programDir, type Config } from "../src/config";
import { buildIco, darkVariant, exportGraphic } from "../src/export";
import { makeGraphic, reviewSvg } from "../src/loop";
import { checkCanvas, renderSvg } from "../src/render";
import { cleanSvg, extractSvg } from "../src/sanitize";
import { GOOD_SVG, startFakeModel } from "./fake-model";

const PALETTE = [
  { name: "ink", value: "#1F2937", dark: "#E5E7EB" },
  { name: "accent", value: "#0F766E", dark: "#2DD4BF" },
];

let fake: ReturnType<typeof startFakeModel>;
let dir: string;
let cfgFile: string;
let cfg: Config;

beforeAll(() => {
  fake = startFakeModel();
  dir = mkdtempSync(join(tmpdir(), "svgloop-test-"));
  cfgFile = join(dir, "svgloop.config.json");
  writeFileSync(cfgFile, JSON.stringify({
    coder: { baseURL: fake.url, model: "fake" },
    palette: PALETTE,
    outDir: "out",
    examplesDir: "examples",
    candidates: 2, rounds: 1, keep: 1,
  }));
  cfg = loadConfig(cfgFile);
});
afterAll(() => fake.stop());

describe("config without a file", () => {
  // A developer's own svgloop.config.json in the repo root would be found "next to the program".
  test.skipIf(existsSync(join(programDir(), "svgloop.config.json")))("env vars alone are enough; shipped examples are used; output goes to ~/SVGLoop", () => {
    const cwd = process.cwd();
    const empty = mkdtempSync(join(tmpdir(), "svgloop-empty-"));
    process.chdir(empty);
    process.env.SVGLOOP_BASE_URL = "http://127.0.0.1:3/v1";
    process.env.SVGLOOP_MODEL = "m3";
    try {
      const c = loadConfig();
      expect(c.coder.model).toBe("m3");
      expect(c.vision.baseURL).toBe("http://127.0.0.1:3/v1");
      expect(existsSync(join(c.examplesDir, "orbit-badge.svg"))).toBe(true);
      expect(existsSync(c.styleFile!)).toBe(true);
      expect(c.outDir).toBe(join(homedir(), "SVGLoop"));
      process.env.SVGLOOP_OUT_DIR = join(empty, "results");
      expect(loadConfig().outDir).toBe(join(empty, "results"));
      process.env.SVGLOOP_EXTRA_BODY = '{"chat_template_kwargs":{"enable_thinking":false}}';
      expect(loadConfig().vision.extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
      process.env.SVGLOOP_EXTRA_BODY = "not json";
      expect(() => loadConfig()).toThrow("EXTRA_BODY");
    } finally {
      process.chdir(cwd);
      delete process.env.SVGLOOP_BASE_URL;
      delete process.env.SVGLOOP_MODEL;
      delete process.env.SVGLOOP_OUT_DIR;
      delete process.env.SVGLOOP_EXTRA_BODY;
    }
  });
});

describe("config", () => {
  test("{env:NAME} and SVGLOOP_* overrides reach both endpoints", () => {
    const f = join(dir, "env.config.json");
    writeFileSync(f, "﻿" + JSON.stringify({ coder: { baseURL: "{env:LW_TEST_URL}", model: "m1", apiKey: "{env:LW_TEST_KEY}" } }));
    process.env.LW_TEST_URL = "http://127.0.0.1:1/v1";
    process.env.LW_TEST_KEY = "k1";
    let c = loadConfig(f);
    expect(c.coder.baseURL).toBe("http://127.0.0.1:1/v1");
    expect(c.vision.apiKey).toBe("k1");
    process.env.SVGLOOP_BASE_URL = "http://127.0.0.1:2/v1";
    process.env.SVGLOOP_MODEL = "m2";
    process.env.SVGLOOP_VISION_MODEL = "v2";
    try {
      c = loadConfig(f);
      expect(c.coder.baseURL).toBe("http://127.0.0.1:2/v1");
      expect(c.coder.model).toBe("m2");
      expect(c.vision.baseURL).toBe("http://127.0.0.1:2/v1");
      expect(c.vision.model).toBe("v2");
    } finally {
      delete process.env.SVGLOOP_BASE_URL;
      delete process.env.SVGLOOP_MODEL;
      delete process.env.SVGLOOP_VISION_MODEL;
    }
  });
});

describe("clean-up", () => {
  test("removes scripts, handlers, foreign content and outside references", () => {
    const evil = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="x()">
      <script>alert(1)</script><foreignObject><div/></foreignObject>
      <image href="http://evil/x.png"/><use xlink:href="http://evil/s.svg#a"/><use href="#ok"/>
      <rect id="ok" width="5" height="5" fill="#0F766E" style="fill:url(http://evil/p)"/></svg>`;
    const r = cleanSvg(evil, { palette: PALETTE });
    expect(r.svg).not.toMatch(/script|onload|foreignObject|evil|<image/i);
    expect(r.svg).toContain('href="#ok"');
    expect(r.ok).toBe(true);
  });

  test("refuses DOCTYPE/ENTITY and broken XML", () => {
    expect(cleanSvg(`<!DOCTYPE svg [<!ENTITY x "y">]><svg/>`).ok).toBe(false);
    expect(cleanSvg(`<svg viewBox="0 0 1 1"><rect></svg>`).ok).toBe(false);
  });

  test("flags off-palette colours, too many shapes, and adds a viewBox", () => {
    const shapes = Array.from({ length: 30 }, (_, i) => `<circle cx="${i}" cy="5" r="1" fill="red"/>`).join("");
    const r = cleanSvg(`<svg width="40" height="10">${shapes}</svg>`, { palette: PALETTE, strictPalette: true, maxElements: 24 });
    expect(r.errors.some((e) => e.includes("palette"))).toBe(true);
    expect(r.errors.some((e) => e.includes("Too complex"))).toBe(true);
    expect(r.svg).toContain('viewBox="0 0 40 10"');
    expect(r.svg).not.toMatch(/width="40"/);
  });

  test("extracts SVG from a chatty reply with thinking", () => {
    expect(extractSvg("<think>hmm <svg></svg></think> Sure!\n```svg\n<svg a='1'><g/></svg>\n```")).toBe("<svg a='1'><g/></svg>");
    // fused fence and tag, seen from Gemma 4 12B
    expect(extractSvg('```svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><g/></svg>\n```')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><g/></svg>');
  });
});

describe("render and checks", () => {
  test("renders PNG at the asked size", () => {
    const r = renderSvg(GOOD_SVG, { size: 64 });
    expect(r.width).toBe(64);
    expect(r.png.subarray(1, 4).toString()).toBe("PNG");
  });
  test("loads fonts only for drawings with <text>, and then text still renders", () => {
    // Without text, renders must be fast (system fonts are not parsed).
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) renderSvg(GOOD_SVG, { size: 128 });
    expect(performance.now() - t0).toBeLessThan(2000);
    const withText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><text x="10" y="45" font-size="40" fill="#000">Ag</text></svg>`;
    expect(checkCanvas(withText).blank).toBe(false);
  }, 30_000);
  test("spots blank, tiny and cut-off drawings", () => {
    expect(checkCanvas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>`).blank).toBe(true);
    expect(checkCanvas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="5" fill="#000"/></svg>`).problems.join()).toContain("very small");
    expect(checkCanvas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="0" cy="50" r="40" fill="#000"/></svg>`).problems.join()).toContain("cut off");
    // nearly-touching strokes, as in a live Qwen draft
    expect(checkCanvas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M8 150 A120 120 0 0 1 248 150" fill="none" stroke="#000" stroke-width="12"/></svg>`).problems.join()).toContain("edge");
    // same, on a full white background rect (which used to hide it)
    expect(checkCanvas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#FFFFFF"/><path d="M8 150 A120 120 0 0 1 248 150" fill="none" stroke="#000" stroke-width="12"/></svg>`).problems.join()).toContain("edge");
    expect(checkCanvas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#0F766E"/><circle cx="128" cy="128" r="80" fill="#FFFFFF"/></svg>`).problems).toEqual([]);
    // rounded app-icon tile (transparent corners), as in the live Qwen draft
    expect(checkCanvas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="56" fill="#FFFFFF"/><path d="M0 156 A128 128 0 0 1 256 156" fill="none" stroke="#0F766E" stroke-width="12"/></svg>`).problems.join()).toContain("edge");
    expect(checkCanvas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="56" fill="#1F2937"/><circle cx="128" cy="128" r="80" fill="#0F766E"/></svg>`).problems).toEqual([]);
    expect(checkCanvas(GOOD_SVG).problems).toEqual([]);
  });
});

describe("export", () => {
  test("writes svg, dark variant, pngs and a valid ico", () => {
    const r = exportGraphic(cfg, GOOD_SVG, "test logo", { sizes: [16, 64] });
    const names = r.files.map((f) => f.split(/[\\/]/).pop());
    expect(names).toEqual(["test-logo.svg", "test-logo-16.png", "test-logo-64.png", "test-logo-dark.svg", "test-logo-dark-16.png", "test-logo-dark-64.png", "test-logo.ico"]);
    expect(readFileSync(r.files[3]!, "utf8")).toContain("#2DD4BF");
    const ico = readFileSync(r.files[6]!);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(4);
  });
  test("dark variant is undefined when nothing changes", () => {
    expect(darkVariant(`<svg><rect fill="#123456"/></svg>`, cfg)).toBeUndefined();
    expect(buildIco([]).length).toBe(6);
  });
});

describe("loop (fake model)", () => {
  test("plans, drafts, reviews, revises and ranks", async () => {
    const events: string[] = [];
    const r = await makeGraphic(cfg, { brief: "a logo for a tool library" }, (e) => events.push(e.phase));
    expect(fake.seen.filter((s) => s === "spec").length).toBe(1);
    expect(fake.seen.filter((s) => s === "draw").length).toBe(2);
    expect(fake.seen.filter((s) => s === "fix").length).toBe(2); // both scored 5 in round 0
    expect(r.finalists.length).toBe(1);
    expect(r.finalists[0]!.score).toBe(9);
    expect(r.finalists[0]!.svg).not.toContain("script");
    expect(existsSync(r.finalists[0]!.preview)).toBe(true);
    expect(existsSync(join(r.dir, "result.json"))).toBe(true);
    expect(events).toContain("revise");
    // revisions are told what to keep, not only what to fix
    expect(fake.fixPrompts[0]).toContain("Keep these strengths");
    expect(fake.fixPrompts[0]).toContain("Bold circle silhouette");
    expect(fake.fixPrompts[0]).toContain("a viewer sees it as: a circle and a square");
    expect(r.finalists[0]!.review?.seen).toBe("a centred mark");
  });

  test("reviewer judges the brief: a mark that misses it is capped at 4", async () => {
    const r = await reviewSvg(cfg, "OFFBRIEF logo", "anything", GOOD_SVG);
    expect(r?.matches_brief).toBe(false);
    expect(r?.score).toBe(4);
    expect(r?.strengths).toEqual(["clean"]);
  });
});

describe("MCP server", () => {
  test("lists tools, renders, and runs a job to completion", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"), "mcp", "--config", cfgFile], stderr: "pipe" });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["export_graphic", "graphic_status", "make_graphic", "render_svg", "stop_graphic"]);

      const rendered: any = await client.callTool({ name: "render_svg", arguments: { svg: GOOD_SVG } });
      expect(rendered.content.filter((c: any) => c.type === "image").length).toBe(2);

      const started: any = await client.callTool({ name: "make_graphic", arguments: { brief: "a mark for a bakery", candidates: 1, rounds: 0 } });
      const { job_id } = JSON.parse(started.content[0].text);
      const status: any = await client.callTool({ name: "graphic_status", arguments: { job_id, wait_seconds: 20 } });
      const s = JSON.parse(status.content[0].text);
      expect(s.state).toBe("done");
      expect(s.finalists[0].svg).toContain("<svg");
      expect(status.content.some((c: any) => c.type === "image")).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
