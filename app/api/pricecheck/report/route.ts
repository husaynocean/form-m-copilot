import { rest } from "@/lib/store";
import { buildReport } from "@/lib/pricecheck/report";
import type { PriceDoc } from "@/lib/pricecheck/extract";
import type { PriceCheckResult } from "@/lib/pricecheck/score";

export const runtime = "nodejs";

/**
 * GET ?id=<check id>&owner=<private key>  ->  PDF report of a saved price check.
 * Built from the stored result, never from data sent by the browser. A check
 * saved under a private key is only available with that key.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const id = u.searchParams.get("id") ?? "";
  const owner = u.searchParams.get("owner");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Invalid report link", { status: 400 });
  try {
    const rows: { id: string; owner: string | null; created_at: string; doc: PriceDoc | null; result: PriceCheckResult | null }[] =
      (await rest(`pc_invoices?id=eq.${id}&select=id,owner,created_at,doc,result`)) ?? [];
    const row = rows[0];
    if (!row || !row.doc || !row.result || (row.owner && row.owner !== owner)) return new Response("Report not found", { status: 404 });
    const pdf = await buildReport({ id: row.id, created_at: row.created_at, doc: row.doc, result: row.result, appUrl: process.env.APP_URL ?? u.origin });
    const name = `pricecheck-${(row.doc.invoice_number ?? row.id.slice(0, 8)).replace(/[^a-z0-9-]+/gi, "-")}.pdf`;
    return new Response(Buffer.from(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${name}"`, "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    console.error("pricecheck report", e);
    return new Response("Could not build the report", { status: 500 });
  }
}
