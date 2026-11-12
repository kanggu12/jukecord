/**
 * The source as JavaScript, which the image carries (scripts/strip-types.ts): the real source is written out and
 * run, and the script refuses what would give an image that cannot start.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { stripTree } from '../../scripts/strip-types.ts';
import { VERSION } from '../../src/version.ts';

// A folder of its own for each test, removed at the end.
const folders: string[] = [];
function scratch(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-strip-'));
  folders.push(folder);
  return folder;
}
after(() => {
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
});

// Writes a small source tree: the files by their path, with their text.
function tree(files: Record<string, string>): string {
  const folder = path.join(scratch(), 'src');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

// Runs a stripped program the way the image does, with nothing of this machine's settings.
function run(file: string, env: Record<string, string> = {}, ...words: string[]) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', file, ...words], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('the source as JavaScript', () => {
  // The real source, written once for the tests below. The packages are beside it, as they are in the image.
  const out = scratch();
  const done = stripTree('src', path.join(out, 'src'));
  fs.symlinkSync(path.resolve('node_modules'), path.join(out, 'node_modules'), 'dir');
  const sources = fs
    .readdirSync('src', { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.ts'));

  it('writes every .ts as a .js with each line and column where it was', () => {
    assert.equal(done.files, sources.length);
    for (const name of sources) {
      const before = fs.readFileSync(path.join('src', name), 'utf8').split('\n');
      const after = fs.readFileSync(path.join(out, 'src', `${name.slice(0, -3)}.js`), 'utf8').split('\n');
      assert.equal(after.length, before.length, name);
      // Spaces stand where the types were, so no line is shorter or longer: a stack trace's line and column from
      // the .js are the place in the .ts.
      before.forEach((line, index) => {
        assert.equal(after[index]?.length, line.length, `${name}:${index + 1}`);
      });
    }
    // Nothing of TypeScript is left to load: no .ts file, and no import of one.
    const written = fs.readdirSync(path.join(out, 'src'), { recursive: true }).map(String);
    assert.deepEqual(
      written.filter((name) => name.endsWith('.ts')),
      [],
    );
    for (const name of written.filter((file) => file.endsWith('.js'))) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(out, 'src', name), 'utf8'),
        /\bfrom\s*['"]\.{1,2}\/[^'"\n]+\.ts['"]/,
      );
    }
    assert.ok(done.imports > 50, `${done.imports} imports renamed`);
  });

  it('gives a jukecord command that runs', () => {
    const version = run(path.join(out, 'src/cli/main.js'), {}, '--version');
    assert.equal(version.stdout, `jukecord ${VERSION}\n`, version.stderr);
    assert.equal(version.status, 0);
  });

  it('gives a server whose every import is found: it reads its settings and refuses a wrong one', () => {
    // A setting that cannot be right stops jukecord after everything it imports has loaded and before it opens
    // or starts anything.
    const data = path.join(out, 'data');
    const server = run(path.join(out, 'src/main.js'), { JUKECORD_PORT: 'nope', JUKECORD_DATA_DIR: data });
    assert.match(server.stderr, /^jukecord cannot start with these settings:\n- JUKECORD_PORT: /);
    assert.equal(server.status, 2);
    assert.equal(fs.existsSync(data), false);
  });

  it('names the place in the source when the stripped code throws', () => {
    const from = tree({
      'main.ts': [
        "import { fail } from './lib/fail.ts';",
        'interface Options {',
        '  readonly why: string;',
        '}',
        "const options: Options = { why: 'on purpose' };",
        'fail(options.why as string);',
        '',
      ].join('\n'),
      'lib/fail.ts': [
        'export function fail<T extends string>(why: T): never {',
        '  const text: string = why;',
        '  throw new Error(text);',
        '}',
        '',
      ].join('\n'),
    });
    const to = path.join(path.dirname(from), 'out');
    assert.deepEqual(stripTree(from, to), { files: 2, imports: 1 });
    const thrown = run(path.join(to, 'main.js'));
    assert.equal(thrown.status, 1);
    // Line 3, column 9 of lib/fail.ts is where `new Error` stands; line 6 of main.ts is the call.
    assert.match(
      thrown.stderr,
      /Error: on purpose\n\s+at fail \(file:\/\/\S+\/lib\/fail\.js:3:9\)\n\s+at file:\/\/\S+\/main\.js:6:1\n/,
    );
  });

  it('renames relative imports of every kind, and leaves the others alone', () => {
    const from = tree({
      'a.ts': [
        "import './side.ts';",
        "import type { Shape } from './shape.ts';",
        "import { one } from './deep/one.ts';",
        "export { two } from './deep/two.ts';",
        "export * as all from './deep/one.ts';",
        "import fs from 'node:fs';",
        "const later = () => import('./deep/two.ts');",
        "const data = fs.existsSync('./deep/notes.txt') as boolean;",
        'export const shape: Shape = { one, later, data };',
        '',
      ].join('\n'),
      'side.ts': 'export {};\n',
      'shape.ts': 'export interface Shape {\n  one: number;\n  later: () => Promise<unknown>;\n  data: boolean;\n}\n',
      'deep/one.ts': 'export const one: number = 1;\n',
      'deep/two.ts': "import { one } from './one.ts';\nexport const two = one + 1;\n",
      'deep/notes.txt': 'kept as it is\n',
    });
    const to = path.join(path.dirname(from), 'out');
    const result = stripTree(from, to);
    const a = fs.readFileSync(path.join(to, 'a.js'), 'utf8');
    assert.match(a, /^import '\.\/side\.js';$/m);
    assert.match(a, /^import \{ one \} from '\.\/deep\/one\.js';$/m);
    assert.match(a, /^export \{ two \} from '\.\/deep\/two\.js';$/m);
    assert.match(a, /^export \* as all from '\.\/deep\/one\.js';$/m);
    assert.match(a, /import\('\.\/deep\/two\.js'\)/);
    // A package or a built-in module is not a file of the tree, and a path that is not a .ts file is left alone.
    assert.match(a, /^import fs from 'node:fs';$/m);
    assert.match(a, /existsSync\('\.\/deep\/notes\.txt'\)/);
    // The import of a type went with the type.
    assert.doesNotMatch(a, /shape\.(ts|js)/);
    // Five in a.ts (the type's import is gone before the renaming), one in deep/two.ts.
    assert.deepEqual(result, { files: 5, imports: 6 });
    assert.equal(fs.readFileSync(path.join(to, 'deep/notes.txt'), 'utf8'), 'kept as it is\n');
    assert.equal(run(path.join(to, 'a.js')).status, 0);
  });

  it('refuses what would leave the image unable to start, or would write over something', () => {
    // An import that leaves the folder: the image has the folder and nothing beside it.
    const leaving = tree({ 'a.ts': "import '../beside.ts';\n" });
    fs.writeFileSync(path.join(path.dirname(leaving), 'beside.ts'), 'export {};\n');
    assert.throws(
      () => stripTree(leaving, path.join(scratch(), 'out')),
      /a\.js imports \.\.\/beside\.js, which is not in the output/,
    );
    // An import of a file that is not there.
    const missing = tree({ 'a.ts': "import './gone.ts';\n" });
    assert.throws(
      () => stripTree(missing, path.join(scratch(), 'out')),
      /imports \.\/gone\.js, which is not in the output/,
    );
    // Syntax that cannot be stripped.
    const unstrippable = tree({ 'a.ts': 'enum Colour {\n  Red,\n}\nexport const red = Colour.Red;\n' });
    assert.throws(() => stripTree(unstrippable, path.join(scratch(), 'out')));
    // A relative .ts path the renaming does not reach: a template string, a module's address made another way.
    for (const text of [
      'const later = () => import(`./b.ts`);\nexport { later };\n',
      "const worker = new URL('./b.ts', import.meta.url);\nexport { worker };\n",
      "import { b } from /* the other one */ './b.ts';\nexport { b };\n",
    ]) {
      const hidden = tree({ 'a.ts': text, 'b.ts': 'export const b = 1;\n' });
      assert.throws(() => stripTree(hidden, path.join(scratch(), 'out')), /names a \.ts file/, text);
    }
    // A .js beside a .ts of the same name: one would write over the other.
    const twins = tree({ 'a.ts': 'export {};\n', 'a.js': 'export {};\n' });
    assert.throws(() => stripTree(twins, path.join(scratch(), 'out')), /a \.ts of the same name is beside it/);
    // A kind of file it has no rule for.
    const other = tree({ 'a.tsx': 'export {};\n' });
    assert.throws(() => stripTree(other, path.join(scratch(), 'out')), /only \.ts files are handled/);
    // The output inside the source, and an output folder with something in it.
    const plain = tree({ 'a.ts': 'export {};\n' });
    assert.throws(() => stripTree(plain, path.join(plain, 'out')), /is inside the source folder/);
    const full = scratch();
    fs.writeFileSync(path.join(full, 'something'), '');
    assert.throws(() => stripTree(plain, full), /is not empty/);
    assert.equal(fs.existsSync(path.join(full, 'a.js')), false);
  });
});
