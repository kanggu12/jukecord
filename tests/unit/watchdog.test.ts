import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

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

  it('leaves a process alone that keeps answering, and lets it end by itself', async () => {
    // Two seconds of short waits (the event loop runs between them), then a normal exit.
    const result = await child('let left = 20; const tick = () => { if (--left > 0) setTimeout(tick, 100); }; tick();');
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
  });
});
