import { validate } from "./validate";
import { buildFormMDraft, type FormMDraft } from "./formm";
import { checkPrintedHsCodes, suggestHs, type HsSuggestion } from "./hs";
import type { DocumentSet, Issue } from "./schema";

/** Shared post-extraction pipeline used by the web app and WhatsApp bot. */
export async function analyze(docs: DocumentSet, extraIssues: Issue[] = []): Promise<{ issues: Issue[]; hs: (HsSuggestion & { line: number })[]; draft: FormMDraft }> {
  const issues: Issue[] = [...validate(docs), ...checkPrintedHsCodes(docs), ...extraIssues];
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
  return { issues, hs, draft: buildFormMDraft(docs) };
}
