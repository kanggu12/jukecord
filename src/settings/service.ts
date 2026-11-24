/**
 * The host's settings while jukecord runs: what each is and where its value comes from, changing them (checked by the
 * same rules as at the start, all or nothing), putting them back to their defaults, and taking a change in, which
 * applies at once what can (the log's level, the limits, the lyrics ...) and marks the rest as waiting for a restart.
 *
 * The web layer calls this and nothing else, so a split jukecord can carry these calls from an edge to its core as it
 * carries the actions. A change is told to the services through one function (`announce`): in one process it takes
 * the change in here; a split jukecord points it at its bus, and every service takes it in from the database.
 *
 * Saved values live in two places (src/settings/layers.ts): settings.json for the bootstrap settings and the secrets,
 * the database for the rest. A change to both writes the database first (one transaction) and settings.json after; if
 * the file cannot be written, the database's part is put back, so a change is kept whole or not at all.
 */
import { ActionError } from '../app/actions.ts';
import type { Config, ConfigFiles, Supervisor } from '../config.ts';
import type { Logger } from '../log.ts';
import { ConnectionError } from '../store/network.ts';
import { RevisionConflict, type SavedSetting, type SettingWrite, type Store } from '../store/store.ts';
import { Lock } from '../util/lock.ts';
import {
  findDefinition,
  GROUPS,
  type GroupDefinition,
  SETTINGS,
  type SettingDefinition,
  storedIn,
  type Words,
} from './definitions.ts';
import type { SettingsFile } from './file.ts';
import {
  environmentVariable,
  type LayerRules,
  mergedEnvironment,
  type SavedLayers,
  savedOf,
  sourceOf,
  strays,
} from './layers.ts';
import { problemsOf, readLayers, type SettingProblem, withoutNames } from './read.ts';
import { restartRefusal } from './restart.ts';
import { sameValue, shownValue } from './values.ts';

/** A change refused by the settings' rules: every problem it would bring, each with the settings it is about. */
export type { SettingProblem } from './read.ts';
export { startingSettings } from './read.ts';

export class SettingsRefused extends ActionError {
  readonly problems: readonly SettingProblem[];

  constructor(problems: readonly SettingProblem[]) {
    super('invalid', problems.map((problem) => problem.message).join('; '));
    this.problems = problems;
  }
}

/** Why a setting cannot be changed here: set by the environment, read from it alone in a split, or the data folder. */
export type LockReason = 'environment' | 'split' | 'start';

/** One setting as the page, the API and the CLI show it. */
export interface SettingState {
  readonly name: string;
  readonly group: string;
  readonly part: string | null;
  readonly kind: SettingDefinition['kind'];
  readonly label: Words;
  readonly help: Words;
  readonly default: string | null;
  readonly defaultNote: Words | null;
  readonly min: string | null;
  readonly max: string | null;
  readonly choices: readonly string[] | null;
  readonly separator: string | null;
  readonly off: string | null;
  readonly words: readonly string[] | null;
  readonly maxLength: number | null;
  readonly applies: 'now' | 'restart';
  readonly bootstrap: boolean;
  readonly secret: boolean;
  readonly roles: readonly string[];
  /** Its text as it reads after a restart (what the layers say now); null when unset, and always for a secret. */
  readonly value: string | null;
  /** Whether it has a value: for a secret, all that is ever said of it. */
  readonly set: boolean;
  /** What a secret may say of itself: the database's address without its user and password; null otherwise. */
  readonly shown: string | null;
  readonly source: 'environment' | 'saved' | 'default';
  /** The variable that sets it, when the environment does. */
  readonly variable: string | null;
  /** Whether it can be changed here, and why not when it cannot. */
  readonly editable: boolean;
  readonly locked: LockReason | null;
  /** Its saved revision (0: never saved), for a change to say what it read (see HostSettings.change). */
  readonly revision: number;
  /** Whether its value waits for a restart (it applies then, and differs from the one in use). */
  readonly pending: boolean;
  /** The value in use while one waits for a restart (never for a secret). */
  readonly running: string | null;
  /** A saved value of it that was refused when jukecord started, why (the default or the environment's is in use). */
  readonly refused: string | null;
}

