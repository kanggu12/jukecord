/**
 * The media pipeline's numbers: getting tracks (fetches, their outcomes and why they failed), the media cache, and the
 * programs that do the work (yt-dlp and FFmpeg), each run counted by what it was for and how it ended.
 *
 * The programs' runs also tell whether each program works at all (ToolWatch.state): one that could not be started is
 * missing; one that started is there, whatever the site then said. `/readyz` reports that, without starting anything
 * of its own on every probe.
 */
import { plainReason, REASONS } from '../core/reasons.ts';
import { type Counter, type Gauge, type Histogram, type Metrics, NO_METRICS } from './registry.ts';

/** The programs jukecord runs. */
export type ToolName = 'yt-dlp' | 'ffmpeg';

/**
 * What a run was for: yt-dlp's version, a lookup, a search, a mix, a download into FFmpeg or into a file; FFmpeg's
 * check of itself, an encode from yt-dlp or from a file, an MP3 copy, or a voice channel's stream.
 */
export type ToolJob =
  | 'version'
  | 'lookup'
  | 'search'
  | 'mix'
  | 'download'
  | 'download-file'
  | 'about'
  | 'encode'
  | 'encode-file'
  | 'mp3'
  | 'voice';

/** How a run ended: well, with a failure of its own, at its time limit, stopped by jukecord, or never started. */
export type ToolOutcome = 'ok' | 'failed' | 'timeout' | 'cancelled' | 'missing';

/** What the runs say of a program: there, missing, or not known before the first run. */
export type ToolState = 'ok' | 'down' | 'unknown';

/** Says how one run ended; the first call counts, a second does nothing. */
export type ToolMeter = (outcome: ToolOutcome) => void;

// The durations of runs: a version check takes a tenth of a second, a long track's download ten minutes.
const TOOL_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];
// A fetch is a download and an encode together: seconds for a song, minutes for an hour-long mix.
const FETCH_BUCKETS = [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600];

/** Counts the programs' runs, and keeps what they say of each program. */
export class ToolWatch {
  private readonly runs: Counter;
  private readonly durations: Histogram;
  private readonly running: Gauge;
  private readonly states = new Map<ToolName, ToolState>();

  constructor(metrics: Metrics = NO_METRICS) {
    this.runs = metrics.counter(
      'jukecord_media_tool_runs_total',
      'Runs of yt-dlp and FFmpeg, by what each was for and how it ended (ok, failed, timeout, cancelled, missing).',
      ['tool', 'job', 'outcome'],
    );
    this.durations = metrics.histogram(
      'jukecord_media_tool_duration_seconds',
      "How long yt-dlp's and FFmpeg's runs took, by what each was for (voice channels' streams, which last as long as the track, left out).",
      ['tool', 'job'],
      TOOL_BUCKETS,
    );
    this.running = metrics.gauge('jukecord_media_tools_running', 'Processes of yt-dlp and FFmpeg running now.', [
      'tool',
    ]);
    // Both programs are named from the start, at zero, so a dashboard shows them before their first run.
    for (const tool of ['yt-dlp', 'ffmpeg'] as const) this.running.inc({ tool }, 0);
  }

  /** A run of `tool` for `job` starts now; the meter it gives says how it ended. */
  start(tool: ToolName, job: ToolJob): ToolMeter {
    const started = performance.now();
    const labels = { tool };
    this.running.inc(labels);
    let done = false;
    return (outcome) => {
      if (done) return;
      done = true;
      this.running.dec(labels);
      this.runs.inc({ tool, job, outcome });
      // A stream's length is the track's, not the work's: only the jobs that end when their work does are timed.
      if (job !== 'voice') this.durations.observe((performance.now() - started) / 1000, { tool, job });
      // A program that could not be started is missing; one that started is there, whatever it then said.
      this.states.set(tool, outcome === 'missing' ? 'down' : 'ok');
    };
  }

  /** What the runs say of a program so far. */
  state(tool: ToolName): ToolState {
    return this.states.get(tool) ?? 'unknown';
  }
}

/** The short name of why a fetch failed, from a list that does not grow: what the panel says, as a label. */
export function failureKind(message: string): string {
  const reason = plainReason(message);
  for (const [key, text] of Object.entries(REASONS)) {
    // botCheck -> bot-check, the label's spelling.
    if (text === reason) return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  }
  // "the site answered 403": by its class, as a status's three digits would make a series each.
  const status = /the site answered (\d)\d\d/.exec(reason)?.[1];
  return status ? `http-${status}xx` : 'failed';
}

/** What the media preparer (src/media/preparer.ts) counts. */
export interface FetchMetrics {
  /** Plays that found their track in the media cache, or had it fetched first. */
  readonly lookups: Counter;
  /** Fetches ended: ok, failed, or cancelled (everyone who wanted it gave up). */
  readonly outcomes: Counter;
  /** Failed fetches by why, in the panel's words as labels (failureKind). */
  readonly failures: Counter;
  /** How long a fetch took, from its start (after any wait for its turn) to the track in the cache. */
  readonly duration: Histogram;
  /** The fetches running and waiting for their turn, by whether somebody waits for them now. */
  readonly fetches: Gauge;
}

/** Declares the preparer's families. */
export function fetchMetrics(metrics: Metrics): FetchMetrics {
  return {
    lookups: metrics.counter(
      'jukecord_cache_lookups_total',
      'Tracks a play asked the media cache for: there already (hit), or fetched first (miss).',
      ['result'],
    ),
    outcomes: metrics.counter(
      'jukecord_fetches_total',
      'Tracks fetched into the media cache (downloaded and encoded), by how it ended: ok, failed, or cancelled.',
      ['outcome'],
    ),
    failures: metrics.counter(
      'jukecord_fetch_failures_total',
      'Fetches that failed, by why (bot-check, unavailable, too-long, offline, http-4xx, ...).',
      ['reason'],
    ),
    duration: metrics.histogram(
      'jukecord_fetch_duration_seconds',
      'How long a fetch that worked took, from its start to the track in the media cache.',
      [],
      FETCH_BUCKETS,
    ),
    fetches: metrics.gauge(
      'jukecord_fetch_jobs',
      'Fetches running and waiting for their turn, by whether somebody waits for them now (now) or they are ahead.',
      ['state', 'priority'],
    ),
  };
}
