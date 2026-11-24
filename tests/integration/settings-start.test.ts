/**
 * jukecord itself (src/main.ts) with saved settings, as a host runs it: it starts on the port settings.json names, a
 * setting saved in the database applies at the start, a broken settings.json keeps it from starting, a restart exits
 * for its supervisor to start it again, and a database move switches: the last copy made, the new address saved, and
 * started again on it with every row. Each run is a jukecord of its own on a free port and a throwaway data folder,
 * browser-only (nothing reaches Discord).
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { SETTINGS_FILE } from '../../src/settings/file.ts';
import { RESTART_EXIT_CODE } from '../../src/settings/restart.ts';

const folders: string[] = [];
const running = new Set<ChildProcess>();
after(() => {
  // Whatever a failed test left running is stopped, by its own process.
  for (const child of running) child.kill('SIGKILL');
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
});

// A port nobody listens on now.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

// A jukecord started in a data folder: its output, and how it ended.
interface Run {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<number | null>;
}
function start(dataDir: string, env: Record<string, string> = {}): Run {
  let output = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    // A clean environment: no Discord token, no settings of the machine running the tests.
    env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), JUKECORD_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      running.delete(child);
      resolve(code);
    }),
  );
  return { child, output: () => output, exited };
}

// Waits for a line in a run's output (or its end).
async function said(run: Run, text: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!run.output().includes(text)) {
    if (Date.now() > until || run.child.exitCode !== null) assert.fail(`never said "${text}":\n${run.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The API of a running jukecord, as the host.
function client(port: number, dataDir: string) {
  return async (method: string, url: string, body?: unknown) => {
    const token = fs.readFileSync(path.join(dataDir, 'host-token'), 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
}

// A throwaway data folder.
function folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-start-'));
  folders.push(dir);
  return dir;
}

describe('jukecord with saved settings', () => {
  it('starts on the port settings.json names, with a level saved in the database, and restarts for its supervisor', async () => {
    const dataDir = folder();
    const port = await freePort();
    fs.writeFileSync(
      path.join(dataDir, SETTINGS_FILE),
      JSON.stringify({ version: 1, settings: { JUKECORD_PORT: { value: String(port), revision: 1, updatedAt: 1 } } }),
      { mode: 0o600 },
    );
    const first = start(dataDir, { JUKECORD_SUPERVISOR: 'docker' });
    await said(first, 'the panel and the API are up');
    const api = client(port, dataDir);
    // Saved now in the database: it waits for nothing, and the next start reads it there.
    const changed = await api('PATCH', '/settings', { values: { JUKECORD_LOG_LEVEL: 'debug' } });
    assert.equal(changed.status, 200);
    const restarted = await api('POST', '/restart');
    assert.deepEqual(restarted.json, { supervisor: 'docker', restarts: true });
    assert.equal(await first.exited, RESTART_EXIT_CODE);
    assert.match(first.output(), /restarting signal=restart/);
    // Started again (as Docker would): the level saved in the database is in use from the start.
    const second = start(dataDir, { JUKECORD_SUPERVISOR: 'docker' });
    await said(second, 'the panel and the API are up');
    const level = await client(port, dataDir)('GET', '/settings/JUKECORD_LOG_LEVEL');
    assert.deepEqual([level.json.value, level.json.source, level.json.pending], ['debug', 'saved', false]);
    second.child.kill('SIGTERM');
    assert.equal(await second.exited, 0);
  });

  it('refuses a restart where nothing would start it again, and does not start on a settings.json it cannot read', async () => {
    const dataDir = folder();
    const port = await freePort();
    const run = start(dataDir, { JUKECORD_PORT: String(port) });
    await said(run, 'the panel and the API are up');
    const refused = await client(port, dataDir)('POST', '/restart');
    assert.equal(refused.status, 409);
    run.child.kill('SIGTERM');
    assert.equal(await run.exited, 0);
    fs.writeFileSync(path.join(dataDir, SETTINGS_FILE), '{ half a file');
    const broken = start(dataDir, { JUKECORD_PORT: String(port) });
    assert.equal(await broken.exited, 2);
    assert.match(broken.output(), /jukecord cannot start with these settings:\n- .*settings\.json is not JSON/);
  });

  it('moves to another database: copied while it runs, the last rows at the switch, started again on it', async () => {
    const dataDir = folder();
    const port = await freePort();
    const first = start(dataDir, { JUKECORD_PORT: String(port), JUKECORD_SUPERVISOR: 'launcher' });
    await said(first, 'the panel and the API are up');
    const api = client(port, dataDir);
    const tested = await api('POST', '/settings/test-database', { url: 'sqlite:moved.db' });
    assert.deepEqual([tested.json.ok, tested.json.newFile], [true, true]);
    assert.equal((await api('POST', '/settings/database-move', { url: 'sqlite:moved.db' })).status, 200);
    let phase = '';
    for (let tries = 0; tries < 200 && phase !== 'copied'; tries += 1) {
      phase = String(((await api('GET', '/settings/database-move')).json.state as { phase: string }).phase);
      if (phase === 'failed') assert.fail('the copy failed');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Written after the copy: an API token. The switch's last copy carries it.
    const token = await api('POST', '/tokens', { name: 'after the copy', scope: 'read' });
    assert.equal(token.status, 200);
    assert.deepEqual((await api('POST', '/settings/database-move/switch')).json, {
      supervisor: 'launcher',
      restarts: true,
    });
    assert.equal(await first.exited, RESTART_EXIT_CODE);
    assert.match(first.output(), /moved to another database; jukecord starts on it now/);
    // The address is saved where the start reads it before the database opens.
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, SETTINGS_FILE), 'utf8'));
    assert.equal(saved.settings.JUKECORD_DATABASE_URL.value, 'sqlite:moved.db');
    const second = start(dataDir, { JUKECORD_PORT: String(port), JUKECORD_SUPERVISOR: 'launcher' });
    await said(second, 'the panel and the API are up');
    assert.match(
      second.output(),
      new RegExp(`database=SQLite \\(${path.join(dataDir, 'moved.db').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\)`),
    );
    const tokens = (await client(port, dataDir)('GET', '/tokens')).json as unknown as { name: string }[];
    assert.ok(
      tokens.some((entry) => entry.name === 'after the copy'),
      'the token made after the copy is not there',
    );
    second.child.kill('SIGTERM');
    assert.equal(await second.exited, 0);
  });
});
