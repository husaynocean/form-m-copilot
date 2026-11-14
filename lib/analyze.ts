import { validate } from "./validate";
import { buildFormMDraft, type FormMDraft } from "./formm";
import { checkPrintedHsCodes, suggestHs, type HsSuggestion } from "./hs";
import type { DocumentSet, Issue } from "./schema";
import { buildNxpDraft, repatriation, validateExport, type ExportCategory } from "./nxp";
import { formMValidity, type Deadline } from "./deadlines";

/** Shared post-extraction pipeline used by the web app and WhatsApp bot. */
export async function analyze(
  docs: DocumentSet,
  extraIssues: Issue[] = [],
  opts: { mode?: "import" | "export"; category?: ExportCategory } = {},
): Promise<{ issues: Issue[]; hs: (HsSuggestion & { line: number })[]; draft: FormMDraft; deadline: Deadline | null }> {
  const exp = opts.mode === "export";
  const issues: Issue[] = [...(exp ? validateExport(docs, opts.category ?? "non-oil") : validate(docs)), ...checkPrintedHsCodes(docs), ...extraIssues];
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
  const deadline = exp
    ? repatriation(docs, opts.category ?? "non-oil", new Date())
    : pi ? formMValidity({ category: "general", reference: pi.invoice_number, amount: pi.total, currency: pi.currency }) : null;
  return { issues, hs, draft: exp ? buildNxpDraft(docs) : buildFormMDraft(docs), deadline };
}
