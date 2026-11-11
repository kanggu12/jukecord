import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionError } from '../../src/app/actions.ts';
import { Presenter } from '../../src/web/present.ts';
import { addTracks } from '../support/store.ts';
import { ALICE, GUILD, testServer } from '../support/web.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-11-11 12:00 UTC, which is 21:00 in Seoul.
const NOW = Date.UTC(2026, 10, 11, 12);

describe('listening statistics', () => {
  it("counts plays per day in the viewer's time zone, with the quiet days in, and ranks tracks and people", async () => {
    const server = await testServer();
    try {
      const { store, actions } = server;
      const [a, b] = addTracks(store, 2);
      assert.ok(a && b);
      const play = (trackId: number, at: number, by: string | null, ms = 180_000) =>
        store.history.add({ guildId: GUILD, trackId, addedBy: by, playedAt: at, playedMs: ms });
      // 2026-11-10 23:30 UTC is already 11-11 in Seoul (08:30).
      play(a.id, Date.UTC(2026, 10, 10, 23, 30), ALICE);
      play(a.id, Date.UTC(2026, 10, 11, 10), ALICE);
      play(b.id, Date.UTC(2026, 10, 9, 5), null, 60_000);
      // Too old for a seven-day span.
      play(b.id, NOW - 9 * DAY, null);
      store.users.upsert({ id: ALICE, name: 'Alice', avatar: null });
      const context = { guildId: GUILD, userId: null, mayControl: false, mayManage: false };
      const seoul = actions.stats(context, 7, 540, NOW);
      assert.equal(seoul.span, 7);
      assert.equal(seoul.from, '2026-11-05');
      assert.deepEqual(
        seoul.days.map((day) => [day.day, day.plays]),
        [
          ['2026-11-05', 0],
          ['2026-11-06', 0],
          ['2026-11-07', 0],
          ['2026-11-08', 0],
          ['2026-11-09', 1],
          ['2026-11-10', 0],
          ['2026-11-11', 2],
        ],
      );
      assert.equal(seoul.plays, 3);
      assert.equal(seoul.playedMs, 420_000);
      // Hours in Seoul: 08:30, 19:00 and 14:00.
      assert.deepEqual(
        seoul.hours.flatMap((count, hour) => (count ? [hour] : [])),
        [8, 14, 19],
      );
      assert.deepEqual(
        seoul.topTracks.map((entry) => [entry.track.title, entry.plays]),
        [
          ['Track 1', 2],
          ['Track 2', 1],
        ],
      );
      const shown = new Presenter(store.users).stats(seoul);
      assert.deepEqual(
        shown.topPeople.map((entry) => [entry.name, entry.plays]),
        [
          ['Alice', 2],
          [null, 1],
        ],
      );
      // In UTC the late play is still the 10th.
      const utc = actions.stats(context, 7, 0, NOW);
      assert.equal(utc.days.find((day) => day.day === '2026-11-10')?.plays, 1);
      assert.throws(
        () => actions.stats(context, 0),
        (error: unknown) => error instanceof ActionError,
      );
      assert.throws(
        () => actions.stats(context, 7, 900),
        (error: unknown) => error instanceof ActionError,
      );
    } finally {
      await server.close();
    }
  });
});
