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
import { claimReport, deleteUser, getSession, logEvent, mergeDoc, resetSession, setLang, setMode, type BotMode } from "./store";
import * as wa from "./whatsapp";
import type { DocumentSet, Extraction, Issue } from "./schema";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where replies go. The real WhatsApp Cloud API by default; the website's
 * WhatsApp preview runs the exact same conversation logic with a transport
 * that collects replies instead of sending them.
 */
export interface Transport {
  sendText(to: string, text: string): Promise<unknown>;
  sendList(to: string, body: string, button: string, rows: { id: string; title: string }[]): Promise<unknown>;
  markRead(messageId: string): Promise<unknown>;
  downloadMedia(mediaId: string): Promise<{ dataUrl: string }>;
}
const whatsappTransport: Transport = {
  sendText: wa.sendText,
  sendList: wa.sendList,
  markRead: wa.markRead,
  downloadMedia: wa.downloadMedia,
};
const transportStore = new AsyncLocalStorage<Transport>();
const t = () => transportStore.getStore() ?? whatsappTransport;
const sendText = (to: string, text: string) => t().sendText(to, text);
const sendList = (to: string, body: string, button: string, rows: { id: string; title: string }[]) => t().sendList(to, body, button, rows);
const markRead = (id: string) => t().markRead(id);
const downloadMedia = (id: string) => t().downloadMedia(id);

/** Run the bot with a custom transport (used by the web preview). */
export function withTransport<T>(transport: Transport, fn: () => Promise<T>): Promise<T> {
  return transportStore.run(transport, fn);
}

const DOC_NAME: Record<string, string> = {
  proforma_invoice: "invoice",
  packing_list: "packing list",
  insurance_certificate: "insurance certificate",
  bill_of_lading: "bill of lading",
  nepc_certificate: "NEPC certificate",
  clean_certificate_of_inspection: "Clean Certificate of Inspection (CCI)",
  certificate_of_origin: "certificate of origin",
};
/** Documents each check needs before the report runs on its own; optional ones are checked if sent. */
const MODES: Record<BotMode, { form: string; required: string[]; optional: string[]; ask: string }> = {
  import: {
    form: "Form M",
    required: ["proforma_invoice", "packing_list", "insurance_certificate"],
    optional: [],
    ask: "1️⃣ *Proforma invoice*\n2️⃣ *Packing list*\n3️⃣ *Insurance certificate*",
  },
  export: {
    form: "Form NXP",
    required: ["proforma_invoice", "packing_list", "bill_of_lading", "nepc_certificate"],
    optional: ["clean_certificate_of_inspection", "certificate_of_origin"],
    ask: "1️⃣ *Commercial invoice*\n2️⃣ *Packing list*\n3️⃣ *Bill of lading*\n4️⃣ *NEPC certificate*\n➕ CCI and certificate of origin if you have them (send them first)",
  },
};
const MODE_WORDS: Record<string, BotMode> = {
  import: "import", imports: "import", "form m": "import", formm: "import", importing: "import",
  export: "export", exports: "export", nxp: "export", "form nxp": "export", exporting: "export",
};
async function modeOf(from: string): Promise<BotMode> {
  const s = await getSession(from).catch(() => null);
  return s?.mode === "export" ? "export" : "import";
}

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
      if (id === "mode:import" || id === "mode:export") return onMode(m.from, id.slice(5) as BotMode, true);
    }
    if (m.type === "text" && m.text) return onText(m.from, m.text.body.trim());
    return sendText(m.from, `Send me photos of your documents, one photo per page:\n${MODES[await modeOf(m.from)].ask}`);
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
  if (MODE_WORDS[t]) return onMode(from, MODE_WORDS[t]);
  if (["new", "reset", "restart", "start over", "clear"].includes(t)) {
    await resetSession(from).catch(() => undefined);
    const mode = await modeOf(from);
    return sendText(from, `🧾 New ${MODES[mode].form} check started. Send photos of:\n${MODES[mode].ask}\n\nType *${mode === "import" ? "export" : "import"}* to switch to ${mode === "import" ? "an export (Form NXP)" : "an import (Form M)"} check.`);
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
      "I check your trade documents *before* they reach the bank: imports (Form M) and exports (Form NXP).",
      "Send the photos and I cross-check every figure and name, suggest HS codes, start the clock on your deadline and send you a fix-list.",
      "Type *check* to check what you've sent so far, *new* to start again, *delete my data* to erase everything.",
    ].join("\n\n"),
  );
  await askMode(from);
}

