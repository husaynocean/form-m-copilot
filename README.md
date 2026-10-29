# Form M Copilot

AI that checks Nigerian import documents before they reach the bank.

An importer sends photos or PDFs of their **proforma invoice**, **packing list** and **marine insurance certificate**. Form M Copilot:

1. extracts every field into structured JSON (Meta Muse Spark, vision),
2. cross-checks the documents against each other (totals, quantities, names, ports, currency, insured value, dates),
3. suggests HS codes with reasons,
4. returns a pre-filled Form M draft plus a plain-language fix-list in English, Hausa or Pidgin, on WhatsApp or the web.

The extraction pipeline also runs on Meta open-weights models, so a bank could host it inside its own network.

Built for the Meta Global AI Developer Hackathon (Indie Developer track, "Build for Your World").

## What was built when

Everything in this repository was created for this hackathon. Commit history is the record.

- **26 Oct 2026 (before kickoff):** synthetic test data only (`samples/`, `scripts/generate_samples.py`). This is test material, not a product feature, and is not shown as a feature in the demo.
- **26 Oct – 4 Nov 2026 (build period):** all application code: extraction, validation agent, HS-code assistant, Form M draft, WhatsApp channel, open-weights deployment.

## Results (Muse Spark Open on Baseten)

| Test | Result |
|---|---|
| Field extraction from phone-style photos (12 cases, 36 documents) | **672 / 672 fields** correct, 36 / 36 documents classified |
| Planted document errors caught (11 error types) | **14 / 14**, 0 false alarms |
| Printed total preserved across repeated reads (money re-read) | **12 / 12** |
| HS-code assistant (30 hand-checked import descriptions) | **28 / 30 exact, 0 wrong**, 2 declined for missing detail |
| Fix-list translations (Hausa, Yoruba, Igbo, Pidgin, Chinese, French) | every figure verified unchanged |
| Full check, 3 documents | ~15 s on the web app, ~28 s over the chat bot |

Synthetic, clean printed documents; real crumpled or handwritten paperwork will be harder. Raw outputs are in `eval-results/`.

## Try it

- Web app: https://form-m-copilot.vercel.app (tap "Try a problem file")
- WhatsApp bot, web preview: https://form-m-copilot.vercel.app/whatsapp — the real WhatsApp number receives messages; Meta blocks outgoing messages until business verification, so the same bot code (`lib/bot.ts`) runs here with a web transport.

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
photos ──► 1. Extract (Muse Spark vision → typed JSON, Zod-validated, self-repair on bad JSON)
       ──► 2. Validate (deterministic TypeScript rules: arithmetic, names, quantities, ports, currency, dates)
       ──► 3. HS-code assistant (BM25 over 5,612 official HS 2022 subheadings → model picks from shortlist → code verified)
       ──► 4. Form M draft (every field traced to its source document) + fix-list
       ──► 5. Fix-list in English, Hausa or Pidgin (every figure verified unchanged after translation)
```

The model only reads documents. Every flag is computed in code, so results are reproducible and explainable to a bank officer.

| Path | What |
|---|---|
| `lib/llm.ts` | One client for Meta Model API, Baseten (Muse Spark Open) or any OpenAI-compatible server (e.g. Muse Glimmer on Modal) |
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
