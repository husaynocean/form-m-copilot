import type { DocumentSet, Issue, PackingLine, InvoiceLine } from "./schema";

/**
 * Step 2 of the agent: deterministic cross-document checks.
 * No model is involved here. Arithmetic, name matching and date logic are
 * done in code so every flag is reproducible and explainable.
 */

const MONEY_TOLERANCE = 1; // currency units; allows for rounding on printed docs

export function normalizeName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[.,'"()&-]/g, " ")
    .replace(/\b(limited)\b/g, "ltd")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePort(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\b(port|lagos|rivers|nigeria)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const VAGUE_TERMS = [
  "general goods", "general merchandise", "assorted", "various", "sundry", "sundries",
  "spare parts", "accessories", "goods", "items", "materials", "machine parts", "merchandise",
];

export function isVagueDescription(desc: string | null | undefined): boolean {
  const d = (desc ?? "").toLowerCase().trim();
  if (!d) return true;
  const words = d.split(/\s+/).filter(Boolean);
  // Specific descriptions carry detail: numbers, specs, materials, commas.
  const hasSpecifics = /\d|,|\(|%/.test(d) || words.length >= 4;
  return !hasSpecifics && VAGUE_TERMS.some((t) => d.includes(t));
}

function similarity(a: string, b: string): number {
  const ta = new Set(normalizeName(a).split(" "));
  const tb = new Set(normalizeName(b).split(" "));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / Math.max(1, Math.max(ta.size, tb.size));
}

/** Pair packing-list lines with invoice lines by description, falling back to order. */
function pairLines(inv: InvoiceLine[], pl: PackingLine[]): [InvoiceLine, PackingLine][] {
  const used = new Set<number>();
  return inv.flatMap((line, i) => {
    let best = -1;
    let bestScore = 0.5;
    pl.forEach((p, j) => {
      if (used.has(j)) return;
      const s = similarity(line.description ?? "", p.description ?? "");
      if (s > bestScore) [best, bestScore] = [j, s];
    });
    if (best < 0 && i < pl.length && !used.has(i)) best = i;
    if (best < 0) return [];
    used.add(best);
    return [[line, pl[best]] as [InvoiceLine, PackingLine]];
  });
}

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function validate(docs: DocumentSet, today: Date = new Date()): Issue[] {
  const issues: Issue[] = [];
  const pi = docs.proforma_invoice;
  const pl = docs.packing_list;
  const ins = docs.insurance_certificate;

  if (pi) {
    // --- arithmetic -------------------------------------------------------
    const sumLines = pi.lines.reduce((s, l) => s + (l.line_total ?? 0), 0);
    const expected = sumLines + (pi.freight ?? 0) + (pi.insurance ?? 0);
    if (pi.total != null && Math.abs(expected - pi.total) > MONEY_TOLERANCE) {
      issues.push({
        code: "INVOICE_TOTAL_MISMATCH",
        severity: "error",
        title: "Invoice total doesn't add up",
        detail: `Line items${pi.freight ? " + freight" : ""}${pi.insurance ? " + insurance" : ""} = ${pi.currency ?? ""} ${fmt(expected)}, but the invoice says ${fmt(pi.total)} (difference ${fmt(pi.total - expected)}).`,
        evidence: [
          { doc: "proforma_invoice", field: "total", value: pi.total },
          { doc: "proforma_invoice", field: "computed_total", value: Number(expected.toFixed(2)) },
        ],
        fix: "Ask the supplier to reissue the proforma invoice with a corrected total.",
      });
    }
    pi.lines.forEach((l, i) => {
      if (l.quantity != null && l.unit_price != null && l.line_total != null) {
        const calc = l.quantity * l.unit_price;
        if (Math.abs(calc - l.line_total) > MONEY_TOLERANCE) {
          issues.push({
            code: "LINE_TOTAL_MISMATCH",
            severity: "error",
            title: `Line ${i + 1}: quantity × price ≠ amount`,
            detail: `${l.quantity} × ${fmt(l.unit_price)} = ${fmt(calc)}, but the line shows ${fmt(l.line_total)}.`,
            evidence: [{ doc: "proforma_invoice", field: `lines[${i}].line_total`, value: l.line_total }],
            fix: "Ask the supplier to correct the line amount.",
          });
        }
      }
    });

    // --- required fields ----------------------------------------------------
    if (!pi.incoterm) {
      issues.push({
        code: "MISSING_INCOTERM",
        severity: "error",
        title: "No Incoterm on the proforma invoice",
        detail: "Form M needs the terms of delivery (e.g. FOB, CFR, CIF) to state the value correctly.",
        evidence: [{ doc: "proforma_invoice", field: "incoterm", value: null }],
        fix: "Ask the supplier to state the Incoterm and named place, e.g. 'CFR Apapa, Lagos'.",
      });
    }
    if (!pi.country_of_origin) {
      issues.push({
        code: "MISSING_COUNTRY_OF_ORIGIN",
        severity: "error",
        title: "Country of origin is missing",
        detail: "Form M requires the country where the goods were produced.",
        evidence: [{ doc: "proforma_invoice", field: "country_of_origin", value: null }],
        fix: "Ask the supplier to add the country of origin to the proforma invoice.",
      });
    }
    pi.lines.forEach((l, i) => {
      if (isVagueDescription(l.description)) {
        issues.push({
          code: "VAGUE_DESCRIPTION",
          severity: "error",
          title: `Line ${i + 1}: description too vague`,
          detail: `"${l.description ?? ""}" cannot be classified to an HS code. Customs and the bank need make, model, material or specification.`,
          evidence: [{ doc: "proforma_invoice", field: `lines[${i}].description`, value: l.description }],
          fix: "Ask the supplier for a full commercial description (what it is, material, size/capacity, use).",
        });
      }
    });

    // --- dates ------------------------------------------------------------
    if (pi.valid_until) {
      const until = new Date(pi.valid_until);
      if (!Number.isNaN(until.getTime()) && until < startOfDay(today)) {
        issues.push({
          code: "PROFORMA_EXPIRED",
          severity: "error",
          title: "Proforma invoice has expired",
          detail: `Valid until ${pi.valid_until}; today is ${today.toISOString().slice(0, 10)}.`,
          evidence: [{ doc: "proforma_invoice", field: "valid_until", value: pi.valid_until }],
          fix: "Request a fresh, dated proforma invoice from the supplier.",
        });
      }
    }
  }

  // --- cross-document: names ----------------------------------------------
  if (pi && pl && pi.seller.name && pl.seller.name && normalizeName(pi.seller.name) !== normalizeName(pl.seller.name)) {
    issues.push({
      code: "BENEFICIARY_NAME_MISMATCH",
      severity: "error",
      title: "Supplier name differs between documents",
      detail: `Proforma: "${pi.seller.name}" · Packing list: "${pl.seller.name}". The beneficiary must be identical on every document.`,
      evidence: [
        { doc: "proforma_invoice", field: "seller.name", value: pi.seller.name },
        { doc: "packing_list", field: "seller.name", value: pl.seller.name },
      ],
      fix: "Ask the supplier which legal name is correct and reissue the other document.",
    });
  }
  const importerNames: { doc: "proforma_invoice" | "packing_list" | "insurance_certificate"; field: string; value: string }[] = [];
  if (pi?.buyer.name) importerNames.push({ doc: "proforma_invoice", field: "buyer.name", value: pi.buyer.name });
  if (pl?.buyer.name) importerNames.push({ doc: "packing_list", field: "buyer.name", value: pl.buyer.name });
  if (ins?.insured) importerNames.push({ doc: "insurance_certificate", field: "insured", value: ins.insured });
  if (new Set(importerNames.map((n) => normalizeName(n.value))).size > 1) {
    issues.push({
      code: "IMPORTER_NAME_MISMATCH",
      severity: "error",
      title: "Importer name differs between documents",
      detail: importerNames.map((n) => `${label(n.doc)}: "${n.value}"`).join(" · "),
      evidence: importerNames,
      fix: "All documents must carry the importer's registered name exactly as on the CAC certificate.",
    });
  }

  // --- cross-document: quantities ---------------------------------------
  if (pi && pl) {
    for (const [inv, pack] of pairLines(pi.lines, pl.lines)) {
      if (inv.quantity != null && pack.quantity != null && inv.quantity !== pack.quantity) {
        issues.push({
          code: "PACKING_QTY_MISMATCH",
          severity: "error",
          title: "Quantity differs between invoice and packing list",
          detail: `"${pack.description ?? inv.description}": invoice ${inv.quantity} ${inv.unit ?? ""}, packing list ${pack.quantity} ${pack.unit ?? ""}.`,
          evidence: [
            { doc: "proforma_invoice", field: "lines.quantity", value: inv.quantity },
            { doc: "packing_list", field: "lines.quantity", value: pack.quantity },
          ],
          fix: "Confirm the shipped quantity with the supplier and align both documents.",
        });
      }
    }
  }

  // --- cross-document: ports --------------------------------------------
  const ports: { doc: "proforma_invoice" | "packing_list" | "insurance_certificate"; field: string; value: string }[] = [];
  if (pi?.port_of_discharge) ports.push({ doc: "proforma_invoice", field: "port_of_discharge", value: pi.port_of_discharge });
  if (pl?.port_of_discharge) ports.push({ doc: "packing_list", field: "port_of_discharge", value: pl.port_of_discharge });
  if (ins?.voyage_to) ports.push({ doc: "insurance_certificate", field: "voyage_to", value: ins.voyage_to });
  if (new Set(ports.map((p) => normalizePort(p.value))).size > 1) {
    issues.push({
      code: "PORT_MISMATCH",
      severity: "error",
      title: "Port of discharge differs between documents",
      detail: ports.map((p) => `${label(p.doc)}: ${p.value}`).join(" · "),
      evidence: ports,
      fix: "Confirm the Nigerian port of discharge and correct the documents that differ.",
    });
  }

  // --- insurance ----------------------------------------------------------
  if (pi && ins) {
    if (pi.currency && ins.currency && pi.currency.toUpperCase() !== ins.currency.toUpperCase()) {
      issues.push({
        code: "CURRENCY_MISMATCH",
        severity: "error",
        title: "Insurance currency differs from invoice currency",
        detail: `Invoice is in ${pi.currency}, insurance certificate is in ${ins.currency}.`,
        evidence: [
          { doc: "proforma_invoice", field: "currency", value: pi.currency },
          { doc: "insurance_certificate", field: "currency", value: ins.currency },
        ],
        fix: "Ask the insurer to reissue the certificate in the invoice currency.",
      });
    }
    // Use the recomputed value so an arithmetic error on the invoice isn't
    // double-reported as under-insurance.
    const computed = pi.lines.length
      ? pi.lines.reduce((s, l) => s + (l.line_total ?? 0), 0) + (pi.freight ?? 0) + (pi.insurance ?? 0)
      : null;
    const invoiceValue = computed ?? pi.total ?? pi.goods_value;
    if (ins.sum_insured != null && invoiceValue != null && ins.sum_insured < invoiceValue - MONEY_TOLERANCE) {
      issues.push({
        code: "INSURED_VALUE_TOO_LOW",
        severity: "error",
        title: "Goods are under-insured",
        detail: `Sum insured ${ins.currency ?? ""} ${fmt(ins.sum_insured)} is below the invoice value ${pi.currency ?? ""} ${fmt(invoiceValue)}.`,
        evidence: [
          { doc: "insurance_certificate", field: "sum_insured", value: ins.sum_insured },
          { doc: "proforma_invoice", field: "total", value: invoiceValue },
        ],
        fix: "Increase cover to at least the full invoice value (commonly 110% of CIF).",
      });
    }
  }

  // --- completeness -------------------------------------------------------
  for (const [key, name] of [
    ["proforma_invoice", "proforma invoice"],
    ["packing_list", "packing list"],
    ["insurance_certificate", "insurance certificate"],
  ] as const) {
    if (!docs[key]) {
      issues.push({
        code: "MISSING_DOCUMENT",
        severity: "warning",
        title: `No ${name} provided`,
        detail: `The ${name} is needed to complete the Form M application.`,
        evidence: [],
        fix: `Upload the ${name}.`,
      });
    }
  }

  return issues;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function label(doc: string) {
  return { proforma_invoice: "Proforma", packing_list: "Packing list", insurance_certificate: "Insurance" }[doc] ?? doc;
}
