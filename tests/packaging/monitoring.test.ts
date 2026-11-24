/**
 * What ships for watching jukecord from outside: the chart's ServiceMonitor, metrics token and scrape annotations, the
 * Grafana dashboard, the alert rules and the Compose example beside them. The dashboard and the alerts may only name
 * metrics jukecord declares, with labels those metrics have; the chart is rendered and validated with helm and
 * kubeconform, the rules with promtool, and the Compose file with docker compose, when each is installed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DASHBOARD_FILE, dashboardText } from '../../scripts/grafana-dashboard.ts';
import type { FamilyInfo } from '../../src/metrics/registry.ts';
import { everyFamily } from '../support/metrics.ts';

const read = (file: string) => fs.readFileSync(file, 'utf8');

// Whether a program is on the PATH (it answers `<program> <probe>`).
function have(program: string, probe = 'version'): boolean {
  try {
    execFileSync(program, [probe], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The ServiceMonitor CRD's schema, from the catalog kubeconform's documentation points at, pinned to one commit.
const CRD_SCHEMAS =
  'https://raw.githubusercontent.com/datreeio/CRDs-catalog/04af58d740718c4dc719441bf39fb284c784f4a8/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json';
const SERVICE_MONITOR_API = 'monitoring.coreos.com/v1/ServiceMonitor';
const TOKEN = 'a-metrics-token-of-the-chart-0123456789';

// The chart rendered with these values, or what helm said when it refused them.
function render(...values: string[]): string {
  return execFileSync('helm', ['template', 't', 'deploy/helm/jukecord', ...values], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}
function refusal(...values: string[]): string {
  try {
    render(...values);
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? error);
  }
  return 'rendered';
}

// One kind's document out of a rendered chart.
function documentOf(rendered: string, kind: string): string {
  return rendered.split(/^---$/m).find((part) => new RegExp(`^kind: ${kind}$`, 'm').test(part)) ?? '';
}

describe("the chart's monitoring", { skip: !have('helm') && 'helm is not installed' }, () => {
  it('makes a ServiceMonitor only when asked, and then only for a cluster with its CRD or when forced', () => {
    const count = (text: string) => (text.match(/^kind: ServiceMonitor$/gm) ?? []).length;
    assert.equal(count(render()), 0);
    assert.equal(count(render('--api-versions', SERVICE_MONITOR_API)), 0);
    // Asked for, but helm template knows no cluster with the CRD: none (helm install says so in its notes).
    assert.equal(count(render('--set', 'metrics.serviceMonitor.enabled=true')), 0);
    assert.equal(
      count(render('--set', 'metrics.serviceMonitor.enabled=true', '--api-versions', SERVICE_MONITOR_API)),
      1,
    );
    assert.equal(
      count(render('--set', 'metrics.serviceMonitor.enabled=true', '--set', 'metrics.serviceMonitor.force=true')),
      1,
    );
    const monitor = documentOf(
      render(
        '--set',
        'metrics.serviceMonitor.enabled=true',
        '--set',
        'metrics.serviceMonitor.force=true',
        '--set',
        'metrics.serviceMonitor.labels.release=prometheus',
        '--set',
        'metrics.serviceMonitor.interval=1m',
      ),
      'ServiceMonitor',
    );
    // jukecord's Service by its labels, its port by name, at the path, with the labels a Prometheus picks it by.
    assert.match(monitor, /^ {4}release: prometheus$/m);
    assert.match(
      monitor,
      /matchLabels:\n {6}app\.kubernetes\.io\/name: jukecord\n {6}app\.kubernetes\.io\/instance: t\n {6}app\.kubernetes\.io\/component: server\n/,
    );
    assert.match(monitor, /- port: http\n {6}path: \/metrics\n {6}interval: 1m\n {6}scrapeTimeout: 10s\n/);
    // No token set: nothing to send.
    assert.doesNotMatch(monitor, /authorization/);
  });

  it('gives the pod the metrics token as a file, and the ServiceMonitor the Secret to send it from', () => {
    const plain = render();
    assert.doesNotMatch(plain, /METRICS_TOKEN|metricsToken|prometheus\.io/);
    const given = render(
      '--set-string',
      `metrics.token=${TOKEN}`,
      '--set',
      'metrics.serviceMonitor.enabled=true',
      '--set',
      'metrics.serviceMonitor.force=true',
    );
    // The chart's Secret holds it; the pod reads it from the mounted file, not from a variable.
    assert.match(documentOf(given, 'Secret'), new RegExp(`^ {2}metricsToken: "${TOKEN}"$`, 'm'));
    const deployment = documentOf(given, 'Deployment');
    assert.match(
      deployment,
      /- name: JUKECORD_METRICS_TOKEN_FILE\n {14}value: \/run\/secrets\/jukecord\/metricsToken\n/,
    );
    assert.match(
      deployment,
      /name: t-jukecord\n {18}items:\n {20}- key: metricsToken\n {22}path: metricsToken\n {18}optional: false/,
    );
    assert.doesNotMatch(deployment, new RegExp(TOKEN));
    assert.match(
      documentOf(given, 'ServiceMonitor'),
      /authorization:\n {8}type: Bearer\n {8}credentials:\n {10}name: t-jukecord\n {10}key: metricsToken\n/,
    );
    // A Secret of yours: the chart makes none (no other secret given), and both read yours.
    const yours = render(
      '--set',
      'metrics.existingSecret=jukecord-metrics',
      '--set',
      'metrics.serviceMonitor.enabled=true',
      '--set',
      'metrics.serviceMonitor.force=true',
    );
    assert.doesNotMatch(yours, /^kind: Secret$/m);
    assert.match(documentOf(yours, 'Deployment'), /name: jukecord-metrics\n {18}items:\n {20}- key: metricsToken\n/);
    assert.match(documentOf(yours, 'ServiceMonitor'), /credentials:\n {10}name: jukecord-metrics\n/);
    // A changed token restarts the pod, which reads it only when it starts.
    const checksum = (text: string) => /checksum\/secret: (\w+)/.exec(text)?.[1];
    assert.notEqual(checksum(given), checksum(plain));
  });

  it('annotates the pod for a Prometheus that finds targets by annotation, when asked, yours winning', () => {
    const annotated = documentOf(render('--set', 'metrics.podAnnotations=true'), 'Deployment');
    assert.match(
      annotated,
      /prometheus\.io\/path: "\/metrics"\n {8}prometheus\.io\/port: "8795"\n {8}prometheus\.io\/scrape: "true"\n/,
    );
    const yours = documentOf(
      render('--set', 'metrics.podAnnotations=true', '--set-string', 'podAnnotations.prometheus\\.io/port=9100'),
      'Deployment',
    );
    assert.equal((yours.match(/prometheus\.io\/port/g) ?? []).length, 1);
    assert.match(yours, /prometheus\.io\/port: "9100"/);
  });

  it('refuses what cannot work, each time with what to change', () => {
    assert.match(
      refusal('--set', 'metrics.existingSecret=s', '--set-string', `metrics.token=${TOKEN}`),
      /would be ignored/,
    );
    assert.match(refusal('--set-string', `env.JUKECORD_METRICS_TOKEN=${TOKEN}`), /goes in metrics\.token/);
    assert.match(
      refusal('--set', 'extraEnv[0].name=JUKECORD_METRICS_TOKEN_FILE', '--set', 'extraEnv[0].value=/x'),
      /set by the chart/,
    );
    for (const values of [
      ['--set-string', 'metrics.token=short'],
      ['--set-string', 'metrics.token=two words that are long enough'],
      ['--set', 'metrics.serviceMonitor.interval=30'],
      ['--set', 'metrics.serviceMonitor.labels.team=two words'],
      ['--set', 'metrics.serviceMonitor.enable=true'],
    ]) {
      assert.match(refusal(...values), /don't meet the specifications of the schema/, values.join(' '));
    }
  });

  it('lints, and passes kubeconform with the ServiceMonitor and the token', () => {
    const values = [
      '--set',
      'metrics.serviceMonitor.enabled=true',
      '--set',
      'metrics.serviceMonitor.force=true',
      '--set',
      'metrics.podAnnotations=true',
      '--set-string',
      `metrics.token=${TOKEN}`,
      '--set',
      'discord.token=x',
    ];
    execFileSync('helm', ['lint', 'deploy/helm/jukecord', '--strict', ...values], { stdio: 'pipe' });
    if (!have('kubeconform', '-v')) return;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-monitor-')), 'chart.yaml');
    fs.writeFileSync(file, render(...values));
    execFileSync(
      'kubeconform',
      [
        '-strict',
        '-summary',
        '-kubernetes-version',
        '1.31.0',
        '-schema-location',
        'default',
        '-schema-location',
        CRD_SCHEMAS,
        file,
      ],
      { stdio: 'pipe' },
    );
  });
});

// Every metric name a PromQL expression names, and the label names its selectors and `by` clauses use.
function metricsIn(expr: string): {
  names: string[];
  selectors: [string, string[]][];
  grouped: string[];
  rated: string[];
} {
  const names = [...expr.matchAll(/\b((?:jukecord|nodejs|process)_[a-z0-9_]+|up)\b(?=\s*[{[)\s]|$)/g)].map(
    (m) => m[1] ?? '',
  );
  const selectors = [...expr.matchAll(/\b([a-z_:][a-z0-9_:]*)\{([^}]*)\}/g)].map((m): [string, string[]] => [
    m[1] ?? '',
    [...(m[2] ?? '').matchAll(/(\w+)\s*(?:=~|!~|!=|=)/g)].map((l) => l[1] ?? ''),
  ]);
  const grouped = [...expr.matchAll(/\bby\s*\(([^)]*)\)/g)].flatMap((m) =>
    (m[1] ?? '').split(',').map((l) => l.trim()),
  );
  const rated = [...expr.matchAll(/\b(?:rate|increase|irate)\(\s*([a-z_:][a-z0-9_:]*)/g)].map((m) => m[1] ?? '');
  return { names, selectors, grouped, rated };
}

// The family a series name belongs to (a histogram's _bucket, _sum and _count are its own), or null.
function familyOf(name: string, families: Map<string, FamilyInfo>): FamilyInfo | null {
  const direct = families.get(name);
  if (direct) return direct;
  const base = name.replace(/_(bucket|sum|count)$/, '');
  const histogram = families.get(base);
  return histogram?.kind === 'histogram' ? histogram : null;
}

// The labels every series of a target has (Prometheus's own), and a histogram bucket's.
const TARGET_LABELS = ['job', 'instance'];

// Checks one expression against what jukecord declares; `up` is Prometheus's own series of every target.
function checkExpr(expr: string, families: Map<string, FamilyInfo>, where: string): void {
  const found = metricsIn(expr);
  assert.ok(found.names.length > 0, `${where} names no metric: ${expr}`);
  const labels = new Set<string>([...TARGET_LABELS, 'le']);
  for (const name of found.names) {
    if (name === 'up') continue;
    const family = familyOf(name, families);
    assert.ok(family, `${where} names ${name}, which jukecord does not declare`);
    for (const label of family.labelNames) labels.add(label);
  }
  for (const [name, used] of found.selectors) {
    if (name === 'up') continue;
    const family = familyOf(name, families);
    const own = new Set([...TARGET_LABELS, ...(family?.labelNames ?? []), ...(name.endsWith('_bucket') ? ['le'] : [])]);
    for (const label of used) assert.ok(own.has(label), `${where}: ${name} has no label ${label}`);
  }
  for (const label of found.grouped)
    assert.ok(labels.has(label), `${where} groups by ${label}, which no metric of it has`);
  // A rate is of something that only goes up: a counter, or a histogram's buckets, sum or count.
  for (const name of found.rated) {
    const family = familyOf(name, families);
    assert.ok(
      family?.kind === 'counter' || (family?.kind === 'histogram' && name !== family.name),
      `${where} takes the rate of ${name}, which is no counter`,
    );
  }
}

describe('the Grafana dashboard', () => {
  const every = everyFamily();
  after(() => every.close());
  const families = new Map(every.registry.declared().map((family) => [family.name, family]));
  const dashboard = JSON.parse(read(DASHBOARD_FILE)) as {
    uid: string;
    templating: { list: { name: string; query: unknown }[] };
    panels: {
      id: number;
      type: string;
      title: string;
      gridPos: { x: number; y: number; w: number; h: number };
      datasource?: { uid: string };
      targets?: { expr: string; refId: string }[];
    }[];
  };

  it('is what scripts/grafana-dashboard.ts makes', () => {
    assert.equal(
      read(DASHBOARD_FILE),
      dashboardText(),
      `${DASHBOARD_FILE} is out of date: node scripts/grafana-dashboard.ts`,
    );
  });

  it('asks only for metrics jukecord declares, with the labels they have, of the targets picked at the top', () => {
    let queries = 0;
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        queries += 1;
        checkExpr(target.expr, families, `"${panel.title}" ${target.refId}`);
        // Every selector is held to the jobs and instances picked at the top.
        for (const selector of target.expr.match(/\{[^}]*\}/g) ?? []) {
          assert.match(selector, /job=~"\$job", instance=~"\$instance"/, `"${panel.title}": ${selector}`);
        }
      }
    }
    assert.ok(queries > 40, `only ${queries} queries`);
    // The jobs to pick from are the ones that report jukecord_info.
    assert.deepEqual(
      dashboard.templating.list.map((variable) => variable.name),
      ['datasource', 'job', 'instance'],
    );
    assert.match(JSON.stringify(dashboard.templating), /label_values\(jukecord_info, job\)/);
  });

  it('lays its panels out in the grid, each with its own id and the picked Prometheus', () => {
    const ids = dashboard.panels.map((panel) => panel.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const panel of dashboard.panels) {
      assert.ok(panel.gridPos.x >= 0 && panel.gridPos.x + panel.gridPos.w <= 24, panel.title);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana's variable, as the dashboard writes it.
      if (panel.type !== 'row') assert.equal(panel.datasource?.uid, '${datasource}', panel.title);
    }
    assert.equal(dashboard.uid, 'jukecord');
  });
});

// The rules of alerts.yaml as its own layout writes them: each `- alert:` with its expr (on its line, or folded
// below it), its labels and annotations.
function rules(text: string): { alert: string; expr: string; block: string }[] {
  return text
    .split(/^ {6}- alert: /m)
    .slice(1)
    .map((block) => {
      const alert = block.split('\n')[0]?.trim() ?? '';
      const inline = /^ {8}expr: (?!>-)(.+)$/m.exec(block)?.[1];
      const folded = /^ {8}expr: >-\n((?: {10}.*\n)+)/m.exec(block)?.[1];
      return { alert, expr: (inline ?? folded ?? '').replace(/\s+/g, ' ').trim(), block };
    });
}

describe('the alert rules', () => {
  const every = everyFamily();
  after(() => every.close());
  const families = new Map(every.registry.declared().map((family) => [family.name, family]));
  const text = read('deploy/monitoring/alerts.yaml');

  it('cover what the brief names, each with a severity, a summary and a description, on metrics that exist', () => {
    const found = rules(text);
    assert.deepEqual(
      found.map((rule) => rule.alert),
      [
        'JukecordDown',
        'JukecordNotReady',
        'JukecordDiscordDisconnected',
        'JukecordFetchFailuresClimbing',
        'JukecordCacheFull',
        'JukecordEventLoopStalling',
        // A split's: a core that hears no edge, an edge that gets no answers from the core.
        'JukecordNoEdges',
        'JukecordCoreNotAnswering',
      ],
    );
    for (const rule of found) {
      assert.ok(rule.expr, `${rule.alert} has no expr`);
      checkExpr(rule.expr, families, rule.alert);
      assert.match(rule.block, /^ {10}severity: (critical|warning)$/m, rule.alert);
      assert.match(rule.block, /^ {10}summary: \S/m, rule.alert);
      assert.match(rule.block, /^ {10}description: >-\n {12}\S/m, rule.alert);
      assert.match(rule.block, /^ {8}for: \d+m$/m, rule.alert);
    }
  });

  it('pass promtool, and its tests in alerts.test.yaml', {
    skip: !have('promtool', '--version') && 'promtool is not installed',
  }, () => {
    execFileSync('promtool', ['check', 'rules', 'alerts.yaml'], { cwd: 'deploy/monitoring', stdio: 'pipe' });
    execFileSync('promtool', ['test', 'rules', 'alerts.test.yaml'], { cwd: 'deploy/monitoring', stdio: 'pipe' });
  });
});

describe('the Compose example', () => {
  const compose = read('deploy/monitoring/compose.yaml');

  it('runs pinned images, opens its ports on this machine only, and joins jukecord rather than making a network', () => {
    const images = [...compose.matchAll(/^ {4}image: (\S+)$/gm)].map((match) => match[1] ?? '');
    assert.equal(images.length, 2);
    for (const image of images) assert.match(image, /^[a-z/]+:v?\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/, image);
    const ports = [...compose.matchAll(/^ {6}- "(.+)"$/gm)].map((match) => match[1] ?? '');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose's variables, as the file writes them.
    assert.deepEqual(ports, ['127.0.0.1:${PROMETHEUS_PORT:-9090}:9090', '127.0.0.1:${GRAFANA_PORT:-3000}:3000']);
    assert.match(compose, /name: \$\{JUKECORD_NETWORK:-jukecord_default\}\n {4}external: true/);
    // The project of the main compose.yaml is called jukecord, so its network is jukecord_default.
    assert.match(read('compose.yaml'), /^name: jukecord$/m);
  });

  it('mounts files that exist, which name each other rightly', () => {
    const mounted = [...compose.matchAll(/^ {6}- \.\/([^:\s]+):\S+$/gm)].map((match) => match[1] ?? '');
    assert.deepEqual(mounted, ['prometheus.yml', 'alerts.yaml', 'grafana/provisioning', 'grafana-dashboard.json']);
    for (const match of compose.matchAll(/^ {6}- \.\/([^:\s]+):\S+$/gm)) {
      assert.ok(fs.existsSync(path.join('deploy/monitoring', match[1] ?? '')), `${match[1]} is not there`);
    }
    const prometheus = read('deploy/monitoring/prometheus.yml');
    // The rules where compose mounts them, jukecord by its service's name and port.
    assert.match(prometheus, /^ {2}- \/etc\/prometheus\/alerts\.yaml$/m);
    assert.match(compose, /\.\/alerts\.yaml:\/etc\/prometheus\/alerts\.yaml:ro/);
    assert.match(prometheus, /targets: \["jukecord:8795"\]/);
    assert.match(read('compose.yaml'), /^ {2}jukecord:$/m);
    // Grafana's dashboard folder is where compose puts the dashboard, and its home page that file.
    assert.match(
      read('deploy/monitoring/grafana/provisioning/dashboards/jukecord.yaml'),
      /path: \/etc\/grafana\/dashboards$/m,
    );
    assert.match(compose, /\.\/grafana-dashboard\.json:\/etc\/grafana\/dashboards\/jukecord\.json:ro/);
    assert.match(
      read('deploy/monitoring/grafana/provisioning/datasources/prometheus.yaml'),
      /url: http:\/\/prometheus:9090$/m,
    );
  });

  it('is a Compose file docker compose takes', { skip: !have('docker') && 'docker is not installed' }, () => {
    execFileSync('docker', ['compose', '-f', 'deploy/monitoring/compose.yaml', 'config', '--quiet'], { stdio: 'pipe' });
  });
});
