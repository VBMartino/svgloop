import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { loadExamples, pickExamples, readStyle } from "./examples";
import { chat, parseJson, pngPart, type Part } from "./model";
import { drawMessages, fixMessages, reviewText, specMessages, type Concept, type Review } from "./prompts";
import { checkCanvas, renderSvg } from "./render";
import { cleanSvg, extractSvg } from "./sanitize";

export interface MakeRequest {
  brief: string;
  /** Revision mode: start from this SVG and apply the feedback. */
  startSvg?: string;
  feedback?: string;
  candidates?: number;
  rounds?: number;
  keep?: number;
}

export interface Version {
  round: number;
  svg: string;
  score: number;
  review?: Review;
  errors: string[];
  warnings: string[];
  canvasProblems: string[];
  file: string;
  preview: string;
}

export interface Candidate {
  index: number;
  concept: Concept;
  versions: Version[];
  best?: Version;
  failed?: string;
}

export interface MakeResult {
  brief: string;
  dir: string;
  finalists: { rank: number; concept: string; score: number; svg: string; file: string; preview: string; review?: Review }[];
  candidates: Candidate[];
  calls: number;
  seconds: number;
}

export type Progress = (e: { phase: string; message: string; step: number; total: number }) => void;

/** Lower is worse: a rule break costs more than an art-director complaint. */
const rank = (v: Version) => v.score - 3 * v.errors.length - (v.canvasProblems.length ? 1 : 0);

