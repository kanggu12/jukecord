/**
 * Checks that one version is named everywhere a release reads it: src/version.ts (the one place it is set),
 * package.json, the Helm chart's version and appVersion, and, given a tag (v1.2.3), the tag. Exits 1 with the
 * differences otherwise.
 *
 *   node scripts/check-version.ts [v1.2.3]
 */
import fs from 'node:fs';
import { VERSION } from '../src/version.ts';

const problems: string[] = [];
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };
if (pkg.version !== VERSION) problems.push(`package.json says ${pkg.version}`);
const chart = fs.readFileSync('deploy/helm/jukecord/Chart.yaml', 'utf8');
const chartVersion = /^version:\s*(\S+)$/m.exec(chart)?.[1];
const appVersion = /^appVersion:\s*"?([^"\s]+)"?$/m.exec(chart)?.[1];
if (chartVersion !== VERSION) problems.push(`the chart's version is ${chartVersion}`);
if (appVersion !== VERSION) problems.push(`the chart's appVersion is ${appVersion}`);
const tag = process.argv[2];
if (tag !== undefined && tag !== `v${VERSION}`) problems.push(`the tag is ${tag}`);
if (problems.length > 0) {
  process.stderr.write(`src/version.ts says ${VERSION}, but ${problems.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`${VERSION} everywhere\n`);
