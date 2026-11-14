/**
 * WhatsApp conversation logic.
 *
 *  photo  -> read it (same extraction + money re-read as the web app), store it,
 *            reply with what was recognised and what is still missing
 *  3 docs -> cross-check, classify, draft, reply with the fix-list in the user's language
 *  text   -> commands: language names, "check", "new", "help"
 */
import { extractDocument } from "./extract";
import { isQuotaError } from "./llm";
import { analyze } from "./analyze";
import { explainIssues } from "./explain";
import { LANGUAGES, isLang, type Lang } from "./languages";
import { claimReport, deleteUser, getSession, logEvent, mergeDoc, resetSession, setFormQUsed, setLang, setMode, type BotMode } from "./store";
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
  fee_invoice: "school bill / hospital estimate",
  support_letter: "admission or doctor's letter",
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
  formq: {
    form: "Form Q",
    required: ["proforma_invoice"],
    optional: [],
    ask: "1️⃣ The supplier's *invoice* (or demand note)\n\nIf you've already used part of this quarter's USD 20,000, type it like *used 5000* first.",
  },
  forma: {
    form: "Form A",
    required: ["fee_invoice", "support_letter"],
    optional: [],
    ask: "1️⃣ The *school bill* (or hospital cost estimate)\n2️⃣ The *admission letter* (or overseas doctor's letter)\n\n⚠️ Don't send passports or tax documents here.",
  },
};
const MODE_ORDER: BotMode[] = ["import", "export", "formq", "forma"];
const MODE_TITLE: Record<BotMode, string> = { import: "an import (Form M)", export: "an export (Form NXP)", formq: "a small import (Form Q)", forma: "a school fees / medical (Form A)" };
const MODE_WORDS: Record<string, BotMode> = {
  import: "import", imports: "import", "form m": "import", formm: "import", importing: "import",
  export: "export", exports: "export", nxp: "export", "form nxp": "export", exporting: "export",
  "form q": "formq", formq: "formq", "form a": "forma", forma: "forma", "school fees": "forma", "medical": "forma",
};
async function modeOf(from: string): Promise<BotMode> {
  const s = await getSession(from).catch(() => null);
  return s?.mode && MODE_ORDER.includes(s.mode) ? s.mode : "import";
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
      if (id?.startsWith("mode:") && MODE_ORDER.includes(id.slice(5) as BotMode)) return onMode(m.from, id.slice(5) as BotMode, true);
    }
    if (m.type === "text" && m.text) return onText(m.from, m.text.body.trim());
    return sendText(m.from, `Send me photos of your documents, one photo per page:\n${MODES[await modeOf(m.from)].ask}`);
  } catch (e) {
    console.error("whatsapp handler", e);
    await logEvent({ sig_ok: true, has_sig: true, fields: "handler_error", note: String((e as Error)?.message ?? e).slice(0, 500) });
    await sendText(
      m.from,
      isQuotaError(e)
        ? "Sorry, the free AI allowance for today is used up, so I can't read photos right now. Please try again tomorrow."
        : "Sorry, I couldn't read that one. Please send it again in a minute.",
    ).catch(() => undefined);
  }
}

