/**
 * Searching: the results kept by their words, a search shared by everyone asking at once and stopped when nobody waits
 * any more, the lookup slots it is counted in, the results the resolver adds from without asking again, and the
 * action's rules. yt-dlp is a stand-in that answers from the real shape of a search (tests/fixtures/ytdlp-search.json:
 * ten results, two of them live streams).
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
import { Resolver } from '../../src/media/resolver.ts';
import { Search, searchWords } from '../../src/media/search.ts';
import { tracksFromInfo, type YtDlp } from '../../src/media/ytdlp.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { memoryStore } from '../support/store.ts';

const log = createLogger({ level: 'error', sinks: [] });
const GUILD = '100000000000000001';
const ALICE = '300000000000000001';

// What yt-dlp's flat search printed, made up but in its real shape.
const LISTING = JSON.parse(fs.readFileSync(new URL('../fixtures/ytdlp-search.json', import.meta.url), 'utf8'));

// A yt-dlp whose searches finish when the test says, and which remembers how it was asked.
function fakeYtDlp() {
  const calls: {
    words: string;
    limit: number;
    signal: AbortSignal | undefined;
    finish: () => void;
    fail: (error: Error) => void;
  }[] = [];
  const ytdlp = {
    search: (words: string, limit: number, signal?: AbortSignal) =>
      new Promise<NewTrack[]>((resolve, reject) => {
        calls.push({
          words,
          limit,
          signal,
          finish: () => resolve(tracksFromInfo(LISTING, limit)),
          fail: reject,
        });
        signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
  } as unknown as YtDlp;
  return { ytdlp, calls };
}

// The resolver's slots, as the real resolver keeps them (four in all, two per person, three per server).
function slots(store = memoryStore()) {
  return new Resolver({ ytdlp: {} as YtDlp, tracks: store.tracks, log });
}

describe('Search', () => {
  it('finds what YouTube lists, without live streams, as many as asked for', async () => {
    const { ytdlp, calls } = fakeYtDlp();
    const search = new Search({ ytdlp, slots: slots(), log });
    const finding = search.find('  example   chill  ', { limit: 5 });
    await flush();
    // The words cleaned once, and a few more asked of yt-dlp than given, for the live streams left out.
    assert.equal(calls[0]?.words, 'example chill');
    assert.ok((calls[0]?.limit ?? 0) > 10);
    calls[0]?.finish();
    const found = await finding;
    assert.equal(found.length, 5);
    assert.deepEqual(
      found.map((track) => track.title),
      [
        'Morning Light (Official Audio)',
        'Paper Boats on the River',
        'Static Bloom',
        'Satellite Hearts (Lyric Video)',
        'Low Tide',
      ],
    );
    // Live streams are not tracks; one that was live and has ended is.
    assert.ok(!found.some((track) => track.title === 'Neon Rain - Live Session'));
    assert.equal(found[0]?.url, 'https://www.youtube.com/watch?v=srch0000001');
    assert.equal(found[0]?.durationMs, 215_000);
  });

  it('answers the same words again from memory, in any case, until they are old', async () => {
    const { ytdlp, calls } = fakeYtDlp();
    const clock = new FakeClock(0);
    const search = new Search({ ytdlp, slots: slots(), log, now: () => clock.now(), keepMs: 60_000 });
    const first = search.find('Example Chill');
    await flush();
    calls[0]?.finish();
    assert.equal((await first).length, 8);
    assert.equal((await search.find('example chill', { limit: 3 })).length, 3);
    assert.equal(search.cached('EXAMPLE CHILL')?.length, 8);
    assert.equal(calls.length, 1);
    // A minute later the words are searched again.
    await clock.advance(60_001);
    assert.equal(search.cached('example chill'), null);
    const again = search.find('example chill');
    await flush();
    assert.equal(calls.length, 2);
    calls[1]?.finish();
    await again;
  });

  it('shares a search under way, stops it when nobody waits, and keeps it for those who still do', async () => {
    const { ytdlp, calls } = fakeYtDlp();
    const search = new Search({ ytdlp, slots: slots(), log });
    const one = new AbortController();
    const two = new AbortController();
    const first = search.find('shared words', { signal: one.signal });
    const second = search.find('shared words', { signal: two.signal });
    await flush();
    assert.equal(calls.length, 1);
    // One asker goes: the search goes on for the other.
    one.abort();
    await assert.rejects(first);
    assert.equal(calls[0]?.signal?.aborted, false);
    calls[0]?.finish();
    assert.equal((await second).length, 8);
    // Alone and gone: the search stops (and its slot is free again).
    const three = new AbortController();
    const third = search.find('typed over', { signal: three.signal });
    await flush();
    three.abort();
    await assert.rejects(third);
    assert.equal(calls[1]?.signal?.aborted, true);
  });

  it('does not keep a failure, and is counted in the lookup slots', async () => {
    const { ytdlp, calls } = fakeYtDlp();
    const resolver = slots();
    const search = new Search({ ytdlp, slots: resolver, log });
    const failing = search.find('bad words', { who: ALICE });
    await flush();
    calls[0]?.fail(new Error('yt-dlp failed: HTTP Error 429'));
    await assert.rejects(failing, /429/);
    const again = search.find('bad words', { who: ALICE });
    await flush();
    assert.equal(calls.length, 2);
    // Two searches of one person fill that person's share: the third is refused at once.
    const other = search.find('other words', { who: ALICE });
    await flush();
    await assert.rejects(search.find('third words', { who: ALICE }), /looking up other tracks/);
    calls[1]?.finish();
    calls[2]?.finish();
    await Promise.all([again, other]);
  });

  it('forgets the least recently asked words beyond its size', async () => {
    const { ytdlp, calls } = fakeYtDlp();
    const search = new Search({ ytdlp, slots: slots(), log, size: 2 });
    for (const words of ['one', 'two']) {
      const finding = search.find(words);
      await flush();
      calls.at(-1)?.finish();
      await finding;
    }
    // Asking "one" again makes "two" the oldest, which "three" pushes out.
    await search.find('one');
    const third = search.find('three');
    await flush();
    calls.at(-1)?.finish();
    await third;
    assert.notEqual(search.cached('one'), null);
    assert.equal(search.cached('two'), null);
    assert.notEqual(search.cached('three'), null);
  });

  it('cleans words as the add box does', () => {
    assert.equal(searchWords('  a \n b  '), 'a b');
    assert.equal(searchWords('x'.repeat(300)).length, 200);
  });
});

describe('picking a result', () => {
  it('adds it from what the search found, with no lookup', async () => {
    const store = memoryStore();
    const { ytdlp, calls } = fakeYtDlp();
    let lookups = 0;
    let search: Search | null = null;
    const resolver = new Resolver({
      ytdlp: {
        lookup: async () => {
          lookups += 1;
          return [];
        },
      } as unknown as YtDlp,
      tracks: store.tracks,
      log,
      recent: (source) => search?.recent(source) ?? null,
    });
    search = new Search({ ytdlp, slots: resolver, log });
    const finding = search.find('example chill');
    await flush();
    calls[0]?.finish();
    const [first] = await finding;
    assert.ok(first);
    // The address as people pick it (a share link of the same video) finds the result.
    const [track] = await resolver.resolve('https://youtu.be/srch0000001?si=shared');
    assert.equal(track?.title, 'Morning Light (Official Audio)');
    assert.equal(track?.durationMs, 215_000);
    assert.equal(lookups, 0);
    // Stored like any added track.
    assert.equal(store.tracks.bySource('https://www.youtube.com/watch?v=srch0000001')?.id, track?.id);
  });
});

describe('the search action', () => {
  const DJ: ActionContext = { guildId: GUILD, userId: ALICE, mayControl: true, mayManage: false };
  const LISTENER: ActionContext = { guildId: GUILD, userId: ALICE, mayControl: false, mayManage: false };

  function setup(withSearch = true) {
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
    const { ytdlp, calls } = fakeYtDlp();
    const resolver = new Resolver({ ytdlp, tracks: store.tracks, log });
    const search = new Search({ ytdlp, slots: resolver, log });
    const actions = new Actions({ store, queue, players, resolver, log, ...(withSearch ? { search } : {}) });
    return { actions, calls };
  }

  const code = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      if (error instanceof ActionError) return `${error.code}: ${error.message}`;
      throw error;
    }
    return 'done';
  };

  it('searches words for people who may change the music, and refuses addresses and listeners', async () => {
    const { actions, calls } = setup();
    const finding = actions.search(DJ, 'example chill', 4);
    await flush();
    calls[0]?.finish();
    assert.equal((await finding).length, 4);
    assert.equal(
      await code(() => actions.search(LISTENER, 'example chill')),
      `forbidden: only members with the DJ role can change the music here`,
    );
    assert.equal(
      await code(() => actions.search(DJ, 'https://example.com/watch?v=a')),
      'invalid: a search takes words, not an address',
    );
    assert.equal(await code(() => actions.search(DJ, '   ')), 'invalid: nothing to search for');
  });

  it('says why a search failed in the short words of the reasons, and when it is not set up', async () => {
    const { actions, calls } = setup();
    const finding = code(() => actions.search(DJ, 'failing words'));
    await flush();
    calls[0]?.fail(new Error('yt-dlp failed: ERROR: Sign in to confirm you’re not a bot'));
    assert.equal(await finding, 'not-found: YouTube is refusing this server for now');
    assert.equal(
      await code(() => setup(false).actions.search(DJ, 'any words')),
      'unavailable: searching is not set up here',
    );
  });
});
