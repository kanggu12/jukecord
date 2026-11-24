/**
 * The settings of a split jukecord: one process by default, with nothing else to set; a core or an edge refuses to
 * start without what services need (a database they all reach, the bus, the internal secret, and for an edge the
 * core's address), each missing one said in a sentence that names its setting.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, type ConfigFiles, DEFAULT_INTERNAL_PORT, describeConfig, loadConfig } from '../../src/config.ts';

const SECRET = 'a'.repeat(64);
const SPLIT = {
  JUKECORD_DATABASE_URL: 'postgres://jukecord:pw@db:5432/jukecord',
  JUKECORD_BUS_URL: 'redis://:bus-password@valkey:6379',
  JUKECORD_INTERNAL_SECRET: SECRET,
};

// The problems a set of settings is refused with (none: an empty list).
function problems(env: NodeJS.ProcessEnv, files?: ConfigFiles): readonly string[] {
  try {
    loadConfig(env, '/srv', files);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

describe('the role settings', () => {
  it('runs as one process by default: no bus, the cache in memory, nothing more to set', () => {
    const config = loadConfig({}, '/srv');
    assert.equal(config.role, 'all');
    assert.equal(config.bus.url, null);
    assert.equal(config.bus.prefix, 'jukecord');
    assert.equal(config.cacheUrl, 'memory');
    assert.equal(config.internal.port, DEFAULT_INTERNAL_PORT);
    assert.equal(config.internal.secret, null);
    assert.deepEqual(config.warnings, []);
  });

  it("may keep one process's cache on Redis or Valkey, and warns about split settings it does not read", () => {
    const config = loadConfig(
      { JUKECORD_CACHE_URL: 'valkey://cache:6379', JUKECORD_BUS_URL: 'redis://valkey:6379' },
      '/srv',
    );
    assert.equal(config.cacheUrl, 'valkey://cache:6379');
    assert.equal(config.bus.url, null);
    assert.match(config.warnings.join('\n'), /JUKECORD_BUS_URL is read only when JUKECORD_ROLE is core or edge/);
  });

  it("reads a core and an edge, the cache on the bus's server unless told otherwise", () => {
    const core = loadConfig({ ...SPLIT, JUKECORD_ROLE: 'Core' }, '/srv');
    assert.equal(core.role, 'core');
    assert.equal(core.bus.url, SPLIT.JUKECORD_BUS_URL);
    assert.equal(core.cacheUrl, SPLIT.JUKECORD_BUS_URL);
    assert.equal(core.internal.secret, SECRET);
    assert.equal(core.internal.coreUrl, null);
    const edge = loadConfig(
      {
        ...SPLIT,
        JUKECORD_ROLE: 'edge',
        JUKECORD_CORE_URL: 'http://core:8796/',
        JUKECORD_CACHE_URL: 'memory',
        JUKECORD_KEY_PREFIX: 'music-2',
      },
      '/srv',
    );
    assert.equal(edge.internal.coreUrl, 'http://core:8796');
    assert.equal(edge.cacheUrl, 'memory');
    assert.equal(edge.bus.prefix, 'music-2');
  });

  it('refuses a core or an edge without what services need, saying each in one sentence', () => {
    const found = problems({ JUKECORD_ROLE: 'edge' });
    assert.equal(found.length, 4);
    assert.match(found[0] ?? '', /JUKECORD_ROLE=edge needs JUKECORD_DATABASE_URL/);
    assert.match(found[1] ?? '', /needs JUKECORD_BUS_URL: the Redis or Valkey server/);
    assert.match(found[2] ?? '', /needs JUKECORD_INTERNAL_SECRET/);
    assert.match(found[3] ?? '', /needs JUKECORD_CORE_URL/);
    // A core needs no core address.
    assert.equal(problems({ JUKECORD_ROLE: 'core' }).length, 3);
    // A SQLite file is one process's.
    assert.match(
      problems({ ...SPLIT, JUKECORD_ROLE: 'core', JUKECORD_DATABASE_URL: 'sqlite:/data/jukecord.db' }).join(),
      /a SQLite file is one process's/,
    );
  });

  it('refuses addresses, prefixes, secrets and ports that cannot work', () => {
    // The refusal names every scheme taken, Valkey's own among them; a valkeys:// address is taken.
    assert.match(
      problems({ ...SPLIT, JUKECORD_ROLE: 'core', JUKECORD_BUS_URL: 'http://valkey' }).join(),
      /redis:\/\/, rediss:\/\/ \(TLS\), valkey:\/\/ or valkeys:\/\/ \(TLS\)/,
    );
    assert.deepEqual(problems({ ...SPLIT, JUKECORD_ROLE: 'core', JUKECORD_BUS_URL: 'valkeys://valkey:6380' }), []);
    assert.match(
      problems({ JUKECORD_CACHE_URL: 'not an address' }).join(),
      /JUKECORD_CACHE_URL: that is not an address/,
    );
    assert.match(problems({ JUKECORD_KEY_PREFIX: 'two words' }).join(), /JUKECORD_KEY_PREFIX/);
    assert.match(
      problems({ ...SPLIT, JUKECORD_ROLE: 'core', JUKECORD_INTERNAL_SECRET: 'short' }).join(),
      /too short: at least 32 characters/,
    );
    assert.match(
      problems({ ...SPLIT, JUKECORD_ROLE: 'core', JUKECORD_INTERNAL_PORT: '8795' }).join(),
      /the core needs two ports/,
    );
    assert.match(problems({ JUKECORD_ROLE: 'both' }).join(), /JUKECORD_ROLE: "both" is not one of all, core, edge/);
  });

  it('reads the bus address and the secret from files, as Docker and Kubernetes mount secrets', () => {
    const files: ConfigFiles = {
      readable: () => true,
      read: (file) =>
        file.endsWith('bus')
          ? 'rediss://:pw@valkey:6380\n'
          : file.endsWith('db')
            ? 'mysql://jukecord:pw@db/jukecord\n'
            : `${SECRET}\n`,
    };
    const config = loadConfig(
      {
        JUKECORD_ROLE: 'core',
        JUKECORD_DATABASE_URL_FILE: '/run/secrets/db',
        JUKECORD_BUS_URL_FILE: '/run/secrets/bus',
        JUKECORD_INTERNAL_SECRET_FILE: '/run/secrets/internal',
      },
      '/srv',
      files,
    );
    assert.equal(config.bus.url, 'rediss://:pw@valkey:6380');
    assert.equal(config.internal.secret, SECRET);
  });

  it('shows the servers without their passwords, and the secret as set', () => {
    const shown = describeConfig(loadConfig({ ...SPLIT, JUKECORD_ROLE: 'core' }, '/srv'));
    assert.equal(shown.role, 'core');
    assert.equal(shown.bus, 'redis://valkey:6379');
    assert.equal(shown['shared cache'], 'redis://valkey:6379');
    assert.equal(shown['internal secret'], 'set');
    assert.doesNotMatch(JSON.stringify(shown), /bus-password|aaaaaaaa/);
  });
});
