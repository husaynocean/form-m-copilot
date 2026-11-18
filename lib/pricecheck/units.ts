/**
 * Express an invoice line in the benchmark's basis: kilograms of net weight,
 * or a count of items. Returns null when the line doesn't carry enough
 * information (e.g. priced per carton with no weight) -- the comparison is
 * then skipped for that line rather than guessed.
 */
import type { Basis } from "./catalog";
import type { PriceLine } from "./extract";

const ITEM_UNITS = /^(u|unit|units|pc|pcs|piece|pieces|set|sets|no|nos|number|each|ea|item|items|car|cars|vehicle|vehicles|tyre|tyres|tire|tires)$/i;
const KG_UNITS: Record<string, number> = { kg: 1, kgs: 1, kilogram: 1, kilograms: 1, mt: 1000, t: 1000, ton: 1000, tons: 1000, tonne: 1000, tonnes: 1000, "metric ton": 1000, "metric tons": 1000, g: 0.001, lb: 0.4536, lbs: 0.4536 };

export function basisQuantity(line: PriceLine, basis: Basis): number | null {
  const q = line.quantity;
  const unit = (line.unit ?? "").toLowerCase().replace(/\.$/, "").trim();
  if (basis === "kg") {
    if (line.net_weight_kg && line.net_weight_kg > 0) return line.net_weight_kg;
    const f = KG_UNITS[unit];
    return q && q > 0 && f ? q * f : null;
  }
  return q && q > 0 && ITEM_UNITS.test(unit) ? q : null;
}

/** Invoice price per basis unit (in the invoice currency). */
export function basisPrice(line: PriceLine, basis: Basis): { qty: number; price: number } | null {
  const qty = basisQuantity(line, basis);
  const total = line.line_total ?? (line.unit_price != null && line.quantity != null ? line.unit_price * line.quantity : null);
  if (!qty || total == null || total <= 0) return null;
  return { qty, price: total / qty };
}
