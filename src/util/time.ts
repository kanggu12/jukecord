/**
 * Track times as people read and type them: "3:07", "1:02:45", and the inputs "83", "1:23", "1m23s".
 */

/** Formats milliseconds as m:ss, or h:mm:ss from an hour up. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * Reads a place in a track: plain seconds ("83"), clock form ("1:23", "1:02:45") or units ("1m23s", "90s", "2h").
 * Returns milliseconds; throws on anything else, with the forms that work.
 */
export function parseTimestamp(text: string): number {
  const value = text.trim().toLowerCase();
  // Plain seconds, fractions allowed ("12.5").
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  // Clock form: up to three parts, each part after the first two digits at most.
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(value);
  if (clock) {
    const [, h, m, s] = clock;
    return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000;
  }
  // Units in order, each optional but at least one present.
  const units = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/.exec(value);
  if (units && (units[1] || units[2] || units[3])) {
    const [, h, m, s] = units;
    return Math.round(((Number(h ?? 0) * 60 + Number(m ?? 0)) * 60 + Number(s ?? 0)) * 1000);
  }
  throw new Error(`"${text}" is not a time in the track (examples: 83, 1:23, 1m23s)`);
}
