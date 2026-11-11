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
    const missing = await cli('remove 9', extra);
    assert.equal(missing.code, 2);
    assert.match(missing.out, /no track number 9/);
    assert.match((await cli('np', extra)).out, /^Getting ready/);
    const json = await cli('np --json', extra);
    assert.equal(JSON.parse(json.out).track.title, 'Track a');
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
    assert.match(wrong.out, /log in first/);
  });

  it('makes a token that then works on its own', async () => {
    const made = await cli('token create laptop --scope read');
    const token = made.out.split('\n')[0] ?? '';
    assert.match(token, /^jkc_/);
    assert.equal((await cli('whoami', { JUKECORD_TOKEN: token })).out, 'the host (read)');
    assert.equal((await cli('shuffle', { JUKECORD_TOKEN: token, JUKECORD_GUILD: GUILD })).code, 1);
  });

  it('prints help with every command', async () => {
    const help = await cli('--help');
    assert.equal(help.code, 0);
    for (const word of ['np', 'add', 'playlist save', 'token create', 'doctor', 'link'])
      assert.ok(help.out.includes(`  ${word}`), word);
  });
});
