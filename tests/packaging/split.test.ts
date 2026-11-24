/**
 * What runs jukecord split into services: the Compose file (a core, two edges, the database, Valkey, Caddy), the
 * chart's split mode (a core of one Recreate pod with the volume, edges without one, the core's Service, the policies,
 * the secrets as files), and the end-to-end script and its CI job. The chart is linted, rendered and validated with
 * helm and kubeconform when they are installed (CI installs both), and the Compose files read by Compose when Docker is
 * there.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const read = (file: string) => fs.readFileSync(file, 'utf8');

// Whether a program answers `<program> <args>`.
function have(program: string, args = ['version']): boolean {
  try {
    execFileSync(program, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The values every split render needs: a database and a bus.
const SPLIT = [
  '--set',
  'mode=split',
  '--set',
  'database.url=postgres://j:p@db:5432/j',
  '--set',
  'bus.url=redis://valkey:6379',
];

// The chart rendered with these values, or the error it refused them with.
function render(...values: string[]): string {
  try {
    return execFileSync('helm', ['template', 't', 'deploy/helm/jukecord', ...values], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    return `refused: ${String((error as { stderr?: Buffer }).stderr ?? error)}`;
  }
}

// One object of a render, by its kind and name.
function object(rendered: string, kind: string, name: string): string {
  const found = rendered
    .split(/^---$/m)
    .find((part) => part.includes(`\nkind: ${kind}\n`) && part.includes(`name: ${name}\n`));
  assert.ok(found, `no ${kind} ${name}`);
  return found;
}

describe('the Compose split', () => {
  it('is in files Compose and Dependabot find by their names, and Dependabot watches them', () => {
    // dependabot-core's docker_compose file fetcher reads a folder's files whose names match this (Ruby's atomic group
    // written as a plain one, the same for these names); Compose reads compose.yaml in a folder by itself.
    const dependabotReads = /(docker-)?compose(-\w+)?(\.[\w-]+)?\.ya?ml/i;
    for (const file of ['compose.yaml', 'compose.mysql.yaml']) {
      assert.ok(fs.existsSync(`deploy/split/${file}`), file);
      assert.match(file, dependabotReads, file);
    }
    // Their images by digest, every one watched, and no major version proposed (a database's needs its data moved).
    const dependabot = read('.github/dependabot.yml');
    assert.match(
      dependabot,
      /- package-ecosystem: docker-compose\n {4}directory: \/deploy\/split\n(?: {4}.*\n)*? {6}- dependency-name: "\*"\n {8}update-types: \["version-update:semver-major"\]\n/,
    );
    for (const file of ['compose.yaml', 'compose.mysql.yaml']) {
      for (const match of read(`deploy/split/${file}`).matchAll(/^ {4}image: (\S+)$/gm)) {
        // The jukecord image is the one exception: a local build or the release the host names.
        if (match[1]?.startsWith('${JUKECORD_IMAGE')) continue;
        assert.match(match[1] ?? '', /^[a-z/]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `${file}: ${match[1]}`);
      }
    }
  });

  it('publishes only the front, on this machine by default, and runs every jukecord read-only without privileges', () => {
    const compose = read('deploy/split/compose.yaml');
    assert.match(compose, /"\$\{JUKECORD_BIND:-127\.0\.0\.1\}:\$\{JUKECORD_PORT:-8795\}:80"/);
    assert.equal(compose.match(/^ {4}ports:$/gm)?.length, 1, 'only the front publishes a port');
    assert.match(compose, /read_only: true/);
    assert.match(compose, /no-new-privileges:true/);
    // One core with the volume; edges without one, behind one proxy whose X-Forwarded-For counts.
    assert.match(compose, /JUKECORD_ROLE: core/);
    assert.match(compose, /JUKECORD_ROLE: edge/);
    assert.match(compose, /- core-data:\/data/);
    assert.match(compose, /JUKECORD_CORE_URL: http:\/\/core:8796/);
    assert.match(compose, /JUKECORD_TRUST_PROXY: "1"/);
    assert.match(compose, /^ {2}edge1: \*edge$/m);
    assert.match(compose, /^ {2}edge2: \*edge$/m);
    // The secrets are the split's own file's, required, and never the checkout's .env (which the jukecord services
    // read for their other settings).
    assert.match(compose, /\$\{JUKECORD_DB_PASSWORD:\?/);
    assert.match(compose, /\$\{JUKECORD_INTERNAL_SECRET:\?/);
    // Every image pinned by digest.
    for (const match of compose.matchAll(/^ {4}image: (\S+)$/gm)) {
      if (match[1]?.startsWith('${JUKECORD_IMAGE')) continue;
      assert.match(match[1] ?? '', /@sha256:[0-9a-f]{64}$/, `${match[1]} is not pinned by digest`);
    }
    assert.match(read('deploy/split/Caddyfile'), /reverse_proxy edge1:8795 edge2:8795/);
  });

  it('is read by Compose, with PostgreSQL and with MySQL', {
    skip: !have('docker', ['compose', 'version']) && 'no Compose',
  }, () => {
    const env = { ...process.env, JUKECORD_DB_PASSWORD: 'x', JUKECORD_INTERNAL_SECRET: 'y'.repeat(40) };
    const config = (...files: string[]) =>
      execFileSync('docker', ['compose', ...files.flatMap((file) => ['-f', file]), 'config'], {
        encoding: 'utf8',
        env,
        stdio: 'pipe',
      });
    assert.match(config('deploy/split/compose.yaml'), /JUKECORD_DATABASE_URL: postgres:\/\/jukecord:x@database:5432/);
    const mysql = config('deploy/split/compose.yaml', 'deploy/split/compose.mysql.yaml');
    assert.match(mysql, /JUKECORD_DATABASE_URL: mysql:\/\/jukecord:x@database:3306\/jukecord/);
    assert.doesNotMatch(mysql, /POSTGRES_PASSWORD/);
  });
});

describe("the chart's split mode", { skip: !have('helm') && 'helm is not installed' }, () => {
  it('lints in both modes', () => {
    execFileSync('helm', ['lint', 'deploy/helm/jukecord', '--strict'], { stdio: 'pipe' });
    execFileSync('helm', ['lint', 'deploy/helm/jukecord', '--strict', ...SPLIT], { stdio: 'pipe' });
  });

  it('runs one core with the volume, edges without one, and points the panel at the edges', () => {
    const rendered = render(...SPLIT, '--set', 'discord.token=x', '--set', 'ingress.enabled=true');
    // The one-process Deployment is not there: the core and the edges are.
    const deployments = rendered.split(/^---$/m).filter((part) => part.includes('\nkind: Deployment\n'));
    assert.deepEqual(deployments.map((part) => /^ {2}name: (\S+)$/m.exec(part)?.[1]).sort(), [
      't-jukecord-core',
      't-jukecord-edge',
    ]);
    const core = object(rendered, 'Deployment', 't-jukecord-core');
    assert.match(core, /replicas: 1\n/);
    assert.match(core, /type: Recreate/);
    assert.match(core, /claimName: t-jukecord\n/);
    assert.match(core, /name: JUKECORD_ROLE\n\s+value: core/);
    assert.match(core, /containerPort: 8796/);
    assert.match(core, /JUKECORD_DISCORD_TOKEN_FILE/);
    const edge = object(rendered, 'Deployment', 't-jukecord-edge');
    assert.match(edge, /replicas: 2\n/);
    assert.match(edge, /name: JUKECORD_ROLE\n\s+value: edge/);
    assert.match(edge, /value: http:\/\/t-jukecord-core:8796/);
    assert.doesNotMatch(edge, /persistentVolumeClaim/);
    // The bot's token stays with the core; behind the Ingress the edges believe one proxy.
    assert.doesNotMatch(edge, /JUKECORD_DISCORD_TOKEN_FILE/);
    assert.match(edge, /name: JUKECORD_TRUST_PROXY\n\s+value: "1"/);
    // The secrets reach both as files: the database's as in single mode (one Secret, key and mount), split mode's own
    // beside it.
    for (const part of [core, edge]) {
      assert.match(part, /name: JUKECORD_DATABASE_URL_FILE\n\s+value: \/run\/secrets\/jukecord-database\/url\n/);
      assert.match(
        part,
        /secretName: t-jukecord-database\n\s+defaultMode: 0440\n\s+items:\n\s+- key: url\n\s+path: url/,
      );
      assert.match(part, /checksum\/database: /);
      for (const name of ['BUS_URL', 'INTERNAL_SECRET']) {
        assert.match(part, new RegExp(`name: JUKECORD_${name}_FILE\\n\\s+value: /run/secrets/jukecord-split/`));
      }
    }
    assert.doesNotMatch(rendered, /secretKeyRef/);
    assert.match(object(rendered, 'Secret', 't-jukecord-database'), /url: "postgres:/);
    // The panel's Service finds the edges; the core's finds the core, its internal port and its own.
    assert.match(object(rendered, 'Service', 't-jukecord'), /app\.kubernetes\.io\/component: edge/);
    const coreService = object(rendered, 'Service', 't-jukecord-core');
    assert.match(coreService, /app\.kubernetes\.io\/component: core/);
    assert.match(coreService, /port: 8796/);
    // The chart's Secret of split mode: the bus's address given, and an internal secret made for the release.
    const secret = object(rendered, 'Secret', 't-jukecord-split');
    for (const key of ['bus-url', 'internal-secret']) assert.match(secret, new RegExp(`^ {2}${key}: "`, 'm'));
    assert.doesNotMatch(secret, /database-url/);
  });

  it('gives both parts the metrics token, and has the ServiceMonitor scrape the core and every edge', () => {
    const rendered = render(
      ...SPLIT,
      '--set',
      'metrics.token=0123456789abcdef0123',
      '--set',
      'metrics.serviceMonitor.enabled=true',
      '--set',
      'metrics.serviceMonitor.force=true',
      '--set',
      'metrics.podAnnotations=true',
    );
    for (const name of ['t-jukecord-core', 't-jukecord-edge']) {
      const part = object(rendered, 'Deployment', name);
      assert.match(part, /name: JUKECORD_METRICS_TOKEN_FILE\n\s+value: \/run\/secrets\/jukecord\/metricsToken/);
      assert.match(part, /- key: metricsToken\n\s+path: metricsToken/);
      assert.match(part, /prometheus\.io\/scrape: "true"/);
    }
    const monitor = object(rendered, 'ServiceMonitor', 't-jukecord');
    assert.match(monitor, /key: app\.kubernetes\.io\/component\n\s+operator: In\n\s+values: \[server, core\]/);
    // The panel's Service (the edges) and the core's both carry what it selects, on their http port.
    assert.match(object(rendered, 'Service', 't-jukecord'), /app\.kubernetes\.io\/component: server/);
    assert.match(object(rendered, 'Service', 't-jukecord-core'), /name: http\n\s+port: 8795/);
  });

  it("lets only the edges reach the core's internal port, and both reach the database and the bus", () => {
    const rendered = render(...SPLIT);
    const core = object(rendered, 'NetworkPolicy', 't-jukecord-core');
    assert.match(
      core,
      /- port: 8796\n\s+protocol: TCP\n\s+from:\n\s+- podSelector:\n\s+matchLabels:\n(?:\s+.*\n)*?\s+app\.kubernetes\.io\/component: edge/,
    );
    const edge = object(rendered, 'NetworkPolicy', 't-jukecord-edge');
    assert.match(edge, /app\.kubernetes\.io\/component: core\n\s+ports:\n\s+- port: 8796/);
    for (const policy of [core, edge])
      for (const port of [5432, 3306, 6379]) assert.match(policy, new RegExp(`port: ${port}\\n`));
    // Elsewhere, where the values say.
    const elsewhere = render(
      ...SPLIT,
      '--set',
      'networkPolicy.egressTo[0].to[0].ipBlock.cidr=10.20.0.0/24',
      '--set',
      'networkPolicy.egressTo[0].ports[0].port=5432',
    );
    assert.match(object(elsewhere, 'NetworkPolicy', 't-jukecord-core'), /cidr: 10\.20\.0\.0\/24/);
    assert.doesNotMatch(object(elsewhere, 'NetworkPolicy', 't-jukecord-core'), /port: 6379/);
  });

  it('scales the edges when asked, and keeps the secrets of a Secret of yours', () => {
    const scaled = render(...SPLIT, '--set', 'split.edge.autoscaling.enabled=true');
    assert.match(object(scaled, 'HorizontalPodAutoscaler', 't-jukecord-edge'), /averageUtilization: 70/);
    assert.doesNotMatch(object(scaled, 'Deployment', 't-jukecord-edge'), /^ {2}replicas:/m);
    const theirs = render(
      '--set',
      'mode=split',
      '--set',
      'database.existingSecret=db',
      '--set',
      'bus.existingSecret=bus',
      '--set',
      'split.existingSecret=internal',
    );
    assert.doesNotMatch(theirs, /name: t-jukecord-split\n/);
    const core = object(theirs, 'Deployment', 't-jukecord-core');
    assert.match(core, /secretName: db\n\s+defaultMode: 0440\n\s+items:\n\s+- key: url\n\s+path: url/);
    assert.match(core, /name: internal\n\s+items:\n\s+- key: internalSecret\n\s+path: internal-secret/);
  });

  it('refuses split mode without a database or a bus, or with a setting the chart makes', () => {
    assert.match(
      render('--set', 'mode=split', '--set', 'bus.url=redis://v:6379'),
      /needs a database every service shares/,
    );
    assert.match(
      render('--set', 'mode=split', '--set', 'database.url=postgres://d/j'),
      /needs the Redis or Valkey server/,
    );
    assert.match(render(...SPLIT, '--set', 'bus.existingSecret=b'), /bus\.url and bus\.existingSecret are both set/);
    assert.match(render(...SPLIT, '--set', 'env.JUKECORD_ROLE=edge'), /set by the chart/);
    assert.match(render('--set', 'mode=both'), /don't meet the specifications of the schema/);
    assert.match(
      render('--set', 'mode=split', '--set', 'bus.url=redis://v:6379', '--set', 'database.url=sqlite:/data/x.db'),
      /a SQLite file is one pod's/,
    );
  });

  it('passes kubeconform in both modes', {
    skip: !have('kubeconform', ['-v']) && 'kubeconform is not installed',
  }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-split-chart-'));
    try {
      const files = [
        ['single.yaml', render('--set', 'discord.token=x', '--set', 'ingress.enabled=true')],
        [
          'split.yaml',
          render(
            ...SPLIT,
            '--set',
            'discord.token=x',
            '--set',
            'ingress.enabled=true',
            '--set',
            'split.edge.autoscaling.enabled=true',
          ),
        ],
      ];
      for (const [name, text] of files) {
        const file = path.join(dir, name ?? '');
        fs.writeFileSync(file, text ?? '');
        execFileSync('kubeconform', ['-strict', '-summary', '-kubernetes-version', '1.31.0', file], { stdio: 'pipe' });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the end-to-end run', () => {
  it('is a script that can run, removes what it started, and runs in CI on both databases', () => {
    for (const file of ['tests/split/run.sh', 'deploy/kind/check-split.sh'])
      assert.ok(fs.statSync(file).mode & 0o100, `${file} is not executable`);
    assert.match(read('.github/workflows/chart-e2e.yml'), /deploy\/kind\/check-split\.sh jukecord:e2e/);
    const script = read('tests/split/run.sh');
    assert.match(script, /trap cleanup EXIT/);
    assert.match(script, /down --volumes --remove-orphans/);
    assert.match(script, /project=jukecord-test-split-e2e-/);
    // No Discord, whatever the checkout's .env says.
    assert.match(read('tests/split/compose.e2e.yaml'), /env_file: !reset \[\]/);
    const ci = read('.github/workflows/ci.yml');
    assert.match(ci, /tests\/split\/run\.sh \$\{\{ matrix\.database \}\} jukecord:ci/);
    assert.match(ci, /database: \[postgres, mysql\]/);
    // And the bus's tests on a real Valkey there.
    assert.match(ci, /JUKECORD_TEST_BUS_URL: redis:\/\/127\.0\.0\.1:6379/);
  });
});
