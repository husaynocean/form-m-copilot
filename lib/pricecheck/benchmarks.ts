/**
 * Price benchmarks from Comtrade flows, cached in Supabase (pc_benchmarks).
 *
 * For an HS6 code and an origin country we gather three views of the price:
 *   1. Nigeria's declared imports from that origin        (CIF)
 *   2. the origin's declared exports to Nigeria (mirror)   (FOB)
 *   3. the origin's exports to the whole world             (FOB, wider sample)
 * Each yearly record gives one unit value (USD per kg, or per item). The
 * direct route (1+2) is used when it has enough points; otherwise (3) is added.
 * The band is the trade-value-weighted 10th–90th percentile.
 */
import { rest } from "../store";
import { defaultPeriods, fetchFlows, queriesFor, type FlowQuery, type FlowRecord, type FlowSource } from "./comtrade";
import type { Basis } from "./catalog";

const STALE_DAYS = 90;
const MIN_RECORD_USD = 5_000; // tiny flows give noisy unit values
const ITEM_UNIT = 5; // Comtrade supplementary unit code: number of items

export interface Benchmark {
  hs6: string;
  origin_m49: number | null;
  basis: Basis;
  low: number;
  median: number;
  high: number;
  points: number;
  years: number[];
  sources: FlowSource[];
  /** Share of the points valued CIF (imports) rather than FOB (exports). */
  cif_share: number;
}

// --- storage -----------------------------------------------------------------
// PC_STORE=memory keeps everything in-process (tests, local runs without Supabase).
const mem = { flows: [] as FlowRecord[], queries: new Map<string, number>() };
const memory = () => process.env.PC_STORE === "memory";
const qkey = (q: { hs6: string; reporter: number; partner: number; flow: string }, p: number) => `${q.hs6}|${q.reporter}|${q.partner}|${q.flow}|${p}`;

async function fetchedPeriods(q: FlowQuery): Promise<Set<number>> {
  const cutoff = Date.now() - STALE_DAYS * 86_400_000;
  if (memory()) return new Set(q.periods.filter((p) => (mem.queries.get(qkey(q, p)) ?? 0) > cutoff));
  const rows: { period: number; fetched_at: string }[] =
    (await rest(`pc_benchmark_queries?hs6=eq.${q.hs6}&reporter_m49=eq.${q.reporter}&partner_m49=eq.${q.partner}&flow=eq.${q.flow}&select=period,fetched_at`)) ?? [];
  return new Set(rows.filter((r) => Date.parse(r.fetched_at) > cutoff).map((r) => r.period));
}

async function save(q: FlowQuery, periods: number[], records: FlowRecord[], status: "ok" | "error") {
  if (memory()) {
    mem.flows = mem.flows.filter((f) => !(f.hs6 === q.hs6 && f.reporter_m49 === q.reporter && f.partner_m49 === q.partner && f.flow === q.flow && periods.includes(f.period)));
    mem.flows.push(...records);
    if (status === "ok") periods.forEach((p) => mem.queries.set(qkey(q, p), Date.now()));
    return;
  }
  if (records.length) {
    await rest("pc_benchmarks?on_conflict=hs6,reporter_m49,partner_m49,flow,period", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(records.map((r) => ({ ...r, fetched_at: new Date().toISOString() }))),
    });
  }
  const byYear = new Map<number, number>();
  records.forEach((r) => byYear.set(r.period, (byYear.get(r.period) ?? 0) + 1));
  await rest("pc_benchmark_queries?on_conflict=hs6,reporter_m49,partner_m49,flow,period", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(periods.map((p) => ({
      hs6: q.hs6, reporter_m49: q.reporter, partner_m49: q.partner, flow: q.flow, period: p,
      rows: byYear.get(p) ?? 0, status: status === "error" ? "error" : byYear.get(p) ? "ok" : "empty",
      fetched_at: new Date().toISOString(),
    }))),
  });
}

