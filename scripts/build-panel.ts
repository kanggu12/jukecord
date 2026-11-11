/**
 * Builds the panel into panel/dist: the TypeScript bundled into one script, the CSS into one stylesheet (with the
 * font beside it), and the page and the icon copied over.
 *
 *   npm run build
 *
 * One file each keeps the first load to four requests. Names do not carry hashes: the server sends the files with
 * "no-cache", so browsers check for a new version (a cheap 304) and never run an old script against a new API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../panel', import.meta.url));
const out = path.join(root, 'dist');

// A clean folder, so a file removed from the panel does not linger in the build.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: { app: path.join(root, 'src/main.ts'), style: path.join(root, 'style.css') },
  outdir: out,
  bundle: true,
  minify: true,
  // Line numbers in a browser's error point at the source, which is what a bug report should quote.
  sourcemap: 'linked',
  format: 'esm',
  // Every browser the panel supports (the last two years of Chrome, Edge, Firefox and Safari).
  target: ['chrome120', 'edge120', 'firefox121', 'safari17'],
  // The font is copied beside the stylesheet under its own name.
  loader: { '.woff2': 'file' },
  assetNames: '[name]',
  logLevel: 'warning',
});

for (const file of ['index.html', 'favicon.svg', 'theme.js'])
  fs.copyFileSync(path.join(root, file), path.join(out, file));
// The font's licence travels with the font.
fs.copyFileSync(path.join(root, 'fonts/OFL.txt'), path.join(out, 'OFL.txt'));
process.stdout.write(`built the panel in ${path.relative(process.cwd(), out)}\n`);
