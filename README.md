# Form M Copilot

AI that checks Nigerian import documents before they reach the bank.

An importer sends photos or PDFs of their **proforma invoice**, **packing list** and **marine insurance certificate**. Form M Copilot:

1. extracts every field into structured JSON (Meta Muse Spark, vision),
2. cross-checks the documents against each other (totals, quantities, names, ports, currency, insured value, dates),
3. suggests HS codes with reasons,
4. returns a pre-filled Form M draft plus a plain-language fix-list in English, Hausa or Pidgin, on WhatsApp or the web.

The extraction pipeline also runs on Meta open-weights models, so a bank could host it inside its own network.

Built for the Meta Global AI Developer Hackathon (Indie Developer track, "Build for Your World").

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
