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

function setup(options: { opus?: boolean; ytdlp?: string; latest?: string | null; token?: boolean; ready?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-doctor-'));
  const config = loadConfig({ JUKECORD_DATA_DIR: dir, ...(options.token ? { JUKECORD_DISCORD_TOKEN: 'x' } : {}) }, dir);
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
});
