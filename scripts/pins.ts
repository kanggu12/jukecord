/**
 * Moves what the release's programs carry to another release, with the SHA-256 of each file from the release's own
 * list: Node.js from its SHASUMS256.txt (signed by the Node.js release team), yt-dlp from its SHA2-256SUMS. yt-dlp is
 * the image's too, so its version and the two Linux sums in deploy/docker/Dockerfile move with it.
 *
 *   node scripts/pins.ts node 26.14.0
 *   node scripts/pins.ts yt-dlp 2026.11.10
 *
 * The weekly checks (node-release.yml, ytdlp-release.yml) say when there is a newer one.
 */
import fs from 'node:fs';
import { PINS_FILE, type Pins, readPins, TARGETS, type Target } from './bundle.ts';

// Node.js's names for a target's system, and its archive for it: .zip for Windows, .tar.xz for the rest.
const NODE_SYSTEM: Readonly<Record<string, string>> = { linux: 'linux', macos: 'darwin', windows: 'win' };
// yt-dlp's file for each target: the one-folder build, which starts faster than the one-file one; one macOS build
// runs on both processors.
const YTDLP_FILE: Readonly<Record<Target, string>> = {
  'linux-x64': 'yt-dlp_linux.zip',
  'linux-arm64': 'yt-dlp_linux_aarch64.zip',
  'macos-arm64': 'yt-dlp_macos.zip',
  'macos-x64': 'yt-dlp_macos.zip',
  'windows-x64': 'yt-dlp_win.zip',
  'windows-arm64': 'yt-dlp_win_arm64.zip',
};

/** A release's list of SHA-256 sums, as file name to sum ("<sum>  <name>" lines; a * before a name is binary mode). */
async function sums(url: string): Promise<Map<string, string>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const list = new Map<string, string>();
  for (const line of (await response.text()).split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) list.set(match[2], match[1]);
  }
  return list;
}

/** Each target's file with its sum, or a stop naming the file the release does not list. */
function files(names: (target: Target) => string, list: Map<string, string>, url: string) {
  return Object.fromEntries(
    TARGETS.map((target) => {
      const name = names(target);
      const sha256 = list.get(name);
      if (!sha256) throw new Error(`${url} lists no ${name}`);
      return [target, { name, sha256 }];
    }),
  ) as Pins['node']['files'];
}

async function main(): Promise<void> {
  const [what, version] = process.argv.slice(2);
  if (!version || (what !== 'node' && what !== 'yt-dlp')) {
    process.stderr.write('Usage: node scripts/pins.ts node <version> | yt-dlp <version>\n');
    process.exit(2);
  }
  const pins = readPins();
  let next: Pins;
  if (what === 'node') {
    const url = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
    const list = await sums(url);
    const name = (target: Target) => {
      const [system = '', processor = ''] = target.split('-');
      return `node-v${version}-${NODE_SYSTEM[system]}-${processor}.${system === 'windows' ? 'zip' : 'tar.xz'}`;
    };
    next = { ...pins, node: { version, files: files(name, list, url) } };
  } else {
    const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/SHA2-256SUMS`;
    const list = await sums(url);
    next = { ...pins, 'yt-dlp': { version, files: files((target) => YTDLP_FILE[target], list, url) } };
    // The image carries the same release: its version and its two sums move together.
    const dockerfile = 'deploy/docker/Dockerfile';
    const text = fs
      .readFileSync(dockerfile, 'utf8')
      .replace(/^ARG YTDLP_VERSION=.*$/m, `ARG YTDLP_VERSION=${version}`)
      .replace(/^ARG YTDLP_SHA256_AMD64=.*$/m, `ARG YTDLP_SHA256_AMD64=${next['yt-dlp'].files['linux-x64'].sha256}`)
      .replace(/^ARG YTDLP_SHA256_ARM64=.*$/m, `ARG YTDLP_SHA256_ARM64=${next['yt-dlp'].files['linux-arm64'].sha256}`);
    fs.writeFileSync(dockerfile, text);
  }
  fs.writeFileSync(PINS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`${what} ${version}: ${PINS_FILE}${what === 'yt-dlp' ? ' and deploy/docker/Dockerfile' : ''}\n`);
}

if (import.meta.main) await main();
