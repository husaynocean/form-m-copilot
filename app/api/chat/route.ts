import { handleMessage, withTransport, type IncomingMessage, type Transport } from "@/lib/bot";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Web preview of the WhatsApp bot. Runs lib/bot.ts unchanged; replies are
 * collected and returned instead of being sent through the WhatsApp Cloud API.
 *
 * POST JSON { session, text? , list_reply? , image? (data URL) }
 */
type Reply = { type: "text"; text: string } | { type: "list"; body: string; button: string; rows: { id: string; title: string }[] };

export async function POST(req: Request) {
  const body = (await req.json()) as { session?: string; text?: string; list_reply?: string; image?: string };
  const session = (body.session ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  if (!session) return Response.json({ error: "missing session" }, { status: 400 });
  if (body.image && (!body.image.startsWith("data:image/") || body.image.length > 14_000_000)) {
    return Response.json({ error: "Send a JPG/PNG under 10 MB." }, { status: 400 });
  }

  const from = `web-${session}`;
  const id = `web-${session}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const m: IncomingMessage = body.image
    ? { id, from, type: "image", image: { id: "inline", mime_type: "image/jpeg" } }
    : body.list_reply
    ? { id, from, type: "interactive", interactive: { type: "list_reply", list_reply: { id: body.list_reply, title: body.list_reply } } }
    : { id, from, type: "text", text: { body: body.text ?? "" } };

  const replies: Reply[] = [];
  const transport: Transport = {
    sendText: async (_to, text) => replies.push({ type: "text", text }),
    sendList: async (_to, b, button, rows) => replies.push({ type: "list", body: b, button, rows }),
    markRead: async () => undefined,
    downloadMedia: async () => ({ dataUrl: body.image! }),
  };
  await withTransport(transport, () => handleMessage(m));
  return Response.json({ replies });
}
