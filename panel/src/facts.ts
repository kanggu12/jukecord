/**
 * Which of Wrapped's superlatives are true to say: the busiest day of the week and hour of the day, and the song of the
 * time. A "busiest" picked from a tie, a habit ("Sundays") drawn from one evening, or a song of the time among tracks
 * played once each would be shared, in a picture, as a fact it is not. What is not true is left out, silently: the
 * page and the picture show the other figures.
 *
 * Kept apart from the pages (which need a browser), as axis.ts is, so the rules are tested as they are
 * (tests/unit/facts.test.ts).
 */
import type { Wrapped } from './api.ts';

/** How many days with music a time needs before it names a habit: a week of them. Fewer, and one evening decides. */
export const HABIT_DAYS = 7;

/** Where the one largest of some counts is, or -1 when the largest is shared (a tie names nothing) or all are zero. */
export function alone(values: readonly number[]): number {
  const top = Math.max(0, ...values);
  if (top === 0) return -1;
  const first = values.indexOf(top);
  // A second count as large: a tie.
  return values.indexOf(top, first + 1) === -1 ? first : -1;
}

// The day of the week of a calendar day "YYYY-MM-DD", Sunday 0, as the API counts the weekdays.
function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/**
 * The busiest day of the week as a habit (Sunday 0), or -1: alone at the top, in a time with music on a week of days
 * or more, its plays not mostly one day's (one long night on a Saturday is not a habit of Saturdays; one long Friday
 * among a year of Fridays does not stop Fridays being one).
 */
export function busiestWeekday(wrapped: Pick<Wrapped, 'weekdays' | 'days' | 'longestDay'>): number {
  if (wrapped.days < HABIT_DAYS) return -1;
  const top = alone(wrapped.weekdays);
  const longest = wrapped.longestDay;
  // The longest day on the top's day of the week, holding more than half of its plays: the top is that day.
  if (top >= 0 && longest && weekdayOf(longest.day) === top && longest.plays * 2 > (wrapped.weekdays[top] ?? 0))
    return -1;
  return top;
}

/**
 * The busiest hour of the day as a habit (0 to 23), or -1: alone at the top, in a time with music on a week of days or
 * more, whose longest day does not hold most of its plays (the hours would be that day's).
 */
export function busiestHour(wrapped: Pick<Wrapped, 'hours' | 'days' | 'plays' | 'longestDay'>): number {
  if (wrapped.days < HABIT_DAYS) return -1;
  if (wrapped.longestDay && wrapped.longestDay.plays * 2 > wrapped.plays) return -1;
  return alone(wrapped.hours);
}

/**
 * Whether the time has a song: one that played more than once. The song is the track played on the most days, then
 * the most times; when it played once, every track played once, and it was only the longest of them.
 */
export function hasSong(wrapped: Pick<Wrapped, 'song'>): boolean {
  return (wrapped.song?.plays ?? 0) > 1;
}
