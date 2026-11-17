/**
 * Fetch Comtrade flows for the 20 catalogue HS codes and their usual origins,
 * then print the benchmark band for each. Writes the raw records to
 * data/pricecheck/benchmarks-seed.json (loaded into pc_benchmarks).
 *
 *   PC_STORE=memory npx tsx scripts/pc-seed-benchmarks.ts [hs6 ...]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "../lib/pricecheck/catalog";
import { defaultPeriods, fetchFlows, queriesFor, type FlowRecord } from "../lib/pricecheck/comtrade";
import { summarise } from "../lib/pricecheck/benchmarks";

const only = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const all: FlowRecord[] = [];
  const periods = defaultPeriods();
  for (const c of CATALOG.filter((x) => !only.length || only.includes(x.hs6))) {
    for (const origin of c.origins) {
      const flows: FlowRecord[] = [];
      for (const q of queriesFor(c.hs6, origin, periods)) {
        try {
          flows.push(...(await fetchFlows(q)));
        } catch (e) {
          console.log(`   ${c.hs6} ${q.source} from ${origin}: ${(e as Error).message.slice(0, 120)}`);
        }
        await sleep(1200); // be polite to the keyless endpoint
      }
      all.push(...flows);
      const b = summarise(c.hs6, origin, c.basis, flows);
      console.log(
        `${c.hs6} ${c.label.padEnd(38)} origin ${String(origin).padEnd(4)} ` +
          (b ? `${c.basis === "kg" ? "USD/kg  " : "USD/item"} ${b.low} – ${b.median} – ${b.high}  (${b.points} pts, ${b.years[0]}–${b.years[b.years.length - 1]}, ${b.sources.join("+")})` : `no data (${flows.length} records)`),
      );
    }
  }
  const out = join(__dirname, "..", "data", "pricecheck", "benchmarks-seed.json");
  writeFileSync(out, JSON.stringify({ fetched_at: new Date().toISOString(), periods, records: all }, null, 1));
  console.log(`\n${all.length} records saved to data/pricecheck/benchmarks-seed.json`);
})();
