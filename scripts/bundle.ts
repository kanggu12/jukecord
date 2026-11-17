/**
 * The release's programs: jukecord for one system and processor as one folder, packed, with its own Node.js, FFmpeg
 * and yt-dlp beside the server, the command and the panel, so a machine needs nothing installed to run it.
 *
 *   node scripts/bundle.ts --ffmpeg <folder> [--out <folder>] [<target> ...]
 *
 * A target is linux-x64, linux-arm64, macos-arm64, macos-x64, windows-x64 or windows-arm64; with none named, all six.
 * --ffmpeg names the folder that holds each target's FFmpeg in a folder of the target's name, as
 * deploy/bundle/build-ffmpeg.sh makes them. Each program lands in --out (dist) as jukecord-<version>-<target>.tar.gz,
 * or .zip for Windows, and unpacks into a folder of the same name. Node.js and yt-dlp come from their own releases at
 * the versions deploy/bundle/pins.json names, checked against its SHA-256, and stay in <out>/.cache for the next run.
 * The npm packages are installed for the target's system and processor (Discord's voice encryption is a native
 * module), so every target is made on one Linux machine, with npm, tar, unzip, zip and dpkg-deb.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { VERSION } from '../src/version.ts';

/** The systems and processors there is a program for, in the order the release lists them. */
export const TARGETS = [
  'linux-x64',
  'linux-arm64',
  'macos-arm64',
  'macos-x64',
  'windows-x64',
  'windows-arm64',
] as const;
export type Target = (typeof TARGETS)[number];

/** A file of another project's release: its name there and its SHA-256. */
interface Pinned {
  readonly name: string;
  readonly sha256: string;
}

/** deploy/bundle/pins.json: the releases of Node.js and yt-dlp the programs carry, with a file for each target. */
export interface Pins {
  readonly node: { readonly version: string; readonly files: Readonly<Record<Target, Pinned>> };
  readonly 'yt-dlp': { readonly version: string; readonly files: Readonly<Record<Target, Pinned>> };
  /** Debian's libatomic1 for the Linux targets: its package version, its source, and each package's address. */
  readonly libatomic: {
    readonly version: string;
    readonly source: string;
    readonly files: Readonly<Record<'linux-x64' | 'linux-arm64', Pinned & { readonly url: string }>>;
  };
}

export const PINS_FILE = 'deploy/bundle/pins.json';

export function readPins(): Pins {
  return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')) as Pins;
}

/** The folder a target's program unpacks into, which is also its file's name without the extension. */
export function folderName(target: Target, version: string = VERSION): string {
  return `jukecord-${version}-${target}`;
}

/** The file a target's program is packed in: a .zip for Windows, which opens one itself, a .tar.gz for the rest. */
export function archiveName(target: Target, version: string = VERSION): string {
  return `${folderName(target, version)}${target.startsWith('windows-') ? '.zip' : '.tar.gz'}`;
}

/** yt-dlp's program in its folder: each of its builds names it for its system. */
export const YTDLP_PROGRAM: Readonly<Record<Target, string>> = {
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'macos-arm64': 'yt-dlp_macos',
  'macos-x64': 'yt-dlp_macos',
  'windows-x64': 'yt-dlp.exe',
  'windows-arm64': 'yt-dlp_arm64.exe',
};

// npm's names for a target's system and processor. They pick which build of a native module is installed; for Linux
// the one for glibc, which the release's Node.js runs on, and not musl's.
const NPM_PLATFORM: Readonly<Record<Target, { os: string; cpu: string; libc?: string }>> = {
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', libc: 'glibc' },
  'macos-arm64': { os: 'darwin', cpu: 'arm64' },
  'macos-x64': { os: 'darwin', cpu: 'x64' },
  'windows-x64': { os: 'win32', cpu: 'x64' },
  'windows-arm64': { os: 'win32', cpu: 'arm64' },
};

