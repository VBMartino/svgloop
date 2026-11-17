import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface Example {
  file: string;
  tags: string[];
  svg: string;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Examples are .svg files; tags come from the file name and an optional <!-- tags: a, b --> comment. */
export function loadExamples(dir: string): Example[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .map((f) => {
      const svg = readFileSync(join(dir, f), "utf8");
      const tagLine = svg.match(/<!--\s*tags:\s*([^>]*?)-->/i)?.[1] ?? "";
      const tags = [...words(basename(f, ".svg") + " " + tagLine)];
      return { file: f, tags, svg: svg.replace(/<!--[\s\S]*?-->/g, "").trim() };
    });
}

/** Pick the k examples whose tags overlap the query most; ties keep file order. */
export function pickExamples(all: Example[], query: string, k = 2, maxChars = 6000): string[] {
  const q = words(query);
  const scored = all
    .map((e, i) => ({ e, i, s: e.tags.filter((t) => q.has(t)).length }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const out: string[] = [];
  let used = 0;
  for (const { e } of scored) {
    if (out.length >= k) break;
    if (used + e.svg.length > maxChars) continue;
    out.push(e.svg);
    used += e.svg.length;
  }
  return out;
}

export function readStyle(file?: string): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  const s = readFileSync(file, "utf8").trim();
  return s || undefined;
}
