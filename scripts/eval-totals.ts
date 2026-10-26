/**
 * Robustness check for the money re-read: extract the proforma invoice of
 * selected cases N times and count how often the PRINTED total is preserved.
 *   npx tsx scripts/eval-totals.ts 4 case_04 case_12 case_01
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDocument } from "../lib/extract";

const [nArg, ...ids] = process.argv.slice(2);
const N = Number(nArg) || 3;
(async () => {
  let ok = 0, total = 0;
  for (const id of ids) {
    const dir = join(__dirname, "..", "samples", "cases", id);
    const key = JSON.parse(readFileSync(join(dir, "answer_key.json"), "utf8"));
    const printed = key.proforma.printed_total ?? key.proforma.total;
    const img = `data:image/jpeg;base64,${readFileSync(join(dir, "photos", "proforma_invoice.jpg")).toString("base64")}`;
    const runs = await Promise.all(Array.from({ length: N }, () => extractDocument(img).catch((e) => e as Error)));
    for (const r of runs) {
      total++;
      if (r instanceof Error) { console.log(`${id} ERROR ${r.message.slice(0, 80)}`); continue; }
      const got = r.extraction.doc_type === "proforma_invoice" ? r.extraction.total : null;
      const good = got != null && Math.abs(got - printed) < 0.01;
      if (good) ok++;
      console.log(`${id} printed=${printed} got=${got} ${good ? "OK" : "WRONG"}  verify=${JSON.stringify(r.verification)}`);
    }
  }
  console.log(`\nPrinted total preserved: ${ok}/${total}`);
})();