// The system's name in the program's README.txt.
const SYSTEM: Readonly<Record<Target, string>> = {
  'linux-x64': 'Linux on x64',
  'linux-arm64': 'Linux on arm64',
  'macos-arm64': 'macOS on Apple silicon (arm64)',
  'macos-x64': 'macOS on Intel (x64)',
  'windows-x64': 'Windows on x64',
  'windows-arm64': 'Windows on arm64',
};

// Where the launcher keeps the data by default, as the program's README.txt says it.
const DATA: Readonly<Record<'linux' | 'macos' | 'windows', string>> = {
  linux: '~/.local/share/jukecord',
  macos: '~/Library/Application Support/jukecord',
  windows: '%LOCALAPPDATA%\\jukecord',
};

const isWindows = (target: Target) => target.startsWith('windows-');

/** Runs a program and stops with its own words when it fails. */
function run(program: string, args: readonly string[], options: { cwd?: string; input?: string } = {}): void {
  execFileSync(program, args, {
    cwd: options.cwd,
    input: options.input,
    stdio: [options.input ? 'pipe' : 'ignore', 'inherit', 'inherit'],
  });
}

function sha256Of(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** A release file, downloaded once into the cache and checked against its pinned SHA-256 each time it is used. */
function fetchPinned(url: string, sha256: string, cache: string, name: string): string {
  const file = path.join(cache, name);
  if (fs.existsSync(file) && sha256Of(file) === sha256) return file;
  // Downloaded beside its place and moved there once checked, so a cut download is never taken for the file.
  const part = `${file}.part`;
  run('curl', ['-fsSL', '--retry', '3', '-o', part, url]);
  const got = sha256Of(part);
  if (got !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`${url} has SHA-256 ${got}; ${PINS_FILE} says ${sha256}`);
  }
  fs.renameSync(part, file);
  return file;
}

/** Every file and folder under a folder, its own path first, in the order of their names. */
function walk(root: string): string[] {
  const found = [root];
  if (fs.lstatSync(root).isDirectory()) {
    for (const name of fs.readdirSync(root).sort()) found.push(...walk(path.join(root, name)));
  }
  return found;
}

/** Text with Windows' line endings, for the files a person opens in Notepad and for cmd, which misreads bare LF. */
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');

/**
 * What every program carries the same: the server and the command as JavaScript (the image's way: the types taken
 * out once, scripts/strip-types.ts), the built panel, package.json and the licence.
 */
function buildApp(app: string): void {
  // The panel from panel/, into panel/dist, with the development packages a checkout has after npm ci.
  run(process.execPath, ['scripts/build-panel.ts']);
  run(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    'scripts/strip-types.ts',
    'src',
    path.join(app, 'src'),
  ]);
  fs.cpSync('panel/dist', path.join(app, 'panel', 'dist'), { recursive: true });
  for (const file of ['package.json', 'LICENSE']) fs.copyFileSync(file, path.join(app, file));
}

