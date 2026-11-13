/**
 * Links of Deezer, Spotify and Apple Music: which addresses are theirs, what each service says a link holds (read
 * from the shapes of their real answers, tests/fixtures, made-up values), the YouTube recording kept for each track,
 * the order the tracks are handed on in, and the add actions that queue them as they come. Nothing here reaches a
 * site: the fetch answers from a table, and the search makes up its results.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions } from '../../src/app/actions.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { NewTrack } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import { BatchLookups } from '../../src/media/batch.ts';
import type { FetchAnswer, PublicFetch } from '../../src/media/fetch.ts';
import { bestMatch, LinkError, type LinkService, Links, linkTarget, metaTags } from '../../src/media/links.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import type { YtDlp } from '../../src/media/ytdlp.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { memoryStore } from '../support/store.ts';

const log = createLogger({ level: 'error', sinks: [] });
const fixture = (name: string) => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const GUILD = '100000000000000001';
const DJ: ActionContext = { guildId: GUILD, userId: '300000000000000001', mayControl: true, mayManage: false };

// A made-up YouTube result.
function found(title: string, uploader: string, seconds: number, id: string): NewTrack {
  return {
    source: `https://www.youtube.com/watch?v=${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    uploader,
    durationMs: seconds * 1000,
    thumbnail: null,
  };
}

// A fetch answering from a table of addresses (200 with the text), recording what was asked.
function tableFetch(table: Record<string, string | { status: number; text: string; url?: string }>) {
  const asked: { address: string; method: string; headers: Record<string, string> }[] = [];
  const fetch: PublicFetch = async (address, options = {}) => {
    asked.push({ address, method: options.method ?? 'GET', headers: { ...options.headers } });
    const entry = table[address];
    if (entry === undefined) return { status: 404, url: address, headers: {}, text: '' } satisfies FetchAnswer;
    const answer = typeof entry === 'string' ? { status: 200, text: entry } : entry;
    return {
      status: answer.status,
      url: 'url' in answer && answer.url ? answer.url : address,
      headers: {},
      text: answer.text,
    };
  };
  return { fetch, asked };
}

// A search making up what YouTube would list for "artist title": a lyric video, the Topic upload, a live one.
function madeUpSearch(lengths: Record<string, number>) {
  const queries: string[] = [];
  const ytdlp = {
    search: async (query: string) => {
      queries.push(query);
      const seconds = Object.entries(lengths).find(([title]) => query.includes(title))?.[1];
      if (seconds === undefined) return [];
      const id = String(queries.length).padStart(11, 'q');
      const title = Object.keys(lengths).find((name) => query.includes(name)) ?? query;
      return [
        found(`${title} (Lyric Video)`, 'Lyrics Corner', seconds + 9, `${id.slice(0, 10)}a`),
        found(title, 'The Placeholders - Topic', seconds, `${id.slice(0, 10)}b`),
        found(`${title} (Live at the Old Hall)`, 'The Placeholders', seconds + 40, `${id.slice(0, 10)}c`),
      ];
    },
  } as unknown as YtDlp;
  return { ytdlp, queries };
}

function links(fetch: PublicFetch, ytdlp: YtDlp, options: { spotify?: boolean; services?: LinkService[] } = {}) {
  const store = memoryStore();
  return {
    store,
    links: new Links({
      fetch,
      ytdlp,
      tracks: store.tracks,
      batch: new BatchLookups(3),
      log,
      services: new Set(options.services ?? ['deezer', 'spotify', 'apple-music']),
      spotify: options.spotify ? { clientId: 'exampleclientid0000', clientSecret: 'examplesecret' } : null,
    }),
  };
}

describe('links of other services', () => {
  it('are told apart by their addresses', () => {
    const kinds = (text: string) => {
      const target = linkTarget(text);
      return target ? `${target.service} ${target.kind} ${target.id}` : null;
    };
    assert.equal(kinds('https://www.deezer.com/track/900001'), 'deezer track 900001');
    assert.equal(kinds('deezer.com/fr/album/900002'), 'deezer album 900002');
    assert.equal(kinds('https://link.deezer.com/s/abc'), 'deezer short ');
    assert.equal(
      kinds('https://open.spotify.com/intl-ko/track/0exampletrack0000000AB?si=x'),
      'spotify track 0exampletrack0000000AB',
    );
    assert.equal(kinds('spotify:playlist:0exampleplaylist000000'), 'spotify playlist 0exampleplaylist000000');
    assert.equal(kinds('https://music.apple.com/us/album/x/1000000001?i=1000000002'), 'apple-music track 1000000002');
    assert.equal(kinds('https://music.apple.com/us/song/x/1000000002'), 'apple-music track 1000000002');
    assert.equal(kinds('https://music.apple.com/us/album/x/1000000001'), 'apple-music album ');
    assert.equal(kinds('https://www.youtube.com/watch?v=aaaaaaaaaaa'), null);
    assert.equal(kinds('deezer song names'), null);
  });

  it('find the recording within a few seconds of the track, official audio first, no other version', () => {
    const track = { key: 'x', title: 'Static Bloom (2019 Remaster)', artists: ['Example Band'], durationMs: 187_000 };
    const pick = bestMatch(track, [
      found('Static Bloom (Live)', 'Example Band', 190, 'aaaaaaaaaa1'),
      found('Example Band - Static Bloom (Official Video)', 'Example Band', 199, 'aaaaaaaaaa2'),
      found('Static Bloom', 'Example Band - Topic', 188, 'aaaaaaaaaa3'),
      found('Static Bloom cover', 'Someone', 187, 'aaaaaaaaaa4'),
    ]);
    assert.equal(pick?.url, 'https://www.youtube.com/watch?v=aaaaaaaaaa3');
    // Only a recording too long, or another song: none.
    assert.equal(bestMatch(track, [found('Static Bloom', 'Example Band', 260, 'aaaaaaaaaa5')]), null);
    assert.equal(bestMatch(track, [found('Velvet Hours', 'Example Band - Topic', 187, 'aaaaaaaaaa6')]), null);
    // A live track keeps its live recording.
    const live = { ...track, title: 'Static Bloom (Live)' };
    assert.equal(
      bestMatch(live, [found('Static Bloom (Live)', 'Example Band', 190, 'aaaaaaaaaa7')])?.title,
      'Static Bloom (Live)',
    );
  });

  it('read a Deezer track, album and playlist from its public API, and its answer for nothing', async () => {
    const track = JSON.parse(fixture('deezer-track.json'));
    const album = JSON.parse(fixture('deezer-album-tracks.json'));
    const lengths = Object.fromEntries(
      [track, ...album.data].map((item: { title: string; duration: number }) => [item.title, item.duration]),
    );
    const { fetch, asked } = tableFetch({
      'https://api.deezer.com/track/900001': fixture('deezer-track.json'),
      'https://api.deezer.com/album/900002/tracks?limit=100': fixture('deezer-album-tracks.json'),
      'https://api.deezer.com/playlist/900003/tracks?limit=100': fixture('deezer-playlist-tracks.json'),
      'https://api.deezer.com/track/1': fixture('deezer-error.json'),
    });
    const { ytdlp, queries } = madeUpSearch(lengths);
    const { links: reader } = links(fetch, ytdlp);
    const single = await reader.resolve('https://www.deezer.com/track/900001');
    assert.deepEqual(
      single.tracks.map((found) => [found.title, found.uploader]),
      [['Paper Boats on the River', 'The Placeholders - Topic']],
    );
    assert.equal(queries[0], 'The Placeholders Paper Boats on the River');
    const fromAlbum = await reader.resolve('https://www.deezer.com/album/900002');
    assert.deepEqual(
      fromAlbum.tracks.map((found) => found.title),
      album.data.map((item: { title: string }) => item.title),
    );
    // The playlist's tracks are not among the made-up search's titles: none found, each counted.
    const fromPlaylist = await reader.resolve('https://www.deezer.com/playlist/900003');
    assert.deepEqual([fromPlaylist.tracks.length, fromPlaylist.notFound], [0, 3]);
    await assert.rejects(reader.resolve('https://www.deezer.com/track/1'), /Deezer has nothing at that link/);
    assert.ok(asked.every((request) => request.address.startsWith('https://api.deezer.com/')));
  });

  it('read a Spotify track from its page without the host’s app, and refuse an album then', async () => {
    const { fetch } = tableFetch({
      'https://open.spotify.com/track/0exampletrack0000000AB': fixture('spotify-track.html'),
    });
    const { ytdlp, queries } = madeUpSearch({ 'Paper Boats on the River': 214 });
    const { links: reader } = links(fetch, ytdlp);
    const result = await reader.resolve('https://open.spotify.com/track/0exampletrack0000000AB?si=shared');
    assert.equal(result.tracks[0]?.uploader, 'The Placeholders - Topic');
    assert.equal(queries[0], 'Example Band Paper Boats on the River');
    await assert.rejects(
      reader.resolve('https://open.spotify.com/album/0examplealbum000000000'),
      /need the host’s Spotify app/,
    );
  });

  it('use the host’s Spotify app for albums and playlists, with one token kept', async () => {
    const item = (id: string, name: string, seconds: number) => ({
      id,
      name,
      duration_ms: seconds * 1000,
      type: 'track',
      artists: [{ name: 'Example Band' }],
    });
    const { fetch, asked } = tableFetch({
      'https://accounts.spotify.com/api/token': JSON.stringify({
        access_token: 'example-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
      'https://api.spotify.com/v1/albums/0examplealbum000000000/tracks?limit=50&offset=0': JSON.stringify({
        items: [item('a', 'Low Tide', 203), item('b', 'Lanterns', 198)],
        next: null,
      }),
      'https://api.spotify.com/v1/playlists/0exampleplaylist000000/tracks?limit=100&fields=items(track(id,name,duration_ms,type,artists(name)))':
        JSON.stringify({ items: [{ track: item('c', 'Small Victories', 231) }, { track: null }] }),
    });
    const { ytdlp } = madeUpSearch({ 'Low Tide': 203, Lanterns: 198, 'Small Victories': 231 });
    const { links: reader } = links(fetch, ytdlp, { spotify: true });
    assert.deepEqual(
      (await reader.resolve('https://open.spotify.com/album/0examplealbum000000000')).tracks.map(
        (found) => found.title,
      ),
      ['Low Tide', 'Lanterns'],
    );
    assert.deepEqual(
      (await reader.resolve('spotify:playlist:0exampleplaylist000000')).tracks.map((found) => found.title),
      ['Small Victories'],
    );
    const tokens = asked.filter((request) => request.address.includes('accounts.spotify.com'));
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.method, 'POST');
    assert.equal(
      tokens[0]?.headers.authorization,
      `Basic ${Buffer.from('exampleclientid0000:examplesecret').toString('base64')}`,
    );
    assert.ok(
      asked
        .filter((request) => request.address.startsWith('https://api.spotify.com/'))
        .every((request) => request.headers.authorization === 'Bearer example-token'),
    );
  });

  it('read an Apple Music track from its page, and refuse an album', async () => {
    const page = 'https://music.apple.com/us/album/example-album/1000000001?i=1000000002';
    const { fetch } = tableFetch({ [page]: fixture('apple-track.html') });
    const { ytdlp, queries } = madeUpSearch({ 'Paper Boats on the River': 213 });
    const { links: reader } = links(fetch, ytdlp);
    const result = await reader.resolve(page);
    assert.equal(result.tracks.length, 1);
    assert.equal(queries[0], 'Example Band Paper Boats on the River');
    await assert.rejects(
      reader.resolve('https://music.apple.com/us/album/example-album/1000000001'),
      /single Apple Music tracks/,
    );
  });

  it('refuse a service turned off, and keep a match for the next time', async () => {
    const { fetch } = tableFetch({ 'https://api.deezer.com/track/900001': fixture('deezer-track.json') });
    const { ytdlp, queries } = madeUpSearch({ 'Paper Boats on the River': 170 });
    const off = links(fetch, ytdlp, { services: ['spotify'] }).links;
    await assert.rejects(
      off.resolve('https://www.deezer.com/track/900001'),
      (error) => error instanceof LinkError && /does not read Deezer links here/.test(error.message),
    );
    const { links: reader } = links(fetch, ytdlp);
    await reader.resolve('https://www.deezer.com/track/900001');
    await reader.resolve('https://www.deezer.com/track/900001');
    assert.equal(queries.length, 1);
  });

  it('keep no match for a Spotify playlist’s local files, which have no ID of their own', async () => {
    // A file on the playlist owner's disk: Spotify lists it with "id": null, and every such file has the same null.
    const local = (name: string, seconds: number) => ({
      id: null,
      name,
      duration_ms: seconds * 1000,
      type: 'track',
      artists: [{ name: 'Example Band' }],
    });
    const playlist = (id: string) =>
      `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=items(track(id,name,duration_ms,type,artists(name)))`;
    const { fetch } = tableFetch({
      'https://accounts.spotify.com/api/token': JSON.stringify({ access_token: 'example-token', expires_in: 3600 }),
      [playlist('0exampleplaylist000001')]: JSON.stringify({ items: [{ track: local('Low Tide', 203) }] }),
      [playlist('0exampleplaylist000002')]: JSON.stringify({ items: [{ track: local('Lanterns', 198) }] }),
    });
    const { ytdlp, queries } = madeUpSearch({ 'Low Tide': 203, Lanterns: 198 });
    const { links: reader } = links(fetch, ytdlp, { spotify: true });
    const first = await reader.resolve('spotify:playlist:0exampleplaylist000001');
    const second = await reader.resolve('spotify:playlist:0exampleplaylist000002');
    // Each file is its own song: the second is searched for, not given the first one's recording.
    assert.deepEqual(
      [...first.tracks, ...second.tracks].map((track) => track.title),
      ['Low Tide', 'Lanterns'],
    );
    assert.equal(queries.length, 2);
  });

  it('read the meta tags of a page, every value of a tag that comes twice', () => {
    const tags = metaTags(
      '<meta property="og:title" content="A &amp; B"/><meta name="music:musician_description" content="One"><meta name="music:musician_description" content="Two">',
    );
    assert.deepEqual(tags.get('og:title'), ['A & B']);
    assert.deepEqual(tags.get('music:musician_description'), ['One', 'Two']);
  });
});

describe('adding a link', () => {
  // Actions over a real queue whose links come from a stand-in that hands its tracks on in two parts.
  function setup() {
    const clock = new FakeClock();
    const store = memoryStore(() => clock.now());
    const bus = new Bus();
    const queue = new QueueService(store.queue, bus);
    const players = new Players({
      queue,
      media: new FakeMedia(),
      history: store.history,
      state: store.playerState,
      bus,
      clock,
      log,
      fetchTimeoutMs: 60_000,
    });
    const tracks = ['one', 'two', 'three'].map((name, index) =>
      store.tracks.upsert(found(`Link track ${name}`, 'Example Band', 180, `link00000${index}`)),
    );
    let release: (() => void) | null = null;
    const links = {
      handles: (text: string) => text.startsWith('https://www.deezer.com/'),
      resolve: async (_text: string, ask: { each?: (part: typeof tracks) => void }) => {
        ask.each?.([tracks[0] as (typeof tracks)[number]]);
        // The rest come later, when the test says.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        ask.each?.([tracks[1] as (typeof tracks)[number], tracks[2] as (typeof tracks)[number]]);
        return { tracks, notFound: 2 };
      },
    } as unknown as Links;
    const resolver = { resolve: async () => [] } as unknown as Resolver;
    const actions = new Actions({ store, queue, players, resolver, log, links });
    return { queue, players, actions, tracks, release: () => release?.() };
  }

  it('plays the first track as soon as it is found, and puts the rest after it in order', async () => {
    const { queue, players, actions, tracks, release } = setup();
    const playing = players.get(GUILD);
    const adding = actions.add(DJ, 'https://www.deezer.com/album/900002');
    await flush();
    // The first is playing before the rest are found.
    assert.equal(playing.snapshot().track?.id, tracks[0]?.id);
    release();
    const result = await adding;
    assert.equal(result.items.length, 3);
    assert.equal(result.skippedNotFound, 2);
    assert.deepEqual(
      queue.list(GUILD).map((item) => item.track.id),
      [tracks[1]?.id, tracks[2]?.id],
    );
  });

  it('plays now: the first found skips the current track, the rest go next in order', async () => {
    const { queue, players, actions, tracks, release } = setup();
    const other = queue.add(GUILD, [tracks[2]?.id ?? 0, tracks[2]?.id ?? 0], 'end', null);
    players.get(GUILD).play();
    const adding = actions.playNow(DJ, 'https://www.deezer.com/album/900002');
    await flush();
    assert.equal(players.get(GUILD).snapshot().track?.id, tracks[0]?.id);
    release();
    await adding;
    // The link's other tracks before what waited already.
    assert.deepEqual(
      queue.list(GUILD).map((item) => item.track.id),
      [tracks[1]?.id, tracks[2]?.id, other[1]?.track.id],
    );
  });

  it('refuses without the DJ role, before anything is read', async () => {
    const { actions } = setup();
    await assert.rejects(
      actions.add({ ...DJ, mayControl: false }, 'https://www.deezer.com/album/900002'),
      (error) => error instanceof ActionError && error.code === 'forbidden',
    );
  });
});
