/**
 * Plan the PriceCheck demo set. "Fair" prices are drawn from inside the real
 * Comtrade bands (lib/pricecheck/benchmarks-seed.json). Every company is invented.
 *   pc01–pc30  the original set: obvious mispricing, 1.8–2.4x beyond the band edge
 *   pc31–pc40  subtle mispricing: a true price anywhere in the normal range,
 *              marked up or down by 1.2–1.5x (closer to real over-invoicing;
 *              some of these are expected to slip through)
 *
 *   npx tsx scripts/pc-demo-plan.ts && python3 scripts/generate_pricecheck_demo.py
 *
 * Writes samples/pricecheck/demo/plan.json: for each invoice the printed
 * document (ground truth for extraction) and what the check should find.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import seed from "../lib/pricecheck/benchmarks-seed.json";
import { summarise, type Benchmark } from "../lib/pricecheck/benchmarks";
import type { FlowRecord } from "../lib/pricecheck/comtrade";
import type { PriceDoc, PriceLine } from "../lib/pricecheck/extract";

// Deterministic randomness so the set is reproducible.
let s = 20261117;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const between = (a: number, b: number) => a + (b - a) * rnd();
const cents = (n: number) => {
  // Avoid suspiciously round prices in fair invoices: keep real cents.
  const v = Math.round(n * 100) / 100;
  return v % 1 === 0 ? v + 0.37 : v;
};

const FX_PER_USD: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79 }; // = fx.ts fallback table
const ORIGIN: Record<number, string> = { 156: "China", 699: "India", 764: "Thailand", 826: "United Kingdom", 792: "Turkey", 842: "USA", 124: "Canada", 392: "Japan", 528: "Netherlands", 579: "Norway", 682: "Saudi Arabia", 76: "Brazil", 372: "Ireland", 554: "New Zealand", 276: "Germany" };

// Goods with a band on the same basis the invoice is priced in.
const GOODS: { hs: string; desc: string; unit: string; perKg: number; origins: number[]; qty: [number, number] }[] = [
  { hs: "8502.12", desc: "Diesel generating set, 100 kVA, 3-phase, soundproof canopy", unit: "set", perKg: 0, origins: [156, 826], qty: [2, 8] },
  { hs: "8415.10", desc: "Split air conditioner, 1.5 HP, wall-mounted, inverter", unit: "unit", perKg: 0, origins: [156], qty: [120, 600] },
  { hs: "8711.20", desc: "Motorcycle, 125 cc petrol engine, 4-stroke", unit: "unit", perKg: 0, origins: [156, 699], qty: [60, 300] },
  { hs: "8703.23", desc: "Saloon car, 2.0 L petrol engine, used (2016 model)", unit: "unit", perKg: 0, origins: [842, 124], qty: [4, 20] },
  { hs: "8517.13", desc: "Smartphone, 6.5 inch, 64 GB, dual SIM", unit: "piece", perKg: 0, origins: [156], qty: [500, 3000] },
  { hs: "8477.10", desc: "Plastic injection moulding machine, 250 T clamping force", unit: "set", perKg: 0, origins: [276], qty: [1, 3] },
  { hs: "1006.30", desc: "White rice, long grain, 5% broken, 50 kg bags", unit: "MT", perKg: 1000, origins: [764, 699], qty: [200, 1000] },
  { hs: "1001.19", desc: "Durum wheat, unmilled, bulk", unit: "MT", perKg: 1000, origins: [124, 842], qty: [2000, 8000] },
  { hs: "1701.14", desc: "Raw cane sugar, VHP grade, bulk", unit: "MT", perKg: 1000, origins: [76], qty: [3000, 12000] },
  { hs: "0303.54", desc: "Frozen Atlantic mackerel, whole round, 300-500 g", unit: "MT", perKg: 1000, origins: [528, 579], qty: [100, 500] },
  { hs: "0402.21", desc: "Skimmed milk powder, 25 kg bags", unit: "MT", perKg: 1000, origins: [528, 372, 554], qty: [40, 200] },
  { hs: "3902.10", desc: "Polypropylene homopolymer granules, injection grade", unit: "MT", perKg: 1000, origins: [682, 156, 699], qty: [100, 600] },
  { hs: "2002.90", desc: "Tomato paste, 28-30% brix, aseptic bags in drums", unit: "MT", perKg: 1000, origins: [156], qty: [100, 400] },
];

const records = (seed as { records: FlowRecord[] }).records;
function band(hs: string, origin: number, basis: "kg" | "item"): Benchmark {
  const hs6 = hs.replace(/\D/g, "");
  const b = summarise(hs6, origin, basis, records.filter((r) => r.hs6 === hs6 && (r.partner_m49 === origin || r.reporter_m49 === origin)));
  if (!b || b.basis !== basis) throw new Error(`no ${basis} band for ${hs} from ${origin}`);
  return b;
}

const SUPPLIERS: Record<number, string[]> = {
  156: ["Ningbo Brightway Trading Co., Ltd", "Guangzhou Hengtai Industrial Co., Ltd", "Shenzhen Coolwave Appliances Co., Ltd", "Zhejiang Sunrise Machinery Co., Ltd"],
  699: ["Mumbai Crestline Exports Pvt Ltd", "Kochi Harvest Agro Pvt Ltd"], 764: ["Chao Phraya Grain Export Co., Ltd"], 826: ["Severn Power Systems Ltd"],
  842: ["Gulf Coast Auto Exports LLC", "Prairie Grain Merchants Inc."], 124: ["Maple Leaf Vehicle Traders Inc.", "Saskatoon Durum Co-op Ltd"],
  528: ["Rotterdam Cold Fish B.V.", "Holland Dairy Ingredients B.V."], 579: ["Bergen Pelagic AS"], 682: ["Jubail Polymer Trading Co."],
  76: ["Santos Sugar Exports Ltda"], 372: ["Shannon Milk Products Ltd"], 554: ["Waikato Dairy Exports Ltd"], 276: ["Rhein Kunststoffmaschinen GmbH"],
};
const BUYERS = ["Arewa Home Appliances Ltd", "Kano Mobility Ventures Ltd", "Sahel Foods & Grains Ltd", "Lagoon Industrial Supplies Ltd", "Zaria Agro Processing Ltd", "Delta Fresh Foods Ltd"];

type Plant = "over" | "under" | "subtle_over" | "subtle_under" | "same_price" | "hs_mismatch" | "round" | "arithmetic" | null;
interface Case {
  id: string; plant: Plant; expect_flag: boolean; expect_codes: string[]; planted_line: number | null; doc: PriceDoc;
  /** Subtle cases: the markup applied, and where the invoiced price lands against the band. */
  markup?: number; true_vs_typical?: number; invoiced_vs_typical?: number; band_edge_factor?: number;
}
const isOver = (p: Plant) => p === "over" || p === "subtle_over";
const isUnder = (p: Plant) => p === "under" || p === "subtle_under";

