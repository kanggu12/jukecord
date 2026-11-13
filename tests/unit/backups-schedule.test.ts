/**
 * The daily backup: made at its time of day (or when jukecord starts after it), once a day, the newest kept, and a
 * failure said once.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Alert } from '../../src/app/alerts.ts';
import { BackupSchedule, listBackups } from '../../src/app/backups.ts';
import { createLogger, MemorySink } from '../../src/log.ts';
import { Store } from '../../src/store/store.ts';
import { FakeClock } from '../support/fakes.ts';

let dir = '';
let zone: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-backups-'));
  // Times of day in a fixed zone, whatever this machine's is.
  zone = process.env.TZ;
  process.env.TZ = 'Asia/Seoul';
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

function setup(start: string, keep = 2) {
  // A clock at a local time in Seoul (UTC+9).
  const clock = new FakeClock(new Date(`${start}+09:00`).getTime());
  const store = Store.open(path.join(dir, 'jukecord.db'), { now: () => clock.now() });
  const sink = new MemorySink();
  const alerts: Alert[] = [];
  const schedule = new BackupSchedule({
    store,
    dir: path.join(dir, 'backups'),
    keep,
    at: { hour: 4, minute: 30 },
    clock,
    log: createLogger({ level: 'debug', sinks: [sink] }),
    alerts: { raise: (alert: Alert) => alerts.push(alert) },
  });
  return { clock, store, sink, alerts, schedule };
}

describe('the daily backup', () => {
  it('is made at its time once a day, and keeps the newest', async () => {
    const { clock, store, sink, schedule } = setup('2026-11-11T03:00:00');
    schedule.start();
    assert.equal(listBackups(path.join(dir, 'backups')).length, 0);
    // 04:30 comes: one backup (written beside the main thread: waited for), and none more that day.
    await clock.advance(90 * 60_000);
    await schedule.idle();
    assert.equal(listBackups(path.join(dir, 'backups')).length, 1);
    await clock.advance(10 * 3_600_000);
    await schedule.idle();
    assert.equal(listBackups(path.join(dir, 'backups')).length, 1);
    // Two days later: three were made, the newest two kept.
    for (let day = 0; day < 2; day += 1) {
      await clock.advance(86_400_000);
      await schedule.idle();
    }
    assert.equal(listBackups(path.join(dir, 'backups')).length, 2);
    assert.equal(sink.records.filter((record) => record.msg === 'made the scheduled backup').length, 3);
    schedule.stop();
    store.close();
  });

  it("is made when jukecord starts after the day's time, unless one was made since", async () => {
    const late = setup('2026-11-11T09:00:00');
    late.schedule.start();
    await late.schedule.idle();
    assert.equal(listBackups(path.join(dir, 'backups')).length, 1);
    late.schedule.stop();
    // Started again the same day: today's is made.
    const again = new BackupSchedule({
      store: late.store,
      dir: path.join(dir, 'backups'),
      keep: 2,
      at: { hour: 4, minute: 30 },
      clock: late.clock,
      log: createLogger({ level: 'error', sinks: [] }),
    });
    again.start();
    await late.clock.advance(3_600_000);
    await again.idle();
    assert.equal(listBackups(path.join(dir, 'backups')).length, 1);
    again.stop();
    late.store.close();
  });

  it('says a failed backup once, in the log and to the alerts, and tries again the next day', async () => {
    const { clock, store, sink, alerts, schedule } = setup('2026-11-11T04:00:00');
    // The backups folder cannot be made: a file stands where it would be.
    fs.writeFileSync(path.join(dir, 'backups'), 'not a folder');
    schedule.start();
    await clock.advance(3_600_000);
    await schedule.idle();
    assert.equal(sink.records.filter((record) => record.msg === 'the scheduled backup failed').length, 1);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]?.en ?? '', /^The scheduled backup failed: /);
    // Kept for `jukecord doctor`, with when it failed: within the hour just gone by.
    const failed = schedule.lastFailure();
    assert.ok(failed && failed.at > clock.now() - 3_600_000 && failed.at <= clock.now());
    assert.match(failed.reason, /\S/);
    await clock.advance(86_400_000);
    await schedule.idle();
    assert.equal(alerts.length, 2);
    // The folder can be made again: the next day's backup works, and nothing failed since.
    fs.rmSync(path.join(dir, 'backups'));
    await clock.advance(86_400_000);
    await schedule.idle();
    assert.equal(schedule.lastFailure(), null);
    schedule.stop();
    store.close();
  });
});