/** Everything the settings page shows. */
export interface SettingsView {
  readonly groups: readonly GroupDefinition[];
  readonly settings: readonly SettingState[];
  readonly restart: {
    /** The settings whose change waits for a restart. */
    readonly pending: readonly string[];
    /** What starts jukecord again after a restart. */
    readonly supervisor: string;
    /** Why a restart cannot be asked for here, or null. */
    readonly refusal: string | null;
  };
  /** Which service answers (one process is `all`). */
  readonly role: 'all' | 'core' | 'edge';
  /** Saved names that are no setting kept where they are (a newer jukecord's, a hand edit); left unused. */
  readonly strays: readonly string[];
}

/** One setting a change touched, as the change's summary shows it (a secret's values never). */
export interface ChangedSetting {
  readonly name: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly applies: 'now' | 'restart';
}

export interface HostSettingsOptions {
  /** The environment jukecord started with. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly files?: ConfigFiles;
  /** The database the runtime settings are saved in. */
  readonly store: Store;
  /** settings.json in the data folder. */
  readonly file: SettingsFile;
  readonly rules: LayerRules;
  /** The settings jukecord started with (what applies after a restart is compared with them). */
  readonly started: Config;
  /** What starts jukecord again after a restart. */
  readonly supervisor: Supervisor;
  /** Saved values refused at the start, by name, with their revision and why (see refusedAtStart). */
  readonly refused?: ReadonlyMap<string, { readonly revision: number; readonly why: string }>;
  /** Applies the settings that changed and apply at once, as the next Config has them. */
  readonly apply: (names: readonly string[], next: Config) => void;
  /** Restarts jukecord (stops it for its supervisor to start it again); absent where it cannot (tests). */
  readonly restart?: () => void;
  /** Tells every service that settings changed (in one process: this service's own take-in). */
  readonly announce?: (names: readonly string[]) => Promise<void>;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly role?: 'all' | 'core' | 'edge';
}

/** What the web layer asks of the settings (a split's edge carries it to its core as it carries the actions). */
export type HostSettingsPort = Pick<HostSettings, 'view' | 'change' | 'reset' | 'restartNow'>;

export class HostSettings {
  private readonly options: HostSettingsOptions;
  // One change at a time in this process, and one take-in at a time: each applies in the order they were made.
  private readonly changing = new Lock();
  private readonly takingIn = new Lock();
  // The settings in use: the start's, with every change that applies at once taken in since.
  private current: Config;

  constructor(options: HostSettingsOptions) {
    this.options = options;
    this.current = options.started;
  }

  /** The settings in use now (the start's, with the changes that apply at once). */
  get config(): Config {
    return this.current;
  }

  /** The saved values: settings.json's, and the database's (which may not answer: a ConnectionError). */
  async layers(): Promise<SavedLayers> {
    const file = this.options.file.read();
    const rows = await this.options.store.hostSettings.all();
    return { file, database: new Map(rows.map((row) => [row.name, row])) };
  }

  // The layers without the saved values refused at the start, while they are the ones refused (a newer save of one is
  // read again).
  private usable(layers: SavedLayers): SavedLayers {
    const refused = this.options.refused;
    if (!refused || refused.size === 0) return layers;
    const out = new Set<string>();
    for (const [name, entry] of refused) {
      const setting = findDefinition(name);
      if (setting && (savedOf(setting, layers)?.revision ?? 0) === entry.revision) out.add(name);
    }
    return out.size === 0 ? layers : withoutNames(layers, out);
  }

  // The settings over some layers, as they would read after a restart.
  private read(layers: SavedLayers): { config: Config | null; problems: readonly string[] } {
    const { env, cwd, files, rules } = this.options;
    return readLayers(env, cwd, files, this.usable(layers), rules);
  }

  /**
   * The environment as the settings read now: the real one with the saved values under it (the login settings' tests
   * read it, so a test without values tries what would apply after a restart).
   */
  async environment(): Promise<NodeJS.ProcessEnv> {
    const { env, rules } = this.options;
    try {
      return mergedEnvironment(env, this.usable(await this.layers()), rules);
    } catch (error) {
      if (error instanceof ConnectionError) throw new ActionError('unavailable', 'the database does not answer');
      throw error;
    }
  }

