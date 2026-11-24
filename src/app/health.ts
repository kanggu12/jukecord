/**
 * Whether jukecord can serve, part by part, for `/readyz` and the metrics: the database, the bus, the shared cache,
 * Discord (when there is a bot) and the media programs, the parts `jukecord doctor` checks, each with its state.
 *
 * jukecord is ready when every part it cannot serve without works: the database, the bus and the shared cache.
 * Discord and the media programs are reported but do not decide it, as in 0.3: without them the panel still serves and
 * says what is wrong, where a pod taken out of its Service would show nothing at all.
 *
 * The answer is kept for a second and shared by everyone asking meanwhile, so a storm of probes costs one check a
 * second; a part that does not answer within two seconds is down for that check. The answer says states and backend
 * names only, never an address or an error's text: `/readyz` needs no login.
 */
import type { Cache } from '../cache/cache.ts';
import type { ToolName, ToolWatch } from '../metrics/media.ts';
import { type Metrics, NO_METRICS } from '../metrics/registry.ts';
import type { GATEWAY_STATES } from '../metrics/service.ts';
import type { Store } from '../store/store.ts';

/** A part's state: works, does not, is on its way (Discord connecting), or not known yet (nothing has run). */
export type PartState = 'ok' | 'down' | 'connecting' | 'unknown';

/** One part jukecord checks. */
export interface HealthPart {
  /** Its name in the answer: database, bus, cache, discord, ffmpeg, yt-dlp. */
  readonly name: string;
  /** Which backend it is, when there are several (sqlite, postgres, in-process, redis, memory). */
  readonly kind?: string;
  /** Whether jukecord is not ready while this part does not work. */
  readonly required: boolean;
  /** Its state now; a check that throws is down. */
  check(): PartState | Promise<PartState>;
}

/** One part in the answer. */
export interface PartReport {
  readonly state: PartState;
  readonly required: boolean;
  readonly kind?: string;
}

/** The answer of `/readyz`; `discord` is 0.3's field, kept: whether the bot is connected. */
export interface Readiness {
  readonly ready: boolean;
  readonly discord: boolean;
  readonly parts: Readonly<Record<string, PartReport>>;
}

export interface HealthOptions {
  readonly parts: readonly HealthPart[];
  /** Whether the bot is connected (false without one). */
  readonly discord: () => boolean;
  /** How long an answer is kept (a second). */
  readonly maxAgeMs?: number;
  /** How long a part may take to answer before it counts as down (two seconds). */
  readonly waitMs?: number;
  /** The steady clock, in milliseconds (tests set it). */
  readonly now?: () => number;
  /** Where `jukecord_ready` and each part's state are reported. */
  readonly metrics?: Metrics;
}

/** The parts' checks, run at most once a second. */
export class Health {
  private readonly options: HealthOptions;
  private readonly now: () => number;
  // The last answer and when it was made; the check under way, which everyone asking meanwhile waits for.
  private last: { readonly at: number; readonly readiness: Readiness } | null = null;
  private checking: Promise<Readiness> | null = null;

  constructor(options: HealthOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    const metrics = options.metrics ?? NO_METRICS;
    const ready = metrics.gauge('jukecord_ready', 'Whether jukecord can serve (what /readyz answers): 1 or 0.');
    const up = metrics.gauge(
      'jukecord_part_up',
      'Whether each part /readyz checks works (1) or not (0): database, bus, cache, discord, ffmpeg, yt-dlp.',
      ['part'],
    );
    // Asked before every scrape; the answer kept for a second serves the scrape and the probes alike.
    metrics.gather(async () => {
      const readiness = await this.read();
      ready.set(readiness.ready ? 1 : 0);
      for (const [part, report] of Object.entries(readiness.parts)) up.set(report.state === 'ok' ? 1 : 0, { part });
    });
  }

  /** The parts' states and whether jukecord is ready: the last answer if it is under a second old. */
  read(): Promise<Readiness> {
    const last = this.last;
    if (last && this.now() - last.at < (this.options.maxAgeMs ?? 1000)) return Promise.resolve(last.readiness);
    this.checking ??= this.check().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  // Checks every part at once, each within the wait.
  private async check(): Promise<Readiness> {
    const reports = await Promise.all(
      this.options.parts.map(async (part): Promise<[string, PartReport]> => {
        const state = await this.within(part);
        return [part.name, { state, required: part.required, ...(part.kind ? { kind: part.kind } : {}) }];
      }),
    );
    const parts = Object.fromEntries(reports);
    const readiness: Readiness = {
      ready: reports.every(([, report]) => !report.required || report.state === 'ok'),
      discord: this.options.discord(),
      parts,
    };
    this.last = { at: this.now(), readiness };
    return readiness;
  }

  // One part's state, or down when it throws or does not answer within the wait.
  private async within(part: HealthPart): Promise<PartState> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<PartState>((resolve) => {
      timer = setTimeout(() => resolve('down'), this.options.waitMs ?? 2000);
      timer.unref();
    });
    try {
      return await Promise.race([Promise.resolve().then(() => part.check()), late]);
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The database: open, and answering a statement. */
export function databasePart(store: Store): HealthPart {
  return {
    name: 'database',
    kind: store.sql.dialect,
    required: true,
    check: async () => {
      if (!store.isOpen()) return 'down';
      await store.sql.get('SELECT 1 AS ok');
      return 'ok';
    },
  };
}

/** The bus: in-process always works; an adapter over a network gives its own check. */
export function busPart(kind: string, check: () => PartState | Promise<PartState> = () => 'ok'): HealthPart {
  return { name: 'bus', kind, required: true, check };
}

/** The shared cache, by its own ping (a round trip for a server). */
export function cachePart(cache: Cache): HealthPart {
  return { name: 'cache', kind: cache.kind, required: true, check: async () => ((await cache.ping()) ? 'ok' : 'down') };
}

/** Discord, when there is a bot: connected, on its way (connecting, resuming), or disconnected. */
export function discordPart(gateway: () => { readonly state: (typeof GATEWAY_STATES)[number] } | null): HealthPart {
  return {
    name: 'discord',
    required: false,
    check: () => {
      const state = gateway()?.state;
      if (state === 'ready') return 'ok';
      return state === 'disconnected' || state === undefined ? 'down' : 'connecting';
    },
  };
}

// How often a program that is missing (or not run yet) is looked for again.
const PROBE_EVERY_MS = 60_000;

/**
 * A media program, as its runs say (src/metrics/media.ts ToolWatch): there once one started, missing once one could
 * not. Before any run, and while it is missing, it is run once more in the background (its version), at most once a
 * minute, so the answer comes without a probe starting a program each time.
 */
export function toolPart(tool: ToolName, tools: ToolWatch, probe: () => Promise<unknown>): HealthPart {
  let probing = false;
  let probedAt = Number.NEGATIVE_INFINITY;
  return {
    name: tool,
    required: false,
    check: () => {
      const state = tools.state(tool);
      if (state !== 'ok' && !probing && performance.now() - probedAt >= PROBE_EVERY_MS) {
        probing = true;
        probedAt = performance.now();
        // Its outcome reaches the watch through the run's meter; the failure itself is the watch's to tell.
        void probe()
          .catch(() => {})
          .finally(() => {
            probing = false;
          });
      }
      return state;
    },
  };
}
