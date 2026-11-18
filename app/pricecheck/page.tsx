"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { LANGUAGES, type Lang } from "@/lib/languages";
import type { Phase, SheetState } from "@/components/DocScene";
import { resizeImage } from "@/lib/resize";
import { getTrackerKey, setTrackerKey } from "@/lib/tracker-key";
import type { PriceCheckResult, Flag, LineResult } from "@/lib/pricecheck/score";
import type { PriceDoc } from "@/lib/pricecheck/extract";
import s from "./pricecheck.module.css";

const DocScene = dynamic(() => import("@/components/DocScene"), { ssr: false, loading: () => <div className="scene" /> });
const QUICK: Lang[] = ["en", "ha", "yo", "ig", "pcm"];
// Flag severities in the shape the fix-list translator expects.
const AS_ISSUE: Record<Flag["severity"], "error" | "warning" | "info"> = { high: "error", medium: "warning", low: "warning", info: "info" };

const TABS = [
  { href: "/?mode=import", label: "Form M · imports" },
  { href: "/?mode=export", label: "Form NXP · exports" },
  { href: "/?mode=formq", label: "Form Q · small imports" },
  { href: "/?mode=forma", label: "Form A · school & medical" },
];
const DEMOS = [
  { id: "pricecheck_problem", label: "Try a mispriced invoice" },
  { id: "pricecheck_clean", label: "Try a fairly priced invoice" },
];
const SEV: Record<Flag["severity"], { cls: string; label: string }> = {
  high: { cls: "issue", label: "High" },
  medium: { cls: "issue warning", label: "Medium" },
  low: { cls: "issue warning", label: "Low" },
  info: { cls: "issue info", label: "Note" },
};
const STEPS = ["Reading the document", "Looking up UN Comtrade prices", "Scoring"];

interface Response { id: string | null; doc: PriceDoc; result: PriceCheckResult; ms: number }

const money = (n: number) => {
  const d = n >= 100 ? 0 : n >= 1 ? 2 : 3;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};

function ownerKeyIfAny(): string | null {
  try { return getTrackerKey(); } catch { return null; }
}

/** Private key that ties price checks to this browser (same key as the deadline tracker). */
function ownerKey(): string {
  const k = getTrackerKey();
  if (k) return k;
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const fresh = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  setTrackerKey(fresh);
  return fresh;
}

function PriceBar({ l }: { l: LineResult }) {
  if (!l.band || l.price_usd == null) return null;
  const { low, median, high } = l.band;
  // Scale so the band and the invoice price both fit with some margin.
  const max = Math.max(high, l.price_usd) * 1.15;
  const min = Math.min(low, l.price_usd) * 0.85;
  const pos = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  const unit = l.basis === "kg" ? "kg" : "item";
  return (
    <>
      <div className={s.track} aria-hidden="true">
        <span className={s.band} style={{ left: pos(low), width: `calc(${pos(high)} - ${pos(low)})` }} />
        <span className={s.median} style={{ left: pos(median) }} />
        <span className={`${s.marker} ${s[l.position]}`} style={{ left: pos(l.price_usd) }}>{money(l.price_usd)}</span>
      </div>
      <div className={s.legend}>
        <span>Normal range {money(low)}–{money(high)} per {unit} · typical {money(median)}</span>
        <span>{l.band.points} yrs of data · {l.band.confidence} confidence</span>
      </div>
    </>
  );
}

