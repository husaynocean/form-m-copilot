/**
 * PriceCheck PDF report (A4), built on the server from a saved check.
 * pdf-lib with the standard Helvetica fonts: pure JavaScript, no font files.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { PriceDoc } from "./extract";
import type { Flag, LineResult, PriceCheckResult } from "./score";

const A4 = { w: 595.28, h: 841.89 };
const M = 46; // page margin
const INK = rgb(0.07, 0.11, 0.09);
const MUTED = rgb(0.38, 0.45, 0.42);
const LINE = rgb(0.85, 0.89, 0.87);
const EM = rgb(0.06, 0.6, 0.42);
const GOLD = rgb(0.76, 0.52, 0.04);
const RED = rgb(0.78, 0.16, 0.2);
const LEVEL: Record<PriceCheckResult["level"], RGB> = { low: EM, medium: GOLD, high: RED };
const SEV: Record<Flag["severity"], { label: string; color: RGB }> = {
  high: { label: "HIGH", color: RED },
  medium: { label: "MEDIUM", color: GOLD },
  low: { label: "LOW", color: GOLD },
  info: { label: "NOTE", color: MUTED },
};

/** Standard PDF fonts only cover Latin-1-ish text: map the rest. */
function clean(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[→⟶]/g, "->").replace(/[≈∼]/g, "~").replace(/≤/g, "<=").replace(/≥/g, ">=")
    .replace(/₦/g, "NGN ").replace(/[‑‒−]/g, "-").replace(/ | /g, " ")
    .replace(/[^\x20-\x7E -ÿ–—‘’“”•…€×]/g, "?");
}

const money = (n: number | null | undefined) => {
  if (n == null) return "-";
  const d = n >= 100 ? 0 : n >= 1 ? 2 : 3;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};

class Writer {
  page: PDFPage;
  y: number;
  constructor(private pdf: PDFDocument, private font: PDFFont, private bold: PDFFont, private footer: string) {
    this.page = this.newPage();
    this.y = A4.h - M;
  }
  private newPage(): PDFPage {
    const p = this.pdf.addPage([A4.w, A4.h]);
    p.drawText(clean(this.footer), { x: M, y: 24, size: 7.5, font: this.font, color: MUTED });
    return p;
  }
  /** Start a new page if fewer than `need` points are left. */
  room(need: number) {
    if (this.y - need < 48) {
      this.page = this.newPage();
      this.y = A4.h - M;
    }
  }
  wrap(text: string, size: number, width: number, font = this.font): string[] {
    const out: string[] = [];
    for (const para of clean(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
        else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  }
  text(text: string, opts: { size?: number; bold?: boolean; color?: RGB; x?: number; width?: number; gap?: number } = {}) {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : this.font;
    const x = opts.x ?? M;
    const lines = this.wrap(text, size, opts.width ?? A4.w - M - x, font);
    for (const l of lines) {
      this.room(size + 3);
      this.y -= size + 3;
      this.page.drawText(l, { x, y: this.y, size, font, color: opts.color ?? INK });
    }
    this.y -= opts.gap ?? 0;
  }
  rule(gap = 8) {
    this.room(gap * 2);
    this.y -= gap;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4.w - M, y: this.y }, thickness: 0.6, color: LINE });
    this.y -= gap;
  }
  heading(t: string) {
    this.room(40);
    this.y -= 6;
    this.text(t.toUpperCase(), { size: 8.5, bold: true, color: EM, gap: 4 });
  }
}

