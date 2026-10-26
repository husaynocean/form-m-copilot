import hs6 from "./data/hs6.json";
import { chat, parseJsonObject, type ProviderConfig } from "./llm";
import type { DocumentSet, Issue } from "./schema";

/**
 * HS-code assistant.
 *   1. Retrieve: BM25 search over the official HS 2022 subheadings (5,613 codes).
 *   2. Decide: the model chooses ONE code from the retrieved shortlist and explains why.
 *   3. Verify: the chosen code must be in the shortlist and in the HS list; otherwise rejected.
 * The model can never invent a code.
 */

export interface HsEntry { code: string; desc: string; heading: string; chapter: string }
const ENTRIES = hs6 as HsEntry[];
const BY_CODE = new Map(ENTRIES.map((e) => [e.code, e]));

// Trade vocabulary -> nomenclature vocabulary. Importers write "generator",
// the tariff says "generating sets".
const SYNONYMS: Record<string, string[]> = {
  generator: ["generating", "sets", "electric"],
  genset: ["generating", "sets", "electric"],
  kva: ["generating", "output"],
  diesel: ["compression", "ignition"],
  "air conditioner": ["air", "conditioning", "machines"],
  ac: ["air", "conditioning"],
  aircon: ["air", "conditioning"],
  split: ["split", "system"],
  floodlight: ["luminaires", "light", "fittings"],
  lamp: ["luminaires", "lamps"],
  led: ["light", "emitting", "diode"],
  bulb: ["lamps"],
  tablets: ["medicaments", "retail", "sale"],
  paracetamol: ["medicaments", "therapeutic"],
  drug: ["medicaments"],
  medicine: ["medicaments", "therapeutic"],
  "tomato paste": ["tomatoes", "prepared", "preserved"],
  granules: ["primary", "forms"],
  pp: ["polypropylene"],
  carton: ["cartons", "boxes", "corrugated"],
  machine: ["machinery", "machines"],
  phone: ["telephone", "smartphones"],
  laptop: ["portable", "automatic", "data", "processing", "machines"],
  tyre: ["tyres", "pneumatic", "rubber"],
  tire: ["tyres", "pneumatic", "rubber"],
  rice: ["rice"],
  sugar: ["cane", "sugar"],
  vehicle: ["motor", "vehicles"],
  car: ["motor", "cars", "vehicles", "transport", "persons"],
  truck: ["motor", "vehicles", "transport", "goods"],
  solar: ["photovoltaic"],
  fabric: ["fabrics", "woven"],
  petrol: ["spark", "ignition"],
  gasoline: ["spark", "ignition"],
  galvanised: ["zinc", "plated", "coated"],
  galvanized: ["zinc", "plated", "coated"],
  cable: ["conductors", "insulated", "electric"],
  wire: ["conductors", "wire"],
  cc: ["cylinder", "capacity"],
  panel: ["modules", "panels"],
};

const STOP = new Set(
  "a an and the of or for in on with to by from not other than more less being its kind used use n e c nec whether".split(" "),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/(\d)\s*(kva|hp|mm|cm|kg|g|l|w|m2|%)/g, "$1 $2")
    .split(/[^a-z0-9%]+/)
    .filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && t.endsWith("es") && /(ch|sh|x|ss)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function expandQuery(desc: string): string[] {
  const low = desc.toLowerCase();
  const extra = Object.entries(SYNONYMS).flatMap(([k, v]) =>
    new RegExp(`\\b${k}s?\\b`).test(low) ? v : [],
  );
  return [...tokenize(desc), ...tokenize(extra.join(" "))];
}

// --- BM25 index (built once per server instance) ---------------------------
const K1 = 1.2, B = 0.75;
const docs = ENTRIES.map((e) => {
  // Subheading text counts double; heading and chapter add context.
  const toks = [...tokenize(e.desc), ...tokenize(e.desc), ...tokenize(e.heading), ...tokenize(e.chapter)];
  const tf = new Map<string, number>();
  toks.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
  return { tf, len: toks.length };
});
const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length;
const df = new Map<string, number>();
docs.forEach((d) => d.tf.forEach((_, t) => df.set(t, (df.get(t) ?? 0) + 1)));
const idf = (t: string) => {
  const n = df.get(t) ?? 0;
  return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
};

