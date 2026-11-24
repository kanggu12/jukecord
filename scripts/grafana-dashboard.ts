/**
 * Writes the Grafana dashboard deploy/monitoring/grafana-dashboard.json from the panels below, so its queries, units
 * and layout are kept in one readable place. The packaging tests fail when the file is out of date, and when a query
 * names a metric jukecord does not declare.
 *
 *   node scripts/grafana-dashboard.ts          rewrite the dashboard
 *   node scripts/grafana-dashboard.ts --check  exit 1 when it is out of date
 *
 * It reads any Prometheus that scrapes jukecord (a datasource picked at the top), for the jobs and instances that
 * report jukecord_info, so the process's and the runtime's numbers of other programs scraped beside it stay out.
 */
import fs from 'node:fs';

/** Where the dashboard is written. */
export const DASHBOARD_FILE = 'deploy/monitoring/grafana-dashboard.json';

// Every query is held to the jukecord targets picked at the top.
const SELECT = 'job=~"$job", instance=~"$instance"';
// The datasource picked at the top, by Grafana's own variable syntax.
// biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana's variable, written as Grafana reads it.
const DATASOURCE = { type: 'prometheus', uid: '${datasource}' };

// One query of a panel: its PromQL (with {} where the targets' selector goes) and the legend of its series.
interface Query {
  readonly expr: string;
  readonly legend?: string;
  /** An instant query (for a stat or a table of the moment), rather than a range over time. */
  readonly instant?: boolean;
  /** On an axis of its own at the right: a limit far above the value beside it (open files and their limit). */
  readonly rightAxis?: boolean;
}

// A panel as the layout below places it.
interface Panel {
  readonly type: 'timeseries' | 'stat' | 'bargauge';
  readonly title: string;
  readonly description: string;
  readonly queries: readonly Query[];
  /** Grafana's unit: s, bytes, percentunit, reqps, short, ... */
  readonly unit?: string;
  /** Its width in the 24 columns, and its height. */
  readonly width: number;
  readonly height?: number;
  /** For a stat: what the values say (1 is Ready, 0 Not ready), and what no value means. */
  readonly mappings?: readonly { readonly value: string; readonly text: string; readonly color: string }[];
  readonly noValue?: string;
  /** For a stat: whether it shows its series' name (the version) instead of a number. */
  readonly showName?: boolean;
  /** Stacked areas (parts of a whole), rather than lines. */
  readonly stacked?: boolean;
  readonly min?: number;
  readonly max?: number;
}

// A row of panels under a title.
interface Row {
  readonly title: string;
  readonly panels: readonly Panel[];
}

// The targets' selector put in every {} of a query: `name{}` and `name{a="b"}` both get it.
function select(expr: string): string {
  return expr.replace(/\{([^}]*)\}/g, (_match, inner: string) => `{${inner.trim() ? `${inner}, ` : ''}${SELECT}}`);
}

// Quantiles of a histogram over the panel's interval: p50, p90, p99 of `metric` (by `by` too, when given).
function quantiles(metric: string, filter = '', by = ''): Query[] {
  return [0.5, 0.9, 0.99].map((q) => ({
    expr: `histogram_quantile(${q}, sum by (le${by ? `, ${by}` : ''}) (rate(${metric}_bucket{${filter}}[$__rate_interval])))`,
    legend: `p${q * 100}${by ? ` {{${by}}}` : ''}`,
  }));
}

