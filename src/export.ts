import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { renderSvg } from "./render";
import { cleanSvg } from "./sanitize";

export interface ExportResult {
  files: string[];
  warnings: string[];
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "graphic";

/** Swap each palette colour for its dark counterpart, where one is set. */
export function darkVariant(svg: string, cfg: Config): string | undefined {
  const pairs = cfg.palette.filter((p) => p.dark);
  if (!pairs.length) return undefined;
  let out = svg;
  for (const p of pairs) out = out.replace(new RegExp(p.value.replace(/[^#0-9A-Fa-f]/g, ""), "gi"), p.dark!);
  return out === svg ? undefined : out;
}

/** Build an .ico holding PNG images (supported by Windows Vista and later, and every browser). */
export function buildIco(pngs: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

export function exportGraphic(cfg: Config, svgIn: string, name: string, opts: { sizes?: number[]; dir?: string; ico?: boolean; dark?: boolean } = {}): ExportResult {
  const cleaned = cleanSvg(svgIn, { palette: cfg.palette, canvas: cfg.canvas });
  if (!cleaned.svg) throw new Error(`Cannot export: ${cleaned.errors.join(" ")}`);
  const base = safeName(name);
  const dir = opts.dir ?? join(cfg.outDir, "exports", base);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const write = (f: string, data: string | Buffer) => { const p = join(dir, f); writeFileSync(p, data); files.push(p); };

  const variants: [string, string][] = [["", cleaned.svg]];
  const dark = opts.dark !== false ? darkVariant(cleaned.svg, cfg) : undefined;
  if (dark) variants.push(["-dark", dark]);

  for (const [suffix, svg] of variants) {
    write(`${base}${suffix}.svg`, svg);
    for (const size of opts.sizes ?? cfg.exportSizes) write(`${base}${suffix}-${size}.png`, renderSvg(svg, { size, fontDirs: cfg.fontDirs }).png);
  }
  if (opts.ico !== false) {
    write(`${base}.ico`, buildIco([16, 32, 48, 256].map((size) => ({ size, png: renderSvg(cleaned.svg, { size, fontDirs: cfg.fontDirs }).png }))));
  }
  return { files, warnings: cleaned.warnings };
}
