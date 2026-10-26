/**
 * Languages for importers (Nigeria and West Africa) and for suppliers in the
 * countries Nigeria imports most from, so the fix-list can be sent straight
 * to the supplier who has to correct the document.
 */
export const LANGUAGES = {
  en: { label: "English", prompt: "plain, simple English" },
  ha: { label: "Hausa", prompt: "Hausa (Northern Nigeria usage, Boko/Latin script)" },
  yo: { label: "Yorùbá", prompt: "Yoruba with correct tone marks" },
  ig: { label: "Igbo", prompt: "Igbo with standard orthography" },
  pcm: { label: "Pidgin", prompt: "Nigerian Pidgin English" },
  fr: { label: "Français", prompt: "French (West African business usage)" },
  ar: { label: "العربية", prompt: "Modern Standard Arabic" },
  sw: { label: "Kiswahili", prompt: "Swahili" },
  pt: { label: "Português", prompt: "Portuguese" },
  zh: { label: "中文", prompt: "Simplified Chinese (for a supplier in China)" },
  hi: { label: "हिन्दी", prompt: "Hindi (for a supplier in India)" },
  tr: { label: "Türkçe", prompt: "Turkish (for a supplier in Turkey)" },
  es: { label: "Español", prompt: "Spanish" },
  de: { label: "Deutsch", prompt: "German (for a supplier in Germany)" },
} as const;
export type Lang = keyof typeof LANGUAGES;
export const isLang = (x: unknown): x is Lang => typeof x === "string" && x in LANGUAGES;
