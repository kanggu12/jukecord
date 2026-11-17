/**
 * The release's programs (scripts/bundle.ts): what they carry is pinned and agrees with the image, every target is
 * built and run in the workflows and named in the install guide, and the Linux and macOS launcher finds its files, its
 * settings and its data folder as deploy/bundle/jukecord says. The programs themselves are made and run on each system
 * by bundles.yml (scripts/bundle-smoke.ts).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { archiveName, folderName, readPins, TARGETS, YTDLP_PROGRAM } from '../../scripts/bundle.ts';
import { VERSION } from '../../src/version.ts';

const read = (file: string) => fs.readFileSync(file, 'utf8');
const dockerfile = read('deploy/docker/Dockerfile');
const arg = (name: string) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1];

describe('the programs', () => {
  it('are one for each system and processor, named for the version, the system and the processor in lower case', () => {
    assert.deepEqual(
      [...TARGETS],
      ['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64', 'windows-x64', 'windows-arm64'],
    );
    for (const target of TARGETS) {
      assert.match(
        archiveName(target),
        /^jukecord-\d+\.\d+\.\d+(-[0-9a-z.]+)?-(linux|macos|windows)-(x64|arm64)\.(tar\.gz|zip)$/,
      );
      assert.equal(archiveName(target), `${folderName(target)}${target.startsWith('windows-') ? '.zip' : '.tar.gz'}`);
      assert.ok(archiveName(target).startsWith(`jukecord-${VERSION}-`));
    }
  });

  it('carry the Node.js and yt-dlp releases pins.json names, the image Node.js line and the image yt-dlp', () => {
    const pins = readPins();
    // The image's base is node:26; the programs carry a release of the same line.
    const line = /^FROM node:(\d+)-/m.exec(dockerfile)?.[1];
    assert.equal(pins.node.version.split('.')[0], line);
    assert.equal(pins['yt-dlp'].version, arg('YTDLP_VERSION'));
    for (const target of TARGETS) {
      for (const pin of [pins.node.files[target], pins['yt-dlp'].files[target]]) {
        assert.ok(pin, `pins.json has nothing for ${target}`);
        assert.match(pin.sha256, /^[0-9a-f]{64}$/);
      }
      // Node.js's file for the target, at the pinned release: node-v26.13.0-darwin-arm64.tar.xz, say.
      const system = { linux: 'linux', macos: 'darwin', windows: 'win' }[
        target.split('-')[0] as 'linux' | 'macos' | 'windows'
      ];
      const extension = target.startsWith('windows-') ? 'zip' : 'tar.xz';
      assert.equal(
        pins.node.files[target].name,
        `node-v${pins.node.version}-${system}-${target.split('-')[1]}.${extension}`,
      );
    }
    // The same yt-dlp files as the image's, by the same sums.
    assert.equal(pins['yt-dlp'].files['linux-x64'].sha256, arg('YTDLP_SHA256_AMD64'));
    assert.equal(pins['yt-dlp'].files['linux-arm64'].sha256, arg('YTDLP_SHA256_ARM64'));
    assert.equal(YTDLP_PROGRAM['linux-x64'], 'yt-dlp_linux');
  });

  it("build FFmpeg with the image's configure line, from release sources checked by their SHA-256", () => {
    const script = read('deploy/bundle/ffmpeg.sh');
    // Every flag of the image's configure line but its prefix and its TLS (each system has its own).
    const configure = /\.\/configure --prefix=\/opt\/ffmpeg \\\n([\s\S]*?);/.exec(dockerfile)?.[1] ?? '';
    const flags = configure.match(/--[\w-]+(=\S+)?/g) ?? [];
    assert.ok(flags.length > 10, 'the image has no configure line to compare with');
    for (const flag of flags.filter((each) => each !== '--enable-openssl')) {
      assert.ok(script.includes(flag), `deploy/bundle/ffmpeg.sh does not configure FFmpeg with ${flag}`);
    }
    for (const tls of ['--enable-openssl', '--enable-schannel', '--enable-securetransport'])
      assert.ok(script.includes(tls));
    for (const library of ['OPENSSL', 'ZLIB', 'OPUS', 'LAME']) {
      assert.match(script, new RegExp(`^${library}_VERSION=[\\d.]+$`, 'm'));
      assert.match(script, new RegExp(`^${library}_SHA256=[0-9a-f]{64}$`, 'm'));
    }
    // FFmpeg's release is the image's, read from its Dockerfile.
    assert.match(read('deploy/bundle/build-ffmpeg.sh'), /sed -n 's\/\^ARG FFMPEG_VERSION=\/\/p' "\$dockerfile"/);
  });

  it('build FFmpeg on bases pinned by digest, in stages the build-cache advice finds', () => {
    const recipe = read('deploy/bundle/Dockerfile');
    const stages = [...recipe.matchAll(/^FROM (\S+) AS ([\w-]+)$/gm)];
    assert.deepEqual(
      stages.map((match) => match[2]),
      ['jukecord-ffmpeg-linux', 'jukecord-ffmpeg-windows', 'linux', 'windows'],
    );
    for (const stage of stages.slice(0, 2)) assert.match(stage[1] ?? '', /^[a-z]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    // Each step of the building stages says jukecord first.
    for (const run of recipe.matchAll(/^RUN (.*)$/gm)) assert.match(run[1] ?? '', /^(set -eu; \\|echo "jukecord: )/);
    assert.match(recipe, /^ARG LLVM_MINGW_SHA256=[0-9a-f]{64}$/m);
    assert.match(read('.github/dependabot.yml'), /- package-ecosystem: docker\n {4}directory: \/deploy\/bundle\n/);
  });

  it('are built, put together and run for every target in the workflows, and attached to the release', () => {
    const bundles = read('.github/workflows/bundles.yml');
    for (const job of ['ffmpeg', 'run']) {
      const section =
        new RegExp(`^ {2}${job}:\\n([\\s\\S]*?)(?=^ {2}\\w+:\\n|(?![\\s\\S]))`, 'm').exec(bundles)?.[1] ?? '';
      const targets = [...section.matchAll(/^ {10}- target: ([\w-]+)$/gm)].map((match) => match[1]);
      assert.deepEqual(targets.sort(), [...TARGETS].sort(), `the ${job} job of bundles.yml has another set of targets`);
    }
    assert.match(bundles, /node scripts\/bundle\.ts --ffmpeg ffmpeg --out dist/);
    assert.match(bundles, /node scripts\/bundle-smoke\.ts dist\/jukecord-\*-\$\{\{ matrix\.target \}\}\.\*/);
    const release = read('.github/workflows/release.yml');
    assert.match(release, /uses: \.\/\.github\/workflows\/bundles\.yml/);
    assert.match(release, /subject-checksums: /);
    for (const pattern of ['-*.tar.gz', '-*.zip', '-helm-chart.tgz', '-checksums.txt']) {
      assert.ok(
        release.includes(`dist/jukecord-\${{ steps.v.outputs.version }}${pattern}`),
        `release.yml attaches no ${pattern}`,
      );
    }
  });

  it('are each named, with what to type, in the install guide', () => {
    const guide = read('docs/INSTALL.md');
    for (const target of TARGETS)
      assert.ok(guide.includes(archiveName(target)), `docs/INSTALL.md does not name ${archiveName(target)}`);
  });

  it("carry a settings example with the settings of Compose's but the ones only Compose reads, and how to run there", () => {
    const config = read('src/config.ts');
    const names = (file: string): string[] => [...(read(file).match(/^JUKECORD_[A-Z_]+(?==)/gm) ?? [])];
    const bundle = names('deploy/bundle/env.example');
    for (const name of bundle)
      assert.ok(config.includes(`'${name}'`), `${name} in deploy/bundle/env.example is not a setting`);
    const composeOnly = ['JUKECORD_BIND', 'JUKECORD_IMAGE', 'JUKECORD_PUBLISHED_PORT'];
    const expected = names('.env.example').filter((name) => !composeOnly.includes(name));
    assert.deepEqual(
      bundle.filter((name) => !['JUKECORD_HOST', 'JUKECORD_DATA_DIR'].includes(name)),
      expected,
      'deploy/bundle/env.example and .env.example list different settings',
    );
    for (const name of composeOnly) assert.ok(!bundle.includes(name), `${name} is read by Compose only`);
    const windows = read('deploy/bundle/jukecord.cmd');
    assert.match(windows, /set "here=%~dp0"/);
    assert.match(windows, /call :default JUKECORD_DATA_DIR "%LOCALAPPDATA%\\jukecord"/);
    assert.match(windows, /@YTDLP@/);
  });
});

