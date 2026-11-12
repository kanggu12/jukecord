/**
 * What ships around the code: one version everywhere, the changelog, the API document, the image's pins, the
 * Compose file, the chart, the workflows, the front door and the settings examples. The chart is linted, rendered and
 * validated with helm and kubeconform when they are installed (CI installs both).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LIVE_ACTIONS, PANEL_ACTIONS } from '../../panel/src/api.ts';
import { withTable } from '../../scripts/api-doc.ts';
import { notesFor } from '../../scripts/release-notes.ts';
import { ACTIONS } from '../../src/app/actions.ts';
import { VERSION } from '../../src/version.ts';

const read = (file: string) => fs.readFileSync(file, 'utf8');

// Whether a program is on the PATH.
function have(program: string): boolean {
  try {
    execFileSync(program, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('versions', () => {
  it('names one version in src/version.ts, package.json and the chart', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    assert.equal((JSON.parse(read('package.json')) as { version: string }).version, VERSION);
    const chart = read('deploy/helm/jukecord/Chart.yaml');
    assert.match(chart, new RegExp(`^version: ${VERSION.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(chart, new RegExp(`^appVersion: "${VERSION.replace(/\./g, '\\.')}"$`, 'm'));
  });

  it('has notes for the version in CHANGELOG.md, or an Unreleased section on its way to it', () => {
    const changelog = read('CHANGELOG.md');
    assert.ok(notesFor(changelog, VERSION) ?? notesFor(changelog, 'Unreleased'), 'no notes for this version');
    // The parser takes one section and stops at the next.
    assert.equal(notesFor('## [1.0.0] - 2026-01-01\n\n- a\n\n## [0.9.0]\n\n- b\n', '1.0.0'), '- a');
    assert.equal(notesFor('## [1.0.0]\n\n## [0.9.0]\n- b\n', '1.0.0'), null);
  });
});

describe('documents', () => {
  it('has an API document whose operations table matches the API', () => {
    const document = read('docs/API.md');
    assert.equal(withTable(document), document, 'docs/API.md is out of date: node scripts/api-doc.ts');
  });

  it('lists in .env.example only settings jukecord knows', () => {
    const config = read('src/config.ts');
    for (const name of read('.env.example').match(/^JUKECORD_[A-Z_]+(?==)/gm) ?? []) {
      assert.ok(config.includes(`'${name}'`), `${name} in .env.example is not a setting`);
    }
  });

  it('documents every setting jukecord reads', () => {
    const guide = read('docs/README.md');
    const known = [...read('src/config.ts').matchAll(/^ {2}'(JUKECORD_[A-Z_]+)',$/gm)].map((match) => match[1] ?? '');
    // The two read by compose.yaml only are in INSTALL.md.
    for (const name of known.filter((setting) => !['JUKECORD_BIND', 'JUKECORD_IMAGE'].includes(setting))) {
      assert.ok(guide.includes(name), `${name} is missing from the settings table in docs/README.md`);
    }
  });

  it('links only to files that exist', () => {
    for (const file of [
      'README.md',
      'CONTRIBUTING.md',
      ...fs
        .readdirSync('docs')
        .filter((name) => name.endsWith('.md'))
        .map((name) => `docs/${name}`),
    ]) {
      for (const match of read(file).matchAll(/\]\(((?!https?:|#|mailto:)[^)#\s]+)(#[^)]*)?\)/g)) {
        const target = path.join(path.dirname(file), match[1] ?? '');
        assert.ok(fs.existsSync(target), `${file} links to ${match[1]}, which is not there`);
      }
    }
  });
});

describe('the image', () => {
  const dockerfile = read('deploy/docker/Dockerfile');

  it('pins its base by digest in FROM lines, where Dependabot reads it, and yt-dlp by version and checksum', () => {
    // The base stage and the panel's stage (built for the build machine's processor) name the same image.
    const bases = [...dockerfile.matchAll(/^FROM (?:--platform=\$BUILDPLATFORM )?(node:\S+) AS (\w+)$/gm)];
    assert.deepEqual(
      bases.map((match) => match[2]),
      ['base', 'panel'],
    );
    assert.match(bases[0]?.[1] ?? '', /^node:26-[a-z-]+@sha256:[0-9a-f]{64}$/);
    assert.equal(bases[1]?.[1], bases[0]?.[1], 'the panel stage builds on another base');
    // Every other stage starts from the base stage, so one line sets the base for all of them.
    for (const match of dockerfile.matchAll(/^FROM (?!node:|--platform)(\S+) AS \w+$/gm))
      assert.equal(match[1], 'base');
    assert.match(dockerfile, /^ARG YTDLP_VERSION=\d{4}\.\d{2}\.\d{2}$/m);
    assert.match(dockerfile, /^ARG YTDLP_SHA256_AMD64=[0-9a-f]{64}$/m);
    assert.match(dockerfile, /^ARG YTDLP_SHA256_ARM64=[0-9a-f]{64}$/m);
    assert.match(dockerfile, /sha256sum -c -/);
    assert.doesNotMatch(dockerfile, /:latest\b/);
  });

  it('runs as a fixed non-root user with a health check, and carries the panel and the command', () => {
    assert.match(dockerfile, /^USER 10001:10001$/m);
    assert.match(dockerfile, /^HEALTHCHECK /m);
    assert.match(dockerfile, /COPY --from=panel (--chmod=\S+ )?\/app\/panel\/dist \.\/panel\/dist/);
    assert.match(dockerfile, /\/usr\/local\/bin\/jukecord/);
  });

  it('copies its own files readable and not executable, and keeps no npm and no setuid program', () => {
    // The symbolic mode needs a newer Dockerfile frontend than the octal one; X is execute for folders only.
    assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\n/);
    assert.doesNotMatch(dockerfile, /--chmod=0?7/);
    assert.equal(dockerfile.match(/^COPY (--from=panel )?--chmod=u=rwX,go=rX /gm)?.length, 3);
    assert.match(
      dockerfile,
      /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/,
    );
    assert.match(dockerfile, /find \/ -xdev -type f -perm \/6000 -exec chmod a-s \{\} \+/);
  });

  it('declares what changes with a release after the steps a release takes from the cache, and labels it fully', () => {
    // A build argument declared before a RUN is part of its cache key, so the release's version comes last.
    const lastRun = dockerfile.lastIndexOf('\nRUN ');
    for (const line of ['ARG VERSION=', 'ARG REVISION=', 'LABEL org.opencontainers.image.title=']) {
      assert.ok(dockerfile.indexOf(`\n${line}`) > lastRun, `${line} comes before a RUN`);
    }
    // A pinned version comes after the tools its stage installs, so a bump takes those from the cache.
    for (const [stage, pin] of [
      ['ytdlp', 'YTDLP_VERSION'],
      ['ffmpeg', 'FFMPEG_VERSION'],
    ]) {
      const from = dockerfile.indexOf(`AS ${stage}\n`);
      assert.ok(dockerfile.indexOf('apt-get install', from) < dockerfile.indexOf(`ARG ${pin}=`, from), stage);
    }
    for (const label of ['url', 'documentation', 'source', 'licenses', 'version', 'revision'])
      assert.match(dockerfile, new RegExp(`org\\.opencontainers\\.image\\.${label}=`));
    // What only the release knows: when, and on which base; the index of both architectures gets annotations.
    const release = read('.github/workflows/release.yml');
    for (const label of ['created', 'base\\.name', 'base\\.digest'])
      assert.match(release, new RegExp(`org\\.opencontainers\\.image\\.${label}=\\$\\{\\{ steps\\.v\\.outputs\\.`));
    for (const annotation of ['description', 'source'])
      assert.match(release, new RegExp(`--annotation "index:org\\.opencontainers\\.image\\.${annotation}=`));
  });

  it('sends only what the build needs', () => {
    const ignore = read('.dockerignore');
    for (const entry of ['**', '!src/**', '!panel/**', '!scripts/**', 'panel/dist'])
      assert.ok(ignore.split('\n').includes(entry), entry);
  });
});

describe('Compose and the front door', () => {
  it('publishes the panel on this machine only by default, read-only, bounded and without privileges', () => {
    const compose = read('compose.yaml');
    assert.match(compose, /"\$\{JUKECORD_BIND:-127\.0\.0\.1\}:\$\{JUKECORD_PORT:-8795\}:8795"/);
    assert.match(compose, /read_only: true/);
    assert.match(compose, /no-new-privileges:true/);
    assert.match(compose, /jukecord-data:\/data/);
    // Memory without swap on top, a process count, and a /tmp that cannot grow into all of that memory.
    assert.match(compose, /^ {4}mem_limit: 1g$/m);
    assert.match(compose, /^ {4}memswap_limit: 1g$/m);
    assert.match(compose, /^ {4}pids_limit: \d+$/m);
    assert.match(compose, /^ {6}- \/tmp:size=\d+m$/m);
  });

  it('has a front door that runs and explains itself', () => {
    assert.ok(fs.statSync('jukecord').mode & 0o100, './jukecord is not executable');
    const help = execFileSync('bash', ['jukecord', 'help'], { encoding: 'utf8' });
    for (const command of [
      'up',
      'open',
      'status',
      'version',
      'logs',
      'doctor',
      'update',
      'restart',
      'backup',
      'restore',
      'down',
    ]) {
      assert.match(help, new RegExp(`\\./jukecord ${command}\\b`));
    }
  });
});

describe('the Helm chart', () => {
  it('has a schema that refuses unknown values', () => {
    const schema = JSON.parse(read('deploy/helm/jukecord/values.schema.json')) as { additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false);
  });

  it('installs the released image as it is, without the release rewriting the values', () => {
    assert.match(read('deploy/helm/jukecord/values.yaml'), /^ {2}repository: ghcr\.io\/kanggu12\/jukecord$/m);
    assert.doesNotMatch(read('.github/workflows/release.yml'), /sed -i[^\n]*values\.yaml/);
  });

  it('lints, renders, refuses a misspelt value, and passes kubeconform', {
    skip: !have('helm') && 'helm is not installed',
  }, () => {
    execFileSync('helm', ['lint', 'deploy/helm/jukecord', '--strict'], { stdio: 'pipe' });
    const rendered = execFileSync(
      'helm',
      [
        'template',
        't',
        'deploy/helm/jukecord',
        '--set',
        'discord.token=x',
        '--set',
        'ingress.enabled=true',
        '--set-string',
        'discord.clientId=108876543210987654',
      ],
      { encoding: 'utf8' },
    );
    for (const kind of [
      'Deployment',
      'Service',
      'PersistentVolumeClaim',
      'Secret',
      'Ingress',
      'NetworkPolicy',
      'Pod',
    ]) {
      assert.match(rendered, new RegExp(`^kind: ${kind}$`, 'm'));
    }
    assert.match(rendered, /enableServiceLinks: false/);
    assert.match(rendered, /readOnlyRootFilesystem: true/);
    // The secrets reach jukecord as files, not as variables that yt-dlp and ffmpeg would inherit; an existing
    // Secret must hold the token, and its OAuth secret is read only with a client ID to go with it.
    assert.match(rendered, /name: JUKECORD_DISCORD_TOKEN_FILE\n/);
    assert.doesNotMatch(rendered, /secretKeyRef/);
    const existing = execFileSync(
      'helm',
      ['template', 't', 'deploy/helm/jukecord', '--set', 'discord.existingSecret=s'],
      {
        encoding: 'utf8',
      },
    );
    assert.match(existing, /- key: token\n\s+path: token\n\s+optional: false\n/);
    assert.doesNotMatch(existing, /JUKECORD_DISCORD_CLIENT_SECRET_FILE/);
    assert.throws(() =>
      execFileSync('helm', ['template', 't', 'deploy/helm/jukecord', '--set', 'replica=2'], { stdio: 'pipe' }),
    );
    // A secret in env, a name the chart sets in extraEnv, and a token beside an existing Secret are refused too.
    for (const values of [
      ['--set', 'env.JUKECORD_DISCORD_TOKEN=x'],
      ['--set', 'extraEnv[0].name=JUKECORD_DISCORD_TOKEN_FILE', '--set', 'extraEnv[0].value=/x'],
      ['--set', 'discord.existingSecret=s', '--set', 'discord.token=x'],
    ]) {
      assert.throws(
        () => execFileSync('helm', ['template', 't', 'deploy/helm/jukecord', ...values], { stdio: 'pipe' }),
        Error,
        values.join(' '),
      );
    }
    if (fs.existsSync('/usr/local/bin/kubeconform') || have('kubeconform')) {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-chart-')), 'chart.yaml');
      fs.writeFileSync(file, rendered);
      execFileSync('kubeconform', ['-strict', '-summary', '-kubernetes-version', '1.31.0', file], { stdio: 'pipe' });
    }
  });
});

describe('workflows and scripts', () => {
  const workflows = fs.readdirSync('.github/workflows').map((name) => `.github/workflows/${name}`);

  it('pins every action to a release, and runs only scripts that exist', () => {
    for (const file of workflows) {
      const text = read(file);
      for (const match of text.matchAll(/uses: ([^\s]+)/g)) {
        const action = match[1] ?? '';
        if (action.startsWith('./')) assert.ok(fs.existsSync(action), `${file} uses ${action}, which is not there`);
        else assert.match(action, /@v\d+(\.\d+)*$/, `${file} uses ${action} without a release`);
      }
      for (const match of text.matchAll(/(?:^|\s)((?:deploy|tests|scripts)\/[\w./-]+\.(?:sh|ts|mjs))/gm)) {
        assert.ok(fs.existsSync(match[1] ?? ''), `${file} runs ${match[1]}, which is not there`);
      }
    }
  });

  it('has its shell scripts executable', () => {
    for (const file of ['jukecord', 'deploy/kind/check.sh', 'tests/ui/run.sh', '.github/badges.sh']) {
      assert.ok(fs.statSync(file).mode & 0o100, `${file} is not executable`);
    }
  });

  it('watches every pin for a newer release: yt-dlp and FFmpeg weekly, the rest through Dependabot', () => {
    assert.match(read('.github/workflows/ytdlp-release.yml'), /ARG YTDLP_VERSION=/);
    assert.match(read('.github/workflows/ffmpeg-release.yml'), /ARG FFMPEG_VERSION=/);
    const dependabot = read('.github/dependabot.yml');
    for (const [ecosystem, directory] of [
      ['github-actions', '/'],
      ['docker', '/deploy/docker'],
      ['npm', '/'],
    ]) {
      assert.match(dependabot, new RegExp(`- package-ecosystem: ${ecosystem}\\n {4}directory: ${directory}\\n`));
    }
  });
});

describe('the panel', () => {
  it('offers every shared action', () => {
    for (const action of ACTIONS)
      assert.ok((PANEL_ACTIONS as readonly string[]).includes(action), `the panel lacks ${action}`);
  });

  it('calls each of its actions from somewhere in its views, or receives it over the live connection', () => {
    const source = fs
      .readdirSync('panel/src', { recursive: true })
      .filter((name) => String(name).endsWith('.ts') && !String(name).endsWith('api.ts'))
      .map((name) => read(path.join('panel/src', String(name))))
      .join('\n');
    for (const action of PANEL_ACTIONS) {
      const called = source.includes(`api['${action}'](`) || source.includes(`api.${action}(`);
      // A live action is handled where the live messages are: a case for its message type.
      const live = LIVE_ACTIONS[action];
      const received = live !== undefined && source.includes(`case '${live}':`);
      assert.ok(called || received, `the panel neither calls api['${action}'] nor receives it live`);
    }
  });
});
