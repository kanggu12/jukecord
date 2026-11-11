import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createLogger, FileSink, MemorySink, redact } from '../../src/log.ts';

describe('redact', () => {
  it('masks Discord tokens, authorization headers and jukecord API tokens', () => {
    // Made up, and put together here so no whole token sits in the source (see config.test.ts).
    const token = ['MTA4ODc2NTQzMjEwOTg3NjU0Mw', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.');
    const text = redact(`login with ${token}; Authorization: Bot ${token}; key jkc_abcdefghijklmnop1234`);
    assert.ok(!text.includes('abcdefghijklmnopqrstuvwxyz'));
    assert.ok(!text.includes('jkc_abcdefghijklmnop1234'));
    assert.match(text, /\[token\]/);
  });
});

describe('createLogger', () => {
  it('passes the configured level and above, with the component name', () => {
    const sink = new MemorySink();
    const log = createLogger({ level: 'info', sinks: [sink] }).child('player');
    log.debug('hidden');
    log.info('shown', { guild: '1' });
    log.error('failed', { error: new Error('boom') });
    assert.deepEqual(
      sink.records.map((record) => [record.level, record.component, record.msg]),
      [
        ['info', 'player', 'shown'],
        ['error', 'player', 'failed'],
      ],
    );
    // Errors keep their message (JSON.stringify alone would write {}).
    const failure = sink.records[1]?.fields.error as { message: string } | undefined;
    assert.equal(failure?.message, 'boom');
  });
});

describe('FileSink', () => {
  it('rotates at the size limit and keeps only the configured number of files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-log-'));
    try {
      const sink = new FileSink({ dir, maxBytes: 400, files: 3 });
      const log = createLogger({ level: 'info', sinks: [sink] });
      // Each record is about 110 bytes, so 20 records cross the limit several times.
      for (let i = 0; i < 20; i += 1) log.info(`line ${i}`);
      const files = fs.readdirSync(dir).sort();
      assert.deepEqual(files, ['jukecord.log', 'jukecord.log.1', 'jukecord.log.2']);
      for (const file of files) assert.ok(fs.statSync(path.join(dir, file)).size <= 400, `${file} is over the limit`);
      // The newest line is in the current file, as JSON.
      const last = fs.readFileSync(path.join(dir, 'jukecord.log'), 'utf8').trim().split('\n').at(-1) ?? '';
      assert.equal(JSON.parse(last).msg, 'line 19');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a file left by an earlier run towards the limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-log-'));
    try {
      fs.writeFileSync(path.join(dir, 'jukecord.log'), 'x'.repeat(390));
      const sink = new FileSink({ dir, maxBytes: 400, files: 2 });
      createLogger({ level: 'info', sinks: [sink] }).info('after a restart');
      assert.ok(fs.existsSync(path.join(dir, 'jukecord.log.1')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