  /** Every setting with its value, where it comes from, and its state. */
  async view(): Promise<SettingsView> {
    let layers: SavedLayers;
    try {
      layers = await this.layers();
    } catch (error) {
      // The database not answering is said as such (503), not as jukecord's own failure.
      if (error instanceof ConnectionError) throw new ActionError('unavailable', 'the database does not answer');
      throw error;
    }
    return this.viewOf(layers);
  }

  // The view over layers already read.
  private viewOf(layers: SavedLayers): SettingsView {
    const { env, rules, started } = this.options;
    const usable = this.usable(layers);
    // As it would read after a restart; when that cannot be read (a saved value refused meanwhile), what runs.
    const next = this.read(layers).config ?? this.current;
    const settings = SETTINGS.filter((setting) => setting.panel !== false).map((setting): SettingState => {
      const source = sourceOf(setting, env, usable, rules);
      const variable = source.kind === 'environment' ? source.variable : null;
      const saved = savedOf(setting, layers);
      const locked: LockReason | null =
        setting.layer === 'environment'
          ? 'start'
          : variable !== null
            ? 'environment'
            : rules.environmentOnly(setting)
              ? 'split'
              : null;
      // The text as it reads: the environment's (not a file's, which is a secret's), the saved one, or the default.
      const text =
        source.kind === 'environment'
          ? variable === setting.name
            ? (env[setting.name]?.trim() ?? null)
            : null
          : source.kind === 'saved'
            ? (saved?.value ?? null)
            : setting.default;
      const pending = setting.applies === 'restart' && !sameValue(started, next, setting.name);
      const secret = setting.secret === true;
      const refused = this.options.refused?.get(setting.name);
      return {
        name: setting.name,
        group: setting.group,
        part: setting.part ?? null,
        kind: setting.kind,
        label: setting.label,
        help: setting.help,
        default: setting.default,
        defaultNote: setting.defaultNote ?? null,
        min: setting.min ?? null,
        max: setting.max ?? null,
        choices: setting.choices ?? null,
        separator: setting.separator ?? null,
        off: setting.off ?? null,
        words: setting.words ?? null,
        maxLength: setting.maxLength ?? null,
        applies: setting.applies,
        bootstrap: setting.layer === 'bootstrap',
        secret,
        roles: setting.roles,
        value: secret ? null : text,
        set: secret ? shownValue(next, setting.name) !== null : text !== null && text !== '',
        shown: setting.name === 'JUKECORD_DATABASE_URL' ? shownValue(next, setting.name) : null,
        source: source.kind,
        variable,
        editable: locked === null,
        locked,
        revision: saved?.revision ?? 0,
        pending,
        running: pending && !secret ? shownValue(started, setting.name) : null,
        refused:
          refused && (saved?.revision ?? 0) === refused.revision && source.kind !== 'environment' ? refused.why : null,
      };
    });
    const pending = settings.filter((setting) => setting.pending).map((setting) => setting.name);
    return {
      groups: GROUPS,
      settings,
      restart: {
        pending,
        supervisor: this.options.supervisor,
        refusal: restartRefusal(this.options.supervisor),
      },
      role: this.options.role ?? 'all',
      strays: strays(layers),
    };
  }

  /**
   * Changes settings: each name to its new text, or to null for its default. All or nothing: a change the settings'
   * rules refuse (as at the start, with the other settings as they are) changes nothing and says every problem; a
   * setting set by the environment cannot be changed here. With `revisions`, a setting changed meanwhile by someone
   * else (its revision is not the one given) is a conflict, and nothing is written.
   */
  async change(
    values: Readonly<Record<string, string | null>>,
    revisions?: Readonly<Record<string, number>>,
  ): Promise<{ changed: ChangedSetting[]; view: SettingsView }> {
    const release = await this.changing.acquire();
    let changed: ChangedSetting[];
    try {
      changed = await this.write(values, revisions);
    } finally {
      release();
    }
    // Every service takes the change in (here: what applies at once is applied, the rest waits for a restart).
    if (changed.length > 0)
      await (this.options.announce ?? ((names) => this.takeIn(names)))(changed.map((c) => c.name));
    return { changed, view: await this.view() };
  }

  /** Puts settings back to their defaults (or to the environment's value, which a saved one no longer hides). */
  reset(names: readonly string[], revisions?: Readonly<Record<string, number>>) {
    return this.change(Object.fromEntries(names.map((name) => [name, null])), revisions);
  }

