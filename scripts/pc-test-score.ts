/**
 * PriceCheck scoring tests: synthetic invoices against the real (bundled)
 * Comtrade benchmarks. No network: PC_STORE=memory, PC_FX=fallback.
 *   npx tsx scripts/pc-test-score.ts
 */
process.env.PC_STORE = "memory";
process.env.PC_FX = "fallback";
import assert from "node:assert/strict";
import { runPriceCheck } from "../lib/pricecheck/run";
import type { PriceDoc, PriceLine } from "../lib/pricecheck/extract";

const L = (description: string, hs_code: string, quantity: number, unit: string, unit_price: number, extra: Partial<PriceLine> = {}): PriceLine =>
  ({ description, hs_code, quantity, unit, unit_price, line_total: Math.round(quantity * unit_price * 100) / 100, net_weight_kg: null, ...extra });
const D = (origin: string, lines: PriceLine[], extra: Partial<PriceDoc> = {}): PriceDoc => ({
  doc_kind: "proforma_invoice", form_m_number: null, supplier: "Test Supplier Co., Ltd", supplier_country: origin, buyer: "Test Importer Ltd",
  invoice_number: "PI-1", invoice_date: "2026-11-01", currency: "USD", incoterm: "FOB", country_of_origin: origin, country_of_supply: origin,
  total: Math.round(lines.reduce((t, l) => t + (l.line_total ?? 0), 0) * 100) / 100, lines, ...extra,
});

type Case = [string, PriceDoc, (r: Awaited<ReturnType<typeof runPriceCheck>>["result"]) => void, string?];
const codes = (r: { flags: { code: string; points: number }[] }) => r.flags.filter((f) => f.points > 0).map((f) => f.code);

const CASES: Case[] = [
  ["fairly priced motorcycles and air conditioners", D("China", [L("Motorcycle, 125 cc petrol", "8711.20", 120, "unit", 480), L("Split air conditioner, 1.5 HP", "8415.10", 300, "unit", 162)]),
    (r) => { assert.equal(r.level, "low"); assert.deepEqual(codes(r), []); }],
  ["air conditioners at 2.6x the normal price", D("China", [L("Split air conditioner, 1.5 HP", "8415.10", 300, "unit", 420)]),
    (r) => { assert.equal(r.level, "high"); assert.ok(codes(r).includes("PRICE_ABOVE_RANGE")); }],
  ["milk powder at half the normal price", D("Netherlands", [L("Skimmed milk powder, 25 kg bags", "0402.21", 20, "MT", 1800)]),
    (r) => { assert.ok(codes(r).includes("PRICE_BELOW_RANGE")); assert.equal(r.level, "high"); assert.ok(!codes(r).includes("ROUND_PRICES")); }],
  ["rice in euros, fairly priced", D("Thailand", [L("Thai white rice, 5% broken", "1006.30", 500, "MT", 470)], { currency: "EUR" }),
    (r) => { assert.equal(r.lines[0].position, "within"); assert.ok(r.flags.some((f) => f.code === "FX_APPROXIMATE")); }],
  ["CIF polypropylene with freight inside the price", D("China", [L("Polypropylene homopolymer granules", "3902.10", 100, "MT", 1500)], { incoterm: "CIF" }),
    (r) => { assert.equal(r.lines[0].position, "within"); assert.ok(r.incoterm_note?.includes("1.1")); assert.equal(r.score, 0); }],
  ["HS code that doesn't match the goods", D("Norway", [L("Frozen mackerel, whole round, 300-500 g", "8711.20", 50, "MT", 1550)]),
    (r) => assert.ok(codes(r).includes("HS_DESCRIPTION_MISMATCH"))],
  ["different goods at the same price", D("China", [L("Split air conditioner, 1.5 HP", "8415.10", 100, "unit", 165), L("Smartphone, 128 GB, dual SIM", "8517.13", 100, "unit", 165)]),
    (r) => assert.ok(codes(r).includes("SAME_PRICE_DIFFERENT_GOODS"))],
  ["round prices", D("China", [L("Diesel generating set, 100 kVA", "8502.12", 4, "set", 7000), L("Injection moulding machine, 250 T", "8477.10", 1, "set", 17000)]),
    (r) => assert.ok(codes(r).includes("ROUND_PRICES"))],
  ["slightly above the band edge is not flagged", D("China", [L("Motorcycle, 125 cc petrol", "8711.20", 120, "unit", 560)]),
    (r) => { assert.equal(r.lines[0].position, "above"); assert.deepEqual(codes(r), []); }],
  ["line arithmetic error", D("India", [{ ...L("Motorcycle, 150 cc", "8711.20", 200, "unit", 500), line_total: 120000 }]),
    (r) => assert.ok(codes(r).includes("LINE_ARITHMETIC"))],
  ["tomato paste per drum without weight", D("China", [L("Tomato paste, 220 L drums", "2002.90", 160, "drum", 196.5)]),
    (r) => { assert.equal(r.lines[0].position, "unchecked"); assert.equal(r.score, 0); }],
  ["tomato paste per drum with packing-list weight, fair", D("China", [L("Tomato paste, 220 L drums", "2002.90", 160, "drum", 210, { net_weight_kg: 37600 })]),
    (r) => assert.equal(r.lines[0].position, "within")],
];

(async () => {
  for (const [name, doc, check] of CASES) {
    const { result: r } = await runPriceCheck(doc);
    try {
      check(r);
      console.log(`PASS ${name}: ${r.score}/100 ${r.level}${codes(r).length ? ` [${codes(r).join(", ")}]` : ""}`);
    } catch (e) {
      console.log(`FAIL ${name}: ${r.score}/100 ${r.level} [${codes(r).join(", ")}]\n   ${(e as Error).message}\n   ${JSON.stringify(r.lines.map((l) => ({ p: l.price_usd, band: l.band && [l.band.low, l.band.median, l.band.high], pos: l.position, note: l.note })))}`);
      process.exitCode = 1;
    }
  }
  // New supplier: first time flagged, second time known.
  const owner = "test-owner-key-0123456789abcdef";
  const doc = D("China", [L("Motorcycle, 125 cc petrol", "8711.20", 120, "unit", 480)], { supplier: "Fresh Supplier Ltd" });
  const first = (await runPriceCheck(doc, { owner })).result;
  const second = (await runPriceCheck(doc, { owner })).result;
  assert.ok(codes(first).includes("NEW_SUPPLIER") && !codes(second).includes("NEW_SUPPLIER"));
  console.log("PASS new supplier flagged once, then remembered");
  const { result } = await runPriceCheck(CASES[1][1]);
  console.log("\nExample explanation:\n", result.summary, "\n", result.flags[0].title, "\n", result.flags[0].detail, "\n", result.flags[0].advice);
})();
