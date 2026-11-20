// All market-time logic runs in IST (UTC+05:30, no DST) regardless of the machine's timezone.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const MARKET_OPEN_MIN = 9 * 60 + 15;
export const MARKET_CLOSE_MIN = 15 * 60 + 30;

const shifted = (ms) => new Date(ms + IST_OFFSET_MS);

/** "YYYY-MM-DD" in IST. */
export const istDate = (ms = Date.now()) => shifted(ms).toISOString().slice(0, 10);

/** "HH:MM:SS" in IST. */
export const istClock = (ms = Date.now()) => shifted(ms).toISOString().slice(11, 19);

/** Minutes since IST midnight. */
export function istMinutes(ms = Date.now()) {
  const d = shifted(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Regular NSE session, 09:15 to 15:30 IST. Weekends excluded; exchange holidays are not known here. */
export function inMarketHours(ms = Date.now()) {
  const day = shifted(ms).getUTCDay();
  const m = istMinutes(ms);
  return day >= 1 && day <= 5 && m >= MARKET_OPEN_MIN && m < MARKET_CLOSE_MIN;
}

/** "HH:MM" -> minutes since midnight. */
export function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`Invalid time "${text}", expected HH:MM (IST)`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Epoch seconds or milliseconds -> milliseconds. 0/empty -> null. */
export function toEpochMs(value) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}
