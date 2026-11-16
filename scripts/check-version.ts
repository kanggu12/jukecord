/**
 * Checks that one version is named everywhere a release reads it: src/version.ts (the one place it is set),
 * package.json, the Helm chart's version and appVersion and the image tag in its artifacthub.io/images annotation, the
 * guides' lines that name a release (the image, the chart, a release's files, the README's badge and the bug form's
 * example) and, given a tag (v1.2.3), the tag. Exits 1 with the differences otherwise.
 *
 *   node scripts/check-version.ts [v1.2.3]
 *   node scripts/check-version.ts --write     # first brings the guides' lines to src/version.ts's version
 */
import fs from 'node:fs';
import { VERSION } from '../src/version.ts';

// The files people read that name a release; CHANGELOG.md keeps each version's own, so it is not among them.
const GUIDES = [
  'README.md',
  'CONTRIBUTING.md',
  'deploy/helm/jukecord/README.md',
  '.github/ISSUE_TEMPLATE/bug.yml',
  // Every guide in docs/, so one added later is checked without being listed here.
  ...fs
    .readdirSync('docs')
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
];

// Where a guide names a released version, the version in the first group: the image (ghcr.io/kanggu12/jukecord:1.2.3,
// and as a copy in a private registry), the chart (--version 1.2.3, and the file helm pull writes), a release's files
// (jukecord-1.2.3-helm-chart.tgz, jukecord-1.2.3-checksums.txt), the README's badge and the bug form's example. Each is
// tied to jukecord, so Node 24.11, a Compose or FFmpeg version or a yt-dlp release (2025.10.22) is never taken for one.
const NAMED = [
  /ghcr\.io\/[\w.-]+\/jukecord:(\d+\.\d+\.\d+)\b/g,
  /registry\.example\.internal\/jukecord:(\d+\.\d+\.\d+)\b/g,
  /charts\/jukecord --version (\d+\.\d+\.\d+)\b/g,
  /\bjukecord-(\d+\.\d+\.\d+)(?:-[a-z-]+)?\.(?:tgz|txt)\b/g,
  /alt="Release v(\d+\.\d+\.\d+)"/g,
  /^ {6}placeholder: (\d+\.\d+\.\d+)$/gm,
];

const problems: string[] = [];
const write = process.argv.includes('--write');
for (const path of GUIDES) {
  // A guide named above that is not there (a fork without the chart's README) has nothing to check.
  if (!fs.existsSync(path)) continue;
  let text = fs.readFileSync(path, 'utf8');
  if (write) {
    const before = text;
    // Each mention keeps its words; only its version becomes this one.
    for (const pattern of NAMED)
      text = text.replace(pattern, (whole: string, named: string) => whole.replace(named, VERSION));
    // A guide already on the version is left as it is, its time of change too.
    if (text !== before) fs.writeFileSync(path, text);
  }
  // Every mention of another version, in the order of the guide's lines.
  const others = NAMED.flatMap((pattern) => [...text.matchAll(pattern)])
    .filter((match) => match[1] !== VERSION)
    .sort((a, b) => a.index - b.index);
  for (const match of others) {
    // The line it is on, counted from 1, as an editor shows it.
    const line = text.slice(0, match.index).split('\n').length;
    problems.push(`${path}:${line} names ${match[1]}`);
  }
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };
if (pkg.version !== VERSION) problems.push(`package.json says ${pkg.version}`);
const chart = fs.readFileSync('deploy/helm/jukecord/Chart.yaml', 'utf8');
const chartVersion = /^version:\s*(\S+)$/m.exec(chart)?.[1];
const appVersion = /^appVersion:\s*"?([^"\s]+)"?$/m.exec(chart)?.[1];
if (chartVersion !== VERSION) problems.push(`the chart's version is ${chartVersion}`);
if (appVersion !== VERSION) problems.push(`the chart's appVersion is ${appVersion}`);
// The image Artifact Hub scans, named with its tag in the chart's annotations.
const imageTag = /^ {6}image: ghcr\.io\/[^\s:]+:(\S+)$/m.exec(chart)?.[1];
if (imageTag !== VERSION) problems.push(`the chart's artifacthub.io/images tag is ${imageTag}`);
// The tag is the one argument that does not start with two dashes.
const tag = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
if (tag !== undefined && tag !== `v${VERSION}`) problems.push(`the tag is ${tag}`);
if (problems.length > 0) {
  process.stderr.write(`src/version.ts says ${VERSION}, but ${problems.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`${VERSION} everywhere\n`);
