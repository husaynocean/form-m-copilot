import { NextResponse } from "next/server";
import { extractDocument } from "@/lib/extract";
import { validate } from "@/lib/validate";
import { buildFormMDraft } from "@/lib/formm";
import { checkPrintedHsCodes, suggestHs, type HsSuggestion } from "@/lib/hs";
import type { DocumentSet, Extraction } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILES = 6;
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * POST multipart/form-data with one or more `files` (photos of documents).
 * Pipeline: extract each page in parallel -> merge into a DocumentSet ->
 * deterministic validation -> Form M draft.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "Upload at least one document photo." }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Upload at most ${MAX_FILES} files.` }, { status: 400 });
  for (const f of files) {
    if (!IMAGE_TYPES.includes(f.type)) return NextResponse.json({ error: `${f.name}: use JPG, PNG or WEBP.` }, { status: 400 });
    if (f.size > MAX_BYTES) return NextResponse.json({ error: `${f.name}: larger than 10 MB.` }, { status: 400 });
  }

  const started = Date.now();
  const results = await Promise.allSettled(
    files.map(async (f) => {
      const b64 = Buffer.from(await f.arrayBuffer()).toString("base64");
      const r = await extractDocument(`data:${f.type};base64,${b64}`);
      return { file: f.name, ...r };
    }),
  );

  const docs: DocumentSet = {};
  const trace: { file: string; status: string; doc_type?: string; model?: string; ms?: number; repaired?: boolean; error?: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const e: Extraction = r.value.extraction;
      // First document of each type wins; duplicates are reported in the trace.
      const dup = Boolean(docs[e.doc_type]);
      if (!dup) (docs as Record<string, Extraction>)[e.doc_type] = e;
      trace.push({ file: r.value.file, status: dup ? "duplicate" : "ok", doc_type: e.doc_type, model: r.value.model, ms: r.value.ms, repaired: r.value.repaired });
    } else {
      trace.push({ file: files[i].name, status: "failed", error: String((r.reason as Error)?.message ?? r.reason).slice(0, 200) });
    }
  });

  if (Object.keys(docs).length === 0) {
    return NextResponse.json({ error: "Could not read any of the documents.", trace }, { status: 502 });
  }

  const issues = [...validate(docs), ...checkPrintedHsCodes(docs)];
  const draft = buildFormMDraft(docs);

  // HS assistant: suggest codes for lines with no code or a flagged code.
  const flagged = new Set(
    issues.filter((i) => i.code.startsWith("HS_CODE_")).map((i) => Number(/lines\[(\d+)\]/.exec(i.evidence[0]?.field ?? "")?.[1])),
  );
  const lines = docs.proforma_invoice?.lines ?? [];
  const hs: (HsSuggestion & { line: number })[] = [];
  await Promise.all(
    lines.map(async (l, i) => {
      if ((l.hs_code && !flagged.has(i)) || !l.description) return;
      try {
        hs.push({ line: i, ...(await suggestHs(l.description)) });
      } catch (e) {
        trace.push({ file: `hs line ${i + 1}`, status: "failed", error: String((e as Error).message).slice(0, 200) });
      }
    }),
  );
  hs.sort((a, b) => a.line - b.line);

  return NextResponse.json({ docs, issues, draft, hs, trace, ms: Date.now() - started });
}
