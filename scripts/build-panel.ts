/**
 * Builds the panel into panel/dist: the TypeScript bundled into one script, the CSS into one stylesheet, the font's
 * pieces into fonts/, the page and the icon copied over, and a Brotli and a gzip copy of each text file.
 *
 *   npm run build
 *
 * The script and the stylesheet keep their names: the server sends them with "no-cache", so browsers check for a new
 * version (a cheap 304) and never run an old script against a new API. The font's pieces carry a hash of their content
 * in their names, so browsers keep them for good and fetch only the pieces a page's characters need.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
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
  // The font's pieces go into fonts/ with their content's hash in their names, so browsers may keep them for good.
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  logLevel: 'warning',
});

for (const file of ['index.html', 'favicon.svg', 'theme.js'])
  fs.copyFileSync(path.join(root, file), path.join(out, file));
// The font's licence travels with the font.
fs.copyFileSync(path.join(root, 'fonts/OFL.txt'), path.join(out, 'OFL.txt'));

// Each text file also compressed, Brotli and gzip, once here: the server sends the one a browser takes (see
// preCompressed in src/web/server.ts) and spends no time compressing. Fonts are compressed already; source maps are
// fetched only by a browser's developer tools.
for (const name of fs.readdirSync(out)) {
  if (!/\.(js|css|html|svg|txt)$/.test(name)) continue;
  const file = path.join(out, name);
  const data = fs.readFileSync(file);
  fs.writeFileSync(
    `${file}.br`,
    zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
  );
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(data, { level: 9 }));
}
process.stdout.write(`built the panel in ${path.relative(process.cwd(), out)}\n`);
