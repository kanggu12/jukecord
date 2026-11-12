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
import { SkipVotes } from '../../src/app/votes.ts';
import { Bus } from '../../src/core/bus.ts';
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
import type { Store } from '../../src/store/store.ts';
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
  readonly cache: MediaCache;
  readonly covers: Covers;
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

/** Starts a test server. */
export async function testServer(options: TestServerOptions = {}): Promise<TestServer> {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
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
      return tracks.map((track) => store.tracks.upsert(track));
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
    applies: (guildId) => actions.voteSkipApplies(guildId),
    listening: (guildId) => new Set([...voice.people(guildId), ...browsers(guildId)]),
  });
  const actions = new Actions({
    store,
    queue,
    players,
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
  const auth = new Auth({
    store,
    hostToken: HOST_TOKEN,
    secureCookies: false,
    oauth: options.oauth ?? null,
    log,
    // Real time for logins: the session repository uses the store's clock, which the tests keep fixed.
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-web-'));
  const cache = new MediaCache({ dir: path.join(dataDir, 'cache'), maxBytes: 1024 ** 3, log });
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
    ready: () => true,
    discordReady: () => !options.browserOnly,
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
      doctor: async () => ({ ok: true, checks: [{ name: 'test', status: 'ok', detail: 'fine' }], settings: {} }),
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
    cache,
    covers,
    pictureRequests,
    logs,
    dataDir,
    url,
    close: async () => {
      await web.close();
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
    voice,
  };
}

/** The Authorization header of the host token. */
export const asHost = { authorization: `Bearer ${HOST_TOKEN}` };

/** Logs a Discord user in (as the OAuth callback would) and returns the headers a panel would send for changes. */
export function sessionFor(server: TestServer, userId: string | null): { cookie: string; csrf: string } {
  const setCookie = server.auth.startSession(userId === null ? { kind: 'host' } : { kind: 'user', userId });
  const cookie = setCookie.split(';')[0] ?? '';
  const caller = server.auth.identify({ cookie });
  if (!caller?.csrf) throw new Error('the session just made does not log in');
  return { cookie, csrf: caller.csrf };
}
