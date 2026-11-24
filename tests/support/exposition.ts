/**
 * A strict reader of what `/metrics` answers, for tests: Prometheus's text format (0.0.4) and OpenMetrics (1.0.0), by
 * their rules. It throws, naming the line, on anything a scraper could misread or refuse: a sample before its family's
 * TYPE, a family without HELP or TYPE, a name or a label the formats do not allow, a bad escape, a value that is not a
 * number, a series written twice, a counter going below zero, histogram buckets that are not cumulative or lack +Inf,
 * a `_count` that differs from the +Inf bucket, an OpenMetrics answer without `# EOF` or with a counter whose samples do
 * not end in `_total`.
 */

/** One sample line, read. */
export interface Sample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** One family: its TYPE, its HELP and its samples, in the order written. */
export interface Family {
  readonly name: string;
  readonly type: string;
  readonly help: string;
  readonly samples: Sample[];
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// A float as both formats allow it, the infinities and NaN by name.
const FLOAT = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]Inf|NaN)$/;
const TYPES = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped', 'unknown']);

// Help text with its escapes read, one at a time from the left: only the characters in `allowed` may follow a
// backslash (and a quote may not stand alone where it must be escaped).
function readEscapes(text: string, allowed: string, where: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[at + 1] ?? '';
    if (!allowed.includes(next) || next === '') throw new Error(`${where}: the escape \\${next} is not allowed here`);
    out += next === 'n' ? '\n' : next;
    at += 1;
  }
  return out;
}

// A number as written: the infinities and NaN by name.
function float(text: string, where: string): number {
  if (!FLOAT.test(text)) throw new Error(`${where}: "${text}" is not a number`);
  if (text === '+Inf') return Number.POSITIVE_INFINITY;
  if (text === '-Inf') return Number.NEGATIVE_INFINITY;
  return Number(text);
}

// Reads `{a="1",b="x\"y"}` from the start of `text`: the labels and how many characters they took.
function readLabels(text: string, where: string): { labels: Record<string, string>; length: number } {
  const labels: Record<string, string> = {};
  if (!text.startsWith('{')) return { labels, length: 0 };
  let at = 1;
  if (text[at] === '}') return { labels, length: 2 };
  for (;;) {
    const name = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(text.slice(at))?.[0];
    if (!name || !LABEL_NAME.test(name)) throw new Error(`${where}: a label name is not allowed`);
    if (name in labels) throw new Error(`${where}: the label ${name} is given twice`);
    at += name.length;
    if (text.slice(at, at + 2) !== '="') throw new Error(`${where}: the label ${name} has no quoted value`);
    at += 2;
    let value = '';
    for (;;) {
      const char = text[at];
      if (char === undefined) throw new Error(`${where}: the value of ${name} does not end`);
      if (char === '"') break;
      if (char === '\n') throw new Error(`${where}: a line break inside the value of ${name}`);
      if (char === '\\') {
        const next = text[at + 1];
        // Only three escapes exist: a backslash, a quote and a line break.
        if (next === '\\') value += '\\';
        else if (next === '"') value += '"';
        else if (next === 'n') value += '\n';
        else throw new Error(`${where}: the escape \\${next ?? ''} in ${name} is not allowed`);
        at += 2;
        continue;
      }
      value += char;
      at += 1;
    }
    labels[name] = value;
    at += 1;
    if (text[at] === '}') return { labels, length: at + 1 };
    if (text[at] !== ',') throw new Error(`${where}: labels are not separated by commas`);
    at += 1;
    // No trailing comma (OpenMetrics refuses it, and jukecord never writes one).
    if (text[at] === '}') throw new Error(`${where}: a comma before the closing brace`);
  }
}

// The family a sample belongs to, by its name and the families' types: `x` for a gauge, `x_bucket`, `x_sum` and
// `x_count` for a histogram, and for a counter `x` (text, whose family name has the _total) or `x_total` (OpenMetrics).
function familyOf(name: string, current: Family | null, open: boolean): boolean {
  if (!current) return false;
  if (current.type === 'histogram')
    return [`${current.name}_bucket`, `${current.name}_sum`, `${current.name}_count`].includes(name);
  if (current.type === 'counter') return name === (open ? `${current.name}_total` : current.name);
  return name === current.name;
}

