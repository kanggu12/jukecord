/**
 * The metrics registry: every number jukecord reports to a monitoring system, declared once with its help text and
 * its labels, and written out in Prometheus's text format for `/metrics`.
 *
 * A module that has something to count asks the registry for a counter, a gauge or a histogram by name when it is
 * built, and from then on only adds, sets or observes. Asking twice for the same name gives the same metric, so two
 * instances of a module share it. Label names are declared up front and a value for any other label is refused: a
 * typo fails a test instead of splitting a series. Label values must come from a short list (a route, an outcome, a
 * kind): never a server, a person, an address or a track, which would make a series for each.
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
}

/** Durations from a millisecond to a minute: requests, queries, commands and conversions all fit. */
export const SECONDS_BUCKETS: readonly number[] = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

// A metric's or label's name, as Prometheus allows them (a label name may not contain a colon).
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type Kind = 'counter' | 'gauge' | 'histogram';

/** One declared metric and its series, by the labels' values joined into a key. */
interface Family {
  readonly name: string;
  readonly help: string;
  readonly kind: Kind;
  readonly labelNames: readonly string[];
  readonly buckets: readonly number[];
  // The series: for a counter or gauge its value, for a histogram its bucket counts, sum and count.
  readonly series: Map<string, { labels: Labels; value: number; counts: number[]; sum: number }>;
}

export class MetricsRegistry implements Metrics {
  private readonly families = new Map<string, Family>();
  private readonly collectors: (() => void)[] = [];

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
    // The bounds in order, each once: the format asks for increasing `le`.
    const bounds = [...new Set(buckets)].sort((a, b) => a - b);
    const family = this.register(name, help, 'histogram', labelNames, bounds);
    const observe = (value: number, labels: Labels = {}): void => {
      const series = this.seriesOf(family, labels);
      // Each bucket counts the observations at or under its bound (the format's buckets are cumulative).
      bounds.forEach((bound, index) => {
        if (value <= bound) series.counts[index] = (series.counts[index] ?? 0) + 1;
      });
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

  /** Everything, in Prometheus's text format (version 0.0.4), after running the collectors. */
  render(): string {
    for (const collector of this.collectors) collector();
    const lines: string[] = [];
    for (const family of this.families.values()) {
      lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
      lines.push(`# TYPE ${family.name} ${family.kind}`);
      for (const series of family.series.values()) {
        if (family.kind !== 'histogram') {
          lines.push(`${family.name}${labelText(series.labels)} ${number(series.value)}`);
          continue;
        }
        family.buckets.forEach((bound, index) => {
          const labels = { ...series.labels, le: number(bound) };
          lines.push(`${family.name}_bucket${labelText(labels)} ${series.counts[index] ?? 0}`);
        });
        lines.push(`${family.name}_bucket${labelText({ ...series.labels, le: '+Inf' })} ${series.value}`);
        lines.push(`${family.name}_sum${labelText(series.labels)} ${number(series.sum)}`);
        lines.push(`${family.name}_count${labelText(series.labels)} ${series.value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  // Declares a family, or gives the one declared before under that name when it is the same kind with the same labels.
  private register(name: string, help: string, kind: Kind, labelNames: readonly string[], buckets: readonly number[]) {
    if (!METRIC_NAME.test(name)) throw new Error(`${name} is not a metric name`);
    for (const label of labelNames) {
      // `le` belongs to the histogram's buckets; a label of that name would collide with them.
      if (!LABEL_NAME.test(label) || label === 'le') throw new Error(`${name}: ${label} is not a label name`);
    }
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
  private seriesOf(family: Family, labels: Labels) {
    for (const label of Object.keys(labels)) {
      if (!family.labelNames.includes(label)) throw new Error(`${family.name} has no label ${label}`);
    }
    // Every declared label has a value in every series (an empty one when not given), in the declared order.
    const full: Record<string, string> = {};
    for (const label of family.labelNames) full[label] = labels[label] ?? '';
    const key = family.labelNames.map((label) => full[label]).join('\u0000');
    let series = family.series.get(key);
    if (series === undefined) {
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
};

// Labels as the format writes them: {name="value",...}, nothing at all when there are none.
function labelText(labels: Labels): string {
  const parts = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabel(value)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

// A label value escapes its backslashes, quotes and line breaks; help text its backslashes and line breaks.
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
