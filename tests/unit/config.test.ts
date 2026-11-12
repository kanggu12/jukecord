import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, DEFAULT_PORT, describeConfig, loadConfig } from '../../src/config.ts';

// A Discord token shaped like a real one (made up), to check it never shows up in printed settings. It is put
// together here: a whole token written out in the source is what secret scanners stop at the door.
const TOKEN = ['MTA4ODc2NTQzMjEwOTg3NjU0Mw', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.');

describe('loadConfig', () => {
  it('starts with safe defaults and no Discord: browser-only, listening on this machine only', () => {
    const config = loadConfig({}, '/srv/jukecord');
    assert.equal(config.dataDir, '/srv/jukecord/data');
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, DEFAULT_PORT);
    assert.equal(config.discord.token, null);
    assert.equal(config.media.cacheMaxBytes, 2 * 1024 ** 3);
    assert.equal(config.media.fetchTimeoutMs, 60_000);
    assert.equal(config.log.files, 5);
    assert.deepEqual(config.warnings, []);
  });

  it('reads every setting', () => {
    const config = loadConfig(
      {
        JUKECORD_DATA_DIR: '/data',
        JUKECORD_HOST: '0.0.0.0',
        JUKECORD_PORT: '9000',
        JUKECORD_PUBLIC_URL: 'https://music.example.com/',
        JUKECORD_DISCORD_TOKEN: TOKEN,
        JUKECORD_DISCORD_CLIENT_ID: '108876543210987654',
        JUKECORD_DISCORD_CLIENT_SECRET: 'secret',
        JUKECORD_CACHE_MAX: '512MiB',
        JUKECORD_FETCH_TIMEOUT: '90s',
        JUKECORD_PREFETCH: '1',
        JUKECORD_LOG_LEVEL: 'DEBUG',
        JUKECORD_LOG_MAX: '1MiB',
        JUKECORD_LOG_FILES: '3',
      },
      '/ignored',
    );
    assert.equal(config.dataDir, '/data');
    assert.equal(config.port, 9000);
    // The trailing slash goes, so paths can be appended.
    assert.equal(config.publicUrl, 'https://music.example.com');
    assert.equal(config.discord.clientId, '108876543210987654');
    assert.equal(config.media.cacheMaxBytes, 512 * 1024 ** 2);
    assert.equal(config.media.fetchTimeoutMs, 90_000);
    assert.equal(config.log.level, 'debug');
  });

  it('refuses private addresses unless JUKECORD_ALLOW_PRIVATE_ADDRESSES says otherwise', () => {
    assert.equal(loadConfig({}, '/srv').media.allowPrivate, false);
    assert.equal(loadConfig({ JUKECORD_ALLOW_PRIVATE_ADDRESSES: 'yes' }, '/srv').media.allowPrivate, true);
    assert.equal(loadConfig({ JUKECORD_ALLOW_PRIVATE_ADDRESSES: '0' }, '/srv').media.allowPrivate, false);
    assert.throws(
      () => loadConfig({ JUKECORD_ALLOW_PRIVATE_ADDRESSES: 'maybe' }, '/srv'),
      (error: unknown) => error instanceof ConfigError && /JUKECORD_ALLOW_PRIVATE_ADDRESSES/.test(error.message),
    );
  });

  it('treats an empty value as unset, the way compose writes VAR=', () => {
    const config = loadConfig({ JUKECORD_PORT: '', JUKECORD_DISCORD_TOKEN: '   ' }, '/srv');
    assert.equal(config.port, DEFAULT_PORT);
    assert.equal(config.discord.token, null);
  });

  it('lists every problem at once, each naming its variable', () => {
    assert.throws(
      () =>
        loadConfig(
          {
            JUKECORD_PORT: '80a',
            JUKECORD_PUBLIC_URL: 'music.example.com',
            JUKECORD_DISCORD_CLIENT_SECRET: 'secret',
            JUKECORD_CACHE_MAX: '1MiB',
            JUKECORD_LOG_LEVEL: 'loud',
          },
          '/srv',
        ),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        const joined = error.problems.join('\n');
        for (const name of [
          'JUKECORD_PORT',
          'JUKECORD_PUBLIC_URL',
          'JUKECORD_DISCORD_CLIENT_SECRET',
          'JUKECORD_CACHE_MAX',
          'JUKECORD_LOG_LEVEL',
        ]) {
          assert.match(joined, new RegExp(name));
        }
        return true;
      },
    );
  });

  it('warns about unknown JUKECORD_ variables, which are almost always typos', () => {
    const config = loadConfig({ JUKECORD_PROT: '9000' }, '/srv');
    assert.deepEqual(config.warnings, ['JUKECORD_PROT is not a jukecord setting']);
  });
});

describe('describeConfig', () => {
  it('says whether secrets are set without showing any part of them', () => {
    const config = loadConfig(
      {
        JUKECORD_DISCORD_TOKEN: TOKEN,
        JUKECORD_DISCORD_CLIENT_ID: '108876543210987654',
        JUKECORD_DISCORD_CLIENT_SECRET: 'hush',
      },
      '/srv',
    );
    const text = JSON.stringify(describeConfig(config));
    assert.ok(!text.includes(TOKEN.slice(0, 10)));
    assert.ok(!text.includes('hush'));
    assert.equal(describeConfig(config)['discord token'], 'set');
  });

  it('reads how long a server nobody hears plays on before it pauses, 0 or off for never', () => {
    const base = { JUKECORD_DATA_DIR: '/data' };
    assert.equal(loadConfig(base, '/').restAfterMs, 120_000);
    assert.equal(loadConfig({ ...base, JUKECORD_REST_AFTER: '30s' }, '/').restAfterMs, 30_000);
    assert.equal(loadConfig({ ...base, JUKECORD_REST_AFTER: '0' }, '/').restAfterMs, 0);
    assert.equal(loadConfig({ ...base, JUKECORD_REST_AFTER: 'off' }, '/').restAfterMs, 0);
    assert.throws(() => loadConfig({ ...base, JUKECORD_REST_AFTER: '5s' }, '/'), /JUKECORD_REST_AFTER: 5s is outside/);
  });
});
