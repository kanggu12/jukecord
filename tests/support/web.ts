/**
 * A whole jukecord web server for tests: a throwaway database, a fake Discord directory, a resolver that answers
 * from a table, fake media, and the real server, routes and logins on top.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Access } from '../../src/app/access.ts';
import {
  Actions,
  type Directory,
  type GuildInfo,
  type MemberInfo,
  type RoleInfo,
  type VoiceControl,
} from '../../src/app/actions.ts';
import { busPart, cachePart, databasePart, discordPart, Health, type HealthPart } from '../../src/app/health.ts';
import { SkipVotes } from '../../src/app/votes.ts';
import type { LoginChecks } from '../../src/auth/check.ts';
import { LdapLogin, type LdapOptions } from '../../src/auth/ldap.ts';
import { OidcLogin } from '../../src/auth/oidc.ts';
import type { LdapSettings, OidcSettings } from '../../src/auth/settings.ts';
import type { Cache } from '../../src/cache/cache.ts';
import { MemoryCache } from '../../src/cache/memory.ts';
import { loadConfig, type Supervisor } from '../../src/config.ts';
import { Bus } from '../../src/core/bus.ts';
import { GuildLanes } from '../../src/core/lanes.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { NewTrack } from '../../src/core/types.ts';
import { createLogger, MemorySink } from '../../src/log.ts';
import { BusyError } from '../../src/media/busy.ts';
import { MediaCache } from '../../src/media/cache.ts';
import { Covers, type Picture } from '../../src/media/covers.ts';
import type { LyricsSource } from '../../src/media/lyrics.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { type Search, searchWords } from '../../src/media/search.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import { describeService, discordMetrics, playerMetrics } from '../../src/metrics/service.ts';
import { SettingsFile } from '../../src/settings/file.ts';
import { ONE_PROCESS } from '../../src/settings/layers.ts';
import { DatabaseMove } from '../../src/settings/move.ts';
import { HostSettings, type HostSettingsOptions } from '../../src/settings/service.ts';
import type { Store } from '../../src/store/store.ts';
import { VERSION } from '../../src/version.ts';
import { Auth, type OAuthConfig } from '../../src/web/auth.ts';
import type { LiveLimits } from '../../src/web/events.ts';
import type { Rate } from '../../src/web/limits.ts';
import { Presenter } from '../../src/web/present.ts';
import { createWebServer, type WebServer, type WebServerOptions } from '../../src/web/server.ts';
import { FakeClock, FakeMedia } from './fakes.ts';
import { memoryStore } from './store.ts';

export const GUILD = '100000000000000001';
export const OTHER_GUILD = '100000000000000002';
export const ALICE = '300000000000000001';
export const BOB = '300000000000000002';
export const DJ_ROLE = '500000000000000001';
/** The one text channel the fake bot may post in. */
export const ALERTS_CHANNEL = '600000000000000001';
/** The host token of every test server. */
export const HOST_TOKEN = 'jkc_test-host-token-0123456789abcdef';

/** Discord as tests want it: two servers, a DJ role, and members set per test. */
export class FakeDirectory implements Directory {
  guildList: GuildInfo[] = [
    { id: GUILD, name: 'Example Server', icon: null },
    { id: OTHER_GUILD, name: 'Second Server', icon: null },
  ];
  readonly members = new Map<string, MemberInfo>();
  /** How many times members were asked about (to see the cache work). */
  asked = 0;
  /** When set, member questions fail as if Discord were down. */
  down = false;
  /** Cleared to act as if jukecord had just started and Discord had not sent the server list yet. */
  serversKnown = true;

  self() {
    return { id: '200000000000000001', name: 'jukecord', avatar: null };
  }

  loaded(): boolean {
    return this.serversKnown;
  }

  guilds(): GuildInfo[] {
    return this.guildList;
  }

  roles(guildId: string): RoleInfo[] {
    return guildId === GUILD ? [{ id: DJ_ROLE, name: 'DJ', color: 0x3d7be0 }] : [];
  }

  // The text channels the bot may post in: one in the first server.
  textChannels(guildId: string) {
    return guildId === GUILD ? [{ id: ALERTS_CHANNEL, name: 'jukecord-alerts' }] : [];
  }

  async member(guildId: string, userId: string): Promise<MemberInfo | null> {
    this.asked += 1;
    if (this.down) throw new Error('Discord is down');
    return this.members.get(`${guildId}:${userId}`) ?? null;
  }