const ROWS: readonly Row[] = [
  {
    title: 'Overview',
    panels: [
      {
        type: 'stat',
        title: 'Ready',
        description: 'What /readyz answers: the database, the bus and the shared cache work.',
        queries: [{ expr: 'min(jukecord_ready{})', instant: true }],
        width: 3,
        height: 4,
        mappings: [
          { value: '1', text: 'Ready', color: 'green' },
          { value: '0', text: 'Not ready', color: 'red' },
        ],
      },
      {
        type: 'stat',
        title: 'Discord',
        description: "The bot's gateway: connected, or not; browser-only when jukecord runs without a bot.",
        queries: [{ expr: 'min(jukecord_discord_gateway_state{state="ready"})', instant: true }],
        width: 3,
        height: 4,
        noValue: 'browser-only',
        mappings: [
          { value: '1', text: 'Connected', color: 'green' },
          { value: '0', text: 'Not connected', color: 'red' },
        ],
      },
      {
        type: 'stat',
        title: 'Version',
        description: 'The version and the role (all, core, edge) of each process.',
        queries: [{ expr: 'jukecord_info{}', legend: '{{version}} ({{role}})', instant: true }],
        width: 4,
        height: 4,
        showName: true,
      },
      {
        type: 'stat',
        title: 'Up for',
        description: 'Since the process started.',
        queries: [{ expr: 'time() - max(process_start_time_seconds{})', instant: true }],
        unit: 's',
        width: 3,
        height: 4,
      },
      {
        type: 'stat',
        title: 'Playing',
        description: 'Servers whose player is playing now.',
        queries: [{ expr: 'sum(jukecord_players{status="playing"})', instant: true }],
        width: 3,
        height: 4,
      },
      {
        type: 'stat',
        title: 'Browsers playing along',
        description: 'Browsers playing a server\'s music now ("Listen" in the panel).',
        queries: [{ expr: 'sum(jukecord_browser_listeners{})', instant: true }],
        width: 4,
        height: 4,
      },
      {
        type: 'stat',
        title: 'Queued',
        description: 'Tracks waiting in every queue.',
        queries: [{ expr: 'sum(jukecord_queue_tracks{})', instant: true }],
        width: 4,
        height: 4,
      },
    ],
  },
  {
    title: 'Playing',
    panels: [
      {
        type: 'timeseries',
        title: 'Players by state',
        description: 'Servers with a player, by what it is doing.',
        queries: [{ expr: 'sum by (status) (jukecord_players{})', legend: '{{status}}' }],
        width: 8,
        stacked: true,
      },
      {
        type: 'timeseries',
        title: 'Queues',
        description: 'Tracks waiting in all queues, and in the longest one.',
        queries: [
          { expr: 'sum(jukecord_queue_tracks{})', legend: 'in all' },
          { expr: 'max(jukecord_queue_longest_tracks{})', legend: 'longest' },
        ],
        width: 8,
      },
      {
        type: 'timeseries',
        title: 'People',
        description: 'Open panels (live connections), the browsers among them playing along, and voice connections.',
        queries: [
          { expr: 'sum(jukecord_panel_connections{})', legend: 'panels open' },
          { expr: 'sum(jukecord_browser_listeners{})', legend: 'browsers playing along' },
          { expr: 'sum(jukecord_voice_connections{state="ready"})', legend: 'voice channels' },
        ],
        width: 8,
      },
    ],
  },
  {
    title: 'Getting tracks',
    panels: [
      {
        type: 'timeseries',
        title: 'Fetches a minute',
        description: 'Tracks fetched into the media cache (downloaded and encoded), by how each ended.',
        queries: [
          { expr: 'sum by (outcome) (rate(jukecord_fetches_total{}[$__rate_interval])) * 60', legend: '{{outcome}}' },
        ],
        width: 8,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Failures a minute, by why',
        description: 'Why fetches failed, in the words the panel shows (bot-check: YouTube refuses this server).',
        queries: [
          {
            expr: 'sum by (reason) (rate(jukecord_fetch_failures_total{}[$__rate_interval])) * 60',
            legend: '{{reason}}',
          },
        ],
        width: 8,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Fetches under way',
        description: 'Fetches running and waiting for their turn: now (somebody waits) or ahead (the next tracks).',
        queries: [{ expr: 'sum by (state, priority) (jukecord_fetch_jobs{})', legend: '{{state}} {{priority}}' }],
        width: 8,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'How long a fetch takes',
        description: 'From its start to the track in the cache.',
        queries: quantiles('jukecord_fetch_duration_seconds'),
        unit: 's',
        width: 8,
      },
      {
        type: 'timeseries',
        title: 'yt-dlp and FFmpeg runs a minute',
        description: 'Each run by program, by what it was for and how it ended.',
        queries: [
          {
            expr: 'sum by (tool, task, outcome) (rate(jukecord_media_tool_runs_total{}[$__rate_interval])) * 60',
            legend: '{{tool}} {{task}} {{outcome}}',
          },
        ],
        width: 8,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'yt-dlp and FFmpeg runs, 90th percentile',
        description: 'How long the runs take, by program and what they were for.',
        queries: [
          {
            expr: 'histogram_quantile(0.9, sum by (le, tool, task) (rate(jukecord_media_tool_duration_seconds_bucket{}[$__rate_interval])))',
            legend: '{{tool}} {{task}}',
          },
        ],
        unit: 's',
        width: 8,
      },
    ],
  },
  {
    title: 'Media cache',
    panels: [
      {
        type: 'timeseries',
        title: 'Media cache',
        description: 'Bytes in the media cache, and its limit (JUKECORD_CACHE_MAX).',
        queries: [
          { expr: 'sum(jukecord_cache_bytes{})', legend: 'in the cache' },
          { expr: 'sum(jukecord_cache_limit_bytes{})', legend: 'limit' },
        ],
        unit: 'bytes',
        width: 12,
        min: 0,
      },
      {
        type: 'stat',
        title: 'Found in the cache',
        description: 'Of the tracks plays asked for in this time range, the share that was cached already.',
        queries: [
          {
            expr: 'sum(increase(jukecord_cache_lookups_total{result="hit"}[$__range])) / sum(increase(jukecord_cache_lookups_total{}[$__range]))',
            instant: true,
          },
        ],
        unit: 'percentunit',
        noValue: 'no plays yet',
        width: 6,
      },
      {
        type: 'stat',
        title: 'Tracks cached',
        description: 'Tracks in the media cache, and their covers.',
        queries: [
          { expr: 'sum(jukecord_cache_tracks{})', legend: 'tracks', instant: true },
          { expr: 'sum(jukecord_cache_covers{})', legend: 'covers', instant: true },
        ],
        width: 6,
      },
      {
        type: 'timeseries',
        title: 'Evicted an hour',
        description:
          'Files the cache removed to stay under its limit; many while the same tracks are fetched again means a cache too small.',
        queries: [
          {
            expr: 'sum by (kind) (rate(jukecord_cache_evictions_total{}[$__rate_interval])) * 3600',
            legend: '{{kind}}',
          },
        ],
        width: 12,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Free on the disk',
        description: 'Free space on the disk holding the data folder (the database, the media cache, the logs).',
        queries: [{ expr: 'min(jukecord_disk_free_bytes{})', legend: 'free' }],
        unit: 'bytes',
        width: 12,
        min: 0,
      },
    ],
  },
  {
    title: 'Web',
    panels: [
      {
        type: 'timeseries',
        title: 'Answers a second',
        description: 'HTTP answers, by status class.',
        queries: [
          { expr: 'sum by (class) (rate(jukecord_http_responses_total{}[$__rate_interval]))', legend: '{{class}}' },
        ],
        unit: 'reqps',
        width: 8,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'How long answers take',
        description: "The API's answers (the panel's files and the audio, which lasts as long as it plays, left out).",
        queries: quantiles('jukecord_http_request_duration_seconds', 'route!~"static|.*/audio"'),
        unit: 's',
        width: 8,
      },
      {
        type: 'bargauge',
        title: 'Slowest routes (95th percentile, this time range)',
        description: 'The API routes that take longest to answer.',
        queries: [
          {
            expr: 'topk(10, histogram_quantile(0.95, sum by (le, route) (rate(jukecord_http_request_duration_seconds_bucket{route!~"static|.*/audio"}[$__range]))))',
            legend: '{{route}}',
            instant: true,
          },
        ],
        unit: 's',
        width: 8,
      },
      {
        type: 'timeseries',
        title: 'Live updates sent',
        description: 'Messages a second to open panels, by frame (binary is gzip), and the bytes they took.',
        queries: [
          {
            expr: 'sum by (frame) (rate(jukecord_panel_messages_total{}[$__rate_interval]))',
            legend: '{{frame}} messages',
          },
          { expr: 'sum(rate(jukecord_panel_sent_bytes_total{}[$__rate_interval]))', legend: 'bytes' },
        ],
        width: 12,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Requests by route',
        description: 'API requests a second, by route.',
        queries: [
          {
            expr: 'sum by (route) (rate(jukecord_http_request_duration_seconds_count{route!="static"}[$__rate_interval]))',
            legend: '{{route}}',
          },
        ],
        unit: 'reqps',
        width: 12,
        min: 0,
      },
    ],
  },
  {
    title: 'Database',
    panels: [
      {
        type: 'timeseries',
        title: 'Statements a second',
        description: 'By operation; a whole transaction counts as one of its own.',
        queries: [
          {
            expr: 'sum by (operation) (rate(jukecord_database_query_duration_seconds_count{}[$__rate_interval]))',
            legend: '{{operation}}',
          },
        ],
        width: 6,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Statements, 99th percentile',
        description: 'How long statements take, the wait for a connection included.',
        queries: [
          {
            expr: 'histogram_quantile(0.99, sum by (le, operation) (rate(jukecord_database_query_duration_seconds_bucket{}[$__rate_interval])))',
            legend: '{{operation}}',
          },
        ],
        unit: 's',
        width: 6,
      },
      {
        type: 'timeseries',
        title: 'Failed statements a minute',
        description: 'Statements (and whole transactions) that failed, by operation.',
        queries: [
          {
            expr: 'sum by (operation) (rate(jukecord_database_query_errors_total{}[$__rate_interval])) * 60',
            legend: '{{operation}}',
          },
        ],
        width: 6,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Connections',
        description: 'Busy and idle connections, and the statements waiting for one.',
        queries: [
          { expr: 'sum by (state) (jukecord_database_connections{})', legend: '{{state}}' },
          { expr: 'sum(jukecord_database_waiting_queries{})', legend: 'waiting' },
        ],
        width: 6,
        min: 0,
      },
    ],
  },
  {
    title: 'Bus and shared cache',
    panels: [
      {
        type: 'timeseries',
        title: 'Commands to the core a second',
        description: 'Commands edges sent over the bus (a split setup), by how they ended.',
        queries: [
          { expr: 'sum by (outcome) (rate(jukecord_bus_commands_total{}[$__rate_interval]))', legend: '{{outcome}}' },
        ],
        width: 8,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Commands, 95th percentile',
        description: 'How long the core took to answer, by command.',
        queries: [
          {
            expr: 'histogram_quantile(0.95, sum by (le, command) (rate(jukecord_bus_command_duration_seconds_bucket{}[$__rate_interval])))',
            legend: '{{command}}',
          },
        ],
        unit: 's',
        width: 8,
      },
      {
        type: 'timeseries',
        title: 'Shared cache',
        description: 'Reads that found a value, and calls to its server that failed, a second.',
        queries: [
          {
            expr: 'sum by (result) (rate(jukecord_shared_cache_lookups_total{}[$__rate_interval]))',
            legend: '{{result}}',
          },
          { expr: 'sum(rate(jukecord_shared_cache_errors_total{}[$__rate_interval]))', legend: 'errors' },
        ],
        width: 8,
        min: 0,
      },
      {
        type: 'stat',
        title: 'Edges',
        description: 'The edges that report to the core (a split setup); none in one process.',
        queries: [{ expr: 'max(jukecord_edges{})', instant: true }],
        width: 4,
        noValue: 'one process',
      },
      {
        type: 'timeseries',
        title: 'Commands the core ran a second',
        description: 'Commands the core ran for its edges, by how they ended (late: its caller had stopped waiting).',
        queries: [
          {
            expr: 'sum by (outcome) (rate(jukecord_bus_commands_served_total{}[$__rate_interval]))',
            legend: '{{outcome}}',
          },
        ],
        width: 10,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Events on the bus a second',
        description: 'Events of the core sent to its edges and heard there, and the ones lost while the bus was down.',
        queries: [
          { expr: 'sum by (outcome) (rate(jukecord_bus_events_total{}[$__rate_interval]))', legend: '{{outcome}}' },
        ],
        width: 10,
        min: 0,
      },
    ],
  },
  {
    title: 'Discord',
    panels: [
      {
        type: 'timeseries',
        title: 'Gateway',
        description: "The state the bot's gateway was in: a line for each state it held (ready, reconnecting, ...).",
        queries: [{ expr: 'max by (state) (jukecord_discord_gateway_state{}) == 1', legend: '{{state}}' }],
        width: 12,
        min: 0,
        max: 1,
      },
      {
        type: 'timeseries',
        title: 'Gateway latency',
        description: "The round trip of the gateway's heartbeat.",
        queries: [{ expr: 'max(jukecord_discord_gateway_latency_seconds{})', legend: 'latency' }],
        unit: 's',
        width: 6,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Servers and voice',
        description: 'Discord servers the bot is in, and its voice connections by state.',
        queries: [
          { expr: 'max(jukecord_discord_guilds{})', legend: 'servers' },
          { expr: 'sum by (state) (jukecord_voice_connections{})', legend: 'voice {{state}}' },
        ],
        width: 6,
        min: 0,
      },
    ],
  },
  {
    title: 'Process',
    panels: [
      {
        type: 'timeseries',
        title: 'Event loop delay',
        description: 'Over each second; above 0.2 s at the 99th percentile jukecord turns away what can wait.',
        queries: [
          { expr: 'max(nodejs_eventloop_lag_p50_seconds{})', legend: 'p50' },
          { expr: 'max(nodejs_eventloop_lag_p99_seconds{})', legend: 'p99' },
          { expr: 'max(nodejs_eventloop_lag_max_seconds{})', legend: 'max' },
        ],
        unit: 's',
        width: 8,
      },
      {
        type: 'timeseries',
        title: 'Event loop use, and time behind',
        description: 'How much of each second the loop worked, and the share of the time jukecord was behind.',
        queries: [
          { expr: 'max(nodejs_eventloop_utilization_ratio{})', legend: 'use' },
          { expr: 'sum(rate(jukecord_event_loop_behind_seconds_total{}[$__rate_interval]))', legend: 'behind' },
        ],
        unit: 'percentunit',
        width: 8,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Processor',
        description: 'Processor time a second (1 is one whole core).',
        queries: [{ expr: 'sum(rate(process_cpu_seconds_total{}[$__rate_interval]))', legend: 'processor' }],
        unit: 'percentunit',
        width: 8,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Memory',
        description: "The process's resident memory, and the JavaScript heap.",
        queries: [
          { expr: 'sum(process_resident_memory_bytes{})', legend: 'resident' },
          { expr: 'sum(nodejs_heap_size_total_bytes{})', legend: 'heap' },
          { expr: 'sum(nodejs_heap_size_used_bytes{})', legend: 'heap in use' },
          { expr: 'sum(nodejs_external_memory_bytes{})', legend: 'outside the heap' },
        ],
        unit: 'bytes',
        width: 12,
        min: 0,
      },
      {
        type: 'timeseries',
        title: 'Open files',
        description: 'Files and sockets open, and the most the process may have (Linux).',
        queries: [
          { expr: 'sum(process_open_fds{})', legend: 'open' },
          { expr: 'min(process_max_fds{})', legend: 'limit', rightAxis: true },
        ],
        width: 12,
        min: 0,
      },
    ],
  },
];