describe('the launcher for Linux and macOS', () => {
  // A program's folder with stand-ins for jukecord: Node.js is this test's own, and the server and the command
  // print what they were started with.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-launcher-')));
  const dir = path.join(root, folderName('linux-x64'));
  fs.mkdirSync(path.join(dir, 'lib', 'node', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib', 'app', 'src', 'cli'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(dir, 'lib', 'node', 'bin', 'node'));
  const said = (kind: string) =>
    `const e = process.env; const args = process.argv.slice(2);
     if (args[0] === 'link') console.log('http://localhost:8795/auth/link/abc');
     else console.log(JSON.stringify({ kind: '${kind}', args, data: e.JUKECORD_DATA_DIR, ffmpeg: e.JUKECORD_FFMPEG,
       ytdlp: e.JUKECORD_YTDLP, port: e.JUKECORD_PORT, mode: e.NODE_ENV }));`;
  fs.writeFileSync(path.join(dir, 'lib', 'app', 'src', 'cli', 'main.js'), said('command'));
  fs.writeFileSync(path.join(dir, 'lib', 'app', 'src', 'main.js'), said('server'));
  const launcher = path.join(dir, 'jukecord');
  fs.writeFileSync(launcher, read('deploy/bundle/jukecord').replaceAll('@YTDLP@', YTDLP_PROGRAM['linux-x64']));
  fs.chmodSync(launcher, 0o755);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  // The launcher run with only these in its environment, as from a login shell with nothing of jukecord's set.
  function run(args: readonly string[], env: Record<string, string> = {}, file = launcher) {
    const result = spawnSync(file, args, {
      env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  }
  const json = (text: string) => JSON.parse(text.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
  const settings = path.join(dir, '.env');

  it("runs the command with its words, the tools beside it and the system's data folder", {
    skip: process.platform !== 'linux',
  }, () => {
    assert.deepEqual(json(run(['np', '--json'])), {
      kind: 'command',
      args: ['np', '--json'],
      data: path.join(home, '.local', 'share', 'jukecord'),
      ffmpeg: path.join(dir, 'lib', 'ffmpeg', 'ffmpeg'),
      ytdlp: path.join(dir, 'lib', 'yt-dlp', 'yt-dlp_linux'),
      mode: 'production',
    });
    assert.equal(
      json(run(['status'], { XDG_DATA_HOME: path.join(root, 'xdg') })).data,
      path.join(root, 'xdg', 'jukecord'),
    );
  });

  it('starts the server with start', () => {
    assert.deepEqual(json(run(['start'])).kind, 'server');
  });

  it('takes the settings in .env, with the environment over them, and an empty one as unset', {
    skip: process.platform !== 'linux',
  }, () => {
    try {
      fs.writeFileSync(settings, 'JUKECORD_DATA_DIR=/srv/from-the-file\nJUKECORD_PORT=9999\n');
      assert.deepEqual([json(run(['status'])).data, json(run(['status'])).port], ['/srv/from-the-file', '9999']);
      assert.equal(
        json(run(['status'], { JUKECORD_DATA_DIR: '/srv/from-the-environment' })).data,
        '/srv/from-the-environment',
      );
      fs.writeFileSync(settings, '# a comment\nJUKECORD_DATA_DIR=\n');
      assert.equal(json(run(['status'])).data, path.join(home, '.local', 'share', 'jukecord'));
    } finally {
      fs.rmSync(settings, { force: true });
    }
  });

  it('finds its folder through a symbolic link to it', () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(launcher, path.join(bin, 'jukecord'));
    assert.equal(
      json(run(['status'], {}, path.join(bin, 'jukecord'))).ffmpeg,
      path.join(dir, 'lib', 'ffmpeg', 'ffmpeg'),
    );
  });

  it('prints the login link alone where no one looks at a terminal, and says start and open in its help', () => {
    assert.equal(run(['open']), 'http://localhost:8795/auth/link/abc\n');
    const help = run([]);
    assert.match(help, /^ {2}start {18}run jukecord here, until Ctrl\+C$/m);
    assert.match(help, /^ {2}open /m);
    assert.deepEqual(json(help).args, ['--help']);
  });
});
