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
 * POST multipart/form-data with `files` (document photos).
 * Streams NDJSON progress events so the UI can show the agent working live:
 *   {type:"start", files}
 *   {type:"doc", index, file, status, doc_type?, model?, ms?, repaired?, error?}   (as each page finishes)
 *   {type:"stage", stage:"validate"|"hs"|"draft"}
 *   {type:"issues", issues}
 *   {type:"hs", hs}
 *   {type:"done", result}
 *   {type:"error", error}
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  const bad =
    files.length === 0 ? "Upload at least one document photo." :
    files.length > MAX_FILES ? `Upload at most ${MAX_FILES} files.` :
    files.find((f) => !IMAGE_TYPES.includes(f.type)) ? "Use JPG, PNG or WEBP images." :
    files.find((f) => f.size > MAX_BYTES) ? "Each image must be under 10 MB." : null;
  if (bad) return Response.json({ error: bad }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      const started = Date.now();
      try {
        send({ type: "start", files: files.map((f) => f.name) });

        const docs: DocumentSet = {};
        const trace: Record<string, unknown>[] = [];
        await Promise.all(
          files.map(async (f, index) => {
            try {
              const b64 = Buffer.from(await f.arrayBuffer()).toString("base64");
              const r = await extractDocument(`data:${f.type};base64,${b64}`);
              const e: Extraction = r.extraction;
              const dup = Boolean(docs[e.doc_type]);
              if (!dup) (docs as Record<string, Extraction>)[e.doc_type] = e;
              const ev = { index, file: f.name, status: dup ? "duplicate" : "ok", doc_type: e.doc_type, model: r.model, ms: r.ms, repaired: r.repaired };
              trace.push(ev);
              send({ type: "doc", ...ev });
            } catch (err) {
              const ev = { index, file: f.name, status: "failed", error: String((err as Error)?.message ?? err).slice(0, 200) };
              trace.push(ev);
              send({ type: "doc", ...ev });
            }
          }),
        );

        if (Object.keys(docs).length === 0) {
          send({ type: "error", error: "Could not read any of the documents." });
          return controller.close();
        }

        send({ type: "stage", stage: "validate" });
        const issues = [...validate(docs), ...checkPrintedHsCodes(docs)];
        send({ type: "issues", issues });

        send({ type: "stage", stage: "hs" });
        const flagged = new Set(
          issues.filter((i) => i.code.startsWith("HS_CODE_")).map((i) => Number(/lines\[(\d+)\]/.exec(i.evidence[0]?.field ?? "")?.[1])),
        );
        const hs: (HsSuggestion & { line: number })[] = [];
        await Promise.all(
          (docs.proforma_invoice?.lines ?? []).map(async (l, i) => {
            if ((l.hs_code && !flagged.has(i)) || !l.description) return;
            try {
              hs.push({ line: i, ...(await suggestHs(l.description)) });
            } catch (e) {
              trace.push({ file: `hs line ${i + 1}`, status: "failed", error: String((e as Error).message).slice(0, 200) });
            }
          }),
        );
        hs.sort((a, b) => a.line - b.line);
        send({ type: "hs", hs });

        send({ type: "stage", stage: "draft" });
        const draft = buildFormMDraft(docs);
        send({ type: "done", result: { docs, issues, draft, hs, trace, ms: Date.now() - started } });
      } catch (err) {
        send({ type: "error", error: String((err as Error)?.message ?? err).slice(0, 300) });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
