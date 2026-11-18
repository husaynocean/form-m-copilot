/**
 * UN Comtrade client: yearly trade flows for one HS6 code, turned into unit
 * values (USD per kg, or per item when the supplementary unit is a count).
 *
 * Endpoints (https://comtradeplus.un.org/ApiDocs):
 *  - keyless preview: /public/v1/preview/C/A/HS  (up to 500 records per call)
 *  - with a free key: /data/v1/get/C/A/HS        (COMTRADE_API_KEY; 500 calls/day)
 * Reporter/partner codes are UN M49 numbers; partner 0 = world.
 */
import { NIGERIA_M49, WORLD_M49 } from "./countries";

const BASE = () => process.env.COMTRADE_BASE_URL ?? "https://comtradeapi.un.org";

export type FlowSource = "ng_imports" | "mirror_exports_to_ng" | "origin_exports_world";

export interface FlowRecord {
  hs6: string;
  reporter_m49: number;
  partner_m49: number;
  flow: "M" | "X";
  period: number;
  source: FlowSource;
  value_usd: number;
  value_basis: "cif" | "fob" | "primary";
  net_wgt_kg: number | null;
  qty: number | null;
  qty_unit_code: number | null;
  qty_unit: string | null;
  qty_estimated: boolean | null;
  wgt_estimated: boolean | null;
}

export interface FlowQuery { hs6: string; reporter: number; partner: number; flow: "M" | "X"; periods: number[]; source: FlowSource }

/** The three views of the price of goods from `origin` into Nigeria. */
export function queriesFor(hs6: string, origin: number | null, periods: number[]): FlowQuery[] {
  const q: FlowQuery[] = [];
  if (origin != null && origin !== NIGERIA_M49) {
    q.push({ hs6, reporter: NIGERIA_M49, partner: origin, flow: "M", periods, source: "ng_imports" });
    q.push({ hs6, reporter: origin, partner: NIGERIA_M49, flow: "X", periods, source: "mirror_exports_to_ng" });
    q.push({ hs6, reporter: origin, partner: WORLD_M49, flow: "X", periods, source: "origin_exports_world" });
  } else {
    // Unknown origin: Nigeria's imports from the whole world.
    q.push({ hs6, reporter: NIGERIA_M49, partner: WORLD_M49, flow: "M", periods, source: "ng_imports" });
  }
  return q;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** Pick the record's value: CIF for imports, FOB for exports, else the primary value. */
export function toRecord(row: Record<string, unknown>, q: FlowQuery): FlowRecord | null {
  // Only national totals: no customs-procedure or transport-mode breakdowns, no second partner.
  if ((row.customsCode && row.customsCode !== "C00") || (num(row.motCode) ?? 0) !== 0 || (num(row.partner2Code) ?? 0) !== 0) return null;
  const cif = num(row.cifvalue ?? row.cifValue);
  const fob = num(row.fobvalue ?? row.fobValue);
  const primary = num(row.primaryValue);
  const [value, basis] =
    q.flow === "M" && cif && cif > 0 ? [cif, "cif" as const]
    : q.flow === "X" && fob && fob > 0 ? [fob, "fob" as const]
    : [primary, "primary" as const];
  if (!value || value <= 0) return null;
  return {
    hs6: q.hs6,
    reporter_m49: num(row.reporterCode) ?? q.reporter,
    partner_m49: num(row.partnerCode) ?? q.partner,
    flow: q.flow,
    period: num(row.period) ?? num(row.refYear) ?? 0,
    source: q.source,
    value_usd: value,
    value_basis: basis,
    net_wgt_kg: num(row.netWgt),
    qty: num(row.qty),
    qty_unit_code: num(row.qtyUnitCode),
    qty_unit: typeof row.qtyUnitAbbr === "string" ? row.qtyUnitAbbr : null,
    qty_estimated: typeof row.isQtyEstimated === "boolean" ? row.isQtyEstimated : null,
    wgt_estimated: typeof row.isNetWgtEstimated === "boolean" ? row.isNetWgtEstimated : null,
  };
}

async function call(q: FlowQuery, periods: number[]): Promise<Record<string, unknown>[]> {
  const key = process.env.COMTRADE_API_KEY;
  const params = new URLSearchParams({
    reporterCode: String(q.reporter),
    partnerCode: String(q.partner),
    partner2Code: "0",
    cmdCode: q.hs6,
    flowCode: q.flow,
    period: periods.join(","),
    customsCode: "C00",
    motCode: "0",
    includeDesc: "false",
  });
  const url = key ? `${BASE()}/data/v1/get/C/A/HS?${params}` : `${BASE()}/public/v1/preview/C/A/HS?${params}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: key ? { "Ocp-Apim-Subscription-Key": key } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: Record<string, unknown>[]; error?: string };
      if (body.error) throw new Error(`comtrade: ${body.error}`);
      return body.data ?? [];
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    throw new Error(`comtrade ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error("comtrade: no response after retries");
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one query. With a key, all years in one call; the keyless preview
 * allows one year per call, so it asks year by year with a short pause.
 */
export async function fetchFlows(q: FlowQuery): Promise<FlowRecord[]> {
  let rows: Record<string, unknown>[] = [];
  if (process.env.COMTRADE_API_KEY) {
    rows = await call(q, q.periods);
  } else {
    let failures = 0;
    for (const p of q.periods) {
      try {
        rows.push(...(await call(q, [p])));
      } catch (e) {
        if (++failures === q.periods.length) throw e;
      }
      await pause(Number(process.env.COMTRADE_PAUSE_MS ?? 350));
    }
  }
  return rows.map((r) => toRecord(r, q)).filter((r): r is FlowRecord => Boolean(r));
}

/** Comtrade publishes with a lag: use the last five complete years. */
export function defaultPeriods(now = new Date()): number[] {
  const last = now.getUTCFullYear() - 2;
  return [last - 4, last - 3, last - 2, last - 1, last];
}
