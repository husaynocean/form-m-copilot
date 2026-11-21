# PriceCheck (in development, branch `pricecheck`)

Flags likely over- or under-invoicing on a proforma invoice, commercial invoice or Form M by comparing each line's unit price with what the same goods normally cost, from UN Comtrade trade statistics.

## Week 1: data model, extraction, Comtrade lookup (done)

**Extraction** (`extract.ts`) has its own prompt and schema, separate from the Form M check, and reads supplier, buyer, currency, Incoterm, origin and every line's HS code, quantity, unit, unit price and total. `fromDocumentSet()` reuses a Form M check's results (with packing-list weights), so "Run price check" won't need a re-upload. On 4 synthetic documents (a Form M, two proformas, a commercial invoice) with Gemini 3.5 Flash-Lite: 63/63 fields correct (`npx tsx scripts/pc-eval-extract.ts`).

**Benchmarks** (`comtrade.ts`, `benchmarks.ts`). For an HS6 code and origin country, three views of the price over the last five complete years:

1. Nigeria's declared imports from that origin (CIF)
2. the origin's declared exports to Nigeria, i.e. mirror data (FOB), which fills gaps where Nigeria's own reporting is thin
3. the origin's exports to the whole world (FOB), added only when 1 + 2 give fewer than 3 data points

Each yearly record gives a unit value: USD per kg of net weight, or per item where Comtrade's supplementary unit is a count (generators, cars, phones). Records under USD 5,000 and values more than 10x from the median are dropped. The band is the trade-value-weighted 10th–50th–90th percentile. Results are cached in Supabase (`pc_benchmarks`, plus `pc_benchmark_queries` so empty queries aren't repeated) for 90 days.

**Comparison basis** (`units.ts`): an invoice line is compared per kg (from MT/kg units or a packing-list net weight) or per item (set, unit, piece...). A line priced per drum or metre with no weight is reported as "can't compare" rather than guessed.

**Catalogue** (`catalog.ts`): 20 HS codes pre-fetched for their usual origins (`benchmarks-seed.json`, 351 Comtrade records for 2020–2024, shipped with the app so these lookups make no Comtrade calls). Any other code or origin is fetched on demand and cached in Supabase. 37 of the 41 code-origin pairs have a band (21 high confidence, 14 medium, 2 low); 4 have too little reliable data.

**What the real data showed.** Nigeria's own import records often carry *estimated* quantities (e.g. generator sets from China, 2023: about $20,000 per set by Nigeria's figures vs about $6,800 by China's export figures for the same trade). Estimated quantities and weights are therefore excluded, and a band needs at least 3 yearly points. Each band gets a confidence level from its point count and width (high: 5+ points and high/low ≤ 2).

The keyless preview endpoint allows one year per call (about 2.5 minutes per HS code for 3 views × 5 years), so on-demand lookups for new codes are slow without a free API key, which allows all years in one call.

**Tables** (`supabase/migrations/20261117_pricecheck.sql`): `pc_benchmarks`, `pc_benchmark_queries`, `pc_invoices`, `pc_lines`, `pc_suppliers`. RLS on, server access only.

Tests: `npx tsx scripts/pc-test-offline.ts` (22 checks, no network). `PC_STORE=memory npx tsx scripts/pc-seed-benchmarks.ts` fetches the catalogue from Comtrade; `scripts/pc-check.ts <photo>` runs one document end to end.

## Week 2: scoring, explanations, the page (done)

**Comparing like with like.** Bands are FOB-equivalent US dollars: Nigeria's CIF import values are divided by 1.10 (the IMF's standard CIF/FOB margin). Invoice prices are converted to USD (`fx.ts`: live daily rates from open.er-api.com, with an approximate built-in table as a labelled fallback) and, on CIF/CFR invoices without separate freight, divided by 1.10 / 1.08.

**Score** (`score.ts`, deterministic: the model only reads the document). A price within 15% of the band edge is treated as normal. Beyond it, points rise with the size of the gap (1.2× → ~18, 1.5× → ~41, 1.8× → ~60, capped at 80), weighted by benchmark confidence and the line's share of the invoice. Other red flags:

| Flag | Points |
|---|---|
| HS code doesn't exist / doesn't match the description | 15 / 12 |
| Different goods at exactly the same unit price | 10 |
| Quantity × price ≠ line total | 10 |
| All prices round hundreds (not for bulk goods priced per tonne/kg) | 6 |
| First invoice from this supplier (per private key) | 5 |

0–29 low, 30–59 medium, 60–100 high. Every flag carries the numbers behind it and what to do. Lines that can't be compared (no HS code, no weight) are listed as notes, not scored.

