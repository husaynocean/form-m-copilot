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
