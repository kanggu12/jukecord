/**
 * Draws the installed panel's icons from the mark (panel/favicon.svg) with Playwright's Chromium, into panel/icons:
 * the app's own icon at the two sizes browsers ask for (a dark tile with the mark), the same as a maskable icon (the
 * tile to the edges, the mark inside the middle 80 % a launcher may cut its own shape from), and the one a phone's
 * home screen takes from Safari. Run when the mark changes:
 *
 *   docker run --rm -v "$PWD:/w" -w /tmp mcr.microsoft.com/playwright:v1.60.0-noble \
 *     sh -c 'npm i --silent playwright@1.60.0 >/dev/null 2>&1 && cp /w/tests/ui/icons.mjs . && node icons.mjs /w/panel/icons'
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'panel/icons';
fs.mkdirSync(out, { recursive: true });

// The mark as the favicon draws it, the record in the light ink of the dark theme (the tile is dark in both themes).
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 7 48 55">
  <defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#ff6f61"/><stop offset=".26" stop-color="#ffb84d"/><stop offset=".5" stop-color="#4fcf86"/>
    <stop offset=".74" stop-color="#4aa3ff"/><stop offset="1" stop-color="#a77bff"/></linearGradient></defs>
  <path d="M12 61V31a20 20 0 0 1 40 0v30" fill="none" stroke="url(#a)" stroke-width="7.5"/>
  <path fill="#e3e4e5" fill-rule="evenodd" d="M32 26.5a12.5 12.5 0 1 1 0 25a12.5 12.5 0 1 1 0-25zM32 34.4a4.6 4.6 0 1 0 0 9.2a4.6 4.6 0 1 0 0-9.2zM32 37.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z"/>
</svg>`;

// One icon: its side in pixels, how much of the side the mark takes, and whether the tile has rounded corners.
const ICONS = [
  { file: 'icon-192.png', side: 192, mark: 0.62, rounded: true },
  { file: 'icon-512.png', side: 512, mark: 0.62, rounded: true },
  { file: 'maskable-192.png', side: 192, mark: 0.5, rounded: false },
  { file: 'maskable-512.png', side: 512, mark: 0.5, rounded: false },
  { file: 'apple-touch-icon.png', side: 180, mark: 0.58, rounded: false },
];

const browser = await chromium.launch();
for (const icon of ICONS) {
  const page = await browser.newPage({ viewport: { width: icon.side, height: icon.side }, deviceScaleFactor: 1 });
  // The tile: the panel's dark field with a soft light from the top, as behind the cards.
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:${icon.side}px;height:${icon.side}px;display:grid;place-items:center;
      border-radius:${icon.rounded ? icon.side * 0.22 : 0}px;
      background:radial-gradient(ellipse 90% 70% at 50% 0%, #23263a 0%, transparent 70%), #0d0e12">
      <div style="width:${icon.side * icon.mark}px;height:${icon.side * icon.mark}px;display:grid;place-items:center">
        ${MARK.replace('<svg ', `<svg width="${icon.side * icon.mark * (48 / 55)}" height="${icon.side * icon.mark}" `)}
      </div>
    </div></body></html>`);
  await page.screenshot({ path: path.join(out, icon.file), omitBackground: true });
  await page.close();
  process.stdout.write(`${icon.file}\n`);
}
await browser.close();