**Run it.** `/pricecheck` (tab in the main navigation): upload up to 3 pages, or use "Run price check" on a Form M check's results to reuse its documents and packing-list weights. API: `POST /api/pricecheck`. Results are saved to `pc_invoices` / `pc_lines`, suppliers to `pc_suppliers`.

Tests: `npx tsx scripts/pc-test-score.ts` (13 synthetic invoices against the real bands: fair prices, over- and under-invoicing, EUR, CIF, wrong HS code, repeated price, round prices, arithmetic, missing weight, new supplier).

## Week 3: PDF report (done)

"Download PDF report" on every result: `GET /api/pricecheck/report?id=&owner=` builds an A4 report (score, reasons, every line against its range, method) from the saved record.

## Week 4: how well it works (measured)

Three tests, from easiest to hardest. Read them together: the first is the demo, the last is the honest picture.

**1. Obvious mispricing, 30 synthetic invoices (pc01–pc30).** Invented proformas priced from the real Comtrade ranges: 15 fair, 11 with planted mispricing 1.8–2.4× beyond the edge of the normal range, 4 with one other red flag each. USD, EUR and GBP; FOB, CFR and CIF; 13 origins. This is close to guaranteed to pass, because the invoices were priced from the same ranges the check uses and the planted errors are large.

| | Printed values | Read from the photos by the model |
|---|---|---|
| Obvious mispricing caught (medium/high, right line) | 11/11 | 11/11 |
| False alarms on the other 19 | 0/19 | 0/19 |
| Other red flags found | 4/4 | 4/4 |
| Price fields read correctly | – | 310/310 |

**2. Subtle mispricing, 10 synthetic invoices (pc31–pc40).** Closer to real over- and under-invoicing: the supplier's true price is drawn from anywhere in the normal range, then marked up or down by 1.2–1.5×.

| | Printed values | Read from the photos |
|---|---|---|
| Caught at medium/high | 1/10 | 1/10 |
| Flagged on the right line, but the score stayed low | 4/10 | 4/10 |
| Missed | 5/10 | 5/10 |
| Price fields read correctly | – | 95/95 |

Two of the five misses (pc35, pc37) are invisible to any range check: after the markup the price is still inside the normal range. The other three are 1.02–1.09× past the edge, inside the 15% tolerance.

**3. Real shipments (`scripts/pc-eval-real.ts`).** 266 real UN Comtrade records for 37 goods/origin pairs, each judged by the app's scorer against a range built from the *other* records (leave-one-out), then marked up or down:

| Price change | Flagged (any level) | Medium/high |
|---|---|---|
| Honest (×1.0) | 23% | 13% |
| ×1.2 over / under | 30% / 35% | 16% / 16% |
| ×1.3 over / under | 38% / 45% | 19% / 22% |
| ×1.5 over / under | 56% / 61% | 32% / 39% |
| ×2 over / under | 79% / 87% | 65% / 70% |

What this means:
- PriceCheck reliably separates **large** mispricing (around 2×) from normal prices. At 1.2–1.3× it barely does better than chance: a marked-up invoice is flagged only a little more often than an honest one.
- About **1 in 8 honest shipments gets a medium/high price flag**. Annual trade figures vary a lot between years and routes; even the best-supported ranges put 10% of real shipments more than 1.5× past the edge.
- Caveats in both directions: a Comtrade record is a year's total, smoother than one invoice (so real false alarms could be higher); and Nigeria's own import records may already contain misinvoicing (they have more outliers than exporters' figures: 28% vs 19% past the edge), so some "honest" records aren't.
- The price check is a screening signal that tells a reviewer where to look, not a verdict. Catching 1.2–1.3× needs finer data than 6-digit HS annual averages: the bank's own past transactions for the same goods and supplier, or specification-level prices.

Run: `npx tsx scripts/pc-demo-plan.ts && python3 scripts/generate_pricecheck_demo.py && npx tsx scripts/pc-eval-demo.ts [--model]`, and `npx tsx scripts/pc-eval-real.ts`. With `PC_REMOTE=<deployment>` the photos are read by that deployment's API (test rows saved under one throwaway owner key; delete them afterwards).

Fixed during the demo: a wrong HS code no longer gets its price scored against the wrong product's range (the line is marked "not compared" and the HS flag explains why).

## Known limits

- A 6-digit HS code can span very different products (a 75 kVA and a 375 kVA generator share 8502.12): bands are wide by design and low-confidence bands carry half weight.
- Annual averages, not transaction prices: a premium brand can legitimately sit above the band. The score is a screening signal for review.