// The variables at the top: the Prometheus to read, and the jukecord jobs and instances in it.
function templating(): object {
  const query = (name: string, label: string, expr: string) => ({
    name,
    label,
    type: 'query',
    datasource: DATASOURCE,
    query: { query: expr, refId: `${name}-variable` },
    definition: expr,
    refresh: 2,
    includeAll: true,
    multi: true,
    allValue: '.+',
    current: { text: 'All', value: '$__all' },
    sort: 1,
  });
  return {
    list: [
      {
        name: 'datasource',
        label: 'Prometheus',
        type: 'datasource',
        query: 'prometheus',
        current: {},
        hide: 0,
        refresh: 1,
      },
      query('job', 'Job', 'label_values(jukecord_info, job)'),
      query('instance', 'Instance', 'label_values(jukecord_info{job=~"$job"}, instance)'),
    ],
  };
}

// A panel as Grafana stores it, at its place.
function panel(made: Panel, id: number, x: number, y: number): object {
  const height = made.height ?? 8;
  const isStat = made.type === 'stat';
  const custom =
    made.type === 'timeseries'
      ? {
          drawStyle: 'line',
          lineWidth: 1,
          fillOpacity: made.stacked ? 30 : 10,
          showPoints: 'never',
          spanNulls: false,
          stacking: { mode: made.stacked ? 'normal' : 'none', group: 'A' },
        }
      : {};
  return {
    id,
    type: made.type,
    title: made.title,
    description: made.description,
    datasource: DATASOURCE,
    gridPos: { h: height, w: made.width, x, y },
    fieldConfig: {
      defaults: {
        unit: made.unit ?? 'short',
        ...(made.min !== undefined ? { min: made.min } : {}),
        ...(made.max !== undefined ? { max: made.max } : {}),
        ...(made.noValue ? { noValue: made.noValue } : {}),
        color: { mode: isStat && made.mappings ? 'thresholds' : 'palette-classic' },
        // Colour only where it says something: the states a stat maps (green for working, red for not); anything else,
        // a value it does not map or none at all (browser-only), stays without colour.
        thresholds: {
          mode: 'absolute',
          steps: [{ color: isStat && made.mappings ? 'transparent' : 'text', value: null }],
        },
        mappings: (made.mappings ?? []).map((mapping) => ({
          type: 'value',
          options: { [mapping.value]: { text: mapping.text, color: mapping.color } },
        })),
        custom,
      },
      // A series on the right axis, by its legend, when the query asks for one.
      overrides: made.queries
        .filter((query) => query.rightAxis)
        .map((query) => ({
          matcher: { id: 'byName', options: query.legend },
          properties: [{ id: 'custom.axisPlacement', value: 'right' }],
        })),
    },
    options:
      made.type === 'stat'
        ? {
            reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
            colorMode: made.mappings ? 'background' : 'none',
            graphMode: 'none',
            justifyMode: 'auto',
            orientation: 'auto',
            textMode: made.showName ? 'name' : 'auto',
            wideLayout: true,
          }
        : made.type === 'bargauge'
          ? {
              reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
              orientation: 'horizontal',
              displayMode: 'basic',
              showUnfilled: true,
            }
          : {
              legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
              tooltip: { mode: 'multi', sort: 'desc' },
            },
    targets: made.queries.map((query, index) => ({
      refId: String.fromCharCode(65 + index),
      datasource: DATASOURCE,
      expr: select(query.expr),
      legendFormat: query.legend ?? '__auto',
      range: !query.instant,
      instant: query.instant === true,
    })),
  };
}

