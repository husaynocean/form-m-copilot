# Trade Copilot

AI that checks Nigerian trade and FX documents before they reach the bank: **Form M** (imports), **Form NXP** (exports), **Form Q** (small imports) and **Form A** (school fees, medical bills), and tracks their deadlines.

*Formerly Form M Copilot, built for the Meta Global AI Developer Hackathon; the old address form-m-copilot.vercel.app still works.*

**Hackathon demo video (1:39, Form M only):** https://youtu.be/CLK3YI_W_q8 · **Live app:** https://trade-copilot-ng.vercel.app

For Form M, an importer sends photos of their **proforma invoice**, **packing list** and **marine insurance certificate**. Trade Copilot:

1. extracts every field into structured JSON (vision model),
2. cross-checks the documents against each other (totals, quantities, names, ports, currency, insured value, dates),
3. suggests HS codes with reasons,
4. returns a pre-filled Form M draft plus a plain-language fix-list in 14 languages (including Hausa, Yoruba, Igbo, Pidgin, French, Arabic and Chinese), on WhatsApp or the web.

The model is swappable (`lib/llm.ts`): the live demo runs on Google Gemini's free tier, and the same pipeline runs on open-weights models such as Meta Muse Spark Open, so a bank could host it inside its own network.

First built for the Meta Global AI Developer Hackathon (Indie Developer track, "Build for Your World"), October–November 2026.

## What was built when

Commit history is the record.

- **26 Oct 2026 (before kickoff):** synthetic test data only (`samples/`, `scripts/generate_samples.py`). This is test material, not a product feature, and is not shown as a feature in the demo.
- **26 Oct – 4 Nov 2026 (build period):** all application code: extraction, validation agent, HS-code assistant, Form M draft, WhatsApp channel, open-weights deployment.
- **After the hackathon (Nov 2026):** the hackathon's Muse Spark Open endpoint was switched off, so the live demo moved to Google Gemini, with automatic fallback between models.

## Results

Measured on Muse Spark Open (Baseten) during the hackathon. Re-run on Gemini 3.5 Flash-Lite on 12 Nov 2026 with the same scores for extraction, error detection and HS codes.

| Test | Result |
|---|---|
| Field extraction from phone-style photos (12 cases, 36 documents) | **672 / 672 fields** correct, 36 / 36 documents classified |
| Planted document errors caught (11 error types) | **14 / 14**, 0 false alarms |
| Printed total preserved across repeated reads (money re-read) | **12 / 12** |
| HS-code assistant (30 hand-checked import descriptions) | **28 / 30 exact, 0 wrong**, 2 declined for missing detail |
| Fix-list translations (Hausa, Yoruba, Igbo, Pidgin, Chinese, French) | every figure verified unchanged |
| Full check, 3 documents | ~15 s on the web app, ~28 s over the chat bot |

Synthetic, clean printed documents; real crumpled or handwritten paperwork will be harder. Raw outputs are in `eval-results/`.

## What it checks (expanded Nov 2026)

After the hackathon the same engine was extended from Form M to the other bank trade and FX forms. Pick the form at the top of the web app.

| Form | Documents | Checks | Deadline clock |
|---|---|---|---|
| **Form M** (imports) | proforma invoice, packing list, insurance certificate | arithmetic, names, quantities, ports, currency, proforma older than 3 months, insured value below **110%** of the proforma, HS codes | Form M validity: 180 days (general goods) or 365 days (plant & machinery), one extension by the bank |
| **Form NXP** (exports) | invoice, packing list, bill of lading, NEPC certificate, plus CCI and certificate of origin | exporter/consignee across all documents, NEPC name and expiry, ports, packages, gross weight, **CCI** value/quantity/weight/HS code/currency, inspection dated before shipment, the same **NXP number** on every document, certificate of origin states Nigeria | Repatriation: 180 days (non-oil) or 90 days (oil & gas) from the bill of lading date, no extensions |
| **Form Q** (small imports) | supplier invoice | **USD 20,000 per quarter** including what was already used, physical goods only (services go through Form A), arithmetic, proforma age | Shipping documents due 60 days after payment |
| **Form A** (school fees, medical) | school bill + admission letter, or hospital estimate + doctor's letter | same person and institution on both, beneficiary bank details present, tuition limit, due date | Payment due date |

Before reporting a numeric mismatch (packages, weights, CCI value or quantity), the agent re-reads the disputed number from the photo twice; a misread is corrected instead of reported.

**Deadline tracker** (`/tracker`): "Save & track" stores a summary of the check (never the photos) under a private link, with calendar reminders (`.ics`, alerts 30, 7 and 1 day before) and optional daily email reminders (`/api/cron/reminders`, sent through Brevo once `BREVO_API_KEY` and `MAIL_FROM` are set).

**WhatsApp**: the bot asks "Import · Form M" or "Export · Form NXP" and handles both. Form Q and Form A are on the web app.

