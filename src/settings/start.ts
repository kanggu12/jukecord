/**
 * Reading the settings at the start, in the two steps the saved values need: first what is needed before the database
 * opens (where it is, where jukecord listens, the log, the bot's token), from the environment and settings.json; then,
 * with the database open, everything, with the values saved there too.
 *
 * A host who never saved a setting reads exactly what loadConfig read before: no saved value, the same environment.
 */
import path from 'node:path';
import { type Config, ConfigError, type ConfigFiles, loadConfig } from '../config.ts';
import { definition, findDefinition, SETTINGS, storedIn } from './definitions.ts';
import type { FileSettings } from './file.ts';
import { environmentVariable, type LayerRules, mergedEnvironment, NOTHING_SAVED, type SavedLayers } from './layers.ts';
import { problemsOf, startingSettings } from './read.ts';

/** The data folder as loadConfig reads it (the environment's alone: settings.json is in it). */
export function dataFolderOf(env: NodeJS.ProcessEnv, cwd: string): string {
  return path.resolve(cwd, env.JUKECORD_DATA_DIR?.trim() || (definition('JUKECORD_DATA_DIR').default ?? 'data'));
}

// What the first step reads: the bootstrap settings, the log's (the log is made before the database opens) and the
// bot's token (the start's first line says whether there is one), each with its _FILE twin.
const FIRST = new Set(
  SETTINGS.filter(
    (setting) =>
      setting.layer !== 'runtime' || setting.group === 'logging' || setting.name === 'JUKECORD_DISCORD_TOKEN',
  )
    .filter((setting) => setting.name !== 'JUKECORD_METRICS_TOKEN')
    .flatMap((setting) => (setting.file ? [setting.name, `${setting.name}_FILE`] : [setting.name])),
);

/**
 * The first step: the settings needed before the database opens, from the environment and settings.json. The rest
 * of the Config is at its defaults (the second step reads it). Problems here cannot be mended by the database's saved
 * values (the environment wins over them): they keep jukecord from starting, as before, with every other problem the
 * environment and settings.json give said with them.
 */
export function firstSettings(
  env: NodeJS.ProcessEnv,
  cwd: string,
  file: FileSettings,
  rules: LayerRules,
  files?: ConfigFiles,
): { config: Config | null; problems: readonly string[]; refused: Map<string, { revision: number; why: string }> } {
  const only = Object.fromEntries(Object.entries(env).filter(([name]) => FIRST.has(name)));
  const fileOnly = new Map([...file].filter(([name]) => FIRST.has(name)));
  const first = startingSettings(only, cwd, files, { file: fileOnly, database: new Map() }, rules);
  if (first.config) return first;
  // Every problem at once, as loadConfig lists them (the database's values unknown yet).
  try {
    loadConfig(mergedEnvironment(env, { file, database: new Map() }, rules), cwd, files);
  } catch (error) {
    if (error instanceof ConfigError) return { ...first, problems: error.problems };
    throw error;
  }
  return first;
}

/**
 * The problems of the environment and settings.json that no value saved in the database could mend: a value of their
 * own that is wrong, alone or with others they set. Said before the start's first line, as one reading of the
 * environment said them before there were saved settings; jukecord does not start. A problem that names a setting
 * the database may hold (one half of a pair, the other saved there) waits for the second step, which knows.
 */
export function settledProblems(
  env: NodeJS.ProcessEnv,
  cwd: string,
  file: FileSettings,
  rules: LayerRules,
  files?: ConfigFiles,
): readonly string[] {
  const read = startingSettings(env, cwd, files, { file, database: new Map() }, rules);
  if (read.config) return [];
  // A setting the database may give a value: kept there, and set neither by the environment nor only by it.
  const fromDatabase = (name: string): boolean => {
    const setting = findDefinition(name);
    return (
      setting !== null &&
      storedIn(setting) === 'database' &&
      !rules.environmentOnly(setting) &&
      environmentVariable(setting, env) === null
    );
  };
  return problemsOf(read.problems)
    .filter((problem) => !problem.names.some(fromDatabase))
    .map((problem) => problem.message);
}

/** The second step: every setting over every layer (see startingSettings). */
export function allSettings(
  env: NodeJS.ProcessEnv,
  cwd: string,
  layers: SavedLayers,
  rules: LayerRules,
  files?: ConfigFiles,
): ReturnType<typeof startingSettings> {
  return startingSettings(env, cwd, files, layers ?? NOTHING_SAVED, rules);
}
