import { validate } from "./validate";
import { buildFormMDraft, type FormMDraft } from "./formm";
import { checkPrintedHsCodes, suggestHs, type HsSuggestion } from "./hs";
import type { DocumentSet, Issue } from "./schema";
import { buildNxpDraft, repatriation, validateExport, type ExportCategory } from "./nxp";
import { formMValidity, formQDocuments, type Deadline } from "./deadlines";
import { buildFormQDraft, invoiceTotal, validateFormQ } from "./formq";
import { buildFormADraft, feeDeadline, validateFormA } from "./forma";

/** Shared post-extraction pipeline used by the web app and WhatsApp bot. */
export async function analyze(
  docs: DocumentSet,
  extraIssues: Issue[] = [],
  opts: { mode?: "import" | "export" | "formq" | "forma"; category?: ExportCategory; used?: number } = {},
): Promise<{ issues: Issue[]; hs: (HsSuggestion & { line: number })[]; draft: FormMDraft; deadline: Deadline | null }> {
  const mode = opts.mode ?? "import";
  const rules =
    mode === "export" ? validateExport(docs, opts.category ?? "non-oil")
    : mode === "formq" ? validateFormQ(docs, { usedThisQuarter: opts.used ?? 0 })
    : mode === "forma" ? validateFormA(docs)
    : validate(docs);
  const issues: Issue[] = [...rules, ...(mode === "forma" ? [] : checkPrintedHsCodes(docs)), ...extraIssues];
  const flagged = new Set(
    issues.filter((i) => i.code.startsWith("HS_CODE_")).map((i) => Number(/lines\[(\d+)\]/.exec(i.evidence[0]?.field ?? "")?.[1])),
  );
  const hs: (HsSuggestion & { line: number })[] = [];
  await Promise.all(
    (docs.proforma_invoice?.lines ?? []).map(async (l, i) => {
      if ((l.hs_code && !flagged.has(i)) || !l.description) return;
      try {
        hs.push({ line: i, ...(await suggestHs(l.description)) });
      } catch {
        /* HS suggestion is best-effort */
      }
    }),
  );
  hs.sort((a, b) => a.line - b.line);
  const pi = docs.proforma_invoice;
  const deadline =
    mode === "export" ? repatriation(docs, opts.category ?? "non-oil", new Date())
    : mode === "formq" ? (pi ? formQDocuments({ reference: pi.invoice_number, amount: invoiceTotal(docs), currency: pi.currency }) : null)
    : mode === "forma" ? feeDeadline(docs)
    : pi ? formMValidity({ category: "general", reference: pi.invoice_number, amount: pi.total, currency: pi.currency }) : null;
  const draft =
    mode === "export" ? buildNxpDraft(docs)
    : mode === "formq" ? buildFormQDraft(docs, { usedThisQuarter: opts.used ?? 0 })
    : mode === "forma" ? buildFormADraft(docs)
    : buildFormMDraft(docs);
  return { issues, hs, draft, deadline };
}
