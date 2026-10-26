import type { DocumentSet } from "./schema";

/**
 * Step 3: assemble a Form M draft from the extracted documents.
 * Each field records where its value came from, so the officer can trace it.
 * This is a pre-fill to review, not a submission to the Single Window.
 */

export interface DraftField {
  label: string;
  value: string | number | null;
  source: string | null;
}

export interface FormMDraft {
  sections: { title: string; fields: DraftField[] }[];
  items: {
    description: string | null;
    hs_code: string | null;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
    amount: number | null;
    net_weight_kg: number | null;
    gross_weight_kg: number | null;
  }[];
  missing: string[];
}

export function buildFormMDraft(docs: DocumentSet): FormMDraft {
  const pi = docs.proforma_invoice;
  const pl = docs.packing_list;
  const ins = docs.insurance_certificate;
  const f = (label: string, value: DraftField["value"] | undefined, source: string | null): DraftField => ({
    label,
    value: value ?? null,
    source: value == null ? null : source,
  });

  const fob =
    pi && pi.goods_value != null
      ? pi.goods_value
      : pi?.lines.reduce((s, l) => s + (l.line_total ?? 0), 0) ?? null;

  // Under FOB the buyer arranges freight and insurance; under CFR, insurance.
  const isFob = pi?.incoterm?.toUpperCase() === "FOB";

  const sections = [
    {
      title: "Applicant (importer)",
      fields: [
        f("Name", pi?.buyer.name, "Proforma"),
        f("RC number", pi?.buyer.rc_number, "Proforma"),
        f("Address", pi?.buyer.address, "Proforma"),
      ],
    },
    {
      title: "Beneficiary (supplier)",
      fields: [
        f("Name", pi?.seller.name, "Proforma"),
        f("Address", pi?.seller.address, "Proforma"),
      ],
    },
    {
      title: "Shipment",
      fields: [
        f("Country of origin", pi?.country_of_origin, "Proforma"),
        f("Country of supply", pi?.country_of_supply, "Proforma"),
        f("Port of loading", pi?.port_of_loading, "Proforma"),
        f("Port of discharge", pi?.port_of_discharge, "Proforma"),
        f("Mode of transport", pi?.mode_of_transport, "Proforma"),
        f("Terms of delivery (Incoterm)", pi?.incoterm, "Proforma"),
      ],
    },
    {
      title: "Financials",
      fields: [
        f("Currency", pi?.currency, "Proforma"),
        f("Proforma invoice no.", pi?.invoice_number, "Proforma"),
        f("Proforma invoice date", pi?.invoice_date, "Proforma"),
        f("Payment terms", pi?.payment_terms, "Proforma"),
        f("FOB value", fob, "Proforma"),
        f("Freight", pi?.freight ?? (isFob ? "Not applicable (FOB)" : null), "Proforma"),
        f("Insurance (on invoice)", pi?.insurance ?? (isFob || pi?.incoterm?.toUpperCase() === "CFR" ? `Not applicable (${pi?.incoterm?.toUpperCase()})` : null), "Proforma"),
        f("Total value", pi?.total, "Proforma"),
      ],
    },
    {
      title: "Insurance",
      fields: [
        f("Insurer", ins?.insurer, "Insurance cert."),
        f("Policy no.", ins?.policy_number, "Insurance cert."),
        f("Certificate no.", ins?.certificate_number, "Insurance cert."),
        f("Sum insured", ins?.sum_insured, "Insurance cert."),
      ],
    },
  ];

  const items = (pi?.lines ?? []).map((l, i) => {
    const pack = pl?.lines[i];
    return {
      description: l.description,
      hs_code: l.hs_code,
      quantity: l.quantity,
      unit: l.unit,
      unit_price: l.unit_price,
      amount: l.line_total,
      net_weight_kg: pack?.net_weight_kg ?? null,
      gross_weight_kg: pack?.gross_weight_kg ?? null,
    };
  });

  const missing = sections.flatMap((s) => s.fields.filter((x) => x.value == null).map((x) => `${s.title}: ${x.label}`));
  items.forEach((it, i) => {
    if (!it.hs_code) missing.push(`Item ${i + 1}: HS code`);
  });

  return { sections, items, missing };
}
