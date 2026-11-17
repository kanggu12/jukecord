/**
 * One of the release's programs, run the way a person runs it, on the system it is for: the archive unpacked, the
 * Node.js, FFmpeg, yt-dlp and voice encryption in it working, and jukecord started with its own launcher, in a data
 * folder of this run's, playing a tone that this script serves on a local address, so the track goes through yt-dlp
 * and FFmpeg as one from a site would. Nothing is installed and nothing outside the run's folder is written. Exits 1
 * with what failed and the end of jukecord's output.
 *
 *   node scripts/bundle-smoke.ts <jukecord-version-target archive>
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { folderName, readPins, TARGETS, type Target, YTDLP_PROGRAM } from './bundle.ts';

const archive = path.resolve(process.argv[2] ?? '');
const named = /jukecord-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-([a-z]+-[a-z0-9]+)\.(?:tar\.gz|zip)$/.exec(archive);
if (!named || !fs.existsSync(archive) || !(TARGETS as readonly string[]).includes(named[2] ?? '')) {
  process.stderr.write('Usage: node scripts/bundle-smoke.ts <path to jukecord-<version>-<target>.tar.gz or .zip>\n');
  process.exit(2);
}
const version = named[1] ?? '';
const target = named[2] as Target;
const windows = process.platform === 'win32';
const pins = readPins();

function fail(what: string, detail = ''): never {
  process.stdout.write(`FAILED: ${what}\n${detail ? `${detail.trimEnd()}\n` : ''}`);
  process.exit(1);
}
const ok = (what: string) => process.stdout.write(`ok: ${what}\n`);

// The program is for this system and processor, or nothing below means anything.
const here = `${{ linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform as string] ?? process.platform}-${process.arch}`;
if (here !== target) fail(`this is the ${target} program; this machine is ${here}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-smoke-'));
// Windows' own tar reads a .zip (the one Git brings along may come first on the PATH and does not).
const tar = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-xf', archive, '-C', work]);
const dir = path.join(work, folderName(target, version));
const exe = windows ? '.exe' : '';
const node = windows ? path.join(dir, 'lib', 'node', 'node.exe') : path.join(dir, 'lib', 'node', 'bin', 'node');
const ffmpeg = path.join(dir, 'lib', 'ffmpeg', `ffmpeg${exe}`);
const ytdlp = path.join(dir, 'lib', 'yt-dlp', YTDLP_PROGRAM[target]);
const launcher = path.join(dir, windows ? 'jukecord.cmd' : 'jukecord');
for (const file of [launcher, node, ffmpeg, ytdlp, path.join(dir, '.env.example'), path.join(dir, 'README.txt')]) {
  if (!fs.existsSync(file)) fail(`${path.relative(work, file)} is in the archive`);
}
ok(`unpacked ${path.basename(archive)}`);

/** A program's output, or the failure with what it said. */
// The programs run straight from the folder find the folder's libatomic as the launcher points Node.js at it (a bare
// Linux has none of its own).
const direct: NodeJS.ProcessEnv = { ...process.env, LD_LIBRARY_PATH: path.join(dir, 'lib', 'node', 'lib') };
function output(program: string, args: readonly string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60_000, env: direct });
  if (result.status !== 0)
    fail(`${path.basename(program)} ${args.join(' ')}`, `${result.stdout}${result.stderr}${result.error ?? ''}`);
  return result.stdout;
}

if (output(node, ['--version']).trim() !== `v${pins.node.version}`) fail(`Node.js is ${pins.node.version}`);
ok(`Node.js ${pins.node.version}`);
// Discord's voice encryption is a native module, built for each system: this one's must load.
output(node, ['-e', 'require(process.argv[1])', path.join(dir, 'lib', 'app', 'node_modules', '@snazzah', 'davey')]);
ok('the voice encryption module loads');
const encoders = output(ffmpeg, ['-hide_banner', '-encoders']);
for (const encoder of ['libopus', 'libmp3lame'])
  if (!encoders.includes(encoder)) fail(`FFmpeg encodes with ${encoder}`);
if (!output(ffmpeg, ['-hide_banner', '-protocols']).split(/\r?\n/).includes('  https')) fail('FFmpeg reads https');
const tone = path.join(work, 'tone.mp3');
// A tone made from FFmpeg's own source filter, as an MP3 a site could serve; and the same as Ogg Opus, as jukecord
// writes its cache.
output(ffmpeg, [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  '-filter_complex',
  'sine=frequency=440:duration=8',
  '-c:a',
  'libmp3lame',
  '-b:a',
  '128k',
  tone,
]);
output(ffmpeg, [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  tone,
  '-c:a',
  'libopus',
  path.join(work, 'tone.ogg'),
]);
ok('FFmpeg reads https, and writes MP3 and Opus');
if (output(ytdlp, ['--version']).trim() !== pins['yt-dlp'].version) fail(`yt-dlp is ${pins['yt-dlp'].version}`);
ok(`yt-dlp ${pins['yt-dlp'].version}`);