  /** Makes someone a member of a server. */
  join(guildId: string, userId: string, member: Partial<MemberInfo> = {}): void {
    this.members.set(`${guildId}:${userId}`, { roles: [], manage: false, ...member });
  }
}

/** Voice as tests want it: joining always works and is remembered. */
export class FakeVoice implements VoiceControl {
  readonly current = new Map<string, { channelId: string; name: string }>();
  async join(guildId: string, channelId: string | null) {
    const joined = { channelId: channelId ?? '400000000000000001', name: 'Lounge' };
    this.current.set(guildId, joined);
    return joined;
  }
  leave(guildId: string): boolean {
    return this.current.delete(guildId);
  }
  channel(guildId: string) {
    return this.current.get(guildId) ?? null;
  }
  channels() {
    return [{ id: '400000000000000001', name: 'Lounge', people: 1 }];
  }
  /** The servers whose stay setting changed, in order. */
  readonly stayed: string[] = [];
  stayChanged(guildId: string): void {
    this.stayed.push(guildId);
  }
  /** Who is in the bot's voice channel, by server (tests set it). */
  readonly inVoice = new Map<string, string[]>();
  people(guildId: string): string[] {
    return this.inVoice.get(guildId) ?? [];
  }
}

export interface TestServer {
  /** The host's settings, when asked for (see TestServerOptions.hostSettings). */
  readonly settings: HostSettings | null;
  /** The names each change of them applied at once, in order. */
  readonly applied: string[][];
  readonly web: WebServer;
  readonly store: Store;
  readonly bus: Bus;
  readonly clock: FakeClock;
  readonly media: FakeMedia;
  readonly directory: FakeDirectory;
  readonly auth: Auth;
  readonly actions: Actions;
  readonly players: Players;
  readonly queue: QueueService;
  /** The servers' lanes, which the actions, the players and the queue share. */
  readonly lanes: GuildLanes;
  readonly cache: MediaCache;
  readonly covers: Covers;
  /** Every number the server reports at /metrics, composed as main.ts composes it. */
  readonly metrics: MetricsRegistry;
  /** The pictures asked of the made-up image hosts, by address, in order. */
  readonly pictureRequests: string[];
  readonly logs: MemorySink;
  readonly dataDir: string;
  /** The base address once listening (`listen: true`); empty otherwise. */
  readonly url: string;
  close(): Promise<void>;
  /** The voice side the actions were given (unused in browser-only mode). */
  readonly voice: FakeVoice;
}

export interface TestServerOptions {
  /** Without Discord: browser-only mode. */
  readonly browserOnly?: boolean;
  /** Discord login with a fake Discord API. */
  readonly oauth?: OAuthConfig;
  readonly fetch?: typeof fetch;
  /** Listen on a real port (for WebSocket and CLI tests); app.inject is enough otherwise. */
  readonly listen?: boolean;
  /** The panel directory to serve. */
  readonly panelDir?: string | null;
  /** What the resolver finds for each input. */
  readonly found?: Record<string, NewTrack[]>;
  /** What the made-up image hosts answer for each picture's address (an Error: that picture cannot be had). */
  readonly pictures?: Record<string, Picture | Error>;
  /** Inputs the resolver looks up and finds nothing for ("nothing was found", as yt-dlp's search says). */
  readonly nothingFound?: readonly string[];
  /** Inputs met while every lookup slot is taken (the resolver's BusyError). */
  readonly busy?: readonly string[];
  /** The caps on live connections (lower than the defaults to test them). */
  readonly live?: Partial<LiveLimits>;
  /** The rates of changes and their clock, and whether jukecord counts as behind (to test the limits). */
  readonly rates?: {
    readonly changes?: Rate;
    readonly fetches?: Rate;
    readonly searches?: Rate;
    readonly now?: () => number;
    readonly covers?: Rate;
  };
  readonly behind?: () => boolean;
  readonly trustProxy?: boolean;
  /** Shorter request and idle timeouts and lower connection caps (to test them): the server's own option, as it is. */
  readonly timeouts?: WebServerOptions['timeouts'];
  /** How the MP3 copy for browsers without Opus is made (by default there is never one). */
  readonly mp3?: WebServerOptions['mp3'];
  /** Where lyrics come from (a stand-in for LRCLIB); without it, lyrics are off as with JUKECORD_LYRICS=off. */
  readonly lyrics?: LyricsSource;
  /** What a search finds for some words (anything else finds nothing). */
  readonly searched?: Record<string, NewTrack[]>;
  /** The token that lets a scraper read /metrics from anywhere (JUKECORD_METRICS_TOKEN). */
  readonly metricsToken?: string;
  /** More parts for /readyz to check, beside the database, the bus, the cache and Discord. */
  readonly parts?: readonly HealthPart[];
  /** Logging in through an identity provider: its settings, and the fetch its made-up provider answers. */
  readonly oidc?: { readonly settings: OidcSettings; readonly fetch: typeof fetch };
  /** Logging in with a directory account: its settings, and a directory that stands in for one. */
  readonly ldap?: { readonly settings: LdapSettings; readonly connect: LdapOptions['connect'] };
  /** The login settings' tests (none by default). */
  readonly loginChecks?: LoginChecks;
  /**
   * The host's settings (src/settings) over the test's database and data folder, started from this environment, with
   * what restarts it (none by default) and a restart of its own; absent: the settings operations are refused.
   */
  readonly hostSettings?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly supervisor?: Supervisor;
    readonly restart?: HostSettingsOptions['restart'];
    /** Discord's API for the Discord login's test: a fake one (tests never reach Discord). */
    readonly discord?: HostSettingsOptions['discord'];
  };
  /** Where the logins keep what is short-lived (links, failed logins, SSO states); a memory cache of its own by default. */
  readonly loginCache?: Cache;
  /**
   * Every way in set up: a provider and a directory (made up, which nobody logs in through unless a test gives its
   * own), and Discord login. A member's login, and an SSO login linked to a Discord user, are let in only through ways
   * that are set up.
   */
  readonly logins?: boolean;
}