/** Reads an answer of `/metrics`; throws on the first thing it breaks. */
export function parseExposition(text: string, format: 'text' | 'openmetrics' = 'text'): Map<string, Family> {
  const open = format === 'openmetrics';
  if (!text.endsWith('\n')) throw new Error('the answer does not end with a line break');
  const lines = text.slice(0, -1).split('\n');
  if (open) {
    if (lines.at(-1) !== '# EOF') throw new Error('an OpenMetrics answer ends with # EOF');
    lines.pop();
  }
  const families = new Map<string, Family>();
  // Which families have their HELP and TYPE, and the family the samples now belong to.
  const helped = new Set<string>();
  const typed = new Set<string>();
  let current: Family | null = null;
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const where = `line ${index + 1} (${line.slice(0, 80)})`;
    if (line === '') throw new Error(`${where}: an empty line`);
    if (line.startsWith('#')) {
      const match = /^# (HELP|TYPE) ([^ ]+) ?(.*)$/.exec(line);
      if (!match) throw new Error(`${where}: a comment that is neither HELP nor TYPE`);
      const [, kind, name = '', rest = ''] = match;
      if (!METRIC_NAME.test(name)) throw new Error(`${where}: ${name} is not a metric name`);
      let family = families.get(name);
      // A family's lines stay together: once another family began, it cannot come back.
      if (family && current !== family) throw new Error(`${where}: ${name} comes back after another family`);
      if (!family) {
        family = { name, type: '', help: '', samples: [] };
        families.set(name, family);
      }
      if (family.samples.length > 0) throw new Error(`${where}: ${kind} of ${name} after its samples`);
      if (kind === 'HELP') {
        if (helped.has(name)) throw new Error(`${where}: a second HELP for ${name}`);
        helped.add(name);
        // The help's escapes: a backslash and a line break, and in OpenMetrics a quote as well.
        (family as { help: string }).help = readEscapes(rest, open ? '\\n"' : '\\n', where);
      } else {
        if (typed.has(name)) throw new Error(`${where}: a second TYPE for ${name}`);
        if (!TYPES.has(rest)) throw new Error(`${where}: ${rest} is not a type`);
        typed.add(name);
        (family as { type: string }).type = rest;
        // In OpenMetrics a counter's family has no _total (its samples do); in the text format it has.
        if (open && rest === 'counter' && name.endsWith('_total'))
          throw new Error(`${where}: ${name} keeps its _total`);
      }
      current = family;
      return;
    }
    const name = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line)?.[0];
    if (!name) throw new Error(`${where}: no metric name`);
    const { labels, length } = readLabels(line.slice(name.length), where);
    const rest = line.slice(name.length + length);
    if (!rest.startsWith(' ')) throw new Error(`${where}: no space before the value`);
    // A value and nothing else: jukecord writes no timestamps.
    const parts = rest.slice(1).split(' ');
    if (parts.length !== 1) throw new Error(`${where}: something after the value`);
    const value = float(parts[0] ?? '', where);
    if (!current || !typed.has(current.name) || !familyOf(name, current, open)) {
      throw new Error(`${where}: ${name} is not a sample of the family before it`);
    }
    if ('le' in labels && !name.endsWith('_bucket')) throw new Error(`${where}: le outside a bucket`);
    const key = `${name}${JSON.stringify(Object.entries(labels).sort())}`;
    if (seen.has(key)) throw new Error(`${where}: the series is written twice`);
    seen.add(key);
    if (current.type === 'counter' && !(value >= 0)) throw new Error(`${where}: a counter below zero`);
    current.samples.push({ name, labels, value });
  });
  for (const family of families.values()) {
    if (!helped.has(family.name)) throw new Error(`${family.name} has no HELP`);
    if (!typed.has(family.name)) throw new Error(`${family.name} has no TYPE`);
    if (family.type === 'histogram') checkHistogram(family, open);
  }
  return families;
}

// A histogram's series, each: buckets in increasing `le` with counts that never go down, +Inf last, a _count equal to
// it and a _sum; in OpenMetrics every bound written as a float (1.0, not 1).
function checkHistogram(family: Family, open: boolean): void {
  const bySeries = new Map<string, { buckets: [number, number][]; sum?: number; count?: number }>();
  for (const sample of family.samples) {
    const { le, ...rest } = sample.labels;
    const key = JSON.stringify(Object.entries(rest).sort());
    const series = bySeries.get(key) ?? { buckets: [] };
    bySeries.set(key, series);
    if (sample.name.endsWith('_bucket')) {
      if (le === undefined) throw new Error(`${family.name}: a bucket without le`);
      if (open && le !== '+Inf' && !/[.e]/.test(le)) throw new Error(`${family.name}: le="${le}" is not a float`);
      series.buckets.push([float(le, family.name), sample.value]);
    } else if (sample.name.endsWith('_sum')) series.sum = sample.value;
    else series.count = sample.value;
  }
  for (const [key, series] of bySeries) {
    const where = `${family.name}${key}`;
    for (let index = 1; index < series.buckets.length; index += 1) {
      const [bound, count] = series.buckets[index] ?? [0, 0];
      const [lower, under] = series.buckets[index - 1] ?? [0, 0];
      if (!(bound > lower)) throw new Error(`${where}: le does not increase`);
      if (count < under) throw new Error(`${where}: the buckets are not cumulative`);
    }
    const last = series.buckets.at(-1);
    if (!last || last[0] !== Number.POSITIVE_INFINITY) throw new Error(`${where}: no +Inf bucket`);
    if (series.count !== last[1]) throw new Error(`${where}: _count differs from the +Inf bucket`);
    if (series.sum === undefined) throw new Error(`${where}: no _sum`);
  }
}

/** Every value each label takes across every family, by label name (for the test that no label is unbounded). */
export function labelValues(families: Map<string, Family>): Map<string, Set<string>> {
  const values = new Map<string, Set<string>>();
  for (const family of families.values()) {
    for (const sample of family.samples) {
      for (const [name, value] of Object.entries(sample.labels)) {
        const key = `${family.name}:${name}`;
        const set = values.get(key) ?? new Set<string>();
        set.add(value);
        values.set(key, set);
      }
    }
  }
  return values;
}
