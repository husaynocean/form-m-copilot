/**
 * PriceCheck step 3: compare each line with its benchmark, add the other red
 * flags, and combine everything into a 0–100 risk score with reasons.
 *
 * Everything here is deterministic: the model only reads the document; every
 * flag, number and sentence comes from code, so results are reproducible.
 */
import { checkPrintedHsCodes } from "../hs";
import { CATALOG } from "./catalog";
import { countryName } from "./countries";
import type { PriceDoc } from "./extract";
import type { FxRate } from "./fx";
import type { LineLookup } from "./lookup";
import type { Benchmark } from "./benchmarks";
import type { DocumentSet } from "../schema";
import hs6Table from "../data/hs6.json";

export type Severity = "high" | "medium" | "low" | "info";

export interface Flag {
  code: string;
  severity: Severity;
  points: number;
  title: string;
  detail: string;
  advice: string;
  line?: number;
}

export interface LineResult {
  line_no: number;
  description: string | null;
  hs6: string | null;
  goods: string | null;
  basis: "kg" | "item" | null;
  /** Invoice price per basis unit, FOB-equivalent US dollars. */
  price_usd: number | null;
  band: Pick<Benchmark, "low" | "median" | "high" | "confidence" | "points" | "years" | "sources" | "spread"> | null;
  ratio: number | null;
  position: "above" | "below" | "within" | "unchecked";
  note: string | null;
}

export interface PriceCheckResult {
  score: number;
  level: "low" | "medium" | "high";
  summary: string;
  flags: Flag[];
  lines: LineResult[];
  origin: string;
  currency: string | null;
  fx: FxRate | null;
  incoterm_note: string | null;
  checked_lines: number;
}

/** Beyond the band edge by less than this, a price is treated as normal. */
export const EDGE_TOLERANCE = 1.15;
const CONF_WEIGHT = { high: 1, medium: 0.8, low: 0.5 } as const;
const HS_NAMES = new Map((hs6Table as { code: string; desc: string }[]).map((e) => [e.code.replace(".", ""), e.desc]));