/** Example tracks: example.com addresses only, so tests never point at real pages. */
export function exampleTrack(name: string, durationMs = 180_000): NewTrack {
  return {
    source: `https://example.com/watch?v=${name}`,
    url: `https://example.com/watch?v=${name}`,
    title: `Track ${name}`,
    uploader: 'Example',
    durationMs,
    thumbnail: null,
  };
}

/** A provider set up for tests of the logins it lets in (`logins`); nobody logs in through it. */
export const TEST_OIDC: OidcSettings = {
  issuer: 'https://sso.example.test/realms/home',
  clientId: 'jukecord',
  clientSecret: 'made-up-client-secret',
  scopes: ['openid'],
  groupsClaim: 'groups',
  groups: { admin: [], control: [], read: ['*'] },
  label: null,
  discordClaim: null,
};

/** A directory set up for tests of the logins it lets in (`logins`); nobody logs in through it. */
export const TEST_LDAP: LdapSettings = {
  url: 'ldap://ldap.example.test',
  startTls: false,
  ca: null,
  bindDn: null,
  bindPassword: null,
  baseDn: 'dc=example,dc=org',
  userFilter: '(uid={username})',
  groupFilter: null,
  groupBaseDn: null,
  nestedGroups: false,
  groups: { admin: [], control: [], read: ['*'] },
  timeoutMs: 1000,
  label: null,
};

/** Discord login set up for tests (`logins`): its addresses are made up, and nothing is sent to them. */
export const TEST_OAUTH: OAuthConfig = {
  clientId: '108876543210987654',
  clientSecret: 'made-up-oauth-secret',
  redirectUri: 'http://localhost:8795/auth/callback',
  api: 'https://discord.test/api',
  authorize: 'https://discord.test/oauth2/authorize',
};

// A fetch that reaches nobody: the made-up provider is never asked.
const NOWHERE = (async () => new Response('nobody here', { status: 503 })) as typeof fetch;

