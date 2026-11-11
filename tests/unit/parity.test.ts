/**
 * The four ways in must offer the same things: every shared action is an API operation, a CLI command and a slash
 * command, and every API operation is a CLI command. (The panel joins this test in its own file, once it exists.)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTIONS } from '../../src/app/actions.ts';
import { COMMANDS } from '../../src/cli/commands.ts';
import { findCommand } from '../../src/cli/main.ts';
import { commandDefinitions, SLASH_COMMANDS } from '../../src/discord/commands.ts';
import { ACCOUNT_OPERATIONS, API, OPERATIONS } from '../../src/web/api.ts';

describe('parity of the ways in', () => {
  it('has an API operation for every action, plus the account operations, and nothing else', () => {
    assert.deepEqual([...OPERATIONS].sort(), [...ACTIONS, ...ACCOUNT_OPERATIONS].sort());
  });

  it('has a CLI command for every operation, each name typed one way only and found by its own words', () => {
    const names = OPERATIONS.map((operation) => COMMANDS[operation].name);
    assert.equal(new Set(names).size, names.length, 'two operations share a CLI name');
    for (const operation of OPERATIONS) {
      const found = findCommand(COMMANDS[operation].name.split(' '));
      assert.equal(found?.operation, operation, `"${COMMANDS[operation].name}" finds ${found?.operation}`);
    }
  });

  it('has a registered slash command for every action', () => {
    const registered = new Set(
      commandDefinitions().flatMap((definition) => {
        const subs = (definition.options ?? []).filter((option) => option.type === 1);
        return subs.length > 0 ? subs.map((sub) => `/${definition.name} ${sub.name}`) : [`/${definition.name}`];
      }),
    );
    for (const action of ACTIONS) {
      const slash = SLASH_COMMANDS[action];
      assert.ok(registered.has(slash), `${action} maps to ${slash}, which is not registered`);
    }
  });

  it('uses one path per method and operation', () => {
    const seen = new Set<string>();
    for (const operation of OPERATIONS) {
      const key = `${API[operation].method} ${API[operation].path}`;
      assert.ok(!seen.has(key), `${key} is used twice`);
      seen.add(key);
    }
  });
});
