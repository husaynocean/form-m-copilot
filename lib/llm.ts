/**
 * Provider-agnostic chat client. Meta Model API, Baseten and any
 * OpenAI-compatible server (e.g. Muse Glimmer served with vLLM on Modal)
 * all accept the same /chat/completions request, so switching backends is
 * an environment variable, not a code change.
 */

export type ProviderName = "meta" | "baseten" | "openai-compatible";

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export function getProvider(override?: ProviderName): ProviderConfig {
  const name = (override ?? process.env.LLM_PROVIDER ?? "meta") as ProviderName;
  switch (name) {
    case "meta":
      return {
        name,
        baseUrl: process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
        apiKey: required("META_API_KEY"),
        model: process.env.META_MODEL ?? "muse-spark-1.3",
      };
    case "baseten":
      return {
        name,
        baseUrl: process.env.BASETEN_BASE_URL ?? "https://inference.baseten.co/v1",
        apiKey: required("BASETEN_API_KEY"),
        model: process.env.BASETEN_MODEL ?? "meta-models/muse-spark-open-1026",
      };
    case "openai-compatible":
      return {
        name,
        baseUrl: required("OPENAI_COMPAT_BASE_URL"),
        apiKey: process.env.OPENAI_COMPAT_API_KEY ?? "none",
        model: required("OPENAI_COMPAT_MODEL"),
      };
    default:
      throw new Error(`Unknown LLM_PROVIDER "${name}"`);
  }
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing environment variable ${key}`);
  return v;
}

export interface ChatResult {
  text: string;
  provider: ProviderName;
  model: string;
  ms: number;
}

export async function chat(
  messages: ChatMessage[],
  opts: { provider?: ProviderConfig; temperature?: number; maxTokens?: number; json?: boolean } = {},
): Promise<ChatResult> {
  const p = opts.provider ?? getProvider();
  const started = Date.now();
  const body: Record<string, unknown> = {
    model: p.model,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 16000, // headroom for reasoning tokens
  };
  if (opts.json) body.response_format = { type: "json_object" };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      // Reasoning models may return thinking separately (reasoning_content) or
      // inline in <think> tags; keep only the final answer.
      const raw: string = data?.choices?.[0]?.message?.content ?? "";
      const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      return { text, provider: p.name, model: p.model, ms: Date.now() - started };
    }
    const errText = await res.text();
    lastErr = new Error(`${p.name} ${res.status}: ${errText.slice(0, 300)}`);
    // Some servers reject response_format; retry once without it.
    if (res.status === 400 && body.response_format) {
      delete body.response_format;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    break;
  }
  throw lastErr;
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences). */
export function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON object in model reply");
  return JSON.parse(raw.slice(start, end + 1));
}
