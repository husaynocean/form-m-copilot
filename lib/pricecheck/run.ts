/**
 * PriceCheck end to end: extracted document -> benchmarks -> score -> saved
 * to pc_invoices / pc_lines (and pc_suppliers when the user has a tracker key).
 */
import { rest } from "../store";
import { normalizeName } from "../validate";
import type { PriceDoc } from "./extract";
import { perUsd } from "./fx";
import { lookupLines } from "./lookup";
import { scorePriceCheck, type PriceCheckResult } from "./score";

const memory = () => process.env.PC_STORE === "memory";
const memSuppliers = new Set<string>();

async function knownSupplier(owner: string | null, supplier: string | null): Promise<boolean | null> {
  if (!owner || !supplier) return null;
  const norm = normalizeName(supplier);
  if (memory()) return memSuppliers.has(`${owner}|${norm}`);
  const rows = (await rest(`pc_suppliers?owner=eq.${encodeURIComponent(owner)}&supplier_norm=eq.${encodeURIComponent(norm)}&select=invoices`)) ?? [];
  return rows.length > 0;
}

async function save(doc: PriceDoc, r: PriceCheckResult, opts: { owner: string | null; source: "upload" | "form_m_check"; origin_m49: number | null }): Promise<string | null> {
  const norm = doc.supplier ? normalizeName(doc.supplier) : null;
  if (memory()) {
    if (opts.owner && norm) memSuppliers.add(`${opts.owner}|${norm}`);
    return null;
  }
  const [inv] = await rest("pc_invoices?select=id", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      owner: opts.owner, source: opts.source, doc_kind: doc.doc_kind, supplier: doc.supplier, supplier_norm: norm, buyer: doc.buyer,
      origin: doc.country_of_origin, origin_m49: opts.origin_m49, currency: doc.currency, incoterm: doc.incoterm,
      invoice_number: doc.invoice_number, invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(doc.invoice_date ?? "") ? doc.invoice_date : null,
      total: doc.total, risk_score: r.score, summary: r.summary,
    }),
  });
  await rest("pc_lines", {
    method: "POST",
    body: JSON.stringify(r.lines.map((l, i) => {
      const src = doc.lines[i];
      return {
        invoice_id: inv.id, line_no: l.line_no, description: src.description, hs_code: src.hs_code, hs6: l.hs6, quantity: src.quantity, unit: src.unit,
        unit_price: src.unit_price, line_total: src.line_total, net_weight_kg: src.net_weight_kg, basis: l.basis, unit_value_usd: l.price_usd,
        bench_low: l.band?.low ?? null, bench_median: l.band?.median ?? null, bench_high: l.band?.high ?? null, bench_points: l.band?.points ?? null,
        ratio: l.ratio, flags: r.flags.filter((f) => f.line === l.line_no).map((f) => f.code),
      };
    })),
  });
  if (opts.owner && norm) {
    const known = await knownSupplier(opts.owner, doc.supplier);
    if (known) {
      const [row] = await rest(`pc_suppliers?owner=eq.${encodeURIComponent(opts.owner)}&supplier_norm=eq.${encodeURIComponent(norm)}&select=invoices`);
      await rest(`pc_suppliers?owner=eq.${encodeURIComponent(opts.owner)}&supplier_norm=eq.${encodeURIComponent(norm)}`, {
        method: "PATCH", body: JSON.stringify({ invoices: (row?.invoices ?? 1) + 1, last_seen: new Date().toISOString() }),
      });
    } else {
      await rest("pc_suppliers", { method: "POST", body: JSON.stringify({ owner: opts.owner, supplier_norm: norm }) });
    }
  }
  return inv.id;
}

export async function runPriceCheck(
  doc: PriceDoc,
  opts: { owner?: string | null; source?: "upload" | "form_m_check" } = {},
): Promise<{ id: string | null; doc: PriceDoc; result: PriceCheckResult; errors: string[] }> {
  const owner = opts.owner ?? null;
  const [lk, fx, known] = await Promise.all([lookupLines(doc), perUsd(doc.currency), knownSupplier(owner, doc.supplier).catch(() => null)]);
  const result = scorePriceCheck(doc, lk.lines, { origin_m49: lk.origin_m49, fx, knownSupplier: known });
  let id: string | null = null;
  try {
    id = await save(doc, result, { owner, source: opts.source ?? "upload", origin_m49: lk.origin_m49 });
  } catch (e) {
    lk.errors.push(`save: ${(e as Error).message}`);
  }
  return { id, doc, result, errors: lk.errors };
}
