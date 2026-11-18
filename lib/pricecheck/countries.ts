/**
 * Country name -> UN M49 code (the code Comtrade uses for reporters/partners).
 * Covers Nigeria's main trading partners; unknown names return null and the
 * lookup falls back to world prices.
 */
export const NIGERIA_M49 = 566;
export const WORLD_M49 = 0;

const M49: Record<string, number> = {
  nigeria: 566, china: 156, "people's republic of china": 156, prc: 156, "hong kong": 344, india: 699, germany: 276,
  "united arab emirates": 784, uae: 784, turkey: 792, "türkiye": 792, turkiye: 792, "united states": 842, usa: 842, "united states of america": 842,
  "united kingdom": 826, uk: 826, "great britain": 826, netherlands: 528, holland: 528, belgium: 56, france: 251, italy: 381,
  spain: 724, brazil: 76, argentina: 32, canada: 124, japan: 392, "south korea": 410, "korea, republic of": 410, korea: 410,
  thailand: 764, vietnam: 704, "viet nam": 704, indonesia: 360, malaysia: 458, singapore: 702, pakistan: 586, bangladesh: 50,
  "south africa": 710, egypt: 818, morocco: 504, ghana: 288, "cote d'ivoire": 384, "côte d'ivoire": 384, "ivory coast": 384,
  benin: 204, togo: 768, niger: 562, cameroon: 120, kenya: 404, "saudi arabia": 682, russia: 643, "russian federation": 643,
  ukraine: 804, poland: 616, sweden: 752, denmark: 208, norway: 579, switzerland: 757, ireland: 372, portugal: 620,
  mexico: 484, chile: 152, australia: 36, "new zealand": 554, taiwan: 490, philippines: 608, "sri lanka": 144, israel: 376,
};

export function toM49(country: string | null | undefined): number | null {
  if (!country) return null;
  const k = country.toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ").trim();
  return M49[k] ?? null;
}

const NAMES: Record<number, string> = {
  566: "Nigeria", 156: "China", 344: "Hong Kong", 699: "India", 276: "Germany", 784: "the UAE", 792: "Turkey", 842: "the USA",
  826: "the UK", 528: "the Netherlands", 56: "Belgium", 251: "France", 381: "Italy", 724: "Spain", 76: "Brazil", 32: "Argentina",
  124: "Canada", 392: "Japan", 410: "South Korea", 764: "Thailand", 704: "Vietnam", 360: "Indonesia", 458: "Malaysia", 702: "Singapore",
  586: "Pakistan", 50: "Bangladesh", 710: "South Africa", 818: "Egypt", 504: "Morocco", 288: "Ghana", 384: "Côte d'Ivoire", 204: "Benin",
  768: "Togo", 562: "Niger", 120: "Cameroon", 404: "Kenya", 682: "Saudi Arabia", 643: "Russia", 804: "Ukraine", 616: "Poland",
  752: "Sweden", 208: "Denmark", 579: "Norway", 757: "Switzerland", 372: "Ireland", 620: "Portugal", 484: "Mexico", 152: "Chile",
  36: "Australia", 554: "New Zealand", 490: "Taiwan", 608: "the Philippines", 144: "Sri Lanka", 376: "Israel", 0: "the world",
};
export const countryName = (m49: number | null | undefined) => (m49 == null ? "any origin" : NAMES[m49] ?? `country ${m49}`);
