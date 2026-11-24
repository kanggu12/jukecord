/**
 * Upgrading the chart from an older release. `helm upgrade --reuse-values` renders this chart with the values the
 * release had in place of this chart's values.yaml, so the groups this version added are not there until
 * templates/_helpers.tpl (jukecord.defaults) fills them in from files/defaults.yaml, the copy of values.yaml. Here an
 * upgrade from 0.3.4 is rendered the way Helm renders it, and compared with a fresh install given the same values.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const CHART = 'deploy/helm/jukecord';
const read = (file: string) => fs.readFileSync(file, 'utf8');

// Whether a program is on the PATH (CI's packaging job installs helm).
function have(program: string): boolean {
  try {
    execFileSync(program, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('upgrading the chart', () => {
  it('keeps files/defaults.yaml a copy of values.yaml, below the lines that say what it is', () => {
    const copy = read(`${CHART}/files/defaults.yaml`);
    const values = read(`${CHART}/values.yaml`);
    // Everything after its own comment lines and a blank one is values.yaml, byte for byte.
    assert.ok(copy.endsWith(values), 'files/defaults.yaml is not values.yaml any more: copy values.yaml there again');
    assert.match(copy.slice(0, copy.length - values.length), /^(?:#[^\n]*\n)+\n$/);
  });

  it("renders an upgrade that reuses 0.3.4's values as a fresh install with those values", {
    skip: !have('helm') && 'helm is not installed',
  }, () => {
    // The chart as Helm holds it in such an upgrade: this version's templates and files, 0.3.4's values.yaml.
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-upgrade-'));
    try {
      fs.cpSync(CHART, old, { recursive: true });
      fs.copyFileSync('tests/packaging/chart-values-0.3.4.yaml', path.join(old, 'values.yaml'));
      const render = (chart: string, values: readonly string[]) =>
        execFileSync('helm', ['template', 't', chart, ...values], { encoding: 'utf8' });
      for (const values of [
        // Nothing set: the defaults of both.
        [],
        // A host behind an Ingress, with the Discord secrets in a Secret of their own.
        ['--set', 'ingress.enabled=true', '--set', 'ingress.host=music.example.org'],
        ['--set', 'discord.existingSecret=music-discord'],
        // Values set to false or changed in place stay as they were set: nothing is filled over them.
        [
          '--set',
          'persistence.size=20Gi',
          '--set',
          'resources.limits.memory=1Gi',
          '--set',
          'networkPolicy.enabled=false',
        ],
      ]) {
        assert.equal(render(old, values), render(CHART, values), values.join(' ') || 'the defaults');
      }
    } finally {
      fs.rmSync(old, { recursive: true, force: true });
    }
  });
});
