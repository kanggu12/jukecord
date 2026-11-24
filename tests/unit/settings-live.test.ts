/**
 * The settings that apply at once: each one marked so in the table is handed to a part of jukecord (none is marked
 * "at once" and then waits for a restart unseen), the Config in use takes exactly those, and each part does what the
 * new value says from then on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { type ActionContext, Actions } from '../../src/app/actions.ts';
import { loadConfig } from '../../src/config.ts';
import { Bus } from '../../src/core/bus.ts';
import { Countdowns } from '../../src/core/countdowns.ts';
import { GuildLanes } from '../../src/core/lanes.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { Track } from '../../src/core/types.ts';
import { ConsoleSink, createLogger, FileSink, MemorySink } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import { Links } from '../../src/media/links.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { MetricsGate } from '../../src/metrics/http.ts';
import { applyLive, type LiveParts } from '../../src/settings/apply.ts';
import { SETTINGS } from '../../src/settings/definitions.ts';
import { inUse } from '../../src/settings/service.ts';
import { valueIn } from '../../src/settings/values.ts';
import { FakeClock, FakeMedia } from '../support/fakes.ts';
import { inOrder, memoryStore } from '../support/store.ts';

// Every part, each call recorded by the part's name and the value it was given.
function recordingParts(): { parts: LiveParts; calls: string[] } {
  const calls: string[] = [];
  const say =
    (name: string) =>
    (...values: unknown[]) =>
      void calls.push(
        `${name} ${JSON.stringify(values, (_key, value) => (value instanceof Set ? [...value] : value))}`,
      );
  const parts: LiveParts = {
    log: { setLevel: say('level'), setFormat: say('format'), setLimits: say('log limits') },
    limits: { setLimits: say('limits') },
    autoplay: { setTrackMax: say('autoplay') },
    lyrics: { setLyrics: say('lyrics') },
    rest: { setAfter: say('rest') },
    cache: { setMaxBytes: say('cache') },
    prefetch: { setCount: say('prefetch') },
    links: { setServices: say('services'), setSpotify: say('spotify') },
    backups: { setSchedule: say('backups') },
    metrics: { setToken: say('metrics') },
    live: () => ({ setTotal: say('live') }),
    voice: () => ({ setIdleMs: say('voice') }),
  };
  return { parts, calls };
}

// A Config with every setting that can change off its default, so each one tells the start's value from the next's.
const NEXT_ENV = {
  JUKECORD_HOST: '0.0.0.0',
  JUKECORD_PORT: '9001',
  JUKECORD_PUBLISHED_PORT: '9002',
  JUKECORD_PUBLIC_URL: 'https://music.example.com',
  JUKECORD_TRUST_PROXY: '1',
  JUKECORD_LIVE_MAX: '50',
  JUKECORD_DATA_DIR: '/var/lib/elsewhere',
  JUKECORD_SUPERVISOR: 'docker',
  JUKECORD_DISCORD_TOKEN: 'made-up-token',
  JUKECORD_VOICE_IDLE: '1m',
  JUKECORD_DISCORD_CLIENT_ID: '123456789012345678',
  JUKECORD_DISCORD_CLIENT_SECRET: 'made-up-secret',
  JUKECORD_OIDC_ISSUER: 'https://sso.example.com/realms/home',
  JUKECORD_OIDC_CLIENT_ID: 'jukecord',
  JUKECORD_OIDC_CLIENT_SECRET: 'made-up',
  JUKECORD_OIDC_SCOPES: 'openid email',
  JUKECORD_OIDC_GROUPS_CLAIM: 'roles',
  JUKECORD_OIDC_ADMIN_GROUPS: 'admins',
  JUKECORD_OIDC_CONTROL_GROUPS: 'djs',
  JUKECORD_OIDC_READ_GROUPS: '*',
  JUKECORD_OIDC_LABEL: 'Company login',
  JUKECORD_OIDC_DISCORD_CLAIM: 'discord_id',
  JUKECORD_LDAP_URL: 'ldaps://directory.example.org',
  JUKECORD_LDAP_BIND_DN: 'cn=jukecord,dc=example,dc=org',
  JUKECORD_LDAP_BIND_PASSWORD: 'made-up',
  JUKECORD_LDAP_BASE_DN: 'dc=example,dc=org',
  JUKECORD_LDAP_USER_FILTER: '(cn={username})',
  JUKECORD_LDAP_GROUP_FILTER: '(member={dn})',
  JUKECORD_LDAP_GROUP_BASE_DN: 'ou=groups,dc=example,dc=org',
  JUKECORD_LDAP_ADMIN_GROUPS: 'admins',
  JUKECORD_LDAP_CONTROL_GROUPS: 'djs',
  JUKECORD_LDAP_READ_GROUPS: '*',
  JUKECORD_LDAP_TIMEOUT: '5s',
  JUKECORD_LDAP_LABEL: 'Office account',
  JUKECORD_DATABASE_URL: 'postgres://u:p@db.example/music',
  JUKECORD_DATABASE_POOL: '4',
  JUKECORD_QUEUE_MAX: '50',
  JUKECORD_TRACK_MAX: '10m',
  JUKECORD_REST_AFTER: '0',
  JUKECORD_CACHE_MAX: '1GiB',
  JUKECORD_FETCH_TIMEOUT: '30s',
  JUKECORD_PREFETCH: '1',
  JUKECORD_ALLOW_PRIVATE_ADDRESSES: 'true',
  JUKECORD_YTDLP: '/opt/yt-dlp',
  JUKECORD_FFMPEG: '/opt/ffmpeg',
  JUKECORD_LYRICS: 'off',
  JUKECORD_LINK_SERVICES: 'deezer',
  JUKECORD_SPOTIFY_CLIENT_ID: 'abcdefabcdefabcdefabcdefabcdefab',
  JUKECORD_SPOTIFY_CLIENT_SECRET: 'made-up',
  JUKECORD_BACKUP_AT: '04:30',
  JUKECORD_BACKUP_KEEP: '3',
  JUKECORD_LOG_LEVEL: 'debug',
  JUKECORD_LOG_FORMAT: 'json',
  JUKECORD_LOG_MAX: '1MiB',
  JUKECORD_LOG_FILES: '2',
  JUKECORD_METRICS_TOKEN: 'abcdefghijklmnopqrstuvwxyz',
};
// The settings NEXT_ENV cannot move off their default in the same Config (the directory's StartTLS takes ldap://, its
// nested groups no group filter, its CA file a file to read, the cookies a file too).
const UNMOVED = new Set([
  'JUKECORD_LDAP_STARTTLS',
  'JUKECORD_LDAP_NESTED_GROUPS',
  'JUKECORD_LDAP_CA_FILE',
  'JUKECORD_YTDLP_COOKIES',
]);

describe('the settings that apply at once', () => {
  it('hands each one to a part, and refuses one that applies after a restart', () => {
    const next = loadConfig(NEXT_ENV, '/srv');
    for (const setting of SETTINGS.filter((entry) => entry.applies === 'now')) {
      const { parts, calls } = recordingParts();
      applyLive([setting.name], next, parts);
      assert.ok(calls.length > 0, `${setting.name} changed no part`);
    }
    for (const setting of SETTINGS.filter((entry) => entry.applies === 'restart')) {
      assert.throws(() => applyLive([setting.name], next, recordingParts().parts), /nothing applies it/);
    }
    // What each part is given: the next Config's value.
    const { parts, calls } = recordingParts();
    applyLive(['JUKECORD_TRACK_MAX', 'JUKECORD_LINK_SERVICES', 'JUKECORD_BACKUP_AT'], next, parts);
    assert.deepEqual(calls, [
      'limits [{"queueMax":50,"trackMaxMs":600000}]',
      'autoplay [600000]',
      'services [["deezer"]]',
      'backups [{"hour":4,"minute":30},3]',
    ]);
  });

  it('keeps in use the next value of each one that applies at once, and the current one of every other', () => {
    const start = loadConfig({}, '/srv');
    const next = loadConfig(NEXT_ENV, '/srv');
    const used = inUse(start, next);
    for (const setting of SETTINGS) {
      if (UNMOVED.has(setting.name)) continue;
      const [was, will, now] = [start, next, used].map((config) => JSON.stringify(valueIn(config, setting.name)));
      assert.notEqual(was, will, `${setting.name} is the same in both Configs; the test cannot tell them apart`);
      assert.equal(now, setting.applies === 'now' ? will : was, setting.name);
    }
  });
});

describe('each part, changed while it runs', () => {
  it('logs at a level changed after the start, in every part already made', () => {
    const sink = new MemorySink();
    const log = createLogger({ level: 'info', sinks: [sink] });
    const child = log.child('player');
    child.debug('not yet');
    log.setLevel('debug');
    child.debug('now');
    log.setLevel('error');
    child.warn('no longer');
    assert.deepEqual(
      sink.records.map((record) => record.msg),
      ['now'],
    );
  });

  it('writes the console as JSON from the change on', () => {
    const lines: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const sink = new ConsoleSink('text');
      const record = {
        time: '2026-11-24T00:00:00.000Z',
        level: 'info' as const,
        component: 'x',
        msg: 'hello',
        fields: {},
      };
      sink.write(record);
      sink.setFormat('json');
      sink.write(record);
    } finally {
      process.stdout.write = write;
    }
    assert.match(lines[0] ?? '', /^2026-11-24T00:00:00.000Z info {2}x: hello\n$/);
    assert.deepEqual(JSON.parse(lines[1] ?? ''), {
      time: '2026-11-24T00:00:00.000Z',
      level: 'info',
      component: 'x',
      msg: 'hello',
      fields: {},
    });
  });

  it('rotates the log at a size changed after the start, and keeps fewer files at once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-log-'));
    try {
      const sink = new FileSink({ dir, maxBytes: 1024 * 1024, files: 5 });
      const record = { time: 't', level: 'info' as const, component: 'x', msg: 'y'.repeat(200), fields: {} };
      for (let index = 0; index < 4; index += 1) sink.write(record);
      // A smaller size: the next lines rotate; four files of history are made.
      sink.setLimits({ maxBytes: 300, files: 5 });
      for (let index = 0; index < 6; index += 1) sink.write(record);
      assert.deepEqual(fs.readdirSync(dir).sort(), [
        'jukecord.log',
        'jukecord.log.1',
        'jukecord.log.2',
        'jukecord.log.3',
        'jukecord.log.4',
      ]);
      // Fewer files kept: the oldest go at once.
      sink.setLimits({ maxBytes: 300, files: 2 });
      assert.deepEqual(fs.readdirSync(dir).sort(), ['jukecord.log', 'jukecord.log.1']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts down at a time changed after the start: a running countdown starts again, 0 stops them all', async () => {
    const clock = new FakeClock();
    const ran: string[] = [];
    const countdowns = new Countdowns(clock, 60_000, (key) => ran.push(key));
    countdowns.arm('a');
    await clock.advance(30_000);
    // Ten seconds now, from now: 'a' runs out ten seconds later, not at its old minute.
    countdowns.setMs(10_000);
    countdowns.rearm();
    await clock.advance(9_000);
    assert.deepEqual(ran, []);
    await clock.advance(2_000);
    assert.deepEqual(ran, ['a']);
    countdowns.arm('b');
    countdowns.disarmAll();
    await clock.advance(60_000);
    assert.deepEqual(ran, ['a']);
  });

  it('refuses a queue past a limit lowered after the start, and the lyrics once they are off', async () => {
    const clock = new FakeClock();
    const store = await memoryStore(() => clock.now());
    const bus = new Bus();
    const lanes = new GuildLanes();
    const queue = new QueueService(store.queue, bus, lanes);
    const log = createLogger({ level: 'error', sinks: [] });
    const players = new Players({
      lanes,
      queue,
      media: new FakeMedia(),
      history: store.history,
      state: store.playerState,
      bus,
      clock,
      log,
      fetchTimeoutMs: 60_000,
    });
    const tracks: Track[] = await inOrder([60_000, 60_000, 60_000], (durationMs, index) =>
      store.tracks.upsert({
        source: `https://example.com/${index}`,
        url: `https://example.com/${index}`,
        title: `T${index}`,
        uploader: null,
        durationMs,
        thumbnail: null,
      }),
    );
    const resolver = { resolve: async () => tracks.slice(0, 1) } as unknown as Resolver;
    const lyrics = { forTrack: async () => ({ trackId: 1, kind: 'none' as const, lines: [], text: null }) };
    const actions = new Actions({ lanes, store, queue, players, resolver, log, queueMax: 100, lyrics });
    const dj: ActionContext = {
      guildId: '100000000000000001',
      userId: '300000000000000001',
      mayControl: true,
      mayManage: false,
    };
    await actions.add(dj, 'a', 'end');
    await actions.add(dj, 'b', 'end');
    actions.setLimits({ queueMax: 10, trackMaxMs: 3_600_000 });
    // Ten is the least the setting takes: the queue is filled to it, and the next is refused.
    let refused: unknown = null;
    for (let tries = 0; tries < 20 && refused === null; tries += 1) {
      refused = await actions.add(dj, `c${tries}`, 'end').then(
        () => null,
        (error: unknown) => error,
      );
    }
    assert.match(String(refused), /the queue is full \(10 tracks\)/);
    assert.equal(await queue.size(dj.guildId), 10);
    // A shorter longest track refuses one that was fine.
    actions.setLimits({ queueMax: 1000, trackMaxMs: 30_000 });
    await assert.rejects(actions.add(dj, 'e', 'end'), /longer than the 1 minute limit|longer than the 0 minute limit/);
    // Lyrics off: refused, and the status says so.
    assert.equal(actions.status().lyrics, true);
    actions.setLyrics(null);
    assert.equal(actions.status().lyrics, false);
    await assert.rejects(actions.lyrics(dj), /lyrics are turned off here/);
    await store.close();
  });

  it('evicts down to a cache limit lowered after the start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-cache-'));
    try {
      const cache = new MediaCache({
        dir,
        maxBytes: 10 * 1024 * 1024,
        log: createLogger({ level: 'error', sinks: [] }),
      });
      cache.init();
      for (const name of ['a', 'b', 'c']) {
        const key = MediaCache.keyOf(`https://example.com/${name}`);
        // A finished file of one MiB, put in place as a fetch puts one (each temporary name is new).
        const tmp = cache.tmpPath(key);
        fs.writeFileSync(tmp, Buffer.alloc(1024 * 1024));
        cache.commit(key, tmp, { source: `https://example.com/${name}`, durationMs: 1000, loudness: null });
      }
      assert.equal(cache.count(), 3);
      cache.setMaxBytes(1024 * 1024 + 1);
      assert.equal(cache.count(), 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses links of a service turned off after the start', async () => {
    const links = new Links({
      fetch: async () => {
        throw new Error('no fetch in this test');
      },
      ytdlp: { search: async () => [] },
      tracks: {} as never,
      batch: {} as never,
      log: createLogger({ level: 'error', sinks: [] }),
      services: new Set(['deezer', 'spotify', 'apple-music']),
    });
    links.setServices(new Set(['spotify']));
    await assert.rejects(links.resolve('https://www.deezer.com/track/3135556'), /does not read Deezer links here/);
  });

  it('asks Spotify with an app set after the start, and refuses its albums again once it is gone', async () => {
    const asked: string[] = [];
    const links = new Links({
      // Every request recorded, none answered (nothing here reaches Spotify).
      fetch: async (address) => {
        asked.push(new URL(address).hostname);
        throw new Error('no network in this test');
      },
      ytdlp: { search: async () => [] },
      tracks: {} as never,
      batch: {} as never,
      log: createLogger({ level: 'error', sinks: [] }),
      services: new Set(['spotify']),
    });
    const album = 'https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo';
    await assert.rejects(links.resolve(album), /need the host’s Spotify app/);
    links.setSpotify({ clientId: 'abcdefabcdefabcdefabcdefabcdefab', clientSecret: 'made-up' });
    await assert.rejects(links.resolve(album), /accounts\.spotify\.com did not answer/);
    assert.deepEqual(asked, ['accounts.spotify.com']);
    links.setSpotify(null);
    await assert.rejects(links.resolve(album), /need the host’s Spotify app/);
  });

  it('lets a scraper in with a metrics token set after the start, and not with the old one', () => {
    const gate = new MetricsGate('old-token-0123456789');
    const asking = (token: string) => gate.verdict('203.0.113.9', { authorization: `Bearer ${token}` });
    assert.equal(asking('old-token-0123456789'), 'allowed');
    gate.setToken('new-token-0123456789');
    assert.equal(asking('old-token-0123456789'), 'wrong-token');
    assert.equal(asking('new-token-0123456789'), 'allowed');
    // None: the address rule alone (a public address is not let in).
    gate.setToken(null);
    assert.notEqual(asking('new-token-0123456789'), 'allowed');
  });
});
