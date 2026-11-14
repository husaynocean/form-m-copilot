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
import { confirmMismatches } from "../lib/confirm";
import { validateExport } from "../lib/nxp";
import type { DocumentSet, Extraction } from "../lib/schema";

const CASES = join(__dirname, "..", "samples", "export_cases");
const useModel = process.argv.includes("--model");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILES = ["commercial_invoice", "packing_list", "bill_of_lading", "nepc_certificate", "cci", "certificate_of_origin"];

async function main() {
  let tp = 0, fp = 0, fn = 0, classified = 0, pages = 0;
  for (const id of readdirSync(CASES).sort()) {
    if (only.length && !only.includes(id)) continue;
    const key = JSON.parse(readFileSync(join(CASES, id, "answer_key.json"), "utf8"));
    let docs: DocumentSet = key.truth;
    const images: Record<string, string> = {};
    if (useModel) {
      docs = {};
      await Promise.all(
        FILES.map(async (f) => {
          pages++;
          const b64 = readFileSync(join(CASES, id, "photos", `${f}.jpg`)).toString("base64");
          try {
            const e: Extraction = (await extractDocument(`data:image/jpeg;base64,${b64}`)).extraction;
            (docs as Record<string, Extraction>)[e.doc_type] = e;
            images[e.doc_type] = `data:image/jpeg;base64,${b64}`;
            const want = ({ commercial_invoice: "proforma_invoice", cci: "clean_certificate_of_inspection" } as Record<string, string>)[f] ?? f;
            if (e.doc_type === want) classified++;
          } catch (err) {
            console.log(`   ${id}/${f}: FAILED ${String((err as Error).message).slice(0, 160)}`);
          }
        }),
      );
    }
    if (useModel) {
      // Same double-check of disputed numbers as the live app.
      const c = await confirmMismatches(docs, images, validateExport(docs, key.category, new Date(key.today)));
      if (c.corrected.length) console.log(`   ${id}: re-read corrected ${c.corrected.join("; ")}`);
    }
    const found = new Set([...validateExport(docs, key.category, new Date(key.today)), ...checkPrintedHsCodes(docs)].filter((i) => i.severity !== "info").map((i) => i.code));
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
