/**
 * Wrapped names a busiest day or hour, and a song of the time, only when it is true (panel/src/facts.ts): never from a
 * tie, never a habit from a few days or from one long night, never a song among tracks played once each.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alone, busiestHour, busiestWeekday, HABIT_DAYS, hasSong } from '../../panel/src/facts.ts';

// Twenty-four hours, zero but the ones given.
const hours = (given: Record<number, number>) => Array.from({ length: 24 }, (_, hour) => given[hour] ?? 0);

describe('the one largest of some counts', () => {
  it('is where it is when it stands alone, and nothing when shared or when all are zero', () => {
    assert.equal(alone([0, 3, 1]), 1);
    assert.equal(alone([1, 0, 0, 0, 0, 0, 1]), -1);
    assert.equal(alone([0, 0, 0]), -1);
    assert.equal(alone([]), -1);
  });
});

describe('the busiest day of the week', () => {
  // A month of music: Fridays the busiest by far, on many days.
  const month = {
    weekdays: [4, 3, 2, 5, 3, 14, 6],
    days: 12,
    longestDay: { day: '2026-03-13', plays: 5, playedMs: 1 },
  };

  it('is named when it is a habit', () => {
    // 2026-03-13 was a Friday: its 5 plays are not most of the Fridays' 14.
    assert.equal(busiestWeekday(month), 5);
  });

  it('stays named when one long day is a small part of it (a long Friday in a year of Fridays)', () => {
    // 2026-06-26 was a Friday of 46 plays, of 391 on Fridays; Saturdays would lead without it, but Fridays are a habit.
    assert.equal(
      busiestWeekday({
        weekdays: [300, 280, 290, 310, 300, 391, 360],
        days: 307,
        longestDay: { day: '2026-06-26', plays: 46, playedMs: 1 },
      }),
      5,
    );
  });

  it('is not named from fewer than a week of days with music (the review: "Sundays" from one play)', () => {
    assert.equal(busiestWeekday({ ...month, days: HABIT_DAYS - 1 }), -1);
    assert.equal(
      busiestWeekday({
        weekdays: [1, 0, 0, 0, 0, 0, 1],
        days: 2,
        longestDay: { day: '2025-11-22', plays: 1, playedMs: 144_000 },
      }),
      -1,
    );
  });

  it('is not named from a tie', () => {
    assert.equal(busiestWeekday({ ...month, weekdays: [4, 3, 2, 5, 3, 14, 14] }), -1);
  });

  it('is not named when one long night makes it (its longest day holds most of its plays)', () => {
    // 2026-07-11 was a Saturday with 46 plays: without it, Saturdays have 3.
    assert.equal(
      busiestWeekday({
        weekdays: [4, 3, 2, 5, 3, 6, 49],
        days: 9,
        longestDay: { day: '2026-07-11', plays: 46, playedMs: 1 },
      }),
      -1,
    );
  });
});

describe('the busiest hour of the day', () => {
  const longestDay = { day: '2026-03-13', plays: 3, playedMs: 1 };

  it('is named alone at the top from a week of days with music', () => {
    assert.equal(busiestHour({ hours: hours({ 21: 9, 22: 4, 10: 2 }), days: 8, plays: 15, longestDay }), 21);
  });

  it('is not named from a tie or from fewer days (the review: "10:00 · 1 play" beside an equal bar)', () => {
    assert.equal(busiestHour({ hours: hours({ 10: 1, 19: 1 }), days: 2, plays: 2, longestDay }), -1);
    assert.equal(busiestHour({ hours: hours({ 10: 6, 19: 6 }), days: 20, plays: 12, longestDay }), -1);
    assert.equal(busiestHour({ hours: hours({ 21: 9 }), days: HABIT_DAYS - 1, plays: 9, longestDay }), -1);
  });

  it('is not named when one day holds most of the plays (the hours are that one night)', () => {
    const night = { day: '2026-07-11', plays: 46, playedMs: 1 };
    assert.equal(busiestHour({ hours: hours({ 21: 20, 22: 18, 10: 6 }), days: 9, plays: 52, longestDay: night }), -1);
  });
});

describe('the song of the time', () => {
  it('is one that played more than once', () => {
    assert.equal(hasSong({ song: null }), false);
    const song = (plays: number) => ({
      track: {} as never,
      plays,
      playedMs: plays * 180_000,
      days: 1,
    });
    assert.equal(hasSong({ song: song(1) }), false);
    assert.equal(hasSong({ song: song(2) }), true);
  });
});
