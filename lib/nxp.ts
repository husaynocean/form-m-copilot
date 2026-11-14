import { validate, normalizeName } from "./validate";
import type { FormMDraft, DraftField } from "./formm";
import type { DocumentSet, Issue } from "./schema";

/**
 * Export side: checks for a Form NXP file and the repatriation clock.
 *
 * Rule source (confirm against the current CBN FX Manual before relying on it):
 * export proceeds must be repatriated within 180 days of the bill of lading
 * date for non-oil exports and 90 days for oil and gas; since the CBN circular
 * of 8 January 2025 no extensions are granted.
 */

export type ExportCategory = "non-oil" | "oil";
export const REPATRIATION_DAYS: Record<ExportCategory, number> = { "non-oil": 180, oil: 90 };

export interface RepatriationTracker {
  category: ExportCategory;
  bl_number: string | null;
  bl_date: string;
  deadline: string;
  days_total: number;
  days_left: number; // negative when overdue
  status: "ok" | "due_soon" | "overdue";
  amount: number | null;
  currency: string | null;
}

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const port = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\b(port|of|lagos|nigeria|netherlands|germany|china|belgium|uae|india)\b/g, "").replace(/\s+/g, " ").trim();
const samePort = (a: string | null | undefined, b: string | null | undefined) => {
  const [x, y] = [port(a), port(b)];
  return !x || !y || x.includes(y) || y.includes(x);
};
const sameName = (a: string | null | undefined, b: string | null | undefined) => normalizeName(a) === normalizeName(b);

export function repatriation(docs: DocumentSet, category: ExportCategory, today: Date): RepatriationTracker | null {
  const bl = docs.bill_of_lading;
  const start = bl?.shipped_on_board_date ? new Date(bl.shipped_on_board_date) : null;
  if (!bl || !start || Number.isNaN(start.getTime())) return null;
  const days = REPATRIATION_DAYS[category];
  const deadline = new Date(start.getTime() + days * DAY);
  const left = Math.ceil((deadline.getTime() - new Date(iso(today)).getTime()) / DAY);
  return {
    category,
    bl_number: bl.bl_number,
    bl_date: iso(start),
    deadline: iso(deadline),
    days_total: days,
    days_left: left,
    status: left < 0 ? "overdue" : left <= 30 ? "due_soon" : "ok",
    amount: docs.proforma_invoice?.total ?? null,
    currency: docs.proforma_invoice?.currency ?? null,
  };
}

/** Invoice and packing-list rules that apply to exports as well as imports. */
const SHARED = new Set(["INVOICE_TOTAL_MISMATCH", "LINE_TOTAL_MISMATCH", "MISSING_INCOTERM", "VAGUE_DESCRIPTION", "PACKING_QTY_MISMATCH"]);

