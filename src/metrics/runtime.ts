/**
 * The process and its runtime, under the names Prometheus's own clients use (`process_*`, and prom-client's
 * `nodejs_*`), so the dashboards made for them read jukecord too: processor time, memory, open files, when it started,
 * and how the event loop keeps up.
 *
 * The event loop is measured once for everything that asks (EventLoop): its delay in one-second windows, which is also
 * what tells jukecord it is behind and should turn away work that can wait (src/web/limits.ts has the same rule for a
 * web server made on its own). Every number about the loop is about the last full second; the seconds spent behind add
 * up in a counter, so a stall between two scrapes still shows.
 */
import fs from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { Metrics } from './registry.ts';

/** The event loop's delay over one window, in seconds. */
export interface LoopDelay {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly stddev: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
}

// Before the first window ends: nothing measured yet.
const NO_DELAY: LoopDelay = { min: 0, max: 0, mean: 0, stddev: 0, p50: 0, p90: 0, p99: 0 };

/** Watches the event loop: its delay and how busy it was, one window (a second) at a time. */
export class EventLoop {
  // Node samples the loop's delay every 10 ms (the timer's own interval is part of each sample, as prom-client reports
  // it: an idle loop shows about 0.01 s).
  private readonly histogram = monitorEventLoopDelay({ resolution: 10 });
  private readonly limitMs: number;
  private readonly timer: NodeJS.Timeout;
  private window: LoopDelay = NO_DELAY;
  private busy = 0;
  // The loop's use and the time at the start of the window under way.
  private used = performance.eventLoopUtilization();
  private tickedAt = performance.now();
  private behindMs = 0;

  constructor(options: { limitMs?: number; everyMs?: number } = {}) {
    this.limitMs = options.limitMs ?? 200;
    this.histogram.enable();
    this.timer = setInterval(() => this.tick(), options.everyMs ?? 1000);
    // Measuring must not keep the process alive.
    this.timer.unref();
  }

  /** The delay over the last window. */
  get delay(): LoopDelay {
    return this.window;
  }

  /** The 99th percentile of the delay over the last window, in milliseconds. */
  get delayMs(): number {
    return this.window.p99 * 1000;
  }

  /** Whether jukecord is so far behind that work which can wait should be turned away (the p99 over 0.2 s). */
  get behind(): boolean {
    return this.delayMs > this.limitMs;
  }

  /** How much of the last window the loop spent working rather than waiting, from 0 to 1. */
  get utilization(): number {
    return this.busy;
  }

  /** The seconds spent behind since jukecord started. */
  get behindSeconds(): number {
    return this.behindMs / 1000;
  }

  stop(): void {
    clearInterval(this.timer);
    this.histogram.disable();
  }

  // Ends a window: its delay (nanoseconds from Node) and use, then a fresh start, so a busy moment ends when it is over.
  private tick(): void {
    const histogram = this.histogram;
    // A window with no sample at all (the loop blocked through it) keeps the last one's numbers until a sample comes.
    if (histogram.count > 0) {
      this.window = {
        min: histogram.min / 1e9,
        max: histogram.max / 1e9,
        mean: histogram.mean / 1e9,
        stddev: histogram.stddev / 1e9,
        p50: histogram.percentile(50) / 1e9,
        p90: histogram.percentile(90) / 1e9,
        p99: histogram.percentile(99) / 1e9,
      };
    }
    histogram.reset();
    const used = performance.eventLoopUtilization();
    this.busy = performance.eventLoopUtilization(used, this.used).utilization;
    this.used = used;
    // A window behind counts whole, however long it ran: a stall of five seconds is one late window of five seconds.
    const now = performance.now();
    if (this.behind) this.behindMs += now - this.tickedAt;
    this.tickedAt = now;
  }
}

// The kernel's limit on open files for this process (Linux, /proc/self/limits), or null where there is none to read.
function maxFiles(): number | null {
  try {
    const line = fs
      .readFileSync('/proc/self/limits', 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('Max open files'));
    const soft = Number(line?.split(/\s{2,}/)[1]);
    return Number.isFinite(soft) ? soft : null;
  } catch {
    return null;
  }
}

// How many files this process has open (Linux), or null elsewhere; the listing's own descriptor is not counted.
function openFiles(): number | null {
  try {
    return fs.readdirSync('/proc/self/fd').length - 1;
  } catch {
    return null;
  }
}

/**
 * Declares the process's and the runtime's numbers, read each time the metrics are written; the event loop's when
 * there is one to read (a web server made for a test has its own, see limits.ts).
 */
