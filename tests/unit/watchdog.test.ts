import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { takeWatchdogMark } from '../../src/watchdog.ts';

const WATCHDOG = path.resolve(import.meta.dirname, '../../src/watchdog.ts');

// A Node process that starts the watchdog with a short limit and then does `then` (code run on its main thread).
function child(then: string): Promise<{ signal: NodeJS.Signals | null; code: number | null; stderr: string }> {
  const script = `import { startWatchdog } from ${JSON.stringify(WATCHDOG)}; startWatchdog(600); ${then}`;
  const run = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  run.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) => run.on('exit', (code, signal) => resolve({ code, signal, stderr })));
}

describe('the watchdog', () => {
  it('ends a process whose main thread hangs, and says why', async () => {
    // Busy for ten seconds without ever returning to the event loop.
    const started = Date.now();
    const result = await child('const end = Date.now() + 10_000; while (Date.now() < end) {}');
    assert.equal(result.signal, 'SIGKILL');
    assert.match(result.stderr, /has not answered for \d+ s/);
    // Well before the loop would have ended by itself.
    assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
  });

  it('does not take a frozen process for a hung main thread once it is thawed', async () => {
    // The whole process stopped for two seconds (docker pause, a laptop asleep), then let go: both threads were
    // still, so nothing can be said about the main one. It must run on and end by itself.
    // The main thread is busy in short bursts (as a server under load is), so that when the process is let go the
    // watching thread usually looks before the main one has moved the counter.
    const script = `import { startWatchdog } from ${JSON.stringify(WATCHDOG)}; startWatchdog(600);
      const busy = setInterval(() => { const end = Date.now() + 45; while (Date.now() < end) {} }, 50);
      setTimeout(() => clearInterval(busy), 4500);`;
    const run = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    run.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      run.on('exit', (code, signal) => resolve({ code, signal })),
    );
    // Once it is up and watching: stop it for well over the limit, then let it continue.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    run.kill('SIGSTOP');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    run.kill('SIGCONT');
    const result = await ended;
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 0);
  });

  it('leaves a mark for the next start to read, which reads it once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-watchdog-'));
    try {
      const mark = path.join(dir, 'watchdog.json');
      const script = `import { startWatchdog } from ${JSON.stringify(WATCHDOG)}; startWatchdog(600, ${JSON.stringify(mark)});
        const end = Date.now() + 10_000; while (Date.now() < end) {}`;
      const run = spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
        {
          stdio: 'ignore',
        },
      );
      await new Promise((resolve) => run.on('exit', resolve));
      // What the next start says in the log and the alerts channels: when, and how long the main thread was still.
      const read = takeWatchdogMark(mark);
      assert.ok(read && read.stillMs >= 600 && read.at > 0, JSON.stringify(read));
      // Read once: a later start that was not the watchdog's says nothing.
      assert.equal(takeWatchdogMark(mark), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a process alone that keeps answering, and lets it end by itself', async () => {
    // Two seconds of short waits (the event loop runs between them), then a normal exit.
    const result = await child('let left = 20; const tick = () => { if (--left > 0) setTimeout(tick, 100); }; tick();');
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
  });
});
