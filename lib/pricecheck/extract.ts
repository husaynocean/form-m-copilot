/**
 * PriceCheck step 1: read a proforma invoice, commercial invoice or Form M
 * into price lines. Separate from the Form M check's extraction so existing
 * features are untouched; `fromDocumentSet` reuses a Form M check's results
 * without re-reading the photos.
 */
import { z } from "zod";
import { chat, parseJsonObject, type ProviderConfig } from "../llm";
import type { DocumentSet } from "../schema";

const toNum = (v: unknown) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const num = z.preprocess(toNum, z.number().nullable());
const str = z.preprocess((v) => (v == null || v === "" ? null : String(v).trim()), z.string().nullable());

export const PriceLine = z.object({
  description: str,
  hs_code: str,
  quantity: num,
  unit: str,
  unit_price: num,
  line_total: num,
  net_weight_kg: num.optional().default(null),
});
export type PriceLine = z.infer<typeof PriceLine>;

export const PriceDoc = z.object({
  doc_kind: z.enum(["proforma_invoice", "commercial_invoice", "form_m", "other"]).catch("other"),
  form_m_number: str.optional().default(null),
  supplier: str,
  supplier_country: str.optional().default(null),
  buyer: str,
  invoice_number: str,
  invoice_date: str,
  currency: str,
  incoterm: str,
  country_of_origin: str,
  country_of_supply: str.optional().default(null),
  total: num,
  lines: z.array(PriceLine),
});
export type PriceDoc = z.infer<typeof PriceDoc>;

export const PRICE_PROMPT = `You read import documents for a bank's trade-compliance desk: proforma invoices, commercial invoices and Nigerian Form M applications.

Transcribe the document into this JSON (null for anything not printed; do not guess):
{"doc_kind":"proforma_invoice|commercial_invoice|form_m|other",
 "form_m_number":null,
 "supplier":null,"supplier_country":null,"buyer":null,
 "invoice_number":null,"invoice_date":null,
 "currency":null,"incoterm":null,
 "country_of_origin":null,"country_of_supply":null,
 "total":null,
 "lines":[{"description":null,"hs_code":null,"quantity":null,"unit":null,"unit_price":null,"line_total":null,"net_weight_kg":null}]}

Rules:
- Copy what is PRINTED. Never correct or compute values. If a total looks wrong, copy it as printed.
- supplier = seller / beneficiary / exporter; buyer = importer / applicant. Company names only, exactly as printed.
- On a Form M: the proforma invoice number and date go in invoice_number / invoice_date; total is the total FOB (or CFR/CIF) value as printed.
- Numbers as plain JSON numbers (1,437,347.09 -> 1437347.09). Dates as yyyy-mm-dd. currency as ISO code (USD, EUR, CNY).
- incoterm: just the code (FOB, CFR, CIF, EXW...). country_of_origin: a country name in English.
- hs_code exactly as printed (e.g. 8502.12.00.00), null if not printed.
- One object per goods line, in printed order. Skip subtotal, freight, insurance and total rows.
- net_weight_kg only if the line's net weight is printed on this document.
- Reply with the JSON object only.`;

export async function extractPriceDoc(imageDataUrl: string, provider?: ProviderConfig): Promise<{ doc: PriceDoc; repaired: boolean; model: string; ms: number }> {
  const messages = [
    { role: "system" as const, content: PRICE_PROMPT },
    { role: "user" as const, content: [{ type: "text" as const, text: "Transcribe this document." }, { type: "image_url" as const, image_url: { url: imageDataUrl } }] },
  ];
  let repaired = false;
  let ms = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat(messages, { provider, json: true });
    ms += res.ms;
    let problem: string;
    try {
      const check = PriceDoc.safeParse(parseJsonObject(res.text));
      if (check.success) return { doc: check.data, repaired, model: res.model, ms };
      problem = check.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    } catch (e) {
      problem = (e as Error).message;
    }
    repaired = true;
    messages.push({ role: "assistant" as never, content: res.text });
    messages.push({ role: "user", content: `Your JSON did not match the format:\n${problem}\nReturn the corrected JSON object only.` } as never);
  }
  throw new Error("Could not read this document in the expected format.");
}

/** Build the price lines from a Form M check's documents (no re-reading). */
export function fromDocumentSet(docs: DocumentSet): PriceDoc | null {
  const pi = docs.proforma_invoice;
  if (!pi) return null;
  const pl = docs.packing_list;
  return {
    doc_kind: "proforma_invoice",
    form_m_number: null,
    supplier: pi.seller.name,
    supplier_country: pi.country_of_supply,
    buyer: pi.buyer.name,
    invoice_number: pi.invoice_number,
    invoice_date: pi.invoice_date,
    currency: pi.currency,
    incoterm: pi.incoterm,
    country_of_origin: pi.country_of_origin,
    country_of_supply: pi.country_of_supply,
    total: pi.total,
    lines: pi.lines.map((l, i) => ({
      description: l.description,
      hs_code: l.hs_code,
      quantity: l.quantity,
      unit: l.unit,
      unit_price: l.unit_price,
      line_total: l.line_total,
      // Same-position packing-list line, when its description matches.
      net_weight_kg: pl?.lines[i] && (pl.lines[i].description ?? "").toLowerCase() === (l.description ?? "").toLowerCase() ? pl.lines[i].net_weight_kg : null,
    })),
  };
}