export function runtimeMetrics(metrics: Metrics, loop: EventLoop | null): void {
  const cpuUser = metrics.counter('process_cpu_user_seconds_total', 'Processor time spent in user mode, in seconds.');
  const cpuSystem = metrics.counter(
    'process_cpu_system_seconds_total',
    'Processor time spent in the kernel, in seconds.',
  );
  const cpu = metrics.counter('process_cpu_seconds_total', 'Processor time spent in user mode and in the kernel.');
  const started = metrics.gauge('process_start_time_seconds', 'When the process started, in seconds since 1970.');
  const resident = metrics.gauge('process_resident_memory_bytes', 'Memory the process holds in RAM.');
  const open = metrics.gauge('process_open_fds', 'Files and sockets the process has open (Linux).');
  const most = metrics.gauge('process_max_fds', 'The most files and sockets the process may have open (Linux).');
  const heapTotal = metrics.gauge('nodejs_heap_size_total_bytes', "The JavaScript heap's size.");
  const heapUsed = metrics.gauge('nodejs_heap_size_used_bytes', 'The part of the JavaScript heap in use.');
  const external = metrics.gauge('nodejs_external_memory_bytes', 'Memory outside the heap held by JavaScript objects.');
  const version = metrics.gauge('nodejs_version_info', 'The Node.js version jukecord runs on.', [
    'version',
    'major',
    'minor',
    'patch',
  ]);
  // The version never changes while the process runs: set once.
  const [major = '', minor = '', patch = ''] = process.versions.node.split('.');
  version.set(1, { version: process.version, major, minor, patch });
  started.set(performance.timeOrigin / 1000);
  // Processor time is a running total kept by the system; the counters add what came since the last read.
  let last = { user: 0, system: 0 };
  metrics.collect(() => {
    const usage = process.cpuUsage();
    const user = (usage.user - last.user) / 1e6;
    const system = (usage.system - last.system) / 1e6;
    last = usage;
    cpuUser.inc({}, user);
    cpuSystem.inc({}, system);
    cpu.inc({}, user + system);
    const memory = process.memoryUsage();
    resident.set(memory.rss);
    heapTotal.set(memory.heapTotal);
    heapUsed.set(memory.heapUsed);
    external.set(memory.external);
    // Only where the system tells (Linux); elsewhere the two families have no samples.
    const files = openFiles();
    if (files !== null) open.set(files);
    const limit = maxFiles();
    if (limit !== null) most.set(limit);
  });
  if (loop) loopMetrics(metrics, loop);
}

// The event loop's numbers: prom-client's names for the delay, OpenTelemetry's for the use, and jukecord's own seconds
// behind; the name 0.3 used for the delay stays one release beside them.
function loopMetrics(metrics: Metrics, loop: EventLoop): void {
  const window = 'over the last second, in seconds';
  const delays = (['min', 'max', 'mean', 'stddev', 'p50', 'p90', 'p99'] as const).map((stat) => {
    const what = {
      min: 'least',
      max: 'greatest',
      mean: 'mean',
      stddev: 'standard deviation of the',
      p50: 'median',
      p90: '90th percentile of the',
      p99: '99th percentile of the',
    }[stat];
    return [
      stat,
      metrics.gauge(`nodejs_eventloop_lag_${stat}_seconds`, `The ${what} event loop delay ${window}.`),
    ] as const;
  });
  const utilization = metrics.gauge(
    'nodejs_eventloop_utilization_ratio',
    'How much of the last second the event loop spent working rather than waiting, from 0 to 1.',
  );
  const behind = metrics.counter(
    'jukecord_event_loop_behind_seconds_total',
    "Seconds jukecord was behind (the event loop's 99th percentile delay over 0.2 s) and turned away what could wait.",
  );
  const old = metrics.gauge(
    'jukecord_event_loop_delay_seconds',
    "The 99th percentile of the event loop's delay over the last second. Deprecated: nodejs_eventloop_lag_p99_seconds (this name goes in 0.5).",
  );
  let counted = 0;
  metrics.collect(() => {
    const delay = loop.delay;
    for (const [stat, gauge] of delays) gauge.set(delay[stat]);
    utilization.set(loop.utilization);
    // The counter adds what came since the last read: a running total kept by the loop's watch.
    behind.inc({}, Math.max(0, loop.behindSeconds - counted));
    counted = loop.behindSeconds;
    old.set(delay.p99);
  });
}

/** Free space and size of the disk the data folder is on (the database, the media cache and the logs). */
export function diskMetrics(metrics: Metrics, dataDir: string): void {
  const free = metrics.gauge(
    'jukecord_disk_free_bytes',
    'Free space, for jukecord, on the disk holding the data folder (the database, the media cache, the logs).',
  );
  const size = metrics.gauge('jukecord_disk_size_bytes', 'The size of the disk holding the data folder.');
  metrics.collect(() => {
    // What an unprivileged user may still write (bavail), the space jukecord can use.
    const disk = fs.statfsSync(dataDir);
    free.set(disk.bavail * disk.bsize);
    size.set(disk.blocks * disk.bsize);
  });
}
