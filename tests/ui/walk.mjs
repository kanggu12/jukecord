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
import zlib from 'node:zlib';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://jk-ui:8795';
const OUT = process.env.OUT ?? '/out';
const TOKEN = fs.readFileSync(process.env.TOKEN_FILE ?? '/data/host-token', 'utf8').trim();
const AUDIT = fs.readFileSync(new URL('./audit.js', import.meta.url), 'utf8');
// axe-core, installed beside this script by run.sh: the accessibility rules (names, roles, landmarks, headings) on the
// pages that are also photographed. Required: a walk without it would pass without checking them.
const AXE = fs.readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
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
// Only some states, for a quick look while working on one (ONLY=toast,menu tests/ui/run.sh <folder>): the other
// states, the README's pictures and the playing-along check are skipped; ONLY=readme takes the README's pictures
// alone. A whole walk leaves it unset.
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
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

// A page logged in as the host, in a theme, a language and a size; a touch screen up to the narrowest tablet, unless
// said otherwise (a tablet held sideways is wide and touched).
async function open({
  width,
  height,
  theme,
  lang,
  login = true,
  motion = 'off',
  discord = false,
  touch = width <= 744,
  forced = false,
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale: lang === 'ko' ? 'ko-KR' : 'en-US',
    isMobile: touch,
    hasTouch: touch,
    // A contrast theme, as Windows has: the system's few colours on every surface.
    ...(forced ? { forcedColors: 'active' } : {}),
  });
  await context.addInitScript(
    ([lang, motion]) => {
      localStorage.setItem('jukecord.lang', lang);
      localStorage.setItem('jukecord.motion', motion);
    },
    [lang, motion],
  );
  const page = await context.newPage();
  if (discord) await asDiscord(page, discord === true ? {} : discord);
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
    // The accessibility rules, on the same pages (each rule once per page, with where it failed first).
    await page.evaluate(AXE);
    const axe = await page.evaluate(
      async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations,
    );
    for (const rule of axe) {
      result.findings.push({
        kind: 'a11y',
        where: `${rule.id}: ${rule.nodes[0]?.target.join(' ') ?? ''}`,
        detail: rule.help,
      });
    }
  }
  const count = result.findings.length + errors.length;
  if (count > 0) process.stdout.write(`  ${label}: ${count}\n`);
}

