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
import { type DiscordLoginTest, testDiscordLogin } from './discord.ts';
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
import type { DatabaseMove, DatabaseTest, MoveFailure, MoveState } from './move.ts';
import { problemsOf, readLayers, type SettingProblem, withoutNames } from './read.ts';
import { restartRefusal } from './restart.ts';
import { type ServerTest, type ServerUse, testServer } from './servers.ts';
import { sameValue, shownValue } from './values.ts';

/** A change refused by the settings' rules: every problem it would bring, each with the settings it is about. */
// The secrets that are addresses: shown as where they are (their user and password left out).
const SHOWN = new Set(['JUKECORD_DATABASE_URL', 'JUKECORD_BUS_URL', 'JUKECORD_CACHE_URL']);

export type { SettingProblem } from './read.ts';
export { startingSettings } from './read.ts';

export class SettingsRefused extends ActionError {
  constructor(problems: readonly SettingProblem[]) {
    super('invalid', problems.map((problem) => problem.message).join('; '), { problems });
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

/** A service of a split jukecord, as the page's Services section lists it. */
export interface ServiceInfo {
  readonly role: 'core' | 'edge';
  /** Its run's name on the bus (a new one at every start). */
  readonly name: string;
  readonly version: string;
  /** When it started; null when it did not say. */
  readonly startedAt: number | null;
  /** Whether it is ready to serve (its readiness check), when it said. */
  readonly ready: boolean | null;
  /** When it was last heard of. */
  readonly seenAt: number;
}

/** How a restart ends: its exit code, what runs before the database closes, and how long it all may take. */
export interface RestartOptions {
  readonly code?: number;
  readonly last?: () => Promise<void>;
  readonly withinMs?: number;
}

/** Everything the settings page shows. */
export interface HostSettingsView {
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
  /** The database move under way or done, and the last switch that did not finish (from the run before). */
  readonly move: { readonly state: MoveState | null; readonly lastFailure: MoveFailure | null };
  /** The services of a split jukecord (the core and each edge); none in one process. */
  readonly services: readonly ServiceInfo[];
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
  /**
   * Restarts jukecord (stops it as on SIGTERM and exits with `code`, for its supervisor to start it again), running
   * `last` once every part that writes has stopped and before the database closes, within `withinMs` in all; absent
   * where it cannot (tests).
   */
  readonly restart?: (options?: RestartOptions) => void;
  /** The database move (src/settings/move.ts); absent where none can be made (tests of the rest). */
  readonly move?: DatabaseMove;
  /** The services of a split jukecord, for the page's Services section (the core's settings service has them). */
  readonly services?: () => Promise<readonly ServiceInfo[]>;
  /** Tells every service that settings changed (in one process: this service's own take-in). */
  readonly announce?: (names: readonly string[]) => Promise<void>;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly role?: 'all' | 'core' | 'edge';
  /** Discord's API for the Discord login's test (tests only: they never reach Discord). */
  readonly discord?: { readonly api?: string; readonly fetch?: typeof fetch };
}

// The service's methods the web layer calls.
type PortMethod =
  | 'view'
  | 'change'
  | 'reset'
  | 'restartNow'
  | 'testDatabase'
  | 'testServer'
  | 'testDiscordLogin'
  | 'startMove'
  | 'moveState'
  | 'cancelMove'
  | 'switchMove';

/**
 * What the web layer asks of the settings: the service itself in one process, the core's over the bus in a split's
 * edge (src/settings/bus.ts), each answer now or later.
 */
export type HostSettingsPort = {
  readonly [K in PortMethod]: (
    ...args: Parameters<HostSettings[K]>
  ) => Awaited<ReturnType<HostSettings[K]>> | Promise<Awaited<ReturnType<HostSettings[K]>>>;
};

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

  /** What starts jukecord again after a restart. */
  get supervisor(): Supervisor {
    return this.options.supervisor;
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
  async view(): Promise<HostSettingsView> {
    let layers: SavedLayers;
    try {
      layers = await this.layers();
    } catch (error) {
      // The database not answering is said as such (503), not as jukecord's own failure.
      if (error instanceof ConnectionError) throw new ActionError('unavailable', 'the database does not answer');
      throw error;
    }
    const services = (await this.options.services?.()) ?? [];
    return { ...this.viewOf(layers), services };
  }

  // The view over layers already read (the services are added by view()).
  private viewOf(layers: SavedLayers): Omit<HostSettingsView, 'services'> {
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
        // What an address that holds a password may say of itself (where it is, never who).
        shown: SHOWN.has(setting.name) ? shownValue(next, setting.name) : null,
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
      move: { state: this.options.move?.current ?? null, lastFailure: this.options.move?.lastFailure() ?? null },
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
  ): Promise<{ changed: ChangedSetting[]; view: HostSettingsView }> {
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
    const entries = Object.entries(values);
    if (entries.length === 0) throw new ActionError('invalid', 'say which settings to change');
    // Each name a setting this page can change.
    for (const [name] of entries) this.changeable(name);
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
    // A saved secret is never sent to a place the change moves its way to (another directory, another provider, the
    // same directory unencrypted): the host types it again for the new place, or puts it away.
    const moved = secretsMoved(layers, changes);
    if (moved.length > 0) throw new SettingsRefused(moved);
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

  /** Tries a database's address without saving or changing anything (see DatabaseMove.test). */
  testDatabase(url: string): Promise<DatabaseTest> {
    return this.mover().test(url);
  }

  /**
   * Tests the Discord login's application with the settings as they are, or with the page's values not saved yet:
   * its client ID and secret at Discord's token endpoint, and the address Discord sends people back to
   * (src/settings/discord.ts). Only Discord's own address is asked, so a saved secret goes nowhere a request names.
   */
  async testDiscordLogin(values: Readonly<Record<string, string>> = {}): Promise<DiscordLoginTest> {
    // The login's own settings, and the ones its return address is made of; nothing else is the form's to try here.
    for (const name of Object.keys(values))
      if (!DISCORD_LOGIN.includes(name)) throw new ActionError('invalid', `${name} is no setting of the Discord login`);
    let layers: SavedLayers;
    try {
      layers = await this.layers();
    } catch (error) {
      throw outage(error);
    }
    // The settings as they would read with the form's values, by the start's rules (the environment still wins).
    const changes = Object.entries(values).map(([name, value]) => ({
      name,
      value: value.trim() === '' ? null : value.trim(),
    }));
    const inFile = changes.filter((change) => storedIn(findDefinition(change.name) as SettingDefinition) === 'file');
    const read = this.read(
      withChanges(
        layers,
        inFile,
        changes.filter((change) => !inFile.includes(change)),
      ),
    );
    // Settings that do not read (a malformed ID, say): their own problems, as a save would say them.
    if (!read.config) throw new SettingsRefused(problemsOf(read.problems));
    const config = read.config;
    const publicUrl = config.publicUrl ?? `http://localhost:${config.publishedPort}`;
    return testDiscordLogin({
      clientId: config.discord.clientId,
      clientSecret: config.discord.clientSecret,
      redirectUri: `${publicUrl}/auth/callback`,
      ...(this.options.discord ?? {}),
    });
  }

  /** Tries an address for the shared cache or the bus without saving or changing anything (src/settings/servers.ts). */
  testServer(url: string, use: ServerUse): Promise<ServerTest> {
    return testServer(url, use);
  }

  /**
   * Starts moving to another database: refused where the database's address is not this page's to change (set by
   * the environment, or a split's); the copy runs on, its state in moveState().
   */
  async startMove(url: string, replace: boolean): Promise<MoveState> {
    this.changeable('JUKECORD_DATABASE_URL');
    const move = this.mover();
    const state = await move.start(url, replace);
    // A new move: the last one's failure is no news any more.
    move.clearFailure();
    this.options.log.info('moving to another database: copying', { to: state.where, replace });
    return state;
  }

  /** The move under way or done, and the last switch that did not finish. */
  moveState(): { readonly state: MoveState | null; readonly lastFailure: MoveFailure | null } {
    const move = this.mover();
    return { state: move.current, lastFailure: move.lastFailure() };
  }

  /** Stops a move's copy under way (the target keeps what it held) and forgets the move. */
  async cancelMove(): Promise<void> {
    await this.mover().cancel();
    this.options.log.info('the database move was cancelled');
  }

  /**
   * Switches to the database a finished copy went into: jukecord stops as for a restart, copies once more after every
   * part that writes has stopped, writes the new address to settings.json, and starts again on it (where nothing
   * would start it again, it stays stopped and uses the new database when started). A failure of that last copy
   * writes nothing: jukecord starts again on the database it used, and the page says why.
   */
  switchMove(): { readonly where: string; readonly restarts: boolean; readonly supervisor: Supervisor } {
    this.changeable('JUKECORD_DATABASE_URL');
    const move = this.mover();
    const restart = this.options.restart;
    if (!restart) throw new ActionError('unavailable', 'jukecord cannot restart itself here');
    const { where } = move.switching();
    const restarts = restartRefusal(this.options.supervisor) === null;
    // The last copy may take as long as the first did, and then some: the stop waits for it.
    const copyMs = move.current?.ms ?? 0;
    const last = async () => {
      try {
        const url = await move.finalCopy();
        await this.options.file.write([{ name: 'JUKECORD_DATABASE_URL', value: url }]);
        move.clearFailure();
        this.options.log.info('moved to another database; jukecord starts on it now', { to: where });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        move.recordFailure(reason);
        this.options.log.error('the move to another database did not finish; the database in use stays', {
          to: where,
          reason,
        });
      }
    };
    const withinMs = 10_000 + 3 * copyMs + 30_000;
    // Started again (the restart's own code), or stopped for good where nothing starts it again (0: a clean stop).
    setTimeout(() => restart(restarts ? { last, withinMs } : { code: 0, last, withinMs }), 200);
    this.options.log.info('switching to another database', { to: where, restarts });
    return { where, restarts, supervisor: this.options.supervisor };
  }

  // The move, where one can be made.
  private mover(): DatabaseMove {
    const move = this.options.move;
    if (!move) throw new ActionError('unavailable', 'the database cannot be moved from here');
    return move;
  }

  // Refuses a setting this page cannot change here (the environment's, the data folder, a split's), saying why.
  private changeable(name: string): void {
    const { env, rules } = this.options;
    const setting = findDefinition(name);
    if (!setting || setting.panel === false) throw new ActionError('invalid', `${name} is not a jukecord setting`);
    if (setting.layer === 'environment')
      throw new ActionError('conflict', `${name} is set where jukecord starts, not here`);
    const variable = environmentVariable(setting, env);
    if (variable !== null) throw new ActionError('conflict', `${name} is set by the environment (${variable})`);
    if (rules.environmentOnly(setting))
      throw new ActionError('conflict', `${name} comes from each service's environment in a split jukecord`);
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

// The secrets that go to a place other settings name: the directory's service password goes to its address, over its
// StartTLS, as its service account; the identity provider's client secret to its issuer, as its client.
const DESTINATIONS: readonly { readonly secret: string; readonly to: readonly string[] }[] = [
  {
    secret: 'JUKECORD_LDAP_BIND_PASSWORD',
    to: ['JUKECORD_LDAP_URL', 'JUKECORD_LDAP_STARTTLS', 'JUKECORD_LDAP_BIND_DN'],
  },
  { secret: 'JUKECORD_OIDC_CLIENT_SECRET', to: ['JUKECORD_OIDC_ISSUER', 'JUKECORD_OIDC_CLIENT_ID'] },
];

/**
 * The problems of a change that would send a saved secret to a new place: one of the settings that say where the
 * secret goes changes (and its way stays on), the secret is saved, and the change gives no new one for it.
 */
export function secretsMoved(
  layers: SavedLayers,
  changes: readonly SettingWrite[],
): { names: string[]; message: string }[] {
  const problems: { names: string[]; message: string }[] = [];
  const changed = new Map(changes.map((change) => [change.name, change.value]));
  for (const { secret, to } of DESTINATIONS) {
    const moving = to.filter((name) => changed.has(name));
    if (moving.length === 0) continue;
    // The first of them is the way's address: put back to nothing, the way is off and the secret goes nowhere.
    const address = to[0] ?? '';
    const addressAfter = changed.has(address) ? changed.get(address) : (layers.database.get(address)?.value ?? '');
    if (changed.has(address) && addressAfter === null) continue;
    // Saved (in settings.json, where secrets are kept), and not given again or put away by this change.
    const saved = layers.file.get(secret)?.value ?? null;
    if (saved === null || changed.has(secret)) continue;
    problems.push({
      names: [secret, ...moving],
      message: `${secret}: type it again for the new ${moving.join(', ')}; a saved secret is not sent to another place`,
    });
  }
  return problems;
}

// The settings the Discord login's test takes from the page's form: its own, and what its return address is made of.
const DISCORD_LOGIN = [
  'JUKECORD_DISCORD_CLIENT_ID',
  'JUKECORD_DISCORD_CLIENT_SECRET',
  'JUKECORD_PUBLIC_URL',
  'JUKECORD_PUBLISHED_PORT',
];

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
