/**
 * Evaluate the deterministic validation engine on the synthetic test pack,
 * assuming perfect extraction. Reports per-case results plus precision/recall.
 *
 *   npm run eval:rules
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validate } from "../lib/validate";
import { caseToDocs } from "./case-to-docs";

const CASES = join(__dirname, "..", "samples", "cases");
const TODAY = new Date("2026-11-01"); // fixed so results are reproducible

let tp = 0, fp = 0, fn = 0;
for (const id of readdirSync(CASES).sort()) {
  const key = JSON.parse(readFileSync(join(CASES, id, "answer_key.json"), "utf8"));
  const expected = new Set<string>(key.expected_issues);
  const found = new Set(validate(caseToDocs(key), TODAY).map((i) => i.code));
  const hit = [...expected].filter((c) => found.has(c));
  const missed = [...expected].filter((c) => !found.has(c));
  const extra = [...found].filter((c) => !expected.has(c));
  tp += hit.length; fn += missed.length; fp += extra.length;
  const ok = missed.length === 0 && extra.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"} ${id}  expected=[${[...expected].join(",")}]` +
    (missed.length ? `  missed=[${missed.join(",")}]` : "") +
    (extra.length ? `  extra=[${extra.join(",")}]` : ""));
}
const precision = tp / Math.max(1, tp + fp);
const recall = tp / Math.max(1, tp + fn);
console.log(`\nprecision ${(precision * 100).toFixed(1)}%  recall ${(recall * 100).toFixed(1)}%  (tp=${tp} fp=${fp} fn=${fn})`);
process.exit(fp + fn === 0 ? 0 : 1);
