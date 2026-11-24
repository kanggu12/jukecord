/**
 * The metrics registry: every number jukecord reports to a monitoring system, declared once with its help text and
 * its labels, and written out in Prometheus's text format for `/metrics` (or in OpenMetrics, for a scraper that asks).
 *
 * A module that has something to count asks the registry for a counter, a gauge or a histogram by name when it is
 * built, and from then on only adds, sets or observes. Asking twice for the same name gives the same metric, so two
 * instances of a module share it. Label names are declared up front and a value for any other label is refused: a
 * typo fails a test instead of splitting a series. Label values must come from a short list (a route, an outcome, a
 * kind): never a server, a person, an address or a track, which would make a series for each.
 *
 * Names follow Prometheus's rules, checked when a metric is declared: a counter's name ends in `_total` (OpenMetrics
 * writes its samples so), and no other kind's name ends in a suffix the formats give samples of their own (`_total`,
 * `_count`, `_sum`, `_bucket`, `_created`), so no sample of one metric can be read as another's.
 */

/** A metric's labels and their values. */
export type Labels = Readonly<Record<string, string>>;

export interface Counter {
  /** Adds `by` (1 by default, never negative) to the series of these labels. */
  inc(labels?: Labels, by?: number): void;
}

export interface Gauge {
  /** Sets the series of these labels to the value. */
  set(value: number, labels?: Labels): void;
  inc(labels?: Labels, by?: number): void;
  dec(labels?: Labels, by?: number): void;
}

export interface Histogram {
  /** Counts one observation (a duration in seconds, a size in bytes) into the series of these labels. */
  observe(value: number, labels?: Labels): void;
  /** Starts a timer; the function it gives observes the seconds since, once. */
  time(labels?: Labels): () => void;
}

/** What modules report into: a registry, or one that keeps nothing (tests that do not look at metrics). */
export interface Metrics {
  counter(name: string, help: string, labelNames?: readonly string[]): Counter;
  gauge(name: string, help: string, labelNames?: readonly string[]): Gauge;
  histogram(name: string, help: string, labelNames?: readonly string[], buckets?: readonly number[]): Histogram;
  /** Runs `fn` each time the metrics are written out, for gauges read from somewhere else at that moment. */
  collect(fn: () => void): void;
  /**
   * Runs `fn` before the metrics are written out and waits for it (a second at most), for numbers that take a question
   * to another part first: the database, a part's health. Two scrapes at once share one run.
   */
  gather(fn: () => Promise<void>): void;
}

/** Durations from a millisecond to a minute: requests, queries, commands and conversions all fit. */
export const SECONDS_BUCKETS: readonly number[] = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

/** The two ways the metrics are written out: Prometheus's text format (0.0.4), or OpenMetrics (1.0.0). */
export type ExpositionFormat = 'text' | 'openmetrics';

/** A declared metric as tests and documents read it: its name, kind, help and label names. */
export interface FamilyInfo {
  readonly name: string;
  readonly kind: Kind;
  readonly help: string;
  readonly labelNames: readonly string[];
}

// A metric's or label's name, as Prometheus allows them (a label name may not contain a colon).
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// The endings the formats give samples of a counter or a histogram: a metric of another kind named so would be read
// as part of one.
const SAMPLE_SUFFIXES = ['_total', '_count', '_sum', '_bucket', '_created'];

// How long a scrape waits for the gatherers before it writes what it has: a database that does not answer must not
// hold the scrape past Prometheus's own time limit (10 s by default).
const GATHER_WAIT_MS = 1000;

type Kind = 'counter' | 'gauge' | 'histogram';

// One series: for a counter or a gauge its value; for a histogram its count (`value`), the observations in each bucket
// (not added up: each counts what falls between the bound below it and its own), and their sum.
interface Series {
  readonly labels: Labels;
  value: number;
  readonly counts: number[];
  sum: number;
}

/** One declared metric and its series, by the labels' values joined into a key. */
interface Family {
  readonly name: string;
  readonly help: string;
  readonly kind: Kind;
  readonly labelNames: readonly string[];
  readonly buckets: readonly number[];
  readonly series: Map<string, Series>;
}

export interface MetricsRegistryOptions {
  /** Hears a collector or a gatherer that failed; the rest are written out all the same (main logs it). */
  readonly onError?: (error: unknown) => void;
  /** How long a scrape waits for the gatherers (a second by default; tests shorten it). */
  readonly gatherWaitMs?: number;
}

export class MetricsRegistry implements Metrics {
  private readonly families = new Map<string, Family>();
  private readonly collectors: (() => void)[] = [];
  private readonly gatherers: (() => Promise<void>)[] = [];
  private readonly onError: (error: unknown) => void;
  private readonly gatherWaitMs: number;
  // The gatherers' run under way, which a second scrape at the same moment waits for instead of starting its own.
  private gathering: Promise<void> | null = null;