// A state of the server, swept over every size, theme and language; `act` sets up the page (open a menu ...).
async function sweep(name, sizes, act, { discord = false, touch, forced = false } = {}) {
  if (ONLY && !ONLY.has(name)) return;
  process.stdout.write(`${name}\n`);
  for (const theme of ['dark', 'light']) {
    for (const lang of ['ko', 'en']) {
      for (const [width, height] of sizes) {
        const setting = { theme, lang, width, height };
        const { context, page, errors } = await open({
          ...setting,
          login: !name.startsWith('login'),
          discord,
          forced,
          ...(touch === undefined ? {} : { touch }),
        });
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

// A made-up Discord around the seeded server: what the panel shows when a bot is connected, which the walk's own
// server (browser-only) cannot. The server's answers pass through with the Discord parts put in: the status says a
// bot is connected, the login is a person's, the server has a name, and every live state carries voice channels and
// people listening in browsers. Every name and ID is made up; no picture is fetched (a person without one shows
// initials).
const MADE_UP = {
  me: { kind: 'user', id: '100000000000000001', name: 'Mina', avatar: null },
  bot: { id: '100000000000000009', name: 'jukecord', avatar: null },
  guild: 'Night Owls',
  voice: {
    current: { channelId: '200000000000000001', name: 'Lounge' },
    channels: [
      { id: '200000000000000001', name: 'Lounge', people: 4 },
      { id: '200000000000000002', name: 'Study room', people: 0 },
      { id: '200000000000000003', name: 'Late night, quiet please', people: 2 },
    ],
  },
  listeners: {
    people: [
      { id: '100000000000000001', name: 'Mina', avatar: null },
      { id: '100000000000000002', name: 'Joon', avatar: null },
      { id: '100000000000000003', name: 'Sol', avatar: null },
    ],
    count: 3,
  },
};
// Options: `name`, the logged-in person's display name, and `guild`, the server's name, in place of the usual ones;
// `control: false`, a person without the server's DJ role; `votes`, how a vote to skip stands in the state.
async function asDiscord(page, { name = MADE_UP.me.name, guild = MADE_UP.guild, control, votes } = {}) {
  await page.route(/\/api\/v1\/(status|me|guilds)(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const what = new URL(route.request().url()).pathname.split('/').pop();
    const json =
      what === 'status'
        ? { ...body, discord: true, mode: 'discord', login: { discord: true } }
        : what === 'me'
          ? { ...body, ...MADE_UP.me, name, bot: MADE_UP.bot }
          : body.map((entry) => ({
              ...entry,
              name: guild,
              icon: null,
              ...(control === false ? { mayControl: false } : {}),
            }));
    await route.fulfill({ response, json });
  });
  // The page's side of each socket, so a state can say something of its own to the page (madeUpSay below).
  page.madeUpSockets = [];
  await page.routeWebSocket(/\/api\/v1\/events/, (ws) => {
    page.madeUpSockets.push(ws);
    const server = ws.connectToServer();
    server.onMessage((message) => {
      let data;
      try {
        // A big message comes as gzip (the panel says it can unpack it): unpacked here, changed, passed on as text.
        data = JSON.parse(typeof message === 'string' ? message : zlib.gunzipSync(message).toString('utf8'));
      } catch {
        ws.send(message);
        return;
      }
      if (data.type === 'state') Object.assign(data, { voice: MADE_UP.voice, listeners: MADE_UP.listeners });
      if (data.type === 'state' && votes) data.votes = votes;
      if (data.type === 'voice') data.voice = MADE_UP.voice;
      if (data.type === 'listeners') data.listeners = MADE_UP.listeners;
      ws.send(JSON.stringify(data));
    });
    ws.onMessage((message) => server.send(message));
  });
}
// A live message of the walk's own to a page in the made-up Discord.
function madeUpSay(page, message) {
  for (const ws of page.madeUpSockets ?? []) ws.send(JSON.stringify({ v: 1, guild: 'local', ...message }));
}

// ---- the walk ---------------------------------------------------------------------------------------------------
await api('POST', '/guilds/local/player/stop').catch(() => {});
await sweep('idle', SIZES);
await sweep('login', FEW);

await api('POST', '/guilds/local/player/resume');
await until('playing');
await sweep('playing', SIZES);
await sweep('discord', SIZES, null, { discord: true });
// The longest names Discord allows its people (32 letters) and a long server name, where the bar shows both: the
// bar holds them on one line without the page growing wider than the screen.
await sweep(
  'long-names',
  [
    [360, 780],
    [561, 900],
    [600, 900],
    [1024, 768],
  ],
  null,
  { discord: { name: 'Maximilian Alexander von Hohenau', guild: 'The Late Night Listening Society' } },
);
// A phone with a notch and a home bar, held upright and sideways (its safe-area insets, emulated by the browser): the
// bars' keys stay clear of them, and the cards of the screen's sides.
const NOTCH = { 390: { top: 47, right: 0, bottom: 34, left: 0 }, 844: { top: 0, right: 47, bottom: 21, left: 47 } };
await sweep(
  'notch',
  [
    [390, 844],
    [844, 390],
  ],
  async (page) => {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: NOTCH[page.viewportSize().width] });
    await page.reload();
    await page.waitForSelector('.app .card');
  },
  { touch: true },
);
// A tablet held sideways: wide, touched, and short (its keys a finger's size): the queue must still show rows.
await sweep(
  'tablet',
  [
    [1024, 768],
    [1180, 820],
    [1366, 950],
  ],
  null,
  { discord: true, touch: true },
);

// The README's pictures: the player with a Discord bot while a track plays, in each theme, 1600 wide (the queue's
// tools keep their words) at 1.6 times the pixels (full colour, no quantising: a reduced palette turns the shadows
// into steps).
for (const theme of ONLY && !ONLY.has('readme') ? [] : ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1.6,
    colorScheme: theme,
    locale: 'en-US',
  });
  await context.addInitScript(() => localStorage.setItem('jukecord.lang', 'en'));
  const page = await context.newPage();
  await asDiscord(page);
  const link = await api('POST', '/login-links');
  await page.goto(link.url.replace(new URL(link.url).origin, BASE));
  await page.waitForSelector('.history .row');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `readme-panel-${theme}.png`) });
  await context.close();
}

