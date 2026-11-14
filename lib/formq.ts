import { validate, normalizeName } from "./validate";
import type { DraftField, FormMDraft } from "./formm";
import type { DocumentSet, Issue } from "./schema";

/**
 * Form Q: foreign exchange for small importers of physical goods, up to
 * USD 20,000 per quarter, paid by transfer without a letter of credit.
 * Bank requirements: the Form Q, the customer's instruction letter and an
 * invoice (or demand note). Shipping documents follow within 60 days.
 */
export const FORM_Q_LIMIT_USD = 20_000;

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SHARED = new Set(["INVOICE_TOTAL_MISMATCH", "LINE_TOTAL_MISMATCH", "VAGUE_DESCRIPTION", "PROFORMA_EXPIRED", "MISSING_COUNTRY_OF_ORIGIN"]);
// Words that mark a service rather than physical goods.
const SERVICE = /\b(services?|consult(ing|ancy)|subscription|licen[cs]e|software|saas|training|tuition|course fees?|maintenance fees?|installation fees?|support fees?|hosting|commission)\b/i;

export function invoiceTotal(docs: DocumentSet): number | null {
  const pi = docs.proforma_invoice;
  if (!pi) return null;
  const sum = pi.lines.reduce((s, l) => s + (l.line_total ?? 0), 0) + (pi.freight ?? 0) + (pi.insurance ?? 0);
  return pi.lines.length ? Math.round(sum * 100) / 100 : pi.total;
}

export function validateFormQ(docs: DocumentSet, opts: { usedThisQuarter?: number } = {}, today: Date = new Date()): Issue[] {
  const pi = docs.proforma_invoice;
  if (!pi) {
    return [{
      code: "MISSING_DOCUMENT", severity: "warning", title: "No invoice provided",
      detail: "Form Q needs the supplier's proforma invoice or demand note.", evidence: [], fix: "Upload the invoice.",
    }];
  }
  const issues = validate({ proforma_invoice: pi }, today).filter((i) => SHARED.has(i.code));
  const used = Math.max(0, opts.usedThisQuarter ?? 0);
  const amount = invoiceTotal(docs);
  const usd = (pi.currency ?? "").toUpperCase() === "USD";

  if (amount != null && usd && amount + used > FORM_Q_LIMIT_USD + 0.005) {
    const left = Math.max(0, FORM_Q_LIMIT_USD - used);
    issues.push({
      code: "FORM_Q_LIMIT_EXCEEDED",
      severity: "error",
      title: "Above the Form Q limit for this quarter",
      detail: `Form Q allows USD ${fmt(FORM_Q_LIMIT_USD)} per quarter. ${used ? `USD ${fmt(used)} is already used, so USD ${fmt(left)} is left; ` : ""}this invoice is USD ${fmt(amount)}.`,
      evidence: [{ doc: "proforma_invoice", field: "total", value: amount }],
      fix: left > 0
        ? `Reduce this order to USD ${fmt(left)} or less, or open a Form M for the full amount. Splitting one order across invoices to stay under the limit is not allowed.`
        : "This quarter's allowance is used up. Wait for the next quarter or open a Form M.",
    });
  } else if (amount != null && !usd) {
    issues.push({
      code: "FORM_Q_CURRENCY",
      severity: "warning",
      title: `Invoice is in ${pi.currency ?? "an unstated currency"}, not US dollars`,
      detail: `The Form Q limit is USD ${fmt(FORM_Q_LIMIT_USD)} per quarter. The bank will convert ${pi.currency ?? "this"} ${fmt(amount)} at its rate to check the limit.`,
      evidence: [{ doc: "proforma_invoice", field: "currency", value: pi.currency }],
      fix: "Ask the bank for the US dollar equivalent before you apply.",
    });
  }

  pi.lines.forEach((l, i) => {
    if (l.description && SERVICE.test(l.description)) {
      issues.push({
        code: "FORM_Q_NOT_GOODS",
        severity: "error",
        title: `Line ${i + 1} looks like a service, not goods`,
        detail: `"${l.description}" reads as a service. Form Q is only for importing physical goods; services are paid through Form A.`,
        evidence: [{ doc: "proforma_invoice", field: `lines[${i}].description`, value: l.description }],
        fix: "Remove the service from this invoice and pay it separately through Form A.",
      });
    }
  });

  if (!pi.buyer.name) {
    issues.push({
      code: "MISSING_APPLICANT", severity: "error", title: "Invoice is not addressed to your business",
      detail: "The invoice has no buyer name. The bank pays only for invoices in the applicant's name.",
      evidence: [{ doc: "proforma_invoice", field: "buyer.name", value: null }],
      fix: "Ask the supplier to address the invoice to your registered business name.",
    });
  }
  issues.push({
    code: "BRING_TO_BANK", severity: "info", title: "Also needed at the bank: Form Q and your instruction letter",
    detail: "Bring the completed Form Q and a signed instruction letter naming the supplier and their bank details. After payment, submit the shipping documents within 60 days.",
    evidence: [], fix: "Prepare them before you visit the bank.",
  });
  return issues;
}

export function buildFormQDraft(docs: DocumentSet, opts: { usedThisQuarter?: number } = {}): FormMDraft {
  const pi = docs.proforma_invoice;
  const f = (label: string, value: DraftField["value"] | undefined, source: string): DraftField => ({ label, value: value ?? null, source: value == null ? null : source });
  const amount = invoiceTotal(docs);
  const used = Math.max(0, opts.usedThisQuarter ?? 0);
  const usd = (pi?.currency ?? "").toUpperCase() === "USD";
  const sections = [
    { title: "Applicant (importer)", fields: [f("Name", pi?.buyer.name, "Invoice"), f("RC number", pi?.buyer.rc_number, "Invoice"), f("Address", pi?.buyer.address, "Invoice")] },
    { title: "Supplier (beneficiary)", fields: [f("Name", pi?.seller.name, "Invoice"), f("Address", pi?.seller.address, "Invoice"), f("Country", pi?.country_of_supply, "Invoice")] },
    {
      title: "Financials",
      fields: [
        f("Currency", pi?.currency, "Invoice"), f("Invoice no.", pi?.invoice_number, "Invoice"), f("Invoice date", pi?.invoice_date, "Invoice"),
        f("Payment terms", pi?.payment_terms, "Invoice"), f("Total value", amount, "Invoice"),
      ],
    },
    {
      title: "Quarterly allowance",
      fields: [
        f("Limit per quarter (USD)", FORM_Q_LIMIT_USD, "CBN"),
        f("Already used (USD)", used, "You"),
        f("Left after this (USD)", usd && amount != null ? Math.round((FORM_Q_LIMIT_USD - used - amount) * 100) / 100 : null, "Calculated"),
      ],
    },
  ];
  const items = (pi?.lines ?? []).map((l) => ({
    description: l.description, hs_code: l.hs_code, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, amount: l.line_total,
    net_weight_kg: null, gross_weight_kg: null,
  }));
  const missing = sections.flatMap((s) => s.fields.filter((x) => x.value == null).map((x) => `${s.title}: ${x.label}`));
  return { sections, items, missing };
}

export { normalizeName };
