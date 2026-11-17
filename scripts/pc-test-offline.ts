/**
 * PriceCheck offline tests (no network): Comtrade record parsing, unit values,
 * band statistics, unit conversion and Form M check reuse.
 *   npx tsx scripts/pc-test-offline.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toRecord, queriesFor, defaultPeriods } from "../lib/pricecheck/comtrade";
import { summarise, unitValue } from "../lib/pricecheck/benchmarks";
import { basisPrice } from "../lib/pricecheck/units";
import { fromDocumentSet } from "../lib/pricecheck/extract";
import { hs6Of } from "../lib/pricecheck/catalog";
import { toM49 } from "../lib/pricecheck/countries";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };

const q = queriesFor("850212", 156, [2020, 2021, 2022, 2023, 2024]);
t("three views for a known origin", () => assert.deepEqual(q.map((x) => x.source), ["ng_imports", "mirror_exports_to_ng", "origin_exports_world"]));
t("unknown origin falls back to Nigeria's imports from the world", () => assert.equal(queriesFor("850212", null, [2023])[0].partner, 0));
t("periods are the last five complete years", () => assert.deepEqual(defaultPeriods(new Date("2026-11-17")), [2020, 2021, 2022, 2023, 2024]));

const row = (o: Record<string, unknown>) => ({ customsCode: "C00", motCode: 0, partner2Code: 0, reporterCode: 566, partnerCode: 156, period: 2023, qtyUnitCode: 5, qtyUnitAbbr: "u", ...o });
t("imports use CIF value", () => assert.equal(toRecord(row({ cifvalue: 100000, fobvalue: 90000, primaryValue: 100000, netWgt: 1000, qty: 10 }), q[0])?.value_basis, "cif"));
t("exports use FOB value", () => assert.equal(toRecord(row({ cifvalue: 0, fobvalue: 90000, primaryValue: 90000, netWgt: 1000 }), q[1])?.value_basis, "fob"));
t("customs/transport breakdown rows are skipped", () => assert.equal(toRecord(row({ customsCode: "C01", cifvalue: 1 }), q[0]), null));
t("string numbers are parsed", () => assert.equal(toRecord(row({ primaryValue: "250000", netWgt: "5000" }), q[0])?.net_wgt_kg, 5000));

const rec = toRecord(row({ cifvalue: 800000, netWgt: 145000, qty: 100 }), q[0])!;
t("unit value per item", () => assert.equal(unitValue(rec, "item"), 8000));
t("unit value per kg", () => assert.ok(Math.abs(unitValue(rec, "kg")! - 5.517) < 0.01));
t("no per-item value when the supplementary unit isn't a count", () => assert.equal(unitValue({ ...rec, qty_unit_code: 8 }, "item"), null));
t("tiny flows are ignored", () => assert.equal(unitValue({ ...rec, value_usd: 1000 }, "item"), null));
t("estimated quantities are not used per item", () => assert.equal(unitValue({ ...rec, qty_estimated: true }, "item"), null));
t("estimated weights are not used per kg", () => assert.equal(unitValue({ ...rec, wgt_estimated: true }, "kg"), null));

// Five direct-route years around $8,000 per set plus one bad record ($800,000 per set).
const flows = [7500, 8000, 8200, 8800, 9500].map((u, i) => ({ ...rec, period: 2020 + i, value_usd: u * 100 }));
flows.push({ ...rec, period: 2024, source: "mirror_exports_to_ng", flow: "X", value_basis: "fob", value_usd: 800000 * 100 });
const b = summarise("850212", 156, "item", flows)!;
t("band is built from the direct route", () => assert.deepEqual(b.sources.sort(), ["ng_imports"]));
t("wild values are dropped", () => assert.equal(b.points, 5));
t("median is in the middle of the band", () => assert.ok(b.low <= b.median && b.median <= b.high && b.median >= 8000 && b.median <= 8800, JSON.stringify(b)));
t("a single data point is not a benchmark", () => assert.equal(summarise("252329", 792, "kg", [{ ...rec, period: 2024 }]), null));
t("tight five-year band is high confidence", () => assert.equal(b.confidence, "high"));
t("falls back to world exports when the direct route is thin", () => {
  const world = [5, 6, 7].map((u, i) => ({ ...rec, source: "origin_exports_world" as const, flow: "X" as const, partner_m49: 0, period: 2021 + i, value_usd: u * 1e6, net_wgt_kg: 1e6 }));
  const s = summarise("850212", 156, "kg", [{ ...rec, period: 2024 }, ...world])!;
  assert.ok(s.sources.includes("origin_exports_world") && s.points === 4);
});

t("MT converts to kg", () => assert.equal(basisPrice({ description: "wheat", hs_code: "1001.19", quantity: 120, unit: "MT", unit_price: 330, line_total: 39600, net_weight_kg: null }, "kg")?.price, 0.33));
t("sets count as items", () => assert.equal(basisPrice({ description: "genset", hs_code: "8502.12", quantity: 2, unit: "set", unit_price: 8000, line_total: 16000, net_weight_kg: null }, "item")?.price, 8000));
t("drums need a weight for a per-kg price", () => assert.equal(basisPrice({ description: "paste", hs_code: "2002.90", quantity: 160, unit: "drum", unit_price: 196.5, line_total: 31440, net_weight_kg: null }, "kg"), null));
t("packing-list weight makes drums comparable", () => assert.ok(Math.abs(basisPrice({ description: "paste", hs_code: "2002.90", quantity: 160, unit: "drum", unit_price: 196.5, line_total: 31440, net_weight_kg: 37600 }, "kg")!.price - 0.836) < 0.001));
t("HS code normalisation", () => { assert.equal(hs6Of("8502.12.00.00"), "850212"); assert.equal(hs6Of("8502"), null); });
t("country names map to M49", () => { assert.equal(toM49("China"), 156); assert.equal(toM49("United Arab Emirates"), 784); assert.equal(toM49("Narnia"), null); });

const key = JSON.parse(readFileSync(join(__dirname, "..", "samples", "cases", "case_01", "answer_key.json"), "utf8"));
const docs = {
  proforma_invoice: { doc_type: "proforma_invoice", seller: { name: key.beneficiary.name, address: null, rc_number: null }, buyer: { name: key.importer.name, address: null, rc_number: null },
    invoice_number: key.proforma.number, invoice_date: key.proforma.date, valid_until: null, currency: "USD", incoterm: key.proforma.incoterm,
    country_of_origin: key.proforma.country_of_origin, country_of_supply: key.proforma.country_of_supply, port_of_loading: null, port_of_discharge: null, mode_of_transport: null, payment_terms: null,
    lines: key.proforma.items.map((i: Record<string, unknown>) => ({ description: i.description, hs_code: i.hs_code, quantity: i.quantity, unit: i.unit, unit_price: i.unit_price, line_total: i.line_total })),
    goods_value: key.proforma.goods_value, freight: null, insurance: null, total: key.proforma.total },
  packing_list: { doc_type: "packing_list", seller: { name: null, address: null }, buyer: { name: null, address: null }, packing_list_number: null, date: null, proforma_reference: null, port_of_discharge: null,
    lines: key.packing_list.items.map((i: Record<string, unknown>) => ({ description: i.description, quantity: i.quantity, unit: i.unit, packages: i.packages, net_weight_kg: i.net_weight_kg, gross_weight_kg: i.gross_weight_kg })) },
} as never;
const pd = fromDocumentSet(docs)!;
t("Form M check results are reused, with packing-list weights", () => { assert.equal(pd.lines.length, key.proforma.items.length); assert.equal(pd.lines[0].net_weight_kg, key.packing_list.items[0].net_weight_kg); });

console.log(`\n${n} passed`);
