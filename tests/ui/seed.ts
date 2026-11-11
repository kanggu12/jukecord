/**
 * Fills a data directory with example data for looking at the panel: tracks with made-up titles and drawn covers, a
 * queue, a month of history from a few people, playlists, and a cached audio file for every track, so playing works
 * with no network. Nothing here points at a real site, song or person.
 *
 *   node tests/ui/seed.ts <data directory> [--queue N] [--ffmpeg path]
 *
 * Runs inside the jukecord image (it has ffmpeg with Opus), as tests/ui/run.sh does.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MediaCache } from '../../src/media/cache.ts';
import { Store } from '../../src/store/store.ts';

const dataDir = path.resolve(process.argv[2] ?? 'data');
const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? (process.argv[at + 1] ?? fallback) : fallback;
};
const queueSize = Number(option('queue', '14'));
const ffmpeg = option('ffmpeg', 'ffmpeg');
const GUILD = option('guild', 'local');

// Made-up titles in both languages, a few of them long, the way real titles are.
const TITLES = [
  'Morning Light',
  'Paper Boats on the River',
  '새벽 세 시의 편의점',
  'Glass Garden (Live at the Old Hall)',
  'Neon Rain',
  '여름밤 옥상에서',
  'The Long Way Home, Part II: Through the Valley of Quiet Lights and Slow Trains (Extended Mix)',
  'Static Bloom',
  '파란 자전거',
  'Satellite Hearts',
  'Low Tide',
  '겨울 끝의 정류장 (어쿠스틱 버전)',
  'Velvet Hours',
  'Copper Skies',
  '첫눈이 오면',
  'Afterglow Avenue',
  'Lanterns',
  '달리는 기차 안에서 듣는 노래',
  'Small Victories',
  'Echo Valley',
  'Midnight Laundromat',
  '고양이와 오후',
  'Signal Fire',
  'Northern Static',
  '바다로 가는 버스',
  'Golden Hour Radio',
  'Maple Street',
  '비 오는 날의 카페',
  'Polaroid Summer',
  'Ferris Wheel',
];
const ARTISTS = ['Example Band', 'The Placeholders', '예시 밴드', 'Demo Orchestra', 'Sample Sound', '가상의 가수'];
// People who add tracks: made-up names with made-up IDs.
const PEOPLE = [
  { id: '300000000000000001', name: 'Mina' },
  { id: '300000000000000002', name: 'Joon' },
  { id: '300000000000000003', name: '하늘' },
  { id: '300000000000000004', name: 'Sol' },
];

// A cover drawn as SVG: two colours and a shape, different for every track.
function cover(index: number): string {
  const hue = (index * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},62%,58%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,32%)"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><circle cx="${30 + (index % 5) * 15}" cy="${40 + (index % 3) * 20}" r="${18 + (index % 4) * 6}" fill="hsl(${(hue + 180) % 360},70%,75%)" opacity=".55"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

fs.mkdirSync(dataDir, { recursive: true });
const store = Store.open(path.join(dataDir, 'jukecord.db'));
for (const person of PEOPLE) store.users.upsert({ id: person.id, name: person.name, avatar: null });

// One audio file, copied for every track: a soft three-minute tone (the panel needs real Opus to play along).
const cacheDir = path.join(dataDir, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });
const sample = path.join(dataDir, 'sample.opus');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  // A source filter, not -f lavfi: the image's FFmpeg is built without devices (lavfi is one).
  '-filter_complex',
  'sine=frequency=330:duration=180,volume=0.08',
  '-c:a',
  'libopus',
  '-b:a',
  '48k',
  '-f',
  'ogg',
  sample,
]);

const tracks = TITLES.map((title, index) => {
  const id = `demo${String(index + 1).padStart(3, '0')}`;
  const track = store.tracks.upsert({
    source: `https://media.example/${id}`,
    url: `https://media.example/${id}`,
    title,
    uploader: ARTISTS[index % ARTISTS.length] ?? null,
    durationMs: 180_000,
    thumbnail: cover(index),
  });
  // Cached as jukecord would have left it: the file and the facts beside it.
  const key = MediaCache.keyOf(track.source);
  fs.copyFileSync(sample, path.join(cacheDir, `${key}.opus`));
  fs.writeFileSync(
    path.join(cacheDir, `${key}.json`),
    JSON.stringify({ source: track.source, durationMs: 180_000, loudness: -14 }),
  );
  return track;
});
fs.rmSync(sample);

// The queue: tracks 2.. in order, added by the people in turn (the first track is left for "play" in the walk).
store.queue.insert(
  GUILD,
  tracks.slice(1, 1 + queueSize).map((track) => track.id),
  0,
  null,
);
const items = store.queue.list(GUILD);
store.transaction(() => {
  for (const [index, item] of items.entries()) {
    store.db
      .prepare('UPDATE queue_items SET added_by = ? WHERE id = ?')
      .run(PEOPLE[index % PEOPLE.length]?.id ?? null, item.id);
  }
});

// A month of history: more in the evenings, more on weekends, from different people.
const now = Date.now();
let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
for (let day = 29; day >= 0; day -= 1) {
  const weekend = new Date(now - day * 86_400_000).getUTCDay() % 6 === 0;
  const plays = Math.floor(random() * (weekend ? 18 : 9)) + (day % 7 === 3 ? 0 : 2);
  for (let play = 0; play < plays; play += 1) {
    // Hours weighted towards the evening (in UTC+9, where the example people are).
    const hour = Math.floor(random() < 0.6 ? 10 + random() * 6 : random() * 24);
    const at = now - day * 86_400_000 - ((now / 3_600_000) % 24) * 3_600_000 + hour * 3_600_000 + random() * 3_600_000;
    const track = tracks[Math.floor(random() ** 1.6 * tracks.length)] ?? tracks[0];
    if (!track || at > now) continue;
    store.history.add({
      guildId: GUILD,
      trackId: track.id,
      addedBy: random() < 0.15 ? null : (PEOPLE[Math.floor(random() * PEOPLE.length)]?.id ?? null),
      playedAt: Math.round(at),
      playedMs: Math.round(60_000 + random() * 120_000),
    });
  }
}

// Saved playlists.
store.playlists.save(
  GUILD,
  'Friday night',
  tracks.slice(0, 12).map((track) => track.id),
  PEOPLE[0]?.id ?? null,
);
store.playlists.save(
  GUILD,
  '드라이브',
  tracks.slice(10, 22).map((track) => track.id),
  PEOPLE[2]?.id ?? null,
);
store.playlists.save(
  GUILD,
  'Quiet hours',
  tracks.slice(5, 9).map((track) => track.id),
  null,
);
store.close();
process.stdout.write(`seeded ${dataDir}: ${tracks.length} tracks, ${items.length} queued\n`);
