/**
 * PriceCheck extraction test on synthetic documents (uses the model).
 *   npx tsx scripts/pc-eval-extract.ts
 * Compares supplier, buyer, currency, incoterm, origin, total and every line's
 * HS code, quantity, unit, unit price and line total with the ground truth.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPriceDoc, type PriceDoc } from "../lib/pricecheck/extract";
import { hs6Of } from "../lib/pricecheck/catalog";

const S = join(__dirname, "..", "samples");
const J = (p: string) => JSON.parse(readFileSync(join(S, p), "utf8"));
const norm = (v: unknown) => (typeof v === "number" ? Math.round(v * 100) / 100 : String(v ?? "").toLowerCase().replace(/[^a-z0-9.]/g, ""));

type Truth = Omit<PriceDoc, "doc_kind" | "form_m_number" | "supplier_country" | "country_of_supply" | "invoice_date" | "invoice_number"> & { doc_kind: string };
const fromCase = (id: string): Truth => {
  const k = J(`cases/${id}/answer_key.json`);
  return { doc_kind: "proforma_invoice", supplier: k.beneficiary.name, buyer: k.importer.name, currency: k.proforma.currency, incoterm: k.proforma.incoterm, country_of_origin: k.proforma.country_of_origin, total: k.proforma.printed_total ?? k.proforma.total,
    lines: k.proforma.items.map((i: Record<string, unknown>) => ({ description: i.description, hs_code: "printed_description" in i ? null : i.hs_code, quantity: i.quantity, unit: i.unit, unit_price: i.unit_price, line_total: i.line_total, net_weight_kg: null })) };
};
const fromTruth = (p: string): Truth => {
  const t = J(p).truth.proforma_invoice;
  return { doc_kind: "commercial_invoice", supplier: t.seller.name, buyer: t.buyer.name, currency: t.currency, incoterm: t.incoterm, country_of_origin: t.country_of_origin, total: t.total, lines: t.lines.map((l: Record<string, unknown>) => ({ ...l, net_weight_kg: null })) };
};

const CASES: [string, string, Truth][] = [
  ["Form M (synthetic)", "pricecheck/photos/form_m_01.jpg", J("pricecheck/form_m_01.json")],
  ["Proforma, 3 lines (case_12)", "cases/case_12/photos/proforma_invoice.jpg", fromCase("case_12")],
  ["Proforma, wheat in MT (case_10)", "cases/case_10/photos/proforma_invoice.jpg", fromCase("case_10")],
  ["Commercial invoice (export x01)", "export_cases/x01/photos/commercial_invoice.jpg", fromTruth("export_cases/x01/answer_key.json")],
];

(async () => {
  let ok = 0, all = 0;
  for (const [name, photo, truth] of CASES) {
    const img = `data:image/jpeg;base64,${readFileSync(join(S, photo)).toString("base64")}`;
    const r = await extractPriceDoc(img);
    const got = r.doc;
    const bad: string[] = [];
    const cmp = (label: string, a: unknown, b: unknown) => { all++; if (norm(a) === norm(b)) ok++; else bad.push(`${label}: want ${a} got ${b}`); };
    for (const f of ["supplier", "buyer", "currency", "incoterm", "country_of_origin", "total"] as const) cmp(f, truth[f], got[f]);
    cmp("line count", truth.lines.length, got.lines.length);
    truth.lines.forEach((l, i) => {
      const g = got.lines[i];
      cmp(`line ${i + 1} hs6`, hs6Of(l.hs_code), hs6Of(g?.hs_code));
      for (const f of ["quantity", "unit", "unit_price", "line_total"] as const) cmp(`line ${i + 1} ${f}`, l[f], g?.[f]);
    });
    console.log(`${bad.length ? "FAIL" : "PASS"} ${name} (${got.doc_kind}, ${(r.ms / 1000).toFixed(1)}s${r.repaired ? ", auto-corrected" : ""})${bad.length ? "\n   " + bad.join("\n   ") : ""}`);
  }
  console.log(`\nFields: ${ok}/${all}`);
})();
