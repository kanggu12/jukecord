/**
 * Days, times of day and lengths of time as the panel writes them: one style in each language, on every page (Wrapped
 * and its pictures, the statistics, the log, the invites, a guest's link, the queue's length).
 *
 * - A day: "Nov 22" ("11월 22일"), with its year when asked, or for a moment when it is not this year's.
 * - A time of day: the 24-hour clock in two digits ("09:30", "19:30:07" with its seconds), as the charts' hours are.
 * - A moment: its day and its time ("Nov 22, 19:30", "11월 22일 19:30").
 * - A span of days: "Nov 1 – 30, 2025" ("2025년 11월 1일 ~ 30일").
 * - A length of time in words: "59 h 22 min" ("59시간 22분"), in whole minutes, in seconds under a minute. A track's
 *   length and a countdown stay a clock ("3:07", dom.ts clock()): they are read against a clock that runs.
 *
 * Figures shown beside their total are rounded so that they agree with it (withLongest(), apportioned()).
 *
 * Kept apart from the pages, as axis.ts is: the language is given and the time zone is the browser's (a Date's own
 * fields), so it is tested as it is.
 */
import { type Lang, words } from './i18n.ts';

/** [year, month, day] of a calendar day written "YYYY-MM-DD" (a day of the viewer's calendar, as the API sends it). */
export function dayParts(day: string): [number, number, number] {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return [year, month, date];
}

// Two digits, as a clock writes them.
function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** A calendar day: "Nov 22", or "Nov 22, 2025" with its year ("11월 22일", "2025년 11월 22일"). */
export function dayText(day: string, lang: Lang, withYear: boolean): string {
  const [year, month, date] = dayParts(day);
  return words(lang).dayOf(month, date, withYear ? String(year) : null);
}

/** A time of day in this browser's time zone, on the 24-hour clock: "09:30", or "09:30:07" with its seconds. */
export function clockTime(at: number, seconds = false): string {
  const when = new Date(at);
  const time = `${two(when.getHours())}:${two(when.getMinutes())}`;
  return seconds ? `${time}:${two(when.getSeconds())}` : time;
}

/** An hour of the day by its start, as a clock writes it: "09:00". */
export function hourText(hour: number): string {
  return `${two(hour)}:00`;
}

/** An hour of the day as the span it is: "09:00 – 10:00" ("09:00 ~ 10:00"). */
export function hourSpanText(hour: number, lang: Lang): string {
  return words(lang).rangeOf(hourText(hour), hourText(hour + 1));
}

/**
 * A moment in this browser's time zone: its day and its time ("Nov 22, 19:30", "11월 22일 19:30"). Its year is said
 * when asked for, and otherwise when it is not this year's ("Jan 4, 2027, 21:41" seen in December).
 */
export function momentText(
  at: number,
  lang: Lang,
  { year, seconds = false, now = Date.now() }: { year?: boolean; seconds?: boolean; now?: number } = {},
): string {
  const when = new Date(at);
  const own = when.getFullYear();
  const withYear = year ?? own !== new Date(now).getFullYear();
  const day = words(lang).dayOf(when.getMonth() + 1, when.getDate(), withYear ? String(own) : null);
  return words(lang).dayAndTime(day, clockTime(at, seconds));
}

/** A span of calendar days ("YYYY-MM-DD" each): "Nov 1 – 30, 2025", "2025년 11월 1일 ~ 30일" (without the year when asked). */
export function dayRangeText(from: string, to: string, lang: Lang, withYear: boolean): string {
  return words(lang).dayRange(dayParts(from), dayParts(to), withYear);
}

/** A month on a chart's axis, from a day in it ("YYYY-MM-DD" or "YYYY-MM"): "Nov 2025" ("2025년 11월"). */
export function monthText(day: string, lang: Lang): string {
  const [year, month] = dayParts(day);
  return words(lang).monthOf(year, month);
}

