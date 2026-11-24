/**
 * Reading the settings over their layers by the start's rules (loadConfig over the environment with the saved values
 * under it), and the problems that gives, each with the settings it names. Shared by the start (src/main.ts, the db
 * command) and the settings service; nothing here needs the rest of jukecord.
 */
import { type Config, ConfigError, type ConfigFiles, loadConfig } from '../config.ts';
import { findDefinition, SETTINGS } from './definitions.ts';
import { type LayerRules, mergedEnvironment, type SavedLayers, savedOf, sourceOf } from './layers.ts';

/** A problem with the settings, and the settings it is about (by their names in the message). */
export interface SettingProblem {
  readonly names: readonly string[];
  readonly message: string;
}

// The settings each problem names: every JUKECORD_ word in its message, a _FILE twin as its setting.
function namesIn(message: string): string[] {
  const names = new Set<string>();
  for (const [word] of message.matchAll(/JUKECORD_[A-Z_]+/g)) {
    const own = findDefinition(word);
    const twin = word.endsWith('_FILE') ? findDefinition(word.slice(0, -'_FILE'.length)) : null;
    const setting = own ?? (twin?.file ? twin : null);
    if (setting) names.add(setting.name);
  }
  return [...names];
}

/** The problems of a list of loadConfig's, each with the settings it names. */
export function problemsOf(messages: readonly string[]): SettingProblem[] {
  return messages.map((message) => ({ names: namesIn(message), message }));
}

/**
 * Reads the settings over the layers as loadConfig reads them at the start: the Config, or every problem. `ignored`
 * leaves out saved values (by name) refused before.
 */
export function readLayers(
  env: NodeJS.ProcessEnv,
  cwd: string,
  files: ConfigFiles | undefined,
  layers: SavedLayers,
  rules: LayerRules,
): { config: Config | null; problems: readonly string[] } {
  try {
    return { config: loadConfig(mergedEnvironment(env, layers, rules), cwd, files), problems: [] };
  } catch (error) {
    if (error instanceof ConfigError) return { config: null, problems: error.problems };
    throw error;
  }
}

/**
 * The settings at the start, over the saved values: a saved value that the rules refuse now (a file gone, a limit of a
 * newer jukecord) is left out, said in the log, and shown on the page, instead of keeping jukecord from starting; a
 * problem of the environment's own stays a reason not to start, as before. Returns the Config, or the problems.
 */
export function startingSettings(
  env: NodeJS.ProcessEnv,
  cwd: string,
  files: ConfigFiles | undefined,
  layers: SavedLayers,
  rules: LayerRules,
): { config: Config | null; problems: readonly string[]; refused: Map<string, { revision: number; why: string }> } {
  const refused = new Map<string, { revision: number; why: string }>();
  let current = layers;
  // Each round leaves out the saved values the problems name; a round with none left to leave out is the answer.
  for (let round = 0; round <= SETTINGS.length; round += 1) {
    const read = readLayers(env, cwd, files, current, rules);
    if (read.config) return { config: read.config, problems: [], refused };
    const saved = new Set<string>();
    for (const problem of problemsOf(read.problems)) {
      for (const name of problem.names) {
        const setting = findDefinition(name);
        if (setting && sourceOf(setting, env, current, rules).kind === 'saved') {
          saved.add(name);
          const revision = savedOf(setting, current)?.revision ?? 0;
          if (!refused.has(name)) refused.set(name, { revision, why: problem.message });
        }
      }
    }
    if (saved.size === 0) return { config: null, problems: read.problems, refused };
    current = withoutNames(current, saved);
  }
  return { config: null, problems: ['the saved settings could not be read'], refused };
}

// The layers without the saved values of some settings.
export function withoutNames(layers: SavedLayers, names: ReadonlySet<string>): SavedLayers {
  const keep = <T>(map: ReadonlyMap<string, T>) => new Map([...map].filter(([name]) => !names.has(name)));
  return { file: keep(layers.file), database: keep(layers.database) };
}