/** The npm packages the server runs, as npm installs them on the target's system and processor. */
function installModules(target: Target, app: string, work: string): void {
  const dir = path.join(work, `npm-${target}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(file, path.join(dir, file));
  const { os, cpu, libc } = NPM_PLATFORM[target];
  // Run-time packages only and no install scripts, as the image installs them (native parts come prebuilt).
  run(
    'npm',
    [
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--os=${os}`,
      `--cpu=${cpu}`,
      ...(libc ? [`--libc=${libc}`] : []),
    ],
    { cwd: dir },
  );
  const modules = path.join(dir, 'node_modules');
  // The packages' command links (.bin): nothing runs them, and a zip would carry each as a copy of its file. And the
  // test folders some packages publish (beside their package.json): nothing loads them, and one holds a folder whose
  // name has a snowman in it, which Windows' own tar could not read on a runner.
  const unused = walk(modules).filter((entry) => {
    const name = path.basename(entry);
    if (name === '.bin') return true;
    return (
      ['test', 'tests', '__tests__'].includes(name) && fs.existsSync(path.join(path.dirname(entry), 'package.json'))
    );
  });
  for (const folder of unused) fs.rmSync(folder, { recursive: true, force: true });
  for (const file of walk(modules)) {
    const name = path.basename(file);
    // The packages' type declarations and source maps: Node.js reads neither when it runs them, and they are near
    // half of the folder.
    if (/\.d\.[cm]?ts$|\.map$/.test(name) && fs.lstatSync(file).isFile()) fs.rmSync(file);
    // A package that says which systems or processors it is for must be for this one (the native builds are).
    if (name === 'package.json' && path.basename(path.dirname(path.dirname(file))) !== 'node_modules') continue;
    if (name === 'package.json') {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; os?: string[]; cpu?: string[] };
      if ((manifest.os && !manifest.os.includes(os)) || (manifest.cpu && !manifest.cpu.includes(cpu))) {
        throw new Error(
          `${manifest.name} is for ${manifest.os ?? 'any system'} on ${manifest.cpu ?? 'any processor'}, not ${target}`,
        );
      }
    }
  }
  fs.renameSync(modules, path.join(app, 'node_modules'));
}

/** Node.js from its release: the program and its licence, which covers what it bundles. */
function addNode(target: Target, into: string, pins: Pins, cache: string): void {
  const pin = pins.node.files[target];
  const archive = fetchPinned(`https://nodejs.org/dist/v${pins.node.version}/${pin.name}`, pin.sha256, cache, pin.name);
  // The archive's one folder, node-v26.13.0-linux-x64 say.
  const top = pin.name.replace(/\.(tar\.xz|tar\.gz|zip)$/, '');
  fs.mkdirSync(into, { recursive: true });
  if (isWindows(target)) run('unzip', ['-q', '-j', archive, `${top}/node.exe`, `${top}/LICENSE`, '-d', into]);
  else run('tar', ['-xf', archive, '-C', into, '--strip-components=1', `${top}/bin/node`, `${top}/LICENSE`]);
}

/**
 * libatomic, which Node.js's Linux builds load and a bare system (Debian's slim image, a minimal server) may not
 * have: Debian's build, beside Node.js in lib/node/lib, where the launcher points the loader (LD_LIBRARY_PATH). It is
 * GPL-3.0-or-later with the GCC Runtime Library Exception: its licence, the exception and where its source is come
 * with it.
 */
function addLibatomic(
  target: 'linux-x64' | 'linux-arm64',
  into: string,
  pins: Pins,
  cache: string,
  work: string,
): void {
  const { version, source, files } = pins.libatomic;
  const pin = files[target];
  const deb = fetchPinned(pin.url, pin.sha256, cache, pin.name);
  const unpacked = path.join(work, `libatomic-${target}`);
  run('dpkg-deb', ['-x', deb, unpacked]);
  const triplet = target === 'linux-x64' ? 'x86_64-linux-gnu' : 'aarch64-linux-gnu';
  fs.mkdirSync(into, { recursive: true });
  // The library under the name Node.js asks for (in the package that name is a link to it).
  fs.copyFileSync(
    fs.realpathSync(path.join(unpacked, 'usr', 'lib', triplet, 'libatomic.so.1')),
    path.join(into, 'libatomic.so.1'),
  );
  fs.copyFileSync('deploy/bundle/licenses/GPL-3.0.txt', path.join(into, 'libatomic-COPYING3'));
  fs.copyFileSync('deploy/bundle/licenses/GCC-exception-3.1.txt', path.join(into, 'libatomic-COPYING.RUNTIME'));
  fs.writeFileSync(
    path.join(into, 'libatomic-SOURCE'),
    `libatomic.so.1 from Debian's libatomic1 ${version} (GCC ${version.split('-')[0]}), ${pin.url} (sha256 ${pin.sha256}).\n` +
      'GPL-3.0-or-later with the GCC Runtime Library Exception 3.1 (libatomic-COPYING3, libatomic-COPYING.RUNTIME).\n' +
      `Its source: ${source}\n`,
  );
}

