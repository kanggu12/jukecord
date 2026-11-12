/**
 * The watchdog. When jukecord's main thread stops answering for a long time (a loop that never ends, a call that
 * blocks), nothing on that thread can notice, and to Docker the process still looks alive: Docker restarts a container
 * that exits, not one that hangs. So a small worker thread watches a counter the main thread moves every second; when
 * the counter has not moved for `limitMs`, the worker writes a line to stderr and ends the process. The restart policy
 * (Compose's, the systemd unit's, Kubernetes') then brings jukecord back, paused where each server was: the players
 * save their state on every change.
 */
import { Worker } from 'node:worker_threads';

// The worker's code, the same as a module or a script (getBuiltinModule needs neither import nor require). It writes
// with fs.writeSync: a worker's console goes through the main thread, which is the one that hangs. Its timer is not
// unref'd, so the worker stays while the process runs; the main side unrefs the worker.
const WATCHER = `
const { workerData } = process.getBuiltinModule('node:worker_threads');
const fs = process.getBuiltinModule('node:fs');
const beat = new Int32Array(workerData.buffer);
let seen = Atomics.load(beat, 0);
let movedAt = Date.now();
setInterval(() => {
  const now = Atomics.load(beat, 0);
  if (now !== seen) {
    seen = now;
    movedAt = Date.now();
    return;
  }
  const still = Date.now() - movedAt;
  if (still < workerData.limitMs) return;
  fs.writeSync(2, 'jukecord: the main thread has not answered for ' + Math.round(still / 1000) +
    ' s; ending the process so that it is started again\\n');
  process.kill(process.pid, 'SIGKILL');
}, workerData.checkMs);
`;

/** Starts watching the main thread; returns a function that stops the watch (for a clean shutdown). */
export function startWatchdog(limitMs = 30_000): () => void {
  // One shared number: the main thread adds one every second, the worker reads it.
  const beat = new Int32Array(new SharedArrayBuffer(4));
  const heart = setInterval(() => Atomics.add(beat, 0, 1), Math.min(1000, Math.max(50, limitMs / 10)));
  // The beat alone must not keep the process alive at shutdown.
  heart.unref();
  const worker = new Worker(WATCHER, {
    eval: true,
    // None of the main thread's flags or settings: the worker needs nothing, and starts lighter without them.
    execArgv: [],
    env: {},
    workerData: { buffer: beat.buffer, limitMs, checkMs: Math.min(1000, Math.max(50, limitMs / 10)) },
  });
  worker.unref();
  return () => {
    clearInterval(heart);
    void worker.terminate();
  };
}
