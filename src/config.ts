/**
 * jukecord's settings, read from environment variables (JUKECORD_*), checked all at once.
 *
 * Every problem is collected before anything starts, so a person fixing their .env sees the whole list in one run
 * instead of one error per restart. Secrets are kept out of anything this module prints.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AUTH_VARIABLES, type AuthSettings, describeAuth, readAuthSettings } from './auth/settings.ts';
import { type Authorities, describeAuthorities, readAuthorities } from './authorities.ts';
import { LINK_SERVICES, type LinkService } from './media/links.ts';
import { type DatabaseAddress, defaultSqliteFile, describeAddress, parseDatabaseAddress } from './store/address.ts';
import { parseDuration, parseSize, UnitError } from './util/units.ts';

/** How much the logger writes; each level includes the ones after it. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** How the console's lines are written: readable text, or one JSON object per line (for a log shipper). */
export type LogFormat = 'text' | 'json';

/**
 * Which part of jukecord a process is (JUKECORD_ROLE): all of it (one process, the default), the core (Discord, the
 * players, the media; exactly one) or an edge (the panel, the API, the live updates, logins; any number of them).
 */
export type Role = 'all' | 'core' | 'edge';

/** The roles, for checking the setting and for messages. */
export const ROLES: readonly Role[] = ['all', 'core', 'edge'];

/** The core's port for its edges unless JUKECORD_INTERNAL_PORT says otherwise. */
export const DEFAULT_INTERNAL_PORT = 8796;

