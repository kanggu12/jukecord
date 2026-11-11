/**
 * The self-check behind `jukecord doctor`: every part jukecord needs, each with a plain verdict and the fact behind it.
 *
 * "fail" means something does not work now (no ffmpeg with Opus, a database that does not pass SQLite's check, a bot
 * that cannot reach Discord). "warn" means it works but will not for long (the disk nearly full, a yt-dlp older than
 * the newest release, which YouTube's changes break sooner or later). Everything else is "ok" with what was seen.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Config, describeConfig } from '../config.ts';
import type { MediaCache } from '../media/cache.ts';
import type { Ffmpeg } from '../media/ffmpeg.ts';
import type { YtDlp } from '../media/ytdlp.ts';
import type { Store } from '../store/store.ts';
import { formatSize } from '../util/units.ts';
import type { Directory } from './actions.ts';

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
}

// Below this much free space the cache cannot take new tracks for long.
const LOW_DISK = 1024 ** 3;

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

  await check('database', () => {
    const row = options.store.db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    const bytes = options.store.file === ':memory:' ? 0 : fs.statSync(options.store.file).size;
    const healthy = row?.quick_check === 'ok';
    return {
      status: healthy ? 'ok' : 'fail',
      detail: healthy
        ? `schema ${options.store.schemaVersion()}, ${formatSize(bytes)}`
        : `SQLite found damage: ${row?.quick_check ?? 'no answer'} (restore a backup)`,
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

  return { ok: checks.every((entry) => entry.status !== 'fail'), checks, settings: describeConfig(config) };
}
