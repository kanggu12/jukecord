/**
 * Writes jukecord's source as JavaScript, for the image.
 *
 * From a checkout Node runs the .ts files as they are and takes the types out each time a process starts. For that
 * it loads its TypeScript parser, which costs every process (the server, each `jukecord` command) about 20 MiB and
 * 40 ms. The image therefore carries the source with the types already out: each .ts under the source folder is
 * written as a .js by the function Node itself uses when it runs a .ts file, which puts spaces where the types were.
 * Every line and column stays where it is in the .ts, so a stack trace from the image names the place in the source
 * (read .ts for .js). The relative imports are renamed from .ts to .js, which is the same length.
 *
 *   node scripts/strip-types.ts <source folder> <output folder>
 */
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

// A relative import or re-export, static or dynamic: from './x.ts', import './x.ts', import('./x.ts'). The third
// group is the path without its quotes.
const RELATIVE = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"\n]+)\2/g;

// Any relative .ts path left in quotes or backticks after the renaming: an import the pattern above did not see (a
// template string, a comment between from and the path) or an address of a module made some other way (new URL(…,
// import.meta.url) for a worker). The image has no .ts files, so each would fail at run time: the build stops instead.
const LEFT_OVER = /(['"`])\.{1,2}\/[^'"`\n]*\.ts\1/;

/** What a run did: how many .ts files became .js, and how many of their imports were renamed. */
export interface Stripped {
  readonly files: number;
  readonly imports: number;
}

/** Writes every .ts under `from` as a .js under `to`, in the same folders; any other file is copied as it is. */
export function stripTree(from: string, to: string): Stripped {
  const source = path.resolve(from);
  const output = path.resolve(to);
  // Written into the source it would be read again as source; written over something else it would mix with it.
  if (output === source || output.startsWith(source + path.sep)) {
    throw new Error(`the output folder ${to} is inside the source folder ${from}`);
  }
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0) {
    throw new Error(`the output folder ${to} is not empty`);
  }
  let files = 0;
  let imports = 0;
  // The files that were written, to check their imports once all of them exist.
  const written: string[] = [];
  const entries = fs
    .readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    // The same order on every machine.
    .sort();
  for (const file of entries) {
    const target = path.join(output, path.relative(source, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Declarations hold types only: there is nothing in them to run.
    if (file.endsWith('.d.ts')) continue;
    // The other TypeScript kinds would need their own handling (.mts becomes .mjs, .tsx has to be compiled).
    if (/\.(mts|cts|tsx)$/.test(file)) throw new Error(`${file}: only .ts files are handled`);
    if (!file.endsWith('.ts')) {
      // A .js beside a .ts of the same name would be written over by the .ts's own.
      if (file.endsWith('.js') && fs.existsSync(`${file.slice(0, -3)}.ts`)) {
        throw new Error(`${file}: a .ts of the same name is beside it, and both would be ${path.basename(file)}`);
      }
      fs.copyFileSync(file, target);
      continue;
    }
    const original = fs.readFileSync(file, 'utf8');
    // Fails on syntax that cannot be stripped (an enum, a namespace), which the type check refuses as well.
    const stripped = stripTypeScriptTypes(original, { mode: 'strip' });
    const code = stripped.replace(RELATIVE, (all: string, lead: string, quote: string, specifier: string) => {
      if (!specifier.endsWith('.ts')) return all;
      imports += 1;
      return `${lead}${quote}${specifier.slice(0, -3)}.js${quote}`;
    });
    // The promise in the header: a line of the .js is the same line of the .ts.
    if (code.split('\n').length !== original.split('\n').length) {
      throw new Error(`${file}: the stripped code has a different number of lines`);
    }
    const left = LEFT_OVER.exec(code);
    if (left) {
      const line = code.slice(0, left.index).split('\n').length;
      throw new Error(
        `${file}:${line}: ${left[0]} names a .ts file, which the image does not have; import it with from or import()`,
      );
    }
    const out = `${target.slice(0, -3)}.js`;
    fs.writeFileSync(out, code);
    written.push(out);
    files += 1;
  }
  // Every relative import has to lead to a file that was written: the image holds this folder and nothing beside
  // it, so an import that leaves it, or one a rename broke, would stop jukecord at its start.
  for (const file of written) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(RELATIVE)) {
      const imported = path.resolve(path.dirname(file), match[3] ?? '');
      if (!imported.startsWith(output + path.sep) || !fs.existsSync(imported)) {
        throw new Error(`${path.relative(output, file)} imports ${match[3]}, which is not in the output`);
      }
    }
  }
  return { files, imports };
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    process.stderr.write('usage: node scripts/strip-types.ts <source folder> <output folder>\n');
    process.exit(2);
  }
  const done = stripTree(from, to);
  console.log(`${done.files} files written as JavaScript, ${done.imports} imports renamed`);
}
