/**
 * One-off setup check (protected by the webhook verify token):
 *  - which WhatsApp Business Accounts the token can manage
 *  - whether each one is subscribed to this app (required for webhooks)
 *  - subscribes it if not
 * GET /api/whatsapp/setup?key=<WHATSAPP_VERIFY_TOKEN>[&fix=1]
 */
export const runtime = "nodejs";

const G = "https://graph.facebook.com/v23.0";

export async function GET(req: Request) {
  const u = new URL(req.url);
  if (!process.env.WHATSAPP_VERIFY_TOKEN || u.searchParams.get("key") !== process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }
  const token = process.env.WHATSAPP_TOKEN ?? "";
  const auth = { Authorization: `Bearer ${token}` };
  const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

  const dbg = await j(await fetch(`${G}/debug_token?input_token=${encodeURIComponent(token)}`, { headers: auth }));
  const data = (dbg.body as { data?: { is_valid?: boolean; expires_at?: number; scopes?: string[]; granular_scopes?: { scope: string; target_ids?: string[] }[] } })?.data;
  const wabaIds = [...new Set((data?.granular_scopes ?? []).filter((s) => s.scope.startsWith("whatsapp")).flatMap((s) => s.target_ids ?? []))];

  const phone = await j(await fetch(`${G}/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,platform_type,status`, { headers: auth }));

  const wabas = [];
  for (const id of wabaIds) {
    const before = await j(await fetch(`${G}/${id}/subscribed_apps`, { headers: auth }));
    let subscribe = null;
    if (u.searchParams.get("fix") === "1") subscribe = await j(await fetch(`${G}/${id}/subscribed_apps`, { method: "POST", headers: auth }));
    const phones = await j(await fetch(`${G}/${id}/phone_numbers?fields=id,display_phone_number`, { headers: auth }));
    wabas.push({ id, subscribed_apps: before, subscribe, phones });
  }

  return Response.json({
    token: { valid: data?.is_valid, expires_at: data?.expires_at, scopes: data?.scopes, debug_status: dbg.status, error: (dbg.body as { error?: unknown })?.error },
    phone,
    wabas,
  });
}
