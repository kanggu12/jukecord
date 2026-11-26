/**
 * A setting's value in words, in its own unit, for people: the page and the `jukecord` command say "2 GiB" and
 * "1 min" where the API carries 2147483648 and 60000. Two spellings come in:
 *
 * - written: the setting as the environment, settings.json or the database has it ("5m", "300", "2GiB"; a duration
 *   without a unit is seconds, a size without one bytes), the API's `value`;
 * - in use: the value as jukecord holds it (a duration in milliseconds, a size in bytes), the API's `running` and a
 *   change's `from` and `to`.
 *
 * Both come out the same: a duration in the largest unit it is a whole number of (h, min, s, ms), a size in the
 * largest binary unit it reaches (two decimals at most), a setting's off value as off. Anything else as it is.
 */
import type { Lang } from '../core/say.ts';
import { parseDuration, parseSize } from '../util/units.ts';
import type { SettingDefinition } from './definitions.ts';

/** What the words need of a setting: its kind and its off value (the page's and the command's copy both have them). */
export type Worded = Pick<SettingDefinition, 'kind'> & { readonly off?: string | null };

// A duration's units, largest first, with each language's word: Korean writes the unit against the number.
const DURATIONS: readonly { readonly ms: number; readonly en: string; readonly ko: string }[] = [
  { ms: 3_600_000, en: ' h', ko: '시간' },
  { ms: 60_000, en: ' min', ko: '분' },
  { ms: 1000, en: ' s', ko: '초' },
  { ms: 1, en: ' ms', ko: 'ms' },
];
// A size's binary units, largest first.
const SIZES: readonly { readonly bytes: number; readonly unit: string }[] = [
  { bytes: 1024 ** 4, unit: 'TiB' },
  { bytes: 1024 ** 3, unit: 'GiB' },
  { bytes: 1024 ** 2, unit: 'MiB' },
  { bytes: 1024, unit: 'KiB' },
];
// Off, as the page's switch says it.
const OFF = { en: 'off', ko: '끔' } as const;

/** A duration in milliseconds in words: "90 min", "30 s"; Korean "90분", "30초". */
export function durationWords(ms: number, lang: Lang = 'en'): string {
  // The largest unit the duration is a whole number of (1 h 30 min reads as 90 min, never as 1.5 h).
  const unit = DURATIONS.find((entry) => ms >= entry.ms && ms % entry.ms === 0) ?? DURATIONS[DURATIONS.length - 1];
  if (!unit) return String(ms);
  return `${ms / unit.ms}${unit[lang]}`;
}

/** A size in bytes in words: "2 GiB", "1.5 GiB", "512 MiB"; Korean without the space. */
export function sizeWords(bytes: number, lang: Lang = 'en'): string {
  const space = lang === 'ko' ? '' : ' ';
  const unit = SIZES.find((entry) => bytes >= entry.bytes);
  if (!unit) return `${bytes}${space}B`;
  // Two decimals at most, and none that are zeros ("2 GiB", not "2.00 GiB").
  const amount = Math.round((bytes / unit.bytes) * 100) / 100;
  return `${amount}${space}${unit.unit}`;
}

/** A setting's value as written (see the module comment) in words, or the text as it is when it is not of a unit. */
export function writtenWords(setting: Worded, text: string | null, lang: Lang = 'en'): string | null {
  if (text === null) return null;
  if (setting.off != null && text.trim() === setting.off) return OFF[lang];
  try {
    if (setting.kind === 'duration') return durationWords(parseDuration(text), lang);
    if (setting.kind === 'size') return sizeWords(parseSize(text), lang);
  } catch {
    // Not a duration or a size after all (a value the start refused): as it was written.
  }
  return text;
}

/** A value in use (see the module comment) in words: a duration from milliseconds, a size from bytes. */
export function inUseWords(setting: Worded, raw: string | null, lang: Lang = 'en'): string | null {
  if (raw === null) return null;
  if (setting.kind !== 'duration' && setting.kind !== 'size') return raw;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || raw.trim() === '') return raw;
  // A duration that can be off is off at 0.
  if (setting.kind === 'duration' && amount === 0 && setting.off != null) return OFF[lang];
  return setting.kind === 'duration' ? durationWords(amount, lang) : sizeWords(amount, lang);
}
