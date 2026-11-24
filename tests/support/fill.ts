/**
 * A database with rows in every table of the schema, of the kinds that go wrong between databases: emoji and other
 * four-byte characters, names that differ only by case or accent, a source longer than an index entry takes, nulls,
 * a real number, the order voice channels were first kept in, a liked track, a guest of a listening link. For the
 * copy's tests (every row must come through) and the backups of a server database.
 */
import { AUTOPLAY } from '../../src/core/types.ts';
import { TABLES } from '../../src/store/schema.ts';
import type { Store } from '../../src/store/store.ts';

const GUILD = '100000000000000001';
const OTHER = '100000000000000002';
const ALICE = '300000000000000001';

/** A source address longer than MySQL's index and PostgreSQL's btree take (both key it by its hash). */
export const LONG_SOURCE = `https://example.com/watch?v=long&list=${'x'.repeat(3000)}`;

/** Fills every table of `store` with a few rows (see the module comment); the tracks' ids are 1 to 4. */
export async function fill(store: Store): Promise<void> {
  const tracks = [];
  for (const [index, title] of ['Neon Rain 🌧️', 'Mix', 'mix', 'Mïx — 夜の歌 🎵'].entries()) {
    tracks.push(
      await store.tracks.upsert({
        source: index === 3 ? LONG_SOURCE : `https://example.com/watch?v=t${index + 1}`,
        url: `https://example.com/watch?v=t${index + 1}`,
        title,
        uploader: index === 1 ? null : 'Pale Orchard',
        durationMs: 180_000 + index,
        thumbnail: index === 2 ? null : `https://example.com/t${index + 1}.jpg`,
      }),
    );
  }
  const [one, two, three, four] = tracks.map((track) => track.id) as [number, number, number, number];
  await store.tracks.setLoudness(one, -13.75);
  await store.queue.insert(GUILD, [one, two, three], 0, ALICE);
  await store.queue.insert(GUILD, [four], 3, AUTOPLAY);
  await store.queue.insert(OTHER, [two], 0, null);
  await store.playerState.save({
    guildId: GUILD,
    trackId: four,
    addedBy: null,
    status: 'paused',
    positionMs: 61_250,
    repeat: 'queue',
    autoplay: 'related',
  });
  for (const [index, trackId] of [one, two, one, four].entries()) {
    await store.history.add({
      guildId: GUILD,
      trackId,
      addedBy: index === 3 ? AUTOPLAY : ALICE,
      playedAt: Date.UTC(2026, 10, 1) + index * 3_600_000,
      playedMs: 120_000 + index,
    });
  }
  // Three lists whose names differ only by case or accent: three playlists.
  await store.playlists.save(GUILD, 'Mix', [one, two], ALICE);
  await store.playlists.save(GUILD, 'mix', [three], null);
  await store.playlists.save(GUILD, 'Mïx 🎶', [four, one, two], ALICE);
  await store.settings.setDjRole(GUILD, '500000000000000001');
  await store.settings.setCommunity(GUILD, { voteSkip: false, personLimit: 3, volume: 85, sound: 'night' });
  await store.settings.setAlertsChannel(OTHER, '600000000000000001');
  await store.discord.setCommandsHash(GUILD, 'f'.repeat(64));
  await store.users.upsert({ id: ALICE, name: 'Alice 🦊', avatar: null });
  await store.sessions.create({
    idHash: 'a'.repeat(64),
    kind: 'user',
    userId: ALICE,
    csrf: 'csrf-one',
    scope: 'admin',
    expiresAt: Date.UTC(2030, 0, 1),
  });
  await store.tokens.create({ hash: 'b'.repeat(64), name: 'laptop ✨', kind: 'host', userId: null, scope: 'control' });
  // Kept in this order, the second changed later in place: the order is the one they were first kept in.
  await store.voiceChannels.remember(OTHER, '400000000000000002');
  await store.voiceChannels.remember(GUILD, '400000000000000001');
  await store.voiceChannels.remember(OTHER, '400000000000000003');
  await store.voiceChannels.told(GUILD);
  await store.lyrics.save({
    trackId: one,
    kind: 'synced',
    synced: '[00:01.00] 비가 내려 🌧️\n[00:05.00] neon',
    plain: '비가 내려 🌧️\nneon',
    sourceId: 42,
  });
  await store.lyrics.save({ trackId: two, kind: 'none', synced: null, plain: null, sourceId: null });
  await store.music.set(one, { artist: 'Pale Orchard', title: 'Neon Rain', album: null });
  const link = await store.listenLinks.create({
    hash: 'c'.repeat(64),
    guildId: GUILD,
    createdBy: ALICE,
    lastsMs: 86_400_000,
    maxGuests: 2,
  });
  await store.guests.create({ idHash: 'd'.repeat(64), linkId: link.id, csrf: 'csrf-guest', expiresAt: link.expiresAt });
  await store.likes.add(ALICE, four);
  await store.likes.add('host', one);
}

/**
 * Every row of every table, each table's rows in the order of its key (the voice channels in the order they were
 * first kept), as plain values: two databases that hold the same give the same.
 */
export async function everyRow(store: Store): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const columns = table.columns.map((column) => store.dialect.column(column)).join(', ');
    const order = table.ordered ? store.dialect.insertionOrder : table.key.join(', ');
    // Each row as a list of its values in the columns' order (a driver's row object may carry more).
    rows[table.name] = (await store.sql.all(`SELECT ${columns} FROM ${table.name} ORDER BY ${order}`)).map((row) =>
      table.columns.map((column) => row[column] ?? null),
    );
  }
  return rows;
}
