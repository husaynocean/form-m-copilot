import { filesToRemind, markReminded, type TradeFile } from "@/lib/files";
import { mailEnabled, sendMail } from "@/lib/mail";

export const runtime = "nodejs";
export const maxDuration = 60;

// Remind 30, 7 and 1 day(s) before, on the day, and once when overdue.
const STEPS = [30, 7, 1, 0] as const;

function due(f: TradeFile, today: string): string | null {
  const left = Math.round((Date.parse(f.deadline) - Date.parse(today)) / 86_400_000);
  if (left < 0) return f.reminders_sent.includes("overdue") ? null : "overdue";
  // The tightest step that applies: 25 days left -> "30", 5 days left -> "7".
  const step = [...STEPS].reverse().find((s) => left <= s);
  return step === undefined || f.reminders_sent.includes(String(step)) ? null : String(step);
}

/** Daily job (Vercel Cron). Protected by CRON_SECRET. */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!mailEnabled()) return Response.json({ skipped: "email not configured" });
  const today = new Date().toISOString().slice(0, 10);
  const app = process.env.APP_URL ?? "https://trade-copilot-ng.vercel.app";
  let sent = 0, failed = 0;
  for (const f of await filesToRemind(today)) {
    const step = due(f, today);
    if (!step || !f.email) continue;
    const left = Math.round((Date.parse(f.deadline) - Date.parse(today)) / 86_400_000);
    const when = left < 0 ? `was due on ${f.deadline} (${-left} days ago)` : left === 0 ? "is due today" : `is due in ${left} day${left > 1 ? "s" : ""}, on ${f.deadline}`;
    const subject = `${f.deadline_title} ${left < 0 ? "overdue" : left === 0 ? "due today" : `in ${left} days`}: ${f.title}`;
    const lines = [`${f.deadline_title} for ${f.title} ${when}.`, f.basis ?? "", f.reference ? `Reference: ${f.reference}` : "", f.amount != null ? `Amount: ${f.currency ?? ""} ${f.amount.toLocaleString("en-US")}` : "", `Open your tracker: ${app}/tracker`];
    const text = lines.filter(Boolean).join("\n");
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${lines.filter(Boolean).map((l) => `<p>${l.replace(/</g, "&lt;").replace(/(https:\/\/\S+)/, '<a href="$1">$1</a>')}</p>`).join("")}<p style="color:#666;font-size:12px">You asked Trade Copilot to remind you. To stop, remove your email in the tracker.</p></div>`;
    try {
      await sendMail(f.email, subject, html, text);
      await markReminded(f.id, [...f.reminders_sent, step]);
      sent++;
    } catch (e) {
      console.error("reminder", f.id, e);
      failed++;
    }
  }
  return Response.json({ sent, failed });
}
