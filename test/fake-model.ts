// A stand-in OpenAI-compatible server for offline tests.
export const GOOD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><circle cx="128" cy="128" r="96" fill="#0F766E"/><rect x="88" y="88" width="80" height="80" rx="12" fill="#1F2937"/></svg>`;

export function startFakeModel() {
  let reviews = 0;
  const seen: string[] = [];
  const fixPrompts: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: any = await req.json();
      const msgs: any[] = body.messages;
      const hasImage = msgs.some((m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"));
      const system = msgs.find((m) => m.role === "system")?.content ?? "";
      let content: string;
      if (hasImage) {
        seen.push("review");
        const text = msgs.at(-1).content.find((p: any) => p.type === "text")?.text ?? "";
        if (text.includes("OFFBRIEF")) {
          content = JSON.stringify({ seen: "a square", strengths: ["clean"], problems: ["not about the brief"], fixes: [], matches_brief: false, score: 8 });
        } else {
          reviews++;
          content = JSON.stringify(
            reviews <= 2
              ? { seen: "a circle and a square", strengths: ["Bold circle silhouette"], problems: ["The square looks off-centre."], fixes: ["Centre the square."], matches_brief: true, score: 5 }
              : { seen: "a centred mark", strengths: ["Balanced"], problems: [], fixes: [], matches_brief: true, score: 9 },
          );
        }
      } else if (String(system).includes("plan marks")) {
        seen.push("spec");
        content = JSON.stringify({ concepts: [
          { name: "Orbit", idea: "a circle holding a square", shapes: "circle, rect", composition: "centred", colors: "accent, ink" },
          { name: "Gate", idea: "an open gate", shapes: "rects", composition: "symmetric", colors: "ink" },
        ] });
      } else if (String(msgs.at(-1)?.content).includes("Current SVG")) {
        seen.push("fix");
        fixPrompts.push(String(msgs.at(-1)?.content));
        content = "Here you go:\n```svg\n" + GOOD_SVG.replace('rx="12"', 'rx="16"') + "\n```";
      } else {
        seen.push("draw");
        content = "<think>planning</think>\n```svg\n" + GOOD_SVG.replace("<circle", '<script>alert(1)</script><circle onclick="x()"') + "\n```";
      }
      return Response.json({ choices: [{ message: { role: "assistant", content } }] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, fixPrompts, stop: () => server.stop(true) };
}