/** The settings the rest of jukecord reads. Built once by loadConfig and not changed afterwards. */
export interface Config {
  /** Where the database, the media cache and the logs live (an absolute path). */
  readonly dataDir: string;
  readonly database: {
    /**
     * Where the database is (JUKECORD_DATABASE_URL): the data folder's SQLite file by default, or another file, or a
     * PostgreSQL or MySQL/MariaDB server's database.
     */
    readonly address: DatabaseAddress;
    /** How many connections to a database server at most (JUKECORD_DATABASE_POOL); SQLite has its one. */
    readonly pool: number;
  };
  /** The address the panel and the API listen on. */
  readonly host: string;
  /** The port the panel and the API listen on. */
  readonly port: number;
  /**
   * The port people reach it on from this machine when that differs from `port` (compose publishes 8795 inside the
   * container on JUKECORD_PORT outside); links and the Discord login use it when there is no public address.
   */
  readonly publishedPort: number;
  /** The address people reach the panel at, when it is not this machine (used for login and links). */
  readonly publicUrl: string | null;
  /** Whether to believe X-Forwarded-* headers: false, true (any proxy), a hop count, or the proxies' addresses. */
  readonly trustProxy: boolean | number | string;
  readonly discord: {
    /** The bot's token; without it jukecord runs browser-only (the panel plays, nothing joins voice). */
    readonly token: string | null;
    /** The application's ID, for logging in with Discord. */
    readonly clientId: string | null;
    /** The application's OAuth2 secret, needed for logging in with Discord. */
    readonly clientSecret: string | null;
  };
  readonly media: {
    /** The yt-dlp program jukecord runs. */
    readonly ytdlp: string;
    /** The ffmpeg program jukecord runs. */
    readonly ffmpeg: string;
    /** The most the media cache may hold, in bytes. */
    readonly cacheMaxBytes: number;
    /** How long getting one track may take before it is given up on, in milliseconds. */
    readonly fetchTimeoutMs: number;
    /** How many of the next tracks are fetched ahead of time. */
    readonly prefetch: number;
    /** The longest track that may be added, in milliseconds (a ten-hour mix would fill the cache). */
    readonly trackMaxMs: number;
    /** A cookies file yt-dlp uses for YouTube's sign-in check, or null. */
    readonly cookies: string | null;
    /** Whether addresses on private networks may be fetched (media servers on the local network). */
    readonly allowPrivate: boolean;
  };
  /** The most tracks one server's queue may hold. */
  readonly queueMax: number;
  /** The most live connections (open panels and other WebSocket clients) at once, across every server. */
  readonly liveMax: number;
  readonly voice: {
    /** How long the bot stays alone in a voice channel before it leaves (0: it does not leave by itself). */
    readonly idleMs: number;
  };
  /** How long a playing server nobody hears anywhere plays on before it pauses (0: it never does; see app/rest.ts). */
  readonly restAfterMs: number;
  readonly backups: {
    /** The time of day of the daily backup, in the time zone jukecord runs in; null for none (app/backups.ts). */
    readonly at: { readonly hour: number; readonly minute: number } | null;
    /** How many backups stay in the backups folder. */
    readonly keep: number;
  };
  /** Whether lyrics are looked up (at LRCLIB) for the track playing when someone asks for them. */
  readonly lyrics: boolean;
  readonly log: {
    readonly level: LogLevel;
    /** text (readable lines) or json (one object per line, the log file's own form) on the console. */
    readonly format: LogFormat;
    /** The size at which the log file is rotated, in bytes. */
    readonly maxBytes: number;
    /** How many log files are kept, the current one included. */
    readonly files: number;
  };
  /** Settings that were read but look wrong without being fatal (an unknown JUKECORD_ variable, mostly typos). */
  readonly warnings: readonly string[];
  /**
   * The host's own certificate authorities (JUKECORD_CA_FILE), which every TLS connection trusts besides Node's own
   * once the start has added them (src/authorities.ts); null when none are set.
   */
  readonly ca: Authorities | null;
  readonly metrics: {
    /**
     * The token a scraper shows (Authorization: Bearer) to read /metrics from outside the private network or through
     * a proxy; null: only a scraper on this machine or its network, asking directly.
     */
    readonly token: string | null;
  };
  /** Which part of jukecord this process is (JUKECORD_ROLE); `all` unless split into services. */
  readonly role: Role;
  /** How the services of a split jukecord talk: a Redis or Valkey server, and the prefix of what jukecord puts there. */
  readonly bus: {
    /** The server's address (JUKECORD_BUS_URL); null in one process, which carries its events in memory. */
    readonly url: string | null;
    /** What every key and channel goes under (JUKECORD_KEY_PREFIX), so several jukecords can share one server. */
    readonly prefix: string;
  };
  /**
   * The shared cache (JUKECORD_CACHE_URL): "memory", or a Redis or Valkey address. One process keeps it in memory unless
   * told otherwise; the services of a split jukecord use the bus's server unless told otherwise.
   */
  readonly cacheUrl: string;
  /** How edges reach the core in a split jukecord. */
  readonly internal: {
    /** The core's port for its edges (JUKECORD_INTERNAL_PORT): the audio and the covers, for edges only. */
    readonly port: number;
    /** The secret the core and its edges share (JUKECORD_INTERNAL_SECRET); null in one process. */
    readonly secret: string | null;
    /** Where an edge reaches that port (JUKECORD_CORE_URL, http://core:8796); null for anything but an edge. */
    readonly coreUrl: string | null;
  };
  /** Links of other music services jukecord reads (and finds on YouTube). */
  readonly links: {
    /** The services read (JUKECORD_LINK_SERVICES); a link of another is refused. */
    readonly services: ReadonlySet<LinkService>;
    /** The host's own Spotify app, for Spotify albums and playlists; null without one. */
    readonly spotify: { readonly clientId: string; readonly clientSecret: string } | null;
  };
  /** Logging in through the host's identity provider (OIDC) and directory (LDAP, Active Directory); each null when off. */
  readonly auth: AuthSettings;
}