async function onText(from: string, text: string) {
  const t = text.toLowerCase();
  // Only full language names: two-letter codes collide with greetings ("hi" = Hindi).
  const lang = LANG_WORDS[t];
  if (lang) return onLanguage(from, lang);
  if (MODE_WORDS[t]) return onMode(from, MODE_WORDS[t]);
  const usedMatch = /^used\s+(?:usd\s*|\$)?([\d,]+(?:\.\d+)?)$/i.exec(t);
  if (usedMatch) {
    const used = Number(usedMatch[1].replace(/,/g, ""));
    await setFormQUsed(from, used);
    return sendText(from, `✅ Noted: USD ${money(used)} already used this quarter, so USD ${money(Math.max(0, 20000 - used))} is left. Now send the invoice.`);
  }
  if (["new", "reset", "restart", "start over", "clear"].includes(t)) {
    await resetSession(from).catch(() => undefined);
    const mode = await modeOf(from);
    return sendText(from, `🧾 New ${MODES[mode].form} check started. Send photos of:\n${MODES[mode].ask}\n\nTo check something else, type *import*, *export*, *form q* or *form a*.`);
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
      "👋 *Trade Copilot*",
      "I check your trade and FX documents *before* they reach the bank: imports (Form M), exports (Form NXP), small imports (Form Q) and school fees or medical bills (Form A).",
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
    { id: "mode:formq", title: "Small import · Form Q" },
    { id: "mode:forma", title: "Fees / medical · Form A" },
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
  const session = await getSession(from).catch(() => null);
  let mode = await modeOf(from);
  const fitsMode = (m: BotMode) => [...MODES[m].required, ...MODES[m].optional].includes(doc.doc_type);
  if (!fitsMode(mode)) {
    const other = MODE_ORDER.find(fitsMode);
    if (!other) {
      await sendText(from, "I couldn't tell what kind of document that is. Please send a clearer photo, one page per photo.");
      return;
    }
    if (Object.keys(session?.docs ?? {}).length === 0) {
      // Nothing sent yet: switch to the form this document belongs to.
      await setMode(from, other);
      mode = other;
      await sendText(from, `↪️ That's a *${DOC_NAME[doc.doc_type]}*, so I've switched to ${MODE_TITLE[other]} check.`);
    } else {
      const word = { import: "import", export: "export", formq: "form q", forma: "form a" }[other];
      await sendText(from, `That's a *${DOC_NAME[doc.doc_type]}*, which belongs to ${MODE_TITLE[other]} check, but you've already sent documents for ${MODE_TITLE[mode]} check. Type *${word}* to start that check instead, or *check* to finish this one.`);
      return;
    }
  }
  const M = MODES[mode];
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
  if (doc.doc_type === "fee_invoice") return `\n${doc.institution ?? "?"} · ${doc.person_name ?? "?"} · ${doc.currency ?? ""} ${money(doc.amount)}`;
  if (doc.doc_type === "support_letter") return `\n${doc.institution ?? "?"} · ${doc.person_name ?? "?"}`;
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
  const mode: BotMode = session?.mode && MODE_ORDER.includes(session.mode) ? session.mode : "import";
  const { issues, hs, draft, deadline } = await analyze(docs, [], { mode, used: Number(session?.fq_used ?? 0) });
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
    (mode === "formq"
      ? [
          "📝 *Form Q draft*",
          `Supplier: ${get("Supplier (beneficiary)", "Name") ?? "?"}`,
          `Value: ${get("Financials", "Currency") ?? ""} ${money(get("Financials", "Total value"))}`,
          (() => {
            const left = get("Quarterly allowance", "Left after this (USD)");
            return `Allowance: USD ${money(get("Quarterly allowance", "Already used (USD)"))} used · ${typeof left === "number" ? `USD ${money(left)} left after this` : left ?? "currency not USD"}`;
          })(),
          goods,
        ]
      : mode === "forma"
      ? [
          "📝 *Form A draft*",
          `${get("Purpose", "Type") ?? ""}: ${get("Purpose", "Programme / treatment") ?? "?"}`,
          `For: ${get("Student", "Name") ?? get("Patient", "Name") ?? "?"}`,
          `Pay to: ${get("Beneficiary", "Institution") ?? "?"} · ${get("Beneficiary", "Account / IBAN") ? `${get("Beneficiary", "Bank") ?? ""} ${get("Beneficiary", "Account / IBAN")}`.trim() : "no bank details"}`,
          `Amount: ${get("Financials", "Currency") ?? ""} ${money(get("Financials", "Total value"))}`,
        ]
      : mode === "export"
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
    `_Draft for review only; verify with the bank${mode === "export" || mode === "forma" ? " on the CBN Trade Monitoring System" : mode === "import" ? " on the Nigeria Single Window" : ""}._\nType *new* to check another set, *import*, *export*, *form q* or *form a* to switch, or a language name to change language.`,
  );
  await sendText(from, parts.join("\n\n"));
}
