"use client";

import { useRef, useState } from "react";
import type { Issue } from "@/lib/schema";
import type { FormMDraft } from "@/lib/formm";
import { LANGUAGES, type Lang } from "@/lib/languages";

interface HsSuggestion {
  line: number;
  code: string | null;
  official_text: string | null;
  confidence: string;
  reason: string;
  missing_info: string | null;
}
interface CheckResult {
  issues: Issue[];
  hs: HsSuggestion[];
  draft: FormMDraft;
  trace: { file: string; status: string; doc_type?: string; model?: string; ms?: number; repaired?: boolean; error?: string }[];
  ms: number;
  error?: string;
}

const DEMOS = {
  "Sample A (clean)": "case_01",
  "Sample B (has errors)": "case_12",
} as const;
const DOCS = ["proforma_invoice", "packing_list", "insurance_certificate"];
const DOC_LABEL: Record<string, string> = {
  proforma_invoice: "Proforma invoice",
  packing_list: "Packing list",
  insurance_certificate: "Insurance certificate",
};

const money = (v: unknown) =>
  typeof v === "number" ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v ?? "—");

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [lang, setLang] = useState<Lang>("en");
  const [translated, setTranslated] = useState<{ title: string; body: string; verified: boolean }[] | null>(null);
  const [translating, setTranslating] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function choose(list: File[]) {
    setFiles(list);
    setPreviews(list.map((f) => URL.createObjectURL(f)));
    setResult(null);
    setError(null);
    setLang("en");
    setTranslated(null);
  }

  async function switchLang(next: Lang) {
    setLang(next);
    if (next === "en" || !result) return setTranslated(null);
    setTranslating(true);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issues: result.issues, lang: next }),
      });
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

  async function loadDemo(caseId: string) {
    const list = await Promise.all(
      DOCS.map(async (d) => {
        const blob = await (await fetch(`/demo/${caseId}_${d}.jpg`)).blob();
        return new File([blob], `${d}.jpg`, { type: "image/jpeg" });
      }),
    );
    choose(list);
  }

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    setLang("en");
    setTranslated(null);
    try {
      const body = new FormData();
      files.forEach((f) => body.append("files", f));
      const res = await fetch("/api/check", { method: "POST", body });
      const data = (await res.json()) as CheckResult;
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const errors = result?.issues.filter((i) => i.severity === "error") ?? [];
  const warnings = result?.issues.filter((i) => i.severity === "warning") ?? [];

  return (
    <main>
      <h1>Form M Copilot</h1>
      <p className="lead">
        Photograph the proforma invoice, packing list and insurance certificate. We read them, cross-check every
        figure and name, and pre-fill your Form M before it reaches the bank.
      </p>

      <div
        className={`drop ${drag ? "active" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); choose(Array.from(e.dataTransfer.files)); }}
      >
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={(e) => choose(Array.from(e.target.files ?? []))}
        />
        <strong>Tap to add document photos</strong>
        <div className="muted">JPG or PNG · up to 6 pages</div>
        {previews.length > 0 && (
          <div className="thumbs">
            {previews.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt={files[i]?.name ?? "document"} />
            ))}
          </div>
        )}
      </div>

      <div className="row">
        <button className="primary" disabled={!files.length || busy} onClick={run}>
          {busy ? <><span className="spinner" /> Checking…</> : "Check documents"}
        </button>
        {Object.entries(DEMOS).map(([label, id]) => (
          <button key={id} disabled={busy} onClick={() => loadDemo(id)}>{label}</button>
        ))}
      </div>
      <p className="muted">Samples are synthetic: invented companies, never real customer documents.</p>

      {error && <p className="err">{error}</p>}

      {result && (
        <>
          <h2>Result</h2>
          <div className={`summary ${errors.length ? "bad" : "good"}`}>
            {errors.length
              ? `${errors.length} problem${errors.length > 1 ? "s" : ""} to fix before submitting`
              : "No problems found. Documents are consistent."}
          </div>

          {[...errors, ...warnings].length > 0 && (
            <>
              <h2>Fix-list</h2>
              <div className="row" style={{ marginTop: 0, marginBottom: 12 }}>
                {(["en", "ha", "yo", "ig", "pcm"] as const).map((l) => (
                  <button key={l} className={lang === l ? "primary" : ""} disabled={translating} onClick={() => switchLang(l)}>
                    {LANGUAGES[l].label}
                  </button>
                ))}
                <select
                  aria-label="More languages"
                  value={["en", "ha", "yo", "ig", "pcm"].includes(lang) ? "" : lang}
                  disabled={translating}
                  onChange={(e) => e.target.value && switchLang(e.target.value as Lang)}
                >
                  <option value="">More languages…</option>
                  {(Object.keys(LANGUAGES) as Lang[])
                    .filter((l) => !["en", "ha", "yo", "ig", "pcm"].includes(l))
                    .map((l) => <option key={l} value={l}>{LANGUAGES[l].label}</option>)}
                </select>
                {translating && <span className="spinner" />}
              </div>
              {[...errors, ...warnings].map((i, k) => {
                const t = translated?.[result.issues.indexOf(i)];
                return (
                  <div key={k} className={`issue ${i.severity}`} dir={t ? "auto" : undefined}>
                    <h3>{t ? t.title : i.title}</h3>
                    {t ? <div>{t.body}</div> : <><div>{i.detail}</div><div className="fix"><b>Fix:</b> {i.fix}</div></>}
                    <div className="code">{i.code}{t && !t.verified ? " · shown in English (figures could not be verified in translation)" : ""}</div>
                  </div>
                );
              })}
            </>
          )}

          <h2>Form M draft</h2>
          <div className="grid">
            {result.draft.sections.map((s) => (
              <div className="card" key={s.title}>
                <h3>{s.title}</h3>
                <dl>
                  {s.fields.map((f) => (
                    <div key={f.label} style={{ display: "contents" }}>
                      <dt>{f.label}</dt>
                      <dd className={f.value == null ? "empty" : ""}>
                        {f.value == null ? "Missing" : typeof f.value === "number" ? money(f.value) : f.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>

          <h2>Items</h2>
          <div className="card tablewrap">
            <table>
              <thead>
                <tr><th>Description</th><th>HS code</th><th>Qty</th><th>Unit price</th><th>Amount</th><th>Gross kg</th></tr>
              </thead>
              <tbody>
                {result.draft.items.map((it, k) => {
                  const sug = result.hs?.find((h) => h.line === k);
                  return (
                  <tr key={k}>
                    <td className="desc">{it.description}</td>
                    <td className={it.hs_code && !sug ? "" : "err"}>
                      {it.hs_code ?? "Needed"}
                      {sug && (
                        <div className="muted" style={{ whiteSpace: "normal", minWidth: 160 }}>
                          {sug.code ? <>Suggested <b>{sug.code}</b> ({sug.confidence})<br />{sug.reason}</> : <>No safe suggestion. {sug.missing_info ?? sug.reason}</>}
                        </div>
                      )}
                    </td>
                    <td>{it.quantity?.toLocaleString()} {it.unit}</td>
                    <td>{money(it.unit_price)}</td>
                    <td>{money(it.amount)}</td>
                    <td>{it.gross_weight_kg?.toLocaleString() ?? "—"}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <footer className="muted">
            {result.trace.map((t) => (
              <div key={t.file}>
                {t.file}: {t.status === "ok" ? `${DOC_LABEL[t.doc_type ?? ""] ?? t.doc_type} · ${t.model} · ${((t.ms ?? 0) / 1000).toFixed(1)}s${t.repaired ? " · self-repaired" : ""}` : `${t.status}${t.error ? ` (${t.error})` : ""}`}
              </div>
            ))}
            <div>Total {(result.ms / 1000).toFixed(1)}s. Draft for review only; verify on the Nigeria Single Window before submission.</div>
          </footer>
        </>
      )}
    </main>
  );
}