export function validateExport(docs: DocumentSet, category: ExportCategory = "non-oil", today: Date = new Date()): Issue[] {
  const inv = docs.proforma_invoice;
  const pl = docs.packing_list;
  const bl = docs.bill_of_lading;
  const nepc = docs.nepc_certificate;
  const issues: Issue[] = validate({ proforma_invoice: inv, packing_list: pl }, today).filter((i) => SHARED.has(i.code));

  // --- required documents -------------------------------------------------
  const missing = [
    !inv && "commercial or proforma invoice",
    !pl && "packing list",
    !bl && "bill of lading",
    !nepc && "NEPC exporter's certificate",
  ].filter(Boolean) as string[];
  if (missing.length) {
    issues.push({
      code: "MISSING_DOCUMENT",
      severity: "warning",
      title: `Missing: ${missing.join(", ")}`,
      detail: `The export file is incomplete. Not provided: ${missing.join(", ")}.`,
      evidence: [],
      fix: "Add the missing document(s) and check again.",
    });
  }

  // --- exporter identity --------------------------------------------------
  const exporter = inv?.seller.name ?? null;
  if (exporter && bl?.shipper && !sameName(exporter, bl.shipper)) {
    issues.push({
      code: "EXPORTER_NAME_MISMATCH",
      severity: "error",
      title: "Exporter name differs between invoice and bill of lading",
      detail: `The invoice is issued by "${exporter}" but the bill of lading shows the shipper as "${bl.shipper}". The NXP, invoice and bill of lading must carry the same exporter.`,
      evidence: [
        { doc: "proforma_invoice", field: "seller.name", value: exporter },
        { doc: "bill_of_lading", field: "shipper", value: bl.shipper },
      ],
      fix: "Ask the shipping line to amend the shipper on the bill of lading, or reissue the invoice in the registered exporter's name.",
    });
  }
  if (nepc) {
    if (exporter && nepc.exporter_name && !sameName(exporter, nepc.exporter_name)) {
      issues.push({
        code: "NEPC_NAME_MISMATCH",
        severity: "error",
        title: "NEPC certificate is in a different name",
        detail: `The NEPC certificate ${nepc.certificate_number ?? ""} is registered to "${nepc.exporter_name}" but the invoice is issued by "${exporter}".`.replace("  ", " "),
        evidence: [
          { doc: "nepc_certificate", field: "exporter_name", value: nepc.exporter_name },
          { doc: "proforma_invoice", field: "seller.name", value: exporter },
        ],
        fix: "Use the NEPC certificate of the company that is exporting, or issue the invoice in the registered exporter's name.",
      });
    }
    const exp = nepc.expiry_date ? new Date(nepc.expiry_date) : null;
    const ref = bl?.shipped_on_board_date ? new Date(bl.shipped_on_board_date) : today;
    if (exp && !Number.isNaN(exp.getTime()) && exp.getTime() < ref.getTime()) {
      issues.push({
        code: "NEPC_EXPIRED",
        severity: "error",
        title: "NEPC certificate has expired",
        detail: `The NEPC certificate ${nepc.certificate_number ?? ""} expired on ${nepc.expiry_date}, before ${bl?.shipped_on_board_date ? `the shipment date ${bl.shipped_on_board_date}` : "today"}.`.replace("  ", " "),
        evidence: [{ doc: "nepc_certificate", field: "expiry_date", value: nepc.expiry_date }],
        fix: "Renew the NEPC exporter's certificate before the bank processes the NXP.",
      });
    }
  }

  // --- invoice vs bill of lading -----------------------------------------
  if (inv && bl) {
    if (!samePort(inv.port_of_loading, bl.port_of_loading) || !samePort(inv.port_of_discharge, bl.port_of_discharge)) {
      issues.push({
        code: "PORT_MISMATCH",
        severity: "error",
        title: "Ports differ between invoice and bill of lading",
        detail: `Invoice: ${inv.port_of_loading ?? "—"} to ${inv.port_of_discharge ?? "—"}. Bill of lading: ${bl.port_of_loading ?? "—"} to ${bl.port_of_discharge ?? "—"}.`,
        evidence: [
          { doc: "proforma_invoice", field: "port_of_discharge", value: inv.port_of_discharge },
          { doc: "bill_of_lading", field: "port_of_discharge", value: bl.port_of_discharge },
        ],
        fix: "Correct the invoice or have the shipping line amend the bill of lading so both show the same route.",
      });
    }
    const consignee = (bl.consignee ?? "").toLowerCase();
    if (inv.buyer.name && bl.consignee && !/\bto (the )?order\b/.test(consignee) && !sameName(inv.buyer.name, bl.consignee)) {
      issues.push({
        code: "CONSIGNEE_MISMATCH",
        severity: "warning",
        title: "Consignee is not the buyer on the invoice",
        detail: `The invoice buyer is "${inv.buyer.name}" but the bill of lading is consigned to "${bl.consignee}". Payment from a different party is hard for the bank to match to the NXP.`,
        evidence: [
          { doc: "proforma_invoice", field: "buyer.name", value: inv.buyer.name },
          { doc: "bill_of_lading", field: "consignee", value: bl.consignee },
        ],
        fix: "Confirm who will pay. If a third party pays, give the bank a letter linking the payer to this NXP.",
      });
    }
    if (!inv.payment_terms) {
      issues.push({
        code: "MISSING_PAYMENT_TERMS",
        severity: "warning",
        title: "Payment terms not stated",
        detail: "The invoice does not say how or when the buyer will pay. The bank needs this to track repatriation.",
        evidence: [{ doc: "proforma_invoice", field: "payment_terms", value: null }],
        fix: "Ask for the payment terms to be added to the invoice or contract.",
      });
    }
  }

  // --- packing list vs bill of lading ------------------------------------
  if (pl && bl) {
    const pk = pl.lines.reduce((s, l) => s + (l.packages ?? 0), 0);
    const gw = pl.lines.reduce((s, l) => s + (l.gross_weight_kg ?? 0), 0);
    if (bl.packages != null && pk > 0 && bl.packages !== pk) {
      issues.push({
        code: "PACKAGES_MISMATCH",
        severity: "error",
        title: "Package count differs between packing list and bill of lading",
        detail: `The packing list totals ${pk} packages but the bill of lading shows ${bl.packages}.`,
        evidence: [
          { doc: "packing_list", field: "lines.packages", value: pk },
          { doc: "bill_of_lading", field: "packages", value: bl.packages },
        ],
        fix: "Confirm the quantity actually shipped and correct the document that is wrong.",
      });
    }
    if (bl.gross_weight_kg != null && gw > 0 && Math.abs(bl.gross_weight_kg - gw) > Math.max(1, gw * 0.01)) {
      issues.push({
        code: "WEIGHT_MISMATCH",
        severity: "error",
        title: "Gross weight differs between packing list and bill of lading",
        detail: `The packing list totals ${fmt(gw)} kg gross but the bill of lading shows ${fmt(bl.gross_weight_kg)} kg (difference ${fmt(Math.abs(bl.gross_weight_kg - gw))}).`,
        evidence: [
          { doc: "packing_list", field: "lines.gross_weight_kg", value: gw },
          { doc: "bill_of_lading", field: "gross_weight_kg", value: bl.gross_weight_kg },
        ],
        fix: "Confirm the weight actually shipped and correct the document that is wrong.",
      });
    }
  }

  // --- repatriation clock -------------------------------------------------
  const t = repatriation(docs, category, today);
  if (t && t.status !== "ok") {
    const value = t.amount != null ? ` (${t.currency ?? ""} ${fmt(t.amount)})`.replace("( ", "(") : "";
    issues.push(
      t.status === "overdue"
        ? {
            code: "REPATRIATION_OVERDUE",
            severity: "error",
            title: "Repatriation deadline has passed",
            detail: `Proceeds${value} were due by ${t.deadline}, ${t.days_total} days after the bill of lading date ${t.bl_date}. The deadline passed ${Math.abs(t.days_left)} days ago and the CBN no longer grants extensions.`,
            evidence: [{ doc: "bill_of_lading", field: "shipped_on_board_date", value: t.bl_date }],
            fix: "Contact your bank's trade desk immediately about this outstanding NXP.",
          }
        : {
            code: "REPATRIATION_DUE_SOON",
            severity: "warning",
            title: `Repatriation due in ${t.days_left} days`,
            detail: `Proceeds${value} must reach the export domiciliary account by ${t.deadline}, ${t.days_total} days after the bill of lading date ${t.bl_date}. The CBN no longer grants extensions.`,
            evidence: [{ doc: "bill_of_lading", field: "shipped_on_board_date", value: t.bl_date }],
            fix: "Follow up with the buyer now, and ask them to quote the NXP number and invoice number on the payment.",
          },
    );
  }
  return issues;
}