/** A length of time as it is shown: a whole number of minutes, or of seconds while it is under a minute. */
export interface Length {
  readonly unit: 'second' | 'minute';
  readonly count: number;
  /** Whether any time is in it: a part that rounds to no minutes though music played says so ("under a minute"). */
  readonly some: boolean;
}

// The milliseconds in each unit.
const UNIT_MS = { second: 1000, minute: 60_000 } as const;

/** A length rounded to the nearest of its unit: seconds while that is under a minute, else minutes. */
export function rounded(ms: number, unit?: Length['unit']): Length {
  const time = Math.max(0, ms);
  // 59.6 seconds round to 60, which is a minute: the unit is chosen on the rounded seconds. No time at all is said in
  // minutes ("0 min"), as a time with none listened says it.
  const own = unit ?? (time > 0 && Math.round(time / 1000) < 60 ? 'second' : 'minute');
  return { unit: own, count: Math.round(time / UNIT_MS[own]), some: time > 0 };
}

/** A length's words split for a figure: its number, and the rest beside it ("59" and "h 22 min", "45" and "s"). */
export function lengthParts(length: Length, lang: Lang): readonly [string, string] {
  return length.unit === 'second'
    ? words(lang).lengthOf(0, 0, length.count)
    : words(lang).lengthOf(Math.floor(length.count / 60), length.count % 60, null);
}

/** A length in words on one line: "59 h 22 min", "45 s" ("59시간 22분", "45초"); "under a minute" for a part of a
 * total in minutes that rounds to none though music played in it. */
export function lengthText(length: Length, lang: Lang): string {
  if (length.unit === 'minute' && length.count === 0 && length.some) return words(lang).underMinute;
  const [number, rest] = lengthParts(length, lang);
  return words(lang).lengthWords(number, rest);
}

/**
 * A total and the longest of its `parts` parts, rounded so that they agree as shown: the longest part is never more
 * than the total, `parts` parts as long as it come to the total at least, and a total of one part is that part. Each
 * rounded on its own, they did not: two days of 2.4 minutes are 5 minutes in all, but 2 minutes at the longest.
 * The longest is raised (never by a whole unit) to the total shared evenly, rounded up, when it falls short of it.
 */
export function withLongest(totalMs: number, longestMs: number, parts: number): { total: Length; longest: Length } {
  const total = rounded(totalMs);
  const own = rounded(longestMs, total.unit);
  // The total shared evenly between the parts, rounded up: the least the longest can be, as shown.
  const share = Math.ceil(total.count / Math.max(1, parts));
  return { total, longest: { ...own, count: Math.min(total.count, Math.max(own.count, share)) } };
}

/**
 * Parts of a total, rounded so that they add up to their total as shown (the largest remainder method): each part
 * rounded down, then the units the rounded total still has, one each, to the parts that lost most in rounding down
 * (the longer part first, then the earlier). Each rounded on its own, two days of 2.4 minutes showed 2 and 2 under a
 * total of 5.
 */
export function apportioned(partsMs: readonly number[]): { total: Length; parts: Length[] } {
  const total = rounded(partsMs.reduce((sum, part) => sum + Math.max(0, part), 0));
  const size = UNIT_MS[total.unit];
  const down = partsMs.map((part) => Math.floor(Math.max(0, part) / size));
  // What the parts rounded down fall short of the total: never below zero, never more than the parts that lost some.
  let left = total.count - down.reduce((sum, count) => sum + count, 0);
  const counts = [...down];
  const order = partsMs
    .map((part, index) => ({ index, part, lost: Math.max(0, part) / size - (down[index] ?? 0) }))
    .filter((entry) => entry.lost > 0)
    .sort((a, b) => b.lost - a.lost || b.part - a.part || a.index - b.index);
  for (const entry of order) {
    if (left <= 0) break;
    counts[entry.index] = (counts[entry.index] ?? 0) + 1;
    left -= 1;
  }
  return {
    total,
    parts: counts.map((count, index) => ({ unit: total.unit, count, some: (partsMs[index] ?? 0) > 0 })),
  };
}