const usd = (n: number) => {
  const d = n >= 100 ? 0 : n >= 1 ? 2 : 3;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
const per = (basis: "kg" | "item") => (basis === "kg" ? "kg" : "item");
const times = (r: number) => `${r >= 10 ? Math.round(r) : r.toFixed(1)}×`;

export function goodsName(hs6: string | null): string | null {
  if (!hs6) return null;
  const c = CATALOG.find((x) => x.hs6 === hs6);
  if (c) return c.label;
  const d = HS_NAMES.get(hs6);
  return d ? d.split(";").slice(-1)[0].trim().replace(/^./, (m) => m.toUpperCase()).slice(0, 80) : `HS ${hs6}`;
}

/**
 * Line prices on a CIF/CFR invoice usually include freight (and insurance)
 * unless they are listed separately, so they are brought back to FOB to
 * compare with the FOB-equivalent bands.
 */
export function incotermFactor(doc: PriceDoc): { factor: number; note: string | null } {
  const term = (doc.incoterm ?? "").toUpperCase();
  const goods = doc.lines.reduce((t, l) => t + (l.line_total ?? 0), 0);
  const separate = doc.total != null && goods > 0 && doc.total > goods * 1.005;
  if (!["CIF", "CIP", "CFR", "CNF", "C&F", "CPT"].includes(term)) return { factor: 1, note: null };
  if (separate) return { factor: 1, note: `${term} invoice with freight listed separately: line prices compared as FOB.` };
  const f = term === "CIF" || term === "CIP" ? 1.1 : 1.08;
  return { factor: f, note: `${term} prices include freight${f > 1.08 ? " and insurance" : ""}; divided by ${f} to compare with FOB prices.` };
}

/** One plain sentence for the headline, naming the goods and the gap. */
function riskReason(f: Flag, lines: LineResult[]): string {
  const l = f.line ? lines.find((x) => x.line_no === f.line) : undefined;
  if ((f.code === "PRICE_ABOVE_RANGE" || f.code === "PRICE_BELOW_RANGE") && l?.ratio != null && l.goods) {
    return `The invoice prices ${l.goods.replace(/^./, (m) => m.toLowerCase())} at ${times(l.ratio)} the typical price, a sign of possible ${f.code === "PRICE_ABOVE_RANGE" ? "over" : "under"}-invoicing.`;
  }
  return `${f.title.replace(/^Lines? [\d ,and]+: /, "").replace(/^./, (m) => m.toUpperCase())}.`;
}

export function scorePriceCheck(
  doc: PriceDoc,
  lookups: LineLookup[],
  ctx: { origin_m49: number | null; fx: FxRate | null; knownSupplier: boolean | null },
): PriceCheckResult {
  const flags: Flag[] = [];
  const origin = countryName(ctx.origin_m49);
  const inc = incotermFactor(doc);
  const goodsTotal = doc.lines.reduce((t, l) => t + (l.line_total ?? 0), 0) || 1;

  // --- 1. price against the benchmark ---------------------------------------
  const lines: LineResult[] = lookups.map((lk) => {
    const b = lk.benchmark;
    const base: LineResult = {
      line_no: lk.line_no, description: lk.line.description, hs6: lk.hs6, goods: goodsName(lk.hs6), basis: lk.basis,
      price_usd: null, band: b ? { low: b.low, median: b.median, high: b.high, confidence: b.confidence, points: b.points, years: b.years, sources: b.sources, spread: b.spread } : null,
      ratio: null, position: "unchecked", note: lk.note,
    };
    if (!b || lk.unit_value == null || !lk.basis) return base;
    if (!ctx.fx) return { ...base, note: `Can't convert ${doc.currency ?? "the invoice currency"} to US dollars, so the price wasn't compared.` };
    const p = lk.unit_value / ctx.fx.per_usd / inc.factor;
    const ratio = p / b.median;
    const res: LineResult = { ...base, price_usd: p, ratio: Math.round(ratio * 100) / 100, note: null };
    const share = (lk.line.line_total ?? 0) / goodsTotal;
    const years = `${b.years[0]}–${b.years[b.years.length - 1]}`;
    const range = `${usd(b.low)}–${usd(b.high)} per ${per(b.basis)} FOB (typically ${usd(b.median)}; UN Comtrade, ${years})`;
    const wide = b.spread > 3 ? " This HS code covers products of very different sizes and specifications, so the normal range is wide." : "";
    const goods = base.goods ?? `HS ${lk.hs6}`;
    if (p > b.high || p < b.low) {
      const above = p > b.high;
      const factor = above ? p / b.high : b.low / p;
      // Just past the band edge counts as normal; the line says so.
      res.position = factor >= EDGE_TOLERANCE ? (above ? "above" : "below") : "within";
      if (factor < EDGE_TOLERANCE) res.note = `Just ${above ? "above" : "below"} the normal range, within the ${Math.round((EDGE_TOLERANCE - 1) * 100)}% tolerance.`;
      if (factor >= EDGE_TOLERANCE) {
        // Beyond the band edge by 1.2x ~18 points, 1.5x ~41, 1.8x ~60 (high), 2.2x+ 80
        // (before the confidence and line-share weights).
        const pts = Math.min(80, Math.max(10, Math.log2(factor) * 70)) * CONF_WEIGHT[b.confidence] * (0.6 + 0.4 * share);
        flags.push({
          code: above ? "PRICE_ABOVE_RANGE" : "PRICE_BELOW_RANGE",
          severity: pts >= 35 ? "high" : pts >= 18 ? "medium" : "low",
          points: Math.round(pts),
          line: lk.line_no,
          title: `Line ${lk.line_no}: ${above ? "priced well above" : "priced well below"} the normal range (${times(ratio)} the typical price)`,
          detail: `${goods} from ${origin} normally trade at ${range}. This invoice prices them at ${usd(p)} per ${per(b.basis)}.${wide}${b.confidence === "low" ? " The benchmark has low confidence." : ""}`,
          advice: above
            ? "Over-invoicing moves more foreign exchange out than the goods are worth. Ask for the supplier's price list or a competing quote, and check that the specification justifies the price."
            : "Under-invoicing lowers the duty paid and can hide a side payment to the supplier. Confirm the price with the supplier and compare with earlier shipments.",
        });
      }
    } else {
      res.position = "within";
    }
    return res;
  });

  // --- 2. HS code vs description --------------------------------------------
  const asDocs = { proforma_invoice: { lines: doc.lines.map((l) => ({ ...l })) } } as unknown as DocumentSet;
  for (const i of checkPrintedHsCodes(asDocs)) {
    const n = Number(/lines\[(\d+)\]/.exec(i.evidence[0]?.field ?? "")?.[1] ?? -1) + 1;
    flags.push({
      code: i.code === "HS_CODE_INVALID" ? "HS_CODE_INVALID" : "HS_DESCRIPTION_MISMATCH",
      severity: "medium",
      points: i.code === "HS_CODE_INVALID" ? 15 : 12,
      line: n || undefined,
      title: i.code === "HS_CODE_INVALID" ? `Line ${n}: HS code does not exist` : `Line ${n}: HS code doesn't match the description`,
      detail: i.detail,
      advice: "A wrong HS code can be used to compare against the wrong price range or pay less duty. Confirm the classification with your clearing agent.",
    });
  }

  // --- 3. same unit price for different goods --------------------------------
  const seen = new Map<number, number>();
  doc.lines.forEach((l, i) => {
    if (!l.unit_price || l.unit_price <= 0) return;
    const j = seen.get(l.unit_price);
    const other = j == null ? null : doc.lines[j];
    if (other && (other.description ?? "").toLowerCase() !== (l.description ?? "").toLowerCase() && (lines[j!].hs6 ?? "") !== (lines[i].hs6 ?? "x")) {
      flags.push({
        code: "SAME_PRICE_DIFFERENT_GOODS", severity: "medium", points: 10, line: i + 1,
        title: `Lines ${j! + 1} and ${i + 1}: different goods at exactly the same price`,
        detail: `"${other.description}" and "${l.description}" are both priced at ${l.unit_price.toLocaleString("en-US")} ${doc.currency ?? ""} per unit.`.replace(" per", " per").replace(/ +/g, " "),
        advice: "Identical prices for unrelated goods suggest the prices were filled in rather than quoted. Ask for an itemised quotation.",
      });
    } else if (j == null) seen.set(l.unit_price, i);
  });

  // --- 4. round numbers ------------------------------------------------------
  const roundUnit = (x: number | null) => x != null && x >= 100 && x % 100 === 0;
  // Bulk commodities are conventionally quoted in round prices per tonne or kg.
  const BULK = /^(mt|t|ton|tons|tonne|tonnes|metric tons?|kg|kgs)$/i;
  const priced = doc.lines.filter((l) => l.unit_price != null && !BULK.test((l.unit ?? "").trim()));
  const roundTotal = doc.total != null && doc.total >= 10_000 && doc.total % 1_000 === 0;
  if (priced.length && priced.every((l) => roundUnit(l.unit_price)) && (priced.length >= 2 || roundTotal)) {
    flags.push({
      code: "ROUND_PRICES", severity: "low", points: 6,
      title: "All prices are round numbers",
      detail: `Every unit price is a whole hundred${roundTotal ? ` and the total (${doc.total!.toLocaleString("en-US")}) is a round thousand` : ""}. Real quotations usually reflect actual costs and rarely come out this round.`,
      advice: "On its own this is weak evidence; it matters more alongside a price outside the normal range.",
    });
  }

  // --- 5. arithmetic ---------------------------------------------------------
  doc.lines.forEach((l, i) => {
    if (l.quantity == null || l.unit_price == null || l.line_total == null) return;
    const want = l.quantity * l.unit_price;
    if (Math.abs(want - l.line_total) > Math.max(1, 0.005 * l.line_total)) {
      flags.push({
        code: "LINE_ARITHMETIC", severity: "medium", points: 10, line: i + 1,
        title: `Line ${i + 1}: quantity × price doesn't equal the line total`,
        detail: `${l.quantity.toLocaleString("en-US")} × ${l.unit_price.toLocaleString("en-US")} = ${want.toLocaleString("en-US", { maximumFractionDigits: 2 })}, but the line total is ${l.line_total.toLocaleString("en-US")}.`,
        advice: "Ask the supplier to correct the invoice; the amount paid must match the goods.",
      });
    }
  });

  // --- 6. new supplier -------------------------------------------------------
  if (ctx.knownSupplier === false && doc.supplier) {
    flags.push({
      code: "NEW_SUPPLIER", severity: "low", points: 5,
      title: "First invoice from this supplier",
      detail: `${doc.supplier} hasn't appeared in your earlier price checks.`,
      advice: "New counterparties deserve a closer look: confirm the supplier exists and trades in these goods.",
    });
  }

  // --- notes that don't add to the score ------------------------------------
  const unchecked = lines.filter((l) => l.position === "unchecked");
  if (unchecked.length) {
    flags.push({
      code: "NOT_COMPARED", severity: "info", points: 0,
      title: `${unchecked.length} of ${lines.length} line${lines.length > 1 ? "s" : ""} couldn't be compared`,
      detail: unchecked.map((l) => `Line ${l.line_no}: ${l.note ?? "no benchmark"}`).join(" "),
      advice: "Add the HS code and the net weight (e.g. the packing list) for a complete check.",
    });
  }
  if (ctx.fx?.source === "fallback") {
    flags.push({
      code: "FX_APPROXIMATE", severity: "info", points: 0,
      title: "Approximate exchange rate used",
      detail: `Live rates were unavailable, so ${ctx.fx.currency} was converted at ${ctx.fx.per_usd} per US dollar (${ctx.fx.as_of}).`,
      advice: "Recheck when live rates are back if the price is close to the range edge.",
    });
  }

  const score = Math.min(100, Math.round(flags.reduce((t, f) => t + f.points, 0)));
  const level = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  const order: Severity[] = ["high", "medium", "low", "info"];
  flags.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || b.points - a.points);
  const top = flags.find((f) => f.points > 0);
  const checked = lines.length - unchecked.length;
  const summary =
    checked === 0 && !top ? "No line could be compared with a benchmark, so this invoice couldn't be scored on price."
    : level === "low" ? `${checked} of ${lines.length} line${lines.length > 1 ? "s" : ""} compared${top ? `; minor point: ${top.title.replace(/^Lines? [\d ,and]+: /, "").replace(/^./, (m) => m.toLowerCase())}` : ", all within the normal price range"}.`
    : `${riskReason(top!, lines)}${flags.filter((f) => f.points > 0).length > 1 ? ` Plus ${flags.filter((f) => f.points > 0).length - 1} other warning${flags.filter((f) => f.points > 0).length > 2 ? "s" : ""}.` : ""}`;
  return { score, level, summary, flags, lines, origin, currency: doc.currency, fx: ctx.fx, incoterm_note: inc.note, checked_lines: checked };
}