/** Pre-fill for the e-Form NXP, with the same shape as the Form M draft. */
export function buildNxpDraft(docs: DocumentSet): FormMDraft {
  const inv = docs.proforma_invoice;
  const pl = docs.packing_list;
  const bl = docs.bill_of_lading;
  const nepc = docs.nepc_certificate;
  const f = (label: string, value: DraftField["value"] | undefined, source: string): DraftField => ({ label, value: value ?? null, source: value == null ? null : source });
  const goods = inv ? (inv.goods_value ?? inv.lines.reduce((s, l) => s + (l.line_total ?? 0), 0)) : null;
  const sections = [
    {
      title: "Exporter",
      fields: [
        f("Name", inv?.seller.name ?? bl?.shipper, "Invoice"),
        f("Address", inv?.seller.address, "Invoice"),
        f("RC number", nepc?.rc_number, "NEPC cert."),
        f("NEPC certificate no.", nepc?.certificate_number, "NEPC cert."),
        f("NEPC expiry", nepc?.expiry_date, "NEPC cert."),
      ],
    },
    {
      title: "Buyer (consignee)",
      fields: [f("Name", inv?.buyer.name ?? bl?.consignee, "Invoice"), f("Address", inv?.buyer.address, "Invoice"), f("Notify party", bl?.notify_party, "Bill of lading")],
    },
    {
      title: "Shipment",
      fields: [
        f("Bill of lading no.", bl?.bl_number, "Bill of lading"),
        f("Shipped on board", bl?.shipped_on_board_date, "Bill of lading"),
        f("Vessel", bl?.vessel, "Bill of lading"),
        f("Port of loading", bl?.port_of_loading ?? inv?.port_of_loading, "Bill of lading"),
        f("Port of discharge", bl?.port_of_discharge ?? inv?.port_of_discharge, "Bill of lading"),
        f("Packages", bl?.packages, "Bill of lading"),
        f("Gross weight (kg)", bl?.gross_weight_kg, "Bill of lading"),
      ],
    },
    {
      title: "Financials",
      fields: [
        f("Currency", inv?.currency, "Invoice"),
        f("Invoice no.", inv?.invoice_number, "Invoice"),
        f("Invoice date", inv?.invoice_date, "Invoice"),
        f("Delivery terms", inv?.incoterm, "Invoice"),
        f("Payment terms", inv?.payment_terms, "Invoice"),
        f("FOB value", goods, "Invoice"),
        f("Total value", inv?.total, "Invoice"),
      ],
    },
  ];
  const items = (inv?.lines ?? []).map((l, i) => ({
    description: l.description,
    hs_code: l.hs_code,
    quantity: l.quantity,
    unit: l.unit,
    unit_price: l.unit_price,
    amount: l.line_total,
    net_weight_kg: pl?.lines[i]?.net_weight_kg ?? null,
    gross_weight_kg: pl?.lines[i]?.gross_weight_kg ?? null,
  }));
  const missing = sections.flatMap((s) => s.fields.filter((x) => x.value == null).map((x) => `${s.title}: ${x.label}`));
  items.forEach((it, i) => { if (!it.hs_code) missing.push(`Item ${i + 1}: HS code`); });
  return { sections, items, missing };
}
