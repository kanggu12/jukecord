import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createLogger, FileSink } from '../../src/log.ts';
import { readLogs } from '../../src/web/logs.ts';

describe('readLogs', () => {
  it('reads the newest records across rotated files, oldest first, with filters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-logs-'));
    try {
      // A small limit so the records spread over several files.
      const sink = new FileSink({ dir, maxBytes: 64 * 1024, files: 5 });
      const log = createLogger({ level: 'debug', sinks: [sink] });
      for (let i = 0; i < 2000; i += 1) {
        const part = i % 2 === 0 ? log.child('player') : log.child('discord');
        if (i % 10 === 0) part.warn(`warning ${i}`, { i });
        else part.info(`line ${i}`, { i });
      }
      assert.ok(fs.existsSync(path.join(dir, 'jukecord.log.2')), 'the test did not rotate');
      // A broken line (a crash halfway through a write) is skipped.
      fs.appendFileSync(path.join(dir, 'jukecord.log'), '{"time":"2026-1');
      const last = readLogs(dir, { limit: 3 });
      assert.deepEqual(
        last.map((record) => record.msg),
        ['line 1997', 'line 1998', 'line 1999'],
      );
      const warnings = readLogs(dir, { limit: 2, level: 'warn' });
      assert.deepEqual(
        warnings.map((record) => record.msg),
        ['warning 1980', 'warning 1990'],
      );
      const discord = readLogs(dir, { limit: 2, component: 'discord' });
      assert.deepEqual(
        discord.map((record) => record.msg),
        ['line 1997', 'line 1999'],
      );
      // Paging back from a record's time gives the ones before it.
      const before = readLogs(dir, { limit: 1, before: last[0]?.time ?? '' });
      assert.ok((before[0]?.time ?? '') < (last[0]?.time ?? ''));
      assert.deepEqual(readLogs(path.join(dir, 'missing'), { limit: 5 }), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
