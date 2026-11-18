/**
 * Week 1 pipeline: extracted document -> per-line benchmark comparison.
 * Scoring, red flags and explanations build on this in week 2.
 */
import { getBenchmark, type Benchmark } from "./benchmarks";
import { catalogEntry, hs6Of, type Basis } from "./catalog";
import { toM49 } from "./countries";
import type { PriceDoc, PriceLine } from "./extract";
import { basisPrice } from "./units";

export interface LineLookup {
  line_no: number;
  line: PriceLine;
  hs6: string | null;
  basis: Basis | null;
  basis_qty: number | null;
  /** Invoice price per basis unit, in the invoice currency. */
  unit_value: number | null;
  benchmark: Benchmark | null;
  /** unit_value / benchmark median; only when the invoice is in US dollars. */
  ratio: number | null;
  note: string | null;
}

const ITEMISH = /^(u|unit|units|pc|pcs|piece|pieces|set|sets|nos?|each|ea|items?)$/i;

export async function lookupLines(doc: PriceDoc): Promise<{ origin_m49: number | null; lines: LineLookup[]; errors: string[] }> {
  const origin = toM49(doc.country_of_origin) ?? toM49(doc.supplier_country) ?? toM49(doc.country_of_supply);
  const usd = (doc.currency ?? "").toUpperCase() === "USD";
  const errors: string[] = [];
  const lines = await Promise.all(
    doc.lines.map(async (line, i): Promise<LineLookup> => {
      const base = { line_no: i + 1, line, basis: null, basis_qty: null, unit_value: null, benchmark: null, ratio: null };
      const hs6 = hs6Of(line.hs_code);
      if (!hs6) return { ...base, hs6: null, note: "No HS code on this line, so there is nothing to compare against." };
      const prefer: Basis = catalogEntry(hs6)?.basis ?? (ITEMISH.test(line.unit ?? "") ? "item" : "kg");
      const { benchmark, errors: e } = await getBenchmark(hs6, origin, prefer);
      errors.push(...e.map((x) => `${hs6}: ${x}`));
      if (!benchmark) return { ...base, hs6, note: "No Comtrade data for this HS code and origin." };
      const bp = basisPrice(line, benchmark.basis);
      if (!bp) {
        return {
          ...base, hs6, benchmark,
          note: benchmark.basis === "kg"
            ? `Priced per ${line.unit ?? "unit"} with no weight given, so it can't be compared per kg. Add the packing list or the net weight.`
            : `Priced per ${line.unit ?? "unit"}, but the benchmark is per item.`,
        };
      }
      return {
        ...base, hs6, benchmark, basis: benchmark.basis, basis_qty: bp.qty, unit_value: bp.price,
        ratio: usd ? Math.round((bp.price / benchmark.median) * 100) / 100 : null,
        note: usd ? null : `Invoice is in ${doc.currency ?? "an unstated currency"}; currency conversion comes in the next step.`,
      };
    }),
  );
  return { origin_m49: origin, lines, errors };
}
