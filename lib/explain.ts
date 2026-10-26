import { chat, parseJsonObject, type ProviderConfig } from "./llm";
import type { Issue } from "./schema";

/**
 * Explain the fix-list in the importer's or supplier's language (see lib/languages.ts).
 * Verification: every figure, code and document number in the original must
 * appear unchanged in the translation. If any is lost or altered, the model is
 * asked to fix it; if it still fails, we fall back to English for that item.
 */

import { LANGUAGES, type Lang } from "./languages";
export { LANGUAGES, isLang, type Lang } from "./languages";

/** Numbers, codes and references that must survive translation verbatim. */
export function protectedTokens(text: string): string[] {
  const matches = text.match(/[A-Z]{2,}[-/A-Z0-9]*\d[-/A-Z0-9]*|\d[\d,]*(?:\.\d+)?/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/,/g, "")))].filter((m) => m.length > 0);
}

export function missingTokens(original: string, translated: string): string[] {
  const t = translated.replace(/,/g, "");
  return protectedTokens(original).filter((tok) => !t.includes(tok));
}

export interface Explained { code: string; title: string; body: string; verified: boolean }

export async function explainIssues(issues: Issue[], lang: Lang, provider?: ProviderConfig): Promise<Explained[]> {
  if (lang === "en" || issues.length === 0) {
    return issues.map((i) => ({ code: i.code, title: i.title, body: `${i.detail} ${i.fix}`, verified: true }));
  }
  const items = issues.map((i, n) => ({ n, title: i.title, text: `${i.detail} Fix: ${i.fix}` }));
  const system =
    `Translate each item into ${LANGUAGES[lang].prompt}. The reader is an importer or their overseas supplier. ` +
    "Write the way a helpful bank officer would say it on WhatsApp: short, clear, respectful. " +
    "Copy every number, amount, currency code, HS code, date and document number EXACTLY as written, using Western digits (0-9) even in Arabic, Hindi or Chinese. Do not convert or round. " +
    "Keep company names unchanged. " +
    'Reply as JSON: {"items":[{"n":0,"title":"...","body":"..."}]}';

  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: JSON.stringify(items) },
  ];
  let out: { n: number; title: string; body: string }[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat(messages, { provider, json: true, maxTokens: 12000, temperature: 0.2 });
    try {
      out = ((parseJsonObject(res.text) as { items?: typeof out }).items ?? []);
    } catch {
      out = [];
    }
    const broken = items
      .map((it) => {
        const got = out.find((o) => o.n === it.n);
        const lost = got ? missingTokens(it.text, `${got.title} ${got.body}`) : ["(missing item)"];
        return { n: it.n, lost };
      })
      .filter((b) => b.lost.length);
    if (broken.length === 0) break;
    messages.push({ role: "assistant" as never, content: res.text });
    messages.push({
      role: "user",
      content:
        "Some figures were changed or dropped. Keep these exactly: " +
        broken.map((b) => `item ${b.n}: ${b.lost.join(", ")}`).join("; ") +
        ". Return the full corrected JSON.",
    });
  }

  return issues.map((issue, n) => {
    const got = out.find((o) => o.n === n);
    const original = `${issue.detail} Fix: ${issue.fix}`;
    const ok = Boolean(got) && missingTokens(original, `${got!.title} ${got!.body}`).length === 0;
    return ok
      ? { code: issue.code, title: got!.title, body: got!.body, verified: true }
      : { code: issue.code, title: issue.title, body: `${issue.detail} ${issue.fix}`, verified: false };
  });
}