/** Starts a test server. */
export async function testServer(options: TestServerOptions = {}): Promise<TestServer> {
  const clock = new FakeClock();
  const store = await memoryStore(() => clock.now());
  const bus = new Bus();
  // One lane per server, shared by everything that changes one, as in main.ts.
  const lanes = new GuildLanes();
  const queue = new QueueService(store.queue, bus, lanes);
  const media = new FakeMedia();
  const logs = new MemorySink();
  const log = createLogger({ level: 'debug', sinks: [logs] });
  const players = new Players({
    queue,
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log,
    lanes,
    fetchTimeoutMs: 60_000,
  });
  const found = options.found ?? {};
  // The resolver looks inputs up in the table; anything else finds nothing.
  const resolver = {
    resolve: async (input: string) => {
      // Looked up on the site, which found nothing: a lookup that cost what any lookup costs.
      if (options.nothingFound?.includes(input)) throw new Error('nothing was found');
      // Every lookup slot taken: nothing looked up, for a moment.
      if (options.busy?.includes(input))
        throw new BusyError('jukecord is looking up other tracks right now; try again in a moment');
      const tracks = found[input];
      if (!tracks) throw new Error(`nothing to add for "${input}"`);
      // Stored one after the other, as the resolver stores what it found.
      const stored = [];
      for (const track of tracks) stored.push(await store.tracks.upsert(track));
      return stored;
    },
  } as unknown as Resolver;
  // The search answers from its table, as many as asked for, and remembers what it showed by the canonical address, as
  // the real one does for picking a result and showing its picture (Search.recent).
  const searched = options.searched ?? {};
  const shown = new Map<string, NewTrack>();
  const search = {
    find: async (words: string, ask: { limit?: number } = {}) => {
      const tracks = (searched[searchWords(words)] ?? []).slice(0, ask.limit ?? 8);
      for (const track of tracks) shown.set(track.source, track);
      return tracks;
    },
    cached: () => null,
    recent: (source: string) => shown.get(source) ?? null,
  } as unknown as Search;
  const directory = new FakeDirectory();
  const voice = new FakeVoice();
  // The votes to skip, counting the fake voice channel and the browsers of the real live updates (once they exist).
  let browsers: (guildId: string) => readonly string[] = () => [];
  const votes = new SkipVotes({
    players,
    bus,
    clock,
    log,
    lanes,
    applies: (guildId) => actions.voteSkipApplies(guildId),
    listening: (guildId) => new Set([...voice.people(guildId), ...browsers(guildId)]),
  });
  const actions = new Actions({
    store,
    queue,
    players,
    lanes,
    resolver,
    log,
    startedAt: clock.now(),
    lyrics: options.lyrics ?? null,
    votes,
    bus,
    search,
  });
  if (!options.browserOnly) actions.setVoice(voice, () => true, directory);
  const access = new Access({ settings: store.settings, directory: () => (options.browserOnly ? null : directory) });
  const loginCache = options.loginCache ?? new MemoryCache();
  // The ways in a test gives, or with `logins` made-up ones that answer nobody.
  const oidcWay = options.oidc ?? (options.logins ? { settings: TEST_OIDC, fetch: NOWHERE } : null);
  const ldapWay = options.ldap ?? (options.logins ? { settings: TEST_LDAP, connect: undefined } : null);
  // Through the made-up provider, coming back to the address the test server says it has.
  const oidc = oidcWay
    ? new OidcLogin({
        settings: oidcWay.settings,
        redirectUri: 'http://localhost:8795/auth/sso/callback',
        afterLogout: 'http://localhost:8795/login',
        cache: loginCache,
        log,
        fetch: oidcWay.fetch,
      })
    : null;
  const ldap = ldapWay
    ? new LdapLogin({
        settings: ldapWay.settings,
        log,
        ...(ldapWay.connect ? { connect: ldapWay.connect } : {}),
      })
    : null;
  const auth = new Auth({
    store,
    hostToken: HOST_TOKEN,
    secureCookies: false,
    oauth: options.oauth ?? (options.logins ? TEST_OAUTH : null),
    // The login links and failed logins in memory, as one jukecord keeps them (each test server its own).
    cache: loginCache,
    oidc,
    ldap,
    log,
    // Real time for logins: the session repository uses the store's clock, which the tests keep fixed.
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-web-'));
  // The metrics as main.ts composes them, from the parts a test server has (no event loop watch, no media tools).
  const metrics = new MetricsRegistry();
  describeService(metrics, {
    version: VERSION,
    role: 'all',
    database: store.sql.dialect,
    bus: 'in-process',
    cache: 'memory',
  });
  playerMetrics(metrics, { players, queue });
  discordMetrics(metrics, {
    connected: () => !options.browserOnly,
    gateway: () => (options.browserOnly ? null : { state: 'ready', pingMs: 42 }),
    guilds: () => (options.browserOnly ? 0 : directory.guildList.length),
    voice: () => new Map(options.browserOnly ? [] : [['ready', voice.current.size]]),
  });
  const cache = new MediaCache({ dir: path.join(dataDir, 'cache'), maxBytes: 1024 ** 3, log, metrics });
  // Readiness as main.ts makes it, the media programs aside (a test server runs none); a test may add parts.
  const sharedCache = new MemoryCache();
  const health = new Health({
    parts: [
      databasePart(store),
      busPart('in-process'),
      cachePart(sharedCache),
      ...(options.browserOnly ? [] : [discordPart(() => ({ state: 'ready' as const }))]),
      ...(options.parts ?? []),
    ],
    discord: () => !options.browserOnly,
    metrics,
  });
  cache.init();
  // Covers come from a table instead of the internet; every picture asked for is noted.
  const pictureRequests: string[] = [];
  const covers = new Covers({
    cache,
    log,
    fetch: async (address) => {
      pictureRequests.push(address);
      const picture = options.pictures?.[address];
      if (!picture) throw new Error('no such picture');
      if (picture instanceof Error) throw picture;
      return picture;
    },
  });
  // The host's settings, as main.ts makes them, over this test's database and data folder.
  const applied: string[][] = [];
  let settings: HostSettings | null = null;
  if (options.hostSettings) {
    const env = { JUKECORD_DATA_DIR: dataDir, ...(options.hostSettings.env ?? {}) };
    const started = loadConfig(env, '/srv');
    settings = new HostSettings({
      env,
      cwd: '/srv',
      store,
      file: new SettingsFile(dataDir),
      rules: ONE_PROCESS,
      started,
      supervisor: options.hostSettings.supervisor ?? 'none',
      log: log.child('settings'),
      apply: (names) => void applied.push([...names]),
      ...(options.hostSettings.restart ? { restart: options.hostSettings.restart } : {}),
      // Never Discord itself: without a fake of the test's, a test of the Discord login meets a closed port.
      discord: options.hostSettings.discord ?? { api: 'http://127.0.0.1:9/api/v10' },
      move: new DatabaseMove({ dataDir, current: started.database.address, pool: 2 }),
    });
  }
  const web = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://localhost:8795',
    trustProxy: options.trustProxy ?? false,
    panelDir: options.panelDir ?? null,
    bus,
    players,
    queue,
    cache,
    mp3: options.mp3 ?? (async () => null),
    covers,
    log,
    ...(options.live ? { live: options.live } : {}),
    ...(options.rates ? { rates: options.rates } : {}),
    // Never behind unless a test says so: a busy test machine must not make changes fail at random.
    behind: options.behind ?? (() => false),
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    health,
    metrics,
    ...(options.metricsToken ? { metricsToken: options.metricsToken } : {}),
    deps: {
      actions,
      access,
      auth,
      store,
      presenter: new Presenter(store.users),
      directory: () => (options.browserOnly ? null : directory),
      publicUrl: 'http://localhost:8795',
      logDir: path.join(dataDir, 'logs'),
      logFiles: 5,
      backupDir: path.join(dataDir, 'backups'),
      discordMode: !options.browserOnly,
      loginSettings: { oidc: options.oidc?.settings ?? null, ldap: options.ldap?.settings ?? null },
      loginChecks: options.loginChecks ?? null,
      doctor: async () => ({ ok: true, checks: [{ name: 'test', status: 'ok', detail: 'fine' }], settings: {} }),
      ...(settings ? { settings } : {}),
    },
  });
  // As main.ts does: a revoked listening link ends its guests' live connections.
  actions.setEndGuests((linkId) =>
    web.hub.end(
      (caller) => caller.principal.kind === 'guest' && caller.principal.linkId === linkId,
      'the listening link has ended',
    ),
  );
  browsers = (guildId) => web.hub.listeningPeople(guildId);
  let url = '';
  if (options.listen) url = await web.listen();
  return {
    settings,
    applied,
    web,
    store,
    bus,
    clock,
    media,
    directory,
    auth,
    actions,
    players,
    queue,
    lanes,
    cache,
    covers,
    metrics,
    pictureRequests,
    logs,
    dataDir,
    url,
    close: async () => {
      await web.close();
      await sharedCache.close();
      await loginCache.close();
      await store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
    voice,
  };
}

/** The Authorization header of the host token. */
export const asHost = { authorization: `Bearer ${HOST_TOKEN}` };

/** Logs a Discord user in (as the OAuth callback would) and returns the headers a panel would send for changes. */
export async function sessionFor(server: TestServer, userId: string | null): Promise<{ cookie: string; csrf: string }> {
  const setCookie = await server.auth.startSession(userId === null ? { kind: 'host' } : { kind: 'user', userId });
  const cookie = setCookie.split(';')[0] ?? '';
  const caller = await server.auth.identify({ cookie });
  if (!caller?.csrf) throw new Error('the session just made does not log in');
  return { cookie, csrf: caller.csrf };
}
