import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTIONS } from '../../src/app/actions.ts';
import { commandDefinitions, SLASH_COMMANDS } from '../../src/discord/commands.ts';

// Discord's rule for command and option names (lower case; Korean letters have no case and pass).
const NAME = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

// Every command and option, with its localized names and descriptions, flattened for checking.
function walk(
  node: {
    name: string;
    description?: string;
    name_localizations?: Record<string, string> | null;
    description_localizations?: Record<string, string> | null;
    options?: unknown[];
  },
  out: { name: string; description: string; ko: string | undefined; koDescription: string | undefined }[],
): void {
  out.push({
    name: node.name,
    description: node.description ?? '',
    ko: node.name_localizations?.ko,
    koDescription: node.description_localizations?.ko,
  });
  for (const child of node.options ?? []) walk(child as Parameters<typeof walk>[0], out);
}

describe('slash commands', () => {
  it('reach every action', () => {
    // The record type already forces an entry per action; this also checks the commands exist.
    const registered = new Set(commandDefinitions().map((command) => command.name));
    for (const action of ACTIONS) {
      const top = SLASH_COMMANDS[action].split(' ')[0]?.slice(1) ?? '';
      assert.ok(registered.has(top), `${action} -> ${SLASH_COMMANDS[action]} is not registered`);
    }
  });

  it('follow Discord limits and carry Korean names and descriptions everywhere', () => {
    const all: Parameters<typeof walk>[1] = [];
    for (const command of commandDefinitions()) walk(command as Parameters<typeof walk>[0], all);
    for (const entry of all) {
      assert.match(entry.name, NAME, entry.name);
      assert.ok(entry.ko && NAME.test(entry.ko), `${entry.name} has no valid Korean name`);
      assert.ok(entry.description.length >= 1 && entry.description.length <= 100, `${entry.name}: description length`);
      assert.ok(entry.koDescription && entry.koDescription.length <= 100, `${entry.name} has no Korean description`);
    }
  });
});