/** Settings that cannot be used; `problems` lists every one, each naming the variable. */
export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    // The message is the list itself, one problem per line, so a log line shows all of them.
    super(`jukecord cannot start with these settings:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

/** The default port: chosen not to clash with the other services that run on the same machines (8777-8798 taken). */
export const DEFAULT_PORT = 8795;

// Every variable jukecord reads. Anything else that starts with JUKECORD_ is reported as a probable typo.
const KNOWN = new Set([
  'JUKECORD_DATA_DIR',
  'JUKECORD_DATABASE_URL',
  'JUKECORD_DATABASE_URL_FILE',
  'JUKECORD_DATABASE_POOL',
  'JUKECORD_HOST',
  'JUKECORD_PORT',
  'JUKECORD_PUBLIC_URL',
  'JUKECORD_DISCORD_TOKEN',
  'JUKECORD_DISCORD_CLIENT_ID',
  'JUKECORD_DISCORD_CLIENT_SECRET',
  'JUKECORD_YTDLP',
  'JUKECORD_FFMPEG',
  'JUKECORD_CACHE_MAX',
  'JUKECORD_FETCH_TIMEOUT',
  'JUKECORD_PREFETCH',
  'JUKECORD_LOG_LEVEL',
  'JUKECORD_LOG_FORMAT',
  'JUKECORD_LOG_MAX',
  'JUKECORD_LOG_FILES',
  'JUKECORD_DISCORD_TOKEN_FILE',
  'JUKECORD_DISCORD_CLIENT_SECRET_FILE',
  'JUKECORD_TRACK_MAX',
  'JUKECORD_YTDLP_COOKIES',
  'JUKECORD_QUEUE_MAX',
  'JUKECORD_LIVE_MAX',
  'JUKECORD_VOICE_IDLE',
  'JUKECORD_TRUST_PROXY',
  'JUKECORD_ALLOW_PRIVATE_ADDRESSES',
  'JUKECORD_REST_AFTER',
  'JUKECORD_BACKUP_AT',
  'JUKECORD_BACKUP_KEEP',
  'JUKECORD_LYRICS',
  // Read by compose.yaml (the published address and the image), not by jukecord; known so they raise no warning
  // when .env passes them through.
  'JUKECORD_BIND',
  'JUKECORD_IMAGE',
  // Set by compose.yaml from JUKECORD_PORT: the port outside the container.
  'JUKECORD_PUBLISHED_PORT',
  'JUKECORD_LINK_SERVICES',
  'JUKECORD_SPOTIFY_CLIENT_ID',
  'JUKECORD_SPOTIFY_CLIENT_SECRET',
  'JUKECORD_SPOTIFY_CLIENT_SECRET_FILE',
  // The host's own certificate authorities, trusted by every TLS connection (src/authorities.ts).
  'JUKECORD_CA_FILE',
  'JUKECORD_METRICS_TOKEN',
  'JUKECORD_METRICS_TOKEN_FILE',
  // Logging in through OIDC and LDAP (src/auth/settings.ts reads them).
  ...AUTH_VARIABLES,
  // Services: the role, the bus and the shared cache (a Redis or Valkey server), and the core's port for edges.
  'JUKECORD_ROLE',
  'JUKECORD_BUS_URL',
  'JUKECORD_BUS_URL_FILE',
  'JUKECORD_CACHE_URL',
  'JUKECORD_CACHE_URL_FILE',
  'JUKECORD_KEY_PREFIX',
  'JUKECORD_INTERNAL_PORT',
  'JUKECORD_INTERNAL_SECRET',
  'JUKECORD_INTERNAL_SECRET_FILE',
  'JUKECORD_CORE_URL',
]);

// A Redis or Valkey server's address, as the bus and the cache take it (TLS with the s).
const REDIS_SCHEMES = ['redis:', 'rediss:', 'valkey:', 'valkeys:'];
// The shortest internal secret taken: as long as the 32 random bytes jukecord's own secrets are, in hex.
const SECRET_MIN = 32;

/** File access loadConfig needs, passed in so tests can give it files without touching the disk. */
export interface ConfigFiles {
  read(file: string): string;
  readable(file: string): boolean;
}

/** The files on this machine, as loadConfig reads them by default (the login settings' test reads them so too). */
export const diskFiles: ConfigFiles = {
  read: (file) => fs.readFileSync(file, 'utf8'),
  readable: (file) => {
    try {
      fs.accessSync(file, fs.constants.R_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
};

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Reads and checks the settings.
 *
 * `env` is passed in (not read from process.env here) so tests can give exact environments; `cwd` anchors a
 * relative data directory, which is how a checkout run by hand keeps its data in ./data.
 */
export function loadConfig(env: NodeJS.ProcessEnv, cwd: string, files: ConfigFiles = diskFiles): Config {
  // Problems are gathered instead of thrown one by one (see the module comment).
  const problems: string[] = [];
  const warnings: string[] = [];

  // A value counts as unset when it is missing or only spaces: compose writes `VAR=` for an empty setting.
  const get = (name: string): string | null => {
    const value = env[name]?.trim();
    return value ? value : null;
  };

  // Runs one parser and turns its error into a problem that names the variable, returning the fallback meanwhile
  // so the rest of the checks still run.
  const read = <T>(name: string, fallback: T, parse: (text: string) => T): T => {
    const text = get(name);
    if (text === null) return fallback;
    try {
      return parse(text);
    } catch (error) {
      // UnitError messages already quote the value; anything else gets the raw message.
      const message = error instanceof UnitError || error instanceof Error ? error.message : String(error);
      problems.push(`${name}: ${message}`);
      return fallback;
    }
  };

  // Whole numbers inside a range; used for the port and the small counts.
  const integer =
    (min: number, max: number) =>
    (text: string): number => {
      // Only plain digits: "8795abc" or "1e4" are typos, not numbers.
      if (!/^\d+$/.test(text)) throw new Error(`"${text}" is not a whole number`);
      const value = Number(text);
      if (value < min || value > max) throw new Error(`${value} is outside ${min}-${max}`);
      return value;
    };

  // The data directory: relative paths are taken from the working directory, so `./data` works in a checkout.
  const dataDir = path.resolve(cwd, get('JUKECORD_DATA_DIR') ?? 'data');

  // 127.0.0.1 unless told otherwise: on a PC the panel should not be open to the network by surprise. The
  // container image sets 0.0.0.0, and compose publishes the port on 127.0.0.1 only.
  const host = get('JUKECORD_HOST') ?? '127.0.0.1';
  const port = read('JUKECORD_PORT', DEFAULT_PORT, integer(1, 65535));
  const publishedPort = read('JUKECORD_PUBLISHED_PORT', port, integer(1, 65535));

  // The public address must be a full http(s) URL; login redirects are built from it, so a bare host name would
  // produce redirects Discord refuses.
  const publicUrl = read('JUKECORD_PUBLIC_URL', null as string | null, (text) => {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`"${text}" is not a URL (example: https://music.example.com)`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`"${text}" must start with http(s)://`);
    // Kept without a trailing slash so paths can be appended as `${publicUrl}/auth/callback`.
    return url.href.replace(/\/+$/, '');
  });

  // Behind a reverse proxy or an Ingress the client's address and https come in X-Forwarded-* headers, which are
  // believed only when this says so: otherwise anyone could claim any address and dodge the login limiter.
  const trustProxy = read('JUKECORD_TRUST_PROXY', false as boolean | number | string, (text) => {
    const value = text.toLowerCase();
    if (value === 'true' || value === 'yes') return true;
    if (value === 'false' || value === 'no') return false;
    if (/^\d+$/.test(value)) return integer(1, 10)(value);
    // Otherwise a list of addresses or ranges, which proxy-addr checks; refuse anything with characters it cannot be.
    if (!/^[0-9a-f.:/,\s]+$/i.test(value)) throw new Error(`"${text}" is not true, false, a hop count or addresses`);
    return text.replace(/\s+/g, '');
  });

  // A secret comes either from the variable or from a file named by <VARIABLE>_FILE, the way Docker and Kubernetes
  // secrets are mounted; giving both is ambiguous, so it is refused.
  const secret = (name: string): string | null => {
    const value = get(name);
    const file = get(`${name}_FILE`);
    if (file === null) return value;
    if (value !== null) {
      problems.push(`set ${name} or ${name}_FILE, not both`);
      return value;
    }
    const full = path.resolve(cwd, file);
    if (!files.readable(full)) {
      problems.push(`${name}_FILE: ${full} cannot be read`);
      return null;
    }
    // Files written by editors end with a newline; a token never contains spaces.
    const content = files.read(full).trim();
    if (content === '') problems.push(`${name}_FILE: ${full} is empty`);
    return content || null;
  };

  // The database: the data folder's SQLite file unless JUKECORD_DATABASE_URL names another, or a server (its address
  // read from a file by JUKECORD_DATABASE_URL_FILE too, as the other secrets: a server's address holds a password).
  // The address is checked here; whether the server answers is found out when jukecord starts.
  let address: DatabaseAddress = { kind: 'sqlite', file: defaultSqliteFile(dataDir) };
  const databaseUrl = secret('JUKECORD_DATABASE_URL');
  // Whether a problem with the address was said already (its file unread, or the address wrong), for the roles' check.
  let databaseSaid = databaseUrl === null && get('JUKECORD_DATABASE_URL_FILE') !== null;
  if (databaseUrl !== null) {
    try {
      address = parseDatabaseAddress(databaseUrl, dataDir);
    } catch (error) {
      // The reason alone, which never quotes the address (it may hold the password).
      problems.push(`JUKECORD_DATABASE_URL ${error instanceof Error ? error.message : String(error)}`);
      databaseSaid = true;
    }
  }
  // Connections to a server at most: ten serve a busy jukecord; a hosted database may allow few per user.
  const database = { address, pool: read('JUKECORD_DATABASE_POOL', 10, integer(1, 100)) };

  // Discord settings. Each is optional on its own; the combinations are checked below.
  const token = secret('JUKECORD_DISCORD_TOKEN');
  const clientId = read('JUKECORD_DISCORD_CLIENT_ID', null as string | null, (text) => {
    // Application IDs are Discord snowflakes: 17 to 20 digits.
    if (!/^\d{17,20}$/.test(text)) throw new Error('an application ID is 17 to 20 digits');
    return text;
  });
  const clientSecret = secret('JUKECORD_DISCORD_CLIENT_SECRET');
  // A secret without the ID it belongs to cannot be used for anything, so it is a mistake worth stopping for.
  if (clientSecret !== null && clientId === null) {
    problems.push('JUKECORD_DISCORD_CLIENT_SECRET is set but JUKECORD_DISCORD_CLIENT_ID is not');
  }

  // Media settings, with the limits that keep a mistyped value from filling a disk or hammering a site.
  const media = {
    ytdlp: get('JUKECORD_YTDLP') ?? 'yt-dlp',
    ffmpeg: get('JUKECORD_FFMPEG') ?? 'ffmpeg',
    cacheMaxBytes: read('JUKECORD_CACHE_MAX', 2 * 1024 ** 3, (text) => {
      const bytes = parseSize(text);
      // Below 64 MiB the cache cannot hold the playing track and the next ones, and every track would be fetched twice.
      if (bytes < 64 * 1024 ** 2) throw new Error(`${text} is too small for the media cache (at least 64MiB)`);
      return bytes;
    }),
    fetchTimeoutMs: read('JUKECORD_FETCH_TIMEOUT', 60_000, (text) => {
      const ms = parseDuration(text);
      // Under 5 s even a short track from a fast site fails; over 10 min a stuck download blocks the queue.
      if (ms < 5_000 || ms > 600_000) throw new Error(`${text} is outside 5s-10m`);
      return ms;
    }),
    prefetch: read('JUKECORD_PREFETCH', 2, integer(0, 5)),
    trackMaxMs: read('JUKECORD_TRACK_MAX', 3 * 3_600_000, (text) => {
      const ms = parseDuration(text);
      // Under a minute refuses ordinary songs; over a day is no limit at all.
      if (ms < 60_000 || ms > 86_400_000) throw new Error(`${text} is outside 1m-24h`);
      return ms;
    }),
    cookies: read('JUKECORD_YTDLP_COOKIES', null as string | null, (text) => {
      const full = path.resolve(cwd, text);
      if (!files.readable(full)) throw new Error(`${full} cannot be read`);
      return full;
    }),
    // Off unless asked for: people who may add tracks should not be able to make the server fetch from its own network.
    allowPrivate: read('JUKECORD_ALLOW_PRIVATE_ADDRESSES', false, (text) => {
      const value = text.toLowerCase();
      if (value === 'true' || value === 'yes' || value === '1') return true;
      if (value === 'false' || value === 'no' || value === '0') return false;
      throw new Error(`"${text}" is not true or false`);
    }),
  };

  // The queue limit keeps a pasted 5,000-track playlist (or a script) from making the panel and the database crawl.
  const queueMax = read('JUKECORD_QUEUE_MAX', 1000, integer(10, 100_000));

  // How many live connections at once: each open panel tab is one. A thousand idle ones take about 120 MiB, and each
  // queue change goes out to all of them; a bigger machine can take more, a small one may want fewer.
  const liveMax = read('JUKECORD_LIVE_MAX', 1000, integer(10, 100_000));

  // How long the bot waits alone in a voice channel; "0" turns leaving by itself off.
  const voice = {
    idleMs: read('JUKECORD_VOICE_IDLE', 5 * 60_000, (text) => {
      if (text.trim() === '0') return 0;
      const ms = parseDuration(text);
      if (ms < 10_000 || ms > 86_400_000) throw new Error(`${text} is outside 10s-24h (or 0 to never leave)`);
      return ms;
    }),
  };

  // How long a playing server that nobody hears (the bot out of voice, no browser playing along) waits before it
  // pauses; "0" or "off" lets it play on to nobody, as before.
  const restAfterMs = read('JUKECORD_REST_AFTER', 2 * 60_000, (text) => {
    if (text === '0' || text.toLowerCase() === 'off') return 0;
    const ms = parseDuration(text);
    if (ms < 10_000 || ms > 86_400_000) throw new Error(`${text} is outside 10s-24h (or 0 to never pause)`);
    return ms;
  });

  // A backup every day at a time of day ("04:30", in the time zone jukecord runs in), or none ("off", the default), and
  // how many stay: each is a whole copy of the database.
  const backups = {
    at: read('JUKECORD_BACKUP_AT', null as { hour: number; minute: number } | null, (text) => {
      if (text.toLowerCase() === 'off') return null;
      const time = /^(\d{1,2}):(\d{2})$/.exec(text);
      const hour = Number(time?.[1]);
      const minute = Number(time?.[2]);
      if (!time || hour > 23 || minute > 59) throw new Error(`"${text}" is not off or a time of day like 04:30`);
      return { hour, minute };
    }),
    keep: read('JUKECORD_BACKUP_KEEP', 7, integer(1, 365)),
  };

  // Lyrics are looked up at LRCLIB unless turned off: the one outside service jukecord asks besides Discord and the
  // sites the tracks come from, so it has a switch of its own.
  const lyrics = read('JUKECORD_LYRICS', true, (text) => {
    const value = text.toLowerCase();
    if (['on', 'true', 'yes', '1'].includes(value)) return true;
    if (['off', 'false', 'no', '0'].includes(value)) return false;
    throw new Error(`"${text}" is not on or off`);
  });

  // Log settings: rotation keeps the log from growing without end (every log has a size limit and a count).
  const log = {
    level: read('JUKECORD_LOG_LEVEL', 'info' as LogLevel, (text) => {
      const level = text.toLowerCase();
      if (!LOG_LEVELS.includes(level as LogLevel)) throw new Error(`"${text}" is not one of ${LOG_LEVELS.join(', ')}`);
      return level as LogLevel;
    }),
    // Readable lines by default; JSON for a log shipper (Loki, Elasticsearch, CloudWatch) reading the console.
    format: read('JUKECORD_LOG_FORMAT', 'text' as LogFormat, (text) => {
      const format = text.toLowerCase();
      if (format !== 'text' && format !== 'json') throw new Error(`"${text}" is not text or json`);
      return format;
    }),
    maxBytes: read('JUKECORD_LOG_MAX', 5 * 1024 ** 2, (text) => {
      const bytes = parseSize(text);
      // A tiny limit would rotate on every line and lose the history that the log page shows.
      if (bytes < 64 * 1024) throw new Error(`${text} is too small for a log file (at least 64KiB)`);
      return bytes;
    }),
    files: read('JUKECORD_LOG_FILES', 5, integer(1, 50)),
  };

  // Links of other music services: which are read (all by default; "none" for none), and the host's Spotify app.
  const services = read('JUKECORD_LINK_SERVICES', new Set<LinkService>(LINK_SERVICES), (text) => {
    if (/^(none|off)$/i.test(text.trim())) return new Set<LinkService>();
    const names = text
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean);
    const unknown = names.filter((name) => !LINK_SERVICES.includes(name as LinkService));
    if (unknown.length > 0)
      throw new Error(`"${unknown.join(', ')}" is not one of ${LINK_SERVICES.join(', ')} (or none)`);
    return new Set(names as LinkService[]);
  });
  const spotifyId = read('JUKECORD_SPOTIFY_CLIENT_ID', null as string | null, (text) => {
    // A Spotify app's client ID: letters and digits (32 of them).
    if (!/^[A-Za-z0-9]{16,64}$/.test(text)) throw new Error('a Spotify client ID is letters and digits');
    return text;
  });
  const spotifySecret = secret('JUKECORD_SPOTIFY_CLIENT_SECRET');
  // One without the other cannot be used: a mistake worth stopping for, as Discord's are.
  if ((spotifyId === null) !== (spotifySecret === null))
    problems.push('set both JUKECORD_SPOTIFY_CLIENT_ID and JUKECORD_SPOTIFY_CLIENT_SECRET, or neither');
  const links = {
    services,
    spotify: spotifyId && spotifySecret ? { clientId: spotifyId, clientSecret: spotifySecret } : null,
  };

  // The host's own certificate authorities: read now, so a wrong path or a file without a certificate stops the start
  // with its reason, as a secret's file does. They are trusted by the start itself (src/main.ts), before any connection.
  const authorities = readAuthorities(get('JUKECORD_CA_FILE'), cwd, files);
  if (authorities.problem) problems.push(authorities.problem);

  // The metrics token: a secret like the others (or its file), long enough that guessing it is hopeless, and one word,
  // as a bearer token is.
  const metricsToken = secret('JUKECORD_METRICS_TOKEN');
  if (metricsToken !== null && !/^\S{16,}$/.test(metricsToken)) {
    problems.push('JUKECORD_METRICS_TOKEN: at least 16 characters and no spaces (openssl rand -hex 32 makes one)');
  }
  const metrics = { token: metricsToken };
  // Logging in through the host's identity provider and directory: off unless their addresses are set.
  const auth = readAuthSettings(env, cwd, files);
  problems.push(...auth.problems);

  // The role, and what the services of a split jukecord need: a database server they all reach (read above), a bus,
  // the internal secret, and for an edge, where the core is.
  const role = read('JUKECORD_ROLE', 'all' as Role, (text) => {
    const value = text.toLowerCase();
    if (!ROLES.includes(value as Role)) throw new Error(`"${text}" is not one of ${ROLES.join(', ')}`);
    return value as Role;
  });
  // A Redis or Valkey address: a URL with a host, by one of their schemes.
  const redisUrl = (name: string, text: string | null): string | null => {
    if (text === null) return null;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      problems.push(`${name}: that is not an address (example: redis://valkey:6379)`);
      return null;
    }
    if (!REDIS_SCHEMES.includes(url.protocol) || !url.hostname) {
      problems.push(
        `${name}: a Redis or Valkey address starts with redis://, rediss:// (TLS), valkey:// or valkeys:// (TLS), and names a host`,
      );
      return null;
    }
    return text;
  };
  const busUrl = redisUrl('JUKECORD_BUS_URL', secret('JUKECORD_BUS_URL'));
  const cacheText = secret('JUKECORD_CACHE_URL');
  const cacheUrl =
    cacheText !== null && cacheText.toLowerCase() === 'memory'
      ? 'memory'
      : (redisUrl('JUKECORD_CACHE_URL', cacheText) ?? (role === 'all' ? 'memory' : (busUrl ?? 'memory')));
  const prefix = read('JUKECORD_KEY_PREFIX', 'jukecord', (text) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(text)) {
      throw new Error('a prefix is up to 64 letters, digits and . _ : - (starting with a letter or digit)');
    }
    return text;
  });
  const internalPort = read('JUKECORD_INTERNAL_PORT', DEFAULT_INTERNAL_PORT, integer(1, 65535));
  const internalSecret = secret('JUKECORD_INTERNAL_SECRET');
  if (internalSecret !== null && internalSecret.length < SECRET_MIN) {
    problems.push(
      `JUKECORD_INTERNAL_SECRET is too short: at least ${SECRET_MIN} characters (openssl rand -hex 32 makes one)`,
    );
  }
  const coreUrl = read('JUKECORD_CORE_URL', null as string | null, (text) => {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`"${text}" is not an address (example: http://core:${DEFAULT_INTERNAL_PORT})`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`"${text}" must start with http(s)://`);
    return url.href.replace(/\/+$/, '');
  });
  if (role !== 'all') {
    const as = `JUKECORD_ROLE=${role}`;
    // A SQLite file is one process's: the services need a database server. An address that could not be read or
    // parsed was said above already.
    if (address.kind === 'sqlite' && !databaseSaid) {
      problems.push(
        databaseUrl !== null
          ? `${as} needs a database every service reaches, and a SQLite file is one process's: set JUKECORD_DATABASE_URL to a postgres:// or mysql:// address`
          : `${as} needs JUKECORD_DATABASE_URL: the PostgreSQL or MySQL/MariaDB database every service shares (postgres://... or mysql://...)`,
      );
    }
    if (busUrl === null && get('JUKECORD_BUS_URL') === null && get('JUKECORD_BUS_URL_FILE') === null) {
      problems.push(`${as} needs JUKECORD_BUS_URL: the Redis or Valkey server the services talk through (redis://...)`);
    }
    if (internalSecret === null && get('JUKECORD_INTERNAL_SECRET_FILE') === null) {
      problems.push(
        `${as} needs JUKECORD_INTERNAL_SECRET (or _FILE): the secret the core and its edges share, ${SECRET_MIN} characters or more`,
      );
    }
    if (role === 'edge' && coreUrl === null && get('JUKECORD_CORE_URL') === null) {
      problems.push(
        `${as} needs JUKECORD_CORE_URL: where the core's internal port is (http://core:${DEFAULT_INTERNAL_PORT})`,
      );
    }
    if (role === 'core' && internalPort === port) {
      problems.push(`JUKECORD_INTERNAL_PORT is the panel's port (${port}): the core needs two ports`);
    }
  } else {
    // In one process these do nothing: said once, in case JUKECORD_ROLE was meant to be set too.
    const unused = ['JUKECORD_BUS_URL', 'JUKECORD_CORE_URL', 'JUKECORD_INTERNAL_SECRET'].filter(
      (name) => get(name) !== null || get(`${name}_FILE`) !== null,
    );
    if (unused.length > 0) {
      warnings.push(
        `${unused.join(', ')} ${unused.length === 1 ? 'is' : 'are'} read only when JUKECORD_ROLE is core or edge; this one process carries its events in memory`,
      );
    }
  }

  // Unknown JUKECORD_ variables are not fatal, but they are almost always a misspelt setting that silently does nothing.
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith('JUKECORD_') && !KNOWN.has(name)) warnings.push(`${name} is not a jukecord setting`);
  }

  // Stop here with every problem at once (see the module comment).
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    dataDir,
    database,
    host,
    port,
    publishedPort,
    publicUrl,
    trustProxy,
    discord: { token, clientId, clientSecret },
    media,
    queueMax,
    liveMax,
    voice,
    restAfterMs,
    backups,
    lyrics,
    log,
    warnings,
    ca: authorities.authorities,
    metrics,
    links,
    auth: auth.settings,
    role,
    bus: { url: role === 'all' ? null : busUrl, prefix },
    cacheUrl,
    internal: {
      port: internalPort,
      secret: role === 'all' ? null : internalSecret,
      coreUrl: role === 'edge' ? coreUrl : null,
    },
  };
}