/** The dashboard as Grafana stores it. */
export function dashboard(): object {
  const panels: object[] = [];
  let id = 1;
  let y = 0;
  for (const row of ROWS) {
    panels.push({
      id: id++,
      type: 'row',
      title: row.title,
      collapsed: false,
      gridPos: { h: 1, w: 24, x: 0, y },
      panels: [],
    });
    y += 1;
    // Left to right, a new line when the next one does not fit.
    let x = 0;
    let lineHeight = 0;
    for (const made of row.panels) {
      if (x + made.width > 24) {
        y += lineHeight;
        x = 0;
        lineHeight = 0;
      }
      panels.push(panel(made, id++, x, y));
      x += made.width;
      lineHeight = Math.max(lineHeight, made.height ?? 8);
    }
    y += lineHeight;
  }
  return {
    uid: 'jukecord',
    title: 'jukecord',
    description:
      "jukecord's metrics: what plays, getting tracks, the web server, the database, Discord and the process.",
    tags: ['jukecord'],
    editable: true,
    graphTooltip: 1,
    timezone: 'browser',
    time: { from: 'now-6h', to: 'now' },
    refresh: '30s',
    schemaVersion: 39,
    version: 1,
    annotations: {
      list: [
        {
          builtIn: 1,
          datasource: { type: 'grafana', uid: '-- Grafana --' },
          enable: true,
          hide: true,
          iconColor: 'rgba(0, 211, 255, 1)',
          name: 'Annotations & Alerts',
          type: 'dashboard',
        },
      ],
    },
    templating: templating(),
    panels,
  };
}

/** The file's text: the dashboard, two spaces deep, as Grafana writes an exported one. */
export function dashboardText(): string {
  return `${JSON.stringify(dashboard(), null, 2)}\n`;
}

if (import.meta.main) {
  const next = dashboardText();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(DASHBOARD_FILE) ? fs.readFileSync(DASHBOARD_FILE, 'utf8') : '';
    if (current !== next) {
      process.stderr.write(`${DASHBOARD_FILE} is out of date: node scripts/grafana-dashboard.ts\n`);
      process.exit(1);
    }
  } else {
    fs.mkdirSync('deploy/monitoring', { recursive: true });
    fs.writeFileSync(DASHBOARD_FILE, next);
  }
}
