import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { ConsoleSink, createLogger, FileSink, jsonLine, type LogRecord, MemorySink, redact } from '../../src/log.ts';

// What a sink writes to stdout and stderr while `fn` runs, line by line.
function console(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => out.push(chunk) > 0) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => err.push(chunk) > 0) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
  return { out, err };
}

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

describe('the console in JSON (JUKECORD_LOG_FORMAT=json)', () => {
  it('writes one JSON object per line, with the time, level, component, message and fields, secrets masked', () => {
    const cycle: Record<string, unknown> = { name: 'request' };
    cycle.self = cycle;
    const written = console(() => {
      const log = createLogger({ level: 'debug', sinks: [new ConsoleSink('json')] }).child('web');
      log.info('a request', { guild: '100000000000000001', took: 12.5, nested: { a: [1, 2] } });
      log.warn('a line\nbreak and "quotes"', { error: new Error('boom\nat two lines') });
      log.error('cannot serialise these', { cycle, big: 10n, kept: 'yes', auth: 'Bearer abcdefghijklmnop' });
      log.debug('nothing', {});
    });
    // Warnings and errors on stderr, as the text lines go.
    assert.equal(written.out.length, 2);
    assert.equal(written.err.length, 2);
    const records = [...written.out, ...written.err].map((line) => {
      // One line each, ending in a line break and holding no other.
      assert.match(line, /^[^\n]+\n$/);
      return JSON.parse(line) as LogRecord;
    });
    for (const record of records) {
      assert.match(record.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(record.component, 'web');
      assert.equal(typeof record.msg, 'string');
      assert.equal(typeof record.fields, 'object');
    }
    const [info, debug, warn, error] = records;
    assert.deepEqual(info?.fields, { guild: '100000000000000001', took: 12.5, nested: { a: [1, 2] } });
    assert.equal(debug?.level, 'debug');
    assert.equal(warn?.msg, 'a line\nbreak and "quotes"');
    assert.equal((warn?.fields.error as { message: string } | undefined)?.message, 'boom\nat two lines');
    // What JSON cannot hold is a note in its place; the rest of the record stays, masked.
    assert.equal(error?.level, 'error');
    assert.deepEqual(error?.fields.cycle, { unserialisable: '[object Object]' });
    assert.deepEqual(error?.fields.big, { unserialisable: '10' });
    assert.equal(error?.fields.kept, 'yes');
    assert.equal(error?.fields.auth, 'Bearer [redacted]');
  });

  it('writes the very lines the log file holds, which the log page reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-log-'));
    try {
      const file = new FileSink({ dir, maxBytes: 1024 ** 2, files: 2 });
      const written = console(() => {
        const log = createLogger({ level: 'info', sinks: [new ConsoleSink('json'), file] }).child('player');
        log.info('played', { title: 'Track a' });
      });
      assert.equal(fs.readFileSync(path.join(dir, 'jukecord.log'), 'utf8'), written.out.join(''));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the readable line by default', () => {
    const written = console(() => {
      createLogger({ level: 'info', sinks: [new ConsoleSink()] })
        .child('cache')
        .info('cleaned up', { removed: 3 });
    });
    assert.match(written.out[0] ?? '', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z info {2}cache: cleaned up removed=3\n$/);
  });

  it('is chosen by JUKECORD_LOG_FORMAT, text when unset, and anything else is refused', () => {
    assert.equal(loadConfig({}, '/tmp').log.format, 'text');
    assert.equal(loadConfig({ JUKECORD_LOG_FORMAT: 'JSON' }, '/tmp').log.format, 'json');
    assert.throws(
      () => loadConfig({ JUKECORD_LOG_FORMAT: 'logfmt' }, '/tmp'),
      /JUKECORD_LOG_FORMAT: "logfmt" is not text or json/,
    );
  });

  it('builds the line a record makes, the same however it is written', () => {
    const record: LogRecord = { time: '2026-11-24T00:00:00.000Z', level: 'info', component: 'x', msg: 'm', fields: {} };
    assert.equal(
      jsonLine(record),
      '{"time":"2026-11-24T00:00:00.000Z","level":"info","component":"x","msg":"m","fields":{}}',
    );
  });
});
