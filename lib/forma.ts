import { normalizeName } from "./validate";
import type { DraftField, FormMDraft } from "./formm";
import type { DocumentSet, Issue } from "./schema";
import { makeDeadline, type Deadline } from "./deadlines";

/**
 * Form A: foreign exchange for services (school fees, medical bills).
 *
 * Tuition limit: the bank's published page says USD 15,000 per semester; the
 * 2026 CBN FX Manual reportedly raised it to USD 25,000. Above 25,000 is
 * flagged as an error, between the two as a warning to confirm with the bank.
 *
 * Passports and tax clearance certificates are NOT uploaded here: they are
 * listed as things to bring, so personal ID documents never pass through a
 * public demo.
 */
export const TUITION_LIMIT_USD = 25_000;
export const TUITION_BANK_PAGE_USD = 15_000;

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sameName = (a: string | null | undefined, b: string | null | undefined) => {
  const x = normalizeName(a).split(" ").filter(Boolean).sort().join(" ");
  const y = normalizeName(b).split(" ").filter(Boolean).sort().join(" ");
  return x === y; // order-insensitive: "Musa Bello" == "Bello Musa"
};

/** Same institution if every word of the shorter name appears in the longer one
 * ("Kestrel Valley College" vs "Kestrel Valley College · Canada"). */
const sameInstitution = (a: string | null | undefined, b: string | null | undefined) => {
  const t = (s: string | null | undefined) => normalizeName(s).replace(/[^a-z0-9 ]/g, " ").split(" ").filter((w) => w.length > 1 && w !== "the" && w !== "of");
  const [x, y] = [t(a), t(b)].sort((p, q) => p.length - q.length);
  return x.length > 0 && x.every((w) => y.includes(w));
};

export type FormAPurpose = "tuition" | "medical";

export function formAPurpose(docs: DocumentSet): FormAPurpose {
  const p = `${docs.fee_invoice?.purpose ?? ""} ${docs.support_letter?.kind ?? ""}`.toLowerCase();
  return /medic|hospital|treat/.test(p) ? "medical" : "tuition";
}

export function validateFormA(docs: DocumentSet, today: Date = new Date()): Issue[] {
  const bill = docs.fee_invoice;
  const letter = docs.support_letter;
  const purpose = formAPurpose(docs);
  const issues: Issue[] = [];
  const billName = purpose === "tuition" ? "school bill" : "hospital cost estimate";
  const letterName = purpose === "tuition" ? "admission letter" : "overseas doctor's letter";

  const missing = [!bill && billName, !letter && letterName].filter(Boolean) as string[];
  if (missing.length) {
    issues.push({
      code: "MISSING_DOCUMENT", severity: "warning", title: `Missing: ${missing.join(", ")}`,
      detail: `Form A for ${purpose === "tuition" ? "school fees" : "medical bills"} needs the ${billName} and the ${letterName}.`,
      evidence: [], fix: "Add the missing document and check again.",
    });
  }

  if (bill && letter) {
    if (bill.person_name && letter.person_name && !sameName(bill.person_name, letter.person_name)) {
      issues.push({
        code: "NAME_MISMATCH", severity: "error",
        title: `${purpose === "tuition" ? "Student" : "Patient"} name differs between documents`,
        detail: `The ${billName} is for "${bill.person_name}" but the ${letterName} is for "${letter.person_name}". The bank needs the same name on every document (and on the passport).`,
        evidence: [
          { doc: "fee_invoice", field: "person_name", value: bill.person_name },
          { doc: "support_letter", field: "person_name", value: letter.person_name },
        ],
        fix: `Ask the ${purpose === "tuition" ? "school" : "hospital"} to reissue the document with the name exactly as on the passport.`,
      });
    }
    if (bill.institution && letter.institution && !sameInstitution(bill.institution, letter.institution)) {
      issues.push({
        code: "INSTITUTION_MISMATCH", severity: "error",
        title: `The ${billName} and ${letterName} are from different institutions`,
        detail: `The ${billName} is from "${bill.institution}" but the ${letterName} is from "${letter.institution}".`,
        evidence: [
          { doc: "fee_invoice", field: "institution", value: bill.institution },
          { doc: "support_letter", field: "institution", value: letter.institution },
        ],
        fix: "Make sure both documents come from the institution that will receive the payment.",
      });
    }
  }

  if (bill) {
    if (!bill.beneficiary_account) {
      issues.push({
        code: "BANK_DETAILS_MISSING", severity: "error", title: `No bank account on the ${billName}`,
        detail: `Form A payments go directly to the ${purpose === "tuition" ? "school" : "hospital"}'s account, so the bill must show its bank and account number (or IBAN).`,
        evidence: [{ doc: "fee_invoice", field: "beneficiary_account", value: null }],
        fix: `Ask the ${purpose === "tuition" ? "school" : "hospital"} for an invoice that shows its bank details.`,
      });
    }
    const usd = (bill.currency ?? "").toUpperCase() === "USD";
    if (purpose === "tuition" && bill.amount != null && usd) {
      if (bill.amount > TUITION_LIMIT_USD) {
        issues.push({
          code: "FEE_LIMIT_EXCEEDED", severity: "error", title: "School fees above the Form A limit",
          detail: `The bill is USD ${fmt(bill.amount)}. Form A tuition is limited to USD ${fmt(TUITION_LIMIT_USD)} per semester.`,
          evidence: [{ doc: "fee_invoice", field: "amount", value: bill.amount }],
          fix: "Ask the school for a per-semester bill, or fund the difference from a domiciliary account.",
        });
      } else if (bill.amount > TUITION_BANK_PAGE_USD) {
        issues.push({
          code: "FEE_LIMIT_CHECK", severity: "warning", title: "Confirm the tuition limit with the bank",
          detail: `The bill is USD ${fmt(bill.amount)}. The bank's published limit is USD ${fmt(TUITION_BANK_PAGE_USD)} per semester; the 2026 FX Manual reportedly raised it to USD ${fmt(TUITION_LIMIT_USD)}.`,
          evidence: [{ doc: "fee_invoice", field: "amount", value: bill.amount }],
          fix: "Confirm the current limit with the bank before applying.",
        });
      }
    } else if (bill.amount != null && !usd && purpose === "tuition") {
      issues.push({
        code: "FEE_CURRENCY", severity: "info", title: `Bill is in ${bill.currency ?? "an unstated currency"}`,
        detail: `The tuition limit is set in US dollars; the bank will convert ${bill.currency ?? ""} ${fmt(bill.amount)} at its rate.`.replace("  ", " "),
        evidence: [{ doc: "fee_invoice", field: "currency", value: bill.currency }], fix: "Ask the bank for the US dollar equivalent.",
      });
    }
    if (bill.due_date && bill.due_date < today.toISOString().slice(0, 10)) {
      issues.push({
        code: "FEE_DUE_DATE_PASSED", severity: "warning", title: "The payment due date has passed",
        detail: `The ${billName} was due on ${bill.due_date}.`,
        evidence: [{ doc: "fee_invoice", field: "due_date", value: bill.due_date }],
        fix: `Ask the ${purpose === "tuition" ? "school" : "hospital"} for an updated bill before applying.`,
      });
    }
  }

  const bring = purpose === "tuition"
    ? ["the completed Form A", "your tax clearance certificate", "the student's passport biodata page", "a signed instruction to bid for FX with the school's bank details", "for postgraduate study, the first-degree certificate or statement of result"]
    : ["the completed Form A", "a referral letter from a Nigerian specialist doctor or hospital", "travel documents (passport, visa, ticket)", "your tax clearance certificate", "a signed instruction to bid for FX"];
  issues.push({
    code: "BRING_TO_BANK", severity: "info", title: "Bring these to the bank (don't upload them here)",
    detail: `Also needed: ${bring.join("; ")}.`, evidence: [],
    fix: purpose === "tuition" ? "Apply on the CBN Trade Monitoring System and choose your bank." : "The treatment fee is paid to the hospital; maintenance is paid to the patient.",
  });
  return issues;
}