function askMode(from: string) {
  return sendList(from, "What are you checking?", "Choose", [
    { id: "mode:import", title: "Import · Form M" },
    { id: "mode:export", title: "Export · Form NXP" },
  ]);
}

async function onMode(from: string, mode: BotMode, fromMenu = false) {
  await setMode(from, mode);
  const session = await getSession(from).catch(() => null);
  // Right after "hi", ask the language once; a typed "import"/"export" just switches.
  if (fromMenu && (!session?.lang || session.lang === "en")) {
    await sendText(from, `✅ *${MODES[mode].form}* check.`);
    return askLanguage(from);
  }
  return sendText(from, `✅ *${MODES[mode].form}* check. Send photos of:\n${MODES[mode].ask}`);
}

function askLanguage(from: string) {
  const rows = (["en", "ha", "yo", "ig", "pcm", "fr", "ar", "zh", "hi", "tr"] as Lang[]).map((l) => ({ id: l, title: LANGUAGES[l].label }));
  return sendList(from, "Which language should I reply in? You can also type it, e.g. *Hausa*.", "Choose language", rows);
}

async function onLanguage(from: string, lang: Lang) {
  await setLang(from, lang);
  await sendText(from, `✅ Language: *${LANGUAGES[lang].label}*. Now send photos of:\n${MODES[await modeOf(from)].ask}`);
}

async function onPhoto(from: string, mediaId: string) {
  const { dataUrl } = await downloadMedia(mediaId);
  const r = await extractDocument(dataUrl);
  const doc: Extraction = r.extraction;
  const mode = await modeOf(from);
  const M = MODES[mode];
  if (![...M.required, ...M.optional].includes(doc.doc_type)) {
    const other: BotMode = mode === "import" ? "export" : "import";
    const fits = [...MODES[other].required, ...MODES[other].optional].includes(doc.doc_type);
    await sendText(from, fits
      ? `That looks like a *${DOC_NAME[doc.doc_type]}*, which belongs to ${other === "export" ? "an export (Form NXP)" : "an import (Form M)"} check. Type *${other}* to switch, then send the photos again.`
      : "I couldn't use that document here. For school fees, medical bills or Form Q, use the web app: form-m-copilot.vercel.app");
    return;
  }
  const held = await mergeDoc(from, doc);
  const missing = M.required.filter((d) => !held.includes(d));

  const lines = [`✅ Got your *${DOC_NAME[doc.doc_type]}*` + summary(doc)];
  if (r.verification?.rereads) lines.push(`🔁 Amounts read ${r.verification.rereads + 1}× independently${r.verification.corrected.length ? " (one reading corrected)" : ", all agree"}.`);
  if (missing.length) lines.push(`Still need: ${missing.map((d) => `*${DOC_NAME[d]}*`).join(", ")}. (Type *check* to check now.)`);
  await sendText(from, lines.join("\n"));
  if (!missing.length) await report(from, M.required.length, false);
}

function summary(doc: Extraction): string {
  if (doc.doc_type === "proforma_invoice") {
    return `\n${doc.seller.name ?? "?"} → ${doc.buyer.name ?? "?"}\n${doc.lines.length} item(s) · ${doc.currency ?? ""} ${money(doc.total)}${doc.incoterm ? ` · ${doc.incoterm}` : ""}`;
  }
  if (doc.doc_type === "packing_list") {
    return `\n${doc.lines.length} line(s) · ${doc.lines.reduce((s, l) => s + (l.packages ?? 0), 0)} package(s)`;
  }
  if (doc.doc_type === "insurance_certificate") return `\n${doc.insurer ?? "?"} · ${doc.currency ?? ""} ${money(doc.sum_insured)}`;
  if (doc.doc_type === "bill_of_lading") return `\nB/L ${doc.bl_number ?? "?"} · shipped ${doc.shipped_on_board_date ?? "?"} · ${doc.packages ?? "?"} packages`;
  if (doc.doc_type === "nepc_certificate") return `\n${doc.exporter_name ?? "?"} · expires ${doc.expiry_date ?? "?"}`;
  if (doc.doc_type === "clean_certificate_of_inspection") return `\n${doc.cci_number ?? "?"} · ${doc.currency ?? ""} ${money(doc.fob_value)}`;
  if (doc.doc_type === "certificate_of_origin") return `\nOrigin: ${doc.country_of_origin ?? "?"}`;
  return "";
}