export async function makeGraphic(cfg: Config, req: MakeRequest, onProgress: Progress = () => {}, signal?: AbortSignal): Promise<MakeResult> {
  const t0 = Date.now();
  const n = Math.max(1, Math.min(8, req.candidates ?? cfg.candidates));
  const rounds = Math.max(0, Math.min(5, req.rounds ?? cfg.rounds));
  const keep = Math.max(1, Math.min(n, req.keep ?? cfg.keep));
  const style = readStyle(cfg.styleFile);
  const examples = loadExamples(cfg.examplesDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(cfg.outDir, `run-${stamp}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "brief.txt"), req.brief + (req.feedback ? `\n\nFeedback: ${req.feedback}` : ""));

  let calls = 0;
  let step = 0;
  const total = 1 + n + (rounds + 1) * n * 2;
  const tick = (phase: string, message: string) => onProgress({ phase, message, step: ++step, total });
  const check = () => { if (signal?.aborted) throw new Error("Stopped."); };

  // 1. Directions
  let concepts: Concept[];
  if (req.startSvg) {
    concepts = Array.from({ length: n }, (_, i) => ({
      name: `revision ${i + 1}`,
      idea: req.feedback ?? "refine the existing mark",
      shapes: "keep the existing construction",
      composition: "keep the existing layout unless the feedback says otherwise",
      colors: "palette",
    }));
    tick("plan", "Revision mode: skipping directions.");
  } else {
    check();
    calls++;
    const reply = await chat(cfg.coder, specMessages(cfg, req.brief, n, style), { json: true, signal });
    const parsed = parseJson<{ concepts: Concept[] }>(reply);
    concepts = (parsed?.concepts ?? []).filter((c) => c && c.idea).slice(0, n);
    while (concepts.length < n) {
      concepts.push({ name: `direction ${concepts.length + 1}`, idea: req.brief, shapes: "simple geometric primitives", composition: "centred, balanced", colors: "palette" });
    }
    writeFileSync(join(dir, "concepts.json"), JSON.stringify(concepts, null, 2));
    tick("plan", `Planned ${concepts.length} directions: ${concepts.map((c) => c.name).join(", ")}.`);
  }

  const cands: Candidate[] = concepts.map((concept, index) => ({ index, concept, versions: [] }));

  // 2. Drafts (all coder calls together, so a one-GPU server swaps models less)
  const pending = new Map<number, string>(); // candidate index -> raw svg awaiting review
  for (const c of cands) {
    check();
    try {
      let raw: string | undefined;
      for (let attempt = 0; attempt < 2 && !raw; attempt++) {
        calls++;
        const msgs = req.startSvg
          ? fixMessages(cfg, req.brief, req.startSvg, [req.feedback ?? "Refine it."], style)
          : drawMessages(cfg, req.brief, c.concept, pickExamples(examples, `${req.brief} ${c.concept.idea}`), style);
        const reply = await chat(cfg.coder, msgs, { signal });
        raw = extractSvg(reply);
        if (!raw) writeFileSync(join(dir, `c${c.index + 1}-draft${attempt}.noreply.txt`), reply);
      }
      if (!raw) throw new Error("The model returned no SVG twice.");
      pending.set(c.index, raw);
      tick("draft", `Drafted "${c.concept.name}".`);
    } catch (e) {
      if (signal?.aborted) throw e;
      c.failed = (e as Error).message;
      tick("draft", `Draft "${c.concept.name}" failed: ${c.failed}`);
    }
  }

  // 3. Review, then revise the ones that need it; repeat.
  for (let round = 0; round <= rounds && pending.size; round++) {
    const toFix: [Candidate, string[]][] = [];
    for (const [idx, raw] of pending) {
      check();
      const c = cands[idx]!;
      const v = await evaluate(cfg, req.brief, c, raw, round, dir, signal);
      calls += v.review ? 1 : 0;
      c.versions.push(v);
      if (!c.best || rank(v) > rank(c.best)) c.best = v;
      tick("review", `"${c.concept.name}" round ${round}: score ${v.score}${v.errors.length ? `, ${v.errors.length} rule breaks` : ""}.`);
      const done = v.errors.length === 0 && v.canvasProblems.length === 0 && v.score >= cfg.goodEnough;
      if (!done && round < rounds) {
        const issues = [...v.errors, ...v.canvasProblems, ...(v.review?.fixes ?? []), ...(v.review?.problems ?? [])].slice(0, 10);
        toFix.push([c, issues.length ? issues : ["Make it bolder, simpler and better balanced."]]);
      }
    }
    pending.clear();
    for (const [c, issues] of toFix) {
      check();
      try {
        calls++;
        // Revise from the best version so far, not the latest.
        const keepList = (c.best!.review?.strengths ?? []).slice(0, 4);
        const raw = extractSvg(await chat(cfg.coder, fixMessages(cfg, req.brief, c.best!.svg, issues, style, keepList, c.best!.review?.seen), { signal }));
        if (raw) pending.set(c.index, raw);
        tick("revise", `Revised "${c.concept.name}".`);
      } catch (e) {
        if (signal?.aborted) throw e;
        tick("revise", `Revision of "${c.concept.name}" failed: ${(e as Error).message}`);
      }
    }
  }

  // 4. Rank
  // Ties: a mark with no rule or canvas problems (usable as is) beats one that scored higher but needs fixing.
  const flaws = (v: Version) => v.errors.length + v.canvasProblems.length;
  const ranked = cands
    .filter((c) => c.best)
    .sort((a, b) => rank(b.best!) - rank(a.best!) || flaws(a.best!) - flaws(b.best!) || b.best!.score - a.best!.score)
    .slice(0, keep);
  const finalists = ranked.map((c, i) => {
    const v = c.best!;
    const file = join(dir, `final-${i + 1}.svg`);
    const preview = join(dir, `final-${i + 1}.png`);
    writeFileSync(file, v.svg);
    writeFileSync(preview, renderSvg(v.svg, { size: 512, fontDirs: cfg.fontDirs }).png);
    return { rank: i + 1, concept: c.concept.name, score: v.score, svg: v.svg, file, preview, review: v.review };
  });
  const result: MakeResult = { brief: req.brief, dir, finalists, candidates: cands, calls, seconds: Math.round((Date.now() - t0) / 1000) };
  writeFileSync(join(dir, "result.json"), JSON.stringify({ ...result, candidates: cands.map(({ versions, ...c }) => ({ ...c, versions: versions.map(({ svg, ...v }) => v) })) }, null, 2));
  return result;
}

async function evaluate(cfg: Config, brief: string, c: Candidate, raw: string, round: number, dir: string, signal?: AbortSignal): Promise<Version> {
  const cleaned = cleanSvg(raw, { palette: cfg.palette, strictPalette: cfg.strictPalette, maxElements: cfg.maxElements, canvas: cfg.canvas });
  const base = join(dir, `c${c.index + 1}-r${round}`);
  const file = `${base}.svg`;
  const preview = `${base}.png`;
  if (!cleaned.svg) {
    writeFileSync(`${base}.rejected.txt`, raw);
    return { round, svg: raw, score: 0, errors: cleaned.errors, warnings: cleaned.warnings, canvasProblems: [], file: `${base}.rejected.txt`, preview: "" };
  }
  writeFileSync(file, cleaned.svg);
  const canvas = checkCanvas(cleaned.svg, cfg.fontDirs);
  const renders = cfg.reviewSizes.map((size) => renderSvg(cleaned.svg, { size, background: "white", fontDirs: cfg.fontDirs }));
  writeFileSync(preview, renders[renders.length - 1]!.png);
  if (canvas.blank) {
    return { round, svg: cleaned.svg, score: 0, errors: cleaned.errors, warnings: cleaned.warnings, canvasProblems: canvas.problems, file, preview };
  }
  const review = await reviewSvg(cfg, brief, c.concept.idea, cleaned.svg, signal);
  const score = review ? review.score : 5;
  return { round, svg: cleaned.svg, score, review, errors: cleaned.errors, warnings: cleaned.warnings, canvasProblems: canvas.problems, file, preview };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map(String) : []);

/** Ask the vision model to review a cleaned SVG. Returns undefined if the reply can't be read. */
export async function reviewSvg(cfg: Config, brief: string, idea: string, svg: string, signal?: AbortSignal): Promise<Review | undefined> {
  // The reviewer sees small renders enlarged so it judges true small-size legibility.
  const images: Part[] = cfg.reviewSizes.map((size) =>
    pngPart(size < 128 ? renderUpscaled(svg, size, cfg) : renderSvg(svg, { size, background: "white", fontDirs: cfg.fontDirs }).png),
  );
  // One retry: a reply that can't be read would otherwise fall back to a neutral 5.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await chat(cfg.vision, [{ role: "user", content: [{ type: "text", text: reviewText(cfg, brief, idea, cfg.reviewSizes) }, ...images] }], { json: true, signal });
      const p = parseJson<Record<string, unknown>>(reply);
      const raw = Number(p?.score);
      if (!p || !Number.isFinite(raw)) continue;
      const matches = p.matches_brief !== false;
      // The scale puts "wrong for the brief" at 3-4, so a mark that misses the brief is capped there.
      const score = Math.max(0, Math.min(10, matches ? raw : Math.min(raw, 4)));
      return { seen: typeof p.seen === "string" ? p.seen : undefined, score, matches_brief: matches, strengths: list(p.strengths), problems: list(p.problems), fixes: list(p.fixes) };
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  return undefined;
}

/** Render at the small size, then show it 4x with hard pixels, so the reviewer judges true small-size legibility. */
function renderUpscaled(svg: string, size: number, cfg: Config): Buffer {
  const small = renderSvg(svg, { size, background: "white", fontDirs: cfg.fontDirs });
  const b64 = small.png.toString("base64");
  const big = size * 4;
  const wrapper =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${big} ${big}">` +
    `<image href="data:image/png;base64,${b64}" width="${big}" height="${big}" style="image-rendering:pixelated"/></svg>`;
  return renderSvg(wrapper, { size: big, background: "white", pixelated: true }).png;
}
