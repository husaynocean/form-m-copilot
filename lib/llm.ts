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

/** Thrown when every model's free allowance for the day is used up. */
export class QuotaError extends Error {
  constructor() {
    super("The free AI allowance for today is used up. Please try again tomorrow.");
    this.name = "QuotaError";
  }
}
export const isQuotaError = (e: unknown) => e instanceof QuotaError || (e as Error)?.name === "QuotaError";

// Models whose DAILY quota is used up, until when (per server instance).
const exhausted = new Map<string, number>();
// Free tiers also limit requests per minute: keep only a few calls in flight.
const MAX_IN_FLIGHT = Number(process.env.LLM_MAX_CONCURRENCY ?? 4);
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
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

  // Free tiers get busy: if a model is overloaded, rate-limited or slow, move
  // to the next one in OPENAI_COMPAT_FALLBACK_MODELS (comma-separated).
  const all = [p.model, ...(p.name === "openai-compatible" ? (process.env.OPENAI_COMPAT_FALLBACK_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean) : [])];
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 75000);

  let lastErr: unknown;
  for (let attempt = 0; attempt < Math.max(4, all.length * 2); attempt++) {
    const models = all.filter((m) => (exhausted.get(m) ?? 0) < Date.now());
    if (!models.length) throw new QuotaError();
    const model = models[attempt % models.length];
    body.model = model;
    let res: Response;
    try {
      res = await slot(() =>
        fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch (e) {
      lastErr = new Error(`${p.name} ${model}: ${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message}`);
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      // Reasoning models may return thinking separately (reasoning_content) or
      // inline in <think> tags; keep only the final answer.
      const raw: string = data?.choices?.[0]?.message?.content ?? "";
      const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<thought>[\s\S]*?<\/thought>/g, "").trim();
      return { text, provider: p.name, model, ms: Date.now() - started };
    }
    const errText = await res.text();
    lastErr = new Error(`${p.name} ${model} ${res.status}: ${errText.slice(0, 300)}`);
    // Some servers reject response_format; retry once without it.
    if (res.status === 400 && body.response_format) {
      delete body.response_format;
      continue;
    }
    if (res.status === 429) {
      if (/per ?day|PerDay|daily/i.test(errText)) {
        // Daily allowance gone: skip this model until the quota resets (assume ~midnight Pacific; recheck hourly).
        exhausted.set(model, Date.now() + 60 * 60 * 1000);
        continue;
      }
      // Per-minute limit: wait for the suggested time (capped) and try again.
      const secs = Math.min(20, Number(/retry in ([\d.]+)s/i.exec(errText)?.[1] ?? 4));
      await new Promise((r) => setTimeout(r, secs * 1000));
      continue;
    }
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, models.length === 1 ? 1000 * 2 ** attempt : 600 * (attempt + 1)));
      continue;
    }
    break;
  }
  if (all.every((m) => (exhausted.get(m) ?? 0) >= Date.now())) throw new QuotaError();
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
