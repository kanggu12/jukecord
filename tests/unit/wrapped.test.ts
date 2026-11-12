import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError } from '../../src/app/actions.ts';
import { COMMANDS } from '../../src/cli/commands.ts';
import { parseLine } from '../../src/cli/main.ts';
import { relativePeriod, wrappedCard } from '../../src/discord/cards.ts';
import { HISTORY_KEEP } from '../../src/store/store.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { Presenter } from '../../src/web/present.ts';
import { addTracks } from '../support/store.ts';
import { ALICE, asHost, BOB, GUILD, testServer } from '../support/web.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-11-11 12:00 UTC, which is 21:00 in Seoul, a Wednesday.
const NOW = Date.UTC(2026, 10, 11, 12);
const look: ActionContext = { guildId: GUILD, userId: null, mayControl: false, mayManage: false };

describe('Wrapped', () => {
  it("sums a server's year in the viewer's time zone: totals, days, the top tracks and people, the moments", async () => {
    const server = await testServer();
    try {
      const { store, actions } = server;
      const [a, b, c] = addTracks(store, 3);
      assert.ok(a && b && c);
      const play = (trackId: number, at: number, by: string | null, ms = 180_000) =>
        store.history.add({ guildId: GUILD, trackId, addedBy: by, playedAt: at, playedMs: ms });
      // New Year's Eve 16:00 UTC is already the new year in Seoul (01:00), so it is 2026's first track there.
      play(c.id, Date.UTC(2025, 11, 31, 16), BOB);
      // Track 1 comes back on three days; track 2 is played four times in one night (more plays, fewer days).
      play(a.id, Date.UTC(2026, 2, 6, 13), ALICE);
      play(a.id, Date.UTC(2026, 2, 13, 13), ALICE);
      play(a.id, Date.UTC(2026, 5, 19, 13), null);
      for (let n = 0; n < 4; n += 1) play(b.id, Date.UTC(2026, 6, 4, 12, n * 10), ALICE, 600_000);
      // Last year's, which this year leaves out.
      play(a.id, Date.UTC(2025, 5, 1), ALICE);
      store.users.upsert({ id: ALICE, name: 'Alice', avatar: 'abc' });
      store.users.upsert({ id: BOB, name: 'Bob', avatar: null });
      const seoul = actions.wrapped(look, undefined, 540, NOW);
      assert.deepEqual(seoul.period, { kind: 'year', key: '2026', from: '2026-01-01', to: '2026-11-11' });
      assert.equal(seoul.plays, 8);
      assert.equal(seoul.playedMs, 4 * 180_000 + 4 * 600_000);
      assert.equal(seoul.tracks, 3);
      // Alice, Bob and the host.
      assert.equal(seoul.people, 3);
      // 1 January, 6 and 13 March, 19 June and 4 July (Seoul's days).
      assert.equal(seoul.days, 5);
      assert.deepEqual(
        seoul.topTracks.map((entry) => [entry.track.title, entry.plays]),
        [
          ['Track 2', 4],
          ['Track 1', 3],
          ['Track 3', 1],
        ],
      );
      assert.deepEqual(
        seoul.topPeople.map((entry) => [entry.userId, entry.plays]),
        [
          [ALICE, 6],
          [null, 1],
          [BOB, 1],
        ],
      );
      // The song of the year is the one that came back on the most days, not the one played most.
      assert.equal(seoul.song?.track.title, 'Track 1');
      assert.equal(seoul.song?.days, 3);
      assert.equal(seoul.song?.plays, 3);
      // Fridays at 22:00 in Seoul (13:00 UTC): 6 and 13 March and 19 June 2026 were Fridays; 4 July a Saturday.
      assert.deepEqual(seoul.weekdays, [0, 0, 0, 0, 1, 3, 4]);
      assert.equal(seoul.hours[22], 3);
      assert.equal(seoul.hours[21], 4);
      assert.equal(seoul.hours.length, 24);
      // The longest day: four tracks of ten minutes.
      assert.deepEqual(seoul.longestDay, { day: '2026-07-04', plays: 4, playedMs: 2_400_000 });
      assert.equal(seoul.firstPlay?.track.title, 'Track 3');
      assert.deepEqual(seoul.years, ['2026', '2025']);
      assert.deepEqual(seoul.months, ['2026-07', '2026-06', '2026-03', '2026-01', '2025-06']);
      assert.equal(seoul.keptFrom, null);
      // In UTC the New Year's Eve play is last year's.
      const utc = actions.wrapped(look, '2026', 0, NOW);
      assert.equal(utc.plays, 7);
      assert.equal(utc.firstPlay?.track.title, 'Track 1');
      // The names come with the API's answer, the host's as none.
      const shown = new Presenter(store.users).wrapped(seoul);
      assert.deepEqual(
        shown.topPeople.map((entry) => [entry.name, entry.avatar]),
        [
          ['Alice', 'abc'],
          [null, null],
          ['Bob', null],
        ],
      );
      assert.equal(shown.firstTrack?.addedByName, 'Bob');
    } finally {
      await server.close();
    }
  });

  it('covers a month or the last twelve months, ends the time today while it lasts, and refuses other names', async () => {
    const server = await testServer();
    try {
      const { store, actions } = server;
      const [a] = addTracks(store, 1);
      assert.ok(a);
      store.history.add({ guildId: GUILD, trackId: a.id, addedBy: null, playedAt: NOW - 400 * DAY, playedMs: 5000 });
      store.history.add({ guildId: GUILD, trackId: a.id, addedBy: null, playedAt: NOW - 300 * DAY, playedMs: 5000 });
      const march = actions.wrapped(look, '2026-03', 540, NOW);
      assert.deepEqual(march.period, { kind: 'month', key: '2026-03', from: '2026-03-01', to: '2026-03-31' });
      assert.equal(march.plays, 0);
      assert.equal(march.song, null);
      assert.equal(march.longestDay, null);
      assert.equal(march.firstPlay, null);
      assert.deepEqual(march.weekdays, [0, 0, 0, 0, 0, 0, 0]);
      // From the day after this date a year ago, through today.
      const year = actions.wrapped(look, 'last-12-months', 540, NOW);
      assert.deepEqual(year.period, {
        kind: 'last-12-months',
        key: 'last-12-months',
        from: '2025-11-12',
        to: '2026-11-11',
      });
      assert.equal(year.plays, 1);
      // A time that is over ends on its own last day.
      assert.equal(actions.wrapped(look, '2025', 540, NOW).period.to, '2025-12-31');
      for (const wrong of ['26', '2026-13', '2026-3', 'last-year', '1969', ' 2026']) {
        assert.throws(
          () => actions.wrapped(look, wrong, 540, NOW),
          (error: unknown) => error instanceof ActionError && error.code === 'invalid',
          wrong,
        );
      }
      assert.throws(
        () => actions.wrapped(look, '2026', 900, NOW),
        (error: unknown) => error instanceof ActionError,
      );
    } finally {
      await server.close();
    }
  });

  it('answers the same question again from what it kept, until a play is added or the day changes', async () => {
    const server = await testServer();
    try {
      const { store, actions } = server;
      const [a] = addTracks(store, 1);
      assert.ok(a);
      store.history.add({ guildId: GUILD, trackId: a.id, addedBy: null, playedAt: NOW - DAY, playedMs: 5000 });
      const first = actions.wrapped(look, '2026', 540, NOW);
      assert.equal(actions.wrapped(look, '2026', 540, NOW), first);
      // Another time zone or another day is another question.
      assert.notEqual(actions.wrapped(look, '2026', 0, NOW), first);
      assert.notEqual(actions.wrapped(look, '2026', 540, NOW + DAY), first);
      store.history.add({ guildId: GUILD, trackId: a.id, addedBy: null, playedAt: NOW, playedMs: 5000 });
      const after = actions.wrapped(look, '2026', 540, NOW);
      assert.notEqual(after, first);
      assert.equal(after.plays, 2);
    } finally {
      await server.close();
    }
  });

  it('says from when the history reaches, once a server has as many plays as jukecord keeps', async () => {
    const server = await testServer();
    try {
      const { store, actions } = server;
      const [a] = addTracks(store, 1);
      assert.ok(a);
      // As many plays as are kept, the oldest on 2026-03-03 (Seoul), the rest every ten minutes after.
      const start = Date.UTC(2026, 2, 2, 16);
      store.transaction(() => {
        for (let n = 0; n < HISTORY_KEEP; n += 1)
          store.history.add({
            guildId: GUILD,
            trackId: a.id,
            addedBy: null,
            playedAt: start + n * 600_000,
            playedMs: 5000,
          });
      });
      assert.equal(actions.wrapped(look, '2026', 540, NOW).keptFrom, '2026-03-03');
      // A time that starts after the oldest play kept is whole.
      assert.equal(actions.wrapped(look, '2026-04', 540, NOW).keptFrom, null);
    } finally {
      await server.close();
    }
  });

  it('answers over the API to any login that can open the server, in the shape the schema says', async () => {
    const server = await testServer();
    try {
      const [a] = addTracks(server.store, 1);
      assert.ok(a);
      server.store.history.add({ guildId: GUILD, trackId: a.id, addedBy: null, playedAt: Date.now(), playedMs: 5000 });
      const url = `${API_PREFIX}/guilds/${GUILD}/wrapped`;
      const answer = await server.web.app.inject({
        method: 'GET',
        url: `${url}?period=last-12-months&tz=540`,
        headers: asHost,
      });
      assert.equal(answer.statusCode, 200);
      const body = answer.json();
      assert.equal(body.plays, 1);
      assert.equal(body.period.kind, 'last-12-months');
      assert.equal(body.topTracks[0].track.title, 'Track 1');
      assert.equal(body.topTracks[0].track.source, undefined);
      assert.equal(body.song.days, 1);
      assert.equal(body.firstTrack.track.title, 'Track 1');
      // Left out, the time is this year.
      assert.equal((await server.web.app.inject({ method: 'GET', url, headers: asHost })).json().period.kind, 'year');
      for (const wrong of ['2026-00', 'last-year', '20261']) {
        const refused = await server.web.app.inject({ method: 'GET', url: `${url}?period=${wrong}`, headers: asHost });
        assert.equal(refused.statusCode, 400, wrong);
      }
      assert.equal((await server.web.app.inject({ method: 'GET', url })).statusCode, 401);
    } finally {
      await server.close();
    }
  });
});

