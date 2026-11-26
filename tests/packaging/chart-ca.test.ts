/**
 * The chart's certificate authorities (ca): a Secret or a ConfigMap of the user's, mounted read-only on every jukecord
 * pod (the one pod; in split mode the core and every edge) as the file JUKECORD_CA_FILE names, a changed one
 * restarting the pods, and the refusals: both a Secret and a ConfigMap, JUKECORD_CA_FILE set by hand beside ca, and the
 * directory's own authority file, which ca covers. Rendered and validated with helm and kubeconform when they are
 * installed (CI installs both).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

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
  'bus.url=rediss://v:6379',
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
    .find((part) => part.includes(`\nkind: ${kind}\n`) && part.includes(`\n  name: ${name}\n`));
  assert.ok(found, `no ${kind} ${name}`);
  return found;
}

// What a pod with the host's authorities carries: the setting, the mount, the volume, and the checksum.
function trusts(part: string, source: RegExp): void {
  assert.match(part, /- name: JUKECORD_CA_FILE\n\s+value: \/run\/jukecord-ca\/ca\.crt\n/);
  assert.match(part, /- name: ca\n\s+mountPath: \/run\/jukecord-ca\n\s+readOnly: true/);
  assert.match(part, source);
  assert.match(part, /checksum\/ca: [0-9a-f]{16}\n/);
  // Node's own variable is the host's to set, never the chart's.
  assert.doesNotMatch(part, /NODE_EXTRA_CA_CERTS/);
}

describe("the chart's certificate authorities", { skip: !have('helm') && 'helm is not installed' }, () => {
  it('reach the one pod from a ConfigMap of yours, and nothing of them is there without ca', () => {
    const rendered = render('--set', 'ca.configMap=corp-ca', '--set', 'ca.key=bundle.pem');
    trusts(
      object(rendered, 'Deployment', 't-jukecord'),
      /- name: ca\n\s+configMap:\n\s+name: corp-ca\n\s+defaultMode: 0444\n\s+items:\n\s+- key: bundle\.pem\n\s+path: ca\.crt/,
    );
    const plain = object(render(), 'Deployment', 't-jukecord');
    assert.doesNotMatch(plain, /JUKECORD_CA_FILE|jukecord-ca/);
  });

  it('reach the core and every edge in split mode from a Secret of yours, under the default key', () => {
    const rendered = render(...SPLIT, '--set', 'ca.secret=corp-ca');
    for (const name of ['t-jukecord-core', 't-jukecord-edge']) {
      trusts(
        object(rendered, 'Deployment', name),
        /- name: ca\n\s+secret:\n\s+secretName: corp-ca\n\s+defaultMode: 0444\n\s+items:\n\s+- key: ca\.crt\n\s+path: ca\.crt/,
      );
    }
  });

  it('restart the pods when ca changes', () => {
    const checksum = (rendered: string, name: string) =>
      /checksum\/ca: (\w+)/.exec(object(rendered, 'Deployment', name))?.[1];
    const before = checksum(render('--set', 'ca.configMap=corp-ca'), 't-jukecord');
    assert.notEqual(checksum(render('--set', 'ca.configMap=corp-ca-2'), 't-jukecord'), before);
    assert.notEqual(
      checksum(render('--set', 'ca.configMap=corp-ca', '--set', 'ca.key=other.pem'), 't-jukecord'),
      before,
    );
    assert.equal(checksum(render('--set', 'ca.configMap=corp-ca'), 't-jukecord'), before);
    // The same on both parts of a split.
    const split = render(...SPLIT, '--set', 'ca.configMap=corp-ca');
    assert.equal(checksum(split, 't-jukecord-core'), checksum(split, 't-jukecord-edge'));
  });

  it('refuse a Secret and a ConfigMap at once, JUKECORD_CA_FILE beside ca, and the directory its own file', () => {
    assert.match(
      render('--set', 'ca.secret=a', '--set', 'ca.configMap=b'),
      /ca\.secret and ca\.configMap are both set; set the one that holds the certificates/,
    );
    assert.match(
      render('--set', 'ca.configMap=corp-ca', '--set', 'env.JUKECORD_CA_FILE=/x'),
      /env: JUKECORD_CA_FILE is set by the chart \(from ca, mounted on every pod\)/,
    );
    assert.match(
      render(
        '--set',
        'ca.configMap=corp-ca',
        '--set',
        'extraEnv[0].name=JUKECORD_CA_FILE',
        '--set',
        'extraEnv[0].value=/x',
      ),
      /extraEnv: JUKECORD_CA_FILE is set by the chart/,
    );
    // Without ca, a file the host mounts another way is theirs to name.
    assert.doesNotMatch(render('--set', 'env.JUKECORD_CA_FILE=/x'), /^refused/);
    assert.match(render('--set', 'env.JUKECORD_LDAP_CA_FILE=/x'), /A private authority goes in the chart's ca/);
    assert.match(render('--set', 'ca.key='), /don't meet the specifications of the schema/);
  });

  it('pass kubeconform in both modes', { skip: !have('kubeconform', ['-v']) && 'kubeconform is not installed' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-chart-ca-'));
    try {
      for (const [name, text] of [
        ['single.yaml', render('--set', 'ca.configMap=corp-ca')],
        ['split.yaml', render(...SPLIT, '--set', 'ca.secret=corp-ca')],
      ] as const) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, text);
        execFileSync('kubeconform', ['-strict', '-summary', '-kubernetes-version', '1.31.0', file], { stdio: 'pipe' });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
