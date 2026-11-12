/**
 * Likes: each login's own list, the tracks a server shows that may be liked there (and no others), the bound on a
 * list, adding them all, and the operations over HTTP.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions, likesOwner } from '../../src/app/actions.ts';
import { COMMANDS } from '../../src/cli/commands.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import { likesCard } from '../../src/discord/cards.ts';
import { createLogger } from '../../src/log.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { LIKES_MAX } from '../../src/store/store.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { FakeClock, FakeMedia } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';
import { ALICE, asHost, BOB, exampleTrack, GUILD, sessionFor, type TestServer, testServer } from '../support/web.ts';

const log = createLogger({ level: 'error', sinks: [] });
const OTHER = '100000000000000002';

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
  const actions = new Actions({ store, queue, players, resolver: {} as Resolver, log });
  const tracks = addTracks(store, 6);
  return { store, queue, players, actions, tracks, clock };
}

const as = (userId: string | null, guildId = GUILD, mayControl = true): ActionContext => ({
  guildId,
  userId,
  mayControl,
  mayManage: false,
});

// The error code and message of an action that refuses.
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ActionError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'done';
}

describe('likes', () => {
  it('are each login’s own, the host’s included, and need no DJ role', () => {
    const { actions, queue, tracks } = setup();
    const [one, two] = tracks;
    assert.ok(one && two);
    queue.add(GUILD, [one.id, two.id], 'end', null);
    // A listener without the DJ role may like.
    actions.like(as(ALICE, GUILD, false), one.id);
    actions.like(as(null), two.id);
    assert.deepEqual(
      actions.likes(as(ALICE)).map((entry) => entry.track.id),
      [one.id],
    );
    assert.deepEqual(
      actions.likes(as(null)).map((entry) => entry.track.id),
      [two.id],
    );
    assert.equal(likesOwner(as(null)), 'host');
    // Liking twice is one like.
    actions.like(as(ALICE), one.id);
    assert.equal(actions.likes(as(ALICE)).length, 1);
    actions.unlike(as(ALICE), one.id);
    assert.equal(actions.likes(as(ALICE)).length, 0);
    assert.equal(
      refusal(() => actions.unlike(as(ALICE), one.id)),
      'not-found: that track is not in your likes',
    );
  });

  it('take only a track this server shows: playing, queued, played or in a playlist', () => {
    const { actions, queue, players, store, tracks } = setup();
    const [playing, queued, played, listed, elsewhere] = tracks;
    assert.ok(playing && queued && played && listed && elsewhere);
    queue.add(GUILD, [playing.id], 'end', null);
    players.get(GUILD).play();
    queue.add(GUILD, [queued.id], 'end', null);
    store.history.add({ guildId: GUILD, trackId: played.id, addedBy: null, playedAt: 1, playedMs: 5000 });
    store.playlists.save(GUILD, 'Mix', [listed.id], null);
    // Another server's track, and a number no track has.
    store.history.add({ guildId: OTHER, trackId: elsewhere.id, addedBy: null, playedAt: 1, playedMs: 5000 });
    for (const track of [playing, queued, played, listed]) actions.like(as(ALICE), track.id);
    const refused = 'not-found: that track is not playing, queued or played in this server';
    assert.equal(
      refusal(() => actions.like(as(ALICE), elsewhere.id)),
      refused,
    );
    assert.equal(
      refusal(() => actions.like(as(ALICE), 999)),
      refused,
    );
    // In its own server it may be liked.
    actions.like(as(ALICE, OTHER), elsewhere.id);
    assert.equal(actions.likes(as(ALICE)).length, 5);
  });

  it('stop at the bound of a list, and a like already there still answers', () => {
    const { actions, store, queue, tracks } = setup();
    const [first, last] = tracks;
    assert.ok(first && last);
    queue.add(GUILD, [first.id, last.id], 'end', null);
    store.likes.add(ALICE, first.id);
    // A full list, made in the table itself (a thousand rows of made-up tracks).
    for (const track of addTracks(store, LIKES_MAX - 1, 'full')) store.likes.add(ALICE, track.id);
    assert.equal(store.likes.count(ALICE), LIKES_MAX);
    assert.equal(
      refusal(() => actions.like(as(ALICE), last.id)),
      `conflict: your likes are full (${LIKES_MAX} tracks)`,
    );
    assert.equal(actions.like(as(ALICE), first.id).track.id, first.id);
  });

  it('go into the queue all at once, newest first, for people who may change the music', async () => {
    const { actions, queue, tracks, clock, players } = setup();
    const [a, b, c] = tracks;
    assert.ok(a && b && c);
    queue.add(GUILD, [a.id, b.id, c.id], 'end', null);
    for (const track of [a, b, c]) {
      actions.like(as(ALICE), track.id);
      await clock.advance(1);
    }
    queue.clear(GUILD);
    assert.equal(
      refusal(() => actions.likesAdd(as(ALICE, GUILD, false))),
      'forbidden: only members with the DJ role can change the music here',
    );
    const result = actions.likesAdd(as(ALICE));
    assert.equal(result.items.length, 3);
    // The newest liked plays first (the player took it), then the others in the list's order.
    assert.equal(players.get(GUILD).snapshot().track?.id, c.id);
    assert.deepEqual(
      queue.list(GUILD).map((item) => item.track.id),
      [b.id, a.id],
    );
    assert.equal(
      refusal(() => actions.likesAdd(as(BOB))),
      'invalid: there are no liked tracks to add',
    );
  });
});

describe('likes over HTTP, in the CLI and in Discord', () => {
  let server: TestServer;
  const api = (path: string) => `${API_PREFIX}${path}`;

  before(async () => {
    server = await testServer({ found: { one: [exampleTrack('a')] } });
    server.directory.join(GUILD, ALICE);
  });
  after(() => server.close());

  it('like, list and take back over HTTP; a read-only token may look but not like', async () => {
    await server.web.app.inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/queue`),
      headers: asHost,
      payload: { input: 'one' },
    });
    const track = server.store.tracks.bySource('https://example.com/watch?v=a');
    assert.ok(track);
    const { cookie, csrf } = sessionFor(server, ALICE);
    const headers = { cookie, 'x-jukecord-csrf': csrf };
    const liked = await server.web.app.inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/likes/${track.id}`),
      headers,
    });
    assert.equal(liked.statusCode, 200);
    assert.equal(liked.json().track.title, 'Track a');
    const list = await server.web.app.inject({ method: 'GET', url: api(`/guilds/${GUILD}/likes`), headers });
    assert.deepEqual(
      list.json().map((entry: { track: { id: number } }) => entry.track.id),
      [track.id],
    );
    // The host's list is the host's.
    const hosts = await server.web.app.inject({ method: 'GET', url: api(`/guilds/${GUILD}/likes`), headers: asHost });
    assert.deepEqual(hosts.json(), []);
    const created = await server.web.app.inject({
      method: 'POST',
      url: api('/tokens'),
      headers: asHost,
      payload: { name: 'reader', scope: 'read' },
    });
    const reader = { authorization: `Bearer ${created.json().token}` };
    assert.equal(
      (await server.web.app.inject({ method: 'GET', url: api(`/guilds/${GUILD}/likes`), headers: reader })).statusCode,
      200,
    );
    assert.equal(
      (await server.web.app.inject({ method: 'PUT', url: api(`/guilds/${GUILD}/likes/${track.id}`), headers: reader }))
        .statusCode,
      403,
    );
    const taken = await server.web.app.inject({
      method: 'DELETE',
      url: api(`/guilds/${GUILD}/likes/${track.id}`),
      headers,
    });
    assert.deepEqual(taken.json(), { ok: true });
  });

  it('are shown numbered by the CLI and on a Discord card', () => {
    const entries = [
      { track: { title: 'First', url: 'https://example.com/watch?v=1', durationMs: 61_000 }, likedAt: 2 },
      { track: { title: 'Second', url: 'https://example.com/watch?v=2', durationMs: null }, likedAt: 1 },
    ];
    assert.equal(COMMANDS.likes.show(entries), '1. First · 1:01\n2. Second');
    assert.equal(COMMANDS.likes.show([]), 'No liked tracks');
    const card = likesCard(
      entries.map((entry, index) => ({
        likedAt: entry.likedAt,
        track: {
          ...entry.track,
          id: index + 1,
          source: entry.track.url,
          uploader: null,
          thumbnail: null,
          loudness: null,
        },
      })),
      1,
      'ko',
    ).toJSON();
    assert.equal(card.title, '좋아요 한 곡 (2)');
    assert.match(card.description ?? '', /^1\. \[First\]\(https:\/\/example\.com\/watch\?v=1\) · 1:01\n2\. \[Second\]/);
  });
});
