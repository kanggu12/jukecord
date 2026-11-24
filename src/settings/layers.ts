/**
 * Where each setting's value comes from: the built-in default, under a saved value, under the environment.
 *
 * A variable with a value wins (the host's infrastructure as code stays the source of truth), and the panel shows the
 * setting locked with that variable's name. An empty one (`VAR=`, what Compose writes for an empty line of .env) is no
 * value, as loadConfig always read it: a saved value applies under it. A saved value is kept where its setting belongs
 * (settings.json for the bootstrap settings and the secrets, the database for the rest). In a split jukecord the
 * settings.json ones come from the environment only (the `environmentOnly` rule), as every service must read the same
 * and each has a data folder of its own.
 */
import { findDefinition, SETTINGS, type SettingDefinition, storedIn } from './definitions.ts';

/** A saved setting of either layer, as both keep them. */
export interface Saved {
  readonly value: string | null;
  readonly revision: number;
  readonly updatedAt: number;
}

/** The saved values: settings.json's, and the database's, by name. */
export interface SavedLayers {
  readonly file: ReadonlyMap<string, Saved>;
  readonly database: ReadonlyMap<string, Saved>;
}

/** No saved value anywhere (a store that cannot be read yet, or tests). */
export const NOTHING_SAVED: SavedLayers = { file: new Map(), database: new Map() };

/** Where a setting's value is from now. */
export type Source =
  | { readonly kind: 'environment'; readonly variable: string }
  | { readonly kind: 'saved'; readonly where: 'file' | 'database' }
  | { readonly kind: 'default' };

/** The rules of where values may come from; one predicate for a split jukecord's (see the module comment). */
export interface LayerRules {
  /** Whether a setting is read from the environment only (its saved value, if any, is not used). */
  environmentOnly(setting: SettingDefinition): boolean;
}

/** One process (role all): every setting may be saved, but the data folder itself. */
export const ONE_PROCESS: LayerRules = { environmentOnly: (setting) => setting.layer === 'environment' };

/** A split jukecord's services: what settings.json holds comes from each service's environment only. */
export const SPLIT: LayerRules = {
  environmentOnly: (setting) => setting.layer === 'environment' || storedIn(setting) === 'file',
};

// Whether a variable is given a value, as loadConfig reads it: something but spaces.
function given(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name]?.trim() ?? '') !== '';
}

/** The variable that sets a setting in the environment, its own or its _FILE twin, or null when neither has a value. */
export function environmentVariable(setting: SettingDefinition, env: NodeJS.ProcessEnv): string | null {
  if (given(env, setting.name)) return setting.name;
  if (setting.file && given(env, `${setting.name}_FILE`)) return `${setting.name}_FILE`;
  return null;
}

/** The saved value a setting would use, from the layer it belongs to, or null (none, or put back to its default). */
export function savedOf(setting: SettingDefinition, layers: SavedLayers): Saved | null {
  const where = storedIn(setting);
  if (where === 'nowhere') return null;
  return (where === 'file' ? layers.file : layers.database).get(setting.name) ?? null;
}

/** Where a setting's value is from now. */
export function sourceOf(
  setting: SettingDefinition,
  env: NodeJS.ProcessEnv,
  layers: SavedLayers,
  rules: LayerRules,
): Source {
  const variable = environmentVariable(setting, env);
  if (variable !== null) return { kind: 'environment', variable };
  const saved = rules.environmentOnly(setting) ? null : savedOf(setting, layers);
  if (saved?.value != null) return { kind: 'saved', where: storedIn(setting) === 'file' ? 'file' : 'database' };
  return { kind: 'default' };
}

/**
 * The environment loadConfig reads: the real one, with each saved value put under it where the environment gives that
 * setting none. Read by the same rules as at the start, a saved value is checked exactly as a variable would be.
 */
export function mergedEnvironment(env: NodeJS.ProcessEnv, layers: SavedLayers, rules: LayerRules): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const setting of SETTINGS) {
    if (sourceOf(setting, env, layers, rules).kind !== 'saved') continue;
    merged[setting.name] = savedOf(setting, layers)?.value ?? undefined;
  }
  return merged;
}

/** The names a layer holds that are no setting kept there (a newer jukecord's, or a hand edit): left unused. */
export function strays(layers: SavedLayers): string[] {
  const out: string[] = [];
  for (const [where, saved] of [
    ['file', layers.file],
    ['database', layers.database],
  ] as const) {
    for (const name of saved.keys()) {
      const setting = findDefinition(name);
      if (!setting || storedIn(setting) !== where) out.push(name);
    }
  }
  return out.sort();
}
