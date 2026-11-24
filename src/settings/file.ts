/**
 * settings.json in the data folder: the host's saved settings that cannot wait for the database (its own address, the
 * port, where jukecord listens) and the saved secrets, which never go into the database (a backup, a copy into another
 * database or a server's dump would carry them).
 *
 *   { "version": 1, "settings": { "JUKECORD_PORT": { "value": "8796", "revision": 1, "updatedAt": 1764000000000 } } }
 *
 * The file is the user's alone (0600), written whole under another name and then renamed over the old one, so a stop
 * halfway leaves the old file or the new one, never half of either. A file jukecord cannot read is a reason not to
 * start: it may name the database, and starting on the default one instead would look like lost data.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SavedSetting, SettingWrite } from '../store/store.ts';
import { RevisionConflict } from '../store/store.ts';
import { Lock } from '../util/lock.ts';

/** The file's name in the data folder. */
export const SETTINGS_FILE = 'settings.json';

// The shape this jukecord writes; a file of a newer shape is refused rather than half understood.
const VERSION = 1;

/** settings.json cannot be read or does not hold what jukecord writes there; the message says which and why. */
export class SettingsFileError extends Error {
  override name = 'SettingsFileError';
}

/** The saved settings of settings.json, by name. */
export type FileSettings = ReadonlyMap<string, SavedSetting>;

/** Reads settings.json in a data folder: nothing saved when there is no file. */
export function readSettingsFile(dataDir: string): FileSettings {
  const file = path.join(dataDir, SETTINGS_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // No file: nothing was ever saved there, the usual case.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new SettingsFileError(`${file} cannot be read (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsFileError(`${file} is not JSON; put back the one jukecord wrote, or remove it`);
  }
  const shape = parsed as { version?: unknown; settings?: unknown };
  if (shape?.version !== VERSION || typeof shape.settings !== 'object' || shape.settings === null) {
    throw new SettingsFileError(`${file} is not a settings file this jukecord writes (version ${VERSION})`);
  }
  const settings = new Map<string, SavedSetting>();
  for (const [name, entry] of Object.entries(shape.settings as Record<string, unknown>)) {
    const saved = entry as { value?: unknown; revision?: unknown; updatedAt?: unknown };
    // Each entry as jukecord writes it: a text or null, and whole numbers; anything else is a hand edit gone wrong.
    if (
      (typeof saved?.value !== 'string' && saved?.value !== null) ||
      !Number.isSafeInteger(saved.revision) ||
      !Number.isSafeInteger(saved.updatedAt)
    ) {
      throw new SettingsFileError(`${file}: ${name} is not a saved setting (a value, a revision and a time)`);
    }
    settings.set(name, {
      name,
      value: saved.value as string | null,
      revision: saved.revision as number,
      updatedAt: saved.updatedAt as number,
    });
  }
  return settings;
}

/** settings.json of one data folder, read and written one change at a time. */
export class SettingsFile {
  readonly file: string;
  private readonly dataDir: string;
  private readonly now: () => number;
  // One change at a time in this process: each reads the file, changes it and writes it whole.
  private readonly lock = new Lock();

  constructor(dataDir: string, now: () => number = Date.now) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, SETTINGS_FILE);
    this.now = now;
  }

  /** What the file holds now. */
  read(): FileSettings {
    return readSettingsFile(this.dataDir);
  }

  /**
   * Writes changes, each one revision up (as the database's settings are); with `expected`, a setting whose revision is
   * not the one given is a conflict and nothing is written. Returns the entries written.
   */
  async write(changes: readonly SettingWrite[], expected?: Readonly<Record<string, number>>): Promise<SavedSetting[]> {
    const release = await this.lock.acquire();
    try {
      const current = new Map(this.read());
      const stale = changes
        .map((change) => change.name)
        .filter((name) => expected?.[name] !== undefined && (current.get(name)?.revision ?? 0) !== expected[name]);
      if (stale.length > 0) throw new RevisionConflict(stale);
      const now = this.now();
      const written: SavedSetting[] = [];
      for (const change of changes) {
        const entry = {
          name: change.name,
          value: change.value,
          revision: (current.get(change.name)?.revision ?? 0) + 1,
          updatedAt: now,
        };
        current.set(change.name, entry);
        written.push(entry);
      }
      this.replace(current);
      return written;
    } finally {
      release();
    }
  }

  /**
   * Puts entries back as they were before a change that could not be finished (the database refused its half): the
   * file's own entries for those names, or none.
   */
  async restore(before: FileSettings, names: readonly string[]): Promise<void> {
    const release = await this.lock.acquire();
    try {
      const current = new Map(this.read());
      for (const name of names) {
        const old = before.get(name);
        if (old) current.set(name, old);
        else current.delete(name);
      }
      this.replace(current);
    } finally {
      release();
    }
  }

  // Writes the whole file under another name, then renames it over the old one (a stop halfway leaves one or the other).
  private replace(settings: ReadonlyMap<string, SavedSetting>): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    // Sorted by name, so the file reads the same way after every save and a diff of two shows what changed.
    const entries = Object.fromEntries(
      [...settings.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => [entry.name, { value: entry.value, revision: entry.revision, updatedAt: entry.updatedAt }]),
    );
    const partial = `${this.file}.partial`;
    const handle = fs.openSync(partial, 'w', 0o600);
    try {
      fs.writeSync(handle, `${JSON.stringify({ version: VERSION, settings: entries }, null, 2)}\n`);
      // On the disk before the rename, so a power cut after it cannot leave an empty file under the real name.
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    // The mode of a file made before (by hand, say) is set again: secrets are the user's alone.
    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, this.file);
  }
}