/** yt-dlp's official build for the target, as its release has it: the program and the folder of what it runs on. */
function addYtdlp(target: Target, into: string, pins: Pins, cache: string): void {
  const { version, files } = pins['yt-dlp'];
  const pin = files[target];
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${pin.name}`;
  // Its files' names carry no version, so the cache's do.
  const archive = fetchPinned(url, pin.sha256, cache, `yt-dlp-${version}-${pin.name}`);
  fs.mkdirSync(into, { recursive: true });
  run('unzip', ['-q', archive, '-d', into]);
  if (!fs.existsSync(path.join(into, YTDLP_PROGRAM[target]))) {
    throw new Error(`${pin.name} has no ${YTDLP_PROGRAM[target]} at its top`);
  }
}

/** The texts beside the launcher: the settings' example, a short README.txt, jukecord's licence and the notices. */
function addTexts(target: Target, stage: string): void {
  const windows = isWindows(target);
  const system = target.split('-')[0] as 'linux' | 'macos' | 'windows';
  const text = (body: string) => (windows ? crlf(body) : body);
  fs.writeFileSync(path.join(stage, '.env.example'), text(fs.readFileSync('deploy/bundle/env.example', 'utf8')));
  const readme = fs
    .readFileSync('deploy/bundle/README.txt', 'utf8')
    .replaceAll('@VERSION@', VERSION)
    .replaceAll('@SYSTEM@', SYSTEM[target])
    .replaceAll('@RUN@', windows ? '.\\jukecord' : './jukecord')
    .replaceAll('@DATA@', DATA[system]);
  fs.writeFileSync(path.join(stage, 'README.txt'), text(readme));
  fs.copyFileSync('LICENSE', path.join(stage, 'LICENSE'));
  // The notices link jukecord's licence from docs/; here it is beside them.
  const notices = fs.readFileSync('docs/THIRD_PARTY_NOTICES.md', 'utf8').replaceAll('](../LICENSE)', '](LICENSE)');
  fs.writeFileSync(path.join(stage, 'THIRD_PARTY_NOTICES.md'), notices);
}

/** The launcher, with the name of yt-dlp's program for the target filled in. */
function addLauncher(target: Target, stage: string): void {
  if (isWindows(target)) {
    const template = fs.readFileSync('deploy/bundle/jukecord.cmd', 'utf8');
    fs.writeFileSync(path.join(stage, 'jukecord.cmd'), crlf(template.replaceAll('@YTDLP@', YTDLP_PROGRAM[target])));
  } else {
    const template = fs.readFileSync('deploy/bundle/jukecord', 'utf8');
    fs.writeFileSync(path.join(stage, 'jukecord'), template.replaceAll('@YTDLP@', YTDLP_PROGRAM[target]));
  }
}

/**
 * Who may do what with each file, the same whatever umask made it: folders 755, files 644, and the programs 755
 * (on Windows the bits mean nothing, and zip leaves them out).
 */
function setModes(target: Target, stage: string): void {
  const programs = new Set(
    isWindows(target)
      ? []
      : [
          path.join(stage, 'jukecord'),
          path.join(stage, 'lib', 'node', 'bin', 'node'),
          path.join(stage, 'lib', 'ffmpeg', 'ffmpeg'),
          path.join(stage, 'lib', 'yt-dlp', YTDLP_PROGRAM[target]),
        ],
  );
  for (const file of walk(stage)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    fs.chmodSync(file, stat.isDirectory() || programs.has(file) ? 0o755 : 0o644);
  }
}

/** The folder packed: tar and gzip with fixed owners, order and times (the same files give the same archive), or zip. */
async function pack(target: Target, work: string, out: string, epoch: number): Promise<string> {
  const name = folderName(target);
  const file = path.join(out, archiveName(target));
  fs.rmSync(file, { force: true });
  // Every file's time is the commit's.
  for (const entry of walk(path.join(work, name))) fs.lutimesSync(entry, epoch, epoch);
  if (isWindows(target)) {
    // zip reads the names, in order, from its input; -X leaves out the owners and other extra fields.
    const names = walk(path.join(work, name)).map((entry) => path.relative(work, entry));
    // Plain ASCII names only: zip stores others without saying they are UTF-8, and Windows then reads them in its
    // own code page or not at all (its tar stopped at one on a runner).
    const unreadable = names.filter((entry) => !/^[\x20-\x7e]*$/.test(entry));
    if (unreadable.length > 0) throw new Error(`names that are not plain ASCII: ${unreadable.join(', ')}`);
    run('zip', ['-q', '-X', '-9', '-@', file], { cwd: work, input: `${names.join('\n')}\n` });
  } else {
    const tar = spawn(
      'tar',
      ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', `--mtime=@${epoch}`, '-cf', '-', '-C', work, name],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const done = new Promise<void>((resolve, reject) =>
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar ended with ${code}`)))),
    );
    // Node's gzip writes no name and no time in its header.
    await pipeline(tar.stdout, zlib.createGzip({ level: 9 }), fs.createWriteStream(file));
    await done;
  }
  return file;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // --name value, taken out of the arguments.
  const option = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    if (at === -1) return undefined;
    const [, value] = args.splice(at, 2);
    return value;
  };
  const ffmpegRoot = option('--ffmpeg');
  const out = path.resolve(option('--out') ?? 'dist');
  if (!ffmpegRoot) {
    process.stderr.write('Usage: node scripts/bundle.ts --ffmpeg <folder> [--out <folder>] [<target> ...]\n');
    process.exit(2);
  }
  for (const target of args) {
    if (!(TARGETS as readonly string[]).includes(target)) {
      process.stderr.write(`bundle.ts: no such target: ${target} (${TARGETS.join(', ')})\n`);
      process.exit(2);
    }
  }
  const targets = (args.length > 0 ? args : TARGETS) as readonly Target[];
  const pins = readPins();
  const cache = path.join(out, '.cache');
  const work = path.join(out, '.work');
  // A run starts from an empty work folder, its own (never a folder named from outside).
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  // The time of the commit the programs are made from, for every file in them.
  const epoch = Number(execFileSync('git', ['log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim());

  const app = path.join(work, 'app');
  buildApp(app);
  for (const target of targets) {
    const stage = path.join(work, folderName(target));
    const lib = path.join(stage, 'lib');
    fs.cpSync(app, path.join(lib, 'app'), { recursive: true });
    installModules(target, path.join(lib, 'app'), work);
    addNode(target, path.join(lib, 'node'), pins, cache);
    if (target === 'linux-x64' || target === 'linux-arm64')
      addLibatomic(target, path.join(lib, 'node', 'lib'), pins, cache, work);
    addYtdlp(target, path.join(lib, 'yt-dlp'), pins, cache);
    const ffmpeg = path.join(ffmpegRoot, target);
    if (!fs.existsSync(path.join(ffmpeg, isWindows(target) ? 'ffmpeg.exe' : 'ffmpeg'))) {
      throw new Error(`no FFmpeg for ${target} in ${ffmpeg} (deploy/bundle/build-ffmpeg.sh ${target} ${ffmpeg})`);
    }
    fs.cpSync(ffmpeg, path.join(lib, 'ffmpeg'), { recursive: true });
    addLauncher(target, stage);
    addTexts(target, stage);
    setModes(target, stage);
    const file = await pack(target, work, out, epoch);
    process.stdout.write(
      `${path.relative(process.cwd(), file)}  ${(fs.statSync(file).size / 1048576).toFixed(1)} MiB\n`,
    );
    fs.rmSync(stage, { recursive: true, force: true });
  }
  fs.rmSync(work, { recursive: true, force: true });
}

if (import.meta.main) await main();
