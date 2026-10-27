/**
 * Minimal server-side store for WhatsApp sessions (Supabase PostgREST).
 * Uses the project's secret key; tables have RLS with no public policies.
 */
import type { Extraction } from "./schema";

function cfg() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY not set");
  return { url: url.replace(/\/$/, ""), key };
}

async function rest(path: string, init: RequestInit = {}) {
  const { url, key } = cfg();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`store ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const rpc = (fn: string, args: Record<string, unknown>) =>
  process.env.WA_STORE === "memory" ? memRpc(fn, args) : rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

// In-memory store for local tests only (WA_STORE=memory). Mirrors the SQL functions.
const mem = { sessions: new Map<string, { lang: string; docs: Record<string, unknown>; reported: boolean }>(), seen: new Set<string>() };
function memSession(phone: string) {
  if (!mem.sessions.has(phone)) mem.sessions.set(phone, { lang: "en", docs: {}, reported: false });
  return mem.sessions.get(phone)!;
}
async function memRpc(fn: string, a: Record<string, unknown>): Promise<unknown> {
  if (fn === "wa_first_seen") { const id = a.p_id as string; if (mem.seen.has(id)) return false; mem.seen.add(id); return true; }
  const s = memSession(a.p_phone as string);
  if (fn === "wa_merge_doc") {
    s.docs = s.reported ? { [a.p_type as string]: a.p_doc } : { ...s.docs, [a.p_type as string]: a.p_doc };
    s.reported = false;
    return Object.keys(s.docs);
  }
  if (fn === "wa_claim_report") {
    if (s.reported || Object.keys(s.docs).length < (a.p_min_docs as number)) return null;
    s.reported = true;
    return s.docs;
  }
  throw new Error(`unknown rpc ${fn}`);
}

export interface Session { phone: string; lang: string; docs: Record<string, Extraction>; reported: boolean }

/** True the first time a WhatsApp message id is seen (webhooks can be redelivered). */
export const firstSeen = async (id: string): Promise<boolean> => Boolean(await rpc("wa_first_seen", { p_id: id }));

/** Store one extracted document; returns the document types now held for this user. */
export const mergeDoc = async (phone: string, doc: Extraction): Promise<string[]> =>
  (await rpc("wa_merge_doc", { p_phone: phone, p_type: doc.doc_type, p_doc: doc })) ?? [];

/** Atomically claim the report; returns the documents if this caller won, else null. */
export const claimReport = async (phone: string, minDocs: number): Promise<Record<string, Extraction> | null> =>
  rpc("wa_claim_report", { p_phone: phone, p_min_docs: minDocs });

export async function getSession(phone: string): Promise<Session | null> {
  if (process.env.WA_STORE === "memory") { const s = mem.sessions.get(phone); return s ? ({ phone, ...s } as Session) : null; }
  const rows = await rest(`wa_sessions?phone=eq.${encodeURIComponent(phone)}&select=*`);
  return rows?.[0] ?? null;
}

export async function setLang(phone: string, lang: string) {
  if (process.env.WA_STORE === "memory") { memSession(phone).lang = lang; return; }
  await rest("wa_sessions?on_conflict=phone", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ phone, lang, updated_at: new Date().toISOString() }),
  });
}

export async function resetSession(phone: string) {
  if (process.env.WA_STORE === "memory") { const s = memSession(phone); s.docs = {}; s.reported = false; return; }
  await rest(`wa_sessions?phone=eq.${encodeURIComponent(phone)}`, {
    method: "PATCH",
    body: JSON.stringify({ docs: {}, reported: false, updated_at: new Date().toISOString() }),
  });
}

/** Record a webhook delivery (metadata only) to debug Meta configuration. */
export async function logEvent(e: { sig_ok: boolean; has_sig: boolean; fields?: string; n_messages?: number; n_statuses?: number; note?: string }) {
  if (process.env.WA_STORE === "memory") return;
  await rest("wa_events", { method: "POST", body: JSON.stringify(e) }).catch(() => undefined);
}

/** Remove everything held for a phone number. */
export async function deleteUser(phone: string) {
  if (process.env.WA_STORE === "memory") { mem.sessions.delete(phone); return; }
  await rest(`wa_sessions?phone=eq.${encodeURIComponent(phone)}`, { method: "DELETE" });
}
