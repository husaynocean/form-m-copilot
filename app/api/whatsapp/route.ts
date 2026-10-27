import { after } from "next/server";
import { handleMessage, type IncomingMessage } from "@/lib/bot";
import { firstSeen, logEvent } from "@/lib/store";
import { validSignature } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Webhook verification handshake from Meta. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ok =
    u.searchParams.get("hub.mode") === "subscribe" &&
    process.env.WHATSAPP_VERIFY_TOKEN &&
    u.searchParams.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok ? new Response(u.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("Forbidden", { status: 403 });
}

/**
 * Incoming messages. We verify Meta's signature, acknowledge with 200 straight
 * away (Meta retries slow webhooks), and do the work after the response.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const sigHeader = req.headers.get("x-hub-signature-256");
  const sigOk = validSignature(raw, sigHeader);
  let body: { entry?: { changes?: { field?: string; value?: { messages?: IncomingMessage[]; statuses?: unknown[] } }[] }[] } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* logged below */
  }
  const changes = (body.entry ?? []).flatMap((e) => e.changes ?? []);
  const messages = changes.flatMap((c) => c.value?.messages ?? []);
  await logEvent({
    sig_ok: sigOk,
    has_sig: Boolean(sigHeader),
    fields: [...new Set(changes.map((c) => c.field ?? "?"))].join(","),
    n_messages: messages.length,
    n_statuses: changes.reduce((n, c) => n + (c.value?.statuses?.length ?? 0), 0),
  });
  if (!sigOk) return new Response("Invalid signature", { status: 401 });

  after(async () => {
    // Photos sent together are processed in parallel; the store merges them atomically.
    await Promise.all(
      messages.map(async (m) => {
        try {
          if (!(await firstSeen(m.id))) return; // duplicate delivery
        } catch (e) {
          console.error("dedupe failed", e);
        }
        await handleMessage(m);
      }),
    );
  });
  return new Response("OK", { status: 200 });
}