Rules and limits come from the bank's published requirements and secondary summaries of the 2026 CBN FX Manual; they are a pre-check for review, not regulatory advice. Passports and tax documents are never requested: Form A lists them as things to bring to the bank.

### Results on the synthetic packs (Gemini 3.5 Flash-Lite, read from phone-style photos)

| Pack | Documents classified | Planted errors caught | False alarms |
|---|---|---|---|
| Form M, 12 cases | 36 / 36 | 14 / 14 | 0 |
| Form NXP, 10 cases (rules on answer keys) | – | 18 / 18 | 0 |
| Form NXP, first 6 cases from photos | 24 / 24 | 10 / 10 | 0 |
| Form Q + Form A, 8 cases | 12 / 12 | 9 / 9 | 0 |

`npx tsx scripts/eval-rules.ts`, `eval-export.ts`, `eval-forms.ts` (add `--model` to read the photos). The free Gemini tier allows about 500 requests a day per model, roughly 60–100 document checks.

## Try it

- Demo video: https://youtu.be/CLK3YI_W_q8
- Web app: https://trade-copilot-ng.vercel.app (tap "Try a problem file")
- WhatsApp bot, web preview: https://trade-copilot-ng.vercel.app/whatsapp — the real WhatsApp number receives messages; Meta blocks outgoing messages until business verification, so the same bot code (`lib/bot.ts`) runs here with a web transport.

## Synthetic test pack

`samples/` holds 12 synthetic import cases (3 documents each, as clean PDFs and phone-style photos) with a ground-truth `answer_key.json` per case. 3 cases are clean, 9 contain deliberate errors:

| Code | Meaning |
|---|---|
| INVOICE_TOTAL_MISMATCH | Printed total ≠ sum of lines + freight/insurance |
| PACKING_QTY_MISMATCH | Packing list quantity ≠ invoice quantity |
| BENEFICIARY_NAME_MISMATCH | Supplier name differs across documents |
| IMPORTER_NAME_MISMATCH | Importer name differs across documents |
| MISSING_INCOTERM / MISSING_COUNTRY_OF_ORIGIN | Required field absent |
| VAGUE_DESCRIPTION | Goods description too vague to classify |
| CURRENCY_MISMATCH | Invoice and insurance currencies differ |
| INSURED_VALUE_TOO_LOW | Sum insured below goods value |
| PORT_MISMATCH | Port of discharge differs across documents |
| PROFORMA_EXPIRED | Proforma validity date has passed |

Regenerate with `python3 scripts/generate_samples.py` (needs `reportlab`, `Pillow`, `pdftoppm`).

**All companies, people, addresses, RC and policy numbers are invented. No real customer or bank documents are used anywhere in this project.**

## How it works

```
photos ──► 1. Extract (vision model → typed JSON, Zod-validated, self-repair on bad JSON)
       ──► 2. Validate (deterministic TypeScript rules: arithmetic, names, quantities, ports, currency, dates)
       ──► 3. HS-code assistant (BM25 over 5,612 official HS 2022 subheadings → model picks from shortlist → code verified)
       ──► 4. Form M draft (every field traced to its source document) + fix-list
       ──► 5. Fix-list in English, Hausa or Pidgin (every figure verified unchanged after translation)
```

The model only reads documents. Every flag is computed in code, so results are reproducible and explainable to a bank officer.

| Path | What |
|---|---|
| `lib/llm.ts` | One client for any OpenAI-compatible server (Google Gemini, Meta Model API, Baseten, self-hosted open weights), with model fallback |
| `lib/extract.ts` | Classify + extract prompt, schema validation, repair loop |
| `lib/validate.ts` | Cross-document rule engine |
| `lib/formm.ts` | Form M draft builder |
| `lib/hs.ts` | HS retrieval, model choice with verification, printed-code checks |
| `lib/explain.ts` | Hausa / Pidgin explanations with number-preservation check |
| `app/api/check` | Upload → extract (parallel) → validate → draft |
| `scripts/eval-rules.ts` | Rule engine vs. answer keys (perfect extraction) |
| `scripts/eval-hs.ts` | HS assistant on 30 hand-checked import descriptions (`samples/hs_testset.json`) |
| `scripts/eval-extract.ts` | Full pipeline on the photos vs. answer keys (needs a model key) |

## Run locally

```bash
npm install
cp .env.example .env.local   # add a key for META, BASETEN or an OpenAI-compatible endpoint
npm run dev                  # http://localhost:3000, try "Sample B"
npm run eval:rules           # rule engine accuracy
npm run eval:hs              # HS shortlist recall (add -- --model to score the model's choice)
npm run eval:extract         # end-to-end accuracy on the 12 synthetic cases
```

## Data

`data/hs-2022.csv`: Harmonized System 2022 nomenclature from [datasets/harmonized-system](https://github.com/datasets/harmonized-system), ODC Public Domain Dedication and Licence (PDDL). Rebuild the index with `python3 scripts/build_hs_index.py`.
