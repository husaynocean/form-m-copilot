/**
 * Form Q and Form A evaluation on the synthetic packs.
 *
 *   npx tsx scripts/eval-forms.ts            rules only, on the answer keys
 *   npx tsx scripts/eval-forms.ts --model    real model extraction from the photos, then rules
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractDocument } from "../lib/extract";
import { validateFormQ } from "../lib/formq";
import { validateFormA } from "../lib/forma";
import type { DocumentSet, Extraction } from "../lib/schema";

const ROOT = join(__dirname, "..", "samples");
const useModel = process.argv.includes("--model");

async function load(folder: string, id: string, truth: DocumentSet): Promise<[DocumentSet, number, number]> {
  if (!useModel) return [truth, 0, 0];
  const docs: DocumentSet = {};
  let ok = 0, n = 0;
  const photos = readdirSync(join(ROOT, folder, id, "photos"));
  await Promise.all(photos.map(async (f) => {
    n++;
    const b64 = readFileSync(join(ROOT, folder, id, "photos", f)).toString("base64");
    try {
      const e: Extraction = (await extractDocument(`data:image/jpeg;base64,${b64}`)).extraction;
      (docs as Record<string, Extraction>)[e.doc_type] = e;
      if (e.doc_type === f.replace(".jpg", "")) ok++;
    } catch (err) {
      console.log(`   ${id}/${f}: FAILED ${String((err as Error).message).slice(0, 160)}`);
    }
  }));
  return [docs, ok, n];
}

async function main() {
  let tp = 0, fp = 0, fn = 0, ok = 0, pages = 0;
  for (const [folder, run] of [
    ["formq_cases", (d: DocumentSet, k: { today: string; used_this_quarter: number }) => validateFormQ(d, { usedThisQuarter: k.used_this_quarter }, new Date(k.today))],
    ["forma_cases", (d: DocumentSet, k: { today: string }) => validateFormA(d, new Date(k.today))],
  ] as const) {
    for (const id of readdirSync(join(ROOT, folder)).sort()) {
      const key = JSON.parse(readFileSync(join(ROOT, folder, id, "answer_key.json"), "utf8"));
      const [docs, o, n] = await load(folder, id, key.truth);
      ok += o; pages += n;
      const found = new Set((run as (d: DocumentSet, k: unknown) => { code: string; severity: string }[])(docs, key).filter((i) => i.severity !== "info").map((i) => i.code));
      const want = new Set<string>(key.expected_issues);
      const missed = [...want].filter((c) => !found.has(c));
      const extra = [...found].filter((c) => !want.has(c));
      tp += want.size - missed.length; fn += missed.length; fp += extra.length;
      console.log(`${missed.length || extra.length ? "FAIL" : "PASS"} ${id}${missed.length ? ` missed=[${missed}]` : ""}${extra.length ? ` extra=[${extra}]` : ""}`);
    }
  }
  if (useModel) console.log(`\nClassification ${ok}/${pages}`);
  console.log(`Issues: ${tp}/${tp + fn} caught, ${fp} false alarm(s)`);
  if (fn || fp) process.exitCode = 1;
}
main();
