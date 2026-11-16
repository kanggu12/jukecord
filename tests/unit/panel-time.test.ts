/**
 * The panel's one style for days, times of day and lengths of time (panel/src/time.ts), in both languages, and the
 * rounding that keeps a total and its parts agreeing as shown. Moments are made with the local Date constructor, so the
 * tests hold in any time zone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { words } from '../../panel/src/i18n.ts';
import {
  apportioned,
  clockTime,
  dayRangeText,
  dayText,
  hourSpanText,
  hourText,
  lengthText,
  momentText,
  monthText,
  rounded,
  withLongest,
} from '../../panel/src/time.ts';
import { hourSpan } from '../../src/core/facts.ts';

// The words keep a no-break space where a wrapped line must not break (core/say.ts together(): a number with its unit,
// a month with its day, Korean's "할 수 있음"): an expected text writes it as "⍽", so it can be seen.
const kept = (text: string) => text.replaceAll('⍽', String.fromCharCode(0xa0));

// A moment in the local time zone, as the panel's Date fields read it.
const local = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second).getTime();

describe('days and times as the panel writes them', () => {
  it('writes a day with a short month in English and in numbers in Korean, the year when asked', () => {
    assert.equal(dayText('2025-11-22', 'en', false), kept('Nov⍽22'));
    assert.equal(dayText('2025-11-22', 'en', true), kept('Nov⍽22, 2025'));
    assert.equal(dayText('2025-11-02', 'ko', false), kept('11월⍽2일'));
    assert.equal(dayText('2025-11-02', 'ko', true), kept('2025년⍽11월⍽2일'));
  });

  it('writes a time of day on the 24-hour clock in two digits, in both languages', () => {
    assert.equal(clockTime(local(2026, 11, 13, 9, 5)), '09:05');
    assert.equal(clockTime(local(2026, 11, 13, 21, 53)), '21:53');
    assert.equal(clockTime(local(2026, 11, 13, 4, 25, 7), true), '04:25:07');
    assert.equal(hourText(9), '09:00');
    assert.equal(hourSpanText(9, 'en'), '09:00 – 10:00');
    assert.equal(hourSpanText(23, 'ko'), '23:00 ~ 24:00');
  });

  it('writes every hour as the panel writes a span, the one way the card and the command line take too', () => {
    // core/facts.ts hourSpan() is what the Discord card and the command line write; the panel's span of two times
    // (i18n.ts rangeOf) has the same dash: the page said "11:00", its picture "11:00 – 12:00", the card "11:00-12:00".
    for (const lang of ['en', 'ko'] as const)
      for (let hour = 0; hour < 24; hour += 1) {
        assert.equal(hourSpan(hour, lang), words(lang).rangeOf(hourText(hour), hourText(hour + 1)));
        assert.equal(hourSpanText(hour, lang), hourSpan(hour, lang));
      }
  });

  it('writes a moment as its day and its time, with the year only when it is not this one or when asked', () => {
    const now = local(2026, 12, 28, 12);
    assert.equal(momentText(local(2026, 12, 31, 21, 41), 'en', { now }), kept('Dec⍽31, 21:41'));
    assert.equal(momentText(local(2027, 1, 4, 21, 41), 'en', { now }), kept('Jan⍽4, 2027, 21:41'));
    assert.equal(momentText(local(2026, 12, 31, 21, 41), 'ko', { now }), kept('12월⍽31일 21:41'));
    assert.equal(momentText(local(2027, 1, 4, 9, 0), 'ko', { now }), kept('2027년⍽1월⍽4일 09:00'));
    assert.equal(momentText(local(2025, 11, 22, 19, 30), 'en', { year: true, now }), kept('Nov⍽22, 2025, 19:30'));
    assert.equal(momentText(local(2026, 11, 22, 19, 30), 'ko', { year: false, now }), kept('11월⍽22일 19:30'));
    assert.equal(momentText(local(2026, 11, 12, 14, 3, 27), 'en', { seconds: true, now }), kept('Nov⍽12, 14:03:27'));
  });

  it('writes a span of days with its year once and its month once where they do not change', () => {
    assert.equal(dayRangeText('2025-11-01', '2025-11-30', 'en', true), kept('Nov⍽1 – 30, 2025'));
    assert.equal(dayRangeText('2026-01-01', '2026-11-13', 'en', true), kept('Jan⍽1 – Nov⍽13, 2026'));
    assert.equal(dayRangeText('2025-11-14', '2026-11-13', 'en', true), kept('Nov⍽14, 2025 – Nov⍽13, 2026'));
    assert.equal(dayRangeText('2025-12-29', '2026-01-04', 'en', false), kept('Dec⍽29 – Jan⍽4'));
    assert.equal(dayRangeText('2026-11-05', '2026-11-11', 'en', false), kept('Nov⍽5 – 11'));
    assert.equal(dayRangeText('2026-11-05', '2026-11-05', 'en', true), kept('Nov⍽5, 2026'));
    assert.equal(dayRangeText('2025-11-01', '2025-11-30', 'ko', true), kept('2025년⍽11월⍽1일 ~ 30일'));
    assert.equal(dayRangeText('2026-01-01', '2026-11-13', 'ko', true), kept('2026년⍽1월⍽1일 ~ 11월⍽13일'));
    assert.equal(dayRangeText('2025-11-14', '2026-11-13', 'ko', true), kept('2025년⍽11월⍽14일 ~ 2026년⍽11월⍽13일'));
    assert.equal(dayRangeText('2025-12-29', '2026-01-04', 'ko', false), kept('12월⍽29일 ~ 1월⍽4일'));
  });

  it('names a month on an axis short, with its year', () => {
    assert.equal(monthText('2025-11-17', 'en'), kept('Nov⍽2025'));
    assert.equal(monthText('2025-11-17', 'ko'), kept('2025년⍽11월'));
  });
});

describe('lengths of time in words', () => {
  it('says hours and minutes, in seconds only under a minute, and no time at all in minutes', () => {
    const say = (ms: number, lang: 'en' | 'ko') => lengthText(rounded(ms), lang);
    assert.equal(say(0, 'en'), kept('0⍽min'));
    assert.equal(say(45_000, 'en'), kept('45⍽s'));
    assert.equal(say(45_000, 'ko'), '45초');
    // 59.6 seconds round to a minute.
    assert.equal(say(59_600, 'en'), kept('1⍽min'));
    assert.equal(say(90_000, 'en'), kept('2⍽min'));
    assert.equal(say(42 * 60_000, 'ko'), '42분');
    assert.equal(say(3_600_000, 'en'), kept('1⍽h'));
    assert.equal(say(3_600_000, 'ko'), '1시간');
    assert.equal(say(69 * 60_000, 'en'), kept('1⍽h 9⍽min'));
    assert.equal(say(69 * 60_000, 'ko'), '1시간 9분');
    assert.equal(say((59 * 60 + 22) * 60_000 + 10_000, 'en'), kept('59⍽h 22⍽min'));
  });

  it('says "under a minute" for a part in minutes that rounds to none though music played in it', () => {
    const { parts } = apportioned([10 * 60_000, 10_000, 0]);
    assert.equal(lengthText(parts[1] ?? rounded(0), 'en'), kept('under a⍽minute'));
    assert.equal(lengthText(parts[1] ?? rounded(0), 'ko'), kept('1분⍽미만'));
    assert.equal(lengthText(parts[2] ?? rounded(1), 'en'), kept('0⍽min'));
  });
});

// A seeded random number, so a failure can be run again.
function randomFrom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('a total and its parts agree as shown', () => {
  it('the case the review found: two days of 2.4 minutes are 5 minutes, the longest 3, not 2', () => {
    const { total, longest } = withLongest(2 * 144_000, 144_000, 2);
    assert.equal(lengthText(total, 'en'), kept('5⍽min'));
    assert.equal(lengthText(longest, 'en'), kept('3⍽min'));
  });

  it('never shows the longest day over the total, or the days at the longest under it, and is within a unit', () => {
    const random = randomFrom(7);
    for (let trial = 0; trial < 4000; trial += 1) {
      const days = 1 + Math.floor(random() * 30);
      // Days of a few seconds to a few hours, a short one now and then.
      const lengths = Array.from({ length: days }, () =>
        Math.round(random() < 0.2 ? 1000 + random() * 90_000 : random() * 4 * 3_600_000 + 1000),
      );
      const totalMs = lengths.reduce((sum, ms) => sum + ms, 0);
      const longestMs = Math.max(...lengths);
      const { total, longest } = withLongest(totalMs, longestMs, days);
      const unit = total.unit === 'second' ? 1000 : 60_000;
      const why = `${days} days ${lengths.join(',')}`;
      assert.equal(longest.unit, total.unit, why);
      assert.ok(longest.count <= total.count, `longest over the total: ${why}`);
      assert.ok(longest.count * days >= total.count, `the days at the longest under the total: ${why}`);
      if (days === 1) assert.equal(longest.count, total.count, why);
      assert.ok(Math.abs(longest.count - longestMs / unit) < 1, `the longest a unit off: ${why}`);
      assert.ok(Math.abs(total.count - totalMs / unit) <= 0.5, `the total off: ${why}`);
    }
  });

  it('apportions parts so they add up to the total as shown, each within a unit of its own time', () => {
    const random = randomFrom(11);
    for (let trial = 0; trial < 4000; trial += 1) {
      const count = 1 + Math.floor(random() * 52);
      const parts = Array.from({ length: count }, () =>
        random() < 0.3 ? 0 : Math.round(random() < 0.3 ? random() * 70_000 : random() * 3 * 3_600_000),
      );
      const { total, parts: shown } = apportioned(parts);
      const unit = total.unit === 'second' ? 1000 : 60_000;
      const why = parts.join(',');
      assert.equal(
        shown.reduce((sum, part) => sum + part.count, 0),
        total.count,
        `the parts do not add up: ${why}`,
      );
      shown.forEach((part, index) => {
        assert.equal(part.unit, total.unit, why);
        assert.ok(Math.abs(part.count - (parts[index] ?? 0) / unit) < 1, `part ${index} a unit off: ${why}`);
        if ((parts[index] ?? 0) === 0) assert.equal(part.count, 0, `an empty part shown with time: ${why}`);
      });
    }
  });
});