describe('Wrapped in the jukecord command', () => {
  const request = (line: string) =>
    COMMANDS.wrapped.request(parseLine(line.split(' ').filter(Boolean)), { queueItemId: async () => 0 }) as {
      query: Record<string, string | number>;
    };

  it('names the time from its options, this year by default, with the time zone of the machine', () => {
    assert.deepEqual(Object.keys(request('').query), ['tz']);
    assert.equal(request('--year 2025').query.period, '2025');
    assert.equal(request('--month 2026-03').query.period, '2026-03');
    assert.equal(request('--year 2025 --month 3').query.period, '2025-03');
    assert.equal(request(`--month 11`).query.period, `${new Date().getFullYear()}-11`);
    assert.equal(request('--last').query.period, 'last-12-months');
    for (const wrong of ['--year 26', '--month 13', '--month 2026-3', '--last --year 2025'])
      assert.throws(() => request(wrong), /--/, wrong);
  });

  it('shows the time as lines of text, and says when nothing played', () => {
    const track = { title: 'Morning Light', url: 'https://example.com/a', durationMs: 180_000 };
    const text = COMMANDS.wrapped.show({
      period: { kind: 'year', key: '2026', from: '2026-01-01', to: '2026-11-11' },
      plays: 12,
      playedMs: 3_900_000,
      tracks: 3,
      people: 2,
      days: 5,
      topTracks: [{ track, plays: 9 }],
      topPeople: [
        { name: 'Alice', plays: 10 },
        { name: null, plays: 2 },
      ],
      weekdays: [0, 0, 0, 0, 0, 7, 5],
      hours: Array.from({ length: 24 }, (_, hour) => (hour === 22 ? 6 : 0)),
      longestDay: { day: '2026-07-04', plays: 4, playedMs: 2_400_000 },
      firstTrack: { track, playedAt: Date.UTC(2026, 0, 1), addedByName: 'Alice' },
      song: { track, plays: 9, days: 4 },
      keptFrom: null,
    });
    assert.match(text, /^2026 in music \(2026-01-01 to 2026-11-11\)/);
    assert.match(text, /12 plays · 1 h 5 min · 3 tracks · 2 people · music on 5 days/);
    assert.match(text, /Song of 2026: Morning Light \(played on 4 days, 9 times\)/);
    assert.match(text, /\n {5}2 {2}the host\n/);
    assert.match(text, /Busiest: Fridays, 22:00-23:00/);
    assert.match(text, /Longest day: 2026-07-04, 40 min \(4 plays\)/);
    assert.match(text, /First track: .*Morning Light, added by Alice/);
    // A quiet month reads in the singular.
    const quiet = COMMANDS.wrapped.show({
      period: { kind: 'month', key: '2025-11', from: '2025-11-01', to: '2025-11-30' },
      plays: 1,
      playedMs: 120_000,
      tracks: 1,
      people: 1,
      days: 1,
      topTracks: [{ track, plays: 1 }],
      topPeople: [{ name: null, plays: 1 }],
      weekdays: [1, 0, 0, 0, 0, 0, 0],
      hours: Array.from({ length: 24 }, (_, hour) => (hour === 4 ? 1 : 0)),
      longestDay: { day: '2025-11-23', plays: 1, playedMs: 120_000 },
      firstTrack: null,
      song: { track, plays: 1, days: 1 },
      keptFrom: null,
    });
    assert.match(quiet, /1 play · 2 min · 1 track · 1 person · music on 1 day/);
    assert.match(quiet, /Song of 2025-11: Morning Light \(played on 1 day, once\)/);
    assert.match(quiet, /Longest day: 2025-11-23, 2 min \(1 play\)/);
    const empty = COMMANDS.wrapped.show({
      period: { kind: 'last-12-months', key: 'last-12-months', from: '2025-11-12', to: '2026-11-11' },
      plays: 0,
    });
    assert.equal(empty, 'The last 12 months in music (2025-11-12 to 2026-11-11)\nNothing was played in this time');
  });
});

