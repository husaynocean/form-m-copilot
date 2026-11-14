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

/** Export side (Form NXP): the shipping document that starts the repatriation clock. */
export const BillOfLading = z.object({
  doc_type: z.literal("bill_of_lading"),
  bl_number: str,
  shipper: str,
  consignee: str,
  notify_party: str,
  vessel: str,
  port_of_loading: str,
  port_of_discharge: str,
  shipped_on_board_date: str, // ISO yyyy-mm-dd
  nxp_number: str.optional().default(null),
  description: str,
  packages: num,
  gross_weight_kg: num,
  freight_terms: str,
});
export type BillOfLading = z.infer<typeof BillOfLading>;

/** NEPC exporter registration certificate. */
export const NepcCertificate = z.object({
  doc_type: z.literal("nepc_certificate"),
  exporter_name: str,
  certificate_number: str,
  rc_number: str,
  issue_date: str,
  expiry_date: str,
});
export type NepcCertificate = z.infer<typeof NepcCertificate>;

/** Clean Certificate of Inspection, issued by the pre-shipment inspection agent. */
export const CleanCertificateOfInspection = z.object({
  doc_type: z.literal("clean_certificate_of_inspection"),
  cci_number: str,
  date: str,
  nxp_number: str,
  inspection_agent: str,
  exporter: str,
  consignee: str,
  description: str,
  hs_code: str,
  quantity: num,
  unit: str,
  net_weight_kg: num,
  gross_weight_kg: num,
  currency: str,
  fob_value: num,
});
export type CleanCertificateOfInspection = z.infer<typeof CleanCertificateOfInspection>;

/** Certificate of origin (NACCIMA / NEPC / chamber of commerce). */
export const CertificateOfOrigin = z.object({
  doc_type: z.literal("certificate_of_origin"),
  certificate_number: str,
  date: str,
  issuing_body: str,
  exporter: str,
  consignee: str,
  country_of_origin: str,
  description: str,
  packages: num,
  gross_weight_kg: num,
});
export type CertificateOfOrigin = z.infer<typeof CertificateOfOrigin>;

/** Form A: a school bill or a hospital cost estimate. */
export const FeeInvoice = z.object({
  doc_type: z.literal("fee_invoice"),
  institution: str,
  institution_country: str,
  person_name: str, // student or patient
  purpose: str, // tuition | medical | other
  reference: str, // student ID / invoice number
  period: str, // semester, session or treatment period as printed
  issue_date: str,
  due_date: str,
  currency: str,
  amount: num,
  beneficiary_bank: str,
  beneficiary_account: str,
});
export type FeeInvoice = z.infer<typeof FeeInvoice>;

/** Form A: admission letter (tuition) or overseas doctor's letter (medical). */
export const SupportLetter = z.object({
  doc_type: z.literal("support_letter"),
  kind: str, // admission | medical
  institution: str,
  person_name: str,
  programme: str, // course, or the treatment
  start_date: str,
  date: str,
});
export type SupportLetter = z.infer<typeof SupportLetter>;

export const Extraction = z.discriminatedUnion("doc_type", [
  ProformaInvoice,
  PackingList,
  InsuranceCertificate,
  BillOfLading,
  NepcCertificate,
  CleanCertificateOfInspection,
  CertificateOfOrigin,
  FeeInvoice,
  SupportLetter,
]);
export type Extraction = z.infer<typeof Extraction>;
export type DocType = Extraction["doc_type"];

export interface DocumentSet {
  proforma_invoice?: ProformaInvoice;
  packing_list?: PackingList;
  insurance_certificate?: InsuranceCertificate;
  bill_of_lading?: BillOfLading;
  nepc_certificate?: NepcCertificate;
  clean_certificate_of_inspection?: CleanCertificateOfInspection;
  certificate_of_origin?: CertificateOfOrigin;
  fee_invoice?: FeeInvoice;
  support_letter?: SupportLetter;
}

/** info = a note for the officer, not a problem with the documents. */
export type Severity = "error" | "warning" | "info";

export interface Issue {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Which documents/fields the issue was found in, for highlighting. */
  evidence: { doc: DocType; field: string; value: unknown }[];
  fix: string;
}
