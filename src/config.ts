/**
 * jukecord's settings, read from environment variables (JUKECORD_*), checked all at once.
 *
 * Every problem is collected before anything starts, so a person fixing their .env sees the whole list in one run
 * instead of one error per restart. Secrets are kept out of anything this module prints.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDuration, parseSize, UnitError } from './util/units.ts';

/** How much the logger writes; each level includes the ones after it. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The settings the rest of jukecord reads. Built once by loadConfig and not changed afterwards. */
export interface Config {
  /** Where the database, the media cache and the logs live (an absolute path). */
  readonly dataDir: string;
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
  readonly voice: {
    /** How long the bot stays alone in a voice channel before it leaves (0: it does not leave by itself). */
    readonly idleMs: number;
  };
  readonly log: {
    readonly level: LogLevel;
    /** The size at which the log file is rotated, in bytes. */
    readonly maxBytes: number;
    /** How many log files are kept, the current one included. */
    readonly files: number;
  };
  /** Settings that were read but look wrong without being fatal (an unknown JUKECORD_ variable, mostly typos). */
  readonly warnings: readonly string[];
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
  'JUKECORD_LOG_MAX',
  'JUKECORD_LOG_FILES',
  'JUKECORD_DISCORD_TOKEN_FILE',
  'JUKECORD_DISCORD_CLIENT_SECRET_FILE',
  'JUKECORD_TRACK_MAX',
  'JUKECORD_YTDLP_COOKIES',
  'JUKECORD_QUEUE_MAX',
  'JUKECORD_VOICE_IDLE',
  'JUKECORD_TRUST_PROXY',
  'JUKECORD_ALLOW_PRIVATE_ADDRESSES',
  // Read by compose.yaml (the published address and the image), not by jukecord; known so they raise no warning
  // when .env passes them through.
  'JUKECORD_BIND',
  'JUKECORD_IMAGE',
  // Set by compose.yaml from JUKECORD_PORT: the port outside the container.
  'JUKECORD_PUBLISHED_PORT',
]);

/** File access loadConfig needs, passed in so tests can give it files without touching the disk. */
export interface ConfigFiles {
  read(file: string): string;
  readable(file: string): boolean;
}

const diskFiles: ConfigFiles = {
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

  // How long the bot waits alone in a voice channel; "0" turns leaving by itself off.
  const voice = {
    idleMs: read('JUKECORD_VOICE_IDLE', 5 * 60_000, (text) => {
      if (text.trim() === '0') return 0;
      const ms = parseDuration(text);
      if (ms < 10_000 || ms > 86_400_000) throw new Error(`${text} is outside 10s-24h (or 0 to never leave)`);
      return ms;
    }),
  };

  // Log settings: rotation keeps the log from growing without end (every log has a size limit and a count).
  const log = {
    level: read('JUKECORD_LOG_LEVEL', 'info' as LogLevel, (text) => {
      const level = text.toLowerCase();
      if (!LOG_LEVELS.includes(level as LogLevel)) throw new Error(`"${text}" is not one of ${LOG_LEVELS.join(', ')}`);
      return level as LogLevel;
    }),
    maxBytes: read('JUKECORD_LOG_MAX', 5 * 1024 ** 2, (text) => {
      const bytes = parseSize(text);
      // A tiny limit would rotate on every line and lose the history that the log page shows.
      if (bytes < 64 * 1024) throw new Error(`${text} is too small for a log file (at least 64KiB)`);
      return bytes;
    }),
    files: read('JUKECORD_LOG_FILES', 5, integer(1, 50)),
  };

  // Unknown JUKECORD_ variables are not fatal, but they are almost always a misspelt setting that silently does nothing.
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith('JUKECORD_') && !KNOWN.has(name)) warnings.push(`${name} is not a jukecord setting`);
  }

  // Stop here with every problem at once (see the module comment).
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    dataDir,
    host,
    port,
    publishedPort,
    publicUrl,
    trustProxy,
    discord: { token, clientId, clientSecret },
    media,
    queueMax,
    voice,
    log,
    warnings,
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
    'log rotation': `${config.log.files} files of ${config.log.maxBytes} bytes`,
    'longest track': `${config.media.trackMaxMs} ms`,
    'yt-dlp cookies': config.media.cookies ?? 'not set',
    'private addresses': config.media.allowPrivate ? 'allowed' : 'refused',
    'queue limit': String(config.queueMax),
    'leave voice when alone after': config.voice.idleMs === 0 ? 'never' : `${config.voice.idleMs} ms`,
  };
}
