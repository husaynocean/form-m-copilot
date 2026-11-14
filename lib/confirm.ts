import { chat, parseJsonObject, type ProviderConfig } from "./llm";
import type { DocType, DocumentSet, Issue } from "./schema";

/**
 * Before accusing a document of a numeric mismatch, re-read the disputed
 * printed number from the photo twice with a narrow prompt. If both re-reads
 * agree with each other and not with the first reading, the first reading was
 * a misread: correct it and let the rules run again.
 */

interface Target { doc: DocType; field: string; label: string }

const TARGETS: Record<string, Target[]> = {
  PACKAGES_MISMATCH: [{ doc: "bill_of_lading", field: "packages", label: "the total number of packages" }],
  WEIGHT_MISMATCH: [{ doc: "bill_of_lading", field: "gross_weight_kg", label: "the total gross weight in kg" }],
  CCI_VALUE_MISMATCH: [{ doc: "clean_certificate_of_inspection", field: "fob_value", label: "the verified FOB value (the amount only)" }],
  CCI_QUANTITY_MISMATCH: [{ doc: "clean_certificate_of_inspection", field: "quantity", label: "the quantity inspected (the number only)" }],
  CCI_WEIGHT_MISMATCH: [{ doc: "clean_certificate_of_inspection", field: "gross_weight_kg", label: "the gross weight in kg" }],
  COO_WEIGHT_MISMATCH: [{ doc: "certificate_of_origin", field: "gross_weight_kg", label: "the gross weight in kg" }],
};

const DOC_NAME: Partial<Record<DocType, string>> = {
  bill_of_lading: "bill of lading",
  clean_certificate_of_inspection: "Clean Certificate of Inspection",
  certificate_of_origin: "certificate of origin",
};

function toNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function reread(image: string, t: Target, provider?: ProviderConfig): Promise<number | null> {
  try {
    const res = await chat(
      [
        { role: "system", content: `You proof-read a ${DOC_NAME[t.doc] ?? t.doc} for a bank. Copy ${t.label} EXACTLY as printed, digit by digit. Do not compute or correct anything. Reply as JSON: {"value": <plain number, or null if not printed>}` },
        { role: "user", content: [{ type: "text", text: `What is ${t.label}?` }, { type: "image_url", image_url: { url: image } }] },
      ],
      { provider, json: true, maxTokens: 4000 },
    );
    return toNum((parseJsonObject(res.text) as { value?: unknown }).value);
  } catch {
    return null;
  }
}

export async function confirmMismatches(
  docs: DocumentSet,
  images: Partial<Record<DocType, string>>,
  issues: Issue[],
  provider?: ProviderConfig,
): Promise<{ corrected: string[]; checked: number }> {
  const targets = [...new Map(issues.flatMap((i) => TARGETS[i.code] ?? []).map((t) => [`${t.doc}.${t.field}`, t])).values()]
    .filter((t) => images[t.doc] && docs[t.doc]);
  const corrected: string[] = [];
  await Promise.all(
    targets.map(async (t) => {
      const [a, b] = await Promise.all([reread(images[t.doc]!, t, provider), reread(images[t.doc]!, t, provider)]);
      const doc = docs[t.doc] as Record<string, unknown>;
      const current = doc[t.field];
      if (a != null && b != null && Math.abs(a - b) < 0.005 && (typeof current !== "number" || Math.abs(current - a) >= 0.005)) {
        doc[t.field] = a;
        corrected.push(`${DOC_NAME[t.doc]} ${t.label.replace(/^the /, "")}: ${current} → ${a}`);
      }
    }),
  );
  return { corrected, checked: targets.length };
}