const cases: Case[] = [];
let n = 0;

function make(opts: { goods: number[]; origin?: number; currency?: string; incoterm?: string; plant?: Plant; plantedLine?: number; markup?: number }): Case {
  n++;
  const id = `pc${String(n).padStart(2, "0")}`;
  const plant = opts.plant ?? null;
  const g0 = GOODS[opts.goods[0]];
  // One origin for the whole invoice, and every line priced from that origin's
  // own range (the same range the checker will use).
  const common = g0.origins.filter((o) => opts.goods.every((gi) => GOODS[gi].origins.includes(o)));
  const origin = opts.origin ?? common[Math.floor(rnd() * common.length)];
  if (origin == null || !opts.goods.every((gi) => GOODS[gi].origins.includes(origin))) throw new Error(`goods ${opts.goods} don't all have a ${origin} range`);
  const currency = opts.currency ?? "USD";
  const incoterm = opts.incoterm ?? "FOB";
  const cifFactor = incoterm === "CIF" ? 1.1 : incoterm === "CFR" ? 1.08 : 1;
  const plantedLine = opts.plantedLine ?? 1;
  let subtle: Pick<Case, "markup" | "true_vs_typical" | "invoiced_vs_typical" | "band_edge_factor"> = {};
  const lines: PriceLine[] = opts.goods.map((gi, k) => {
    const g = GOODS[gi];
    const b = band(g.hs, origin, g.perKg ? "kg" : "item");
    // Fair FOB price per basis unit: near the typical price, inside the band.
    let fob = Math.min(b.high * 0.97, Math.max(b.low * 1.03, b.median * between(0.92, 1.08)));
    if (k + 1 === plantedLine && plant === "over") fob = b.high * between(1.8, 2.4);
    if (k + 1 === plantedLine && plant === "under") fob = b.low / between(1.8, 2.4);
    if (k + 1 === plantedLine && (plant === "subtle_over" || plant === "subtle_under")) {
      // The supplier's real price can sit anywhere in the normal range.
      const truePrice = between(b.low, b.high);
      const m = opts.markup!;
      fob = plant === "subtle_over" ? truePrice * m : truePrice / m;
      const edge = fob > b.high ? fob / b.high : fob < b.low ? b.low / fob : 1;
      subtle = { markup: m, true_vs_typical: +(truePrice / b.median).toFixed(2), invoiced_vs_typical: +(fob / b.median).toFixed(2), band_edge_factor: +edge.toFixed(2) };
    }
    const perUnit = fob * (g.perKg || 1) * cifFactor * FX_PER_USD[currency];
    const qty = Math.round(between(g.qty[0], g.qty[1]));
    const unit_price = cents(perUnit);
    return { description: g.desc, hs_code: g.hs, quantity: qty, unit: g.unit, unit_price, line_total: Math.round(qty * unit_price * 100) / 100, net_weight_kg: null };
  });
  const expect: string[] = [];
  if (isOver(plant)) expect.push("PRICE_ABOVE_RANGE");
  if (isUnder(plant)) expect.push("PRICE_BELOW_RANGE");
  if (plant === "same_price") {
    // Two goods whose normal ranges overlap, both priced at one figure inside
    // the overlap: the price is fair for each, only the coincidence is odd.
    const [a, b] = opts.goods.map((gi) => band(GOODS[gi].hs, origin, "kg"));
    const lo = Math.max(a.low, b.low), hi = Math.min(a.high, b.high);
    if (lo >= hi) throw new Error("same_price goods need overlapping bands");
    const price = cents(((lo + hi) / 2) * 1000 * cifFactor * FX_PER_USD[currency]);
    for (const l of lines) {
      l.unit_price = price;
      l.line_total = Math.round(l.quantity! * price * 100) / 100;
    }
    expect.push("SAME_PRICE_DIFFERENT_GOODS");
  }
  if (plant === "hs_mismatch") {
    lines[0].hs_code = "8415.10"; // air conditioners, on a line of frozen fish
    expect.push("HS_DESCRIPTION_MISMATCH");
  }
  if (plant === "round") {
    for (const l of lines) {
      l.unit_price = Math.max(100, Math.round(l.unit_price! / 100) * 100); // whole hundreds
      l.line_total = Math.round(l.quantity! * l.unit_price * 100) / 100;
    }
    expect.push("ROUND_PRICES");
  }
  if (plant === "arithmetic") {
    lines[0].line_total = Math.round((lines[0].line_total! + lines[0].unit_price! * 3) * 100) / 100;
    expect.push("LINE_ARITHMETIC");
  }
  const total = Math.round(lines.reduce((t, l) => t + (l.line_total ?? 0), 0) * 100) / 100;
  const sup = SUPPLIERS[origin] ?? SUPPLIERS[156];
  const doc: PriceDoc = {
    doc_kind: "proforma_invoice", form_m_number: null,
    supplier: sup[n % sup.length], supplier_country: ORIGIN[origin], buyer: BUYERS[n % BUYERS.length],
    invoice_number: `PI-26${String(10 + (n % 2)).padStart(2, "0")}-${String(100 + n * 7)}`, invoice_date: `2026-${n % 2 ? "10" : "11"}-${String(1 + (n % 27)).padStart(2, "0")}`,
    currency, incoterm, country_of_origin: ORIGIN[origin], country_of_supply: ORIGIN[origin], total, lines,
  };
  const mis = isOver(plant) || isUnder(plant);
  const c: Case = { id, plant, expect_flag: mis, expect_codes: expect, planted_line: mis ? plantedLine : null, doc, ...subtle };
  cases.push(c);
  return c;
}

