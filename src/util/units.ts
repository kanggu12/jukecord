/**
 * Reading sizes and durations the way people write them in settings ("2GiB", "60s").
 *
 * Settings come from environment variables, Helm values and the command line, so the same parser serves all three
 * and the error names the value that could not be read.
 */

// Bytes per unit. Decimal units (KB, MB, GB) and binary ones (KiB, MiB, GiB) are both accepted because people mix
// them up; each means what it says, so "1GB" is 1,000,000,000 bytes and "1GiB" is 1,073,741,824.
const SIZE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

// Milliseconds per unit for durations.
const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** A value in a setting that could not be read; the message says which value and what was expected. */
export class UnitError extends Error {
  // A plain class field, not a parameter property: Node strips types but cannot strip parameter properties.
  override name = 'UnitError';
}

/**
 * Parses a size such as "2GiB", "500 MB" or "1048576" into whole bytes.
 *
 * A plain number is bytes. Fractions are allowed with a unit ("1.5GiB") and rounded down to a whole byte, since a
 * cache or log limit cannot hold a part of a byte.
 */
export function parseSize(text: string): number {
  // Spaces around and between the number and the unit carry no meaning, and units are case-insensitive.
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  // Anything else (a negative number, two numbers, a typo in the unit) is refused rather than guessed at.
  if (!match) throw new UnitError(`"${text}" is not a size (examples: 512MiB, 2GiB, 1048576)`);
  // The regular expression guarantees both groups are present when it matches.
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase() || 'b';
  // The unit table decides which spellings exist; "2 gigs" fails here with the list of accepted ones.
  const factor = SIZE_UNITS[unit];
  if (factor === undefined) {
    throw new UnitError(`"${text}" has an unknown size unit (use B, KB, MB, GB, KiB, MiB or GiB)`);
  }
  // Floor: a limit is never raised above what was written.
  return Math.floor(amount * factor);
}

/**
 * Parses a duration such as "60s", "5m", "250ms" or "1.5h" into milliseconds.
 *
 * A plain number is seconds, because that is what people mean when they write JUKECORD_FETCH_TIMEOUT=60.
 */
export function parseDuration(text: string): number {
  // Same shape as sizes: a number, optional spaces, an optional unit.
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  if (!match) throw new UnitError(`"${text}" is not a duration (examples: 250ms, 60s, 5m, 1h)`);
  const amount = Number(match[1]);
  // No unit means seconds (see above).
  const unit = (match[2] ?? '').toLowerCase() || 's';
  const factor = DURATION_UNITS[unit];
  if (factor === undefined) throw new UnitError(`"${text}" has an unknown duration unit (use ms, s, m or h)`);
  // Durations feed timers, which count whole milliseconds.
  return Math.round(amount * factor);
}

/**
 * Formats a byte count for people, in binary units with one decimal ("1.5 GiB").
 *
 * Used in status output and logs, where an exact byte count is noise.
 */
export function formatSize(bytes: number): string {
  // Walk up the binary units until the number is below 1024; bytes are never shown with a decimal.
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index === 0 ? `${value} B` : `${value.toFixed(1)} ${units[index]}`;
}
