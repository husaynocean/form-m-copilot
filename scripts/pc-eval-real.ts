/**
 * PriceCheck against REAL shipments: the UN Comtrade records in the bundled seed.
 *
 *   npx tsx scripts/pc-eval-real.ts
 *
 * Each real record (Nigeria's imports, or the origin's exports to Nigeria) is
 * treated as an invoice and judged against a normal range built from the OTHER
 * records for the same goods and origin (leave-one-out), using the app's own
 * scorer. Then the same real price is marked up or down by 1.2–2x to see what
 * the check catches.
 *
 *   x1.0 -> how often an honest shipment is flagged (false alarms)
 *   x1.2.. -> how often a marked-up or marked-down price is caught
 *
 * Caveat: a Comtrade record is a year's total for a trade route, which is
 * smoother than a single invoice. Real invoices vary more, so the false-alarm
 * rate here is a lower bound.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import seed from "../lib/pricecheck/benchmarks-seed.json";
import { summarise, unitValue, CIF_FOB } from "../lib/pricecheck/benchmarks";
import type { FlowRecord } from "../lib/pricecheck/comtrade";
import type { LineLookup } from "../lib/pricecheck/lookup";
import { scorePriceCheck } from "../lib/pricecheck/score";

const NG = 566;
const records = (seed as { records: FlowRecord[] }).records;
const direct = (r: FlowRecord) => r.source === "ng_imports" || r.source === "mirror_exports_to_ng";
const originOf = (r: FlowRecord) => (r.source === "ng_imports" ? r.partner_m49 : r.reporter_m49);

// Groups of records for one HS code from one origin.
const groups = new Map<string, FlowRecord[]>();
for (const r of records) {
  const k = `${r.hs6}|${originOf(r)}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}

const MARKUPS = [1, 1.2, 1.3, 1.5, 2];
type Tally = { n: number; anyFlag: number; mediumUp: number };
const over: Record<number, Tally> = {}, under: Record<number, Tally> = {};
for (const m of MARKUPS) { over[m] = { n: 0, anyFlag: 0, mediumUp: 0 }; under[m] = { n: 0, anyFlag: 0, mediumUp: 0 }; }

function judge(hs6: string, origin: number, basis: "kg" | "item", price: number, band: NonNullable<ReturnType<typeof summarise>>) {
  const line = { description: null, hs_code: hs6, quantity: 1, unit: basis === "kg" ? "kg" : "unit", unit_price: price, line_total: price, net_weight_kg: null };
  const lk: LineLookup = { line_no: 1, line, hs6, basis, basis_qty: 1, unit_value: price, benchmark: band, ratio: null, note: null };
  const r = scorePriceCheck(
    { doc_kind: "proforma_invoice", form_m_number: null, supplier: null, supplier_country: null, buyer: null, invoice_number: null, invoice_date: null, currency: "USD", incoterm: "FOB", country_of_origin: null, country_of_supply: null, total: price, lines: [line] },
    [lk],
    { origin_m49: origin, fx: { currency: "USD", per_usd: 1, source: "live", as_of: "" }, knownSupplier: null },
  );
  const flag = r.flags.find((f) => /^PRICE_(ABOVE|BELOW)_RANGE$/.test(f.code));
  return { flag: flag?.code ?? null, level: r.level };
}

let tested = 0, groupsUsed = 0;
for (const [key, rs] of groups) {
  const [hs6, o] = key.split("|");
  const origin = Number(o);
  for (const basis of ["kg", "item"] as const) {
    const whole = summarise(hs6, origin, basis, rs);
    if (!whole || whole.basis !== basis) continue;
    let used = false;
    for (const r of rs.filter(direct)) {
      const raw = unitValue(r, basis);
      if (raw == null || r.value_usd < 5000) continue;
      const truth = r.value_basis === "cif" ? raw / CIF_FOB : raw; // FOB-equivalent real price
      const band = summarise(hs6, origin, basis, rs.filter((x) => x !== r));
      if (!band || band.basis !== basis) continue;
      if (truth > band.median * 10 || truth < band.median / 10) continue; // the app drops these as bad data
      used = true; tested++;
      for (const m of MARKUPS) {
        const up = judge(hs6, origin, basis, truth * m, band);
        over[m].n++; if (up.flag) over[m].anyFlag++; if (up.flag && up.level !== "low") over[m].mediumUp++;
        if (m === 1) continue;
        const down = judge(hs6, origin, basis, truth / m, band);
        under[m].n++; if (down.flag) under[m].anyFlag++; if (down.flag && down.level !== "low") under[m].mediumUp++;
      }
    }
    if (used) groupsUsed++;
    break; // one basis per group, as the app does
  }
}

const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
const rows = MARKUPS.map((m) => ({
  change: m === 1 ? "honest (x1.0)" : `x${m}`,
  over_flagged: pct(over[m].anyFlag, over[m].n),
  over_medium_or_high: pct(over[m].mediumUp, over[m].n),
  under_flagged: m === 1 ? "" : pct(under[m].anyFlag, under[m].n),
  under_medium_or_high: m === 1 ? "" : pct(under[m].mediumUp, under[m].n),
}));
console.log(`${tested} real shipments, ${groupsUsed} goods/origin pairs (leave-one-out)\n`);
console.table(rows);
writeFileSync(join(__dirname, "..", "samples", "pricecheck", "demo", "results-real.json"), JSON.stringify({ tested, groups: groupsUsed, rows }, null, 1));
