/**
 * PriceCheck demo evaluation on the 30 synthetic invoices.
 *
 *   npx tsx scripts/pc-eval-demo.ts            scoring only, on the printed values
 *   npx tsx scripts/pc-eval-demo.ts --model    read each photo with the model first
 *   PC_REMOTE=<deployment url> PC_REMOTE_COOKIE=<cookie> npx tsx scripts/pc-eval-demo.ts --model
 *        same, but the photo is read by a deployment's /api/pricecheck (which
 *        holds the model key); only the values it read are used, scoring is local.
 *
 * Reports: mispricing caught (invoice flagged medium/high with the right
 * PRICE_ flag on the planted line), false alarms on fairly priced invoices,
 * other red flags found, and extraction accuracy for the price fields.
 */
process.env.PC_STORE = "memory";
process.env.PC_FX = "fallback"; // same rates the set was generated with
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractPriceDoc, type PriceDoc } from "../lib/pricecheck/extract";
import { runPriceCheck } from "../lib/pricecheck/run";

const DIR = join(__dirname, "..", "samples", "pricecheck", "demo");
const useModel = process.argv.includes("--model");
const REMOTE = process.env.PC_REMOTE;
const EVAL_OWNER = "pcDemoEvalOwner0123456789abcdef"; // throwaway key so the test rows are easy to delete

async function readPhoto(file: string): Promise<PriceDoc> {
  if (!REMOTE) return (await extractPriceDoc(`data:image/jpeg;base64,${readFileSync(file).toString("base64")}`)).doc;
  const form = new FormData();
  form.append("files", new Blob([readFileSync(file)], { type: "image/jpeg" }), "invoice.jpg");
  form.append("owner", EVAL_OWNER);
  const res = await fetch(`${REMOTE}/api/pricecheck`, { method: "POST", body: form, headers: { cookie: process.env.PC_REMOTE_COOKIE ?? "" } });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? res.status);
  return j.doc;
}
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

interface Case { id: string; plant: string | null; expect_flag: boolean; expect_codes: string[]; planted_line: number | null; doc: PriceDoc; markup?: number; band_edge_factor?: number }
const plan: Case[] = JSON.parse(readFileSync(join(DIR, "plan.json"), "utf8"));

const eq = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.01 : String(a ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") === String(b ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""));

(async () => {
  const rows: Record<string, unknown>[] = [];
  let fields = 0, fieldsOk = 0;
  for (const c of plan.filter((x) => !only.length || only.includes(x.id))) {
    let doc = c.doc;
    if (useModel) {
      doc = await readPhoto(join(DIR, "photos", `${c.id}.jpg`));
      const check: [unknown, unknown][] = [[c.doc.currency, doc.currency], [c.doc.incoterm, doc.incoterm], [c.doc.country_of_origin, doc.country_of_origin], [c.doc.lines.length, doc.lines.length]];
      c.doc.lines.forEach((l, i) => check.push([l.hs_code, doc.lines[i]?.hs_code], [l.quantity, doc.lines[i]?.quantity], [l.unit, doc.lines[i]?.unit], [l.unit_price, doc.lines[i]?.unit_price], [l.line_total, doc.lines[i]?.line_total]));
      fields += check.length;
      fieldsOk += check.filter(([a, b]) => eq(a, b)).length;
      const bad = check.filter(([a, b]) => !eq(a, b));
      if (bad.length) console.log(`   ${c.id} read differently: ${bad.map(([a, b]) => `${a} -> ${b}`).join("; ")}`);
    }
    const { result } = await runPriceCheck(doc);
    const scored = result.flags.filter((f) => f.points > 0);
    const flagged = result.level !== "low";
    const priceFlag = scored.find((f) => /^PRICE_(ABOVE|BELOW)_RANGE$/.test(f.code));
    const onLine = scored.some((f) => f.code === c.expect_codes[0] && f.line === c.planted_line);
    const caught = c.expect_flag ? flagged && onLine : null;
    const falseAlarm = !c.expect_flag ? flagged || Boolean(priceFlag) : null;
    const otherFound = c.plant && !c.expect_flag ? c.expect_codes.every((code) => scored.some((f) => f.code === code)) : null;
    // FLAGGED LOW: the right price flag on the right line, but the total stayed under 30.
    const status = c.expect_flag ? (caught ? "CAUGHT" : onLine ? "FLAGGED LOW" : "MISSED") : falseAlarm ? "FALSE ALARM" : c.plant ? (otherFound ? "FOUND" : "MISSED FLAG") : "OK";
    const why = c.markup ? ` (${c.markup}x markup, ${c.band_edge_factor === 1 ? "inside range" : `${c.band_edge_factor}x past edge`})` : "";
    console.log(`${c.id} ${(c.plant ?? "fair").padEnd(12)} ${String(result.score).padStart(3)}/100 ${result.level.padEnd(6)} ${status.padEnd(11)} ${scored.map((f) => f.code).join(",") || "-"}${why}`);
    rows.push({ id: c.id, plant: c.plant, score: result.score, level: result.level, status, markup: c.markup, band_edge_factor: c.band_edge_factor, flags: scored.map((f) => `${f.code}${f.line ? `@${f.line}` : ""}`) });
  }
  const mis = rows.filter((r) => r.plant === "over" || r.plant === "under");
  const subtle = rows.filter((r) => String(r.plant).startsWith("subtle"));
  const MIS = ["over", "under", "subtle_over", "subtle_under"];
  const fair = rows.filter((r) => !r.plant || !MIS.includes(r.plant as string));
  const other = rows.filter((r) => r.plant && !MIS.includes(r.plant as string));
  const n = (rs: typeof rows, st: string) => rs.filter((r) => r.status === st).length;
  const summary = {
    mode: useModel ? "read from photos" : "printed values",
    mispricing_caught: `${n(mis, "CAUGHT")}/${mis.length}`,
    subtle_caught_medium_or_high: `${n(subtle, "CAUGHT")}/${subtle.length}`,
    subtle_flagged_low_only: `${n(subtle, "FLAGGED LOW")}/${subtle.length}`,
    subtle_missed: `${n(subtle, "MISSED")}/${subtle.length}`,
    false_alarms: `${fair.filter((r) => r.status === "FALSE ALARM").length}/${fair.length}`,
    other_red_flags_found: `${other.filter((r) => r.status === "FOUND").length}/${other.length}`,
    ...(useModel ? { fields_read_correctly: `${fieldsOk}/${fields}` } : {}),
  };
  console.log("\n" + JSON.stringify(summary, null, 1));
  if (!only.length) writeFileSync(join(DIR, `results-${useModel ? "model" : "printed"}.json`), JSON.stringify({ summary, rows }, null, 1));
})();
