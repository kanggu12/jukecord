/**
 * The self-check behind `jukecord doctor`: every part jukecord needs, each with a plain verdict and the fact behind it.
 *
 * "fail" means something does not work now (no ffmpeg with Opus, a database that does not answer or does not pass
 * SQLite's check, a bot that cannot reach Discord). "warn" means it works but will not for long (the disk nearly full, a yt-dlp older than
 * the newest release, which YouTube's changes break sooner or later). Everything else is "ok" with what was seen.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthSettings } from '../auth/settings.ts';
import { type Config, describeConfig, timeOfDay } from '../config.ts';
import type { MediaCache } from '../media/cache.ts';
import type { Ffmpeg } from '../media/ffmpeg.ts';
import type { YtDlp } from '../media/ytdlp.ts';
import { LATEST_SCHEMA, type Store } from '../store/store.ts';
import { formatSize } from '../util/units.ts';
import type { Directory } from './actions.ts';
import { listBackups } from './backups.ts';

export interface Check {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

export interface DoctorReport {
  /** False when any check failed. */
  readonly ok: boolean;
  readonly checks: Check[];
  /** The settings in effect, secrets shown only as set or not set. */
  readonly settings: Record<string, string>;
}

export interface DoctorOptions {
  readonly config: Config;
  readonly store: Store;
  readonly cache: MediaCache;
  readonly ytdlp: YtDlp;
  readonly ffmpeg: Ffmpeg;
  readonly discordReady: () => boolean;
  readonly directory: () => Directory | null;
  /** Whether logging in with Discord is set up. */
  readonly discordLogin: boolean;
  /** The newest yt-dlp release, or null when it cannot be found out (offline). Tests pass a fixed answer. */
  readonly latestYtDlp?: () => Promise<string | null>;
  /** The daily backup's last failure since it last worked (see BackupSchedule); null or absent when none. */
  readonly backupFailure?: () => { at: number; reason: string } | null;
}

// Below this much free space the cache cannot take new tracks for long.
const LOW_DISK = 1024 ** 3;

// A database server further than this (one statement there and back) makes every change wait that long several times
// over: it works, but slowly.
const SLOW_DATABASE_MS = 100;

/** Asks GitHub for the newest yt-dlp release tag; null when offline or rate-limited. */
export async function latestYtDlpRelease(): Promise<string | null> {
  try {
    const response = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      // GitHub asks every client to name itself; the program's name is enough.
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'jukecord' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown };
    return typeof body.tag_name === 'string' ? body.tag_name : null;
  } catch {
    return null;
  }
}

// yt-dlp versions are dates ("2026.10.26", sometimes with a fourth part); compared part by part as numbers.
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const x = pa[index] ?? 0;
    const y = pb[index] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * What the doctor says of an SSO login's link to a Discord user (JUKECORD_OIDC_DISCORD_CLAIM), where the logins are:
 * the claim links nobody without Discord login, and with it a person is linked once they have logged in with Discord
 * as the user it names. The claim must be an attribute people cannot change themselves, or anyone could name anyone.
 * Null when no claim is set.
 */
export function discordLinkCheck(auth: AuthSettings, discordLogin: boolean): Check | null {
  const claim = auth.oidc?.discordClaim ?? null;
  if (claim === null) return null;
  if (!discordLogin)
    return {
      name: 'sso discord link',
      status: 'warn',
      detail: `JUKECORD_OIDC_DISCORD_CLAIM (${claim}) links nobody: Discord login is off (JUKECORD_DISCORD_CLIENT_SECRET)`,
    };
  return {
    name: 'sso discord link',
    status: 'ok',
    detail: `an SSO login is the Discord user its ${claim} claim names once that person logs in with Discord as them; ${claim} must be an attribute people cannot change on their own account`,
  };
}

