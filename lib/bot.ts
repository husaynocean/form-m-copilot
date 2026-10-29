/**
 * WhatsApp conversation logic.
 *
 *  photo  -> read it (same extraction + money re-read as the web app), store it,
 *            reply with what was recognised and what is still missing
 *  3 docs -> cross-check, classify, draft, reply with the fix-list in the user's language
 *  text   -> commands: language names, "check", "new", "help"
 */
import { extractDocument } from "./extract";
import { analyze } from "./analyze";
import { explainIssues } from "./explain";
import { LANGUAGES, isLang, type Lang } from "./languages";
import { claimReport, deleteUser, getSession, logEvent, mergeDoc, resetSession, setLang } from "./store";
import { downloadMedia, markRead, sendList, sendText } from "./whatsapp";
import type { DocumentSet, Extraction, Issue } from "./schema";

const DOC_NAME: Record<string, string> = {
  proforma_invoice: "proforma invoice",
  packing_list: "packing list",
  insurance_certificate: "insurance certificate",
};
const ALL_DOCS = Object.keys(DOC_NAME);

// Words people type to pick a language (English names, native names, codes).
const LANG_WORDS: Record<string, Lang> = {
  english: "en", hausa: "ha", yoruba: "yo", "yorùbá": "yo", igbo: "ig", pidgin: "pcm", "naija": "pcm",
  french: "fr", "français": "fr", francais: "fr", arabic: "ar", "العربية": "ar", swahili: "sw", kiswahili: "sw",
  portuguese: "pt", "português": "pt", chinese: "zh", mandarin: "zh", "中文": "zh", hindi: "hi", "हिन्दी": "hi",
  turkish: "tr", "türkçe": "tr", spanish: "es", "español": "es", german: "de", deutsch: "de",
};

export interface IncomingMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename?: string };
  interactive?: { type: string; list_reply?: { id: string; title: string }; button_reply?: { id: string } };
}

const money = (n: unknown) =>
  typeof n === "number" ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(n ?? "—");

export async function handleMessage(m: IncomingMessage) {
  await markRead(m.id);
  try {
    if (m.type === "image" || (m.type === "document" && m.document?.mime_type.startsWith("image/"))) {
      return await onPhoto(m.from, (m.image ?? m.document)!.id);
    }
    if (m.type === "document") {
      return sendText(m.from, "I can read *photos* (JPG/PNG) of your documents for now. Please send a clear photo of each page.");
    }
    if (m.type === "interactive") {
      const id = m.interactive?.list_reply?.id ?? m.interactive?.button_reply?.id;
      if (id && isLang(id)) return onLanguage(m.from, id);
    }
    if (m.type === "text" && m.text) return onText(m.from, m.text.body.trim());
    return sendText(m.from, "Send me photos of your *proforma invoice*, *packing list* and *insurance certificate*, one photo per page.");
  } catch (e) {
    console.error("whatsapp handler", e);
    await logEvent({ sig_ok: true, has_sig: true, fields: "handler_error", note: String((e as Error)?.message ?? e).slice(0, 500) });
    await sendText(m.from, "Sorry, something went wrong on my side. Please try again in a minute.").catch(() => undefined);
  }
}

async function onText(from: string, text: string) {
  const t = text.toLowerCase();
  // Only full language names: two-letter codes collide with greetings ("hi" = Hindi).
  const lang = LANG_WORDS[t];
  if (lang) return onLanguage(from, lang);
  if (["new", "reset", "restart", "start over", "clear"].includes(t)) {
    await resetSession(from).catch(() => undefined);
    return sendText(from, "🧾 New check started. Send photos of the proforma invoice, packing list and insurance certificate.");
  }
  if (["check", "done", "go", "finish"].includes(t)) return report(from, 1, true);
  if (["delete my data", "delete", "stop"].includes(t)) {
    await deleteUser(from);
    return sendText(from, "🗑️ Done. I've deleted your documents and settings.");
  }
  if (["language", "lang", "languages"].includes(t)) return askLanguage(from);
  return welcome(from);
}

async function welcome(from: string) {
  await sendText(
    from,
    [
      "👋 *Form M Copilot*",
      "I check your import documents for Form M errors *before* they reach the bank.",
      "1️⃣ Send a photo of your *proforma invoice*\n2️⃣ Your *packing list*\n3️⃣ Your *insurance certificate*",
      "When all three are in, I cross-check every figure and name, suggest HS codes and send you a fix-list.",
      "Type *check* to check what you've sent so far, *new* to start again, *delete my data* to erase everything.",
    ].join("\n\n"),
  );
  await askLanguage(from);
}

