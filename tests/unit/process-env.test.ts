import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { childEnv, run } from '../../src/media/process.ts';

describe('what a child program sees of jukecord', () => {
  it('passes on the environment without jukecord’s own settings', () => {
    const env = childEnv({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy.example:3128',
      JUKECORD_DISCORD_TOKEN: 'not-a-real-token',
      JUKECORD_DISCORD_CLIENT_SECRET: 'not-a-real-secret',
      JUKECORD_DATA_DIR: '/data',
    });
    assert.deepEqual(env, { PATH: '/usr/bin', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://proxy.example:3128' });
  });

  it('keeps the bot’s token from a program it runs', async () => {
    const before = process.env.JUKECORD_DISCORD_TOKEN;
    process.env.JUKECORD_DISCORD_TOKEN = 'not-a-real-token';
    try {
      // A child that prints the token if it can see it.
      const result = await run(process.execPath, [
        '-e',
        "process.stdout.write(process.env.JUKECORD_DISCORD_TOKEN ?? 'absent')",
      ]);
      assert.equal(result.stdout, 'absent');
    } finally {
      if (before === undefined) delete process.env.JUKECORD_DISCORD_TOKEN;
      else process.env.JUKECORD_DISCORD_TOKEN = before;
    }
  });
});

describe('a program that cannot start', () => {
  it('is reported, and a cancel made before it could start signals nothing', async () => {
    // Cancelled before it starts, as a skipped track's fetch is: the kill runs in the same moment as the spawn, while
    // the failed process still has a handle and no ID (src/discord/voice.ts shows what signalling one can do).
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      run('/nonexistent/jukecord-test-program', [], { signal: cancelled.signal }),
      /was not found|cancelled/,
    );
  });
});
