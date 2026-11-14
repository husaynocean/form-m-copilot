/**
 * Export (Form NXP) evaluation on the synthetic export pack.
 *
 *   npx tsx scripts/eval-export.ts            rules only, on the answer keys
 *   npx tsx scripts/eval-export.ts --model    real model extraction from the photos, then rules
 *
 * Scores the issues found against each case's expected issues.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractDocument } from "../lib/extract";
import { checkPrintedHsCodes } from "../lib/hs";
import { validateExport } from "../lib/nxp";
import type { DocumentSet, Extraction } from "../lib/schema";

const CASES = join(__dirname, "..", "samples", "export_cases");
const useModel = process.argv.includes("--model");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILES = ["commercial_invoice", "packing_list", "bill_of_lading", "nepc_certificate"];

async function main() {
  let tp = 0, fp = 0, fn = 0, classified = 0, pages = 0;
  for (const id of readdirSync(CASES).sort()) {
    if (only.length && !only.includes(id)) continue;
    const key = JSON.parse(readFileSync(join(CASES, id, "answer_key.json"), "utf8"));
    let docs: DocumentSet = key.truth;
    if (useModel) {
      docs = {};
      await Promise.all(
        FILES.map(async (f) => {
          pages++;
          const b64 = readFileSync(join(CASES, id, "photos", `${f}.jpg`)).toString("base64");
          try {
            const e: Extraction = (await extractDocument(`data:image/jpeg;base64,${b64}`)).extraction;
            (docs as Record<string, Extraction>)[e.doc_type] = e;
            const want = f === "commercial_invoice" ? "proforma_invoice" : f;
            if (e.doc_type === want) classified++;
          } catch (err) {
            console.log(`   ${id}/${f}: FAILED ${String((err as Error).message).slice(0, 160)}`);
          }
        }),
      );
    }
    const found = new Set([...validateExport(docs, key.category, new Date(key.today)), ...checkPrintedHsCodes(docs)].map((i) => i.code));
    const want = new Set<string>(key.expected_issues);
    const missed = [...want].filter((c) => !found.has(c));
    const extra = [...found].filter((c) => !want.has(c));
    tp += want.size - missed.length; fn += missed.length; fp += extra.length;
    console.log(`${missed.length || extra.length ? "FAIL" : "PASS"} ${id}${missed.length ? ` missed=[${missed}]` : ""}${extra.length ? ` extra=[${extra}]` : ""}`);
  }
  if (useModel) console.log(`\nClassification ${classified}/${pages}`);
  console.log(`Issues: ${tp}/${tp + fn} caught, ${fp} false alarm(s)`);
  if (fn || fp) process.exitCode = 1;
}
main();
