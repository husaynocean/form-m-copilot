"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Issue } from "@/lib/schema";
import type { FormMDraft } from "@/lib/formm";
import type { Deadline } from "@/lib/deadlines";
import { LANGUAGES, type Lang } from "@/lib/languages";
import { resizeImage } from "@/lib/resize";
import { getTrackerKey, setTrackerKey } from "@/lib/tracker-key";
import type { Link, Phase, SheetState } from "@/components/DocScene";

const DocScene = dynamic(() => import("@/components/DocScene"), { ssr: false, loading: () => <div className="scene" /> });

interface HsSuggestion { line: number; code: string | null; official_text: string | null; confidence: string; reason: string; missing_info: string | null }
interface DocEvent { index: number; file: string; status: string; doc_type?: string; model?: string; ms?: number; repaired?: boolean; error?: string; verification?: { rereads: number; agreed: boolean; corrected: string[]; uncertain: string[] } }
interface Result { mode: Mode; issues: Issue[]; draft: FormMDraft; hs: HsSuggestion[]; ms: number; deadlines?: Deadline[] }
type Mode = "import" | "export" | "formq" | "forma";

const MODES: Record<Mode, {
  tab: string; form: string; eyebrow: string; head: string; lead: string; draftNote: string; okText: string;
  demos: { id: string; label: string }[]; docs: string[];
}> = {
  import: {
    tab: "Form M · imports", form: "Form M", eyebrow: "For Nigerian importers & trade desks", head: "Catch Form M errors",
    lead: "Snap your proforma invoice, packing list and insurance certificate. The agent reads every figure, cross-checks the documents against each other and drafts your Form M, in your language.",
    draftNote: "Pre-filled · verify on the Nigeria Single Window", okText: "problems · ready for the bank",
    demos: [{ id: "case_12", label: "Try a problem file" }, { id: "case_01", label: "Try a clean file" }],
    docs: ["proforma_invoice", "packing_list", "insurance_certificate"],
  },
  export: {
    tab: "Form NXP · exports", form: "Form NXP", eyebrow: "For Nigerian exporters & trade desks", head: "Catch Form NXP errors",
    lead: "Snap your invoice, packing list, bill of lading and NEPC certificate, plus the CCI and certificate of origin when you have them. The agent cross-checks them, drafts your Form NXP and starts the clock on your repatriation deadline.",
    draftNote: "Pre-filled · verify on the CBN Trade Monitoring System", okText: "problems · ready for the bank",
    demos: [{ id: "export_problem", label: "Try a problem file" }, { id: "export_clean", label: "Try a clean file" }],
    docs: ["commercial_invoice", "packing_list", "bill_of_lading", "nepc_certificate", "cci", "certificate_of_origin"],
  },
  formq: {
    tab: "Form Q · small imports", form: "Form Q", eyebrow: "For small importers · up to USD 20,000 a quarter", head: "Catch Form Q errors",
    lead: "Snap your supplier's invoice. The agent checks the arithmetic, that it is for physical goods, and that it fits your USD 20,000 quarterly allowance, then drafts your Form Q.",
    draftNote: "Pre-filled · bring Form Q and your instruction letter to the bank", okText: "problems · ready for the bank",
    demos: [{ id: "formq_problem", label: "Try a problem file" }, { id: "formq_clean", label: "Try a clean file" }],
    docs: ["proforma_invoice"],
  },
  forma: {
    tab: "Form A · school & medical", form: "Form A", eyebrow: "For school fees & medical bills abroad", head: "Catch Form A errors",
    lead: "Snap the school bill and admission letter (or the hospital estimate and doctor's letter). The agent checks names, bank details, limits and dates, then drafts your Form A. Don't upload passports or tax documents.",
    draftNote: "Pre-filled · apply on the CBN Trade Monitoring System", okText: "problems · ready for the bank",
    demos: [{ id: "forma_problem", label: "Try a problem file" }, { id: "forma_clean", label: "Try a clean file" }],
    docs: ["fee_invoice", "support_letter"],
  },
};
const DOC_LABEL: Record<string, string> = {
  proforma_invoice: "Invoice", packing_list: "Packing list", insurance_certificate: "Insurance cert.", bill_of_lading: "Bill of lading",
  nepc_certificate: "NEPC cert.", clean_certificate_of_inspection: "CCI", certificate_of_origin: "Cert. of origin",
  fee_invoice: "Fee bill", support_letter: "Letter",
};
const QUICK: Lang[] = ["en", "ha", "yo", "ig", "pcm"];

