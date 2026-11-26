/**
 * The host's settings while jukecord runs (src/settings/service.ts): where each value comes from (the default, a
 * saved value, the environment, which wins and locks it), a change checked by the start's rules and kept whole or not
 * at all, revisions against a change written over unseen, secrets never shown or logged, what applies at once handed
 * on and what waits for a restart said, saved values refused at the start, and the database away during a change.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ActionError } from '../../src/app/actions.ts';
import { type Config, loadConfig } from '../../src/config.ts';
import { createLogger, MemorySink } from '../../src/log.ts';
import { SETTINGS } from '../../src/settings/definitions.ts';
import { readSettingsFile, SETTINGS_FILE, SettingsFile } from '../../src/settings/file.ts';
import { mergedEnvironment, ONE_PROCESS, SPLIT, sourceOf } from '../../src/settings/layers.ts';
import { DatabaseMove } from '../../src/settings/move.ts';
import { supervisorOf } from '../../src/settings/restart.ts';
import { HostSettings, type RestartOptions, SettingsRefused, startingSettings } from '../../src/settings/service.ts';
import { allSettings, firstSettings } from '../../src/settings/start.ts';
import { valueIn } from '../../src/settings/values.ts';
import { ConnectionError } from '../../src/store/network.ts';
import type { Store } from '../../src/store/store.ts';
import { Store as SqliteStore } from '../../src/store/store.ts';
import { eachDatabase } from '../support/databases.ts';
import { addTracks, memoryStore } from '../support/store.ts';

// A made-up Discord token and Spotify secret, to look for in every answer and log line (put together here: a whole
// token written in the source is what secret scanners stop at).
const TOKEN = ['MTA4ODc2NTQzMjEwOTg3NjU0Mw', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.');
const SPOTIFY_SECRET = 'spotify-secret-made-up-0123456789';
const SPOTIFY_ID = 'abcdefabcdefabcdefabcdefabcdefab';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

// A service over a store, a data folder of the test's own and an environment; what it applied is recorded.
async function setup(
  options: {
    env?: NodeJS.ProcessEnv;
    store?: Store;
    supervisor?: 'docker' | 'none';
    restart?: (options?: RestartOptions) => void;
    answerMs?: number;
    move?: DatabaseMove;
  } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-settings-'));
  folders.push(dataDir);
  const env = { JUKECORD_DATA_DIR: dataDir, ...(options.env ?? {}) };
  const store = options.store ?? (await memoryStore());
  const sink = new MemorySink();
  const log = createLogger({ level: 'debug', sinks: [sink] });
  const started = loadConfig(env, '/srv');
  const applied: { names: readonly string[]; next: Config }[] = [];
  const file = new SettingsFile(dataDir);
  const settings = new HostSettings({
    env,
    cwd: '/srv',
    store,
    file,
    rules: ONE_PROCESS,
    started,
    supervisor: options.supervisor ?? 'none',
    log,
    apply: (names, next) => applied.push({ names, next }),
    ...(options.restart ? { restart: options.restart } : {}),
    ...(options.answerMs !== undefined ? { answerMs: options.answerMs } : {}),
    ...(options.move ? { move: options.move } : {}),
  });
  return { settings, store, file, dataDir, sink, applied, env };
}

// Waits until an asynchronous check says yes (two seconds at most).
async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
  const until = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > until) assert.fail('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// The refusal a change gets, or a failure when it was taken.
async function refusal(promise: Promise<unknown>): Promise<ActionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ActionError) return error;
    throw error;
  }
  assert.fail('the change was taken');
}

describe('where a setting comes from', () => {
  it('reads the default, under a saved value, under the environment (an empty variable is none)', () => {
    const setting = SETTINGS.find((entry) => entry.name === 'JUKECORD_QUEUE_MAX');
    assert.ok(setting);
    const saved = {
      file: new Map(),
      database: new Map([['JUKECORD_QUEUE_MAX', { value: '50', revision: 1, updatedAt: 1 }]]),
    };
    assert.deepEqual(sourceOf(setting, {}, { file: new Map(), database: new Map() }, ONE_PROCESS), {
      kind: 'default',
    });
    assert.deepEqual(sourceOf(setting, {}, saved, ONE_PROCESS), { kind: 'saved', where: 'database' });
    // Compose writes VAR= for an empty line of .env: no value, so the saved one applies under it.
    assert.deepEqual(sourceOf(setting, { JUKECORD_QUEUE_MAX: '  ' }, saved, ONE_PROCESS), {
      kind: 'saved',
      where: 'database',
    });
    assert.deepEqual(sourceOf(setting, { JUKECORD_QUEUE_MAX: '20' }, saved, ONE_PROCESS), {
      kind: 'environment',
      variable: 'JUKECORD_QUEUE_MAX',
    });
    // The merged environment loadConfig reads has the saved value, unless the environment gives one.
    assert.equal(mergedEnvironment({}, saved, ONE_PROCESS).JUKECORD_QUEUE_MAX, '50');
    assert.equal(mergedEnvironment({ JUKECORD_QUEUE_MAX: '20' }, saved, ONE_PROCESS).JUKECORD_QUEUE_MAX, '20');
  });

  it('takes a secret from its _FILE twin as the environment, and keeps a split’s settings.json ones out', () => {
    const token = SETTINGS.find((entry) => entry.name === 'JUKECORD_DISCORD_TOKEN');
    assert.ok(token);
    const saved = {
      file: new Map([['JUKECORD_DISCORD_TOKEN', { value: 'x', revision: 1, updatedAt: 1 }]]),
      database: new Map(),
    };
    assert.deepEqual(sourceOf(token, { JUKECORD_DISCORD_TOKEN_FILE: '/run/t' }, saved, ONE_PROCESS), {
      kind: 'environment',
      variable: 'JUKECORD_DISCORD_TOKEN_FILE',
    });
    // The variable and its file at once would be refused; a saved value never goes beside a file the environment
    // names (it would make "set X or X_FILE, not both" out of nothing).
    assert.equal(
      mergedEnvironment({ JUKECORD_DISCORD_TOKEN_FILE: '/run/t' }, saved, ONE_PROCESS).JUKECORD_DISCORD_TOKEN,
      undefined,
    );
    // In a split, a service reads what settings.json would hold from its environment only.
    assert.deepEqual(sourceOf(token, {}, saved, SPLIT), { kind: 'default' });
  });
});

describe('the settings service', () => {
  it('shows every setting with its source, the environment’s locked with the variable’s name', async () => {
    const { settings } = await setup({ env: { JUKECORD_LOG_LEVEL: 'warn' } });
    const view = await settings.view();
    const level = view.settings.find((setting) => setting.name === 'JUKECORD_LOG_LEVEL');
    assert.equal(level?.source, 'environment');
    assert.equal(level?.variable, 'JUKECORD_LOG_LEVEL');
    assert.equal(level?.value, 'warn');
    assert.equal(level?.editable, false);
    assert.equal(level?.locked, 'environment');
    const queue = view.settings.find((setting) => setting.name === 'JUKECORD_QUEUE_MAX');
    assert.deepEqual([queue?.source, queue?.value, queue?.editable], ['default', '1000', true]);
    // The data folder is where jukecord starts: never changed here. What restarts jukecord is no setting of the page.
    assert.equal(view.settings.find((setting) => setting.name === 'JUKECORD_DATA_DIR')?.locked, 'start');
    assert.equal(
      view.settings.some((setting) => setting.name === 'JUKECORD_SUPERVISOR'),
      false,
    );
    // Every group in the page's order, and nothing waits for a restart.
    assert.equal(view.groups[0]?.id, 'server');
    assert.deepEqual(view.restart.pending, []);
  });

  it('saves a runtime setting in the database and a secret or a bootstrap one in settings.json (0600)', async () => {
    const { settings, store, dataDir } = await setup();
    await settings.change({ JUKECORD_QUEUE_MAX: '50', JUKECORD_PORT: '8796', JUKECORD_DISCORD_TOKEN: TOKEN });
    const rows = await store.hostSettings.all();
    assert.deepEqual(
      rows.map((row) => [row.name, row.value, row.revision]),
      [['JUKECORD_QUEUE_MAX', '50', 1]],
    );
    const file = readSettingsFile(dataDir);
    assert.deepEqual([...file.keys()].sort(), ['JUKECORD_DISCORD_TOKEN', 'JUKECORD_PORT']);
    assert.equal(file.get('JUKECORD_PORT')?.value, '8796');
    // Windows keeps no POSIX modes (every file reads 0o666); the 0600 is checked where there is one.
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, SETTINGS_FILE)).mode & 0o777, 0o600);
    // No half-written file is left beside it.
    assert.deepEqual(fs.readdirSync(dataDir), [SETTINGS_FILE]);
  });

  it('refuses a change the start’s rules refuse, all of it, naming each setting', async () => {
    const { settings, store, dataDir } = await setup();
    const refused = await refusal(
      settings.change({ JUKECORD_QUEUE_MAX: '5', JUKECORD_LOG_LEVEL: 'debug', JUKECORD_PORT: 'x' }),
    );
    assert.ok(refused instanceof SettingsRefused);
    assert.equal(refused.code, 'invalid');
    assert.deepEqual(
      (refused.problems ?? []).map((problem) => problem.names),
      [['JUKECORD_PORT'], ['JUKECORD_QUEUE_MAX']],
    );
    assert.match(refused.problems?.[1]?.message ?? '', /^JUKECORD_QUEUE_MAX: 5 is outside 10-100000$/);
    // Nothing of it was kept, the good part neither.
    assert.deepEqual(await store.hostSettings.all(), []);
    assert.equal(fs.existsSync(path.join(dataDir, SETTINGS_FILE)), false);
  });

  it('checks settings together: one half of a pair is refused, both at once are taken', async () => {
    const { settings } = await setup();
    const half = await refusal(settings.change({ JUKECORD_SPOTIFY_CLIENT_ID: SPOTIFY_ID }));
    assert.ok(half instanceof SettingsRefused);
    assert.deepEqual(half.problems?.[0]?.names, ['JUKECORD_SPOTIFY_CLIENT_ID', 'JUKECORD_SPOTIFY_CLIENT_SECRET']);
    const { changed } = await settings.change({
      JUKECORD_SPOTIFY_CLIENT_ID: SPOTIFY_ID,
      JUKECORD_SPOTIFY_CLIENT_SECRET: SPOTIFY_SECRET,
    });
    assert.deepEqual(
      changed.map((entry) => entry.name),
      ['JUKECORD_SPOTIFY_CLIENT_ID', 'JUKECORD_SPOTIFY_CLIENT_SECRET'],
    );
  });

  it('refuses a setting the environment sets, the data folder, and a name that is no setting', async () => {
    const { settings } = await setup({ env: { JUKECORD_CACHE_MAX: '1GiB' } });
    const locked = await refusal(settings.change({ JUKECORD_CACHE_MAX: '3GiB' }));
    assert.deepEqual(
      [locked.code, locked.message],
      ['conflict', 'JUKECORD_CACHE_MAX is set by the environment (JUKECORD_CACHE_MAX)'],
    );
    assert.equal((await refusal(settings.change({ JUKECORD_DATA_DIR: '/x' }))).code, 'conflict');
    assert.equal((await refusal(settings.change({ JUKECORD_SUPERVISOR: 'docker' }))).code, 'invalid');
    assert.equal((await refusal(settings.change({ JUKECORD_NO_SUCH: '1' }))).code, 'invalid');
  });

  it('refuses a change made against an older revision: nothing written over unseen', async () => {
    const { settings } = await setup();
    const first = await settings.view();
    const revision = (name: string) => first.settings.find((setting) => setting.name === name)?.revision ?? -1;
    await settings.change({ JUKECORD_QUEUE_MAX: '50' }, { JUKECORD_QUEUE_MAX: revision('JUKECORD_QUEUE_MAX') });
    // A second page read the settings before that change: its change is refused, the first one stays.
    const stale = await refusal(
      settings.change({ JUKECORD_QUEUE_MAX: '60' }, { JUKECORD_QUEUE_MAX: revision('JUKECORD_QUEUE_MAX') }),
    );
    assert.equal(stale.code, 'conflict');
    assert.match(stale.message, /changed by someone else meanwhile: JUKECORD_QUEUE_MAX/);
    // settings.json's settings likewise.
    await settings.change({ JUKECORD_PORT: '8796' }, { JUKECORD_PORT: 0 });
    assert.equal((await refusal(settings.change({ JUKECORD_PORT: '8797' }, { JUKECORD_PORT: 0 }))).code, 'conflict');
    const now = await settings.view();
    assert.equal(now.settings.find((setting) => setting.name === 'JUKECORD_QUEUE_MAX')?.value, '50');
    assert.equal(now.settings.find((setting) => setting.name === 'JUKECORD_PORT')?.value, '8796');
  });

  it('never shows a secret or writes one to the log: only whether it is set', async () => {
    const { settings, sink } = await setup();
    const answer = await settings.change({
      JUKECORD_DISCORD_TOKEN: TOKEN,
      JUKECORD_SPOTIFY_CLIENT_ID: SPOTIFY_ID,
      JUKECORD_SPOTIFY_CLIENT_SECRET: SPOTIFY_SECRET,
    });
    const view = await settings.view();
    const said = JSON.stringify([answer, view, sink.records]);
    assert.ok(!said.includes(TOKEN), 'the token was in an answer or the log');
    assert.ok(!said.includes(SPOTIFY_SECRET), 'the secret was in an answer or the log');
    const token = view.settings.find((setting) => setting.name === 'JUKECORD_DISCORD_TOKEN');
    assert.deepEqual([token?.value, token?.set, token?.source], [null, true, 'saved']);
  });

  it('shows the database’s address without its user or password', async () => {
    const { settings } = await setup();
    await settings.change({ JUKECORD_DATABASE_URL: 'postgres://jukecord:pass-made-up@db.example:5432/music' });
    const view = await settings.view();
    const database = view.settings.find((setting) => setting.name === 'JUKECORD_DATABASE_URL');
    assert.equal(database?.value, null);
    assert.equal(database?.shown, 'PostgreSQL (db.example:5432, database music, without TLS)');
    assert.ok(!JSON.stringify(view).includes('pass-made-up'));
  });

  it('hands what applies at once on, and says what waits for a restart until it is changed back', async () => {
    const { settings, applied } = await setup();
    await settings.change({ JUKECORD_LOG_LEVEL: 'debug', JUKECORD_PORT: '8796' });
    assert.deepEqual(
      applied.map((entry) => entry.names),
      [['JUKECORD_LOG_LEVEL']],
    );
    assert.equal(applied[0]?.next.log.level, 'debug');
    assert.equal(settings.config.log.level, 'debug');
    // The port waits for a restart, and says what runs meanwhile; the one in use is still the start's.
    let view = await settings.view();
    let port = view.settings.find((setting) => setting.name === 'JUKECORD_PORT');
    assert.deepEqual([port?.pending, port?.value, port?.running], [true, '8796', '8795']);
    // The port as this machine reaches it follows the port by default: it changes with it, and says so too.
    assert.deepEqual(view.restart.pending, ['JUKECORD_PORT', 'JUKECORD_PUBLISHED_PORT']);
    assert.equal(settings.config.port, 8795);
    // Put back as it started: nothing waits any more.
    await settings.reset(['JUKECORD_PORT']);
    view = await settings.view();
    port = view.settings.find((setting) => setting.name === 'JUKECORD_PORT');
    assert.deepEqual([port?.pending, port?.source, port?.value], [false, 'default', '8795']);
    assert.deepEqual(view.restart.pending, []);
  });

  it('keeps a save of what is saved already as it is, revision and all', async () => {
    const { settings, store } = await setup();
    await settings.change({ JUKECORD_QUEUE_MAX: '50' });
    const { changed } = await settings.change({ JUKECORD_QUEUE_MAX: ' 50 ' });
    assert.deepEqual(changed, []);
    assert.equal((await store.hostSettings.all())[0]?.revision, 1);
  });

  it('keeps nothing of a change when the database stops answering, and says so', async () => {
    const { settings, store, dataDir } = await setup();
    // The database's half fails as an unreachable server does; settings.json's half must not be written either.
    store.hostSettings.write = async () => {
      throw new ConnectionError('connection refused', true);
    };
    const refused = await refusal(settings.change({ JUKECORD_QUEUE_MAX: '50', JUKECORD_PORT: '8796' }));
    assert.deepEqual(
      [refused.code, refused.message],
      ['unavailable', 'the database does not answer; nothing was saved'],
    );
    assert.equal(fs.existsSync(path.join(dataDir, SETTINGS_FILE)), false);
  });

  it('tells a page the database is silent within its wait, and takes a change it answers late in order', async () => {
    const { settings, store, sink, applied } = await setup({ answerMs: 50 });
    // A server that stops answering: the write waits for it, as a statement on a paused server does.
    const write = store.hostSettings.write.bind(store.hostSettings);
    let answer: () => void = () => {};
    const silent = new Promise<void>((resolve) => {
      answer = resolve;
    });
    store.hostSettings.write = async (changes, expected) => {
      await silent;
      return write(changes, expected);
    };
    const started = Date.now();
    const late = await refusal(settings.change({ JUKECORD_QUEUE_MAX: '50' }));
    assert.deepEqual(
      [late.code, late.message],
      ['unavailable', 'the database does not answer; the change may still be saved when it does'],
    );
    assert.ok(Date.now() - started < 1000, 'the page waited for the silent database');
    // A second change meanwhile waits behind the first (one at a time, in the order they came), and is told the same.
    const second = refusal(settings.change({ JUKECORD_QUEUE_MAX: '60' }));
    assert.equal((await second).code, 'unavailable');
    // The server answers again: both changes go through, the first then the second, and are taken in.
    answer();
    await eventually(
      async () => (await store.hostSettings.all()).find((row) => row.name === 'JUKECORD_QUEUE_MAX')?.revision === 2,
    );
    const row = (await store.hostSettings.all()).find((entry) => entry.name === 'JUKECORD_QUEUE_MAX');
    assert.deepEqual([row?.value, row?.revision], ['60', 2]);
    await eventually(async () => applied.at(-1)?.next.queueMax === 60);
    assert.ok(sink.records.some((record) => record.msg === 'a change was saved after the page stopped waiting'));
    // A read while the server is silent: told so within the wait as well.
    const all = store.hostSettings.all.bind(store.hostSettings);
    store.hostSettings.all = async () => new Promise(() => {});
    const away = await refusal(settings.view());
    // In the words and with the wait every request is told while the database is out of reach.
    assert.deepEqual(
      [away.code, away.message, away.retryAfterMs],
      ['unavailable', 'the database does not answer; try again in a moment', 5000],
    );
    store.hostSettings.all = all;
  });

  it('puts the database’s half back when settings.json cannot be written', async () => {
    const { settings, store, file } = await setup();
    await settings.change({ JUKECORD_QUEUE_MAX: '50' });
    file.write = async () => {
      throw new Error('EACCES: permission denied');
    };
    const refused = await refusal(settings.change({ JUKECORD_QUEUE_MAX: '60', JUKECORD_PORT: '8796' }));
    assert.equal(refused.code, 'unavailable');
    const rows = await store.hostSettings.all();
    assert.equal(rows[0]?.value, '50');
  });

  it('refuses a restart where nothing would start jukecord again, and restarts where something does', async () => {
    const alone = await setup({ supervisor: 'none' });
    const refused = await refusal(Promise.resolve().then(() => alone.settings.restartNow()));
    assert.equal(refused.code, 'conflict');
    assert.match(refused.message, /^nothing would start jukecord again here/);
    let restarted = 0;
    const docker = await setup({ supervisor: 'docker', restart: () => restarted++ });
    assert.deepEqual(docker.settings.restartNow(), { supervisor: 'docker' });
    // A moment after the answer, not before it.
    assert.equal(restarted, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(restarted, 1);
  });
});

describe('a restart and a move’s switch', () => {
  // A move whose copy is done: a SQLite file of a few tracks copied into another one in the same folder.
  async function copiedMove(): Promise<DatabaseMove> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-switch-'));
    folders.push(dataDir);
    const file = path.join(dataDir, 'jukecord.db');
    const store = await SqliteStore.open(file);
    await addTracks(store, 2, 'kept');
    await store.close();
    const move = new DatabaseMove({ dataDir, current: { kind: 'sqlite', file }, pool: 2 });
    await move.start(`sqlite:${path.join(dataDir, 'moved.db')}`, false);
    await eventually(() => move.current?.phase === 'copied');
    return move;
  }

  it('counts systemd as what starts jukecord again only when the setting says so', () => {
    // Every unit's process has an INVOCATION_ID, and systemd leaves it stopped unless the unit says Restart=.
    assert.equal(supervisorOf(null, { INVOCATION_ID: '0123456789abcdef0123456789abcdef' }), 'none');
    assert.equal(supervisorOf('systemd', { INVOCATION_ID: '0123456789abcdef0123456789abcdef' }), 'systemd');
    // A pod's containers are started again by default.
    assert.equal(supervisorOf(null, { KUBERNETES_SERVICE_HOST: '10.43.0.1' }), 'kubernetes');
  });

  it('refuses a switch while a restart is on its way, and a restart while a switch is', async () => {
    // A restart first: the switch after it would be dropped by the stop under way, so it is refused, the move kept.
    const restarts: (RestartOptions | undefined)[] = [];
    const first = await setup({
      supervisor: 'docker',
      restart: (options) => restarts.push(options),
      move: await copiedMove(),
    });
    first.settings.restartNow();
    const refused = await refusal(Promise.resolve().then(() => first.settings.switchMove()));
    assert.deepEqual(
      [refused.code, refused.message],
      ['conflict', 'jukecord is restarting; switch to the database once it is back'],
    );
    assert.equal(first.settings.moveState().state?.phase, 'copied');
    // Asked again, the restart under way is the answer.
    assert.deepEqual(first.settings.restartNow(), { supervisor: 'docker' });
    await eventually(() => restarts.length === 1);
    assert.equal(restarts[0], undefined);
    // A switch first: a restart after it would stop jukecord without the switch's last copy.
    const switched: (RestartOptions | undefined)[] = [];
    const second = await setup({
      supervisor: 'docker',
      restart: (options) => switched.push(options),
      move: await copiedMove(),
    });
    assert.equal(second.settings.switchMove().restarts, true);
    const again = await refusal(Promise.resolve().then(() => second.settings.restartNow()));
    assert.deepEqual(
      [again.code, again.message],
      ['conflict', 'jukecord is switching to another database; it starts again on it'],
    );
    // The stop that comes is the switch's, with its last copy.
    await eventually(() => switched.length === 1);
    assert.equal(typeof switched[0]?.last, 'function');
  });
});

describe('the settings at the start', () => {
  // A saved setting as settings.json or the database holds it.
  const row = (name: string, value: string) => [name, { name, value, revision: 1, updatedAt: 1 }] as const;

  it('reads nothing from the database that steers a saved secret or names a program for jukecord to run', () => {
    // Rows another holder of the database's password could write: the directory moved elsewhere for the bind
    // password saved in settings.json, a program of its own for yt-dlp. None of them is read.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-rows-'));
    folders.push(dataDir);
    const env = { JUKECORD_DATA_DIR: dataDir };
    const file = new Map([row('JUKECORD_LDAP_BIND_PASSWORD', 'a-made-up-bind-password')]);
    const database = new Map([
      row('JUKECORD_LDAP_URL', 'ldap://directory.example.net'),
      row('JUKECORD_LDAP_BIND_DN', 'cn=reader,dc=example,dc=net'),
      row('JUKECORD_LDAP_BASE_DN', 'dc=example,dc=net'),
      row('JUKECORD_LDAP_READ_GROUPS', '*'),
      row('JUKECORD_OIDC_ISSUER', 'https://sso.example.net/realms/home'),
      row('JUKECORD_YTDLP', '/opt/elsewhere/yt-dlp'),
      row('JUKECORD_FFMPEG', '/opt/elsewhere/ffmpeg'),
    ]);
    const all = allSettings(env, dataDir, { file, database }, ONE_PROCESS);
    assert.ok(all.config, all.problems.join('; '));
    const plain = loadConfig(env, dataDir);
    assert.deepEqual(
      [all.config.auth.ldap, all.config.auth.oidc, all.config.media.ytdlp, all.config.media.ffmpeg],
      [plain.auth.ldap, plain.auth.oidc, plain.media.ytdlp, plain.media.ffmpeg],
    );
  });

  it('never starts without a saved database address it refuses: it says why instead', () => {
    // Left out, jukecord would start on a new SQLite file, which looks like every track and playlist lost.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-address-'));
    folders.push(dataDir);
    const env = { JUKECORD_DATA_DIR: dataDir };
    const file = new Map([row('JUKECORD_DATABASE_URL', 'postgres://db.example.net:5432/jukecord')]);
    const first = firstSettings(env, dataDir, file, ONE_PROCESS);
    assert.equal(first.config, null);
    assert.deepEqual(first.problems, [
      'JUKECORD_DATABASE_URL has no user name (postgres://user:password@host/database)',
    ]);
    assert.equal(allSettings(env, dataDir, { file, database: new Map() }, ONE_PROCESS).config, null);
  });

  it('leaves out a saved value the rules refuse now, and says which and why', async () => {
    const layers = {
      file: new Map(),
      database: new Map([
        ['JUKECORD_QUEUE_MAX', { value: '5', revision: 3, updatedAt: 1 }],
        ['JUKECORD_LOG_LEVEL', { value: 'debug', revision: 1, updatedAt: 1 }],
      ]),
    };
    const started = startingSettings({}, '/srv', undefined, layers, ONE_PROCESS);
    assert.ok(started.config);
    // The refused one at its default, the other as saved.
    assert.equal(started.config.queueMax, 1000);
    assert.equal(started.config.log.level, 'debug');
    assert.deepEqual([...started.refused.keys()], ['JUKECORD_QUEUE_MAX']);
    assert.equal(started.refused.get('JUKECORD_QUEUE_MAX')?.revision, 3);
    // A problem of the environment's own is still a reason not to start.
    const broken = startingSettings({ JUKECORD_PORT: 'x' }, '/srv', undefined, layers, ONE_PROCESS);
    assert.equal(broken.config, null);
    assert.deepEqual(broken.problems, ['JUKECORD_PORT: "x" is not a whole number']);
  });

  it('reads a host who never saved anything exactly as loadConfig reads the environment', () => {
    const env = { JUKECORD_QUEUE_MAX: '20', JUKECORD_LYRICS: 'off' };
    const started = startingSettings(env, '/srv', undefined, { file: new Map(), database: new Map() }, ONE_PROCESS);
    assert.deepEqual(started.config, loadConfig(env, '/srv'));
  });
});

eachDatabase('the saved settings', (db) => {
  it('writes each setting one revision up, in one transaction, and refuses a stale revision whole', async () => {
    const store = await db.open();
    const first = await store.hostSettings.write([
      { name: 'JUKECORD_QUEUE_MAX', value: '50' },
      { name: 'JUKECORD_LOG_LEVEL', value: 'debug' },
    ]);
    assert.deepEqual(
      first.map((row) => [row.name, row.revision]),
      [
        ['JUKECORD_QUEUE_MAX', 1],
        ['JUKECORD_LOG_LEVEL', 1],
      ],
    );
    // Put back to its default: the row stays, null, a revision on.
    await store.hostSettings.write([{ name: 'JUKECORD_LOG_LEVEL', value: null }]);
    // One of two names stale: neither is written.
    await assert.rejects(
      store.hostSettings.write(
        [
          { name: 'JUKECORD_QUEUE_MAX', value: '60' },
          { name: 'JUKECORD_LOG_LEVEL', value: 'warn' },
        ],
        { JUKECORD_QUEUE_MAX: 1, JUKECORD_LOG_LEVEL: 1 },
      ),
      /changed by someone else meanwhile: JUKECORD_LOG_LEVEL/,
    );
    assert.deepEqual(
      (await store.hostSettings.all()).map((row) => [row.name, row.value, row.revision]),
      [
        ['JUKECORD_LOG_LEVEL', null, 2],
        ['JUKECORD_QUEUE_MAX', '50', 1],
      ],
    );
  });

  it('takes a burst of changes at once, each whole, none lost', async () => {
    const store = await db.open();
    // Twenty changes of two settings at once, each with the revision it read: some are refused, none is half kept,
    // and the rows end at one change's values with as many revisions as changes taken.
    const names = ['JUKECORD_QUEUE_MAX', 'JUKECORD_PREFETCH'];
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        store.hostSettings.write(
          names.map((name) => ({ name, value: String(100 + index) })),
          Object.fromEntries(names.map((name) => [name, 0])),
        ),
      ),
    );
    const taken = results.filter((result) => result.status === 'fulfilled');
    assert.equal(taken.length, 1, 'more than one change read revision 0 and was kept');
    const rows = await store.hostSettings.all();
    assert.equal(new Set(rows.map((row) => row.value)).size, 1, 'the rows are of two different changes');
    // Blind writes (no revision): every one taken, one after the other, the last one's values kept whole.
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.hostSettings.write(names.map((name) => ({ name, value: String(200 + index) }))),
      ),
    );
    const after = await store.hostSettings.all();
    assert.equal(new Set(after.map((row) => row.value)).size, 1);
    assert.deepEqual(
      after.map((row) => row.revision),
      [11, 11],
    );
  });
});

describe('what the next Config keeps', () => {
  it('reads each setting’s value out of a Config', () => {
    const config = loadConfig({ JUKECORD_QUEUE_MAX: '20' }, '/srv');
    assert.equal(valueIn(config, 'JUKECORD_QUEUE_MAX'), 20);
    assert.throws(() => valueIn(config, 'JUKECORD_NO_SUCH'), /no reader/);
  });
});