function askLanguage(from: string) {
  const rows = (["en", "ha", "yo", "ig", "pcm", "fr", "ar", "zh", "hi", "tr"] as Lang[]).map((l) => ({ id: l, title: LANGUAGES[l].label }));
  return sendList(from, "Which language should I reply in? You can also type it, e.g. *Hausa*.", "Choose language", rows);
}

async function onLanguage(from: string, lang: Lang) {
  await setLang(from, lang);
  await sendText(from, `✅ Language: *${LANGUAGES[lang].label}*. Now send your document photos.`);
}

async function onPhoto(from: string, mediaId: string) {
  const { dataUrl } = await downloadMedia(mediaId);
  const r = await extractDocument(dataUrl);
  const doc: Extraction = r.extraction;
  const held = await mergeDoc(from, doc);
  const missing = ALL_DOCS.filter((d) => !held.includes(d));

  const lines = [`✅ Got your *${DOC_NAME[doc.doc_type]}*` + summary(doc)];
  if (r.verification?.rereads) lines.push(`🔁 Amounts read ${r.verification.rereads + 1}× independently${r.verification.corrected.length ? " (one reading corrected)" : ", all agree"}.`);
  if (missing.length) lines.push(`Still need: ${missing.map((d) => `*${DOC_NAME[d]}*`).join(", ")}. (Type *check* to check now.)`);
  await sendText(from, lines.join("\n"));
  if (!missing.length) await report(from, ALL_DOCS.length, false);
}

function summary(doc: Extraction): string {
  if (doc.doc_type === "proforma_invoice") {
    return `\n${doc.seller.name ?? "?"} → ${doc.buyer.name ?? "?"}\n${doc.lines.length} item(s) · ${doc.currency ?? ""} ${money(doc.total)}${doc.incoterm ? ` · ${doc.incoterm}` : ""}`;
  }
  if (doc.doc_type === "packing_list") {
    return `\n${doc.lines.length} line(s) · ${doc.lines.reduce((s, l) => s + (l.packages ?? 0), 0)} package(s)`;
  }
  return `\n${doc.insurer ?? "?"} · ${doc.currency ?? ""} ${money(doc.sum_insured)}`;
}

async function report(from: string, minDocs: number, manual: boolean) {
  const docs = (await claimReport(from, minDocs)) as DocumentSet | null;
  if (!docs) {
    if (manual) await sendText(from, "Send at least one document photo first, then type *check*.");
    return;
  }
  const session = await getSession(from);
  const lang = (session?.lang && isLang(session.lang) ? session.lang : "en") as Lang;
  const { issues, hs, draft } = await analyze(docs);
  const errors = issues.filter((i) => i.severity === "error");
  const shown: Issue[] = [...errors, ...issues.filter((i) => i.severity === "warning")];
  const explained = await explainIssues(shown, lang).catch(() => explainIssues(shown, "en"));

  const parts: string[] = [];
  parts.push(
    errors.length
      ? `❌ *${errors.length} problem${errors.length > 1 ? "s" : ""} to fix before submitting*`
      : "✅ *No problems found.* The documents are consistent.",
  );
  explained.forEach((x, i) => parts.push(`*${i + 1}. ${x.title}*\n${x.body}`));

  const fin = draft.sections.find((s) => s.title === "Financials")?.fields ?? [];
  const get = (label: string) => fin.find((f) => f.label === label)?.value;
  const ship = draft.sections.find((s) => s.title === "Shipment")?.fields ?? [];
  const gs = (label: string) => ship.find((f) => f.label === label)?.value;
  const goods = draft.items
    .map((it, k) => {
      const sug = hs.find((h) => h.line === k);
      const code = it.hs_code ?? (sug?.code ? `${sug.code} (suggested)` : "needs more detail");
      return `• ${it.description ?? "—"}: *${code}*`;
    })
    .join("\n");
  parts.push(
    [
      "📝 *Form M draft*",
      `Value: ${get("Currency") ?? ""} ${money(get("Total value"))} (${gs("Terms of delivery (Incoterm)") ?? "no Incoterm"})`,
      `Route: ${gs("Port of loading") ?? "?"} → ${gs("Port of discharge") ?? "?"}`,
      `Origin: ${gs("Country of origin") ?? "missing"}`,
      goods,
      draft.missing.length ? `Missing: ${draft.missing.slice(0, 6).join("; ")}` : "",
    ].filter(Boolean).join("\n"),
  );
  parts.push("_Draft for review only; verify on the Nigeria Single Window._\nType *new* to check another set, or a language name to switch language.");
  await sendText(from, parts.join("\n\n"));
}
