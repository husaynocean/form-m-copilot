/**
 * Saved transactions for the deadline tracker (Supabase table trade_files).
 * Access is by an unguessable owner key; only summaries are stored, never the
 * document images.
 */
import { randomBytes } from "node:crypto";
import { rest } from "./store";

export type FileKind = "form_m" | "nxp" | "form_q" | "form_a";
export interface TradeFile {
  id: string;
  owner: string;
  kind: FileKind;
  title: string;
  reference: string | null;
  party: string | null;
  amount: number | null;
  currency: string | null;
  deadline_kind: string;
  deadline_title: string;
  basis: string | null;
  start_label: string | null;
  start_date: string;
  days_total: number;
  deadline: string;
  open_issues: number;
  email: string | null;
  reminders_sent: string[];
  created_at: string;
}

export const newOwnerKey = () => randomBytes(18).toString("base64url"); // 24 chars
export const validOwner = (k: unknown): k is string => typeof k === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(k);
export const validDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
export const validEmail = (e: unknown): e is string => typeof e === "string" && e.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const clip = (v: unknown, n = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

export async function listFiles(owner: string): Promise<TradeFile[]> {
  return (await rest(`trade_files?owner=eq.${encodeURIComponent(owner)}&select=*&order=deadline.asc`)) ?? [];
}

export async function createFile(owner: string, f: Record<string, unknown>): Promise<TradeFile> {
  const kinds: FileKind[] = ["form_m", "nxp", "form_q", "form_a"];
  if (!kinds.includes(f.kind as FileKind)) throw new Error("bad kind");
  if (!validDate(f.start_date)) throw new Error("bad start date");
  const days = Number(f.days_total);
  if (!Number.isInteger(days) || days < 1 || days > 800) throw new Error("bad days");
  const row = {
    owner,
    kind: f.kind,
    title: clip(f.title, 120) ?? "Transaction",
    reference: clip(f.reference, 80),
    party: clip(f.party, 120),
    amount: typeof f.amount === "number" && Number.isFinite(f.amount) ? f.amount : null,
    currency: clip(f.currency, 8),
    deadline_kind: clip(f.deadline_kind, 40) ?? "deadline",
    deadline_title: clip(f.deadline_title, 80) ?? "Deadline",
    basis: clip(f.basis, 300),
    start_label: clip(f.start_label, 40),
    start_date: f.start_date,
    days_total: days,
    open_issues: Math.max(0, Math.min(99, Number(f.open_issues) || 0)),
    email: validEmail(f.email) ? f.email : null,
  };
  const out = await rest("trade_files?select=*", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  return out[0];
}

export async function updateFile(owner: string, id: string, patch: { start_date?: unknown; email?: unknown }) {
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.start_date !== undefined) {
    if (!validDate(patch.start_date)) throw new Error("bad start date");
    body.start_date = patch.start_date;
    body.start_label = "Started";
    body.reminders_sent = [];
  }
  if (patch.email !== undefined) body.email = validEmail(patch.email) ? patch.email : null;
  await rest(`trade_files?owner=eq.${encodeURIComponent(owner)}&id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
}

/** Set (or clear) the reminder email on every file of this owner. */
export async function setOwnerEmail(owner: string, email: unknown) {
  await rest(`trade_files?owner=eq.${encodeURIComponent(owner)}`, {
    method: "PATCH",
    body: JSON.stringify({ email: validEmail(email) ? email : null, updated_at: new Date().toISOString() }),
  });
}

export async function deleteFile(owner: string, id: string) {
  await rest(`trade_files?owner=eq.${encodeURIComponent(owner)}&id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function deleteOwner(owner: string) {
  await rest(`trade_files?owner=eq.${encodeURIComponent(owner)}`, { method: "DELETE" });
}

/** Files with an email whose deadline is within the next 31 days or already passed. */
export async function filesToRemind(today: string): Promise<TradeFile[]> {
  const until = new Date(Date.parse(today) + 31 * 86_400_000).toISOString().slice(0, 10);
  return (await rest(`trade_files?email=not.is.null&deadline=lte.${until}&select=*&order=deadline.asc&limit=500`)) ?? [];
}

export async function markReminded(id: string, sent: string[]) {
  await rest(`trade_files?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ reminders_sent: sent }) });
}

/** iCalendar file with alarms 30, 7 and 1 day(s) before the deadline. */
export function toIcs(f: TradeFile, appUrl: string): string {
  const d = f.deadline.replace(/-/g, "");
  const next = new Date(Date.parse(f.deadline) + 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
  const esc = (s: string) => s.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  const summary = esc(`${f.deadline_title}: ${f.title}`);
  const desc = esc([f.basis, f.reference && `Ref: ${f.reference}`, f.amount != null && `${f.currency ?? ""} ${f.amount.toLocaleString("en-US")}`, `Tracker: ${appUrl}/tracker`].filter(Boolean).join("\n"));
  const alarm = (days: number) => ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${summary}`, `TRIGGER:-P${days}D`, "END:VALARM"];
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Trade Copilot//Tracker//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${f.id}@trade-copilot`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${summary}`, `DESCRIPTION:${desc}`,
    ...alarm(30), ...alarm(7), ...alarm(1),
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}
