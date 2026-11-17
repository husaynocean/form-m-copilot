/**
 * End-to-end week-1 run on one document photo: extract -> benchmark lookup.
 *   PC_STORE=memory npx tsx scripts/pc-check.ts samples/pricecheck/photos/form_m_01.jpg
 */
import { readFileSync } from "node:fs";
import { extractPriceDoc } from "../lib/pricecheck/extract";
import { lookupLines } from "../lib/pricecheck/lookup";

(async () => {
  const path = process.argv[2];
  const { doc } = await extractPriceDoc(`data:image/jpeg;base64,${readFileSync(path).toString("base64")}`);
  console.log(`${doc.doc_kind}: ${doc.supplier} -> ${doc.buyer} · ${doc.currency} ${doc.total} · ${doc.incoterm} · origin ${doc.country_of_origin}`);
  const r = await lookupLines(doc);
  for (const l of r.lines) {
    const b = l.benchmark;
    console.log(
      `#${l.line_no} ${l.hs6 ?? "no HS"} ${l.line.description?.slice(0, 40)}\n` +
        `   invoice ${l.unit_value?.toFixed(2) ?? "–"} per ${l.basis ?? "?"} · benchmark ${b ? `${b.low} – ${b.median} – ${b.high} per ${b.basis} (${b.points} pts)` : "none"}` +
        `${l.ratio != null ? ` · ratio ${l.ratio}×` : ""}${l.note ? `\n   note: ${l.note}` : ""}`,
    );
  }
  if (r.errors.length) console.log("errors:", r.errors);
})();
