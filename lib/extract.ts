import { chat, parseJsonObject, type ChatMessage, type ProviderConfig } from "./llm";
import { Extraction, type ProformaInvoice } from "./schema";

/**
 * Step 1 of the agent: read one document image and return typed fields.
 * The model classifies the document AND extracts it in a single call.
 * Output is validated with Zod; if it fails, the model gets the validation
 * errors back and one chance to repair its JSON.
 */

const SKELETONS = `
proforma_invoice:
{"doc_type":"proforma_invoice",
 "seller":{"name":null,"address":null},
 "buyer":{"name":null,"address":null,"rc_number":null},
 "invoice_number":null,"invoice_date":null,"valid_until":null,
 "currency":null,"incoterm":null,
 "country_of_origin":null,"country_of_supply":null,
 "port_of_loading":null,"port_of_discharge":null,"mode_of_transport":null,"payment_terms":null,
 "lines":[{"description":null,"hs_code":null,"quantity":null,"unit":null,"unit_price":null,"line_total":null}],
 "goods_value":null,"freight":null,"insurance":null,"total":null}

packing_list:
{"doc_type":"packing_list",
 "seller":{"name":null,"address":null},
 "buyer":{"name":null,"address":null,"rc_number":null},
 "packing_list_number":null,"date":null,"proforma_reference":null,"port_of_discharge":null,
 "lines":[{"description":null,"quantity":null,"unit":null,"packages":null,"net_weight_kg":null,"gross_weight_kg":null}]}

insurance_certificate:
{"doc_type":"insurance_certificate",
 "insurer":null,"certificate_number":null,"policy_number":null,"date_of_issue":null,
 "insured":null,"interest":null,"proforma_reference":null,
 "currency":null,"sum_insured":null,"voyage_from":null,"voyage_to":null,
 "conveyance":null,"conditions":null}`;

export const EXTRACTION_SYSTEM_PROMPT = `You read Nigerian import trade documents for a bank's trade-services desk.

Task: identify which ONE of these documents the image shows, then transcribe its fields into JSON using exactly the matching skeleton below.
${SKELETONS}

Rules:
- Transcribe what is PRINTED. Never correct, compute, or infer values. If the printed total is wrong, copy the wrong total.
- If a field is not printed or is blank, use null. Do not guess.
- Numbers: plain JSON numbers without thousands separators or currency symbols (1,437,347.09 -> 1437347.09).
- Dates: ISO format yyyy-mm-dd.
- currency: ISO 4217 code (USD, EUR, CNY...). incoterm: just the code (FOB, CFR, CIF...), without the named place.
- Copy names exactly as printed, including suffixes like Ltd, Plc, GmbH, Co., Ltd.
- For insurance: voyage_from / voyage_to come from the "Voyage" line ("X to Y").
- One JSON object per line item, in printed order. Skip subtotal/total rows in "lines".
- Reply with the JSON object only.`;

export interface Verification {
  /** Independent re-reads of the money fields that were performed. */
  rereads: number;
  /** True if the first independent re-read matched the main extraction. */
  agreed: boolean;
  /** Fields whose value changed after majority vote. */
  corrected: string[];
  /** Fields where no two reads agreed; the officer must check these by eye. */
  uncertain: string[];
}

export interface ExtractResult {
  extraction: Extraction;
  provider: string;
  model: string;
  ms: number;
  repaired: boolean;
  verification?: Verification;
}

// --- money re-read ----------------------------------------------------------
// Models tend to "helpfully" fix arithmetic errors while transcribing, which
// hides exactly the mistakes we must catch. A second, narrow read that only
// copies printed amounts is compared against the main read; on disagreement a
// third read breaks the tie.

const MONEY_PROMPT = `You are proof-reading a proforma invoice image for a bank.
Copy these numbers EXACTLY as they are printed. Do NOT add, compute, round or correct anything:
printed totals on these invoices are sometimes wrong on purpose, and we need the wrong value.
- line_totals: the Amount column of each goods line, top to bottom (not subtotal rows)
- goods_value, freight, insurance, total: the summary rows at the bottom (null if a row is not printed)
If the image is not a proforma invoice, reply {"is_proforma": false}.
Reply as JSON: {"is_proforma": true, "line_totals": [..], "goods_value": n|null, "freight": n|null, "insurance": n|null, "total": n|null}`;

interface MoneyRead { is_proforma?: boolean; line_totals?: number[]; goods_value?: number | null; freight?: number | null; insurance?: number | null; total?: number | null }

