/**
 * End-to-end evaluation on the synthetic photos: real model extraction ->
 * validation, scored against each case's answer key.
 *
 *   LLM_PROVIDER=meta META_API_KEY=... npm run eval:extract
 *   LLM_PROVIDER=baseten BASETEN_API_KEY=... npm run eval:extract -- case_01 case_12
 *
 * Reports field accuracy per document type and issue precision/recall.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { extractDocument } from "../lib/extract";
import { validate } from "../lib/validate";
import type { DocumentSet, Extraction } from "../lib/schema";
import { caseToDocs } from "./case-to-docs";

const ROOT = join(__dirname, "..");
const CASES = join(ROOT, "samples", "cases");
const TODAY = new Date("2026-11-01");
const DOCS = ["proforma_invoice", "packing_list", "insurance_certificate"] as const;

const norm = (v: unknown) =>
  typeof v === "number" ? Math.round(v * 100) / 100 : typeof v === "string" ? v.toLowerCase().replace(/^rc\s*/, "").replace(/[^a-z0-9.]/g, "") : v;

/** Compare flat scalar fields + line fields; returns [matched, total, mismatches]. */
function score(truth: Record<string, unknown>, got: Record<string, unknown>, prefix = ""): [number, number, string[]] {
  let ok = 0, n = 0;
  const bad: string[] = [];
  for (const [k, v] of Object.entries(truth)) {
    if (k === "doc_type" || k === "interest" || k.endsWith("address")) continue;
    const g = got?.[k];
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const [a, b, c] = score(item as Record<string, unknown>, ((g as unknown[]) ?? [])[i] as Record<string, unknown>, `${prefix}${k}[${i}].`);
        ok += a; n += b; bad.push(...c);
      });
    } else if (v && typeof v === "object") {
      const [a, b, c] = score(v as Record<string, unknown>, g as Record<string, unknown>, `${prefix}${k}.`);
      ok += a; n += b; bad.push(...c);
    } else {
      n++;
      if (norm(v) === norm(g)) ok++;
      else bad.push(`${prefix}${k}: expected ${JSON.stringify(v)} got ${JSON.stringify(g)}`);
    }
  }
  return [ok, n, bad];
}

async function main() {
  const only = process.argv.slice(2);
  const ids = readdirSync(CASES).sort().filter((id) => !only.length || only.includes(id));
  const fieldTotals: Record<string, [number, number]> = {};
  let tp = 0, fp = 0, fn = 0, classifyOk = 0, classifyN = 0;
  const report: unknown[] = [];

  for (const id of ids) {
    const key = JSON.parse(readFileSync(join(CASES, id, "answer_key.json"), "utf8"));
    const truth = caseToDocs(key);
    const got: DocumentSet = {};
    const mismatches: string[] = [];
    for (const d of DOCS) {
      const img = readFileSync(join(CASES, id, "photos", `${d}.jpg`)).toString("base64");
      try {
        const r = await extractDocument(`data:image/jpeg;base64,${img}`);
        classifyN++;
        if (r.extraction.doc_type === d) classifyOk++;
        (got as Record<string, Extraction>)[r.extraction.doc_type] = r.extraction;
        const [a, b, bad] = score(truth[d] as unknown as Record<string, unknown>, r.extraction as unknown as Record<string, unknown>);
        fieldTotals[d] = [(fieldTotals[d]?.[0] ?? 0) + a, (fieldTotals[d]?.[1] ?? 0) + b];
        mismatches.push(...bad.map((x) => `${d}.${x}`));
      } catch (e) {
        classifyN++;
        mismatches.push(`${d}: FAILED ${(e as Error).message}`);
      }
    }
    const expected = new Set<string>(key.expected_issues);
    const found = new Set(validate(got, TODAY).map((i) => i.code).filter((c) => c !== "MISSING_DOCUMENT"));
    const missed = [...expected].filter((c) => !found.has(c));
    const extra = [...found].filter((c) => !expected.has(c));
    tp += [...expected].filter((c) => found.has(c)).length; fn += missed.length; fp += extra.length;
    console.log(`${missed.length + extra.length ? "FAIL" : "PASS"} ${id}` +
      (missed.length ? ` missed=[${missed}]` : "") + (extra.length ? ` extra=[${extra}]` : "") +
      (mismatches.length ? `\n   field errors: ${mismatches.slice(0, 6).join(" | ")}${mismatches.length > 6 ? " …" : ""}` : ""));
    report.push({ id, expected: [...expected], found: [...found], mismatches });
  }

  console.log("\nField accuracy:");
  for (const [d, [a, b]] of Object.entries(fieldTotals)) console.log(`  ${d.padEnd(22)} ${((a / b) * 100).toFixed(1)}% (${a}/${b})`);
  console.log(`Classification ${classifyOk}/${classifyN}`);
  console.log(`Issues: precision ${((tp / Math.max(1, tp + fp)) * 100).toFixed(1)}%  recall ${((tp / Math.max(1, tp + fn)) * 100).toFixed(1)}%`);
  mkdirSync(join(ROOT, "eval-results"), { recursive: true });
  const out = join(ROOT, "eval-results", `extract-${process.env.LLM_PROVIDER ?? "meta"}-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Saved ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
