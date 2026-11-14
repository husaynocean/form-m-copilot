/** The browser keeps the private tracker key; the share link carries it in the #hash (never sent to the server). */
const K = "fmc-tracker-key";
export function getTrackerKey(): string | null {
  try {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("k");
    if (fromHash && /^[A-Za-z0-9_-]{24,64}$/.test(fromHash)) {
      localStorage.setItem(K, fromHash);
      return fromHash;
    }
    return localStorage.getItem(K);
  } catch {
    return null;
  }
}
export function setTrackerKey(k: string) {
  try { localStorage.setItem(K, k); } catch { /* private mode: link still works */ }
}
export function clearTrackerKey() {
  try { localStorage.removeItem(K); } catch { /* ignore */ }
}