// --- 15 fairly priced -------------------------------------------------------------
make({ goods: [1] });
make({ goods: [2, 1] });
make({ goods: [6] });
make({ goods: [7], origin: 124 });
make({ goods: [10], origin: 528, currency: "EUR" });
make({ goods: [3], origin: 842, incoterm: "CIF" });
make({ goods: [0], origin: 826, currency: "GBP" });
make({ goods: [9], origin: 579, currency: "EUR", incoterm: "CFR" });
make({ goods: [11], origin: 682 });
make({ goods: [12, 11], origin: 156 });
make({ goods: [8], origin: 76, incoterm: "CIF" });
make({ goods: [4, 2], origin: 156 });
make({ goods: [5], origin: 276, currency: "EUR" });
make({ goods: [6], origin: 699 });
make({ goods: [10], origin: 554, incoterm: "CIF" });
// --- 11 planted mispricing ---------------------------------------------------------
make({ goods: [1], plant: "over" });
make({ goods: [2, 1], origin: 156, plant: "over", plantedLine: 2 });
make({ goods: [4], plant: "over" });
make({ goods: [0], origin: 156, plant: "over", incoterm: "CIF" });
make({ goods: [3], origin: 124, plant: "over", currency: "EUR" });
make({ goods: [11], origin: 156, plant: "over" });
make({ goods: [6], origin: 764, plant: "under" });
make({ goods: [10], origin: 372, plant: "under", currency: "EUR" });
make({ goods: [9], origin: 528, plant: "under", incoterm: "CIF" });
make({ goods: [2], origin: 699, plant: "under" });
make({ goods: [7, 3], origin: 842, plant: "under", plantedLine: 1 }); // wheat and used cars from the USA
// --- 4 other red flags (prices fair) -----------------------------------------------
make({ goods: [11, 6], origin: 699, plant: "same_price" }); // polypropylene and rice from India
make({ goods: [9], origin: 528, plant: "hs_mismatch" });
make({ goods: [1, 2, 4], origin: 156, plant: "round" });
make({ goods: [11], origin: 699, plant: "arithmetic" });
// --- 10 subtle mispricing (pc31–pc40): 1.2–1.5x on a true price anywhere in the range
// Narrow and wide ranges, all currencies and terms, over and under.
make({ goods: [1], origin: 156, plant: "subtle_over", markup: 1.2 });                    // air conditioners, narrow range
make({ goods: [2], origin: 156, plant: "subtle_over", markup: 1.3 });                    // motorcycles
make({ goods: [4], origin: 156, plant: "subtle_over", markup: 1.5 });                    // smartphones
make({ goods: [0], origin: 826, plant: "subtle_over", markup: 1.4, currency: "GBP" });   // generators, wide range
make({ goods: [11, 6], origin: 699, plant: "subtle_over", markup: 1.35, plantedLine: 1 }); // polypropylene, one line of two
make({ goods: [6], origin: 764, plant: "subtle_under", markup: 1.2 });                   // rice
make({ goods: [8], origin: 76, plant: "subtle_under", markup: 1.3, incoterm: "CIF" });   // sugar
make({ goods: [10], origin: 528, plant: "subtle_under", markup: 1.5, currency: "EUR" }); // milk powder
make({ goods: [3], origin: 842, plant: "subtle_under", markup: 1.4 });                   // used cars, wide range
make({ goods: [9], origin: 579, plant: "subtle_under", markup: 1.25, currency: "EUR", incoterm: "CFR" }); // mackerel

const dir = join(__dirname, "..", "samples", "pricecheck", "demo");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "plan.json"), JSON.stringify(cases, null, 1));
console.log(`${cases.length} invoices: ${cases.filter((c) => !c.plant).length} fair, ${cases.filter((c) => c.plant === "over" || c.plant === "under").length} obvious mispricing, ${cases.filter((c) => c.plant?.startsWith("subtle")).length} subtle mispricing, ${cases.filter((c) => c.plant && !c.expect_flag).length} other red flags`);
for (const c of cases.filter((x) => x.markup)) console.log(`  ${c.id} ${c.plant} ${c.markup}x: true price ${c.true_vs_typical}x typical -> invoiced ${c.invoiced_vs_typical}x typical, ${c.band_edge_factor === 1 ? "inside the normal range" : `${c.band_edge_factor}x past the range edge`}`);
