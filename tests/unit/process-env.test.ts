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
