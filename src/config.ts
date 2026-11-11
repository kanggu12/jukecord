/**
 * jukecord's settings, read from environment variables (JUKECORD_*), checked all at once.
 *
 * Every problem is collected before anything starts, so a person fixing their .env sees the whole list in one run
 * instead of one error per restart. Secrets are kept out of anything this module prints.
 */
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
  /** The address people reach the panel at, when it is not this machine (used for login and links). */
  readonly publicUrl: string | null;
  readonly discord: {
    /** The bot's token; without it jukecord runs browser-only (the panel plays, nothing joins voice). */
    readonly token: string | null;
    /** The application's ID, needed for the slash commands and for logging in with Discord. */
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
]);

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Reads and checks the settings.
 *
 * `env` is passed in (not read from process.env here) so tests can give exact environments; `cwd` anchors a
 * relative data directory, which is how a checkout run by hand keeps its data in ./data.
 */
export function loadConfig(env: NodeJS.ProcessEnv, cwd: string): Config {
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

  // Discord settings. Each is optional on its own; the combinations are checked below.
  const token = get('JUKECORD_DISCORD_TOKEN');
  const clientId = read('JUKECORD_DISCORD_CLIENT_ID', null as string | null, (text) => {
    // Application IDs are Discord snowflakes: 17 to 20 digits.
    if (!/^\d{17,20}$/.test(text)) throw new Error('an application ID is 17 to 20 digits');
    return text;
  });
  const clientSecret = get('JUKECORD_DISCORD_CLIENT_SECRET');
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
    publicUrl,
    discord: { token, clientId, clientSecret },
    media,
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
  };
}
