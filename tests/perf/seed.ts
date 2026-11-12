/**
 * Fills a data directory as a server used every day for a year would be: a thousand different tracks, all of them in
 * the queue (its default limit), 10,000 plays over the last 365 days by eight people, and a few saved playlists. The
 * tracks' addresses, titles and pictures are made up but as long as real ones (a video page's address, a picture's
 * address, a title of a few words), so sizes and compression come out as they would. No audio: tests/perf/reads.ts
 * only reads. tests/perf/measure.sh runs it inside the image.
 *
 *   node tests/perf/seed.ts <data directory>
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/store/store.ts';

const dataDir = path.resolve(process.argv[2] ?? 'data');
const GUILD = 'local';
// A fixed sequence of numbers (mulberry32), so every run makes the same server. Its 32-bit integer steps stay exact,
// where a multiplication past 2^53 in plain numbers would round and soon repeat itself.
let state = 11;
const random = (): number => {
  state = (state + 0x6d2b79f5) | 0;
  let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
// An eleven-letter ID like a video site's.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const videoId = (): string => Array.from({ length: 11 }, () => pick([...LETTERS])).join('');

// Words for made-up titles and names, in both languages, as a mixed queue has.
const WORDS = [
  'Morning',
  'River',
  'Glass',
  'Garden',
  'Neon',
  'Rain',
  'Static',
  'Bloom',
  'Satellite',
  'Hearts',
  'Low',
  'Tide',
  'Velvet',
  'Hours',
  'Copper',
  'Skies',
  'Paper',
  'Boats',
  'Echo',
  'Valley',
  '새벽',
  '바다',
  '여름밤',
  '정류장',
  '자전거',
  '편의점',
  '옥상',
  '겨울',
];
const SUFFIXES = ['', '', '', ' (Live)', ' (Acoustic)', ' (Official Audio)', ' (Extended Mix)', ' [Remastered]'];
const ARTISTS = Array.from(
  { length: 60 },
  (_, index) => `${pick(WORDS)} ${pick(WORDS)}${index % 4 === 0 ? ' - Topic' : ''}`,
);
// Eight people with made-up IDs.
const PEOPLE = ['Mina', 'Joon', '하늘', 'Sol', 'Ara', 'Theo', '도윤', 'Kai'].map((name, index) => ({
  id: `30000000000000000${index + 1}`,
  name,
}));

fs.mkdirSync(dataDir, { recursive: true });
const store = Store.open(path.join(dataDir, 'jukecord.db'));
for (const person of PEOPLE) store.users.upsert({ id: person.id, name: person.name, avatar: null });

const tracks = store.transaction(() =>
  Array.from({ length: 1000 }, () => {
    const id = videoId();
    const words = Array.from({ length: 2 + Math.floor(random() * 5) }, () => pick(WORDS)).join(' ');
    return store.tracks.upsert({
      source: `https://media.example/watch?v=${id}`,
      url: `https://media.example/watch?v=${id}`,
      title: `${words}${pick(SUFFIXES)}`,
      uploader: pick(ARTISTS),
      // Two to seven minutes.
      durationMs: Math.round(120_000 + random() * 300_000),
      thumbnail: `https://images.media.example/vi/${id}/hqdefault.jpg`,
    });
  }),
);

// The whole thousand in the queue, added by the people in turn.
store.queue.insert(
  GUILD,
  tracks.map((track) => track.id),
  0,
  null,
);
store.transaction(() => {
  for (const [index, item] of store.queue.list(GUILD).entries()) {
    store.db
      .prepare('UPDATE queue_items SET added_by = ? WHERE id = ?')
      .run(PEOPLE[index % PEOPLE.length]?.id ?? null, item.id);
  }
});

// A year of plays: the favourites more often, anyone adding them.
const now = Date.now();
store.transaction(() => {
  for (let play = 0; play < 10_000; play += 1) {
    const track = tracks[Math.floor(random() ** 1.6 * tracks.length)];
    if (!track) continue;
    store.history.add({
      guildId: GUILD,
      trackId: track.id,
      addedBy: random() < 0.15 ? null : pick(PEOPLE).id,
      playedAt: Math.round(now - random() * 365 * 86_400_000),
      playedMs: Math.round(60_000 + random() * 240_000),
    });
  }
});

// A few saved playlists of different sizes.
for (const [name, size] of [
  ['Friday night', 40],
  ['드라이브', 120],
  ['Everything', 400],
] as const) {
  store.playlists.save(
    GUILD,
    name,
    tracks.slice(0, size).map((track) => track.id),
    pick(PEOPLE).id,
  );
}

const count = (table: string): number =>
  (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
console.log(
  `seeded ${dataDir}: ${count('tracks')} tracks, ${count('queue_items')} queued, ${count('history')} plays, ${count('playlists')} playlists`,
);
store.close();
