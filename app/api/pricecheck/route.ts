import { extractPriceDoc, fromDocumentSet, type PriceDoc } from "@/lib/pricecheck/extract";
import { runPriceCheck } from "@/lib/pricecheck/run";
import { isQuotaError } from "@/lib/llm";
import { validOwner } from "@/lib/files";
import type { DocumentSet } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_PAGES = 3;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * PriceCheck.
 *  - multipart/form-data: `files` = 1–3 photos of one invoice or Form M (pages in order), optional `owner`
 *  - application/json:    { docs: <a Form M check's documents>, owner? }  -> no re-upload
 * Returns { id, doc, result, ms }.
 */
export async function POST(req: Request) {
  const started = Date.now();
  try {
    let doc: PriceDoc | null = null;
    let owner: string | null = null;
    let source: "upload" | "form_m_check" = "upload";
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const body = (await req.json()) as { docs?: DocumentSet; owner?: string };
      owner = validOwner(body.owner) ? body.owner : null;
      doc = body.docs ? fromDocumentSet(body.docs) : null;
      source = "form_m_check";
      if (!doc) return Response.json({ error: "No invoice found in that check to price." }, { status: 400 });
    } else {
      const form = await req.formData();
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      const o = form.get("owner");
      owner = validOwner(o) ? o : null;
      const bad =
        files.length === 0 ? "Upload a photo of the invoice or Form M." :
        files.length > MAX_PAGES ? `Upload at most ${MAX_PAGES} pages of one document.` :
        files.find((f) => !IMAGE_TYPES.includes(f.type)) ? "Use JPG, PNG or WEBP images." :
        files.find((f) => f.size > 10 * 1024 * 1024) ? "Each image must be under 10 MB." : null;
      if (bad) return Response.json({ error: bad }, { status: 400 });
      const pages = await Promise.all(
        files.map(async (f) => (await extractPriceDoc(`data:${f.type};base64,${Buffer.from(await f.arrayBuffer()).toString("base64")}`)).doc),
      );
      // Pages of one document: header from the first page that has one, lines from all pages in order.
      const head = pages.find((p) => p.supplier || p.invoice_number) ?? pages[0];
      doc = { ...head, total: pages.map((p) => p.total).filter((t) => t != null).pop() ?? head.total, lines: pages.flatMap((p) => p.lines) };
    }
    if (!doc.lines.length) return Response.json({ error: "No goods lines were found on this document." }, { status: 422 });
    const out = await runPriceCheck(doc, { owner, source });
    if (out.errors.length) console.error("pricecheck", out.errors.slice(0, 5));
    return Response.json({ id: out.id, doc: out.doc, result: out.result, ms: Date.now() - started });
  } catch (e) {
    console.error("pricecheck", e);
    return Response.json(
      { error: isQuotaError(e) ? "The free AI allowance for today is used up, so the document couldn't be read. Please try again tomorrow." : "Something went wrong checking this document. Please try again." },
      { status: isQuotaError(e) ? 429 : 500 },
    );
  }
}
