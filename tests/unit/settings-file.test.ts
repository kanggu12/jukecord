/**
 * settings.json (src/settings/file.ts): written whole and the user's alone, read back as written, put back after a
 * change that could not be finished, and refused when it is not what jukecord writes (starting on the default
 * database instead of the one it names would look like lost data).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readSettingsFile, SETTINGS_FILE, SettingsFile, SettingsFileError } from '../../src/settings/file.ts';
import { ONE_PROCESS } from '../../src/settings/layers.ts';
import { firstSettings } from '../../src/settings/start.ts';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-settings-file-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('settings.json', () => {
  it('is nothing saved when there is no file', () => {
    assert.equal(readSettingsFile(dir).size, 0);
  });

  it('writes entries whole, a revision up each time, the file the user’s alone', async () => {
    const file = new SettingsFile(dir, () => 1000);
    await file.write([{ name: 'JUKECORD_PORT', value: '8796' }]);
    await file.write([
      { name: 'JUKECORD_PORT', value: '8797' },
      { name: 'JUKECORD_HOST', value: '0.0.0.0' },
    ]);
    const read = readSettingsFile(dir);
    assert.deepEqual(read.get('JUKECORD_PORT'), { name: 'JUKECORD_PORT', value: '8797', revision: 2, updatedAt: 1000 });
    assert.equal(read.get('JUKECORD_HOST')?.revision, 1);
    assert.equal(fs.statSync(path.join(dir, SETTINGS_FILE)).mode & 0o777, 0o600);
    // As people read it: sorted by name, two spaces, a line at the end.
    const text = fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8');
    assert.ok(text.indexOf('JUKECORD_HOST') < text.indexOf('JUKECORD_PORT'));
    assert.ok(text.endsWith('}\n'));
  });

  it('refuses a stale revision, and puts entries back as they were', async () => {
    const file = new SettingsFile(dir);
    await file.write([{ name: 'JUKECORD_PORT', value: '8796' }]);
    const before = file.read();
    await assert.rejects(file.write([{ name: 'JUKECORD_PORT', value: '9' }], { JUKECORD_PORT: 0 }), /meanwhile/);
    await file.write([
      { name: 'JUKECORD_PORT', value: '8800' },
      { name: 'JUKECORD_HOST', value: '0.0.0.0' },
    ]);
    await file.restore(before, ['JUKECORD_PORT', 'JUKECORD_HOST']);
    const after = file.read();
    assert.equal(after.get('JUKECORD_PORT')?.value, '8796');
    assert.equal(after.has('JUKECORD_HOST'), false);
  });

  it('is refused when it is not JSON, not of this jukecord, or an entry is not a saved setting', () => {
    const write = (text: string) => fs.writeFileSync(path.join(dir, SETTINGS_FILE), text);
    write('{ not json');
    assert.throws(
      () => readSettingsFile(dir),
      (error: unknown) => error instanceof SettingsFileError && /not JSON/.test(error.message),
    );
    write('{"version":2,"settings":{}}');
    assert.throws(() => readSettingsFile(dir), /not a settings file this jukecord writes/);
    write('{"version":1,"settings":{"JUKECORD_PORT":{"value":8796,"revision":1,"updatedAt":1}}}');
    assert.throws(() => readSettingsFile(dir), /JUKECORD_PORT is not a saved setting/);
  });

  it('gives the first step of the start its bootstrap values, under the environment', async () => {
    const file = new SettingsFile(dir);
    await file.write([
      { name: 'JUKECORD_PORT', value: '8796' },
      { name: 'JUKECORD_HOST', value: '0.0.0.0' },
    ]);
    const first = firstSettings({ JUKECORD_HOST: '127.0.0.1' }, '/srv', file.read(), ONE_PROCESS);
    assert.equal(first.config?.port, 8796);
    // The environment wins over what was saved.
    assert.equal(first.config?.host, '127.0.0.1');
  });

  it('lists every problem of the environment and settings.json at once when the first step fails', () => {
    const first = firstSettings({ JUKECORD_PORT: 'x', JUKECORD_QUEUE_MAX: '5' }, '/srv', new Map(), ONE_PROCESS);
    assert.equal(first.config, null);
    assert.deepEqual(first.problems, [
      'JUKECORD_PORT: "x" is not a whole number',
      'JUKECORD_QUEUE_MAX: 5 is outside 10-100000',
    ]);
  });
});
