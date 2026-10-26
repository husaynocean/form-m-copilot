/**
 * Convert a synthetic case's answer key into the DocumentSet a perfect reader
 * would extract (i.e. what is PRINTED, including the injected errors).
 */
import type { DocumentSet } from "../lib/schema";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function caseToDocs(key: any): DocumentSet {
  const pf = key.proforma;
  const pl = key.packing_list;
  const ins = key.insurance_certificate;
  const [from, to] = String(ins.voyage).split(" to ");
  return {
    proforma_invoice: {
      doc_type: "proforma_invoice",
      seller: { name: key.beneficiary.name, address: key.beneficiary.address, rc_number: null },
      buyer: { name: key.importer.name, address: key.importer.address, rc_number: key.importer.rc_number },
      invoice_number: pf.number,
      invoice_date: pf.date,
      valid_until: pf.valid_until,
      currency: pf.currency,
      incoterm: pf.incoterm,
      country_of_origin: pf.country_of_origin,
      country_of_supply: pf.country_of_supply,
      port_of_loading: pf.port_of_loading,
      port_of_discharge: pf.port_of_discharge,
      mode_of_transport: pf.mode_of_transport,
      payment_terms: pf.payment_terms,
      lines: pf.items.map((i: any) => ({
        description: i.printed_description ?? i.description,
        hs_code: i.printed_description ? null : i.hs_code,
        quantity: i.quantity,
        unit: i.unit,
        unit_price: i.unit_price,
        line_total: i.line_total,
      })),
      goods_value: pf.goods_value,
      freight: pf.freight || null,
      insurance: pf.insurance || null,
      total: pf.printed_total ?? pf.total,
    },
    packing_list: {
      doc_type: "packing_list",
      seller: { name: pl.beneficiary_name, address: key.beneficiary.address, rc_number: null },
      buyer: { name: pl.importer_name, address: key.importer.address, rc_number: key.importer.rc_number },
      packing_list_number: pl.number,
      date: pl.date,
      proforma_reference: pf.number,
      port_of_discharge: pl.port_of_discharge,
      lines: pl.items.map((i: any) => ({
        description: i.description,
        quantity: i.quantity,
        unit: i.unit,
        packages: i.packages,
        net_weight_kg: i.net_weight_kg,
        gross_weight_kg: i.gross_weight_kg,
      })),
    },
    insurance_certificate: {
      doc_type: "insurance_certificate",
      insurer: ins.insurer,
      certificate_number: ins.certificate_number,
      policy_number: ins.policy_number,
      date_of_issue: ins.date,
      insured: ins.insured,
      interest: pf.items.map((i: any) => i.description).join("; "),
      proforma_reference: pf.number,
      currency: ins.currency,
      sum_insured: ins.sum_insured,
      voyage_from: from ?? null,
      voyage_to: to ?? null,
      conveyance: ins.conveyance,
      conditions: ins.cover,
    },
  };
}
