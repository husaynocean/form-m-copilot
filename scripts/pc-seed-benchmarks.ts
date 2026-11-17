/**
 * Fetch Comtrade flows for the 20 catalogue HS codes and their usual origins,
 * then print the benchmark band for each. Writes the raw records to
 * lib/pricecheck/benchmarks-seed.json, which ships with the app.
 *
 *   PC_STORE=memory npx tsx scripts/pc-seed-benchmarks.ts [hs6 ...]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "../lib/pricecheck/catalog";
import { defaultPeriods, fetchFlows, queriesFor, type FlowRecord } from "../lib/pricecheck/comtrade";
import { summarise } from "../lib/pricecheck/benchmarks";

const only = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = process.env.SEED_OUT ?? join(__dirname, "..", "lib", "pricecheck", "benchmarks-seed.json");
  const periods = defaultPeriods();
  // Keep earlier runs' records for codes not fetched this time.
  const done = new Set(CATALOG.filter((x) => !only.length || only.includes(x.hs6)).map((x) => x.hs6));
  const all: FlowRecord[] = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")).records as FlowRecord[]).filter((r) => !done.has(r.hs6)) : [];
  for (const c of CATALOG.filter((x) => !only.length || only.includes(x.hs6))) {
    for (const origin of c.origins) {
      const flows: FlowRecord[] = [];
      for (const q of queriesFor(c.hs6, origin, periods)) {
        // World exports only when the direct route gave fewer than 3 records.
        if (q.source === "origin_exports_world" && flows.length >= 3) continue;
        try {
          flows.push(...(await fetchFlows(q)));
        } catch (e) {
          console.log(`   ${c.hs6} ${q.source} from ${origin}: ${(e as Error).message.slice(0, 120)}`);
        }
        await sleep(300);
      }
      all.push(...flows);
      const b = summarise(c.hs6, origin, c.basis, flows) ?? summarise(c.hs6, origin, c.basis === "kg" ? "item" : "kg", flows);
      console.log(
        `${c.hs6} ${c.label.padEnd(38)} origin ${String(origin).padEnd(4)} ` +
          (b ? `${b.basis === "kg" ? "USD/kg  " : "USD/item"} ${b.low} – ${b.median} – ${b.high}  (${b.points} pts, ${b.confidence}, ${b.sources.join("+")})` : `not enough data (${flows.length} records)`),
      );
    }
  }
  writeFileSync(out, JSON.stringify({ fetched_at: new Date().toISOString(), periods, records: all }));
  console.log(`\n${all.length} records saved to ${out}`);
})();
