import { Resvg } from "@resvg/resvg-js";

export interface RenderOptions {
  size: number;
  /** CSS colour behind the drawing; omit for transparent. */
  background?: string;
  fontDirs?: string[];
  /** Nearest-neighbour scaling for embedded images (used to show small renders enlarged). */
  pixelated?: boolean;
}

export interface Rendered {
  size: number;
  png: Buffer;
  width: number;
  height: number;
}

export interface CanvasCheck {
  blank: boolean;
  /** Share of the canvas covered by the drawing's bounding box, 0-1. */
  coverage: number;
  problems: string[];
}

export function renderSvg(svg: string, opts: RenderOptions): Rendered {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: opts.size },
    background: opts.background,
    font: { loadSystemFonts: true, fontDirs: opts.fontDirs ?? [] },
    shapeRendering: 2,
    textRendering: 1,
    imageRendering: opts.pixelated ? 1 : 0,
  });
  const img = r.render();
  return { size: opts.size, png: img.asPng(), width: img.width, height: img.height };
}

/** Cheap pixel checks on a transparent render: blank, tiny, cut off. */
export function checkCanvas(svg: string, fontDirs?: string[]): CanvasCheck {
  const size = 128;
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: true, fontDirs: fontDirs ?? [] } });
  const img = r.render();
  const { width: w, height: h } = img;
  const px = img.pixels;
  // A background (square or rounded tile) is not "drawing": if the border is mostly opaque and one colour
  // dominates the opaque part, treat that colour as the background and measure what sits on it.
  const counts = new Map<string, number>();
  let border = 0;
  let opaque = 0;
  const sample = (x: number, y: number) => {
    border++;
    const i = (y * w + x) * 4;
    if (px[i + 3]! < 240) return;
    opaque++;
    const key = `${px[i]! >> 4},${px[i + 1]! >> 4},${px[i + 2]! >> 4}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { sample(0, y); sample(w - 1, y); }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const bg = top && opaque >= border * 0.3 && top[1] >= opaque * 0.6 ? top[0].split(",").map((n) => Number(n) * 16 + 8) : undefined;
  // With a background, composite each pixel over it first (resvg pixels are premultiplied), so the
  // anti-aliased fringe of a rounded tile counts as background, not as ink touching the edge.
  const isInk = (i: number) => {
    if (!bg) return px[i + 3]! > 16;
    const k = 1 - px[i + 3]! / 255;
    let diff = 0;
    for (let c = 0; c < 3; c++) diff += Math.abs(px[i + c]! + bg[c]! * k - bg[c]!);
    return diff > 48;
  };
  let minX = w, minY = h, maxX = -1, maxY = -1, filled = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isInk((y * w + x) * 4)) {
        filled++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const problems: string[] = [];
  if (w !== h) problems.push(`Canvas is not square (${w}x${h}).`);
  if (filled < w * h * 0.005) {
    return { blank: true, coverage: 0, problems: [...problems, "The drawing is blank or nearly invisible."] };
  }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const coverage = (bw * bh) / (w * h);
  if (bw < w * 0.3 && bh < h * 0.3) problems.push("The drawing is very small on the canvas; scale it up to fill about 70-90%.");
  // "Touching" means within 3% of an edge: anti-aliased strokes rarely land on pixel 0 exactly.
  const m = Math.max(1, Math.round(w * 0.03));
  const edges = [minX < m, minY < m, maxX > w - 1 - m, maxY > h - 1 - m].filter(Boolean).length;
  if (edges > 0 && edges < 4) problems.push("The drawing runs to the canvas edge on some sides; it looks cut off. Keep a margin of about 10%.");
  return { blank: false, coverage, problems };
}
