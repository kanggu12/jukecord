/**
 * Lyrics: which song a track is, LRC read into timed lines, LRCLIB's answers (in their real shapes, with made-up
 * songs: tests/fixtures/lrclib), choosing among search results, and the lookups themselves: kept once found, asked
 * once however many ask, one request at a time with a pause between, LRCLIB's "wait" obeyed, failures remembered.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import type { Track } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import {
  bestRecord,
  LrclibClient,
  type LrclibRecord,
  LrclibWait,
  Lyrics,
  type LyricsLookup,
  LyricsUnavailable,
  parseLrc,
  type Song,
  songOf,
} from '../../src/media/lyrics.ts';
import type { OutboundAnswer } from '../../src/media/outbound.ts';
import { Resolver } from '../../src/media/resolver.ts';
import { tracksFromInfo, type YtDlp } from '../../src/media/ytdlp.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const log = createLogger({ level: 'error', sinks: [] });
const fixture = (name: string) => fs.readFileSync(new URL(`../fixtures/lrclib/${name}`, import.meta.url), 'utf8');

// A track as songOf reads it.
const track = (title: string, uploader: string | null = null, durationMs: number | null = 187_000) => ({
  title,
  uploader,
  durationMs,
});

describe('songOf', () => {
  it("takes what the site said the recording is, without a featured artist, and the album's name", () => {
    assert.deepEqual(
      songOf(track('Whatever the video says'), {
        artist: 'Example Band',
        title: 'Paper Boats (feat. Sample Sound)',
        album: 'Made-up Rivers',
      }),
      { artist: 'Example Band', title: 'Paper Boats', album: 'Made-up Rivers', seconds: 187, tagged: true },
    );
  });

  it('reads "Artist - Song" with the usual decorations taken off', () => {
    const cases: [string, string | null, string, string][] = [
      ['Example Band - Paper Boats (Official Video)', null, 'Example Band', 'Paper Boats'],
      ['Example Band – Low Tide [Lyrics]', null, 'Example Band', 'Low Tide'],
      [
        'The Placeholders - Static Bloom (feat. Sample Sound) [Official Audio]',
        null,
        'The Placeholders',
        'Static Bloom',
      ],
      ['[MV] 예시 밴드 _ 파란 자전거', null, '예시 밴드', '파란 자전거'],
      ['예시 밴드 - 첫눈이 오면 (가사)', null, '예시 밴드', '첫눈이 오면'],
      ['Demo Orchestra - Velvet Hours | Official Music Video', null, 'Demo Orchestra', 'Velvet Hours'],
      ["SAMPLE 'Neon Rain' M/V", null, 'SAMPLE', 'Neon Rain'],
      ['Example Band - Copper Skies ft. Sample Sound', null, 'Example Band', 'Copper Skies'],
    ];
    for (const [title, uploader, artist, song] of cases) {
      const found = songOf(track(title, uploader), null);
      assert.deepEqual([found?.artist, found?.title, found?.tagged], [artist, song, false], title);
    }
  });

  it('takes the channel as the artist when the title is the song alone, without what channels add to names', () => {
    assert.equal(songOf(track('Paper Boats', 'Example Band - Topic'), null)?.artist, 'Example Band');
    assert.equal(songOf(track('Paper Boats (Official Video)', 'ExampleBandVEVO'), null)?.artist, 'ExampleBand');
    assert.equal(songOf(track('Paper Boats', 'Example Band Official'), null)?.title, 'Paper Boats');
    // Keeps what is not a decoration: a live recording is another recording.
    assert.equal(
      songOf(track('Morning Light (Live at the Old Hall)', 'Example Band'), null)?.title,
      'Morning Light (Live at the Old Hall)',
    );
  });

  it('gives no song when no artist can be read, and no length LRCLIB would refuse', () => {
    assert.equal(songOf(track('Paper Boats'), null), null);
    assert.equal(songOf(track('Example Band - Paper Boats', null, null), null)?.seconds, null);
    assert.equal(songOf(track('Example Band - Paper Boats', null, 4 * 3_600_000), null)?.seconds, null);
    assert.equal(songOf(track('Example Band - Paper Boats', null, 300), null)?.seconds, null);
  });
});

describe('parseLrc', () => {
  it('reads timed lines in the order they are sung, several stamps a line, the offset, and no metadata', () => {
    const lines = parseLrc(
      [
        '[ar:Example Band]',
        '[offset:+500]',
        '[00:12.40] Fold the morning into paper',
        '[00:21.10]',
        '[01:02.30][00:30.5] Every letter never ends',
        'a line without a time',
        '[00:05:120]first',
      ].join('\r\n'),
    );
    assert.deepEqual(lines, [
      { atMs: 4620, text: 'first' },
      { atMs: 11_900, text: 'Fold the morning into paper' },
      { atMs: 20_600, text: '' },
      { atMs: 30_000, text: 'Every letter never ends' },
      { atMs: 61_800, text: 'Every letter never ends' },
    ]);
  });

  it("reads LRCLIB's own timed lines, pauses included", () => {
    const record = JSON.parse(fixture('get-found.json')) as LrclibRecord;
    const lines = parseLrc(record.syncedLyrics ?? '');
    assert.equal(lines.length, 6);
    assert.deepEqual(lines[0], { atMs: 12_400, text: 'Fold the morning into paper' });
    assert.equal(lines[2]?.text, '');
  });
});

// LRCLIB as it answers, from the fixtures: each request is noted, and the answer is the next one given.
function lrclib(answers: OutboundAnswer[]) {
  const asked: URL[] = [];
  const agents: string[] = [];
  const client = new LrclibClient({
    userAgent: 'jukecord/test (https://example.com)',
    get: async (url, headers) => {
      asked.push(url);
      agents.push(headers['user-agent'] ?? '');
      const answer = answers.shift();
      if (!answer) throw new Error('no answer left');
      return answer;
    },
  });
  return { client, asked, agents };
}
const json = (status: number, body: string, headers: Record<string, string> = {}): OutboundAnswer => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body,
});

describe('LrclibClient', () => {
  const song: Song = {
    artist: 'Example Band',
    title: 'Paper Boats on the River',
    album: null,
    seconds: 187,
    tagged: false,
  };

  it("asks by the song's signature, says what it is, and reads the record", async () => {
    const { client, asked, agents } = lrclib([json(200, fixture('get-found.json'))]);
    const record = await client.match({ ...song, album: 'Made-up Rivers' });
    assert.equal(record?.id, 4815162);
    assert.equal(record?.duration, 187);
    assert.equal(asked[0]?.origin, 'https://lrclib.net');
    assert.equal(asked[0]?.pathname, '/api/get');
    assert.deepEqual(Object.fromEntries(asked[0]?.searchParams ?? []), {
      track_name: 'Paper Boats on the River',
      artist_name: 'Example Band',
      album_name: 'Made-up Rivers',
      duration: '187',
    });
    assert.equal(agents[0], 'jukecord/test (https://example.com)');
  });

  it("reads LRCLIB's 404 as no record, its waits as waits, and anything else as a failure", async () => {
    const { client } = lrclib([
      json(404, fixture('not-found.json')),
      json(429, fixture('rate-limited.json'), { 'retry-after': '30' }),
      json(503, '{}'),
      json(500, '{"name":"UnknownError"}'),
      { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>' },
      json(200, 'not json'),
    ]);
    assert.equal(await client.match(song), null);
    await assert.rejects(client.match(song), (error: Error & { waitMs?: number }) => error.waitMs === 30_000);
    // No Retry-After: a minute.
    await assert.rejects(client.match(song), (error: Error & { waitMs?: number }) => error.waitMs === 60_000);
    await assert.rejects(client.match(song), /LRCLIB answered 500/);
    await assert.rejects(client.match(song), /LRCLIB answered 200/);
    await assert.rejects(client.match(song), /not JSON/);
  });

  it('searches by title and artist, and reads only the records it can', async () => {
    const records = JSON.parse(fixture('search.json')) as unknown[];
    const { client, asked } = lrclib([json(200, JSON.stringify([...records, { id: 'x' }, null]))]);
    const found = await client.search({ track_name: 'Paper Boats on the River', artist_name: 'Example Band' });
    assert.equal(found.length, 4);
    assert.equal(asked[0]?.pathname, '/api/search');
  });
});

describe('bestRecord', () => {
  const records = JSON.parse(fixture('search.json')) as LrclibRecord[];
  const song: Song = {
    artist: 'Example Band',
    title: 'Paper Boats on the River',
    album: null,
    seconds: 187,
    tagged: false,
  };

  it('takes the record as long as the track and named like it, timed lines before words alone', () => {
    // 201 s is another recording; "Static Bloom" is another song; the timed one with a featured artist wins.
    assert.equal(bestRecord(song, records)?.id, 4815172);
    assert.equal(bestRecord({ ...song, seconds: 188 }, records.slice(0, 2))?.id, 4815171);
    assert.equal(bestRecord({ ...song, seconds: 300 }, records), null);
    // Without a length, the name decides.
    assert.equal(bestRecord({ ...song, seconds: null, title: 'Static Bloom' }, records)?.id, 4815173);
  });
});

// A lookup whose answers the test decides, counting the requests.
function lookup(answers: { match?: (LrclibRecord | null | Error)[]; search?: (LrclibRecord[] | Error)[] }) {
  const calls: string[] = [];
  const next = <T>(list: (T | Error)[] | undefined, fallback: T): T => {
    const value = list?.shift();
    if (value instanceof Error) throw value;
    return value === undefined ? fallback : value;
  };
  const fake: LyricsLookup = {
    match: async (song) => {
      calls.push(`match ${song.artist} / ${song.title}`);
      return next(answers.match, null);
    },
    search: async (query) => {
      calls.push(`search ${'q' in query ? query.q : `${query.artist_name} / ${query.track_name}`}`);
      return next(answers.search, []);
    },
  };
  return { fake, calls };
}

// The lyrics of tracks, on a clock the test moves; sleeping moves the clock instead of waiting.
function service(fake: LyricsLookup) {
  let now = Date.UTC(2026, 10, 11);
  const store = memoryStore(() => now);
  const slept: number[] = [];
  const lyrics = new Lyrics({
    lyrics: store.lyrics,
    music: store.music,
    lookup: fake,
    log,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  });
  return { store, lyrics, slept, advance: (ms: number) => (now += ms) };
}

describe('Lyrics', () => {
  const found = JSON.parse(fixture('get-found.json')) as LrclibRecord;

  it('looks a track up once, keeps what it found, and answers from the database after', async () => {
    const { fake, calls } = lookup({ match: [found] });
    const { store, lyrics } = service(fake);
    const [stored] = addTracks(store, 1);
    assert.ok(stored);
    const playing: Track = { ...stored, title: 'Example Band - Paper Boats on the River (Official Video)' };
    // Three asking at once: one lookup.
    const answers = await Promise.all([lyrics.forTrack(playing), lyrics.forTrack(playing), lyrics.forTrack(playing)]);
    assert.deepEqual(calls, ['match Example Band / Paper Boats on the River']);
    assert.equal(answers[0]?.kind, 'synced');
    assert.equal(answers[0]?.lines.length, 6);
    assert.match(answers[0]?.text ?? '', /^Fold the morning into paper\n/);
    assert.equal(store.lyrics.get(stored.id)?.sourceId, 4815162);
    // Asked again later: from the database, nothing asked of LRCLIB.
    assert.equal((await lyrics.forTrack(playing)).kind, 'synced');
    assert.equal(calls.length, 1);
  });

  it('uses what the site said the recording is before the title', async () => {
    const { fake, calls } = lookup({ match: [found] });
    const { store, lyrics } = service(fake);
    const [stored] = addTracks(store, 1);
    assert.ok(stored);
    store.music.set(stored.id, { artist: 'Example Band', title: 'Paper Boats on the River', album: 'Made-up Rivers' });
    await lyrics.forTrack(stored);
    assert.deepEqual(calls, ['match Example Band / Paper Boats on the River']);
  });

  it('searches when the exact lookup finds nothing, by title and artist, then (for a guess) by the words', async () => {
    const records = JSON.parse(fixture('search.json')) as LrclibRecord[];
    const { fake, calls } = lookup({ match: [null], search: [[], records] });
    const { store, lyrics, slept } = service(fake);
    const [stored] = addTracks(store, 1);
    assert.ok(stored);
    const answer = await lyrics.forTrack({
      ...stored,
      title: 'Paper Boats on the River',
      uploader: 'Example Band',
      durationMs: 187_000,
    });
    assert.deepEqual(calls, [
      'match Example Band / Paper Boats on the River',
      'search Example Band / Paper Boats on the River',
      'search Example Band Paper Boats on the River',
    ]);
    assert.equal(answer.kind, 'synced');
    // One request at a time, a third of a second apart.
    assert.deepEqual(slept, [300, 300]);
  });

  it('keeps that nothing was found for a week, then asks again; an instrumental is an answer', async () => {
    const instrumental = JSON.parse(fixture('instrumental.json')) as LrclibRecord;
    const { fake, calls } = lookup({ match: [null, instrumental] });
    const { store, lyrics, advance } = service(fake);
    const [stored] = addTracks(store, 1);
    assert.ok(stored);
    store.music.set(stored.id, { artist: 'Demo Orchestra', title: 'Low Tide', album: null });
    assert.equal((await lyrics.forTrack(stored)).kind, 'none');
    assert.equal(calls.length, 2);
    advance(6 * 86_400_000);
    assert.equal((await lyrics.forTrack(stored)).kind, 'none');
    assert.equal(calls.length, 2);
    advance(86_400_000);
    const answer = await lyrics.forTrack(stored);
    assert.deepEqual([answer.kind, answer.lines, answer.text], ['instrumental', [], null]);
    assert.equal(calls.length, 3);
  });

  it("obeys LRCLIB's wait, remembers a failure for two minutes, and says so as unavailable", async () => {
    const { fake, calls } = lookup({ match: [new LrclibWait(5000), found] });
    const { store, lyrics, advance } = service(fake);
    const [stored] = addTracks(store, 1);
    assert.ok(stored);
    store.music.set(stored.id, { artist: 'Example Band', title: 'Paper Boats on the River', album: null });
    await assert.rejects(lyrics.forTrack(stored), (error: unknown) => {
      // Said with how long until asking may work: the whole two minutes.
      assert.ok(error instanceof LyricsUnavailable);
      assert.equal(error.retryAfterMs, 2 * 60_000);
      return true;
    });
    // Asked again a little later: answered without asking LRCLIB, with what is left of the wait.
    advance(30_000);
    await assert.rejects(lyrics.forTrack(stored), (error: unknown) => {
      assert.ok(error instanceof LyricsUnavailable);
      assert.match(error.message, /LRCLIB did not answer/);
      assert.equal(error.retryAfterMs, 90_000);
      return true;
    });
    assert.equal(calls.length, 1);
    advance(90_000);
    assert.equal((await lyrics.forTrack(stored)).kind, 'synced');
    assert.equal(store.lyrics.get(stored.id)?.kind, 'synced');
  });

  it('holds every request back for as long as a 429 says, with a little more at random', async () => {
    const client = lrclib([json(429, fixture('rate-limited.json'), { 'retry-after': '20' })]);
    const { store, lyrics, slept } = service(client.client);
    const [first, second] = addTracks(store, 2);
    assert.ok(first && second);
    for (const stored of [first, second]) store.music.set(stored.id, { artist: 'A', title: 'B', album: null });
    await assert.rejects(lyrics.forTrack(first), LyricsUnavailable);
    // The next track's lookup is turned away at once, with the 20 s (and up to a third more) left to wait: a person
    // asking does not wait out LRCLIB's minutes, and LRCLIB is asked nothing meanwhile.
    await assert.rejects(lyrics.forTrack(second), (error: unknown) => {
      assert.ok(error instanceof LyricsUnavailable);
      assert.ok(error.retryAfterMs >= 20_000 && error.retryAfterMs <= 26_700, String(error.retryAfterMs));
      return true;
    });
    assert.deepEqual(slept, []);
    assert.equal(client.asked.length, 1);
    // One already in the line when the 429 came is turned away the same way.
    const again = lrclib([json(429, fixture('rate-limited.json'), { 'retry-after': '20' })]);
    const other = service(again.client);
    const [one, two] = addTracks(other.store, 2);
    assert.ok(one && two);
    for (const stored of [one, two]) other.store.music.set(stored.id, { artist: 'A', title: 'B', album: null });
    const [said, inLine] = await Promise.allSettled([other.lyrics.forTrack(one), other.lyrics.forTrack(two)]);
    assert.equal(said.status, 'rejected');
    assert.ok(inLine.status === 'rejected' && inLine.reason instanceof LyricsUnavailable);
    assert.ok(inLine.reason.retryAfterMs >= 20_000 && inLine.reason.retryAfterMs <= 26_700);
    assert.equal(again.asked.length, 1);
  });

  it('waits in line for a short pause between requests, not for a long one', async () => {
    // A wait of LRCLIB's of five seconds: the next lookup waits it out and is answered.
    const found = JSON.parse(fixture('get-found.json')) as LrclibRecord;
    const { fake } = lookup({ match: [new LrclibWait(5000), found] });
    const { store, lyrics, slept } = service(fake);
    const [first, second] = addTracks(store, 2);
    assert.ok(first && second);
    for (const stored of [first, second])
      store.music.set(stored.id, { artist: 'Example Band', title: 'Paper Boats on the River', album: null });
    await assert.rejects(lyrics.forTrack(first), LyricsUnavailable);
    assert.equal((await lyrics.forTrack(second)).kind, 'synced');
    assert.ok(slept[0] !== undefined && slept[0] >= 5000 && slept[0] <= 6700, String(slept[0]));
  });

  it('turns a lookup away when many are waiting already', async () => {
    // Lookups that never end, filling the places.
    const fake: LyricsLookup = { match: () => new Promise(() => {}), search: async () => [] };
    const { store, lyrics } = service(fake);
    const tracks = addTracks(store, 9);
    for (const stored of tracks) store.music.set(stored.id, { artist: 'A', title: 'B', album: null });
    for (const stored of tracks.slice(0, 8)) void lyrics.forTrack(stored);
    await assert.rejects(lyrics.forTrack(tracks[8] as Track), /looking up other lyrics/);
  });

  it('keeps that none were found when no song can be read from the track, asking nothing', async () => {
    const { fake, calls } = lookup({});
    const { store, lyrics } = service(fake);
    const [stored] = addTracks(store, 1);
    assert.ok(stored);
    assert.equal((await lyrics.forTrack({ ...stored, uploader: null, title: 'Untitled' })).kind, 'none');
    assert.deepEqual(calls, []);
  });
});

describe('what YouTube says a recording is', () => {
  it('is read from yt-dlp with the first artist, and kept beside the track by the resolver', async () => {
    const entry = {
      id: 'aaaaaaaaaaa',
      title: 'Example Band - Paper Boats (Official Video)',
      webpage_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      uploader: 'Example Band',
      duration: 187,
      track: 'Paper Boats',
      artist: 'Example Band, Sample Sound',
      artists: ['Example Band', 'Sample Sound'],
      album: 'Made-up Rivers',
    };
    const [found] = tracksFromInfo(entry, 1);
    assert.deepEqual(found?.music, { artist: 'Example Band', title: 'Paper Boats', album: 'Made-up Rivers' });
    // A video that is not a known song says nothing of the kind.
    assert.equal(tracksFromInfo({ ...entry, track: undefined }, 1)[0]?.music, undefined);
    const store = memoryStore();
    const resolver = new Resolver({
      ytdlp: { lookup: async () => tracksFromInfo(entry, 1) } as unknown as YtDlp,
      tracks: store.tracks,
      music: store.music,
      log,
    });
    const [stored] = await resolver.resolve('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    assert.ok(stored);
    assert.equal(store.music.get(stored.id)?.album, 'Made-up Rivers');
  });
});