  constructor(options: MetricsRegistryOptions = {}) {
    this.onError = options.onError ?? (() => {});
    this.gatherWaitMs = options.gatherWaitMs ?? GATHER_WAIT_MS;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    const family = this.register(name, help, 'counter', labelNames, []);
    return {
      inc: (labels = {}, by = 1) => {
        // A counter only goes up; a negative step would break every rate() over it.
        if (by < 0) throw new Error(`${name}: a counter cannot go down`);
        this.seriesOf(family, labels).value += by;
      },
    };
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    const family = this.register(name, help, 'gauge', labelNames, []);
    return {
      set: (value, labels = {}) => {
        this.seriesOf(family, labels).value = value;
      },
      inc: (labels = {}, by = 1) => {
        this.seriesOf(family, labels).value += by;
      },
      dec: (labels = {}, by = 1) => {
        this.seriesOf(family, labels).value -= by;
      },
    };
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = SECONDS_BUCKETS,
  ): Histogram {
    // The bounds in order, each once and finite: the format asks for increasing `le`, and +Inf is always added.
    const bounds = [...new Set(buckets)].filter((bound) => Number.isFinite(bound)).sort((a, b) => a - b);
    const family = this.register(name, help, 'histogram', labelNames, bounds);
    const observe = (value: number, labels: Labels = {}): void => {
      // Not a number would make the sum NaN for good; it is a mistake of the caller's, and is not counted.
      if (Number.isNaN(value)) return;
      const series = this.seriesOf(family, labels);
      // Into the first bucket whose bound it does not pass; past the last bound, only the +Inf bucket (the count) has it.
      const index = firstAtLeast(bounds, value);
      if (index < bounds.length) series.counts[index] = (series.counts[index] ?? 0) + 1;
      series.sum += value;
      series.value += 1;
    };
    return {
      observe,
      time: (labels = {}) => {
        const started = performance.now();
        let done = false;
        return () => {
          // Once: a `finally` that runs twice must not count the same work twice.
          if (done) return;
          done = true;
          observe((performance.now() - started) / 1000, labels);
        };
      },
    };
  }

  collect(fn: () => void): void {
    this.collectors.push(fn);
  }

  gather(fn: () => Promise<void>): void {
    this.gatherers.push(fn);
  }

  /** Every metric declared, in the order declared (for tests, and to check a dashboard's queries). */
  declared(): FamilyInfo[] {
    return [...this.families.values()].map(({ name, kind, help, labelNames }) => ({ name, kind, help, labelNames }));
  }

  /** Runs the gatherers (waiting a second at most), then writes everything out: what `/metrics` answers. */
  async scrape(format: ExpositionFormat = 'text'): Promise<string> {
    // One run for every scrape that comes while it is under way.
    this.gathering ??= this.runGatherers().finally(() => {
      this.gathering = null;
    });
    await this.gathering;
    return this.render(format);
  }

  /** Everything, in Prometheus's text format (0.0.4) or in OpenMetrics (1.0.0), after running the collectors. */
  render(format: ExpositionFormat = 'text'): string {
    for (const collector of this.collectors) {
      // One collector that fails (a folder gone, a part closed) must not cost every other number.
      try {
        collector();
      } catch (error) {
        this.onError(error);
      }
    }
    const open = format === 'openmetrics';
    const lines: string[] = [];
    for (const family of this.families.values()) {
      // OpenMetrics names a counter's family without `_total`, which only its samples carry.
      const familyName = open && family.kind === 'counter' ? family.name.slice(0, -'_total'.length) : family.name;
      lines.push(`# HELP ${familyName} ${open ? escapeLabel(family.help) : escapeHelp(family.help)}`);
      lines.push(`# TYPE ${familyName} ${family.kind}`);
      for (const series of family.series.values()) {
        if (family.kind !== 'histogram') {
          lines.push(`${family.name}${labelText(series.labels)} ${number(series.value)}`);
          continue;
        }
        // The format's buckets are cumulative: each counts every observation at or under its bound.
        let below = 0;
        family.buckets.forEach((bound, index) => {
          below += series.counts[index] ?? 0;
          const labels = { ...series.labels, le: open ? canonical(bound) : number(bound) };
          lines.push(`${family.name}_bucket${labelText(labels)} ${below}`);
        });
        lines.push(`${family.name}_bucket${labelText({ ...series.labels, le: '+Inf' })} ${series.value}`);
        lines.push(`${family.name}_sum${labelText(series.labels)} ${number(series.sum)}`);
        lines.push(`${family.name}_count${labelText(series.labels)} ${series.value}`);
      }
    }
    // OpenMetrics ends with a line saying so, so a cut-off answer is told from a whole one.
    if (open) lines.push('# EOF');
    return `${lines.join('\n')}\n`;
  }

