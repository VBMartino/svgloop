import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { PaletteColor } from "./config";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "title", "desc", "symbol", "use",
  "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask",
  "text", "tspan",
]);

const SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "use"]);

const ALLOWED_ATTRS = new Set([
  "id", "class", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "fx", "fy", "d", "points", "transform",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "opacity", "clip-path", "clip-rule", "mask", "style", "offset", "stop-color", "stop-opacity",
  "gradientUnits", "gradientTransform", "spreadMethod", "patternUnits",
  "clipPathUnits", "maskUnits", "maskContentUnits",
  "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "text-anchor",
  "dominant-baseline", "xmlns", "xmlns:xlink", "href", "xlink:href", "preserveAspectRatio", "version",
  "paint-order", "vector-effect", "color",
]);

const COLOR_ATTRS = ["fill", "stroke", "stop-color", "color"];
const NEUTRAL = new Set(["none", "currentcolor", "transparent", "inherit"]);

const NAMED: Record<string, string> = {
  white: "#FFFFFF", black: "#000000", red: "#FF0000", green: "#008000", blue: "#0000FF",
  gray: "#808080", grey: "#808080", yellow: "#FFFF00", orange: "#FFA500", purple: "#800080",
  navy: "#000080", teal: "#008080", silver: "#C0C0C0", maroon: "#800000", olive: "#808000",
};

export interface CleanResult {
  ok: boolean;
  svg: string;
  errors: string[];
  warnings: string[];
  colors: string[];
  elementCount: number;
}

