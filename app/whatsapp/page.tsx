"use client";

import { useEffect, useRef, useState } from "react";
import { blobToDataUrl, resizeImage } from "@/lib/resize";
import s from "./chat.module.css";

type Msg =
  | { id: string; from: "me"; kind: "text"; text: string; at: string }
  | { id: string; from: "me"; kind: "image"; src: string; at: string }
  | { id: string; from: "bot"; kind: "text"; text: string; at: string }
  | { id: string; from: "bot"; kind: "list"; text: string; button: string; rows: { id: string; title: string }[]; at: string };

const SAMPLES = ["proforma_invoice", "packing_list", "insurance_certificate"];
const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const uid = () => Math.random().toString(36).slice(2, 10);

/** WhatsApp-style formatting: *bold*, _italic_, line breaks. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("*") && p.endsWith("*") && p.length > 2 ? <b key={i}>{p.slice(1, -1)}</b>
        : p.startsWith("_") && p.endsWith("_") && p.length > 2 ? <i key={i}>{p.slice(1, -1)}</i>
        : <span key={i}>{p}</span>,
      )}
    </>
  );
}

function getSession(): string {
  try {
    const k = "fmc-chat-session";
    const v = localStorage.getItem(k) ?? uid() + uid();
    localStorage.setItem(k, v);
    return v;
  } catch {
    return uid() + uid();
  }
}

export default function ChatPreview() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pending, setPending] = useState(0);
  const [draft, setDraft] = useState("");
  const [sheet, setSheet] = useState<Extract<Msg, { kind: "list" }> | null>(null);
  const [session, setSession] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSession(getSession());
  }, []);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which
    // React would otherwise treat as a cleanup function.
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, pending]);

  async function call(payload: Record<string, unknown>) {
    setPending((p) => p + 1);
    try {
      // Mobile connections can drop during the ~20 s model call; retry once on a network error.
      const send = () => fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session, ...payload }) });
      let res: Response;
      try {
        res = await send();
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          res = await send();
        } catch {
          throw new Error("Connection dropped. Check your network and send it again.");
        }
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      for (const r of data.replies as ({ type: "text"; text: string } | { type: "list"; body: string; button: string; rows: { id: string; title: string }[] })[]) {
        setMsgs((m) => [...m, r.type === "text"
          ? { id: uid(), from: "bot", kind: "text", text: r.text, at: now() }
          : { id: uid(), from: "bot", kind: "list", text: r.body, button: r.button, rows: r.rows, at: now() }]);
      }
    } catch (e) {
      setMsgs((m) => [...m, { id: uid(), from: "bot", kind: "text", text: `⚠️ ${(e as Error).message}`, at: now() }]);
    } finally {
      setPending((p) => p - 1);
    }
  }

  function sendText(text: string) {
    if (!text.trim()) return;
    setMsgs((m) => [...m, { id: uid(), from: "me", kind: "text", text, at: now() }]);
    setDraft("");
    void call({ text });
  }

  async function sendImages(blobs: Blob[]) {
    // Like WhatsApp: photos sent together are processed in parallel.
    await Promise.all(
      blobs.map(async (b) => {
        const small = await resizeImage(b);
        const dataUrl = await blobToDataUrl(small);
        setMsgs((m) => [...m, { id: uid(), from: "me", kind: "image", src: dataUrl, at: now() }]);
        await call({ image: dataUrl });
      }),
    );
  }

  async function sendSamples() {
    const blobs = await Promise.all(SAMPLES.map(async (d) => (await fetch(`/demo/case_12_${d}.jpg`)).blob()));
    await sendImages(blobs);
  }

  function pick(row: { id: string; title: string }) {
    setSheet(null);
    setMsgs((m) => [...m, { id: uid(), from: "me", kind: "text", text: row.title, at: now() }]);
    void call({ list_reply: row.id });
  }

  return (
    <div className={s.wrap}>
      <div className={s.phone}>
        <header className={s.head}>
          <a href="/" className={s.back} aria-label="Back to Form M Copilot">‹</a>
          <span className={s.avatar}>M</span>
          <div className={s.who}>
            <b>Form M Copilot</b>
            <small>{pending ? "typing…" : "web preview of the WhatsApp bot"}</small>
          </div>
        </header>

        <div className={s.notice}>
          Same bot code as the WhatsApp number: Meta has the number on hold pending business verification, so this preview runs it in the browser. Samples are synthetic.
        </div>

        <main className={s.feed}>
          {msgs.length === 0 && (
            <div className={s.empty}>
              <p>Say <b>hi</b>, choose a language, then send the three document photos.</p>
              <div className={s.quick}>
                <button onClick={() => sendText("hi")}>👋 Say hi</button>
                <button onClick={sendSamples}>📎 Send sample documents</button>
              </div>
            </div>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={`${s.row} ${m.from === "me" ? s.me : s.bot}`}>
              <div className={s.bubble}>
                {m.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.src} alt="document photo" className={s.img} />
                ) : (
                  <div className={s.text}><Rich text={m.text} /></div>
                )}
                {m.kind === "list" && (
                  <button className={s.listBtn} onClick={() => setSheet(m)}>☰ {m.button}</button>
                )}
                <span className={s.time}>{m.at}{m.from === "me" ? " ✓✓" : ""}</span>
              </div>
            </div>
          ))}
          {pending > 0 && (
            <div className={`${s.row} ${s.bot}`}>
              <div className={`${s.bubble} ${s.typing}`}><i /><i /><i /></div>
            </div>
          )}
          <div ref={end} />
        </main>

        {msgs.length > 0 && (
          <div className={s.chips}>
            <button onClick={sendSamples} disabled={pending > 0}>📎 Sample documents</button>
            <button onClick={() => sendText("check")} disabled={pending > 0}>check</button>
            <button onClick={() => sendText("new")} disabled={pending > 0}>new</button>
            <button onClick={() => sendText("language")} disabled={pending > 0}>language</button>
          </div>
        )}

        <form className={s.bar} onSubmit={(e) => { e.preventDefault(); sendText(draft); }}>
          <button type="button" className={s.icon} onClick={() => file.current?.click()} aria-label="Attach photos">＋</button>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message" aria-label="Message" />
          <button type="submit" className={s.send} aria-label="Send">➤</button>
          <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { void sendImages(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        </form>

        {sheet && (
          <div className={s.sheetBg} onClick={() => setSheet(null)}>
            <div className={s.sheet} onClick={(e) => e.stopPropagation()}>
              <h3>{sheet.button}</h3>
              {sheet.rows.map((r) => (
                <button key={r.id} onClick={() => pick(r)}>{r.title}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