// And on a phone: the player listening along, the queue, and the statistics, each a picture of its own (the README's
// figure puts them side by side).
for (const theme of ONLY && !ONLY.has('readme') ? [] : ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: 'en-US',
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(() => localStorage.setItem('jukecord.lang', 'en'));
  const page = await context.newPage();
  await asDiscord(page);
  const link = await api('POST', '/login-links');
  await page.goto(link.url.replace(new URL(link.url).origin, BASE));
  await page.waitForSelector('.history .row');
  await page.click('[data-act="listen"]');
  await page.waitForFunction(
    () => document.querySelector('.listen .what span')?.textContent?.includes('In time'),
    null,
    {
      timeout: 15000,
    },
  );
  await page.evaluate(() => document.fonts.ready);
  const shot = async (n) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `readme-phone-${n}-${theme}.png`) });
  };
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(1);
  await page.evaluate(() => document.querySelector('#queue-h')?.closest('.card')?.scrollIntoView({ block: 'start' }));
  await shot(2);
  await page.click('a[data-route="stats"]').catch(() => page.goto(`${BASE}/stats`));
  await page.waitForSelector('.tiles');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(3);
  await context.close();
}

// Playing along: the audio must actually start and keep in time.
if (!ONLY) {
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
// A short window (a laptop's page zoomed to 200 %, with a mouse): the shortcuts' list fits in the dialog, or the
// keyboard can scroll it.
await sweep(
  'shortcuts-short',
  [
    [640, 400],
    [640, 320],
  ],
  async (page) => {
    await page.keyboard.press('?');
    await page.waitForSelector('.dialog kbd');
  },
  { touch: false },
);
// Phones and the tablet, where width is short: a toast (Remove duplicates says how many went) under the bar.
const NARROW = [
  [360, 780],
  [412, 915],
  [744, 1000],
];
await sweep('toast', NARROW, async (page) => {
  await tool(page, 'dedupe');
  await page.waitForSelector('.toast');
});
await sweep(
  'toast-discord',
  NARROW,
  async (page) => {
    await tool(page, 'dedupe');
    await page.waitForSelector('.toast');
  },
  { discord: true },
);
// A toast raised over a layer: jukecord's long refusal (a live error message, put in by standing between the page
// and its connection). With the menu open (on a narrow window the bar's strip hangs over the sheet, and must show over
// it), and with a dialog open (its shade covers the bar: the dialog says it).
const LONG_REFUSAL = 'jukecord runs without a Discord bot here, so it cannot join voice';
async function refusal(page) {
  const inject = await intercept(page);
  await page.reload();
  await page.waitForSelector('.app .card');
  // Connected, so the message comes as the live connection's.
  await page.waitForSelector('.bar .pill.tone-idle');
  return () => inject({ type: 'error', message: LONG_REFUSAL });
}
await sweep('menu-toast', NARROW, async (page) => {
  const raise = await refusal(page);
  await page.click('[data-act="menu"]');
  await page.waitForSelector('.sheet .section');
  raise();
  await page.waitForSelector('.toast');
  await page.waitForTimeout(300);
});
await sweep('dialog-toast', FEW, async (page) => {
  const raise = await refusal(page);
  await tool(page, 'load');
  await page.waitForSelector('.dialog .channel');
  raise();
  // Wherever it is said: the instrument tells whether it can be seen.
  await page.waitForSelector('.toast');
  await page.waitForTimeout(300);
});
// The same long reason in the bar of a wide window, beside the made-up server's name: on two lines.
await sweep(
  'toast-wide',
  [
    [1024, 768],
    [1440, 900],
  ],
  async (page) => {
    // Connected, so the message comes as the live connection's.
    await page.waitForSelector('.bar .pill.tone-play');
    madeUpSay(page, { type: 'error', message: LONG_REFUSAL });
    await page.waitForSelector('.toast');
    await page.waitForTimeout(300);
  },
  { discord: true },
);
// The Discord login on a phone: its key, a finger's size.
await sweep('login-discord', [[360, 780]], null, { discord: true });
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
// A contrast theme: the menu over the player (its choices, the switch; the seek bar under it) and the statistics (the
// charts' bars and the meters), every state still told apart.
await sweep(
  'forced',
  FEW,
  async (page) => {
    await page.click('[data-act="menu"]');
    await page.waitForSelector('.sheet .section');
    await page.waitForTimeout(400);
  },
  { forced: true },
);
await sweep(
  'forced-stats',
  FEW,
  async (page) => {
    await page.goto(`${BASE}/stats`);
    await page.waitForSelector('.bars .slot');
  },
  { forced: true },
);
await sweep('stats', SIZES, async (page) => {
  // The link in the bar on a wide window; on a narrow one the links are in the menu, so the address itself (waiting
  // for a hidden link to become pressable would take half a minute a page).
  const link = page.locator('.bar a[data-route="stats"]');
  if (await link.isVisible()) await link.click();
  else await page.goto(`${BASE}/stats`);
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
      // As the server says it: the track's title and a short reason (core/reasons.ts).
      error: 'Neon Rain: the site answered 404',
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
// The seed's longest title playing, on phones and the tablet: the bar at the bottom shows it on one line.
{
  const queue = await api('GET', '/guilds/local/queue');
  const long = queue.items.find((item) => item.track.title.length > 60);
  if (long) await api('POST', `/guilds/local/queue/${long.id}/play`).catch(() => {});
  await until('playing');
  await sweep('long-title', NARROW);
}
// A queue of two hundred tracks (saved playlists loaded over and over).
for (let i = 0; i < 16; i += 1) await api('POST', '/guilds/local/playlists/Friday%20night/load', { at: 'end' });
await sweep('long-queue', FEW);
await api('DELETE', '/guilds/local/queue');
await api('POST', '/guilds/local/player/stop').catch(() => {});
await sweep('empty', FEW);

// ---- how people share the music, and the sound -------------------------------------------------------------------
// A queue and a track playing again (the walk above left the queue empty and the player stopped).
await api('POST', '/guilds/local/playlists/Friday%20night/load', { at: 'end' });
await api('POST', '/guilds/local/player/resume').catch(() => {});
await until('playing');
// Someone without the DJ role, with a vote to skip under way: the Skip key says how it stands, at every width (the
// count stays on the key when a narrow row shows icons alone).
await sweep('vote-skip', SIZES, null, { discord: { control: false, votes: { on: true, votes: 1, needed: 2 } } });
// The menu of someone who manages the server, with the server's settings under the DJ role.
await sweep(
  'menu-settings',
  FEW,
  async (page) => {
    await page.click('[data-act="menu"]');
    await page.waitForSelector('.sheet .settings .switch');
    await page.waitForTimeout(400);
  },
  { discord: true },
);
// Take turns now from the queue's tools (its own key on a wide card, the list behind the tools key on a narrow one),
// and the toast that says what moved.
await sweep('take-turns', [...NARROW, [1440, 900]], async (page) => {
  await tool(page, 'turns');
  await page.waitForSelector('.toast');
});
// The voice channel's sound: the volume and a preset on, in the voice card, and the presets' dialog open over it.
await api('PUT', '/guilds/local/voice/volume', { percent: 120 });
await api('PUT', '/guilds/local/voice/sound', { preset: 'night' });
await sweep(
  'sound-dialog',
  FEW,
  async (page) => {
    await page.locator('[data-act="sound"]').scrollIntoViewIfNeeded();
    await page.click('[data-act="sound"]');
    await page.waitForSelector('.dialog [data-preset]');
    await page.waitForTimeout(300);
  },
  { discord: true },
);
// Playing along as a sound comes and goes: the plain sound (no WebAudio at all), a sound put on while listening (the
// press of Listen lets WebAudio run without another), and another: each time the audio still keeps in time.
if (!ONLY || ONLY.has('listening-sound')) {
  await api('PUT', '/guilds/local/voice/sound', { preset: 'off' });
  const { context, page, errors } = await open({ width: 1440, height: 900, theme: 'dark', lang: 'en', motion: 'on' });
  await page.click('[data-act="listen"]');
  let synced = false;
  for (let i = 0; i < 40 && !synced; i += 1) {
    await page.waitForTimeout(250);
    synced = await page.evaluate(() => document.querySelector('.listen .what span')?.textContent?.includes('In time'));
  }
  let still = true;
  for (const preset of ['night', 'bass']) {
    await api('PUT', '/guilds/local/voice/sound', { preset });
    await page.waitForTimeout(2500);
    still &&= await page.evaluate(() => document.querySelector('.listen .what span')?.textContent?.includes('In time'));
  }
  report.push({
    state: 'listening-sound',
    theme: 'dark',
    lang: 'en',
    width: 1440,
    findings:
      synced && still ? [] : [{ kind: 'listen', where: 'listen bar', detail: 'not in sync with a sound preset on' }],
    errors,
  });
  process.stdout.write(`listening with a preset: ${synced && still ? 'in sync' : 'NOT in sync'}\n`);
  await context.close();
}
await api('PUT', '/guilds/local/voice/sound', { preset: 'off' });
await api('PUT', '/guilds/local/voice/volume', { percent: 100 });

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