/** Runs every check; never throws (a check that cannot run is a failed check). */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];
  // Each check runs on its own, so one broken part does not hide the state of the others.
  const check = async (name: string, run: () => Promise<Omit<Check, 'name'>> | Omit<Check, 'name'>) => {
    try {
      checks.push({ name, ...(await run()) });
    } catch (error) {
      checks.push({ name, status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const { config } = options;

  await check('data directory', () => {
    // A real write, not a permission bit: a read-only mount or a full disk shows here.
    const probe = path.join(config.dataDir, `.doctor-${randomUUID()}`);
    fs.writeFileSync(probe, 'jukecord');
    fs.rmSync(probe);
    const disk = fs.statfsSync(config.dataDir);
    const free = disk.bavail * disk.bsize;
    return {
      status: free < LOW_DISK ? 'warn' : 'ok',
      detail: `${config.dataDir}, ${formatSize(free)} free`,
    };
  });

  await check('database', async () => {
    const { store } = options;
    // A statement there and back, and the schema the database is at: the same for every kind of database.
    const health = await store.health();
    if (!health.ok) return { status: 'fail', detail: `${health.server} does not answer: ${health.error}` };
    // Another jukecord (a newer one beside this one, on a shared database) moved the schema on while this one ran.
    if (health.schema !== LATEST_SCHEMA) {
      return {
        status: 'fail',
        detail: `the database is at schema ${health.schema}, this jukecord at ${LATEST_SCHEMA} (run the jukecord that wrote it)`,
      };
    }
    if (store.backend !== 'sqlite') {
      // A server checks its own files; what it says of its size, and how far it is.
      const bytes = await store.size();
      const slow = (health.roundTripMs ?? 0) > SLOW_DATABASE_MS;
      return {
        status: slow ? 'warn' : 'ok',
        detail: `${health.server}, schema ${health.schema}${bytes === null ? '' : `, ${formatSize(bytes)}`}, ${health.roundTripMs} ms there and back${slow ? ' (far: every change waits that long a few times)' : ''}`,
      };
    }
    const answer = await store.quickCheck();
    // The file on this machine, if the database is one (not an in-memory one, the tests').
    const file = store.file;
    const onDisk = file !== null && file !== ':memory:';
    const bytes = onDisk ? fs.statSync(file).size : 0;
    // What its write-ahead log holds that the file does not yet: on disk too, and folded in now and then.
    let log = 0;
    try {
      if (onDisk) log = fs.statSync(`${file}-wal`).size;
    } catch {
      // No log file at the moment.
    }
    const healthy = answer === 'ok';
    return {
      status: healthy ? 'ok' : 'fail',
      detail: healthy
        ? `schema ${health.schema}, ${formatSize(bytes)}${log > 0 ? `, and ${formatSize(log)} in its write-ahead log` : ''}`
        : `SQLite found damage: ${answer ?? 'no answer'} (restore a backup)`,
    };
  });

  await check('ffmpeg', async () => {
    const about = await options.ffmpeg.about();
    const missing = [about.opus ? null : 'libopus', about.mp3 ? null : 'libmp3lame'].filter(Boolean);
    return {
      status: missing.length > 0 ? 'fail' : 'ok',
      detail: missing.length > 0 ? `${about.version} has no ${missing.join(' or ')}` : about.version,
    };
  });

  await check('yt-dlp', async () => {
    const installed = await options.ytdlp.version();
    const latest = await (options.latestYtDlp ?? latestYtDlpRelease)();
    if (latest && newer(latest, installed)) {
      return { status: 'warn', detail: `${installed}; ${latest} is out (a newer jukecord image brings it)` };
    }
    return {
      status: 'ok',
      detail: latest ? `${installed} (the newest)` : `${installed} (could not check for a newer one)`,
    };
  });

  await check('media cache', () => ({
    status: 'ok',
    detail: `${options.cache.count()} tracks, ${formatSize(options.cache.size())} of ${formatSize(config.media.cacheMaxBytes)}`,
  }));

  await check('discord', () => {
    if (!config.discord.token) return { status: 'ok', detail: 'no bot token: browser-only mode' };
    if (!options.discordReady()) return { status: 'fail', detail: 'the bot is not connected to Discord' };
    const servers = options.directory()?.guilds().length ?? 0;
    return { status: 'ok', detail: `connected, in ${servers} server${servers === 1 ? '' : 's'}` };
  });

  await check('panel login', () => ({
    status: 'ok',
    detail: options.discordLogin
      ? 'with Discord, and login links from the host'
      : 'login links from the host only (Discord login needs JUKECORD_DISCORD_CLIENT_SECRET)',
  }));
  // An SSO login's link to a Discord user, when a claim is set (a split's edges say it themselves: logins are theirs).
  const link = discordLinkCheck(config.auth, options.discordLogin);
  if (link) checks.push(link);

  await check('backups', () => {
    const backups = listBackups(path.join(config.dataDir, 'backups'));
    const schedule = config.backups.at
      ? `daily at ${timeOfDay(config.backups.at)}, keeping ${config.backups.keep}`
      : 'no daily backup (JUKECORD_BACKUP_AT)';
    const newest = backups[0];
    // The daily backup failed after the newest one there is (or before any was made): the data has no fresh copy, said
    // with the reason, as the log and the alerts channels said it. A backup made since (by hand) settles it.
    const failure = options.backupFailure?.() ?? null;
    if (failure && (!newest || failure.at > newest.at)) {
      const kept = newest
        ? `the newest ${ago(Math.max(0, Date.now() - newest.at))} (${formatSize(newest.bytes)}), ${backups.length} kept`
        : 'none made yet';
      return {
        status: 'warn',
        detail: `the scheduled backup failed ${ago(Math.max(0, Date.now() - failure.at))}: ${failure.reason}; ${kept}; ${schedule}`,
      };
    }
    if (!newest) return { status: 'ok', detail: `none yet; ${schedule}` };
    const age = Math.max(0, Date.now() - newest.at);
    // A daily backup that has not run for two days did not run when it should have.
    const late = config.backups.at !== null && age > 2 * 86_400_000;
    return {
      status: late ? 'warn' : 'ok',
      detail: `the newest ${ago(age)} (${formatSize(newest.bytes)}), ${backups.length} kept; ${schedule}`,
    };
  });

  return { ok: checks.every((entry) => entry.status !== 'fail'), checks, settings: describeConfig(config) };
}

// How long ago, as people say it: "12 min ago", "3 h ago", "2 days ago".
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
