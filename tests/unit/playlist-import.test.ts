/**
 * Playlists in and out through the actions and the API: export in each kind, import of a file that describes its
 * tracks (nothing looked up), of a pasted list (looked up three at a time, a hundred at most), what is left out and
 * why, and the turns a list takes.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions } from '../../src/app/actions.ts';
import { writePlaylist } from '../../src/app/playlist-files.ts';
import { COMMANDS } from '../../src/cli/commands.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { Track } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import { AddressError } from '../../src/media/address.ts';
import { BatchLookups } from '../../src/media/batch.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { FakeClock, FakeMedia } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';
import { asHost, GUILD, type TestServer, testServer } from '../support/web.ts';

const log = createLogger({ level: 'error', sinks: [] });
const DJ: ActionContext = { guildId: GUILD, userId: '300000000000000001', mayControl: true, mayManage: false };

// Actions whose resolver answers a list's lines from a table, counting how many run at once.
function setup(table: Record<string, number> = {}) {
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
  const tracks = addTracks(store, 5);
  let running = 0;
  let most = 0;
  const asked: string[] = [];
  const resolver = {
    resolveListed: async (text: string) => {
      asked.push(text);
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      const index = table[text];
      if (index === undefined) throw new Error('nothing was found');
      return [tracks[index] as Track];
    },
  } as unknown as Resolver;
  const checkAddress = async (url: URL) => {
    if (url.hostname === 'inside.example') throw new AddressError('inside.example is on a private network');
  };
  const actions = new Actions({ store, queue, players, resolver, log, checkAddress, batch: new BatchLookups(3) });
  return { store, actions, tracks, asked, most: () => most };
}

async function refusal(run: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ActionError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'done';
}

describe('exporting a playlist', () => {
  it('gives each kind of file with its name, and refuses an unknown playlist or kind', async () => {
    const { store, actions, tracks } = setup();
    store.playlists.save(GUILD, 'Friday: late', [tracks[0]?.id ?? 0, tracks[1]?.id ?? 0], null);
    const text = actions.playlistExport(DJ, 'Friday: late', 'text');
    assert.deepEqual(text, {
      name: 'Friday: late',
      format: 'text',
      filename: 'Friday_ late.txt',
      content: 'https://example.com/watch?v=v1\nhttps://example.com/watch?v=v2\n',
    });
    assert.equal(actions.playlistExport(DJ, 'Friday: late', 'm3u').filename, 'Friday_ late.m3u');
    assert.equal(
      await refusal(() => actions.playlistExport(DJ, 'Nope', 'text')),
      'not-found: there is no playlist named "Nope"',
    );
    assert.equal(
      await refusal(() => actions.playlistExport(DJ, 'Friday: late', 'xml')),
      'invalid: the format is one of text, m3u, json',
    );
  });
});

describe('importing a playlist', () => {
  it('stores what a jukecord file says, with no lookup, and keeps what jukecord knew', async () => {
    const { store, actions, tracks, asked } = setup();
    const content = JSON.stringify({
      kind: 'jukecord playlist',
      version: 1,
      name: 'Shared',
      tracks: [
        {
          url: 'https://example.com/watch?v=v1',
          title: 'Another title',
          uploader: null,
          durationMs: 1,
          thumbnail: null,
        },
        { url: 'https://example.com/new', title: 'New one', uploader: 'Someone', durationMs: 200_000, thumbnail: null },
        { url: 'https://inside.example/secret', title: 'Inside', uploader: null, durationMs: null, thumbnail: null },
      ],
    });
    const result = await actions.playlistImport(DJ, 'Shared', content);
    assert.equal(result.tracks, 2);
    // The address on a private network is left out.
    assert.equal(result.leftOut, 1);
    assert.deepEqual(asked, []);
    const saved = store.playlists.tracks(result.playlist.id);
    // The known track keeps its own title; the new one is stored as the file said.
    assert.equal(saved[0]?.id, tracks[0]?.id);
    assert.equal(saved[0]?.title, 'Track 1');
    assert.deepEqual([saved[1]?.title, saved[1]?.uploader, saved[1]?.durationMs], ['New one', 'Someone', 200_000]);
  });

  it('looks up a pasted list three at a time, in its order, and counts what it could not find', async () => {
    const { store, actions, tracks, most } = setup({
      'https://example.com/unknown': 2,
      'Example Band - Velvet Hours': 3,
      'Demo Orchestra - Lanterns': 4,
    });
    const content = [
      'https://example.com/unknown',
      'example.com/watch?v=v2',
      'Example Band - Velvet Hours',
      'nothing like it',
      'Demo Orchestra - Lanterns',
    ].join('\n');
    const result = await actions.playlistImport(DJ, 'Pasted', content);
    assert.deepEqual(
      store.playlists.tracks(result.playlist.id).map((track) => track.id),
      [tracks[2]?.id, tracks[1]?.id, tracks[3]?.id, tracks[4]?.id],
    );
    assert.equal(result.leftOut, 1);
    assert.ok(most() <= 3);
  });

  it('looks up a hundred lines at most, and refuses a taken name, an empty list and one with nothing found', async () => {
    const table = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`song ${index}`, index % 5]));
    const { actions, store } = setup(table);
    const result = await actions.playlistImport(
      DJ,
      'Long',
      Array.from({ length: 120 }, (_, index) => `song ${index}`).join('\n'),
    );
    assert.equal(result.tracks, 100);
    assert.equal(result.leftOut, 20);
    assert.equal(
      await refusal(() => actions.playlistImport(DJ, 'Long', 'song 1')),
      'conflict: a playlist named "Long" exists',
    );
    assert.equal(
      await refusal(() => actions.playlistImport(DJ, 'Empty', '\n# nothing\n')),
      'invalid: there is nothing to import in it',
    );
    assert.equal(
      await refusal(() => actions.playlistImport(DJ, 'Missing', 'no such song')),
      'not-found: nothing in it could be found',
    );
    assert.equal(store.playlists.find(GUILD, 'Missing'), null);
    assert.equal(
      await refusal(() => actions.playlistImport({ ...DJ, mayControl: false }, 'Mine', 'song 1')),
      'forbidden: only members with the DJ role can change the music here',
    );
  });
});

describe('lists taking turns', () => {
  it('runs three at once across every list, one list per person, and keeps the order of the results', async () => {
    const batch = new BatchLookups(3);
    let running = 0;
    let most = 0;
    const work = async (item: number) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 3));
      running -= 1;
      if (item === 2) throw new Error('not found');
      return item * 10;
    };
    const first = batch.map('alice', [0, 1, 2, 3, 4], work);
    // A second list of the same person while the first runs: refused at once.
    await assert.rejects(batch.map('alice', [9], work), /still adding a list of yours/);
    const second = batch.map('bob', [5, 6], work);
    const [one, two] = await Promise.all([first, second]);
    assert.ok(most <= 3);
    assert.deepEqual(
      one.map((result) => (result instanceof Error ? 'error' : result)),
      [0, 10, 'error', 30, 40],
    );
    assert.deepEqual(two, [50, 60]);
  });
});

describe('playlists in and out over HTTP and in the CLI', () => {
  let server: TestServer;
  const api = (path: string) => `${API_PREFIX}${path}`;
  before(async () => {
    server = await testServer();
  });
  after(() => server.close());

  it('imports a file larger than the usual body limit, and exports it again', async () => {
    const tracks = Array.from({ length: 400 }, (_, index) => ({
      url: `https://example.com/watch?v=t${index}`,
      title: `A long made-up title for the track number ${index} of this playlist`,
      uploader: 'Example Band',
      durationMs: 180_000,
      thumbnail: `https://example.com/covers/${index}.jpg`,
    }));
    const content = JSON.stringify({ kind: 'jukecord playlist', version: 1, name: 'Big', tracks });
    assert.ok(content.length > 64 * 1024);
    const imported = await server.web.app.inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/playlists/import`),
      headers: asHost,
      payload: { name: 'Big', content },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.deepEqual([imported.json().tracks, imported.json().leftOut, imported.json().playlist.size], [400, 0, 400]);
    const exported = await server.web.app.inject({
      method: 'GET',
      url: api(`/guilds/${GUILD}/playlists/Big/export?format=m3u`),
      headers: asHost,
    });
    assert.equal(exported.json().filename, 'Big.m3u');
    assert.ok(
      exported.json().content.startsWith('#EXTM3U\n#PLAYLIST:Big\n#EXTINF:180,Example Band - A long made-up title'),
    );
  });

  it('prints an export as the file, and an import in a line', () => {
    const file = writePlaylist('Mix', [], 'text');
    assert.equal(
      COMMANDS['playlist-export'].show({ content: `${file}https://example.com/a\n` }),
      'https://example.com/a',
    );
    assert.equal(
      COMMANDS['playlist-import'].show({ playlist: { name: 'Mix' }, tracks: 12, leftOut: 2 }),
      'Imported Mix: 12 tracks, 2 left out',
    );
  });
});