export default function PriceCheck() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [fromCheck, setFromCheck] = useState<unknown | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<Response | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lang, setLang] = useState<Lang>("en");
  const [translated, setTranslated] = useState<{ title: string; body: string; verified: boolean }[] | null>(null);
  const [translating, setTranslating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Arriving from a Form M check: its documents are waiting in this tab's session.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("from") !== "formm") return;
    try {
      const raw = sessionStorage.getItem("pc-docs");
      if (raw) setFromCheck(JSON.parse(raw));
    } catch { /* storage unavailable */ }
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t0 = performance.now();
    const id = setInterval(() => setElapsed((performance.now() - t0) / 1000), 100);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    if (!busy) return;
    setStep(0);
    const t1 = setTimeout(() => setStep(1), fromCheck ? 300 : 3500);
    const t2 = setTimeout(() => setStep(2), fromCheck ? 1800 : 6500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [busy, fromCheck]);

  function choose(list: File[]) {
    previews.forEach((p) => URL.revokeObjectURL(p));
    setFiles(list.slice(0, 3));
    setPreviews(list.slice(0, 3).map((f) => URL.createObjectURL(f)));
    setFromCheck(null);
    setRes(null);
    setError(null);
    setLang("en");
    setTranslated(null);
  }

  async function run(body: FormData | string) {
    setBusy(true);
    setError(null);
    setRes(null);
    setLang("en");
    setTranslated(null);
    try {
      const r = await fetch("/api/pricecheck", {
        method: "POST",
        body,
        headers: typeof body === "string" ? { "Content-Type": "application/json" } : undefined,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Something went wrong");
      setRes(data);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function check(list = files) {
    if (fromCheck) return run(JSON.stringify({ docs: fromCheck, owner: ownerKey() }));
    if (!list.length) return;
    const body = new FormData();
    list.forEach((f) => body.append("files", f));
    body.append("owner", ownerKey());
    return run(body);
  }

  async function demo(id: string) {
    const blob = await (await fetch(`/demo/${id}_invoice.jpg`)).blob();
    const f = new File([blob], `${id}.jpg`, { type: "image/jpeg" });
    choose([f]);
    await check([f]);
  }

  const r = res?.result;
  const scored = r?.flags.filter((f) => f.points > 0) ?? [];
  const notes = r?.flags.filter((f) => f.points === 0) ?? [];
  const shown = [...scored, ...notes];
  const phase: Phase = busy ? (step >= 1 ? "checking" : "reading") : res ? "result" : "idle";
  const sheetStates: SheetState[] = previews.map(() => (busy ? "scanning" : res ? "done" : "idle"));
  const reportUrl = res?.id ? `/api/pricecheck/report?id=${res.id}&owner=${encodeURIComponent(ownerKeyIfAny() ?? "")}` : null;

  async function switchLang(next: Lang) {
    setLang(next);
    if (next === "en" || !shown.length) return setTranslated(null);
    setTranslating(true);
    try {
      const issues = shown.map((f) => ({ code: f.code, severity: AS_ISSUE[f.severity], title: f.title, detail: f.detail, fix: f.advice, evidence: [] }));
      const out = await fetch("/api/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issues, lang: next }) });
      const data = await out.json();
      if (!out.ok) throw new Error(data.error ?? "Translation failed");
      setTranslated(data.items);
    } catch (e) {
      setError((e as Error).message);
      setLang("en");
      setTranslated(null);
    } finally {
      setTranslating(false);
    }
  }

  return (
    <div className="shell">
      <div className="aurora" aria-hidden="true" />
      <header className="nav">
        <a className="brand" href="/" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="seal" aria-hidden="true">T</span>
          <span>Trade <b>Copilot</b></span>
        </a>
        <span className="pill"><span className="dot" /> UN Comtrade prices</span>
      </header>

      <main>
        <section className="hero">
          <nav className="modes" aria-label="Checks">
            {TABS.map((t) => <a key={t.href} className="mode" href={t.href}>{t.label}</a>)}
            <a className="mode on" href="/pricecheck" aria-current="page">Price check</a>
          </nav>
          <p className="eyebrow">For trade ops, compliance &amp; clearing agents</p>
          <h1>Spot over- and under-invoicing <span className="grad">in seconds.</span></h1>
          <p className="lead">Upload a proforma invoice, commercial invoice or Form M. Each line is compared with what the same goods from the same country normally cost, from UN Comtrade trade data, and you get a 0–100 risk score with the reasons.</p>
        </section>

        {fromCheck ? <div className={s.from}>Using the documents from your Form M check: no need to upload again.</div> : null}
        <section className={`stage ${phase}`}>
          <DocScene images={previews} states={sheetStates} phase={phase} links={[]} />
          <div className="stage-overlay">
            {!busy && !res && previews.length === 0 && !fromCheck && (
              <button className="drop" onClick={() => input.current?.click()}>
                <span className="drop-icon" aria-hidden="true">＋</span>
                <span><b>Add the invoice or Form M</b><small>JPG / PNG · up to 3 pages of one document</small></span>
              </button>
            )}
            {busy && <div className="timer mono">{elapsed.toFixed(1)}s</div>}
            {r && !busy && (
              <div className={`verdict ${r.level === "low" ? "good" : "bad"}`}>
                <span className="big mono">{r.score}</span>
                <span>{r.level} risk · out of 100</span>
              </div>
            )}
          </div>
        </section>
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={async (e) => {
            const picked = Array.from(e.target.files ?? []).slice(0, 3);
            const small = await Promise.all(picked.map(async (f) => {
              const b = await resizeImage(f);
              return b === f ? f : new File([b], f.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg", { type: "image/jpeg" });
            }));
            choose(small);
            e.target.value = "";
          }}
        />

        <div className="actions">
          <button className="cta" disabled={busy || (!files.length && !fromCheck)} onClick={() => check()}>
            {busy ? <><span className="spinner" /> Checking…</> : res ? "Check again" : "Check prices"}
          </button>
          {!fromCheck && <button className="ghost" disabled={busy} onClick={() => input.current?.click()}>Upload photos</button>}
          {!fromCheck && DEMOS.map((d) => <button key={d.id} className="ghost" disabled={busy} onClick={() => demo(d.id)}>{d.label}</button>)}
          {fromCheck ? <a className="ghost" href="/pricecheck">Upload a different document</a> : null}
        </div>
        <p className="fine">Sample invoices are synthetic. Use test or public documents only, never real customer paperwork. Prices are a screening signal, not proof of mispricing.</p>
        {error && <p className="alert">{error}</p>}

        {busy && (
          <ol className="timeline">
            {STEPS.map((t, i) => (
              <li key={t} className={i < step ? "done" : i === step ? "active" : "pending"}>
                <span className="node" />
                <div><b>{t}</b></div>
              </li>
            ))}
          </ol>
        )}

        {r && res && (
          <div ref={resultsRef} className="results">
            <section>
              <div className={s.scorecard}>
                <div className={`${s.dial} ${s[r.level]}`} style={{ ["--p" as string]: r.score }}>
                  <span><b>{r.score}</b><small>out of 100</small></span>
                </div>
                <div>
                  <span className={`${s.level} ${s[r.level]}`}><b>{r.level} risk</b></span>
                  <p>{r.summary}</p>
                  {reportUrl && (
                    <p style={{ margin: "12px 0 4px" }}>
                      <a className="ghost" href={reportUrl} target="_blank" rel="noopener">⬇ Download PDF report</a>
                    </p>
                  )}
                  <p className="dim small">
                    {res.doc.supplier ?? "Unknown supplier"} → {res.doc.buyer ?? "unknown buyer"} · origin {r.origin} · {res.doc.currency ?? "?"} {res.doc.incoterm ?? ""} ·{" "}
                    {r.checked_lines} of {r.lines.length} line{r.lines.length === 1 ? "" : "s"} compared · {(res.ms / 1000).toFixed(1)}s
                  </p>
                </div>
              </div>
            </section>

            {(scored.length > 0 || notes.length > 0) && (
              <section>
                <div className="section-head">
                  <h2>Why</h2>
                  <div className="langs">
                    {QUICK.map((l) => (
                      <button key={l} className={`lang ${lang === l ? "on" : ""}`} disabled={translating} onClick={() => switchLang(l)}>{LANGUAGES[l].label}</button>
                    ))}
                    <select aria-label="More languages" value={QUICK.includes(lang) ? "" : lang} disabled={translating} onChange={(e) => e.target.value && switchLang(e.target.value as Lang)}>
                      <option value="">More…</option>
                      {(Object.keys(LANGUAGES) as Lang[]).filter((l) => !QUICK.includes(l)).map((l) => <option key={l} value={l}>{LANGUAGES[l].label}</option>)}
                    </select>
                    {translating && <span className="spinner" />}
                  </div>
                </div>
                <p className="dim small" style={{ marginTop: -6 }}>Every figure comes from the document and UN Comtrade.</p>
                <div className="issues">
                  {shown.map((f, k) => {
                    const t = translated?.[k];
                    return (
                      <article key={`${lang}-${f.code}-${k}`} className={SEV[f.severity].cls} style={{ animationDelay: `${k * 80}ms` }} dir={t ? "auto" : undefined}>
                        <header>
                          <span className="sev">{SEV[f.severity].label}{f.points ? ` · +${f.points}` : ""}</span>
                        </header>
                        <h3>{t ? t.title : f.title}</h3>
                        {t ? <p>{t.body}</p> : <><p>{f.detail}</p><p className="fix"><b>What to do</b> {f.advice}</p></>}
                        {t && <footer className="mono">{t.verified ? "figures verified" : "shown in English: figures couldn't be verified in translation"}</footer>}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            <section>
              <div className="section-head"><h2>Line by line</h2><span className="dim small">FOB US dollars{r.fx && r.fx.currency !== "USD" ? ` · ${r.fx.currency} at ${r.fx.per_usd} per USD` : ""}</span></div>
              {r.incoterm_note && <p className="dim small" style={{ marginTop: -6 }}>{r.incoterm_note}</p>}
              <div className={s.lines}>
                {r.lines.map((l, k) => (
                  <div key={l.line_no} className={s.line} style={{ animationDelay: `${k * 80}ms` }}>
                    <header>
                      <b>{l.line_no}. {l.description ?? "—"}</b>
                      <span className="mono dim">{l.hs6 ? `HS ${l.hs6.slice(0, 4)}.${l.hs6.slice(4)}` : "no HS code"}</span>
                    </header>
                    {l.price_usd != null && l.band ? (
                      <>
                        <PriceBar l={l} />
                        <p className="dim small" style={{ margin: "8px 0 0" }}>
                          {l.note ?? (l.position === "within" ? "Within the normal range" : l.position === "above" ? "Above the normal range" : "Below the normal range")} · {l.ratio}× the typical price
                        </p>
                      </>
                    ) : (
                      <p className="dim small" style={{ margin: "8px 0 0" }}>{l.note ?? "Not compared."}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>

      <footer className="foot">
        Prices: UN Comtrade, annual trade flows 2020–2024, converted to FOB US dollars. A screening aid for review, not a finding of wrongdoing.
        <br />
        <a href="/tracker" style={{ color: "inherit" }}>My deadline tracker</a> · <a href="/privacy" style={{ color: "inherit" }}>Privacy</a>
      </footer>
    </div>
  );
}
