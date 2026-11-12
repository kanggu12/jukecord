import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runDoctor } from '../../src/app/doctor.ts';
import { loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import type { Ffmpeg } from '../../src/media/ffmpeg.ts';
import type { YtDlp } from '../../src/media/ytdlp.ts';
import { memoryStore } from '../support/store.ts';
import { FakeDirectory } from '../support/web.ts';

function setup(options: {
  opus?: boolean;
  ytdlp?: string;
  latest?: string | null;
  token?: boolean;
  ready?: boolean;
  env?: Record<string, string>;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-doctor-'));
  const config = loadConfig(
    { JUKECORD_DATA_DIR: dir, ...(options.token ? { JUKECORD_DISCORD_TOKEN: 'x' } : {}), ...options.env },
    dir,
  );
  const cache = new MediaCache({
    dir: path.join(dir, 'cache'),
    maxBytes: 1024 ** 3,
    log: createLogger({ level: 'error', sinks: [] }),
  });
  cache.init();
  const ffmpeg = {
    about: async () => ({ version: 'ffmpeg version 7.1.2', opus: options.opus ?? true, mp3: true }),
  } as Ffmpeg;
  const ytdlp = { version: async () => options.ytdlp ?? '2026.10.26' } as YtDlp;
  const directory = new FakeDirectory();
  return {
    dir,
    run: () =>
      runDoctor({
        config,
        store: memoryStore(),
        cache,
        ytdlp,
        ffmpeg,
        discordReady: () => options.ready ?? true,
        directory: () => directory,
        discordLogin: false,
        latestYtDlp: async () => (options.latest === undefined ? '2026.10.26' : options.latest),
      }),
  };
}

describe('runDoctor', () => {
  it('passes a healthy setup and shows the settings without secrets', async () => {
    const { dir, run } = setup({ token: true });
    try {
      const report = await run();
      assert.equal(report.ok, true);
      assert.deepEqual(
        report.checks.map((check) => [check.name, check.status]),
        [
          ['data directory', 'ok'],
          ['database', 'ok'],
          ['ffmpeg', 'ok'],
          ['yt-dlp', 'ok'],
          ['media cache', 'ok'],
          ['discord', 'ok'],
          ['panel login', 'ok'],
          ['backups', 'ok'],
        ],
      );
      assert.equal(report.checks.find((check) => check.name === 'discord')?.detail, 'connected, in 2 servers');
      assert.equal(report.settings['discord token'], 'set');
      assert.ok(!JSON.stringify(report).includes('"x"'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails for an ffmpeg without Opus or a bot that cannot connect, and warns for an old yt-dlp', async () => {
    const { dir, run } = setup({ opus: false, token: true, ready: false, ytdlp: '2026.03.17' });
    try {
      const report = await run();
      assert.equal(report.ok, false);
      const status = Object.fromEntries(report.checks.map((check) => [check.name, check.status]));
      assert.equal(status.ffmpeg, 'fail');
      assert.equal(status.discord, 'fail');
      assert.equal(status['yt-dlp'], 'warn');
      assert.match(report.checks.find((check) => check.name === 'ffmpeg')?.detail ?? '', /no libopus/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count an offline update check against yt-dlp', async () => {
    const { dir, run } = setup({ latest: null });
    try {
      const check = (await run()).checks.find((entry) => entry.name === 'yt-dlp');
      assert.deepEqual([check?.status, check?.detail], ['ok', '2026.10.26 (could not check for a newer one)']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says how old the newest backup is and the schedule, and warns when a daily one has not run for two days', async () => {
    const off = setup({});
    try {
      const none = (await off.run()).checks.find((entry) => entry.name === 'backups');
      assert.deepEqual([none?.status, none?.detail], ['ok', 'none yet; no daily backup (JUKECORD_BACKUP_AT)']);
      // A backup made three hours ago, as the backup command names it.
      fs.mkdirSync(path.join(off.dir, 'backups'));
      const made = new Date(Date.now() - 3 * 3_600_000).toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(off.dir, 'backups', `jukecord-${made}.db`), Buffer.alloc(110_592));
      const one = (await off.run()).checks.find((entry) => entry.name === 'backups');
      assert.deepEqual(
        [one?.status, one?.detail],
        ['ok', 'the newest 3 h ago (108.0 KiB), 1 kept; no daily backup (JUKECORD_BACKUP_AT)'],
      );
    } finally {
      fs.rmSync(off.dir, { recursive: true, force: true });
    }
    const daily = setup({ env: { JUKECORD_BACKUP_AT: '04:30', JUKECORD_BACKUP_KEEP: '14' } });
    try {
      fs.mkdirSync(path.join(daily.dir, 'backups'));
      const made = new Date(Date.now() - 3 * 86_400_000).toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(daily.dir, 'backups', `jukecord-${made}.db`), Buffer.alloc(2048));
      const late = (await daily.run()).checks.find((entry) => entry.name === 'backups');
      assert.deepEqual(
        [late?.status, late?.detail],
        ['warn', 'the newest 3 days ago (2.0 KiB), 1 kept; daily at 04:30, keeping 14'],
      );
    } finally {
      fs.rmSync(daily.dir, { recursive: true, force: true });
    }
  });
});