async function readMoney(imageDataUrl: string, provider?: ProviderConfig): Promise<{ read: MoneyRead | null; ms: number }> {
  try {
    const res = await chat(
      [
        { role: "system", content: MONEY_PROMPT },
        { role: "user", content: [{ type: "text", text: "Copy the printed amounts." }, { type: "image_url", image_url: { url: imageDataUrl } }] },
      ],
      { provider, json: true, maxTokens: 8000 },
    );
    return { read: parseJsonObject(res.text) as MoneyRead, ms: res.ms };
  } catch {
    return { read: null, ms: 0 };
  }
}

const eq = (a: unknown, b: unknown) =>
  (a == null && b == null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.005);

function moneyFields(pi: ProformaInvoice): Record<string, number | null> {
  const f: Record<string, number | null> = { goods_value: pi.goods_value, freight: pi.freight, insurance: pi.insurance, total: pi.total };
  pi.lines.forEach((l, i) => (f[`lines[${i}].line_total`] = l.line_total));
  return f;
}
function moneyFromRead(r: MoneyRead, n: number): Record<string, number | null> {
  const f: Record<string, number | null> = { goods_value: r.goods_value ?? null, freight: r.freight ?? null, insurance: r.insurance ?? null, total: r.total ?? null };
  for (let i = 0; i < n; i++) f[`lines[${i}].line_total`] = r.line_totals?.[i] ?? null;
  return f;
}
function disagreements(a: Record<string, number | null>, b: Record<string, number | null>): string[] {
  return Object.keys(a).filter((k) => !eq(a[k], b[k]));
}
function setMoney(pi: ProformaInvoice, field: string, v: number | null) {
  const m = /^lines\[(\d+)\]\.line_total$/.exec(field);
  if (m) pi.lines[Number(m[1])].line_total = v;
  else (pi as unknown as Record<string, number | null>)[field] = v;
}

async function verifyMoney(
  imageDataUrl: string,
  pi: ProformaInvoice,
  first: Promise<{ read: MoneyRead | null; ms: number }>,
  provider?: ProviderConfig,
): Promise<{ verification: Verification; ms: number }> {
  const main = moneyFields(pi);
  const r2 = await first;
  if (!r2.read || r2.read.is_proforma === false) return { verification: { rereads: 0, agreed: true, corrected: [], uncertain: [] }, ms: r2.ms };
  const second = moneyFromRead(r2.read, pi.lines.length);
  const diff = disagreements(main, second);
  if (diff.length === 0) return { verification: { rereads: 1, agreed: true, corrected: [], uncertain: [] }, ms: r2.ms };

  // Tie-break with a third independent read; majority wins per field.
  const r3 = await readMoney(imageDataUrl, provider);
  const third = r3.read ? moneyFromRead(r3.read, pi.lines.length) : {};
  const corrected: string[] = [];
  const uncertain: string[] = [];
  for (const k of diff) {
    if (eq(second[k], third[k])) {
      setMoney(pi, k, second[k]);
      corrected.push(k);
    } else if (!eq(main[k], third[k])) {
      uncertain.push(k);
    }
  }
  return { verification: { rereads: 2, agreed: false, corrected, uncertain }, ms: r2.ms + r3.ms };
}

export async function extractDocument(
  imageDataUrl: string,
  opts: { provider?: ProviderConfig; hint?: string } = {},
): Promise<ExtractResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: opts.hint ?? "Extract this document." },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ];

  // Start the independent money read in parallel with the main read.
  const moneyRead = readMoney(imageDataUrl, opts.provider);

  let ms = 0;
  let repaired = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat(messages, { provider: opts.provider, json: true });
    ms += res.ms;
    let parsed: unknown;
    let problem: string;
    try {
      parsed = parseJsonObject(res.text);
      const check = Extraction.safeParse(parsed);
      if (check.success) {
        const extraction = check.data;
        let verification: Verification | undefined;
        if (extraction.doc_type === "proforma_invoice") {
          const v = await verifyMoney(imageDataUrl, extraction, moneyRead, opts.provider);
          verification = v.verification;
        }
        return { extraction, provider: res.provider, model: res.model, ms: ms, repaired, verification };
      }
      problem = check.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n");
    } catch (e) {
      problem = (e as Error).message;
    }
    // Self-repair: show the model exactly what was wrong.
    repaired = true;
    messages.push({ role: "assistant", content: res.text });
    messages.push({
      role: "user",
      content: `Your JSON did not match the schema:\n${problem}\nReturn the corrected JSON object only.`,
    });
  }
  throw new Error("Extraction failed schema validation after repair attempt");
}
