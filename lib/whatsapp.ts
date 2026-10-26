/**
 * WhatsApp Cloud API helpers (Meta Graph API).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = () => process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0";
// Overridable for local tests against a fake Graph API.
const BASE = () => process.env.WHATSAPP_GRAPH_BASE ?? "https://graph.facebook.com";
const token = () => {
  const t = process.env.WHATSAPP_TOKEN;
  if (!t) throw new Error("WHATSAPP_TOKEN not set");
  return t;
};

/** Verify Meta's X-Hub-Signature-256 header against the raw request body. */
export function validSignature(raw: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const a = Buffer.from(header.slice(7), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function graph(path: string, body: unknown) {
  const res = await fetch(`${BASE()}/${VERSION()}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`whatsapp ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const phoneId = () => {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!id) throw new Error("WHATSAPP_PHONE_NUMBER_ID not set");
  return id;
};

/** Send text, splitting at WhatsApp's 4096-character limit on paragraph boundaries. */
export async function sendText(to: string, text: string) {
  const chunks: string[] = [];
  let cur = "";
  for (const para of text.split("\n\n")) {
    if ((cur + "\n\n" + para).length > 3900 && cur) {
      chunks.push(cur);
      cur = para;
    } else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) chunks.push(cur);
  for (const body of chunks) {
    await graph(`${phoneId()}/messages`, { messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } });
  }
}

/** Interactive list (max 10 rows). */
export async function sendList(to: string, body: string, button: string, rows: { id: string; title: string; description?: string }[]) {
  await graph(`${phoneId()}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: { button, sections: [{ title: "Languages", rows: rows.slice(0, 10) }] },
    },
  });
}

/** Mark a message as read and show the typing indicator while we work. */
export async function markRead(messageId: string) {
  await graph(`${phoneId()}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  }).catch(() => undefined); // best effort
}

/** Download a media object as a data URL. */
export async function downloadMedia(mediaId: string): Promise<{ dataUrl: string; mime: string }> {
  const meta = await fetch(`${BASE()}/${VERSION()}/${mediaId}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!meta.ok) throw new Error(`media lookup ${meta.status}`);
  const { url, mime_type } = (await meta.json()) as { url: string; mime_type: string };
  const file = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
  if (!file.ok) throw new Error(`media download ${file.status}`);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024) throw new Error("Image larger than 10 MB");
  return { dataUrl: `data:${mime_type};base64,${buf.toString("base64")}`, mime: mime_type };
}
