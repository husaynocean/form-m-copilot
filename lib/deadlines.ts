/**
 * Deadline clocks shared by Form M, Form NXP and Form Q.
 *
 * Rules as stated by the bank (confirm against the current CBN FX Manual):
 * - Form M is valid 180 days for general merchandise, 365 days for plant and
 *   machinery; the bank can extend it once by the same period, after which
 *   further extensions need CBN approval.
 * - Export proceeds: 180 days from the bill of lading date for non-oil
 *   exports, 90 days for oil and gas; no extensions since 8 January 2025.
 * - Form Q: shipping documents are due within 60 days of the remittance.
 */

export type DeadlineKind = "repatriation" | "form_m_validity" | "form_q_documents" | "fee_due";

export interface Deadline {
  kind: DeadlineKind;
  title: string;
  /** One-line explanation of the rule applied. */
  basis: string;
  start_label: string;
  start_date: string;
  deadline: string;
  days_total: number;
  days_left: number; // negative when overdue
  status: "ok" | "due_soon" | "overdue";
  reference: string | null;
  amount: number | null;
  currency: string | null;
  /** What has to happen by the deadline. */
  action: string;
}

const DAY = 86_400_000;
export const iso = (d: Date) => d.toISOString().slice(0, 10);

export function makeDeadline(
  d: Omit<Deadline, "deadline" | "days_left" | "status">,
  today: Date = new Date(),
  soonDays = 30,
): Deadline {
  const start = new Date(d.start_date);
  const deadline = new Date(start.getTime() + d.days_total * DAY);
  const left = Math.ceil((deadline.getTime() - new Date(iso(today)).getTime()) / DAY);
  return { ...d, deadline: iso(deadline), days_left: left, status: left < 0 ? "overdue" : left <= soonDays ? "due_soon" : "ok" };
}

export type FormMCategory = "general" | "plant";
export const FORM_M_DAYS: Record<FormMCategory, number> = { general: 180, plant: 365 };

export function formMValidity(
  opts: { category: FormMCategory; approvalDate?: string | null; reference?: string | null; amount?: number | null; currency?: string | null },
  today: Date = new Date(),
): Deadline {
  const days = FORM_M_DAYS[opts.category];
  const approved = Boolean(opts.approvalDate);
  return makeDeadline(
    {
      kind: "form_m_validity",
      title: "Form M validity",
      basis: `${days} days for ${opts.category === "plant" ? "plant & machinery" : "general goods"} · the bank can extend once by ${days} days, then CBN approval is needed`,
      start_label: approved ? "Approved" : "If approved today",
      start_date: opts.approvalDate ?? iso(today),
      days_total: days,
      reference: opts.reference ?? null,
      amount: opts.amount ?? null,
      currency: opts.currency ?? null,
      action: "Goods must ship before the Form M expires, or ask the bank for an extension in time.",
    },
    today,
  );
}

export const FORM_Q_DOCS_DAYS = 60;

export function formQDocuments(
  opts: { remittanceDate?: string | null; reference?: string | null; amount?: number | null; currency?: string | null },
  today: Date = new Date(),
): Deadline {
  const paid = Boolean(opts.remittanceDate);
  return makeDeadline(
    {
      kind: "form_q_documents",
      title: "Form Q shipping documents",
      basis: `Shipping documents are due within ${FORM_Q_DOCS_DAYS} days of the payment to the supplier`,
      start_label: paid ? "Paid" : "If paid today",
      start_date: opts.remittanceDate ?? iso(today),
      days_total: FORM_Q_DOCS_DAYS,
      reference: opts.reference ?? null,
      amount: opts.amount ?? null,
      currency: opts.currency ?? null,
      action: "Submit the bill of lading and final invoice to the bank.",
    },
    today,
    14,
  );
}