export function searchHs(description: string, k = 15): (HsEntry & { score: number })[] {
  const q = [...new Set(expandQuery(description))];
  const scored = docs.map((d, i) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen)));
    }
    return { i, s };
  });
  return scored
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => ({ ...ENTRIES[x.i], score: Number(x.s.toFixed(2)) }));
}

export function lookupHs(code: string | null | undefined): HsEntry | undefined {
  if (!code) return undefined;
  const digits = code.replace(/\D/g, "");
  if (digits.length < 6) return undefined;
  return BY_CODE.get(`${digits.slice(0, 4)}.${digits.slice(4, 6)}`);
}

// --- model decision ----------------------------------------------------------
export interface HsSuggestion {
  description: string;
  code: string | null;
  official_text: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
  missing_info: string | null;
  candidates: string[];
}

export async function suggestHs(description: string, provider?: ProviderConfig): Promise<HsSuggestion> {
  const candidates = searchHs(description, 15);
  const list = candidates.map((c) => `${c.code}: ${c.heading} > ${c.desc}`).join("\n");
  const res = await chat(
    [
      {
        role: "system",
        content:
          "You classify goods for Nigerian import declarations (Form M) under the HS 2022 nomenclature. " +
          "Choose exactly one code from the candidate list, or null if none fits or the description lacks the detail needed " +
          "(e.g. capacity, material, weight). Never output a code that is not in the list. " +
          'Reply as JSON: {"code": "xxxx.xx" | null, "confidence": "high"|"medium"|"low", "reason": "<one sentence citing the deciding words>", "missing_info": "<what the supplier must state>" | null}',
      },
      { role: "user", content: `Goods description: "${description}"\n\nCandidates:\n${list}` },
    ],
    { provider, json: true, maxTokens: 400 },
  );
  const out = parseJsonObject(res.text) as Partial<HsSuggestion>;
  const allowed = new Set(candidates.map((c) => c.code));
  // Verification step: reject anything outside the retrieved, official list.
  const code = out.code && allowed.has(out.code) ? out.code : null;
  return {
    description,
    code,
    official_text: code ? BY_CODE.get(code)?.desc ?? null : null,
    confidence: code ? (out.confidence ?? "low") : "low",
    reason: out.code && !code ? `Model proposed ${out.code}, which is not in the official shortlist; rejected.` : out.reason ?? "",
    missing_info: out.missing_info ?? null,
    candidates: candidates.slice(0, 5).map((c) => c.code),
  };
}

/** Deterministic checks on printed HS codes (no model). */
export function checkPrintedHsCodes(docs: DocumentSet): Issue[] {
  const pi = docs.proforma_invoice;
  if (!pi) return [];
  const issues: Issue[] = [];
  pi.lines.forEach((l, i) => {
    if (!l.hs_code) return;
    const entry = lookupHs(l.hs_code);
    if (!entry) {
      issues.push({
        code: "HS_CODE_INVALID",
        severity: "error",
        title: `Line ${i + 1}: HS code ${l.hs_code} does not exist`,
        detail: `${l.hs_code} is not a valid HS 2022 subheading.`,
        evidence: [{ doc: "proforma_invoice", field: `lines[${i}].hs_code`, value: l.hs_code }],
        fix: "Use the suggested code below or confirm the correct code with your clearing agent.",
      });
      return;
    }
    const heading = entry.code.slice(0, 4);
    const top = searchHs(l.description ?? "", 25).map((c) => c.code.slice(0, 4));
    if (l.description && top.length && !top.includes(heading)) {
      issues.push({
        code: "HS_CODE_DOUBTFUL",
        severity: "warning",
        title: `Line ${i + 1}: HS code may not match the goods`,
        detail: `${l.hs_code} is "${entry.desc}", which doesn't appear to match "${l.description}".`,
        evidence: [{ doc: "proforma_invoice", field: `lines[${i}].hs_code`, value: l.hs_code }],
        fix: "Check the classification before submitting; a wrong code changes duty and can delay clearance.",
      });
    }
  });
  return issues;
}
