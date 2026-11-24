/**
 * The whole metrics surface: every family jukecord declares follows Prometheus's naming (a unit in the name, counters in
 * _total, the standard names for the process and the runtime) and reads in both formats; and the parts that count do
 * count: the programs' runs, the fetches, the media cache, the event loop, the live connections.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { createLogger } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import type { Ffmpeg } from '../../src/media/ffmpeg.ts';
import { Media } from '../../src/media/preparer.ts';
import { run } from '../../src/media/process.ts';
import type { YtDlp } from '../../src/media/ytdlp.ts';
import { failureKind, ToolWatch } from '../../src/metrics/media.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import { EventLoop, runtimeMetrics } from '../../src/metrics/runtime.ts';
import { discordMetrics } from '../../src/metrics/service.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { parseExposition } from '../support/exposition.ts';
import { everyFamily } from '../support/metrics.ts';
import { addTracks, memoryStore } from '../support/store.ts';
import { GUILD, HOST_TOKEN, type TestServer, testServer } from '../support/web.ts';

const log = createLogger({ level: 'error', sinks: [] });

// The value of one series in the text format, or undefined when it is not there.
function seriesValue(text: string, series: string): number | undefined {
  const line = text.split('\n').find((entry) => entry.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('every family jukecord declares', () => {
  const every = everyFamily();
  after(() => every.close());

  it('reads in both formats, by their rules', () => {
    parseExposition(every.registry.render());
    parseExposition(every.registry.render('openmetrics'), 'openmetrics');
  });

  it("is named by Prometheus's conventions: jukecord's own prefix, units in the name, the standard runtime names", () => {
    for (const family of every.registry.declared()) {
      assert.match(family.name, /^(jukecord|process|nodejs)_[a-z0-9_]+$/, family.name);
      // Durations and sizes in seconds and bytes, said in the name; a histogram measures one of the two.
      if (family.kind === 'histogram') assert.match(family.name, /_(seconds|bytes)$/, family.name);
      if (/_(ms|milliseconds|kb|mb|minutes)(_|$)/.test(family.name)) assert.fail(`${family.name} is not in base units`);
      // Help is a sentence, for the people who read it in Grafana and Prometheus.
      assert.match(family.help, /^[A-Z].*[.)]$/, family.name);
      // No label that names one thing among many: a server, a person, a track, an address; and none Prometheus or
      // Kubernetes' discovery puts on every series of a target, which would rename ours exported_<name> on the way in.
      for (const label of family.labelNames) {
        assert.ok(
          !['job', 'instance', 'namespace', 'pod', 'service', 'container', 'endpoint', 'node'].includes(label),
          `${family.name}{${label}} takes a target's label`,
        );
        assert.doesNotMatch(
          label,
          /guild|server_id|user|person|track|url|address|ip|path|token|session/,
          `${family.name}{${label}}`,
        );
      }
    }
  });
});

describe('Discord, counted', () => {
  it('says only that it is not connected when jukecord runs browser-only, leaving the gateway out', () => {
    const registry = new MetricsRegistry();
    discordMetrics(registry, {
      connected: () => false,
      gateway: () => null,
      guilds: () => 0,
      voice: () => new Map(),
    });
    const text = registry.render();
    parseExposition(text);
    assert.equal(seriesValue(text, 'jukecord_discord_connected'), 0);
    // No gateway: no state, no latency of 0 s, no count of servers, no voice (an alert on them never fires).
    for (const family of [
      'jukecord_discord_gateway_state',
      'jukecord_discord_gateway_latency_seconds',
      'jukecord_discord_guilds',
      'jukecord_voice_connections',
    ]) {
      assert.doesNotMatch(text, new RegExp(`^${family}[{ ]`, 'm'), family);
    }
  });
});

describe('the media programs, counted', () => {
  it('counts each run by how it ended, and tells a missing program from one that is there', async () => {
    const registry = new MetricsRegistry();
    const tools = new ToolWatch(registry);
    assert.equal(tools.state('ffmpeg'), 'unknown');
    await run(process.execPath, ['-e', ''], { meter: tools.start('ffmpeg', 'about') });
    await assert.rejects(run(process.execPath, ['-e', 'process.exit(3)'], { meter: tools.start('ffmpeg', 'mp3') }));
    await assert.rejects(
      run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        meter: tools.start('yt-dlp', 'lookup'),
        timeoutMs: 100,
      }),
      /took longer/,
    );
    const abort = new AbortController();
    const cancelled = run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      meter: tools.start('yt-dlp', 'search'),
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);
    await assert.rejects(cancelled, /cancelled/);
    assert.equal(tools.state('ffmpeg'), 'ok');
    assert.equal(tools.state('yt-dlp'), 'ok');
    await assert.rejects(
      run('/nonexistent/yt-dlp', ['--version'], { meter: tools.start('yt-dlp', 'version') }),
      /not found/,
    );
    assert.equal(tools.state('yt-dlp'), 'down');
    const text = registry.render();
    parseExposition(text);
    for (const [labels, count] of [
      ['tool="ffmpeg",task="about",outcome="ok"', 1],
      ['tool="ffmpeg",task="mp3",outcome="failed"', 1],
      ['tool="yt-dlp",task="lookup",outcome="timeout"', 1],
      ['tool="yt-dlp",task="search",outcome="cancelled"', 1],
      ['tool="yt-dlp",task="version",outcome="missing"', 1],
    ] as const) {
      assert.equal(seriesValue(text, `jukecord_media_tool_runs_total{${labels}}`), count, labels);
    }
    assert.equal(seriesValue(text, 'jukecord_media_tool_duration_seconds_count{tool="yt-dlp",task="lookup"}'), 1);
    // Nothing runs any more.
    assert.equal(seriesValue(text, 'jukecord_media_tools_running{tool="yt-dlp"}'), 0);
    assert.equal(seriesValue(text, 'jukecord_media_tools_running{tool="ffmpeg"}'), 0);
  });

  it('names why a fetch failed from a short list', () => {
    assert.equal(failureKind("ERROR: [youtube] x: Sign in to confirm you're not a bot"), 'bot-check');
    assert.equal(
      failureKind('yt-dlp failed: ERROR: unable to download video data: HTTP Error 403: Forbidden'),
      'http-4xx',
    );
    assert.equal(failureKind('HTTP Error 503: Service Unavailable'), 'http-5xx');
    assert.equal(failureKind('yt-dlp took longer than 60 s'), 'too-long');
    assert.equal(failureKind('ERROR: Video unavailable'), 'unavailable');
    assert.equal(failureKind('getaddrinfo EAI_AGAIN www.youtube.com'), 'offline');
    assert.equal(failureKind('something nobody has seen before'), 'failed');
  });
});

// One Ogg page as the length reader sees it, and a file of a few seconds of Opus made of them.
function oggPage(granule: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(28);
  header.write('OggS', 0, 'latin1');
  header.writeBigUInt64LE(granule, 6);
  header[26] = 1;
  header[27] = payload.length;
  return Buffer.concat([header, payload]);
}
function oggOpus(seconds: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  return Buffer.concat([oggPage(0n, head), oggPage(BigInt(seconds * 48_000), Buffer.alloc(100))]);
}

describe('the fetches and the media cache, counted', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-fetches-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('counts fetches by outcome and failures by why, plays by hit or miss, and what the cache holds and evicts', async () => {
    const registry = new MetricsRegistry();
    const store = await memoryStore();
    const [good, bad, slow, other] = await addTracks(store, 4);
    if (!good || !bad || !slow || !other) throw new Error('no tracks');
    // A cache that holds a little over one track's file, so the second evicts the first.
    const cache = new MediaCache({ dir, maxBytes: 1500, log, metrics: registry });
    cache.init();
    // An ffmpeg that writes a short file at once, fails for one track as YouTube's bot check, and waits on another.
    const ffmpeg = {
      fromYtDlp: (_ytdlp: unknown, url: string, out: string, signal: AbortSignal) => {
        if (url === bad.url) return Promise.reject(new Error("ERROR: Sign in to confirm you're not a bot"));
        if (url === slow.url) {
          // Until it is cancelled, as a real run is, at once when that happened before it started.
          return new Promise((_resolve, reject) => {
            if (signal.aborted) reject(new Error('cancelled'));
            signal.addEventListener('abort', () => reject(new Error('cancelled')));
          });
        }
        fs.writeFileSync(out, Buffer.concat([oggOpus(3), Buffer.alloc(1000)]));
        return Promise.resolve({ loudness: null });
      },
    } as unknown as Ffmpeg;
    const media = new Media({
      cache,
      ytdlp: {} as YtDlp,
      ffmpeg,
      tracks: store.tracks,
      log,
      timeoutMs: 60_000,
      metrics: registry,
    });
    const never = new AbortController().signal;
    await media.prepare(good, never);
    // Played again: from the cache.
    await media.prepare(good, never);
    await assert.rejects(media.prepare(bad, never), /not a bot/);
    const leaving = new AbortController();
    const waiting = media.prepare(slow, leaving.signal);
    // While it runs: one fetch somebody waits for.
    assert.match(registry.render(), /^jukecord_fetch_jobs\{state="running",priority="now"\} 1$/m);
    // Given up while it runs.
    await new Promise((resolve) => setTimeout(resolve, 5));
    leaving.abort();
    await assert.rejects(waiting);
    // Another track pushes the first out of the cache.
    await media.prepare(other, never);
    const text = registry.render();
    parseExposition(text);
    assert.equal(seriesValue(text, 'jukecord_fetches_total{outcome="ok"}'), 2);
    assert.equal(seriesValue(text, 'jukecord_fetches_total{outcome="failed"}'), 1);
    assert.equal(seriesValue(text, 'jukecord_fetches_total{outcome="cancelled"}'), 1);
    assert.equal(seriesValue(text, 'jukecord_fetch_failures_total{reason="bot-check"}'), 1);
    assert.equal(seriesValue(text, 'jukecord_cache_lookups_total{result="hit"}'), 1);
    assert.equal(seriesValue(text, 'jukecord_cache_lookups_total{result="miss"}'), 4);
    assert.equal(seriesValue(text, 'jukecord_fetch_duration_seconds_count'), 2);
    assert.equal(seriesValue(text, 'jukecord_cache_evictions_total{kind="track"}'), 1);
    assert.equal(seriesValue(text, 'jukecord_cache_tracks'), 1);
    assert.equal(seriesValue(text, 'jukecord_cache_limit_bytes'), 1500);
    assert.equal(seriesValue(text, 'jukecord_fetch_jobs{state="running",priority="now"}'), 0);
    await store.close();
  });
});

describe('the event loop and the process', () => {
  it('measures the loop by the second, adds up the seconds behind, and reads the process', async () => {
    const registry = new MetricsRegistry();
    const loop = new EventLoop({ everyMs: 100 });
    runtimeMetrics(registry, loop);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Held for 400 ms: the window it ends in is behind (over 0.2 s at the 99th percentile).
      const until = performance.now() + 400;
      while (performance.now() < until) {
        // Busy on purpose.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      const text = registry.render();
      parseExposition(text);
      assert.ok((seriesValue(text, 'nodejs_eventloop_lag_max_seconds') ?? 0) >= 0 && loop.behindSeconds > 0.3);
      assert.ok((seriesValue(text, 'jukecord_event_loop_behind_seconds_total') ?? 0) > 0.3);
      // The name 0.3 used is still written, beside the standard one.
      assert.equal(
        seriesValue(text, 'jukecord_event_loop_delay_seconds'),
        seriesValue(text, 'nodejs_eventloop_lag_p99_seconds'),
      );
      const utilization = seriesValue(text, 'nodejs_eventloop_utilization_ratio') ?? -1;
      assert.ok(utilization >= 0 && utilization <= 1);
      const started = seriesValue(text, 'process_start_time_seconds') ?? 0;
      assert.ok(Math.abs(started - (Date.now() / 1000 - process.uptime())) < 5);
      assert.ok((seriesValue(text, 'process_resident_memory_bytes') ?? 0) > 10 * 1024 ** 2);
      assert.ok((seriesValue(text, 'nodejs_heap_size_used_bytes') ?? 0) > 0);
      assert.ok((seriesValue(text, 'process_cpu_seconds_total') ?? 0) > 0);
      assert.match(text, /^nodejs_version_info\{version="v\d+\.\d+\.\d+",major="\d+",minor="\d+",patch="\d+"\} 1$/m);
      // The open files where the system tells (Linux), with the limit beside them.
      if (process.platform === 'linux') {
        assert.ok((seriesValue(text, 'process_open_fds') ?? 0) > 0);
        assert.ok((seriesValue(text, 'process_max_fds') ?? 0) >= (seriesValue(text, 'process_open_fds') ?? 0));
      }
    } finally {
      loop.stop();
    }
  });
});

describe('the live connections, counted', () => {
  let server: TestServer;
  after(() => server.close());

  it('counts the open connections and the messages and bytes sent on them, and does not time them as answers', async () => {
    server = await testServer({ listen: true });
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}${API_PREFIX}/events?guild=${GUILD}`, {
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('the live connection failed')), { once: true });
    });
    const open = server.metrics.render();
    assert.equal(seriesValue(open, 'jukecord_panel_connections'), 1);
    assert.ok((seriesValue(open, 'jukecord_panel_messages_total{frame="text"}') ?? 0) >= 1);
    assert.ok((seriesValue(open, 'jukecord_panel_sent_bytes_total') ?? 0) > 0);
    assert.doesNotMatch(open, /route="\/api\/v1\/events"/);
    socket.close();
    // Gone once the hub hears the close.
    for (
      let tries = 0;
      tries < 50 && seriesValue(server.metrics.render(), 'jukecord_panel_connections') !== 0;
      tries += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(seriesValue(server.metrics.render(), 'jukecord_panel_connections'), 0);
  });
});
