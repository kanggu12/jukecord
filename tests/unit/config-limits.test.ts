import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, type ConfigFiles, loadConfig } from '../../src/config.ts';

// Files that exist only in this map, so the tests never touch the disk.
function files(content: Record<string, string>): ConfigFiles {
  return { read: (file) => content[file] ?? '', readable: (file) => file in content };
}

describe('loadConfig: limits, cookies and secrets from files', () => {
  it('defaults to a 3 hour track limit, a 1000 track queue and leaving an empty channel after 5 minutes', () => {
    const config = loadConfig({}, '/srv', files({}));
    assert.equal(config.media.trackMaxMs, 3 * 3_600_000);
    assert.equal(config.queueMax, 1000);
    assert.equal(config.voice.idleMs, 300_000);
    assert.equal(config.media.cookies, null);
  });

  it('reads the limits, a cookies file and "0" for never leaving voice', () => {
    const config = loadConfig(
      {
        JUKECORD_TRACK_MAX: '90m',
        JUKECORD_QUEUE_MAX: '250',
        JUKECORD_VOICE_IDLE: '0',
        JUKECORD_YTDLP_COOKIES: 'cookies.txt',
      },
      '/srv',
      files({ '/srv/cookies.txt': '# Netscape HTTP Cookie File' }),
    );
    assert.equal(config.media.trackMaxMs, 90 * 60_000);
    assert.equal(config.queueMax, 250);
    assert.equal(config.voice.idleMs, 0);
    assert.equal(config.media.cookies, '/srv/cookies.txt');
  });

  it('reads secrets from the files *_FILE names, the way Docker and Kubernetes mount them', () => {
    const config = loadConfig(
      {
        JUKECORD_DISCORD_TOKEN_FILE: '/run/secrets/token',
        JUKECORD_DISCORD_CLIENT_ID: '108876543210987654',
        JUKECORD_DISCORD_CLIENT_SECRET_FILE: '/run/secrets/oauth',
      },
      '/srv',
      files({ '/run/secrets/token': 'abc.def.ghi\n', '/run/secrets/oauth': 'hush\n' }),
    );
    assert.equal(config.discord.token, 'abc.def.ghi');
    assert.equal(config.discord.clientSecret, 'hush');
  });

  it('refuses both a secret and its file, an unreadable file, and limits out of range', () => {
    assert.throws(
      () =>
        loadConfig(
          {
            JUKECORD_DISCORD_TOKEN: 'a',
            JUKECORD_DISCORD_TOKEN_FILE: '/run/secrets/token',
            JUKECORD_DISCORD_CLIENT_SECRET_FILE: '/missing',
            JUKECORD_YTDLP_COOKIES: '/missing.txt',
            JUKECORD_TRACK_MAX: '30s',
            JUKECORD_QUEUE_MAX: '5',
            JUKECORD_VOICE_IDLE: '1s',
          },
          '/srv',
          files({ '/run/secrets/token': 'b' }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        const all = error.problems.join('\n');
        for (const part of [
          'not both',
          'JUKECORD_DISCORD_CLIENT_SECRET_FILE',
          'JUKECORD_YTDLP_COOKIES',
          'JUKECORD_TRACK_MAX',
          'JUKECORD_QUEUE_MAX',
          'JUKECORD_VOICE_IDLE',
        ]) {
          assert.match(all, new RegExp(part));
        }
        return true;
      },
    );
  });
});