// The tone on a local address, as a site would serve it.
const media = http.createServer((request, response) => {
  if (request.url !== '/tone.mp3') return void response.writeHead(404).end();
  response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': fs.statSync(tone).size });
  if (request.method === 'HEAD') return void response.end();
  fs.createReadStream(tone).pipe(response);
});
await new Promise<void>((resolve) => media.listen(0, '127.0.0.1', resolve));
const toneUrl = `http://127.0.0.1:${(media.address() as AddressInfo).port}/tone.mp3`;

// A free port for jukecord: one the system hands out, let go again.
const port = await new Promise<number>((resolve) => {
  const probe = http.createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address() as AddressInfo;
    probe.close(() => resolve(free));
  });
});
// jukecord's settings for the run: its data in the run's folder, no Discord, the local address allowed, no lyrics
// looked up, and nothing from the environment of this machine's own jukecord.
// LD_LIBRARY_PATH stays out too: the launcher must point Node.js at its libatomic by itself.
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('JUKECORD_') && name !== 'LD_LIBRARY_PATH'),
);
Object.assign(env, {
  JUKECORD_DATA_DIR: path.join(work, 'data'),
  JUKECORD_PORT: String(port),
  JUKECORD_ALLOW_PRIVATE_ADDRESSES: 'true',
  JUKECORD_LYRICS: 'off',
});

/** The launcher with its words: itself on Linux and macOS, through cmd on Windows (a .cmd runs nowhere else). */
function launch(args: readonly string[]): { file: string; args: string[]; verbatim: boolean } {
  if (!windows) return { file: launcher, args: [...args], verbatim: false };
  const line = [launcher, ...args].map((word) => `"${word}"`).join(' ');
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}
/**
 * A jukecord command through the launcher, and what it printed. Not waited for in a blocking way: the tone is served
 * from this process, which must stay free to answer while jukecord fetches it.
 */
function jukecord(args: readonly string[]): Promise<{ status: number | null; text: string }> {
  const how = launch(args);
  const child = spawn(how.file, how.args, { env, windowsVerbatimArguments: how.verbatim });
  const text: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => text.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => text.push(chunk.toString()));
  const timer = setTimeout(() => child.kill(), 120_000);
  return new Promise((resolve) =>
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, text: text.join('') });
    }),
  );
}

const log: string[] = [];
const how = launch(['start']);
const server: ChildProcess = spawn(how.file, how.args, { env, windowsVerbatimArguments: how.verbatim });
server.stdout?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
server.stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
let exited: number | null | undefined;
server.on('exit', (code) => {
  exited = code;
});
const tail = () => log.join('').split('\n').slice(-30).join('\n');

/** Stops jukecord: SIGTERM, as a service manager does; on Windows the whole tree (cmd, then Node). */
async function stop(): Promise<number | null | undefined> {
  if (exited !== undefined) return exited;
  if (windows) spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' });
  else server.kill('SIGTERM');
  for (let waited = 0; exited === undefined && waited < 20_000; waited += 200)
    await new Promise((r) => setTimeout(r, 200));
  return exited;
}
async function check(what: string, condition: boolean, detail = ''): Promise<void> {
  if (condition) return ok(what);
  await stop();
  media.close();
  fail(what, `${detail}\n--- jukecord's output\n${tail()}`);
}

// Ready: the panel answers.
let ready = false;
for (let waited = 0; !ready && exited === undefined && waited < 90_000; waited += 500) {
  ready = await fetch(`http://127.0.0.1:${port}/readyz`).then(
    (response) => response.ok,
    () => false,
  );
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
await check('jukecord start answers on its port', ready);

const status = await jukecord(['status']);
await check('jukecord status', status.status === 0 && status.text.includes(version), status.text);
const added = await jukecord(['add', toneUrl]);
await check('jukecord add', added.status === 0, added.text);

// Playing: the track is the tone, fetched by yt-dlp and made Opus by FFmpeg, then played.
let playing = '';
for (let waited = 0; !playing && waited < 90_000; waited += 1000) {
  const now = await jukecord(['--json', 'np']);
  if (now.status === 0) {
    const player = JSON.parse(now.text) as { status?: string; track?: { title?: string } };
    if (player.status === 'playing' && player.track) playing = player.track.title ?? '(no title)';
  }
  if (!playing) await new Promise((r) => setTimeout(r, 1000));
}
await check(`the tone plays (as "${playing}")`, playing !== '', (await jukecord(['np'])).text);

const code = await stop();
media.close();
// On Linux and macOS jukecord stops cleanly on SIGTERM; on Windows taskkill ends it outright.
if (!windows && code !== 0) fail(`jukecord stops on SIGTERM with 0, not ${code}`, tail());
for (const file of ['jukecord.db', 'host-token']) {
  if (!fs.existsSync(path.join(work, 'data', file))) fail(`jukecord kept its ${file} in JUKECORD_DATA_DIR`, tail());
}
ok('jukecord stopped, its data in JUKECORD_DATA_DIR');
// Windows may still hold the files for a moment after the processes end.
fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
process.stdout.write(`the ${target} program works\n`);