export function feeDeadline(docs: DocumentSet, today: Date = new Date()): Deadline | null {
  const b = docs.fee_invoice;
  if (!b?.due_date) return null;
  const start = b.issue_date && b.issue_date <= b.due_date ? b.issue_date : today.toISOString().slice(0, 10);
  const days = Math.max(1, Math.round((Date.parse(b.due_date) - Date.parse(start)) / 86_400_000));
  return makeDeadline({
    kind: "fee_due", title: formAPurpose(docs) === "tuition" ? "School fees due" : "Medical bill due",
    basis: `Due date printed on the ${formAPurpose(docs) === "tuition" ? "school bill" : "cost estimate"} · Form A requests are treated first come, first served`,
    start_label: "Issued", start_date: start, days_total: days, reference: b.reference, amount: b.amount, currency: b.currency,
    action: "Apply early: Form A requests are processed in order of arrival.",
  }, today, 21);
}

export function buildFormADraft(docs: DocumentSet): FormMDraft {
  const b = docs.fee_invoice;
  const l = docs.support_letter;
  const purpose = formAPurpose(docs);
  const f = (label: string, value: DraftField["value"] | undefined, source: string): DraftField => ({ label, value: value ?? null, source: value == null ? null : source });
  const sections = [
    { title: "Purpose", fields: [f("Type", purpose === "tuition" ? "School fees (tuition)" : "Medical bill", "Documents"), f("Programme / treatment", l?.programme, "Letter"), f("Period", b?.period, "Bill"), f("Start date", l?.start_date, "Letter")] },
    { title: purpose === "tuition" ? "Student" : "Patient", fields: [f("Name", b?.person_name ?? l?.person_name, "Bill"), f("Reference / ID", b?.reference, "Bill")] },
    { title: "Beneficiary", fields: [f("Institution", b?.institution ?? l?.institution, "Bill"), f("Country", b?.institution_country, "Bill"), f("Bank", b?.beneficiary_bank, "Bill"), f("Account / IBAN", b?.beneficiary_account, "Bill")] },
    { title: "Financials", fields: [f("Currency", b?.currency, "Bill"), f("Total value", b?.amount, "Bill"), f("Due date", b?.due_date, "Bill")] },
  ];
  const missing = sections.flatMap((s) => s.fields.filter((x) => x.value == null).map((x) => `${s.title}: ${x.label}`));
  return { sections, items: [], missing };
}