  // Runs every gatherer at once, for a second at most; a failure is told and the others count.
  private async runGatherers(): Promise<void> {
    if (this.gatherers.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    // The wait's end, which must not keep a stopping process alive.
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.gatherWaitMs);
      timer.unref();
    });
    const all = Promise.all(
      this.gatherers.map(async (gatherer) => {
        try {
          await gatherer();
        } catch (error) {
          this.onError(error);
        }
      }),
    );
    try {
      await Promise.race([all, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Declares a family, or gives the one declared before under that name when it is the same kind with the same labels.
  private register(name: string, help: string, kind: Kind, labelNames: readonly string[], buckets: readonly number[]) {
    if (!METRIC_NAME.test(name)) throw new Error(`${name} is not a metric name`);
    // A counter's samples end in _total in OpenMetrics; named otherwise, the two formats would name it differently.
    if (kind === 'counter' && (!name.endsWith('_total') || name === '_total')) {
      throw new Error(`${name}: a counter's name ends in _total`);
    }
    // Anything else ending in a sample's suffix would be read as part of a counter or a histogram of another name.
    if (kind !== 'counter' && SAMPLE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      throw new Error(
        `${name}: only a counter's name ends in _total, and no name in _count, _sum, _bucket or _created`,
      );
    }
    for (const label of labelNames) {
      // `le` belongs to the histogram's buckets, and names starting with two underscores to Prometheus itself.
      if (!LABEL_NAME.test(label) || label === 'le' || label.startsWith('__')) {
        throw new Error(`${name}: ${label} is not a label name`);
      }
    }
    if (new Set(labelNames).size !== labelNames.length) throw new Error(`${name}: a label is named twice`);
    const known = this.families.get(name);
    if (known !== undefined) {
      if (known.kind !== kind || known.labelNames.join() !== labelNames.join()) {
        throw new Error(`${name} is declared already as another ${known.kind} or with other labels`);
      }
      return known;
    }
    const family: Family = { name, help, kind, labelNames: [...labelNames], buckets, series: new Map() };
    this.families.set(name, family);
    return family;
  }

  // The series of these labels' values, made at zero the first time.
  private seriesOf(family: Family, labels: Labels): Series {
    // The key: every declared label's value in the declared order (an empty one when not given). Counting the given
    // labels on the way finds one that was not declared without a second pass over them.
    let key = '';
    let found = 0;
    for (let index = 0; index < family.labelNames.length; index += 1) {
      const value = labels[family.labelNames[index] ?? ''];
      if (value !== undefined) found += 1;
      key += index === 0 ? (value ?? '') : `\u0000${value ?? ''}`;
    }
    if (Object.keys(labels).length !== found) {
      const unknown = Object.keys(labels).find((label) => !family.labelNames.includes(label));
      throw new Error(`${family.name} has no label ${unknown}`);
    }
    let series = family.series.get(key);
    if (series === undefined) {
      // Every declared label has a value in every series (an empty one when not given), in the declared order.
      const full: Record<string, string> = {};
      for (const label of family.labelNames) full[label] = labels[label] ?? '';
      series = { labels: full, value: 0, counts: family.buckets.map(() => 0), sum: 0 };
      family.series.set(key, series);
    }
    return series;
  }
}

/** A registry that keeps nothing: for modules built in tests that do not look at their metrics. */
export const NO_METRICS: Metrics = {
  counter: () => ({ inc: () => {} }),
  gauge: () => ({ set: () => {}, inc: () => {}, dec: () => {} }),
  histogram: () => ({ observe: () => {}, time: () => () => {} }),
  collect: () => {},
  gather: () => {},
};

// The index of the first bound at or over the value (the bounds' length when it is past them all), by halving.
function firstAtLeast(bounds: readonly number[], value: number): number {
  let low = 0;
  let high = bounds.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((bounds[middle] ?? Number.POSITIVE_INFINITY) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Labels as the format writes them: {name="value",...}, nothing at all when there are none.
function labelText(labels: Labels): string {
  const parts = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabel(value)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

// A label value escapes its backslashes, quotes and line breaks (so does OpenMetrics's help text); the text format's
// help text only its backslashes and line breaks.
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

// A number as the format writes it: the infinities and NaN by name.
function number(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

// A bucket's bound as OpenMetrics writes it: a whole number with ".0", as Prometheus's own clients write it there.
function canonical(value: number): string {
  const text = number(value);
  return /[.eIN]/.test(text) ? text : `${text}.0`;
}