describe('Wrapped in Discord', () => {
  it('turns each choice into the time it names where the person is', () => {
    // 2026-01-15 20:00 UTC is already the 16th in Seoul; a choice is read by the person's own date.
    const now = Date.UTC(2026, 0, 15, 20);
    assert.equal(relativePeriod(null, 540, now), '2026');
    assert.equal(relativePeriod('this-year', 540, now), '2026');
    assert.equal(relativePeriod('last-year', 540, now), '2025');
    assert.equal(relativePeriod('this-month', 540, now), '2026-01');
    assert.equal(relativePeriod('last-month', 540, now), '2025-12');
    assert.equal(relativePeriod('last-12-months', 540, now), 'last-12-months');
    // On New Year's Eve in UTC it is New Year's Day in Seoul.
    assert.equal(relativePeriod('this-year', 540, Date.UTC(2025, 11, 31, 20)), '2026');
    assert.equal(relativePeriod('this-year', 0, Date.UTC(2025, 11, 31, 20)), '2025');
  });

  it("makes a card of the server's time in both languages, with the panel's page of it", async () => {
    const server = await testServer();
    try {
      const { store, actions } = server;
      const [a] = addTracks(store, 1);
      assert.ok(a);
      store.tracks.upsert({ ...a, thumbnail: 'https://images.example.com/a.jpg' });
      store.history.add({
        guildId: GUILD,
        trackId: a.id,
        addedBy: ALICE,
        playedAt: Date.UTC(2026, 5, 19, 13),
        playedMs: 4_000_000,
      });
      const view = actions.wrapped(look, '2026', 540, NOW);
      const english = wrappedCard(view, 'en', 'Night Owls', 'https://music.example.com', 540);
      const card = english.embeds[0]?.toJSON();
      assert.equal(card?.title, 'Night Owls · 2026 in music');
      assert.match(
        card?.description ?? '',
        /\*\*1\*\* play · listened \*\*1 h 7 min\*\* · \*\*1\*\* track · \*\*1\*\* person · music on \*\*1\*\* day/,
      );
      assert.match(
        card?.description ?? '',
        /\*\*Song of 2026\*\*\n\[Track 1\]\(https:\/\/example.com\/watch\?v=v1\) · played on 1 day, once/,
      );
      assert.match(card?.description ?? '', /1\. <@300000000000000001> · 1/);
      assert.equal(card?.thumbnail?.url, 'https://images.example.com/a.jpg');
      assert.deepEqual(
        card?.fields?.map((field) => [field.name, field.value]),
        [
          ['Busiest day', 'Fridays'],
          ['Busiest hour', '22:00-23:00'],
          ['Longest day', 'June 19 · 1 h 7 min'],
          ['First track', '[Track 1](https://example.com/watch?v=v1) · June 19'],
        ],
      );
      assert.equal(card?.footer?.text, '2026-01-01 to 2026-11-11');
      const link = english.components[0]?.toJSON().components[0] as { url?: string } | undefined;
      assert.equal(link?.url, 'https://music.example.com/stats/wrapped?period=2026');
      const korean = wrappedCard(view, 'ko', 'Night Owls', null, 540);
      const kard = korean.embeds[0]?.toJSON();
      assert.equal(kard?.title, 'Night Owls · 2026년 음악 결산');
      assert.match(kard?.description ?? '', /재생 \*\*1\*\*회 · 들은 시간 \*\*1시간 7분\*\*/);
      assert.match(kard?.description ?? '', /\*\*2026년의 노래\*\*\n.* · 1일에 걸쳐 1번 재생/);
      assert.deepEqual(kard?.fields?.map((field) => field.value).slice(0, 3), [
        '금요일',
        '22:00-23:00',
        '6월 19일 · 1시간 7분',
      ]);
      assert.equal(korean.components.length, 0);
      // Nothing played: said in the card, which keeps its title.
      const quiet = wrappedCard(actions.wrapped(look, '2026-03', 540, NOW), 'en', '', null, 540).embeds[0]?.toJSON();
      assert.equal(quiet?.title, 'March 2026 in music');
      assert.equal(quiet?.description, 'Nothing was played in this time');
      const twelve = wrappedCard(
        actions.wrapped(look, 'last-12-months', 540, NOW),
        'en',
        '',
        null,
        540,
      ).embeds[0]?.toJSON();
      assert.equal(twelve?.title, 'The last 12 months in music');
    } finally {
      await server.close();
    }
  });
});
