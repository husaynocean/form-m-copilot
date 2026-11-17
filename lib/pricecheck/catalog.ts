/**
 * The 20 HS codes PriceCheck benchmarks first: the goods in the synthetic
 * test pack plus ten common Nigerian imports. `basis` is how the price is
 * compared: per kg of net weight, or per item where Comtrade's supplementary
 * unit is a count (generators, cars, phones). `origins` are the countries
 * fetched in advance; any other origin is fetched on demand.
 */
export type Basis = "kg" | "item";

export interface CatalogEntry { hs6: string; label: string; basis: Basis; origins: number[] }

export const CATALOG: CatalogEntry[] = [
  { hs6: "850212", label: "Diesel generating sets, 75–375 kVA", basis: "item", origins: [156, 826, 792] },
  { hs6: "200290", label: "Tomato paste", basis: "kg", origins: [156, 381] },
  { hs6: "390210", label: "Polypropylene, primary forms", basis: "kg", origins: [682, 156, 699] },
  { hs6: "841510", label: "Air conditioners, wall/window type", basis: "item", origins: [156, 784] },
  { hs6: "520832", label: "Cotton fabric, dyed, plain weave", basis: "kg", origins: [156, 699] },
  { hs6: "300490", label: "Medicaments, packaged doses", basis: "kg", origins: [699, 156] },
  { hs6: "847710", label: "Injection-moulding machines", basis: "item", origins: [156, 276] },
  { hs6: "100119", label: "Durum wheat", basis: "kg", origins: [124, 842] },
  { hs6: "940542", label: "LED luminaires", basis: "kg", origins: [156] },
  { hs6: "481910", label: "Corrugated cartons and boxes", basis: "kg", origins: [156, 710] },
  { hs6: "100630", label: "Rice, milled", basis: "kg", origins: [764, 699] },
  { hs6: "170114", label: "Raw cane sugar", basis: "kg", origins: [76] },
  { hs6: "030354", label: "Frozen mackerel", basis: "kg", origins: [528, 579] },
  { hs6: "252329", label: "Portland cement", basis: "kg", origins: [156, 792] },
  { hs6: "870323", label: "Cars, 1,500–3,000 cc petrol", basis: "item", origins: [842, 124, 392] },
  { hs6: "871120", label: "Motorcycles, 50–250 cc", basis: "item", origins: [156, 699] },
  { hs6: "851713", label: "Smartphones", basis: "item", origins: [156, 784] },
  { hs6: "854143", label: "Solar PV modules", basis: "kg", origins: [156] },
  { hs6: "401110", label: "Car tyres, new", basis: "item", origins: [156, 704] },
  { hs6: "040221", label: "Milk powder, unsweetened", basis: "kg", origins: [528, 372, 554] },
];

export const catalogEntry = (hs: string | null | undefined) => CATALOG.find((c) => c.hs6 === hs6Of(hs));

/** "8502.12" / "850212" / "8502.12.00.00" -> "850212" (null if under 6 digits). */
export function hs6Of(hs: string | null | undefined): string | null {
  const d = (hs ?? "").replace(/\D/g, "");
  return d.length >= 6 ? d.slice(0, 6) : null;
}
