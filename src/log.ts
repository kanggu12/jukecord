/**
 * Logging: one record per event, written as a readable line to the console and as JSON to a rotated file.
 *
 * The console line is for `docker logs` and a terminal; the JSON file is what the panel's log page and
 * `jukecord logs` read, so it keeps the fields machine-readable. The file never grows without end: it is rotated at a
 * size limit and only a fixed number of files is kept. Secrets are masked before anything is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from './config.ts';

/** Extra facts attached to a record (an error, a guild ID, a duration). */
export type LogFields = Readonly<Record<string, unknown>>;

/** One log event as the sinks receive it. */
export interface LogRecord {
  /** ISO 8601 time in UTC, so files from machines in different time zones sort together. */
  readonly time: string;
  readonly level: LogLevel;
  /** The part of jukecord that wrote it ("player", "discord", "web"). */
  readonly component: string;
  readonly msg: string;
  readonly fields: LogFields;
}

/** Where records go. A sink must not throw: a full disk must not stop the music. */
export interface LogSink {
  write(record: LogRecord): void;
}

/** What the rest of jukecord holds to write logs. */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger for one part of jukecord; its records carry that part's name. */
  child(component: string): Logger;
}

// Numeric order of the levels, so "info" lets info, warn and error through but not debug.
const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

// Patterns for secrets that can end up inside a message (an error from a library quoting its request, say).
// Discord bot tokens are three dot-separated base64url parts; the first part starts with M, N or O.
const DISCORD_TOKEN = /[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/g;
// An Authorization header value, whatever the scheme.
const AUTH_HEADER = /\b(Bearer|Bot|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
// jukecord's own API tokens (src/web issues them with this prefix).
const API_TOKEN = /\bjkc_[A-Za-z0-9_-]{16,}/g;

/** Replaces anything that looks like a secret with a marker. Applied to messages and to string fields alike. */
export function redact(text: string): string {
  return text
    .replace(DISCORD_TOKEN, '[token]')
    .replace(AUTH_HEADER, '$1 [redacted]')
    .replace(API_TOKEN, 'jkc_[redacted]');
}

// Turns field values into something JSON can hold: errors become their name, message and stack (JSON.stringify would
// write {} for them), strings are redacted, and anything that cannot be serialised is described instead of thrown.
function clean(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      // The stack is kept: it is the one thing that tells where a rare failure came from.
      out[key] = {
        name: value.name,
        message: redact(value.message),
        stack: value.stack ? redact(value.stack) : undefined,
      };
    } else if (typeof value === 'string') {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Builds a logger that passes records at `level` and above to every sink. */
export function createLogger(options: { level: LogLevel; sinks: readonly LogSink[]; component?: string }): Logger {
  const component = options.component ?? 'jukecord';
  // One function writes for every level, so the redaction and the level check cannot differ between them.
  const write = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (RANK[level] < RANK[options.level]) return;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      component,
      msg: redact(msg),
      fields: clean(fields),
    };
    for (const sink of options.sinks) sink.write(record);
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    // A child shares the sinks and the level; only the component name changes.
    child: (name) => createLogger({ ...options, component: name }),
  };
}

// JSON.stringify with a guard: a field holding a cycle (a request object, say) is written as a note, not a crash.
function toJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserialisable: String(value) });
  }
}

/**
 * Writes readable lines to the terminal: `time level component: message key=value ...`.
 *
 * Warnings and errors go to stderr so a shell redirect of stdout still shows them.
 */
export class ConsoleSink implements LogSink {
  write(record: LogRecord): void {
    // Fields follow the message as key=value pairs; nested values are written as compact JSON.
    const extras = Object.entries(record.fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : toJson(value)}`)
      .join(' ');
    const line = `${record.time} ${record.level.padEnd(5)} ${record.component}: ${record.msg}${extras ? ` ${extras}` : ''}\n`;
    const stream = record.level === 'warn' || record.level === 'error' ? process.stderr : process.stdout;
    stream.write(line);
  }
}

/**
 * Appends JSON lines to `<dir>/jukecord.log` and rotates the file at `maxBytes`, keeping `files` files in all
 * (jukecord.log, jukecord.log.1, ... jukecord.log.<files-1>).
 *
 * Writes are synchronous: jukecord logs a few lines a minute, and a synchronous append cannot interleave two records
 * or lose the last lines when the process is stopped.
 */
export class FileSink implements LogSink {
  readonly file: string;
  private readonly maxBytes: number;
  private readonly files: number;
  // The current file's size, tracked here so rotation does not need a stat call per line.
  private size: number;
  // Set after the first write failure so a broken disk produces one message, not one per log line.
  private failed = false;

  constructor(options: { dir: string; maxBytes: number; files: number }) {
    this.file = path.join(options.dir, 'jukecord.log');
    this.maxBytes = options.maxBytes;
    this.files = options.files;
    // The directory may not exist on the first start of a new data directory.
    fs.mkdirSync(options.dir, { recursive: true });
    // A file left by the last run counts towards the limit, or a restart loop would never rotate.
    this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
  }

  write(record: LogRecord): void {
    const line = `${toJson(record)}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      // Rotate before a line that would cross the limit; an empty file is never rotated, so one huge line still lands.
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line);
      this.size += bytes;
      this.failed = false;
    } catch (error) {
      // Logging must not take the bot down; say so once on stderr and keep going.
      if (!this.failed) process.stderr.write(`jukecord: cannot write the log file ${this.file}: ${String(error)}\n`);
      this.failed = true;
    }
  }

  // Shifts jukecord.log.N to .N+1 from the oldest down, dropping the one past the limit, then starts a new file.
  private rotate(): void {
    // With files = 1 there is no history: the file is simply emptied.
    if (this.files === 1) {
      fs.truncateSync(this.file, 0);
      this.size = 0;
      return;
    }
    // The oldest kept file is .<files-1>; it is overwritten by the rename below, so it needs no separate delete.
    for (let index = this.files - 2; index >= 1; index -= 1) {
      const from = `${this.file}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${index + 1}`);
    }
    fs.renameSync(this.file, `${this.file}.1`);
    this.size = 0;
  }
}

/** A sink that keeps records in memory; tests read them back. */
export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}