export async function buildReport(input: {
  id: string;
  created_at: string;
  doc: PriceDoc;
  result: PriceCheckResult;
  appUrl: string;
}): Promise<Uint8Array> {
  const { doc, result: r } = input;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`PriceCheck report ${input.id.slice(0, 8)}`);
  pdf.setAuthor("Trade Copilot");
  pdf.setSubject("Invoice price screening against UN Comtrade benchmarks");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const when = new Date(input.created_at);
  const stamp = `${when.toISOString().slice(0, 10)} ${when.toISOString().slice(11, 16)} UTC`;
  const w = new Writer(pdf, font, bold, `Trade Copilot · PriceCheck report ${input.id} · ${stamp} · A screening aid for review, not a finding of wrongdoing.`);

  // --- header ------------------------------------------------------------------
  w.page.drawRectangle({ x: M, y: w.y - 22, width: 22, height: 22, color: EM });
  w.page.drawText("T", { x: M + 6.5, y: w.y - 16.5, size: 13, font: bold, color: rgb(1, 1, 1) });
  w.page.drawText("Trade Copilot", { x: M + 30, y: w.y - 10, size: 12, font: bold, color: INK });
  w.page.drawText("PriceCheck report", { x: M + 30, y: w.y - 21, size: 9, font, color: MUTED });
  const right = `Checked ${stamp}`;
  w.page.drawText(right, { x: A4.w - M - font.widthOfTextAtSize(right, 8.5), y: w.y - 10, size: 8.5, font, color: MUTED });
  const ref = `Ref ${input.id.slice(0, 8).toUpperCase()}`;
  w.page.drawText(ref, { x: A4.w - M - font.widthOfTextAtSize(ref, 8.5), y: w.y - 21, size: 8.5, font, color: MUTED });
  w.y -= 34;
  w.rule(6);

  // --- score -------------------------------------------------------------------
  const boxTop = w.y;
  const c = LEVEL[r.level];
  w.page.drawRectangle({ x: M, y: boxTop - 74, width: 92, height: 74, borderColor: c, borderWidth: 1.5, color: rgb(1, 1, 1) });
  const sc = String(r.score);
  w.page.drawText(sc, { x: M + 46 - bold.widthOfTextAtSize(sc, 30) / 2, y: boxTop - 40, size: 30, font: bold, color: c });
  w.page.drawText("out of 100", { x: M + 46 - font.widthOfTextAtSize("out of 100", 7.5) / 2, y: boxTop - 52, size: 7.5, font, color: MUTED });
  const lv = `${r.level.toUpperCase()} RISK`;
  w.page.drawText(lv, { x: M + 46 - bold.widthOfTextAtSize(lv, 8) / 2, y: boxTop - 66, size: 8, font: bold, color: c });
  w.y = boxTop + 4;
  w.text(r.summary, { x: M + 108, size: 10.5, bold: true, gap: 4 });
  w.text(
    `Benchmarks: UN Comtrade prices for goods from ${r.origin} to Nigeria, 2020–2024, in FOB US dollars.`,
    { x: M + 108, size: 9, color: MUTED },
  );
  w.y = Math.min(w.y, boxTop - 74) - 6;

  // --- document ----------------------------------------------------------------
  w.heading("Document");
  const kind = { proforma_invoice: "Proforma invoice", commercial_invoice: "Commercial invoice", form_m: "Form M", other: "Document" }[doc.doc_kind];
  const rows: [string, string][] = [
    ["Type", `${kind}${doc.form_m_number ? ` · Form M ${doc.form_m_number}` : ""}`],
    ["Supplier", `${doc.supplier ?? "-"}${doc.supplier_country ? ` (${doc.supplier_country})` : ""}`],
    ["Buyer", doc.buyer ?? "-"],
    ["Invoice", `${doc.invoice_number ?? "-"}${doc.invoice_date ? ` · ${doc.invoice_date}` : ""}`],
    ["Terms", `${doc.currency ?? "?"} · ${doc.incoterm ?? "no Incoterm"} · origin ${doc.country_of_origin ?? "not stated"}`],
    ["Total", doc.total != null ? `${doc.currency ?? ""} ${doc.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "-"],
  ];
  for (const [k, v] of rows) {
    w.room(14);
    const y0 = w.y;
    w.text(k, { size: 9, color: MUTED });
    const after = w.y;
    w.y = y0;
    w.text(v, { size: 9, x: M + 80 });
    w.y = Math.min(w.y, after);
  }

  // --- reasons -----------------------------------------------------------------
  const flags = [...r.flags].sort((a, b) => b.points - a.points);
  w.heading(flags.length ? "Why this score" : "Findings");
  if (!flags.length) w.text("Nothing unusual was found. Every compared price is within its normal range.", { size: 9.5 });
  for (const f of flags) {
    w.room(46);
    w.y -= 2;
    const sev = SEV[f.severity];
    const tag = `${sev.label}${f.points ? ` +${f.points}` : ""}`;
    w.page.drawText(tag, { x: M, y: w.y - 10, size: 7.5, font: bold, color: sev.color });
    w.text(f.title, { x: M + 62, size: 10, bold: true, gap: 2 });
    w.text(f.detail, { x: M + 62, size: 9, gap: 2 });
    w.text(`What to do: ${f.advice}`, { x: M + 62, size: 9, color: MUTED, gap: 8 });
  }

  // --- lines ---------------------------------------------------------------------
  w.heading("Line by line (FOB US dollars)");
  if (r.fx && r.fx.currency !== "USD") {
    w.text(`Converted from ${r.fx.currency} at ${r.fx.per_usd} per US dollar (${r.fx.source === "live" ? `rate of ${r.fx.as_of}` : "approximate rate"}).`, { size: 8.5, color: MUTED });
  }
  if (r.incoterm_note) w.text(r.incoterm_note, { size: 8.5, color: MUTED, gap: 2 });
  const cols = [M, M + 18, M + 222, M + 290, M + 360, M + 436, A4.w - M];
  const head = ["#", "Goods", "HS code", "Invoice", "Normal range", "Typical"];
  w.room(30);
  w.y -= 14;
  head.forEach((h, i) => w.page.drawText(h, { x: cols[i], y: w.y, size: 7.5, font: bold, color: MUTED }));
  w.page.drawText("vs typical", { x: cols[6] - bold.widthOfTextAtSize("vs typical", 7.5), y: w.y, size: 7.5, font: bold, color: MUTED });
  w.y -= 5;
  w.page.drawLine({ start: { x: M, y: w.y }, end: { x: A4.w - M, y: w.y }, thickness: 0.6, color: LINE });
  // Red in the price columns means the price itself is outside the normal range.
  const flagged = new Set(r.flags.filter((f) => f.points > 0 && /^PRICE_(ABOVE|BELOW)_RANGE$/.test(f.code)).map((f) => f.line));
  for (const l of r.lines) lineRow(w, l, cols, font, bold, flagged.has(l.line_no));

  // --- method ------------------------------------------------------------------
  w.heading("How this was checked");
  w.text(
    "Each line's unit price is compared with UN Comtrade annual trade statistics for the same 6-digit HS code from the same origin country to Nigeria, over 2020–2024: Nigeria's declared imports and the origin's declared exports to Nigeria (mirror data), or the origin's exports to the world when those are thin. " +
      "Import values (CIF) are reduced by 10% to FOB; estimated quantities and weights are excluded; the normal range is the trade-value-weighted 10th–90th percentile. " +
      "Prices just outside the range (within 15%) are treated as normal. A 6-digit HS code can cover very different specifications, so a price outside the range is a reason to ask questions, not proof of mispricing.",
    { size: 8.5, color: MUTED, gap: 4 },
  );
  w.text(`Synthetic or public documents only. Report generated by Trade Copilot (${input.appUrl}).`, { size: 8, color: MUTED });

  return pdf.save();
}

function lineRow(w: Writer, l: LineResult, cols: number[], font: PDFFont, bold: PDFFont, flagged: boolean) {
  const unit = l.basis === "kg" ? "/kg" : l.basis === "item" ? "/item" : "";
  const goods = w.wrap(l.description ?? "-", 8.5, cols[2] - cols[1] - 8);
  const note = l.price_usd == null || !l.band ? w.wrap(l.note ?? "Not compared.", 7.5, cols[6] - cols[2]) : [];
  const compared = l.price_usd != null && l.band;
  const h = Math.max(Math.max(goods.length, 1) * 11, compared ? 21 : 0) + note.length * 10 + 8;
  w.room(h + 4);
  const top = w.y - 12;
  w.page.drawText(String(l.line_no), { x: cols[0], y: top, size: 8.5, font, color: INK });
  goods.forEach((g, i) => w.page.drawText(g, { x: cols[1], y: top - i * 11, size: 8.5, font, color: INK }));
  w.page.drawText(l.hs6 ? `${l.hs6.slice(0, 4)}.${l.hs6.slice(4)}` : "none", { x: cols[2], y: top, size: 8.5, font, color: INK });
  if (l.price_usd != null && l.band) {
    const off = flagged; // just outside the range but within tolerance is not flagged
    w.page.drawText(`${money(l.price_usd)}${unit}`, { x: cols[3], y: top, size: 8.5, font: off ? bold : font, color: off ? RED : INK });
    w.page.drawText(`${money(l.band.low)}–${money(l.band.high)}`, { x: cols[4], y: top, size: 8.5, font, color: INK });
    w.page.drawText(money(l.band.median), { x: cols[5], y: top, size: 8.5, font, color: INK });
    const ratio = `${l.ratio}×`;
    w.page.drawText(ratio, { x: cols[6] - bold.widthOfTextAtSize(ratio, 8.5), y: top, size: 8.5, font: bold, color: off ? RED : EM });
    w.page.drawText(`${l.band.points} yrs · ${l.band.confidence}`, { x: cols[4], y: top - 10, size: 7, font, color: MUTED });
  } else {
    note.forEach((n, i) => w.page.drawText(n, { x: cols[2], y: top - 11 - i * 10, size: 7.5, font, color: MUTED }));
  }
  w.y -= h;
  w.page.drawLine({ start: { x: M, y: w.y }, end: { x: A4.w - M, y: w.y }, thickness: 0.4, color: LINE });
}