async function storedFlows(hs6: string, q: FlowQuery[]): Promise<FlowRecord[]> {
  const match = (f: FlowRecord) => q.some((x) => x.reporter === f.reporter_m49 && x.partner === f.partner_m49 && x.flow === f.flow && x.periods.includes(f.period));
  if (memory()) return mem.flows.filter((f) => f.hs6 === hs6 && match(f));
  const reporters = [...new Set(q.map((x) => x.reporter))].join(",");
  const rows: FlowRecord[] = (await rest(`pc_benchmarks?hs6=eq.${hs6}&reporter_m49=in.(${reporters})&select=*`)) ?? [];
  return rows.map((r) => ({ ...r, value_usd: Number(r.value_usd), net_wgt_kg: r.net_wgt_kg == null ? null : Number(r.net_wgt_kg), qty: r.qty == null ? null : Number(r.qty) })).filter(match);
}

/** Make sure every query/year has been fetched recently; fetch the missing ones. */
export async function ensureFlows(hs6: string, origin: number | null, periods = defaultPeriods()): Promise<{ fetched: number; errors: string[] }> {
  let fetched = 0;
  const errors: string[] = [];
  for (const q of queriesFor(hs6, origin, periods)) {
    const have = await fetchedPeriods(q);
    const missing = q.periods.filter((p) => !have.has(p));
    if (!missing.length) continue;
    try {
      const recs = await fetchFlows({ ...q, periods: missing });
      await save(q, missing, recs, "ok");
      fetched += recs.length;
    } catch (e) {
      errors.push(`${q.source}: ${(e as Error).message}`);
      await save(q, missing, [], "error").catch(() => undefined);
    }
  }
  return { fetched, errors };
}

// --- statistics ----------------------------------------------------------------
export function unitValue(r: FlowRecord, basis: Basis): number | null {
  if (r.value_usd < MIN_RECORD_USD) return null;
  if (basis === "kg") return r.net_wgt_kg && r.net_wgt_kg > 0 ? r.value_usd / r.net_wgt_kg : null;
  return r.qty_unit_code === ITEM_UNIT && r.qty && r.qty > 0 ? r.value_usd / r.qty : null;
}

/** Trade-value-weighted quantile. */
function wq(points: { v: number; w: number }[], q: number): number {
  const s = [...points].sort((a, b) => a.v - b.v);
  const total = s.reduce((t, p) => t + p.w, 0);
  let acc = 0;
  for (const p of s) {
    acc += p.w;
    if (acc >= q * total) return p.v;
  }
  return s[s.length - 1].v;
}

export function summarise(hs6: string, origin: number | null, basis: Basis, flows: FlowRecord[]): Benchmark | null {
  const pts = (sources: FlowSource[]) =>
    flows.filter((f) => sources.includes(f.source)).map((f) => ({ f, v: unitValue(f, basis) })).filter((p): p is { f: FlowRecord; v: number } => p.v != null);
  let used: FlowSource[] = ["ng_imports", "mirror_exports_to_ng"];
  let p = pts(used);
  if (p.length < 3) {
    used = [...used, "origin_exports_world"];
    p = pts(used);
  }
  if (!p.length) return null;
  // Drop wild values (bad weights or quantities): more than 10x from the plain median.
  const plain = [...p].sort((a, b) => a.v - b.v)[Math.floor(p.length / 2)].v;
  p = p.filter((x) => x.v <= plain * 10 && x.v >= plain / 10);
  const w = p.map((x) => ({ v: x.v, w: x.f.value_usd }));
  const round = (n: number) => Number(n.toPrecision(4));
  return {
    hs6, origin_m49: origin, basis,
    low: round(wq(w, 0.1)), median: round(wq(w, 0.5)), high: round(wq(w, 0.9)),
    points: p.length,
    years: [...new Set(p.map((x) => x.f.period))].sort(),
    sources: [...new Set(p.map((x) => x.f.source))],
    cif_share: Math.round((p.filter((x) => x.f.value_basis === "cif").length / p.length) * 100) / 100,
  };
}

/**
 * Benchmark for one HS6 code from one origin, fetching from Comtrade when the
 * cache is missing or stale. Tries the preferred basis, then the other one.
 */
export async function getBenchmark(hs6: string, origin: number | null, prefer: Basis): Promise<{ benchmark: Benchmark | null; errors: string[] }> {
  const periods = defaultPeriods();
  const { errors } = await ensureFlows(hs6, origin, periods);
  const flows = await storedFlows(hs6, queriesFor(hs6, origin, periods));
  const other: Basis = prefer === "kg" ? "item" : "kg";
  return { benchmark: summarise(hs6, origin, prefer, flows) ?? summarise(hs6, origin, other, flows), errors };
}