async function report(from: string, minDocs: number, manual: boolean) {
  const docs = (await claimReport(from, minDocs)) as DocumentSet | null;
  if (!docs) {
    if (manual) await sendText(from, "Send at least one document photo first, then type *check*.");
    return;
  }
  const session = await getSession(from);
  const lang = (session?.lang && isLang(session.lang) ? session.lang : "en") as Lang;
  const mode: BotMode = session?.mode === "export" ? "export" : "import";
  const { issues, hs, draft, deadline } = await analyze(docs, [], { mode });
  const errors = issues.filter((i) => i.severity === "error");
  const shown: Issue[] = [...errors, ...issues.filter((i) => i.severity === "warning")];
  const notes = issues.filter((i) => i.severity === "info");
  const explained = await explainIssues(shown, lang).catch(() => explainIssues(shown, "en"));

  const parts: string[] = [];
  parts.push(
    errors.length
      ? `❌ *${errors.length} problem${errors.length > 1 ? "s" : ""} to fix before submitting*`
      : "✅ *No problems found.* The documents are consistent.",
  );
  explained.forEach((x, i) => parts.push(`*${i + 1}. ${x.title}*\n${x.body}`));
  notes.forEach((n) => parts.push(`ℹ️ _${n.title}_`));

  if (deadline) {
    const when = deadline.days_left < 0 ? `*${Math.abs(deadline.days_left)} days overdue*` : `*${deadline.days_left} days left*`;
    parts.push(`⏳ *${deadline.title}*: ${when}, due *${deadline.deadline}*\n_${deadline.basis}_`);
  }

  const section = (title: string) => draft.sections.find((s) => s.title === title)?.fields ?? [];
  const get = (title: string, label: string) => section(title).find((f) => f.label === label)?.value;
  const goods = draft.items
    .map((it, k) => {
      const sug = hs.find((h) => h.line === k);
      const code = it.hs_code ?? (sug?.code ? `${sug.code} (suggested)` : "needs more detail");
      return `• ${it.description ?? "—"}: *${code}*`;
    })
    .join("\n");
  const missing = draft.missing.length ? `Missing: ${draft.missing.slice(0, 6).join("; ")}` : "";
  parts.push(
    (mode === "export"
      ? [
          "📝 *Form NXP draft*",
          `Exporter: ${get("Exporter", "Name") ?? "?"} · NEPC ${get("Exporter", "NEPC certificate no.") ?? "missing"}`,
          `Buyer: ${get("Buyer (consignee)", "Name") ?? "?"}`,
          `Value: ${get("Financials", "Currency") ?? ""} ${money(get("Financials", "Total value"))} (${get("Financials", "Delivery terms") ?? "no Incoterm"})`,
          `Route: ${get("Shipment", "Port of loading") ?? "?"} → ${get("Shipment", "Port of discharge") ?? "?"} · B/L ${get("Shipment", "Bill of lading no.") ?? "?"}`,
          goods,
          missing,
        ]
      : [
          "📝 *Form M draft*",
          `Value: ${get("Financials", "Currency") ?? ""} ${money(get("Financials", "Total value"))} (${get("Shipment", "Terms of delivery (Incoterm)") ?? "no Incoterm"})`,
          `Route: ${get("Shipment", "Port of loading") ?? "?"} → ${get("Shipment", "Port of discharge") ?? "?"}`,
          `Origin: ${get("Shipment", "Country of origin") ?? "missing"}`,
          goods,
          missing,
        ]
    ).filter(Boolean).join("\n"),
  );
  parts.push(
    `_Draft for review only; verify on the ${mode === "export" ? "CBN Trade Monitoring System" : "Nigeria Single Window"}._\nType *new* to check another set, *${mode === "export" ? "import" : "export"}* to switch, or a language name to change language.`,
  );
  await sendText(from, parts.join("\n\n"));
}
