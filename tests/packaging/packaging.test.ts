/**
 * What ships around the code: one version everywhere, the changelog, the API document, the image's pins, the
 * Compose file, the chart, the workflows, the front door and the settings examples. The chart is linted, rendered and
 * validated with helm and kubeconform when they are installed (CI installs both).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    // The image Artifact Hub scans is this version's.
    assert.match(chart, new RegExp(`^ {6}image: ghcr\\.io/kanggu12/jukecord:${VERSION.replace(/\./g, '\\.')}$`, 'm'));
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
    // The base stage and the two stages made on the build machine (for its own processor) name the same image.
    const bases = [...dockerfile.matchAll(/^FROM (?:--platform=\$BUILDPLATFORM )?(node:\S+) AS ([\w-]+)$/gm)];
    assert.deepEqual(
      bases.map((match) => match[2]),
      ['base', 'jukecord-panel', 'jukecord-source'],
    );
    assert.match(bases[0]?.[1] ?? '', /^node:26-[a-z-]+@sha256:[0-9a-f]{64}$/);
    for (const stage of bases.slice(1))
      assert.equal(stage[1], bases[0]?.[1], `the ${stage[2]} stage builds on another base`);
    // Every other stage starts from the base stage, so one line sets the base for all of them.
    for (const match of dockerfile.matchAll(/^FROM (?!node:|--platform)(\S+) AS [\w-]+$/gm))
      assert.equal(match[1], 'base');
    // Every stage with steps of its own has jukecord in its name, which the build-cache advice filters on.
    for (const match of dockerfile.matchAll(/^FROM .* AS ([\w-]+)$/gm)) {
      if (match[1] !== 'base') assert.match(match[1] ?? '', /^jukecord(-[a-z]+)?$/);
    }
    assert.match(dockerfile, /^ARG YTDLP_VERSION=\d{4}\.\d{2}\.\d{2}$/m);
    assert.match(dockerfile, /^ARG YTDLP_SHA256_AMD64=[0-9a-f]{64}$/m);
    assert.match(dockerfile, /^ARG YTDLP_SHA256_ARM64=[0-9a-f]{64}$/m);
    assert.match(dockerfile, /sha256sum -c -/);
    assert.doesNotMatch(dockerfile, /:latest\b/);
  });

  it('runs as a fixed non-root user with a health check, and carries the panel and the command', () => {
    assert.match(dockerfile, /^USER 10001:10001$/m);
    assert.match(dockerfile, /^HEALTHCHECK --interval=60s /m);
    assert.match(dockerfile, /COPY --from=jukecord-panel (--chmod=\S+ )?\/app\/panel\/dist \.\/panel\/dist/);
    assert.match(dockerfile, /\/usr\/local\/bin\/jukecord/);
  });

  it('carries its source as JavaScript, and starts nothing that would have its types taken out', () => {
    // The stage that takes the types out has the script and the source, and nothing else to wait for.
    const start = dockerfile.indexOf(' AS jukecord-source\n');
    const stage = dockerfile.slice(start, dockerfile.indexOf('\nFROM ', start));
    assert.deepEqual(stage.match(/^COPY .+$/gm), ['COPY scripts/strip-types.ts ./scripts/', 'COPY src ./src']);
    assert.match(stage, /node --disable-warning=ExperimentalWarning scripts\/strip-types\.ts src js$/m);
    // What runs gets that stage's output where the source is in a checkout, and the checkout's .ts files stay out.
    const runtime = dockerfile.slice(dockerfile.indexOf(' AS jukecord\n'));
    assert.match(runtime, /^COPY --from=jukecord-source --chmod=u=rwX,go=rX \/app\/js \.\/src$/m);
    assert.doesNotMatch(runtime, /^COPY (?!--from=).*\bsrc\b/m);
    // The server and the jukecord command are the .js files; no instruction names a .ts one.
    assert.match(runtime, /^CMD \["node", "--disable-warning=ExperimentalWarning", "src\/main\.js"\]$/m);
    assert.match(runtime, /exec node --disable-warning=ExperimentalWarning \/app\/src\/cli\/main\.js "\$@"/);
    const instructions = runtime
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    assert.doesNotMatch(instructions, /\.ts\b/);
    assert.ok(fs.existsSync('src/main.ts') && fs.existsSync('src/cli/main.ts'));
  });

  it('copies its own files readable and not executable, and keeps no npm and no setuid program', () => {
    // The symbolic mode needs a newer Dockerfile frontend than the octal one; X is execute for folders only.
    assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\n/);
    assert.doesNotMatch(dockerfile, /--chmod=0?7/);
    assert.equal(dockerfile.match(/^COPY (--from=[\w-]+ )?--chmod=u=rwX,go=rX /gm)?.length, 3);
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
      ['jukecord-ytdlp', 'YTDLP_VERSION'],
      ['jukecord-ffmpeg', 'FFMPEG_VERSION'],
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

  it("copies into the panel's stage every file from outside panel/ that the panel imports", () => {
    // The panel's sources, then every file their relative imports reach, and those files' own imports in turn.
    // Type-only imports are left out: esbuild drops them without opening the file.
    const imports =
      /^\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm;
    const pending = fs
      .readdirSync('panel/src', { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => path.join('panel/src', name));
    const seen = new Set<string>();
    const outside = new Set<string>();
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of read(file).matchAll(imports)) {
        const target = path.join(path.dirname(file), match[1] ?? match[2] ?? '');
        if (!target.startsWith(`panel${path.sep}`)) outside.add(target);
        if (fs.existsSync(target)) pending.push(target);
      }
    }
    // What the stage copies from the build context to the same place under its working folder, which is where a
    // relative import from panel/ looks for it.
    const start = dockerfile.indexOf(' AS jukecord-panel\n');
    const stage = dockerfile.slice(start, dockerfile.indexOf('\nFROM ', start));
    const copied: string[] = [];
    for (const match of stage.matchAll(/^COPY ((?:--\S+ )*)(.+)$/gm)) {
      if ((match[1] ?? '').includes('--from=')) continue;
      const parts = (match[2] ?? '').trim().split(/\s+/);
      const destination = parts.pop() ?? '';
      for (const source of parts) {
        // Several sources, or a destination ending in /, put each source into that folder under its own name.
        const into =
          parts.length > 1 || destination.endsWith('/') ? path.join(destination, path.basename(source)) : destination;
        if (path.normalize(into) === path.normalize(source)) copied.push(path.normalize(source));
      }
    }
    for (const file of outside) {
      assert.ok(
        copied.some((source) => file === source || file.startsWith(`${source}${path.sep}`)),
        `the panel imports ${file}, which the Dockerfile's panel stage does not copy (COPY ${file} ./${path.dirname(file)}/)`,
      );
    }
  });

  it('names jukecord first in each step of the stages that only build, which the build-cache advice filters on', () => {
    for (const stage of ['jukecord-ytdlp', 'jukecord-ffmpeg', 'jukecord-deps', 'jukecord-panel', 'jukecord-source']) {
      const start = dockerfile.indexOf(` AS ${stage}\n`);
      // The stage's instructions, each with its continuation lines joined and its comment lines left out.
      const instructions = dockerfile
        .slice(start, dockerfile.indexOf('\nFROM ', start))
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n')
        .replace(/\\\n/g, ' ')
        .split('\n');
      for (const run of instructions.filter((line) => line.startsWith('RUN '))) {
        assert.match(run, /^RUN (?:set -eu; +)?echo "jukecord: /, `${stage}: ${run.slice(0, 80)}`);
      }
    }
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
    // The host's time zone, which the front door sets: the statistics' "today" and the backups' time of day.
    assert.match(compose, /^ {6}TZ: "\$\{TZ:-UTC\}"$/m);
    assert.match(read('jukecord'), /^export TZ$/m);
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

describe('the front door with jukecord not running', () => {
  it('says a mistyped command is not one, and a real one that jukecord is not running', () => {
    // A Docker that answers but runs nothing (no container is up), so nothing here reaches a real Docker.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-docker-'));
    try {
      fs.writeFileSync(
        path.join(bin, 'docker'),
        '#!/bin/sh\ncase "$1" in info) echo 27.0.0 ;; compose) [ "$2" = version ] && echo v2.30.0 ;; esac\nexit 0\n',
        { mode: 0o755 },
      );
      const front = (word: string) =>
        spawnSync('bash', ['jukecord', word], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        });
      const mistyped = front('foo');
      assert.equal(mistyped.status, 2);
      assert.equal(mistyped.stderr, 'jukecord: there is no command "foo" (./jukecord help)\n');
      // A command of the jukecord command's own (from the source beside the front door), with nothing running.
      const real = front('np');
      assert.equal(real.status, 1);
      assert.equal(real.stderr, 'jukecord: jukecord is not running here (./jukecord up)\n');
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('the front door with jukecord running', () => {
  it("leaves the words it does not know to the running jukecord's own command, its help for a command too", () => {
    // A Docker whose jukecord runs: the command inside prints what it was asked (an image newer than this checkout
    // knows commands the checkout does not).
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-docker-'));
    try {
      fs.writeFileSync(
        path.join(bin, 'docker'),
        [
          '#!/bin/sh',
          'case "$1" in',
          '  info) echo 27.0.0 ;;',
          '  compose)',
          '    case "$2" in',
          '      version) echo v2.30.0 ;;',
          '      ps) echo 0123456789ab ;;',
          // exec [-T|-it] -e TZ=... jukecord jukecord ARGS: what follows the service and the command, and what came on
          // its standard input when a word of it is "-".
          '      exec) shift 7; echo "inside: $*"; case " $* " in *" - "*) cat ;; esac ;;',
          '    esac ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const front = (...words: string[]) =>
        spawnSync('bash', ['jukecord', ...words], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        });
      const newer = front('karaoke', 'on');
      assert.equal(newer.status, 0, newer.stderr);
      assert.equal(newer.stdout, 'inside: karaoke on\n');
      // help with a command: that command's help, from the command that runs it (the whole list was printed).
      const help = front('help', 'add');
      assert.equal(help.status, 0, help.stderr);
      assert.equal(help.stdout, 'inside: help add\n');
      // A playlist imported from a file where the command was typed: the command inside gets its text on its standard
      // input, the options and their values left as they are.
      const typed = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-typed-'));
      try {
        fs.writeFileSync(path.join(typed, 'friday.m3u'), '#EXTM3U\nhttps://example.com/a\n');
        const fromHere = (...words: string[]) =>
          spawnSync('bash', [path.resolve('jukecord'), ...words], {
            encoding: 'utf8',
            cwd: typed,
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
          });
        const imported = fromHere('playlist', 'import', '--guild', '1234', 'Friday night', 'friday.m3u', '--json');
        assert.equal(imported.status, 0, imported.stderr);
        assert.equal(
          imported.stdout,
          'inside: playlist import --guild 1234 Friday night - --json\n#EXTM3U\nhttps://example.com/a\n',
        );
        // The options before the command, as the help shows them ("jukecord [--guild ID] <command>"): the file is
        // handed over all the same (its name reached the command, which could not open it inside the container).
        const first = fromHere('--guild', '1234', '--json', 'playlist', 'import', 'Friday night', 'friday.m3u');
        assert.equal(first.status, 0, first.stderr);
        assert.equal(
          first.stdout,
          'inside: --guild 1234 --json playlist import Friday night -\n#EXTM3U\nhttps://example.com/a\n',
        );
        // A file that is not there is a typing mistake here; nothing reaches the command.
        const missing = fromHere('playlist', 'import', 'Friday', 'gone.m3u');
        assert.equal(missing.status, 2);
        assert.match(missing.stderr, /gone\.m3u is not there/);
        assert.equal(missing.stdout, '');
        // The standard input given already, and every other playlist command: passed on as they are.
        assert.equal(fromHere('playlist', 'export', 'Friday').stdout, 'inside: playlist export Friday\n');
      } finally {
        fs.rmSync(typed, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("reads the options that take a value as the jukecord command does, to find an import's file", () => {
    // The front door's list and the command's own (src/cli/main.ts VALUED) must be the same words.
    const door = /valued=' ([^']*) '/.exec(read('jukecord'))?.[1]?.split(' ') ?? [];
    const own = /const VALUED = new Set\(\[([^\]]*)\]\)/.exec(read('src/cli/main.ts'))?.[1] ?? '';
    const words = [...own.matchAll(/'([a-z-]+)'/g)].map((match) => `--${match[1]}`);
    assert.ok(words.length > 5);
    assert.deepEqual([...door].sort(), [...words].sort());
  });
});

// The front door's check of a backup before a restore, as bash hands it to node inside the container: the
// `check='...'` assignment of ./jukecord, evaluated by bash itself (its quoting included).
function restoreCheck(): string {
  const text = read('jukecord');
  const start = text.indexOf("    check='");
  const end = text.indexOf("}'\n", start) + 2;
  assert.ok(start > 0 && end > start, 'the restore check is not in ./jukecord');
  return execFileSync('bash', ['-c', `${text.slice(start, end)}\nprintf '%s' "$check"`], { encoding: 'utf8' });
}

describe('the front door checks a backup before a restore', () => {
  // The check, run as the container runs it: an ES module, the backup on stdin, the data folder as the argument.
  const check = (input: Buffer, folder: string) =>
    spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', restoreCheck(), folder],
      { input, encoding: 'utf8' },
    );

  it('runs the check in the image the way this test runs it', () => {
    assert.match(read('jukecord'), /--input-type=module -e "\$check" \/data <"\$file"/);
  });

  it('reads a backup whole into the data folder (not the small /tmp), passes a whole one and leaves nothing', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-restore-'));
    try {
      // A whole backup with jukecord's tables, made the way the backup command makes one (VACUUM INTO).
      const live = new DatabaseSync(path.join(folder, 'live.db'));
      live.exec('CREATE TABLE tracks (id INTEGER PRIMARY KEY, title TEXT)');
      const insert = live.prepare('INSERT INTO tracks (title) VALUES (?)');
      // In one transaction: one write to the disk instead of one per row.
      live.exec('BEGIN');
      for (let index = 0; index < 2000; index += 1) insert.run(`Track ${index} with a title long enough to fill pages`);
      live.exec('COMMIT');
      live.prepare('VACUUM INTO ?').run(path.join(folder, 'backup.db'));
      live.close();
      const backup = fs.readFileSync(path.join(folder, 'backup.db'));
      fs.rmSync(path.join(folder, 'live.db'));
      fs.rmSync(path.join(folder, 'backup.db'));
      const target = path.join(folder, 'data');
      fs.mkdirSync(target);
      const whole = check(backup, target);
      assert.equal(whole.status, 0, whole.stderr);
      // The copy it read went into the data folder and is gone again.
      assert.deepEqual(fs.readdirSync(target), []);
      // A backup cut short (a copy that stopped half way) is refused, with SQLite's own words on the marked line.
      const cut = check(backup.subarray(0, 20_000), target);
      assert.equal(cut.status, 2);
      assert.match(cut.stderr, /^restore-check: .*(malformed|not a database)/m);
      assert.deepEqual(fs.readdirSync(target), []);
      // A copy that cannot be written (no room, no folder) says why on a line of its own, not as a crash: a crash's
      // last line is Node's version, which the front door showed as the reason before.
      const nowhere = check(backup, path.join(folder, 'missing'));
      assert.equal(nowhere.status, 2);
      assert.match(nowhere.stderr, /^restore-copy: ENOENT/m);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the Helm chart', () => {
  it('has a schema that refuses unknown values', () => {
    const schema = JSON.parse(read('deploy/helm/jukecord/values.schema.json')) as { additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false);
  });

  it('works out the panel address in one place, for the pod and for the notes after an install', () => {
    for (const file of ['NOTES.txt', 'deployment.yaml']) {
      assert.match(read(`deploy/helm/jukecord/templates/${file}`), /include "jukecord\.publicUrl"/, file);
      assert.doesNotMatch(
        read(`deploy/helm/jukecord/templates/${file}`),
        /ingress\.host \| default|printf "%s:\/\/%s"/,
        file,
      );
    }
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
    // Probes that wait out a busy moment, and memory enough for Node's heap and the downloads beside it.
    assert.match(rendered, /startupProbe:\n(?: {12}.*\n)*? {12}timeoutSeconds: 3\n/);
    assert.match(rendered, /readinessProbe:\n(?: {12}.*\n)*? {12}timeoutSeconds: 5\n {12}failureThreshold: 6\n/);
    assert.match(rendered, /limits:\n {14}memory: 1536Mi\n/);
    // The secrets reach jukecord as files, not as variables that yt-dlp and ffmpeg would inherit; an existing
    // Secret must hold the token, and its OAuth secret is read only with a client ID to go with it.
    assert.match(rendered, /name: JUKECORD_DISCORD_TOKEN_FILE\n/);
    assert.doesNotMatch(rendered, /secretKeyRef/);
    // helm test's pod runs where jukecord's may: the same registry login, node selector and tolerations.
    const placed = execFileSync(
      'helm',
      [
        'template',
        't',
        'deploy/helm/jukecord',
        '--set',
        'imagePullSecrets[0].name=regcred',
        '--set',
        'nodeSelector.pool=music',
        '--set',
        'tolerations[0].operator=Exists',
      ],
      { encoding: 'utf8' },
    );
    // With networkPolicy.ingressFrom, only those peers (and helm test's pod) may reach the panel's port.
    const policy = (text: string) => text.slice(text.indexOf('\nkind: NetworkPolicy\n'), text.indexOf('egress:'));
    assert.doesNotMatch(policy(rendered), /from:/);
    const fenced = execFileSync(
      'helm',
      ['template', 't', 'deploy/helm/jukecord', '--set', 'networkPolicy.ingressFrom[0].ipBlock.cidr=192.0.2.0/24'],
      { encoding: 'utf8' },
    );
    assert.match(policy(fenced), /from:\n\s+- ipBlock:\n\s+cidr: 192\.0\.2\.0\/24\n[\s\S]*component: test/);
    const testPod = placed.slice(placed.indexOf('\nkind: Pod\n'));
    for (const key of ['imagePullSecrets:', 'nodeSelector:', 'tolerations:']) assert.ok(testPod.includes(key), key);
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
    // What cannot work is refused before anything is installed, each with a message that says what to change.
    const refusal = (...values: string[]) => {
      try {
        execFileSync('helm', ['template', 't', 'deploy/helm/jukecord', ...values], { stdio: 'pipe' });
      } catch (error) {
        return String((error as { stderr?: Buffer }).stderr ?? error);
      }
      return 'rendered';
    };
    assert.match(refusal('--set', 'env.JUKECORD_DISCORD_TOKEN=x'), /goes in discord\.token/);
    assert.match(
      refusal('--set', 'extraEnv[0].name=JUKECORD_DISCORD_TOKEN_FILE', '--set', 'extraEnv[0].value=/x'),
      /set by the chart/,
    );
    assert.match(refusal('--set', 'discord.existingSecret=s', '--set', 'discord.token=x'), /would be ignored/);
    // An OAuth secret without the application's ID would stop jukecord at start.
    assert.match(refusal('--set', 'discord.clientSecret=s'), /without discord\.clientId/);
    assert.match(
      refusal(
        '--set-string',
        'env.JUKECORD_LOG_LEVEL=debug',
        '--set',
        'extraEnv[0].name=JUKECORD_LOG_LEVEL',
        '--set',
        'extraEnv[0].value=info',
      ),
      /in both env and extraEnv/,
    );
    // The schema: a value and a source for one variable, a peer naming nothing, a host with a scheme, a label with a
    // space, a range without its length, a size Kubernetes would not take.
    for (const values of [
      [
        '--set',
        'extraEnv[0].name=TZ',
        '--set',
        'extraEnv[0].value=x',
        '--set',
        'extraEnv[0].valueFrom.configMapKeyRef.name=c',
      ],
      ['--set', 'networkPolicy.ingressFrom[0].x=1'],
      ['--set', 'ingress.host=https://music.example.org'],
      ['--set', 'podLabels.team=two words'],
      ['--set', 'networkPolicy.privateRanges[0]=10.0.0.0'],
      ['--set', 'persistence.size=5K'],
    ]) {
      assert.match(refusal(...values), /don't meet the specifications of the schema/, values.join(' '));
    }
    // And what Kubernetes takes is taken: decimal and binary sizes, an IPv6 range, a wildcard host, the values a
    // parent chart gives every chart it depends on.
    for (const values of [
      ['--set', 'persistence.size=1Pi'],
      ['--set', 'persistence.size=500M'],
      ['--set', 'networkPolicy.privateRanges[0]=fd00::/8'],
      ['--set', 'ingress.enabled=true', '--set', 'ingress.host=*.example.org'],
      ['--set', 'global.imageRegistry=registry.example.org'],
    ]) {
      assert.equal(refusal(...values), 'rendered', values.join(' '));
    }
    // An upgrade with --reuse-values from a chart before podLabels keeps the old values, which have none.
    const old = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-old-values-')), 'values.yaml');
    fs.writeFileSync(old, read('deploy/helm/jukecord/values.yaml').replace(/^podLabels: \{\}\n/m, ''));
    assert.doesNotMatch(read(old), /^podLabels:/m);
    assert.equal(refusal('-f', old, '--set', 'podLabels=null'), 'rendered');
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
      for (const match of text.matchAll(/uses: ([^\s]+)(?: # (v\d+(?:\.\d+)*))?/g)) {
        const action = match[1] ?? '';
        if (action.startsWith('./')) assert.ok(fs.existsSync(action), `${file} uses ${action}, which is not there`);
        // By commit, with the release it is beside it (Dependabot moves both), or by a release's tag.
        else if (/@[0-9a-f]{40}$/.test(action)) assert.ok(match[2], `${file} pins ${action} without its version`);
        else assert.match(action, /@v\d+(\.\d+)*$/, `${file} uses ${action} without a release`);
      }
      for (const match of text.matchAll(/(?:^|\s)((?:deploy|tests|scripts)\/[\w./-]+\.(?:sh|ts|mjs))/gm)) {
        assert.ok(fs.existsSync(match[1] ?? ''), `${file} runs ${match[1]}, which is not there`);
      }
    }
  });

  it('pins by commit the outside actions that run with a token that may write, and checks before it publishes', () => {
    // Every action that is neither GitHub's own (actions/…) nor in this repository: by commit, the release in a comment.
    for (const file of workflows) {
      for (const match of read(file).matchAll(/uses: ((?!actions\/|\.\/)[\w.-]+\/[\w.-]+@\S+)/g)) {
        assert.match(match[1] ?? '', /@[0-9a-f]{40}$/, `${file} uses ${match[1]} by a tag that can move`);
      }
    }
    const release = read('.github/workflows/release.yml');
    assert.match(release, /helm lint --strict /);
    assert.match(release, /generate_release_notes: false/);
    assert.match(read('.github/workflows/chart-e2e.yml'), /^ {2}pull_request:$/m);
    assert.match(
      read('.github/workflows/ci.yml'),
      /docker run -d --name smoke --read-only --cap-drop ALL --security-opt no-new-privileges /,
    );
  });

  it('has its shell scripts executable', () => {
    for (const file of ['jukecord', 'deploy/kind/check.sh', 'tests/ui/run.sh', '.github/badges.sh']) {
      assert.ok(fs.statSync(file).mode & 0o100, `${file} is not executable`);
    }
  });

  // The pins of what ships (the image and the packages) and of the actions; the tools CI runs with (helm, kind,
  // kubeconform) are pinned by version and checksum in the workflows and moved by hand (CONTRIBUTING.md).
  it('watches the pins of what ships for a newer release: yt-dlp and FFmpeg weekly, the rest through Dependabot', () => {
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
