/**
 * Walks the panel through its states at many window sizes, in both themes and both languages, measuring each with
 * tests/ui/audit.js and photographing some, and plays along in the browser to check that the audio really starts.
 *
 *   BASE=http://jk-ui:8795 TOKEN_FILE=/data/host-token OUT=/out node walk.mjs
 *
 * Run by tests/ui/run.sh inside the Playwright image, against a jukecord seeded by tests/ui/seed.ts. The server's
 * state (playing, paused, an empty queue) is set through the API; states that need a particular message (loading
 * at 42 %, a failed track, a lost connection) are made by standing between the page and its WebSocket.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://jk-ui:8795';
const OUT = process.env.OUT ?? '/out';
const TOKEN = fs.readFileSync(process.env.TOKEN_FILE ?? '/data/host-token', 'utf8').trim();
const AUDIT = fs.readFileSync(new URL('./audit.js', import.meta.url), 'utf8');
// Phones, the narrowest tablet, laptops, and the big screens (2560 is a 4K screen at 150 %).
const SIZES = [
  [360, 780],
  [412, 915],
  [744, 1000],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
  [2560, 1400],
];
const FEW = [
  [390, 844],
  [1024, 768],
  [1440, 900],
];
const SHOOT = new Set([412, 390, 1440]);
const report = [];
fs.mkdirSync(OUT, { recursive: true });

// The API with the host token.
async function api(method, url, body) {
  const response = await fetch(`${BASE}/api/v1${url}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// Waits until the player is in a state.
async function until(status) {
  for (let i = 0; i < 50; i += 1) {
    if ((await api('GET', '/guilds/local/player')).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the player did not become ${status}`);
}

const browser = await chromium.launch();

// A page logged in as the host, in a theme, a language and a size.
async function open({ width, height, theme, lang, login = true, motion = 'off' }) {
  const touch = width <= 744;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale: lang === 'ko' ? 'ko-KR' : 'en-US',
    isMobile: touch,
    hasTouch: touch,
  });
  await context.addInitScript(
    ([lang, motion]) => {
      localStorage.setItem('jukecord.lang', lang);
      localStorage.setItem('jukecord.motion', motion);
    },
    [lang, motion],
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text());
  });
  if (login) {
    const link = await api('POST', '/login-links');
    await page.goto(link.url.replace(new URL(link.url).origin, BASE));
    await page.waitForSelector('.app .card', { timeout: 15000 });
  } else {
    await page.goto(`${BASE}/login`);
    await page.waitForSelector('.login .card');
  }
  return { context, page, errors };
}

// Measures the page as it is now, and photographs it at some widths.
async function measure(page, name, setting, errors) {
  // Fonts, pictures and the first requests settle first; a measurement mid-load reports nonsense.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  // Through the debugging protocol: the panel's content security policy (rightly) refuses inline scripts.
  await page.evaluate(AUDIT);
  const result = await page.evaluate(() => window.__audit());
  const label = `${name} ${setting.theme} ${setting.lang} ${setting.width}`;
  report.push({ state: name, ...setting, findings: result.findings, sizes: result.sizes, errors: [...errors] });
  if (SHOOT.has(setting.width) || (name === 'idle' && setting.width === 2560)) {
    await page.screenshot({ path: path.join(OUT, `${name}-${setting.theme}-${setting.lang}-${setting.width}.png`) });
  }
  const count = result.findings.length + errors.length;
  if (count > 0) process.stdout.write(`  ${label}: ${count}\n`);
}

// A state of the server, swept over every size, theme and language; `act` sets up the page (open a menu ...).
async function sweep(name, sizes, act) {
  process.stdout.write(`${name}\n`);
  for (const theme of ['dark', 'light']) {
    for (const lang of ['ko', 'en']) {
      for (const [width, height] of sizes) {
        const setting = { theme, lang, width, height };
        const { context, page, errors } = await open({ ...setting, login: name !== 'login' });
        try {
          if (act) await act(page);
          await measure(page, name, setting, errors);
        } catch (error) {
          report.push({
            state: name,
            ...setting,
            findings: [{ kind: 'walk', where: name, detail: String(error) }],
            errors,
          });
          process.stdout.write(`  ${name} ${theme} ${lang} ${width}: the walk failed: ${error}\n`);
        } finally {
          await context.close();
        }
      }
    }
  }
}

// Stands between the page and its live connection, passing everything through, and returns a way to add messages.
async function intercept(page) {
  const sockets = [];
  await page.routeWebSocket(/\/api\/v1\/events/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => ws.send(message));
    ws.onMessage((message) => server.send(message));
    sockets.push(ws);
  });
  return (message) => {
    for (const ws of sockets) ws.send(JSON.stringify({ v: 1, guild: 'local', ...message }));
  };
}

// ---- the walk ---------------------------------------------------------------------------------------------------
await api('POST', '/guilds/local/player/stop').catch(() => {});
await sweep('idle', SIZES);
await sweep('login', FEW);

await api('POST', '/guilds/local/player/resume');
await until('playing');
await sweep('playing', SIZES);

// The README's pictures: the player while a track plays, in each theme, at twice the pixels (full colour, no
// quantising: a reduced palette turns the shadows into steps).
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: 'en-US',
  });
  await context.addInitScript(() => localStorage.setItem('jukecord.lang', 'en'));
  const page = await context.newPage();
  const link = await api('POST', '/login-links');
  await page.goto(link.url.replace(new URL(link.url).origin, BASE));
  await page.waitForSelector('.history .row');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `readme-panel-${theme}.png`) });
  await context.close();
}

// Playing along: the audio must actually start and keep in time.
{
  const { context, page, errors } = await open({ width: 1440, height: 900, theme: 'dark', lang: 'en', motion: 'on' });
  await page.click('[data-act="listen"]');
  let synced = false;
  for (let i = 0; i < 40 && !synced; i += 1) {
    await page.waitForTimeout(250);
    synced = await page.evaluate(() => document.querySelector('.listen .what span')?.textContent?.includes('In time'));
  }
  const audio = await page.evaluate(() => {
    const element = document.querySelector('audio') ?? [...document.querySelectorAll('*')].find(() => false);
    return element ? { paused: element.paused, time: element.currentTime } : null;
  });
  report.push({
    state: 'listening',
    theme: 'dark',
    lang: 'en',
    width: 1440,
    findings: synced ? [] : [{ kind: 'listen', where: 'listen bar', detail: 'never in sync' }],
    errors,
    audio,
  });
  process.stdout.write(`listening: ${synced ? 'in sync' : 'NOT in sync'}\n`);
  await page.screenshot({ path: path.join(OUT, 'listening-dark-en-1440.png') });
  await context.close();
}

await api('POST', '/guilds/local/player/pause');
await until('paused');
await sweep('paused', SIZES);
await sweep('menu', FEW, async (page) => {
  await page.click('[data-act="menu"]');
  await page.waitForSelector('.sheet .section');
  await page.waitForTimeout(400);
});
// A queue tool: its own key on a wide card, the list behind the tools key on a narrow one (phones).
async function tool(page, act) {
  const key = page.locator(`[data-act="${act}"]`);
  if (await key.isVisible()) {
    await key.click();
    return;
  }
  await page.click('[data-act="queue-tools"]');
  await page.click(`.dialog [data-tool="${act}"]`);
}

await sweep('clear-dialog', FEW, async (page) => {
  await tool(page, 'clear');
  await page.waitForSelector('.dialog');
});
await sweep('playlists', FEW, async (page) => {
  await tool(page, 'load');
  await page.waitForSelector('.dialog .channel');
});
await sweep('shortcuts', FEW, async (page) => {
  await page.keyboard.press('?');
  await page.waitForSelector('.dialog kbd');
});
// A queued track's keys on a phone, behind the row's one key.
await sweep(
  'track-menu',
  [
    [360, 780],
    [390, 844],
  ],
  async (page) => {
    await page.locator('.row .more-key:visible').first().click();
    await page.waitForSelector('.dialog .menu-list .choice');
  },
);
await sweep('stats', SIZES, async (page) => {
  await page.click('a[data-route="stats"]').catch(() => page.goto(`${BASE}/stats`));
  await page.waitForSelector('.tiles');
});
await sweep('stats-tip', FEW, async (page) => {
  await page.goto(`${BASE}/stats`);
  await page.waitForSelector('.bars .slot');
  // In the middle of the window, as a person would have it when pointing at it (not under the bottom bar).
  await page
    .locator('.bars')
    .first()
    .evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.hover('.bars .slot:not(.zero) >> nth=-1');
});
await sweep('logs', FEW, async (page) => {
  await page.goto(`${BASE}/logs`);
  await page.waitForSelector('.logs');
});
await sweep('loading', FEW, async (page) => {
  const inject = await intercept(page);
  await page.reload();
  await page.waitForSelector('.app .card');
  await page.waitForTimeout(300);
  const player = await api('GET', '/guilds/local/player');
  inject({ type: 'player', player: { ...player, status: 'loading', progress: 0.42, version: player.version + 1000 } });
  await page.waitForTimeout(200);
});
await sweep('failed', FEW, async (page) => {
  const inject = await intercept(page);
  await page.reload();
  await page.waitForSelector('.app .card');
  await page.waitForTimeout(300);
  const player = await api('GET', '/guilds/local/player');
  inject({
    type: 'player',
    player: {
      ...player,
      status: 'idle',
      track: null,
      error: 'yt-dlp failed: ERROR: [generic] Unable to download webpage: HTTP Error 404',
      version: player.version + 1000,
    },
  });
  await page.waitForTimeout(200);
});
await sweep('disconnected', FEW, async (page) => {
  await page.routeWebSocket(/\/api\/v1\/events/, (ws) => ws.close({ code: 1006, reason: 'gone' }).catch(() => {}));
  await page.reload();
  await page.waitForSelector('.app .card');
  await page.waitForTimeout(1500);
});
// A queue of two hundred tracks (saved playlists loaded over and over).
for (let i = 0; i < 16; i += 1) await api('POST', '/guilds/local/playlists/Friday%20night/load', { at: 'end' });
await sweep('long-queue', FEW);
await api('DELETE', '/guilds/local/queue');
await api('POST', '/guilds/local/player/stop').catch(() => {});
await sweep('empty', FEW);

await browser.close();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

// The summary: findings by kind, then each distinct finding once with where it happened.
const all = report.flatMap((entry) =>
  entry.findings.map((finding) => ({ ...finding, at: `${entry.state} ${entry.theme} ${entry.lang} ${entry.width}` })),
);
const errors = report.flatMap((entry) =>
  (entry.errors ?? []).map((error) => ({ error, at: `${entry.state} ${entry.width}` })),
);
const kinds = {};
for (const finding of all) kinds[finding.kind] = (kinds[finding.kind] ?? 0) + 1;
process.stdout.write(
  `\npages measured: ${report.length}, findings: ${all.length}, page errors: ${errors.length}\n${JSON.stringify(kinds)}\n`,
);
const distinct = new Map();
for (const finding of all) {
  const key = `${finding.kind} ${finding.where} ${finding.detail.replace(/[\d.]+/g, '#')}`;
  if (!distinct.has(key)) distinct.set(key, { ...finding, count: 0, first: finding.at });
  distinct.get(key).count += 1;
}
for (const entry of [...distinct.values()].slice(0, 80)) {
  process.stdout.write(`- [${entry.kind}] ${entry.where}: ${entry.detail} (x${entry.count}, first ${entry.first})\n`);
}
for (const entry of errors.slice(0, 10)) process.stdout.write(`! ${entry.at}: ${entry.error}\n`);
