import { chat, parseJsonObject, type ChatMessage, type ProviderConfig } from "./llm";
import { Extraction } from "./schema";

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

export interface ExtractResult {
  extraction: Extraction;
  provider: string;
  model: string;
  ms: number;
  repaired: boolean;
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
        return { extraction: check.data, provider: res.provider, model: res.model, ms, repaired };
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
