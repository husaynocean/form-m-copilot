"use client";

import { useCallback, useEffect, useState } from "react";
import { clearTrackerKey, getTrackerKey } from "@/lib/tracker-key";
import s from "./tracker.module.css";

interface TradeFile {
  id: string; kind: string; title: string; reference: string | null; party: string | null; amount: number | null; currency: string | null;
  deadline_title: string; basis: string | null; start_label: string | null; start_date: string; days_total: number; deadline: string;
  open_issues: number; email: string | null;
}
const FORM: Record<string, string> = { form_m: "Form M", nxp: "Form NXP", form_q: "Form Q", form_a: "Form A" };
const START: Record<string, string> = { form_m: "Form M approved on", nxp: "Shipped on board", form_q: "Paid to supplier on", form_a: "Bill issued on" };
const today = () => new Date().toISOString().slice(0, 10);
const daysLeft = (d: string) => Math.round((Date.parse(d) - Date.parse(today())) / 86_400_000);
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Tracker() {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [files, setFiles] = useState<TradeFile[]>([]);
  const [mailOn, setMailOn] = useState(false);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (k: string) => {
    const res = await fetch(`/api/files?owner=${encodeURIComponent(k)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not load");
    setFiles(data.files);
    setMailOn(Boolean(data.email_reminders));
    setEmail(data.files.find((f: TradeFile) => f.email)?.email ?? "");
  }, []);

  useEffect(() => {
    const k = getTrackerKey();
    setKey(k);
    if (k) load(k).catch((e) => setMsg((e as Error).message));
  }, [load]);

  async function patch(body: Record<string, unknown>, ok: string) {
    if (!key) return;
    setBusy(true);
    try {
      const res = await fetch("/api/files", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner: key, ...body }) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      await load(key);
      setMsg(ok);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id?: string) {
    if (!key) return;
    if (!id && !confirm("Delete every saved transaction in this tracker?")) return;
    setBusy(true);
    await fetch(`/api/files?owner=${encodeURIComponent(key)}${id ? `&id=${encodeURIComponent(id)}` : ""}`, { method: "DELETE" });
    if (!id) { clearTrackerKey(); setKey(null); setFiles([]); } else await load(key);
    setBusy(false);
  }

  async function copyLink() {
    const link = `${location.origin}/tracker#k=${key}`;
    try { await navigator.clipboard.writeText(link); setMsg("Private link copied. Anyone with it can see this tracker."); } catch { setMsg(link); }
  }

  return (
    <div className="shell">
      <div className="aurora" aria-hidden="true" />
      <header className="nav">
        <a className="brand" href="/" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="seal" aria-hidden="true">T</span>
          <span>Trade <b>Copilot</b></span>
        </a>
        <a className="pill" href="/">← Check documents</a>
      </header>
      <main className={s.main}>
        <p className="eyebrow">Deadline tracker</p>
        <h1 className={s.h1}>Every deadline, <span className="grad">in one place.</span></h1>

        {key === undefined ? null : !key ? (
          <p className="lead">Nothing saved yet. Check a set of documents, then tap <b>Save &amp; track</b> under the deadline.</p>
        ) : (
          <>
            <section className={`panel ${s.bar}`}>
              <label className={s.email}>
                <span className="dim small">Email reminders 30, 7 and 1 day before each deadline</span>
                <span className={s.row}>
                  <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
                  <button className="ghost" disabled={busy} onClick={() => patch({ email: email.trim() || null }, email.trim() ? "Reminders will go to this email." : "Email removed.")}>
                    {email.trim() ? "Save" : "Remove"}
                  </button>
                </span>
                {!mailOn && <span className="dim small">Email sending is being set up. Until then, use <b>Add to calendar</b> on each item: your phone will remind you.</span>}
              </label>
              <div className={s.row}>
                <button className="ghost" onClick={copyLink}>Copy private link</button>
                <button className="ghost" onClick={() => remove()} disabled={busy}>Delete everything</button>
              </div>
            </section>

            {files.length === 0 && <p className="lead">No saved transactions.</p>}
            <div className={s.list}>
              {files.map((f) => {
                const left = daysLeft(f.deadline);
                const st = left < 0 ? "overdue" : left <= 30 ? "due_soon" : "ok";
                return (
                  <article key={f.id} className={`tracker ${st}`}>
                    <div className="section-head">
                      <h2>{f.title}</h2>
                      <span className="dim small">{FORM[f.kind]}{f.reference ? ` · ${f.reference}` : ""}{f.open_issues ? ` · ${f.open_issues} open issue${f.open_issues > 1 ? "s" : ""}` : ""}</span>
                    </div>
                    <div className="tracker-main">
                      <b className="mono">{left < 0 ? `${-left} days overdue` : left === 0 ? "Due today" : `${left} days left`}</b>
                      <span>{f.deadline_title}{f.amount != null ? ` · ${f.currency ?? ""} ${money(f.amount)}` : ""} · due <b className="mono">{f.deadline}</b></span>
                    </div>
                    <div className="bar" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, Math.max(0, ((f.days_total - left) / f.days_total) * 100))}%` }} />
                    </div>
                    {f.basis && <p className="dim small tracker-action">{f.basis}</p>}
                    <div className={s.actions}>
                      <label className={s.date}>
                        <span className="dim small">{START[f.kind]}</span>
                        <input type="date" value={f.start_date} disabled={busy} onChange={(e) => e.target.value && patch({ id: f.id, start_date: e.target.value }, "Date updated.")} />
                      </label>
                      <a className="ghost" href={`/api/files/ics?owner=${encodeURIComponent(key)}&id=${encodeURIComponent(f.id)}`}>Add to calendar</a>
                      <button className="ghost" disabled={busy} onClick={() => remove(f.id)}>Delete</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
        {msg && <p className="fine">{msg}</p>}
        <p className="fine">Only a summary is saved (names, amounts, dates), never your document photos. Anyone with your private link can see this tracker.</p>
      </main>
    </div>
  );
}