/**
 * The settings as text for status pages and the doctor command, with the secrets replaced by whether they are set.
 *
 * Nothing that prints settings should take them from anywhere else, so a secret cannot reach a screen or a log.
 */
export function describeConfig(config: Config): Record<string, string> {
  // Shows that a secret exists without any part of it: even a prefix helps someone guessing a token.
  const secret = (value: string | null): string => (value === null ? 'not set' : 'set');
  return {
    'data directory': config.dataDir,
    // Where the database is, never with its user or password.
    database: describeAddress(config.database.address),
    'database connections':
      config.database.address.kind === 'sqlite' ? 'one (a file)' : `up to ${config.database.pool}`,
    listen: `${config.host}:${config.port}`,
    'public address': config.publicUrl ?? 'not set',
    'trust proxy headers': String(config.trustProxy),
    'discord token': secret(config.discord.token),
    'discord application': config.discord.clientId ?? 'not set',
    'discord oauth secret': secret(config.discord.clientSecret),
    'yt-dlp': config.media.ytdlp,
    ffmpeg: config.media.ffmpeg,
    'cache limit': `${config.media.cacheMaxBytes} bytes`,
    'fetch timeout': `${config.media.fetchTimeoutMs} ms`,
    prefetch: String(config.media.prefetch),
    'log level': config.log.level,
    'log format': config.log.format,
    'log rotation': `${config.log.files} files of ${config.log.maxBytes} bytes`,
    'longest track': `${config.media.trackMaxMs} ms`,
    'yt-dlp cookies': config.media.cookies ?? 'not set',
    'private addresses': config.media.allowPrivate ? 'allowed' : 'refused',
    'queue limit': String(config.queueMax),
    'live connections limit': String(config.liveMax),
    'leave voice when alone after': config.voice.idleMs === 0 ? 'never' : `${config.voice.idleMs} ms`,
    'pause with nobody listening after': config.restAfterMs === 0 ? 'never' : `${config.restAfterMs} ms`,
    'daily backup': config.backups.at ? `at ${timeOfDay(config.backups.at)}, keeping ${config.backups.keep}` : 'off',
    lyrics: config.lyrics ? 'from LRCLIB' : 'off',
    'links read': config.links.services.size > 0 ? [...config.links.services].join(', ') : 'none',
    'spotify app': config.links.spotify?.clientId ?? 'not set',
    'spotify secret': secret(config.links.spotify?.clientSecret ?? null),
    'metrics token': secret(config.metrics.token),
    'certificate authorities': describeAuthorities(config.ca),
    ...describeAuth(config.auth),
    role: config.role,
    // The servers without their passwords (an address may carry one).
    bus: config.bus.url ? shownServer(config.bus.url) : 'in memory (one process)',
    'shared cache': config.cacheUrl === 'memory' ? 'in memory' : shownServer(config.cacheUrl),
    'key prefix': config.bus.prefix,
    ...(config.role === 'core' ? { 'internal port': String(config.internal.port) } : {}),
    ...(config.role === 'edge' ? { 'core address': config.internal.coreUrl ?? 'not set' } : {}),
    ...(config.role !== 'all' ? { 'internal secret': secret(config.internal.secret) } : {}),
  };
}

// A server's address with its user name and password left out.
function shownServer(address: string): string {
  try {
    const url = new URL(address);
    url.username = '';
    url.password = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return 'set';
  }
}

/** A time of day as people write it: "04:30". */
export function timeOfDay(at: { readonly hour: number; readonly minute: number }): string {
  return `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;
}
