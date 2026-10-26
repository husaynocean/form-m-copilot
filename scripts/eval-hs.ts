/**
 * HS-code assistant evaluation on samples/hs_testset.json (30 hand-checked items).
 *   npm run eval:hs                 -> retrieval only (no model): is the right code in the shortlist?
 *   npm run eval:hs -- --model      -> retrieval + model choice (needs a provider key)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { searchHs, suggestHs } from "../lib/hs";

const set: { description: string; code: string }[] = JSON.parse(
  readFileSync(join(__dirname, "..", "samples", "hs_testset.json"), "utf8"),
);
const useModel = process.argv.includes("--model");

(async () => {
  const ks = [1, 5, 15];
  const hits: Record<number, number> = { 1: 0, 5: 0, 15: 0 };
  let modelOk = 0, modelHeading = 0, abstain = 0;
  for (const t of set) {
    const codes = searchHs(t.description, 15).map((c) => c.code);
    const rank = codes.indexOf(t.code);
    ks.forEach((k) => { if (rank >= 0 && rank < k) hits[k]++; });
    let line = `${rank >= 0 ? `#${rank + 1}`.padEnd(4) : "MISS"} ${t.code}  ${t.description}`;
    if (rank < 0) line += `  (top: ${codes.slice(0, 3).join(", ")})`;
    if (useModel) {
      const s = await suggestHs(t.description);
      if (s.code === t.code) modelOk++;
      if (s.code?.slice(0, 4) === t.code.slice(0, 4)) modelHeading++;
      if (!s.code) abstain++;
      line += `  -> model ${s.code ?? "null"} (${s.confidence})${s.code === t.code ? "" : " ✗"}`;
    }
    console.log(line);
  }
  console.log(`\nRetrieval recall: @1 ${hits[1]}/${set.length}  @5 ${hits[5]}/${set.length}  @15 ${hits[15]}/${set.length}`);
  if (useModel) console.log(`Model: exact ${modelOk}/${set.length}, correct heading ${modelHeading}/${set.length}, abstained ${abstain}`);
})();
