/**
 * Reading the log files back for the panel's log page and `jukecord logs`.
 *
 * The file sink writes JSON lines to jukecord.log and rotates it to jukecord.log.1, .2 and so on (src/log.ts); this
 * reads them newest first until it has enough records, and returns them oldest first, the order people read logs in.
 * The files are small (5 MiB each by default), so reading a whole file is cheaper than seeking backwards through it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from '../config.ts';

/** One record as the API returns it. */
export interface LogLine {
  readonly time: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

export interface LogQuery {
  readonly limit: number;
  /** The lowest level returned. */
  readonly level?: LogLevel;
  /** Only this part of jukecord ("player", "discord"); a prefix, so "web" also matches "web.auth". */
  readonly component?: string;
  /** Only records older than this ISO time, for paging back. */
  readonly before?: string;
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

// One JSON line, or null for a line that is not one of ours (a half-written line after a crash, a hand edit).
function parse(line: string): LogLine | null {
  try {
    const record = JSON.parse(line) as Partial<LogLine>;
    if (typeof record.time !== 'string' || typeof record.msg !== 'string') return null;
    if (!record.level || !(record.level in RANK)) return null;
    return {
      time: record.time,
      level: record.level,
      component: typeof record.component === 'string' ? record.component : '',
      msg: record.msg,
      fields: record.fields && typeof record.fields === 'object' ? record.fields : {},
    };
  } catch {
    return null;
  }
}

/** The newest records matching the query, oldest first. `dir` is the log directory; `files` is how many are kept. */
export function readLogs(dir: string, query: LogQuery, files = 50): LogLine[] {
  const minimum = RANK[query.level ?? 'debug'];
  const found: LogLine[] = [];
  // jukecord.log is the newest, then .1, .2 ...; stop at the first file that does not exist.
  for (let index = 0; index < files && found.length < query.limit; index += 1) {
    const file = path.join(dir, index === 0 ? 'jukecord.log' : `jukecord.log.${index}`);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      break;
    }
    const lines = text.split('\n');
    // Newest first within the file too, so the limit keeps the newest records.
    for (let at = lines.length - 1; at >= 0 && found.length < query.limit; at -= 1) {
      const record = parse(lines[at] ?? '');
      if (!record || RANK[record.level] < minimum) continue;
      if (query.component && !record.component.startsWith(query.component)) continue;
      // ISO times in UTC compare as text in time order.
      if (query.before && record.time >= query.before) continue;
      found.push(record);
    }
  }
  return found.reverse();
}