  // The change itself, under the lock: checked, then written to the database and settings.json.
  private async write(
    values: Readonly<Record<string, string | null>>,
    revisions?: Readonly<Record<string, number>>,
  ): Promise<ChangedSetting[]> {
    const { env, rules } = this.options;
    const entries = Object.entries(values);
    if (entries.length === 0) throw new ActionError('invalid', 'say which settings to change');
    // Each name a setting this page can change.
    for (const [name] of entries) {
      const setting = findDefinition(name);
      if (!setting || setting.panel === false) throw new ActionError('invalid', `${name} is not a jukecord setting`);
      if (setting.layer === 'environment')
        throw new ActionError('conflict', `${name} is set where jukecord starts, not here`);
      const variable = environmentVariable(setting, env);
      if (variable !== null) throw new ActionError('conflict', `${name} is set by the environment (${variable})`);
      if (rules.environmentOnly(setting))
        throw new ActionError('conflict', `${name} comes from each service's environment in a split jukecord`);
    }
    let layers: SavedLayers;
    try {
      layers = await this.layers();
    } catch (error) {
      throw outage(error);
    }
    // Spaces around a value are no part of it (as the environment's are read); an empty value is the default.
    const changes: SettingWrite[] = [];
    for (const [name, value] of entries) {
      const setting = findDefinition(name) as SettingDefinition;
      const text = value === null ? null : value.trim() === '' ? null : value.trim();
      const saved = savedOf(setting, layers);
      // Saving what is saved already changes nothing (and keeps its revision).
      if ((saved?.value ?? null) === text) continue;
      changes.push({ name, value: text });
    }
    if (changes.length === 0) return [];
    // settings.json's revisions are this process's to check (only this jukecord writes its data folder's file).
    const fileChanges = changes.filter(
      (change) => storedIn(findDefinition(change.name) as SettingDefinition) === 'file',
    );
    const databaseChanges = changes.filter((change) => !fileChanges.includes(change));
    const staleInFile = fileChanges
      .map((change) => change.name)
      .filter((name) => revisions?.[name] !== undefined && (layers.file.get(name)?.revision ?? 0) !== revisions[name]);
    if (staleInFile.length > 0) throw conflict(staleInFile);
    // The settings as they would read with the change, by the start's rules, the other settings as they are: a
    // problem the change brings refuses it (one there before, a file gone meanwhile, is not this change's).
    const candidate = withChanges(layers, fileChanges, databaseChanges);
    const before = new Set(this.read(layers).problems);
    const after = this.read(candidate);
    const brought = problemsOf(after.problems.filter((problem) => !before.has(problem)));
    if (brought.length > 0) throw new SettingsRefused(brought);
    const shown = (config: Config | null, name: string): string | null =>
      config && !findDefinition(name)?.secret ? shownValue(config, name) : null;
    const was = this.read(layers).config;
    // The database's part first, in one transaction (it checks its own revisions): nothing written when it fails.
    let written: SavedSetting[] = [];
    if (databaseChanges.length > 0) {
      try {
        written = await this.options.store.hostSettings.write(databaseChanges, revisions);
      } catch (error) {
        if (error instanceof RevisionConflict) throw conflict(error.names);
        throw outage(error);
      }
    }
    // Then settings.json's; when it cannot be written, the database's part goes back to what it was.
    if (fileChanges.length > 0) {
      try {
        await this.options.file.write(fileChanges, revisions);
      } catch (error) {
        if (written.length > 0) await this.undo(databaseChanges, layers);
        if (error instanceof RevisionConflict) throw conflict(error.names);
        this.options.log.error('settings.json could not be written; nothing was saved', { error });
        throw new ActionError('unavailable', 'settings.json could not be written; nothing was saved');
      }
    }
    // Said in the log by name only: values (secrets among them) never go there.
    this.options.log.info('settings changed', { names: changes.map((change) => change.name) });
    return changes.map((change) => ({
      name: change.name,
      from: shown(was, change.name),
      to: shown(after.config, change.name),
      applies: findDefinition(change.name)?.applies ?? 'restart',
    }));
  }

