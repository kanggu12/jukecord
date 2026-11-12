// The walk's states in groups, so that several walks at once cover the whole panel (the look workflow's matrix, or by
// hand: ONLY="$(node tests/ui/groups.ts 2 4)" tests/ui/run.sh <folder>). One walk of every state took 40 of the
// workflow's 45 minutes; four at once take about a quarter of that each.
//
//   node tests/ui/groups.ts <group> <groups>     prints that group's ONLY list (groups numbered from 0)
import fs from 'node:fs';

// What a walk takes by name that is not a state: the README's pictures, the panel's pictures and the two playing-along
// checks. A whole walk (ONLY unset) takes them, so a walk in groups must too: the last group does.
export const EXTRAS = ['readme', 'pictures', 'listening', 'listening-sound'];

/** Every state of the walk, in its order: each sweep('name' ...), with the name on the same line or the next. */
export function walkStates(text: string): string[] {
  const names = [...text.matchAll(/sweep\(\s*'([a-z0-9-]+)'/g)].map((match) => match[1] ?? '');
  // A name swept twice (none is now) is walked once.
  return [...new Set(names)];
}

/** Every name the walk takes besides its states (ONLY.has('...')): each must be one of EXTRAS, or a group misses it. */
export function walkExtras(text: string): string[] {
  return [...new Set([...text.matchAll(/ONLY\.has\('([a-z0-9-]+)'\)/g)].map((match) => match[1] ?? ''))];
}

/**
 * One group's names: the states dealt out in turn (so each group has a share of the sweeps at every window size, which
 * take longest), and the extras with the last group.
 */
export function groupOf(states: readonly string[], index: number, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('the number of groups must be a whole number from 1');
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`the group is 0 to ${count - 1}`);
  const mine = states.filter((_, at) => at % count === index);
  return index === count - 1 ? [...mine, ...EXTRAS] : mine;
}

if (import.meta.main) {
  // The walk beside this file, read as it is now: a new state joins a group without anyone listing it here.
  const text = fs.readFileSync(new URL('walk.mjs', import.meta.url), 'utf8');
  const [index = Number.NaN, count = Number.NaN] = process.argv.slice(2).map(Number);
  process.stdout.write(`${groupOf(walkStates(text), index, count).join(',')}\n`);
}
