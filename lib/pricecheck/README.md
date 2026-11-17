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

**Catalogue** (`catalog.ts`): 20 HS codes pre-fetched for their usual origins; any other code or origin is fetched on demand.

**Tables** (`supabase/migrations/20261117_pricecheck.sql`): `pc_benchmarks`, `pc_benchmark_queries`, `pc_invoices`, `pc_lines`, `pc_suppliers`. RLS on, server access only.

Tests: `npx tsx scripts/pc-test-offline.ts` (22 checks, no network). `PC_STORE=memory npx tsx scripts/pc-seed-benchmarks.ts` fetches the catalogue from Comtrade; `scripts/pc-check.ts <photo>` runs one document end to end.

## Known gaps, for week 2

- Currency: Comtrade is in USD; non-USD invoices need conversion before the ratio is computed.
- CIF vs FOB: Nigeria's imports are CIF while most invoices are FOB; the band needs an Incoterm adjustment.
- A 6-digit HS code can span very different products (a 75 kVA and a 375 kVA generator share 8502.12), so the band is wide by design and scoring must allow for it.
