import { z } from "zod";

/**
 * Structured fields extracted from each trade document.
 * Every field is nullable: if the document does not show it, the model must
 * return null rather than guess. Missing data is itself a finding.
 */

const num = z.number().nullable();
const str = z.string().nullable();

export const Party = z.object({
  name: str,
  address: str,
  rc_number: str.optional().default(null),
});
export type Party = z.infer<typeof Party>;

export const InvoiceLine = z.object({
  description: str,
  hs_code: str,
  quantity: num,
  unit: str,
  unit_price: num,
  line_total: num,
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

export const ProformaInvoice = z.object({
  doc_type: z.literal("proforma_invoice"),
  seller: Party,
  buyer: Party,
  invoice_number: str,
  invoice_date: str, // ISO yyyy-mm-dd
  valid_until: str,
  currency: str, // ISO 4217
  incoterm: str, // FOB, CFR, CIF, ...
  country_of_origin: str,
  country_of_supply: str,
  port_of_loading: str,
  port_of_discharge: str,
  mode_of_transport: str,
  payment_terms: str,
  lines: z.array(InvoiceLine),
  goods_value: num,
  freight: num,
  insurance: num,
  total: num,
});
export type ProformaInvoice = z.infer<typeof ProformaInvoice>;

export const PackingLine = z.object({
  description: str,
  quantity: num,
  unit: str,
  packages: num,
  net_weight_kg: num,
  gross_weight_kg: num,
});
export type PackingLine = z.infer<typeof PackingLine>;

export const PackingList = z.object({
  doc_type: z.literal("packing_list"),
  seller: Party,
  buyer: Party,
  packing_list_number: str,
  date: str,
  proforma_reference: str,
  port_of_discharge: str,
  lines: z.array(PackingLine),
});
export type PackingList = z.infer<typeof PackingList>;

export const InsuranceCertificate = z.object({
  doc_type: z.literal("insurance_certificate"),
  insurer: str,
  certificate_number: str,
  policy_number: str,
  date_of_issue: str,
  insured: str,
  interest: str,
  proforma_reference: str,
  currency: str,
  sum_insured: num,
  voyage_from: str,
  voyage_to: str,
  conveyance: str,
  conditions: str,
});
export type InsuranceCertificate = z.infer<typeof InsuranceCertificate>;

export const Extraction = z.discriminatedUnion("doc_type", [
  ProformaInvoice,
  PackingList,
  InsuranceCertificate,
]);
export type Extraction = z.infer<typeof Extraction>;
export type DocType = Extraction["doc_type"];

export interface DocumentSet {
  proforma_invoice?: ProformaInvoice;
  packing_list?: PackingList;
  insurance_certificate?: InsuranceCertificate;
}

export type Severity = "error" | "warning";

export interface Issue {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Which documents/fields the issue was found in, for highlighting. */
  evidence: { doc: DocType; field: string; value: unknown }[];
  fix: string;
}
