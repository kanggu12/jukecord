/**
 * Backups of the database: one on request (the backup operation, ./jukecord backup), and one a day at a time of the
 * host's choosing (JUKECORD_BACKUP_AT, off by default), the newest JUKECORD_BACKUP_KEEP kept (seven by default).
 *
 * A backup is a consistent copy made while jukecord runs (VACUUM INTO, see Store.backup), in the backups folder of
 * the data directory, named by the time it was made so the names sort as the backups do. The media cache is not in it
 * (tracks are fetched again when they are played).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Clock, TimerHandle } from '../core/clock.ts';
import type { Logger } from '../log.ts';
import type { Store } from '../store/store.ts';
import type { Alerts } from './alerts.ts';

/** How many backups stay in the folder by default: a week of daily ones. */
export const KEEP_BACKUPS = 7;

/** A backup in the folder: its file, its size, and when it was made. */
export interface Backup {
  readonly file: string;
  readonly bytes: number;
  readonly at: number;
}

// When a backup was made, from its name ("jukecord-2026-11-12T14-33-24-775Z.db" is that moment in UTC): a copy keeps
// it, where the file's own time is that of the copy.
function madeAt(name: string): number | null {
  const parts = /^jukecord-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/.exec(name);
  if (!parts) return null;
  const at = Date.parse(`${parts[1]}T${parts[2]}:${parts[3]}:${parts[4]}.${parts[5]}Z`);
  return Number.isNaN(at) ? null : at;
}

/** The backups in a folder, newest first (none when the folder is not there yet). */
export function listBackups(dir: string): Backup[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return (
    names
      // jukecord's own: "jukecord-<time>.db".
      .filter((name) => /^jukecord-.+\.db$/.test(name))
      .sort()
      .reverse()
      .flatMap((name) => {
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          return [{ file, bytes: stat.size, at: madeAt(name) ?? stat.mtimeMs }];
        } catch {
          // Removed meanwhile: not one any more.
          return [];
        }
      })
  );
}

// How old a backup's unfinished copy (".partial", see Store.backupAside) must be to be cleared away: one being written
// now is younger (its file changes as it is written).
const PARTIAL_STALE_MS = 3_600_000;

/**
 * Removes all but the newest `keep` backups (their names sort by time) from the folder, and the unfinished copies a
 * stop in the middle of a backup left behind.
 */
export function pruneBackups(dir: string, keep: number, now = Date.now()): void {
  for (const backup of listBackups(dir).slice(Math.max(0, keep))) fs.rmSync(backup.file, { force: true });
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No folder: nothing to clear.
  }
  for (const name of names) {
    if (!/^jukecord-.*\.db\.partial$/.test(name)) continue;
    const file = path.join(dir, name);
    // Gone meanwhile (another prune), or still being written: left alone.
    const changed = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (changed !== undefined && now - changed >= PARTIAL_STALE_MS) fs.rmSync(file, { force: true });
  }
}

/**
 * Writes a backup of the database into the folder, named by the time, and keeps the newest `keep`. The copy is written
 * beside the main thread (Store.backupAside), which goes on answering meanwhile.
 */
export async function makeBackup(store: Store, dir: string, keep: number, now = new Date()): Promise<Backup> {
  // One file per backup, named by the time, so backups sort and none replaces another.
  const file = path.join(dir, `jukecord-${now.toISOString().replace(/[:.]/g, '-')}.db`);
  await store.backupAside(file);
  const bytes = fs.statSync(file).size;
  pruneBackups(dir, keep);
  return { file, bytes, at: now.getTime() };
}

/** A time of day, in the time zone jukecord runs in (TZ). */
export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

export interface BackupScheduleOptions {
  readonly store: Store;
  readonly dir: string;
  readonly keep: number;
  readonly at: TimeOfDay;
  readonly clock: Clock;
  readonly log: Logger;
  /** Where a failed backup is told (the servers' alerts channels). */
  readonly alerts?: Pick<Alerts, 'raise'>;
}

// The local day of a date, as "YYYY-MM-DD", and when the time of day falls on it.
function dayOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function timeOn(date: Date, at: TimeOfDay): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), at.hour, at.minute).getTime();
}

/**
 * The daily backup. It looks every minute whether today's time has come and today's backup is not made yet (from the
 * date, so a clock set, a change of summer time or a machine that slept through the time do not skip a day), so a
 * jukecord that was not running at the time makes the day's backup when it starts. One try a day: a backup that
 * failed (a full disk) is said in the log and in the alerts channels, and tried again the next day.
 */
export class BackupSchedule {
  private readonly options: BackupScheduleOptions;
  // The day whose backup is made (or was tried).
  private done: string | null = null;
  private timer: TimerHandle | null = null;
  // The backup being written now, if one is.
  private running: Promise<void> | null = null;
  // The last scheduled backup that failed, until one works again (for `jukecord doctor`).
  private failure: { at: number; reason: string } | null = null;

  constructor(options: BackupScheduleOptions) {
    this.options = options;
  }

  /** Starts looking (a backup made since today's time, by hand or by a run before a restart, counts as today's). */
  start(): void {
    const now = new Date(this.options.clock.now());
    const newest = listBackups(this.options.dir)[0];
    if (newest && newest.at >= timeOn(now, this.options.at)) this.done = dayOf(now);
    this.look();
  }

  stop(): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** The last scheduled backup that failed, when, and why; null when the last one worked (or none ran yet). */
  lastFailure(): { at: number; reason: string } | null {
    return this.failure;
  }

  /** Settles once no backup is being written (at once when none is); for a stop that waits for it, and for tests. */
  async idle(): Promise<void> {
    await this.running;
  }

  // Makes today's backup when its time has come, then looks again in a minute.
  private look(): void {
    const now = new Date(this.options.clock.now());
    const today = dayOf(now);
    // One at a time: a backup still being written puts off the next look's (only a clock set far ahead could ask).
    if (this.running === null && this.done !== today && now.getTime() >= timeOn(now, this.options.at)) {
      this.done = today;
      const running = this.run(now).finally(() => {
        if (this.running === running) this.running = null;
      });
      this.running = running;
    }
    this.timer = this.options.clock.setTimeout(() => this.look(), 60_000);
  }

  // Writes the day's backup (beside the main thread); a failure is said, never thrown.
  private async run(now: Date): Promise<void> {
    const { store, dir, keep, log } = this.options;
    try {
      const made = await makeBackup(store, dir, keep, now);
      log.info('made the scheduled backup', { file: made.file, bytes: made.bytes, kept: keep });
      // Working again: an earlier failure is no longer news.
      this.failure = null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error('the scheduled backup failed', { reason });
      // Kept for `jukecord doctor`, which otherwise said "none yet" as if all were well.
      this.failure = { at: now.getTime(), reason };
      this.options.alerts?.raise({
        kind: 'backup',
        guildId: null,
        logged: true,
        en: `The scheduled backup failed: ${reason}`,
        ko: `예약 백업 실패: ${reason}`,
      });
    }
  }
}