/** Pull the first <svg>…</svg> out of a model reply (code fences, prose and thinking are ignored). */
export function extractSvg(text: string): string | undefined {
  const noThink = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // Small models sometimes fuse the fence and the tag: "```svg xmlns=..." instead of "```svg\n<svg xmlns=...".
    .replace(/```svg(\s+(?:xmlns|viewBox|width|height|version)\s*=)/gi, "<svg$1");
  const start = noThink.search(/<svg[\s>]/i);
  const end = noThink.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < start) return undefined;
  return noThink.slice(start, end + 6);
}

export function normalizeColor(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  if (!v || NEUTRAL.has(v) || v.startsWith("url(")) return undefined;
  if (NAMED[v]) return NAMED[v];
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return "#" + m[1]!.split("").map((c) => c + c).join("").toUpperCase();
  m = v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) return "#" + m[1]!.toUpperCase();
  m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return "#" + [m[1], m[2], m[3]].map((n) => Math.min(255, +n!).toString(16).padStart(2, "0")).join("").toUpperCase();
  return v; // unknown keyword: report as-is
}

function cleanStyle(style: string, warn: (s: string) => void): string {
  const out: string[] = [];
  for (const decl of style.split(";")) {
    const [k, ...rest] = decl.split(":");
    if (!k || !rest.length) continue;
    const prop = k.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (/expression|javascript:|@import|behavior/i.test(val) || /url\(\s*['"]?(?!#)/i.test(val)) {
      warn(`Removed unsafe style "${prop}".`);
      continue;
    }
    out.push(`${prop}:${val}`);
  }
  return out.join(";");
}

/**
 * Make model-written SVG safe and check it against the rules.
 * Unsafe parts are removed (with a warning); rule breaks are reported as errors.
 */
export function cleanSvg(
  input: string,
  opts: { palette?: PaletteColor[]; strictPalette?: boolean; maxElements?: number; canvas?: number } = {},
): CleanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = extractSvg(input) ?? input;
  if (!/<svg[\s>]/i.test(raw)) {
    return { ok: false, svg: "", errors: ["No <svg> element found."], warnings, colors: [], elementCount: 0 };
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
    return { ok: false, svg: "", errors: ["DOCTYPE/ENTITY declarations are not allowed."], warnings, colors: [], elementCount: 0 };
  }

  const parseErrors: string[] = [];
  let doc: ReturnType<DOMParser["parseFromString"]> | undefined;
  try {
    doc = new DOMParser({
      onError: (level: string, msg: string) => {
        if (level !== "warning") parseErrors.push(String(msg).split("\n")[0]!);
      },
    }).parseFromString(raw, "image/svg+xml");
  } catch (e) {
    parseErrors.push(String((e as Error).message).split("\n")[0]!); // xmldom throws on fatal errors
  }
  const root = doc?.documentElement;
  if (parseErrors.length || !root || root.localName !== "svg") {
    return { ok: false, svg: "", errors: [`SVG does not parse: ${parseErrors[0] ?? "no root <svg>"}`], warnings, colors: [], elementCount: 0 };
  }

  const colors = new Set<string>();
  let elementCount = 0;
  const noteColor = (val: string | null) => {
    if (!val) return;
    const c = normalizeColor(val);
    if (c) colors.add(c);
  };

  const walk = (el: any) => {
    const kids = Array.from(el.childNodes ?? []) as any[];
    for (const node of kids) {
      if (node.nodeType === 7 || node.nodeType === 8) { el.removeChild(node); continue; } // PI, comment
      if (node.nodeType !== 1) continue;
      const name = node.localName as string;
      if (!ALLOWED_ELEMENTS.has(name) || (node.namespaceURI && node.namespaceURI !== SVG_NS)) {
        warnings.push(`Removed <${node.nodeName}>.`);
        el.removeChild(node);
        continue;
      }
      if (SHAPES.has(name)) elementCount++;
      if (name === "text") warnings.push("Uses <text>: the look depends on installed fonts. Prefer letterforms drawn as paths.");
      scrubAttrs(node);
      walk(node);
    }
  };

  const scrubAttrs = (node: any) => {
    for (const attr of Array.from(node.attributes ?? []) as any[]) {
      const an = attr.name as string;
      const lower = an.toLowerCase();
      if (lower.startsWith("xmlns")) continue; // namespace declarations; foreign elements are removed anyway
      if (lower.startsWith("on") || !ALLOWED_ATTRS.has(an)) {
        warnings.push(`Removed attribute ${an} on <${node.localName}>.`);
        node.removeAttribute(an);
        continue;
      }
      if (lower === "href" || lower === "xlink:href") {
        if (!String(attr.value).trim().startsWith("#")) {
          warnings.push(`Removed outside reference ${an}="${attr.value}".`);
          node.removeAttribute(an);
        }
        continue;
      }
      if (lower === "style") {
        const cleaned = cleanStyle(attr.value, (s) => warnings.push(s));
        if (cleaned) node.setAttribute("style", cleaned); else node.removeAttribute("style");
        for (const m of cleaned.matchAll(/(?:^|;)\s*(fill|stroke|stop-color|color)\s*:\s*([^;]+)/gi)) noteColor(m[2]!);
        continue;
      }
      if (/url\(/i.test(attr.value) && !/url\(\s*#/i.test(attr.value)) {
        warnings.push(`Removed outside url() in ${an}.`);
        node.removeAttribute(an);
        continue;
      }
      if (COLOR_ATTRS.includes(lower)) noteColor(attr.value);
    }
  };

  scrubAttrs(root);
  walk(root);

  // Canvas: require a viewBox; fill it in from width/height when missing.
  if (!root.getAttribute("viewBox")) {
    const w = parseFloat(root.getAttribute("width") ?? "");
    const h = parseFloat(root.getAttribute("height") ?? "");
    if (w > 0 && h > 0) {
      root.setAttribute("viewBox", `0 0 ${w} ${h}`);
      warnings.push("Added viewBox from width/height.");
    } else if (opts.canvas) {
      root.setAttribute("viewBox", `0 0 ${opts.canvas} ${opts.canvas}`);
      warnings.push("No viewBox: assumed the standard canvas.");
    } else {
      errors.push("No viewBox.");
    }
  }
  root.setAttribute("xmlns", SVG_NS);
  if (raw.includes("xlink:")) root.setAttribute("xmlns:xlink", XLINK_NS);
  // Size comes from the renderer, not the file.
  root.removeAttribute("width");
  root.removeAttribute("height");

  if (elementCount === 0) errors.push("Draws nothing (no shapes).");
  if (opts.maxElements && elementCount > opts.maxElements) {
    errors.push(`Too complex: ${elementCount} shapes (limit ${opts.maxElements}). Simplify.`);
  }

  if (opts.palette?.length) {
    const allowed = new Set(opts.palette.flatMap((p) => [p.value, p.dark].filter(Boolean).map((c) => normalizeColor(c!)!)));
    const off = [...colors].filter((c) => !allowed.has(c));
    if (off.length) {
      const msg = `Colours outside the palette: ${off.join(", ")}. Use only ${opts.palette.map((p) => `${p.name} ${p.value}`).join(", ")}.`;
      (opts.strictPalette ? errors : warnings).push(msg);
    }
  }

  const svg = new XMLSerializer().serializeToString(root);
  return { ok: errors.length === 0, svg, errors, warnings: [...new Set(warnings)], colors: [...colors], elementCount };
}