  // Puts the database's rows of a change back to what they were (settings.json could not take its part).
  private async undo(changes: readonly SettingWrite[], layers: SavedLayers): Promise<void> {
    try {
      await this.options.store.hostSettings.write(
        changes.map((change) => ({ name: change.name, value: layers.database.get(change.name)?.value ?? null })),
      );
    } catch (error) {
      // The database refused the way back too: what it holds is the change, said so (the file kept what it had).
      this.options.log.error('a change was saved in the database but not in settings.json, and could not be undone', {
        names: changes.map((change) => change.name),
        error,
      });
    }
  }

  /**
   * Restarts jukecord: it stops as on SIGTERM, a moment after this answer, for its supervisor to start it again.
   * Refused, saying why, where nothing would start it again (a terminal running it by hand).
   */
  restartNow(): { readonly supervisor: Supervisor } {
    const refusal = restartRefusal(this.options.supervisor);
    if (refusal) throw new ActionError('conflict', refusal);
    const restart = this.options.restart;
    if (!restart) throw new ActionError('unavailable', 'jukecord cannot restart itself here');
    // A moment later: the answer reaches whoever asked before the panels are told that jukecord is restarting.
    setTimeout(restart, 200);
    this.options.log.info('restarting, as asked', { supervisor: this.options.supervisor });
    return { supervisor: this.options.supervisor };
  }

  /**
   * Takes in a change of the saved settings (this service's own, or another's, told by announce): what applies at
   * once is applied, in the order changes came; the rest waits for a restart (the view says so).
   */
  async takeIn(names: readonly string[] = []): Promise<void> {
    const release = await this.takingIn.acquire();
    try {
      let layers: SavedLayers;
      try {
        layers = await this.layers();
      } catch (error) {
        this.options.log.warn('could not read the saved settings to take a change in', { names, error });
        return;
      }
      const { config, problems } = this.read(layers);
      if (!config) {
        // Saved by another service with a value this one refuses (a file it does not have, say): what runs stays.
        this.options.log.warn('the saved settings are refused here; the ones in use stay', { problems });
        return;
      }
      const live = SETTINGS.filter(
        (setting) => setting.applies === 'now' && !sameValue(this.current, config, setting.name),
      ).map((setting) => setting.name);
      if (live.length > 0) {
        this.options.apply(live, config);
        this.options.log.info('settings applied', { names: live });
      }
      // What applies at once is in use now; the rest stays as it started (see view's pending).
      this.current = inUse(this.current, config);
    } finally {
      release();
    }
  }
}

// The layers with a change in them.
function withChanges(
  layers: SavedLayers,
  fileChanges: readonly SettingWrite[],
  databaseChanges: readonly SettingWrite[],
): SavedLayers {
  const file = new Map(layers.file);
  const database = new Map(layers.database);
  for (const change of fileChanges) {
    file.set(change.name, { ...change, revision: (file.get(change.name)?.revision ?? 0) + 1, updatedAt: Date.now() });
  }
  for (const change of databaseChanges) {
    database.set(change.name, {
      ...change,
      revision: (database.get(change.name)?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    });
  }
  return { file, database };
}

/**
 * The Config in use after a change is taken in: the next one's values of the settings that apply at once, the
 * current one's of the others (they wait for a restart). A test holds it to the settings table, setting by setting.
 */
export function inUse(current: Config, next: Config): Config {
  return {
    ...current,
    queueMax: next.queueMax,
    liveMax: next.liveMax,
    restAfterMs: next.restAfterMs,
    lyrics: next.lyrics,
    voice: { ...current.voice, idleMs: next.voice.idleMs },
    media: {
      ...current.media,
      cacheMaxBytes: next.media.cacheMaxBytes,
      prefetch: next.media.prefetch,
      trackMaxMs: next.media.trackMaxMs,
    },
    backups: next.backups,
    log: next.log,
    metrics: next.metrics,
    links: next.links,
  };
}

// A conflict: settings changed by someone else since they were read.
function conflict(names: readonly string[]): ActionError {
  return new ActionError('conflict', `changed by someone else meanwhile: ${names.join(', ')}; read them again`);
}

// The database not answering, said as such: nothing was saved.
function outage(error: unknown): unknown {
  if (error instanceof ConnectionError) {
    return new ActionError('unavailable', 'the database does not answer; nothing was saved', { retryAfterMs: 5000 });
  }
  return error;
}
