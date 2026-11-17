import type { Config } from "./config";

export interface Concept {
  name: string;
  idea: string;
  shapes: string;
  composition: string;
  colors: string;
}

export interface Review {
  seen?: string;
  score: number;
  matches_brief: boolean;
  strengths: string[];
  problems: string[];
  fixes: string[];
}

const paletteLine = (c: Config) => c.palette.map((p) => `${p.name} ${p.value}`).join(", ");

export function rules(c: Config): string {
  return [
    `- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.canvas} ${c.canvas}">. No width or height.`,
    `- Colours: only ${paletteLine(c)}. Transparent background unless the brief asks for one.`,
    `- At most ${c.maxElements} shapes. Use circle, rect, ellipse, line, polygon and simple paths.`,
    `- Build it from geometry on a grid: shared centres, consistent stroke widths, deliberate proportions.`,
    `- Keep a margin of about 10% on every side, and fill about 70-90% of the canvas.`,
    `- It must still read at 32 pixels: bold, simple silhouettes, no hairlines or tiny detail.`,
    `- No <text>: draw any letters as paths. No scripts, images, filters, or outside references.`,
  ].join("\n");
}

export function specMessages(c: Config, brief: string, n: number, style?: string) {
  return [
    {
      role: "system" as const,
      content:
        "You are a senior identity designer. You plan marks before drawing them. Reply with JSON only." +
        (style ? `\n\nHouse style:\n${style}` : ""),
    },
    {
      role: "user" as const,
      content:
        `Brief: ${brief}\n\nPalette: ${paletteLine(c)}\n\n` +
        `Propose ${n} clearly different design directions for this mark. Return JSON:\n` +
        `{"concepts":[{"name":"short label","idea":"the visual idea in one sentence",` +
        `"shapes":"which primitives and how they are built","composition":"layout, balance and negative space",` +
        `"colors":"which palette names go where"}]}`,
    },
  ];
}

export function drawMessages(c: Config, brief: string, concept: Concept, examples: string[], style?: string) {
  const ex = examples.length
    ? `\n\nExamples in the house style (match their level of polish, not their subject):\n` +
      examples.map((e, i) => `Example ${i + 1}:\n\`\`\`svg\n${e}\n\`\`\``).join("\n\n")
    : "";
  return [
    {
      role: "system" as const,
      content:
        "You draw logos and icons as hand-written SVG code. You reply with one ```svg code block and nothing else." +
        (style ? `\n\nHouse style:\n${style}` : "") +
        ex,
    },
    {
      role: "user" as const,
      content:
        `Brief: ${brief}\n\nDirection "${concept.name}": ${concept.idea}\nShapes: ${concept.shapes}\n` +
        `Composition: ${concept.composition}\nColours: ${concept.colors}\n\nRules:\n${rules(c)}`,
    },
  ];
}

export function fixMessages(c: Config, brief: string, svg: string, issues: string[], style?: string, keep: string[] = [], seen?: string) {
  const keepText = keep.length ? `\n\nKeep these strengths:\n${keep.map((k) => `- ${k}`).join("\n")}` : "";
  const seenText = seen ? `\n\nRight now a viewer sees it as: ${seen}\nMake it read clearly as the brief's subject.` : "";
  return [
    {
      role: "system" as const,
      content:
        "You revise SVG logos. You reply with one ```svg code block containing the full revised SVG and nothing else." +
        (style ? `\n\nHouse style:\n${style}` : ""),
    },
    {
      role: "user" as const,
      content:
        `Brief: ${brief}\n\nCurrent SVG:\n\`\`\`svg\n${svg}\n\`\`\`${seenText}\n\n` +
        `Fix these issues and keep what already works:\n${issues.map((i) => `- ${i}`).join("\n")}${keepText}\n\nRules:\n${rules(c)}`,
    },
  ];
}

/**
 * The reviewer judges the result against the BRIEF. The designer's direction is context only:
 * an earlier version judged against the direction's exact wording and scored good marks 0-1.
 */
export function reviewText(c: Config, brief: string, conceptIdea: string, sizes: number[]): string {
  return (
    `You are an experienced art director reviewing a logo mark.\n\n` +
    `Client brief: ${brief}\n` +
    `The designer's starting idea was: ${conceptIdea}\n` +
    `That idea is context only. Judge the drawing against the brief: a mark that drifted from the idea ` +
    `but works well for the brief is a good mark.\n\n` +
    `The images show the same mark at ${sizes.join(" and ")} pixels on white ` +
    `(small sizes are enlarged with hard pixels so you can see how they really read).\n\n` +
    `First look at what it actually shows. Then judge:\n` +
    `- Fit: does it suit the brief's subject and feeling?\n` +
    `- Craft: balance, consistent weights, clean geometry, nothing clipped, misaligned or overlapping by accident.\n` +
    `- Small size: is it still a clear, distinct shape at the smallest size?\n` +
    `- Distinctiveness: is it memorable, not generic clip-art?\n\n` +
    `Score on this scale:\n` +
    `0-2 broken, blank or unreadable. 3-4 weak: wrong for the brief, confusing, or badly built. ` +
    `5-6 workable but generic, ambiguous or visibly flawed: a client would ask for another round. ` +
    `7-8 good: a client would accept it after small fixes. 9-10 excellent: distinctive and ready to ship.\n` +
    `Use the whole scale. If you would describe the shape as something other than the brief's subject ` +
    `(a helmet, an eye, a signal icon), it is 5 or below. Do not deduct for differences from the starting idea.\n\n` +
    `Reply with JSON only, in this order:\n` +
    `{"seen": "one sentence: what the mark shows", "strengths": ["what works and must be kept"], ` +
    `"problems": ["concrete flaw"], "fixes": ["specific change to the drawing"], ` +
    `"matches_brief": true|false, "score": 0-10}`
  );
}
