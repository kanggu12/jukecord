/**
 * The CLI against a real server on a port: what people type, what they see, and the exit codes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseLine, run } from '../../src/cli/main.ts';
import { exampleTrack, GUILD, HOST_TOKEN, type TestServer, testServer } from '../support/web.ts';

describe('parseLine', () => {
  it('separates words from options in both spellings, and keeps words after --', () => {
    const words = parseLine(['add', 'never', 'gonna', '--next', '--limit', '5', '--scope=read', '--', '--help']);
    assert.deepEqual(words.args, ['add', 'never', 'gonna', '--help']);
    assert.deepEqual(
      [...words.flags],
      [
        ['next', true],
        ['limit', '5'],
        ['scope', 'read'],
      ],
    );
  });
});

describe('the jukecord command', () => {
  let server: TestServer;
  let env: NodeJS.ProcessEnv;
  let dataDir: string;

  before(async () => {
    server = await testServer({
      listen: true,
      found: { three: [exampleTrack('a'), exampleTrack('b'), exampleTrack('c')] },
    });
    // The host token is found in the data directory, as `./jukecord <command>` does it.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-cli-'));
    fs.writeFileSync(path.join(dataDir, 'host-token'), `${HOST_TOKEN}\n`);
    env = { JUKECORD_URL: server.url, JUKECORD_DATA_DIR: dataDir };
  });
  after(async () => {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Runs one command line and returns its exit code and output.
  async function cli(line: string, extra: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const code = await run(line.split(' ').filter(Boolean), { ...env, ...extra }, (text) => out.push(text));
    return { code, out: out.join('\n') };
  }

  it('asks which server when there are two, and uses the one named', async () => {
    const unnamed = await cli('queue');
    assert.equal(unnamed.code, 2);
    assert.match(unnamed.out, /--guild/);
    assert.match(unnamed.out, /Example Server/);
    const named = await cli('queue', { JUKECORD_GUILD: GUILD });
    assert.deepEqual(named, { code: 0, out: 'The queue is empty' });
  });

  it('adds, shows, moves and removes by the numbers people see', async () => {
    const extra = { JUKECORD_GUILD: GUILD };
    assert.equal((await cli('add three', extra)).out, 'Added 3 tracks');
    assert.equal((await cli('queue', extra)).out, '1. Track b · 3:00\n2. Track c · 3:00');
    assert.equal((await cli('move 2 1', extra)).code, 0);
    assert.equal((await cli('queue', extra)).out, '1. Track c · 3:00\n2. Track b · 3:00');
    assert.equal((await cli('remove 1', extra)).code, 0);
    assert.equal((await cli('queue', extra)).out, '1. Track b · 3:00');
    // Playing a queued track now takes it out of the queue and makes it current.
    assert.equal((await cli('jump 1', extra)).code, 0);
    assert.equal((await cli('queue', extra)).out, 'The queue is empty');
    assert.match((await cli('np', extra)).out, /Track b/);
    const missing = await cli('remove 9', extra);
    assert.equal(missing.code, 2);
    assert.match(missing.out, /no track number 9/);
    const json = await cli('np --json', extra);
    assert.equal(JSON.parse(json.out).track.title, 'Track b');
  });

  it('exits 1 with the reason when jukecord refuses, 2 for typing mistakes, 3 when nobody answers', async () => {
    const refused = await cli('skip', { JUKECORD_GUILD: '100000000000000002' });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /nothing is playing/);
    assert.equal((await cli('repeat sometimes', { JUKECORD_GUILD: GUILD })).code, 2);
    assert.equal((await cli('fly')).code, 2);
    const away = await cli('status', { JUKECORD_URL: 'http://127.0.0.1:9' });
    assert.equal(away.code, 3);
    assert.match(away.out, /not answering/);
    const wrong = await cli('whoami', { JUKECORD_TOKEN: 'jkc_wrong' });
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /token was refused/);
  });

  it('makes a token that then works on its own', async () => {
    const made = await cli('token create laptop --scope read');
    const token = made.out.split('\n')[0] ?? '';
    assert.match(token, /^jkc_/);
    assert.equal((await cli('whoami', { JUKECORD_TOKEN: token })).out, 'the host (read)');
    assert.equal((await cli('shuffle', { JUKECORD_TOKEN: token, JUKECORD_GUILD: GUILD })).code, 1);
  });

  it('says what a value may be in its own words, before asking jukecord', async () => {
    const level = await cli('logs --level nonsense');
    assert.equal(level.code, 2);
    assert.match(level.out, /^jukecord logs: --level is debug, info, warn or error$/m);
    const limit = await cli('history --limit 0', { JUKECORD_GUILD: GUILD });
    assert.equal(limit.code, 2);
    assert.match(limit.out, /^jukecord history: --limit is 1 to 200$/m);
    const days = await cli('stats --days=400', { JUKECORD_GUILD: GUILD });
    assert.equal(days.code, 2);
    assert.match(days.out, /^jukecord stats: --days is 1 to 366$/m);
    const guild = await cli('np --guild 123');
    assert.equal(guild.code, 2);
    assert.match(guild.out, /^jukecord np: --guild takes a server ID \(see jukecord servers\)$/m);
  });

  it('shows one command when asked for its help', async () => {
    const help = await cli('help add');
    assert.deepEqual(help, {
      code: 0,
      out: 'Usage: jukecord add <address or words> [--next]\n  Add to the queue (plays if nothing is)',
    });
    assert.deepEqual(await cli('add --help'), help);
    const two = await cli('help playlist save');
    assert.match(two.out, /^Usage: jukecord playlist save <name>$/m);
    const none = await cli('help fly');
    assert.equal(none.code, 2);
    assert.match(none.out, /there is no command "fly"/);
  });

  it('says a refusal under --json as JSON, and exits 4 when jukecord says to try again later', async () => {
    const out: { text: string; error: boolean }[] = [];
    const code = await run(['skip', '--json'], { ...env, JUKECORD_GUILD: '100000000000000002' }, (text, error) =>
      out.push({ text, error: Boolean(error) }),
    );
    assert.equal(code, 1);
    assert.deepEqual(out, [
      { text: JSON.stringify({ error: { code: 'conflict', message: 'nothing is playing' } }, null, 2), error: true },
    ]);
    // A typing mistake too, with its own code, whether it is found before jukecord is asked or after.
    for (const line of [
      ['repeat', 'sometimes', '--json'],
      ['fly', '--json'],
      ['np', '--jsno', '--json'],
    ]) {
      const typed: string[] = [];
      assert.equal(await run(line, env, (text) => typed.push(text)), 2, line.join(' '));
      assert.equal(JSON.parse(typed.join('')).error.code, 'usage', line.join(' '));
    }
    // Answered "try again later" (a rate, a busy moment: an answer with Retry-After): 4, apart from a refusal.
    const later = await testServer({ listen: true, rates: { changes: { perSecond: 1, burst: 1 } } });
    try {
      later.directory.join(GUILD, '300000000000000001');
      const made = later.auth.createToken(
        { principal: { kind: 'user', userId: '300000000000000001' }, scope: 'control', via: 'token' } as never,
        'script',
        'control',
      );
      const asScript = { JUKECORD_URL: later.url, JUKECORD_TOKEN: made.token, JUKECORD_GUILD: GUILD };
      const first: string[] = [];
      assert.equal(await run(['shuffle'], asScript, (text) => first.push(text)), 0);
      const second: string[] = [];
      assert.equal(await run(['shuffle'], asScript, (text) => second.push(text)), 4);
      assert.match(second.join(''), /too many changes at once; try again in a moment/);
    } finally {
      await later.close();
    }
  });

  it('chooses where jukecord tells the server about trouble, and shows it with the settings', async () => {
    const extra = { JUKECORD_GUILD: GUILD };
    const chosen = await cli('alerts 600000000000000001', extra);
    assert.equal(chosen.code, 0);
    assert.match(chosen.out, /^Alerts: #jukecord-alerts$/m);
    assert.match(chosen.out, /^ {2}600000000000000001 {2}#jukecord-alerts$/m);
    assert.match((await cli('alerts none', extra)).out, /^Alerts: none$/m);
    assert.equal((await cli('alerts', extra)).code, 2);
  });

  it('prints help with every command', async () => {
    const help = await cli('--help');
    assert.equal(help.code, 0);
    for (const word of ['np', 'add', 'playlist save', 'token create', 'doctor', 'link'])
      assert.ok(help.out.includes(`  ${word}`), word);
  });
});

describe('the jukecord command without a Discord bot', () => {
  it("says jukecord's own refusals once, without its name twice", async () => {
    const server = await testServer({ listen: true, browserOnly: true });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-cli-'));
    try {
      fs.writeFileSync(path.join(dataDir, 'host-token'), `${HOST_TOKEN}\n`);
      const out: string[] = [];
      const code = await run(['join'], { JUKECORD_URL: server.url, JUKECORD_DATA_DIR: dataDir }, (text) =>
        out.push(text),
      );
      assert.equal(code, 1);
      assert.deepEqual(out, ['jukecord runs without a Discord bot here, so it cannot join voice']);
    } finally {
      await server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
