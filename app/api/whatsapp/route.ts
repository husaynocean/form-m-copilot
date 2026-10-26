import { after } from "next/server";
import { handleMessage, type IncomingMessage } from "@/lib/bot";
import { firstSeen } from "@/lib/store";
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
  if (!validSignature(raw, req.headers.get("x-hub-signature-256"))) {
    return new Response("Invalid signature", { status: 401 });
  }
  let body: { entry?: { changes?: { value?: { messages?: IncomingMessage[] } }[] }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const messages = (body.entry ?? []).flatMap((e) => (e.changes ?? []).flatMap((c) => c.value?.messages ?? []));

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
