/**
 * Many at once on one store with a pool of ten connections, as jukecord runs one, on each database:
 * - ten Discord servers' changes side by side, each server's in turn as its lane runs them: none refused for another
 *   server's sake (READ COMMITTED for the work the lanes put in order; at the serializable level PostgreSQL's page and
 *   table locks and MariaDB's gap locks refused them, and ten servers used up the tries);
 * - a check and the write that hangs on it in a turn on its key (TransactionOptions.turn), as a login's likes and a
 *   listening link's guests take one: those of one key one at a time in line, those of other keys side by side, ten
 *   logins' likes at once and fifty browsers at once at one link without one failing (at the serializable level some
 *   used up their tries), and the link's places never overfilled.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { it } from 'node:test';
import { openExecutor } from '../../src/store/open.ts';
import type { ExecutorReport } from '../../src/store/sql.ts';
import { Store } from '../../src/store/store.ts';
import { eachDatabase, type TestDatabase } from '../support/databases.ts';

// How many servers (or logins) run at once, and how many rounds of changes each makes.
const SERVERS = 10;
const ROUNDS = 12;

// The most likes a login keeps (as src/app/actions.ts's LIKES_MAX): the check the likes' transaction makes.
const LIKES_MAX = 1000;

// A store on the test's database with a pool of ten, as jukecord runs one, whose transactions that failed (refused
// and run again, or failed for good) are counted.
async function countedStore(db: TestDatabase): Promise<{ store: Store; failedTries: () => number }> {
  let failed = 0;
  const report: ExecutorReport = {
    query: (kind, _seconds, didFail) => {
      if (kind === 'transaction' && didFail) failed += 1;
    },
    connections: () => {},
  };
  const store = await Store.open(await openExecutor(await db.address(), { waitMs: 0, pool: 10, idleMs: 1000, report }));
  return { store, failedTries: () => failed };
}

// Fifty tracks every server queues from.
async function tracksOf(store: Store): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    const url = `https://example.com/t${i}`;
    const track = { source: url, url, title: `t${i}`, uploader: null, durationMs: 1000, thumbnail: null };
    ids.push((await store.tracks.upsert(track)).id);
  }
  return ids;
}

// Runs `step` for each of the servers at once, each server's rounds one after another (its lane), and gives every
// failure in words.
async function sideBySide(step: (server: number, round: number) => Promise<void>): Promise<string[]> {
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: SERVERS }, async (_, server) => {
      for (let round = 0; round < ROUNDS; round += 1) {
        try {
          await step(server, round);
        } catch (error) {
          failures.push(`server ${server}, round ${round}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }),
  );
  return failures;
}

// A server's ID in these tests.
const guildOf = (server: number) => `90000000000000${String(server).padStart(4, '0')}`;

// A SHA-256 in hex, as the logins' secrets are kept.
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// Likes a track as src/app/actions.ts does: the limit checked and the like written in the login's own turn.
function like(store: Store, owner: string, trackId: number, max = LIKES_MAX): Promise<void> {
  return store.transaction(
    async () => {
      if (!(await store.likes.has(owner, trackId)) && (await store.likes.count(owner)) >= max) {
        throw new Error('the likes are full');
      }
      await store.likes.add(owner, trackId);
    },
    { turn: `likes:${owner}` },
  );
}

// Comes in with a listening link's code as src/web/auth.ts does: the link looked up, the guests whose time is up let
// go, the places counted and one taken, in the link's own turn.
function join(store: Store, codeHash: string): Promise<'invalid' | 'full' | 'guest'> {
  return store.transaction(
    async () => {
      const link = await store.listenLinks.byHash(codeHash);
      if (!link) return 'invalid';
      await store.guests.prune();
      if ((await store.guests.count(link.id)) >= link.maxGuests) return 'full';
      const secret = randomBytes(16).toString('hex');
      await store.guests.create({ idHash: hash(secret), linkId: link.id, csrf: 'c', expiresAt: link.expiresAt });
      return 'guest';
    },
    { turn: `listen:${codeHash}` },
  );
}

eachDatabase('many at once', (db) => {
  it('runs ten servers’ queues, history and playlists side by side, none refused for another’s sake', async (t) => {
    const { store, failedTries } = await countedStore(db);
    try {
      const tracks = await tracksOf(store);
      const before = failedTries();
      const failures = await sideBySide(async (server, round) => {
        const guild = guildOf(server);
        const by = `user${server}`;
        // A server's changes in the order its lane runs them: tracks queued, the next one taken to play, its play
        // written down, a playlist saved, a queued track removed, and the figures read.
        const at = (offset: number) => tracks[(round + offset) % tracks.length] ?? 0;
        await store.queue.insert(guild, [at(0), at(7), at(13)], Number.MAX_SAFE_INTEGER, by);
        const next = await store.queue.shift(guild);
        if (next) {
          const played = { guildId: guild, trackId: next.track.id, addedBy: by, playedAt: round, playedMs: 1000 };
          await store.history.add(played);
        }
        await store.playlists.save(guild, `list ${round % 3}`, tracks.slice(0, 5), by);
        const queued = await store.queue.list(guild);
        await store.queue.removeMany(
          guild,
          queued.slice(0, 1).map((item) => item.id),
        );
        await store.history.stats(guild, 0, 0);
      });
      assert.deepEqual(failures, []);
      const refused = failedTries() - before;
      t.diagnostic(`${refused} of about ${SERVERS * ROUNDS * 5} transactions refused once and run again`);
      if (db.kind === 'mysql') {
        // InnoDB also locks the index entry just past a server's own last one, another server's, so now and then two
        // servers' changes deadlock and one is run again (none or one in a run here; fifty and more at the
        // serializable level, where some ran out of tries).
        assert.ok(refused <= 5, `${refused} transactions refused`);
      } else {
        // PostgreSQL waits only for the rows a statement changes, and each server's rows are its own: none refused.
        assert.equal(refused, 0);
      }
      // Every server's queue holds what its rounds left there (three queued, one played, one removed, each round).
      for (let server = 0; server < SERVERS; server += 1)
        assert.equal(await store.queue.count(guildOf(server)), ROUNDS);
    } finally {
      await store.close();
    }
  });

  it('keeps the likes of ten logins at once, each in the login’s own turn, without one failing', async () => {
    const { store } = await countedStore(db);
    try {
      const tracks = await tracksOf(store);
      const failures = await sideBySide((login, round) =>
        like(store, `user${login}`, tracks[(login + round) % 50] ?? 0),
      );
      assert.deepEqual(failures, []);
      for (let login = 0; login < SERVERS; login += 1) assert.equal(await store.likes.count(`user${login}`), ROUNDS);
    } finally {
      await store.close();
    }
  });

  it('lets fifty browsers at once into a listening link of forty places: forty in, ten told it is full', async () => {
    const { store } = await countedStore(db);
    try {
      const code = randomBytes(16).toString('hex');
      await store.listenLinks.create({
        hash: hash(code),
        guildId: guildOf(0),
        createdBy: null,
        lastsMs: 3_600_000,
        maxGuests: 40,
      });
      const outcomes = await Promise.allSettled(Array.from({ length: 50 }, () => join(store, hash(code))));
      const said = outcomes.map((outcome) =>
        outcome.status === 'fulfilled' ? outcome.value : `failed: ${String(outcome.reason)}`,
      );
      assert.deepEqual(
        [said.filter((kind) => kind === 'guest').length, said.filter((kind) => kind === 'full').length],
        [40, 10],
        said.filter((kind) => kind.startsWith('failed')).join('\n'),
      );
      const link = await store.listenLinks.byHash(hash(code));
      assert.equal(await store.guests.count(link?.id ?? 0), 40);
    } finally {
      await store.close();
    }
  });

  it('takes turns on one key one at a time, at its limit only one passing, and none across keys', async () => {
    const { store } = await countedStore(db);
    try {
      const tracks = await tracksOf(store);
      // A login one like from a limit of three, and five likes of it at once: one passes, in its turn.
      await like(store, 'limited', tracks[0] ?? 0, 3);
      await like(store, 'limited', tracks[1] ?? 0, 3);
      let inside = 0;
      let most = 0;
      const outcomes = await Promise.allSettled(
        [2, 3, 4, 5, 6].map((index) =>
          store.transaction(
            async () => {
              // How many of this key are inside at once: one, since the others wait in line.
              inside += 1;
              most = Math.max(most, inside);
              try {
                await new Promise((resolve) => setTimeout(resolve, 20));
                if ((await store.likes.count('limited')) >= 3) throw new Error('the likes are full');
                await store.likes.add('limited', tracks[index] ?? 0);
              } finally {
                inside -= 1;
              }
            },
            { turn: 'likes:limited' },
          ),
        ),
      );
      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [
        'fulfilled',
        'rejected',
        'rejected',
        'rejected',
        'rejected',
      ]);
      assert.equal(most, 1);
      assert.equal(await store.likes.count('limited'), 3);
      // Two keys' turns at once, each waiting inside for the other to come in: on a server neither waits for the
      // other's turn (SQLite's transactions take turns whatever their key, so this is not asked of it).
      if (db.kind !== 'sqlite') {
        let arrived = 0;
        let both: () => void = () => {};
        const together = new Promise<void>((resolve) => {
          both = resolve;
        });
        const meet = (key: string) =>
          store.transaction(
            async () => {
              arrived += 1;
              if (arrived === 2) both();
              await Promise.race([
                together,
                new Promise((_, reject) => setTimeout(() => reject(new Error('the other key waited')), 3000)),
              ]);
            },
            { turn: key },
          );
        await Promise.all([meet('likes:a'), meet('likes:b')]);
      }
    } finally {
      await store.close();
    }
  });
});