const money = (v: unknown) =>
  typeof v === "number" ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v ?? "—");

function useCountUp(target: number, run: boolean, ms = 900) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!run) return setV(0);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, run, ms]);
  return v;
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("import");
  const [category, setCategory] = useState<"non-oil" | "oil">("non-oil");
  const [validity, setValidity] = useState<"general" | "plant">("general");
  const [used, setUsed] = useState("");
  const [saved, setSaved] = useState<Record<string, "saving" | "saved" | "error">>({});
  const M = MODES[mode];
  const label = (d: string) => (d === "proforma_invoice" && mode === "import" ? "Proforma invoice" : DOC_LABEL[d] ?? d);
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<"read" | "validate" | "hs" | "draft" | "done" | null>(null);
  const [docEvents, setDocEvents] = useState<DocEvent[]>([]);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("en");
  const [translated, setTranslated] = useState<{ title: string; body: string; verified: boolean }[] | null>(null);
  const [translating, setTranslating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // Only one check at a time: a new check cancels the previous one.
  const runRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const busy = phase === "reading" || phase === "checking";

  useEffect(() => {
    if (!busy) return;
    const t0 = performance.now();
    const id = setInterval(() => setElapsed((performance.now() - t0) / 1000), 100);
    return () => clearInterval(id);
  }, [busy]);

  function reset() {
    setPhase("idle"); setStage(null); setDocEvents([]); setIssues(null); setResult(null);
    setError(null); setLang("en"); setTranslated(null); setElapsed(0); setSaved({});
  }

  function choose(list: File[]) {
    previews.forEach((p) => URL.revokeObjectURL(p));
    setFiles(list.slice(0, 6));
    setPreviews(list.slice(0, 6).map((f) => URL.createObjectURL(f)));
    reset();
  }

  function switchMode(next: Mode) {
    if (next === mode || busy) return;
    previews.forEach((p) => URL.revokeObjectURL(p));
    setFiles([]); setPreviews([]); reset(); setMode(next);
  }

  async function loadDemo(caseId: string) {
    const list = await Promise.all(
      M.docs.map(async (d) => {
        const blob = await (await fetch(`/demo/${caseId}_${d}.jpg`)).blob();
        return new File([blob], `${d}.jpg`, { type: "image/jpeg" });
      }),
    );
    choose(list);
    return list;
  }

  async function run(list = files) {
    if (!list.length) return;
    runRef.current?.abort();
    const ctrl = new AbortController();
    runRef.current = ctrl;
    reset();
    setPhase("reading");
    setStage("read");
    try {
      const body = new FormData();
      list.forEach((f) => body.append("files", f));
      body.append("mode", mode);
      body.append("category", category);
      body.append("validity", validity);
      body.append("used", String(Number(used.replace(/[^0-9.]/g, "")) || 0));
      const res = await fetch("/api/check", { method: "POST", body, signal: ctrl.signal });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done || ctrl.signal.aborted) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "doc") setDocEvents((d) => [...d, ev]);
          else if (ev.type === "stage") { setStage(ev.stage); if (ev.stage === "validate") setPhase("checking"); }
          else if (ev.type === "issues") setIssues(ev.issues);
          else if (ev.type === "done") {
            setResult(ev.result);
            setStage("done");
            setPhase("result");
            setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 700);
          } else if (ev.type === "error") throw new Error(ev.error);
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError((e as Error).message);
      setPhase("idle");
      setStage(null);
    }
  }

  async function saveDeadline(t: Deadline) {
    if (!result) return;
    setSaved((x) => ({ ...x, [t.kind]: "saving" }));
    const kind = { import: "form_m", export: "nxp", formq: "form_q", forma: "form_a" }[result.mode ?? mode];
    const name = (title: string) => result.draft.sections.find((sec) => sec.title === title)?.fields.find((f) => f.label === "Name" || f.label === "Institution")?.value;
    const counterparty =
      mode === "import" ? name("Beneficiary (supplier)")
      : mode === "export" ? name("Buyer (consignee)")
      : mode === "formq" ? name("Supplier (beneficiary)")
      : name("Beneficiary");
    const own = mode === "import" ? name("Applicant (importer)") : mode === "export" ? name("Exporter") : mode === "formq" ? name("Applicant (importer)") : name("Student") ?? name("Patient");
    try {
      const res = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: getTrackerKey(),
          file: {
            kind, title: String(counterparty ?? M.form), party: own ? String(own) : null, reference: t.reference, amount: t.amount, currency: t.currency,
            deadline_kind: t.kind, deadline_title: t.title, basis: t.basis, start_label: t.start_label, start_date: t.start_date, days_total: t.days_total,
            open_issues: errors.length,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTrackerKey(data.owner);
      setSaved((x) => ({ ...x, [t.kind]: "saved" }));
    } catch {
      setSaved((x) => ({ ...x, [t.kind]: "error" }));
    }
  }

  async function switchLang(next: Lang) {
    setLang(next);
    if (next === "en" || !result) return setTranslated(null);
    setTranslating(true);
    try {
      const res = await fetch("/api/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issues: result.issues, lang: next }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Translation failed");
      setTranslated(data.items);
    } catch (e) {
      setError((e as Error).message);
      setLang("en");
      setTranslated(null);
    } finally {
      setTranslating(false);
    }
  }

  // --- derive 3D scene state from real progress -----------------------------
  const sheetStates: SheetState[] = previews.map((_, i) => {
    const ev = docEvents.find((d) => d.index === i);
    if (ev) return ev.status === "failed" ? "failed" : "done";
    return phase === "reading" || phase === "checking" ? "scanning" : phase === "result" ? "done" : "idle";
  });
  const typeToIndex = useMemo(() => {
    const m: Record<string, number> = {};
    docEvents.forEach((d) => { if (d.doc_type && d.status === "ok") m[d.doc_type] = d.index; });
    return m;
  }, [docEvents]);
  const links: Link[] = useMemo(() => {
    if (phase !== "checking" && phase !== "result") return [];
    const idx = Object.values(typeToIndex);
    const conflict = new Set<string>();
    (issues ?? []).forEach((iss) => {
      const ds = [...new Set(iss.evidence.map((e) => typeToIndex[e.doc]).filter((x) => x !== undefined))];
      for (let a = 0; a < ds.length; a++) for (let b = a + 1; b < ds.length; b++) conflict.add([ds[a], ds[b]].sort().join("-"));
    });
    const out: Link[] = [];
    for (let a = 0; a < idx.length; a++)
      for (let b = a + 1; b < idx.length; b++) {
        const [x, y] = [idx[a], idx[b]].sort();
        out.push({ a: x, b: y, ok: !conflict.has(`${x}-${y}`) });
      }
    return out;
  }, [phase, typeToIndex, issues]);

  const errors = result?.issues.filter((i) => i.severity === "error") ?? [];
  const warnings = result?.issues.filter((i) => i.severity === "warning") ?? [];
  const notes = result?.issues.filter((i) => i.severity === "info") ?? [];
  const errorCount = useCountUp(errors.length, phase === "result", 700);
  const totalValue = Number(result?.draft.sections.find((s) => s.title === "Financials")?.fields.find((f) => f.label === "Total value")?.value ?? 0);
  const valueCount = useCountUp(totalValue, phase === "result", 1400);
  const currency = String(result?.draft.sections.find((s) => s.title === "Financials")?.fields.find((f) => f.label === "Currency")?.value ?? "");

  const steps = [
    { key: "read", title: "Reading documents", sub: `${docEvents.length}/${files.length || 3} pages · vision model` },
    { key: "validate", title: "Cross-checking", sub: issues ? `${issues.length} finding${issues.length === 1 ? "" : "s"} · totals, names, quantities, ports, dates` : "totals, names, quantities, ports, dates" },
    { key: "hs", title: "Classifying goods", sub: "5,612 HS 2022 codes · verified shortlist" },
    { key: "draft", title: `Drafting ${M.form}`, sub: mode === "export" ? "every field traced · repatriation clock started" : "every field traced to its source" },
  ] as const;
  const order = ["read", "validate", "hs", "draft", "done"];
  const stepState = (k: string) => {
    if (!stage) return "pending";
    const a = order.indexOf(stage), b = order.indexOf(k);
    return b < a ? "done" : b === a ? "active" : "pending";
  };

  return (
    <div className="shell">
      <div className="aurora" aria-hidden="true" />
      <header className="nav">
        <div className="brand">
          <span className="seal" aria-hidden="true">T</span>
          <span>Trade <b>Copilot</b></span>
        </div>
        <span className="pill"><span className="dot" /> Runs on Gemini</span>
      </header>

      <main>
        <section className="hero">
          <div className="modes" role="tablist" aria-label="Choose imports or exports">
            {(Object.keys(MODES) as Mode[]).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} className={`mode ${mode === m ? "on" : ""}`} disabled={busy} onClick={() => switchMode(m)}>{MODES[m].tab}</button>
            ))}
          </div>
          {mode === "import" && (
            <div className="cats" role="radiogroup" aria-label="Type of goods">
              {([["general", "General goods · 180 days"], ["plant", "Plant & machinery · 365 days"]] as const).map(([c, t]) => (
                <button key={c} role="radio" aria-checked={validity === c} className={`cat ${validity === c ? "on" : ""}`} disabled={busy} onClick={() => { setValidity(c); reset(); }}>{t}</button>
              ))}
            </div>
          )}
          {mode === "export" && (
            <div className="cats" role="radiogroup" aria-label="Type of export">
              {([["non-oil", "Non-oil · 180 days"], ["oil", "Oil & gas · 90 days"]] as const).map(([c, t]) => (
                <button key={c} role="radio" aria-checked={category === c} className={`cat ${category === c ? "on" : ""}`} disabled={busy} onClick={() => { setCategory(c); reset(); }}>{t}</button>
              ))}
            </div>
          )}
          {mode === "formq" && (
            <label className="cats used">
              <span className="dim small">Already used this quarter (USD)</span>
              <input inputMode="decimal" placeholder="0" value={used} disabled={busy} onChange={(e) => { setUsed(e.target.value); if (phase === "result") reset(); }} />
            </label>
          )}
          <p className="eyebrow">{M.eyebrow}</p>
          <h1>{M.head} <span className="grad">before the bank does.</span></h1>
          <p className="lead">{M.lead}</p>
        </section>

        <section className={`stage ${phase}`}>
          <DocScene images={previews} states={sheetStates} phase={phase} links={links} />
          <div className="stage-overlay">
            {phase === "idle" && previews.length === 0 && (
              <button className="drop" onClick={() => input.current?.click()}>
                <span className="drop-icon" aria-hidden="true">＋</span>
                <span><b>Add document photos</b><small>JPG / PNG · up to 6 pages</small></span>
              </button>
            )}
            {busy && <div className="timer mono">{elapsed.toFixed(1)}s</div>}
            {phase === "result" && result && (
              <div className={`verdict ${errors.length ? "bad" : "good"}`}>
                <span className="big mono">{Math.round(errorCount)}</span>
                <span>{errors.length ? `problem${errors.length > 1 ? "s" : ""} to fix` : M.okText}</span>
              </div>
            )}
          </div>
          <div className="chips">
            {previews.map((_, i) => {
              const ev = docEvents.find((d) => d.index === i);
              const s = sheetStates[i];
              return (
                <span key={i} className={`chip ${s}`}>
                  <span className="chip-dot" />
                  <span className="chip-label">{ev?.doc_type ? label(ev.doc_type) : files[i]?.name.replace(/\.[a-z]+$/i, "").replace(/_/g, " ")}</span>
                  {ev?.ms ? <span className="mono dim"> {(ev.ms / 1000).toFixed(1)}s</span> : s === "scanning" ? <span className="dim">…</span> : null}
                </span>
              );
            })}
          </div>
        </section>

        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={async (e) => {
            // Shrink phone photos before upload (keeps requests under the 4.5 MB limit).
            const picked = Array.from(e.target.files ?? []).slice(0, 6);
            const small = await Promise.all(
              picked.map(async (f) => {
                const b = await resizeImage(f);
                return b === f ? f : new File([b], f.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg", { type: "image/jpeg" });
              }),
            );
            choose(small);
            e.target.value = "";
          }}
        />

        <div className="actions">
          <button className="cta" disabled={!files.length || busy} onClick={() => run()}>
            {busy ? <><span className="spinner" /> Checking…</> : phase === "result" ? "Check again" : "Check documents"}
          </button>
          <button className="ghost" disabled={busy} onClick={() => input.current?.click()}>Upload photos</button>
          <a className="ghost wa" href="/whatsapp">💬 Try the WhatsApp bot</a>
          {M.demos.map((d) => (
            <button key={d.id} className="ghost" disabled={busy} onClick={async () => run(await loadDemo(d.id))}>{d.label}</button>
          ))}
        </div>
        <p className="fine">Sample files are synthetic: invented companies, never real customer documents. This is a public demo on a free AI tier, so please upload test documents only, not real customer paperwork.</p>
        {error && <p className="alert">{error}</p>}

        {(busy || phase === "result") && (
          <ol className="timeline">
            {steps.map((s, i) => (
              <li key={s.key} className={stepState(s.key)} style={{ animationDelay: `${i * 80}ms` }}>
                <span className="node" />
                <div>
                  <b>{s.title}</b>
                  <small>{s.sub}</small>
                  {s.key === "read" && docEvents.length > 0 && (
                    <div className="subs">
                      {docEvents.map((d) => (
                        <span key={d.index} className={`sub ${d.status}`}>
                          {d.status === "ok" ? "✓" : d.status === "failed" ? "✕" : "•"} {d.doc_type ? label(d.doc_type) : d.file}
                          {d.ms ? <span className="mono"> {(d.ms / 1000).toFixed(1)}s</span> : null}
                          {d.repaired ? <span className="tag" title="The AI's first answer was incomplete or in the wrong format; it was shown the problem and corrected itself.">auto-corrected</span> : null}
                          {d.verification?.rereads ? (
                            <span className="tag">
                              {d.verification.corrected.length
                                ? `totals re-read ${d.verification.rereads + 1}× · corrected`
                                : d.verification.uncertain.length
                                ? "totals unclear"
                                : `totals re-read ${d.verification.rereads + 1}× · agree`}
                            </span>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        {phase === "result" && result && (
          <div ref={resultsRef} className="results">
            <section className="kpis">
              <div className="kpi">
                <small>Declared value</small>
                <b className="mono">{currency} {money(valueCount)}</b>
              </div>
              <div className="kpi">
                <small>{result.draft.items.length ? "Line items" : "Documents"}</small>
                <b className="mono">{result.draft.items.length || docEvents.filter((d) => d.status === "ok").length}</b>
              </div>
              <div className="kpi">
                <small>Checked in</small>
                <b className="mono">{(result.ms / 1000).toFixed(1)}s</b>
              </div>
            </section>

            {(result.deadlines ?? []).map((t) => (
              <section key={t.kind} className={`tracker ${t.status}`}>
                <div className="section-head">
                  <h2>{t.title}</h2>
                  <span className="dim small">{t.basis}</span>
                </div>
                <div className="tracker-main">
                  <b className="mono">{t.days_left < 0 ? `${Math.abs(t.days_left)} days overdue` : `${t.days_left} days left`}</b>
                  <span>
                    {t.amount != null ? `${t.currency ?? ""} ${money(t.amount)} · ` : ""}due by <b className="mono">{t.deadline}</b>
                  </span>
                </div>
                <div className="bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, Math.max(0, ((t.days_total - t.days_left) / t.days_total) * 100))}%` }} />
                </div>
                <div className="tracker-ends mono dim small">
                  <span>{t.start_label} {t.start_date}{t.reference ? ` · ${t.reference}` : ""}</span>
                  <span>Due {t.deadline}</span>
                </div>
                <p className="dim small tracker-action">{t.action}</p>
                <div className="tracker-save">
                  {saved[t.kind] === "saved" ? (
                    <a className="ghost" href="/tracker">✓ Saved · open tracker</a>
                  ) : (
                    <button className="ghost" disabled={saved[t.kind] === "saving"} onClick={() => saveDeadline(t)}>
                      {saved[t.kind] === "saving" ? "Saving…" : saved[t.kind] === "error" ? "Couldn't save · try again" : "Save & track this deadline"}
                    </button>
                  )}
                  {t.start_label?.startsWith("If") && <span className="dim small">You can set the real {t.kind === "form_m_validity" ? "approval" : "payment"} date in the tracker.</span>}
                </div>
              </section>
            ))}

            {[...errors, ...warnings, ...notes].length > 0 && (
              <section>
                <div className="section-head">
                  <h2>Fix-list</h2>
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
                <div className="issues">
                  {[...errors, ...warnings, ...notes].map((iss, k) => {
                    const t = translated?.[result.issues.indexOf(iss)];
                    const docs = [...new Set(iss.evidence.map((e) => e.doc))];
                    return (
                      <article key={`${lang}-${k}`} className={`issue ${iss.severity}`} style={{ animationDelay: `${k * 90}ms` }} dir={t ? "auto" : undefined}>
                        <header>
                          <span className="sev">{iss.severity === "error" ? "Must fix" : iss.severity === "warning" ? "Check" : "Note"}</span>
                          {docs.map((d) => <span key={d} className="docchip">{label(d)}</span>)}
                        </header>
                        <h3>{t ? t.title : iss.title}</h3>
                        {t ? <p>{t.body}</p> : <><p>{iss.detail}</p><p className="fix"><b>Fix</b> {iss.fix}</p></>}
                        <footer className="mono">{iss.code}{t && !t.verified ? " · shown in English: figures couldn't be verified in translation" : t ? " · figures verified" : ""}</footer>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            <section>
              <div className="section-head"><h2>{M.form} draft</h2><span className="dim small">{M.draftNote}</span></div>
              <div className="draft">
                {result.draft.sections.map((s, i) => (
                  <div className="panel" key={s.title} style={{ animationDelay: `${i * 70}ms` }}>
                    <h3>{s.title}</h3>
                    <dl>
                      {s.fields.map((f) => (
                        <div key={f.label} className="kv">
                          <dt>{f.label}</dt>
                          <dd className={f.value == null ? "missing" : typeof f.value === "number" ? "mono" : ""}>
                            {f.value == null ? "Missing" : typeof f.value === "number" ? money(f.value) : f.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="section-head"><h2>Goods &amp; HS codes</h2></div>
              <div className="goods">
                {result.draft.items.map((it, k) => {
                  const sug = result.hs?.find((h) => h.line === k);
                  return (
                    <div key={k} className="good" style={{ animationDelay: `${k * 80}ms` }}>
                      <div className="good-main">
                        <b>{it.description ?? "—"}</b>
                        <span className="mono dim">{it.quantity?.toLocaleString()} {it.unit} × {money(it.unit_price)} = {money(it.amount)}</span>
                      </div>
                      <div className={`hs ${it.hs_code && !sug ? "ok" : sug?.code ? "suggest" : "need"}`}>
                        <span className="mono">{it.hs_code ?? sug?.code ?? "No code"}</span>
                        <small>
                          {it.hs_code && !sug ? "on invoice" : sug?.code ? `suggested · ${sug.confidence}` : "needs more detail"}
                        </small>
                      </div>
                      {sug && <p className="why">{sug.code ? sug.reason : sug.missing_info ?? sug.reason}</p>}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </main>

      <footer className="foot">
        Started at the Meta Global AI Developer Hackathon · Works with any vision model, now on Google Gemini · Draft for review only, not a submission
        <br />
        <a href="/tracker" style={{ color: "inherit" }}>My deadline tracker</a> · <a href="/privacy" style={{ color: "inherit" }}>Privacy</a> · <a href="/data-deletion" style={{ color: "inherit" }}>Data deletion</a>
      </footer>
    </div>
  );
}
