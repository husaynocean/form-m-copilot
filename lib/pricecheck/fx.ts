/**
 * Exchange rates to US dollars (Comtrade is in USD). Live daily rates from
 * open.er-api.com (free, no key), cached for 12 hours per server instance;
 * if that fails, an approximate built-in table is used and the result says so.
 */
const FALLBACK_PER_USD: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, CNY: 7.2, JPY: 150, INR: 84, AED: 3.6725, SAR: 3.75, TRY: 34,
  CHF: 0.88, CAD: 1.37, AUD: 1.52, ZAR: 18.2, KRW: 1380, HKD: 7.8, SGD: 1.34, MYR: 4.5, THB: 35, NGN: 1500,
};
const FALLBACK_DATE = "2025 (approximate)";

let cache: { at: number; rates: Record<string, number>; date: string } | null = null;

export interface FxRate { currency: string; per_usd: number; source: "live" | "fallback"; as_of: string }

async function rates(): Promise<{ rates: Record<string, number>; date: string; source: "live" | "fallback" }> {
  if (cache && Date.now() - cache.at < 12 * 3_600_000) return { rates: cache.rates, date: cache.date, source: "live" };
  if (process.env.PC_FX !== "fallback") {
    try {
      const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000) });
      const d = (await res.json()) as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
      if (d.result === "success" && d.rates?.EUR) {
        cache = { at: Date.now(), rates: d.rates, date: (d.time_last_update_utc ?? "").slice(5, 16) || "today" };
        return { rates: d.rates, date: cache.date, source: "live" };
      }
    } catch {
      /* fall through to the table */
    }
  }
  return { rates: FALLBACK_PER_USD, date: FALLBACK_DATE, source: "fallback" };
}

/** Units of `currency` per US dollar, or null if the currency is unknown. */
export async function perUsd(currency: string | null | undefined): Promise<FxRate | null> {
  const c = (currency ?? "").toUpperCase().trim();
  if (!c) return null;
  if (c === "USD") return { currency: c, per_usd: 1, source: "live", as_of: "fixed" };
  const r = await rates();
  const v = r.rates[c];
  return v ? { currency: c, per_usd: v, source: r.source, as_of: r.date } : null;
}
