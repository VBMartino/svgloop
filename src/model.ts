import type { Endpoint } from "./config";

export type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface Message {
  role: "system" | "user" | "assistant";
  content: string | Part[];
}

export function pngPart(png: Buffer): Part {
  return { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } };
}

export class ModelError extends Error {}

/** One chat call to any OpenAI-compatible server (llama-server, Ollama, LM Studio, ...). */
export async function chat(ep: Endpoint, messages: Message[], opts: { json?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  const url = ep.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const body: Record<string, unknown> = {
    model: ep.model,
    messages,
    temperature: ep.temperature ?? 0.7,
    max_tokens: ep.maxTokens ?? 4096,
    stream: false,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    ...(ep.extraBody ?? {}),
  };
  const timeout = AbortSignal.timeout(ep.timeoutMs ?? 600_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new ModelError(`Cannot reach ${url}: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new ModelError(`${url} answered ${res.status}: ${text.slice(0, 400)}`);
  let data: any;
  try { data = JSON.parse(text); } catch { throw new ModelError(`${url} did not return JSON: ${text.slice(0, 200)}`); }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ModelError(`${url} returned no message content.`);
  return content;
}

/** Parse the first JSON object in a reply, tolerating fences and thinking. */
export function parseJson<T = any>(text: string): T | undefined {
  const s = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(s.slice(start, end + 1)) as T; } catch { return undefined; }
}
