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
const SHOOT = new Set([412, 390, 1440, 1366]);
// Only some states, for a quick look while working on one (ONLY=toast,menu tests/ui/run.sh <folder>): the other
// states, the README's pictures and the playing-along check are skipped; ONLY=readme takes the README's pictures
// alone, ONLY=pictures the panel's pictures and ONLY=listening the playing-along check. A whole walk leaves it unset,
// or walks in groups at once whose names together are every state and those three.
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
  // Lyrics come from the walk itself: its server would ask LRCLIB, and the walk reaches no site.
  await madeUpLyrics(page);
  if (discord) await asDiscord(page, discord === true ? {} : discord);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // A state may say which errors it causes on purpose (a refused request's "Failed to load resource" line).
    const expected = (page.expectedErrors ?? []).some((pattern) => pattern.test(message.text()));
    if (message.type() === 'error' && !message.text().includes('favicon') && !expected) errors.push(message.text());
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
  report.push({
    state: name,
    ...setting,
    findings: result.findings,
    sizes: result.sizes,
    // How many different font sizes, control heights, corners, paddings and gaps the page shows, and which.
    distinct: result.distinct,
    errors: [...errors],
  });
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
async function sweep(name, sizes, act, { discord = false, touch, forced = false, login } = {}) {
  if (ONLY && !ONLY.has(name)) return;
  process.stdout.write(`${name}\n`);
  for (const theme of ['dark', 'light']) {
    for (const lang of ['ko', 'en']) {
      for (const [width, height] of sizes) {
        const setting = { theme, lang, width, height };
        const { context, page, errors } = await open({
          ...setting,
          // Logged in as the host, but on the login page's states and where a state logs in its own way (a guest).
          login: login ?? !name.startsWith('login'),
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
  // The server's roles and the text channels the bot may post in, for the menu of someone who manages the server.
  roles: [
    { id: '500000000000000001', name: 'DJ', color: 0x3d7be0 },
    { id: '500000000000000002', name: 'Night shift', color: 0 },
  ],
  channels: [
    { id: '600000000000000001', name: 'jukecord-alerts' },
    { id: '600000000000000002', name: 'general' },
  ],
};
// Options: `name`, the logged-in person's display name, and `guild`, the server's name, in place of the usual ones;
// `view`, a person who may only look (no DJ role, no Manage Server); `listeners`, the people listening in browsers;
// `control: false`, a person without the server's DJ role; `votes`, how a vote to skip stands in the state; `djRole`,
// a server whose DJ role is chosen (the menu's settings say how Skip works then).
async function asDiscord(
  page,
  {
    name = MADE_UP.me.name,
    guild = MADE_UP.guild,
    view = false,
    listeners = MADE_UP.listeners,
    control,
    votes,
    djRole = false,
  } = {},
) {
  await page.route(/\/api\/v1\/(status|me|guilds|guilds\/[^/]+\/settings)(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const what = new URL(route.request().url()).pathname.split('/').pop();
    const json =
      what === 'status'
        ? { ...body, discord: true, mode: 'discord', login: { discord: true } }
        : what === 'me'
          ? { ...body, ...MADE_UP.me, name, bot: MADE_UP.bot }
          : what === 'settings'
            ? {
                ...body,
                roles: MADE_UP.roles,
                channels: MADE_UP.channels,
                alertsChannelId: MADE_UP.channels[0].id,
                ...(djRole ? { djRoleId: MADE_UP.roles[0].id } : {}),
              }
            : body.map((entry) => ({
                ...entry,
                name: guild,
                icon: null,
                ...(view ? { mayControl: false, mayManage: false } : {}),
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
      if (data.type === 'state') Object.assign(data, { voice: MADE_UP.voice, listeners });
      if (data.type === 'state' && votes) data.votes = votes;
      if (data.type === 'voice') data.voice = MADE_UP.voice;
      if (data.type === 'listeners') data.listeners = listeners;
      ws.send(JSON.stringify(data));
    });
    ws.onMessage((message) => server.send(message));
  });
}
// A live message of the walk's own to a page in the made-up Discord.
function madeUpSay(page, message) {
  for (const ws of page.madeUpSockets ?? []) ws.send(JSON.stringify({ v: 1, guild: 'local', ...message }));
}

// Made-up lyrics for the track playing, in the shape the server gives them: a line every four seconds of the seeded
// three-minute tracks, so that one is being sung whenever a page looks. `page.lyricsKind` picks what the answer is
// (timed lines unless a state says otherwise). Every word is made up.
const LYRIC_LINES = [
  'Fold the morning into paper',
  'Set it down where the water bends',
  '',
  'Every boat a little letter',
  'Every letter never ends',
  '종이배에 아침을 접어 실어 보내',
  '강물이 굽는 곳까지 천천히',
  'Lanterns on the far side of the river, waiting for the last of the boats to come home again',
];
async function madeUpLyrics(page) {
  await page.route(/\/api\/v1\/guilds\/[^/]+\/lyrics$/, async (route) => {
    const player = await api('GET', '/guilds/local/player');
    const kind = page.lyricsKind ?? 'synced';
    const lines = Array.from({ length: 45 }, (_, index) => ({
      atMs: index * 4000,
      text: LYRIC_LINES[index % LYRIC_LINES.length],
    }));
    const json =
      kind === 'none'
        ? { trackId: player.track?.id ?? 0, kind, lines: [], text: null, source: null }
        : {
            trackId: player.track?.id ?? 0,
            kind,
            lines: kind === 'synced' ? lines : [],
            text: lines.map((line) => line.text).join('\n'),
            source: { name: 'LRCLIB', url: 'https://lrclib.net' },
          };
    await route.fulfill({ status: 200, contentType: 'application/json', json });
  });
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
// A tablet held sideways: wide, touched, and short (its keys a finger's size): the queue must still show rows. The
// voice card's keys of a finger's size keep apart from each other and from the lines between its rows (in rows as tall
// as the keys, the channels' Join keys were a pixel apart and the sound's key on the line above it).
await sweep(
  'tablet',
  [
    [1024, 768],
    [1180, 820],
    [1366, 950],
  ],
  async (page) => {
    await page.waitForSelector('.channels .channel .key');
    const close = await page.evaluate(() => {
      const card = document.querySelector('.card[aria-labelledby="voice-h"]');
      const keys = [...card.querySelectorAll('.key')]
        .filter((key) => key.getClientRects().length > 0)
        .map((key) => key.getBoundingClientRect());
      // The lines between the rows: the top edges of the rows that draw one.
      const lines = [...card.children]
        .filter((row) => Number.parseFloat(getComputedStyle(row).borderTopWidth) > 0)
        .map((row) => row.getBoundingClientRect().top);
      const found = [];
      for (const [index, key] of keys.entries()) {
        for (const other of keys.slice(index + 1)) {
          const side = Math.min(key.right, other.right) - Math.max(key.left, other.left);
          const apart = Math.max(other.top - key.bottom, key.top - other.bottom);
          if (side > 0 && apart < 4) found.push(`two keys ${apart.toFixed(1)} px apart`);
        }
        for (const line of lines) {
          const apart = Math.min(Math.abs(key.top - line), Math.abs(key.bottom - line));
          if (apart < 4) found.push(`a key ${apart.toFixed(1)} px from a line`);
        }
      }
      return found;
    });
    if (close.length > 0) throw new Error(`the voice card's keys are too close: ${close.join(', ')}`);
  },
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
    () => document.querySelector('.listen .what span')?.textContent?.includes('In sync'),
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
if (!ONLY || ONLY.has('listening')) {
  const { context, page, errors } = await open({ width: 1440, height: 900, theme: 'dark', lang: 'en', motion: 'on' });
  await page.click('[data-act="listen"]');
  let synced = false;
  for (let i = 0; i < 40 && !synced; i += 1) {
    await page.waitForTimeout(250);
    synced = await page.evaluate(() => document.querySelector('.listen .what span')?.textContent?.includes('In sync'));
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
// The saved playlists: each row one line of name over its count, Load, and one key for the rest. With three bare icons
// beside Load a phone's names wrapped ("Quiet / hours") and the rows were of different heights.
await sweep('playlists', FEW, async (page) => {
  await tool(page, 'load');
  await page.waitForSelector('.dialog .channel');
  const rows = await page.$$eval('.dialog .channel', (items) =>
    items.map((item) => {
      // The name's lines: one box each for the words of a line.
      const name = document.createRange();
      name.selectNodeContents(item.querySelector('.name > b'));
      return { height: item.getBoundingClientRect().height, lines: name.getClientRects().length };
    }),
  );
  if (new Set(rows.map((row) => Math.round(row.height))).size > 1)
    throw new Error(`playlist rows of different heights: ${rows.map((row) => row.height).join(', ')}`);
  if (rows.some((row) => row.lines > 1)) throw new Error('a playlist name wraps');
});
// A playlist's other keys, behind its row's key: rename, export and delete in words.
await sweep('playlist-menu', FEW, async (page) => {
  await tool(page, 'load');
  await page.locator('.dialog .channel [data-key="more"]').first().click();
  await page.waitForSelector('.dialog .choice[data-choice="delete"]');
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
// No colour on the page is drawn with a hue it lost. Mixed in oklch with transparent, a colour of little chroma (the
// inks, the light field) kept its chroma but lost its hue, which the browser drew at 0°, a rose: the light theme's
// bars were pink, its grey ink warm.
async function noLostHue(page) {
  const lost = await page.evaluate(() => {
    const found = new Set();
    for (const element of document.querySelectorAll('html, body, body *')) {
      for (const part of [null, '::before', '::after']) {
        const style = getComputedStyle(element, part);
        for (const value of [style.color, style.backgroundColor, style.borderTopColor, style.boxShadow])
          for (const match of value.matchAll(/oklch\(([\d.]+) ([\d.]+) none/g))
            if (Number(match[2]) > 0.003)
              found.add(`${element.tagName.toLowerCase()}.${element.classList[0] ?? ''}${part ?? ''}: ${match[0]}`);
      }
    }
    return [...found];
  });
  if (lost.length > 0) throw new Error(`colours drawn with a lost hue: ${lost.slice(0, 3).join(' | ')}`);
}
await sweep('stats', SIZES, async (page) => {
  // The link in the bar on a wide window; on a narrow one the links are in the menu, so the address itself (waiting
  // for a hidden link to become pressable would take half a minute a page).
  const link = page.locator('.bar a[data-route="stats"]');
  if (await link.isVisible()) await link.click();
  else await page.goto(`${BASE}/stats`);
  await page.waitForSelector('.tiles');
  // Every problem of the page said at once.
  const problems = [];
  await oneStyle(page).catch((error) => problems.push(error.message));
  // Each rank's count says what it counts (the people's are plays of what they added, which read as tracks added).
  const bare = await page.$$eval(
    '.ranks .n',
    (counts) => counts.filter((count) => /^\s*[\d,]+\s*$/.test(count.textContent ?? '')).length,
  );
  if (bare > 0) problems.push(`${bare} counts in the ranks with no unit`);
  await noLostHue(page).catch((error) => problems.push(error.message));
  if (problems.length > 0) throw new Error(problems.join('; '));
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
  // Every problem of the page said at once: the records' moments in the panel's style (a message says what it says),
  // and the look of the list and its head.
  const problems = [];
  await oneStyle(page, '.log > :last-child').catch((error) => problems.push(error.message));
  const look = await page.evaluate(() => ({
    // Colour on a record's level only for a warning or an error (an "Info" chip on every row said nothing).
    tinted: [...document.querySelectorAll('.log .badge')].filter(
      (badge) => !badge.classList.contains('plain') && !/tone-(pause|bad)/.test(badge.className),
    ).length,
    // Refresh says its word at every width (on a phone it was its icon alone).
    refresh: getComputedStyle(document.querySelector('.refresh-key .label') ?? document.body).display !== 'none',
    // The component right after the level: no wide hole between them (a fixed 64 px column left 40 px on a phone).
    hole: Math.max(
      0,
      ...[...document.querySelectorAll('.log')].slice(0, 20).map((log) => {
        const badge = log.querySelector('.badge')?.getBoundingClientRect();
        const component = log.children[2]?.getBoundingClientRect();
        const widest = Math.max(
          ...[...document.querySelectorAll('.log .badge')].map((b) => b.getBoundingClientRect().width),
        );
        return badge && component ? component.left - badge.left - widest : 0;
      }),
    ),
  }));
  if (look.tinted > 0) problems.push(`${look.tinted} log levels coloured though they are neither warnings nor errors`);
  if (!look.refresh) problems.push('Refresh shows its icon alone');
  if (look.hole > 12.5) problems.push(`${Math.round(look.hole)} px between the widest level and the component`);
  if (problems.length > 0) throw new Error(problems.join('; '));
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
// Nothing playing and nothing queued: the playing card has no key that would do nothing (Lyrics for no track, More
// offering to stop after it, a disabled Play the width of a phone's card).
await sweep('empty', FEW, async (page) => {
  const live = await page.evaluate(() =>
    [...document.querySelectorAll('.now .keys, [data-act="lyrics"], [data-act="now-more"]')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.dataset.act ?? 'the transport keys'),
  );
  if (live.length > 0) throw new Error(`with nothing to play, the playing card shows ${live.join(', ')}`);
});

// Wrapped: the seed's year of plays, the server's first month (a few plays), and a time with none; the times to
// choose from, the picture to save, and the page in a contrast theme.
const year = await api('GET', '/guilds/local/wrapped?period=last-12-months');
const firstMonth = year.months.at(-1) ?? 'last-12-months';
async function wrappedAt(page, period) {
  await page.goto(`${BASE}/stats/wrapped?period=${period}`);
  await page.waitForSelector('.wrapped .page-body > *');
}
// The page says one style of day, time and length (the 0.3.2 review found ISO days, a 12-hour clock beside a 24-hour
// one, and "1:09:00 in all" beside "6 h 42 min"): no "2025-11-13", no "9:53 PM" or "오후 9:53", no length as a clock
// but a track's own (in a row's line, a seek bar, a result). `skip` names what may hold other text (a log's message).
async function oneStyle(page, skip = '') {
  const wrong = await page.evaluate((skip) => {
    const main = document.querySelector('main:not([hidden])') ?? document.body;
    const hidden = skip ? [...main.querySelectorAll(skip)] : [];
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const found = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (hidden.some((element) => element.contains(node))) continue;
      const text = node.textContent ?? '';
      if (/\b\d{4}-\d{2}-\d{2}\b/.test(text) || /\d(\s|\u202f)?(AM|PM)\b|(오전|오후)\s?\d/.test(text)) found.push(text);
      // A length of time written as a clock beside words ("1:09:00 in all"); a track's m:ss stands alone in its span.
      if (/\d:\d{2}:\d{2}\s+in all|총\s+\d+:\d{2}/.test(text)) found.push(text);
    }
    return found;
  }, skip);
  if (wrong.length > 0)
    throw new Error(`a day, time or length off the panel's one style: ${wrong.slice(0, 3).join(' | ')}`);
}
// Wrapped says only what is true (the 0.3.2 review: "Busiest day: Sundays · 1 play" from a tie of one play each,
// "Time listened 5 min" over two days whose longest was "2 min"): a busiest day or hour only alone at the top and from
// a week of days with music, no song of the time among tracks played once each, the longest day's time at most the
// total and, times the days with music, at least the total; and on a wide window the first track's card is not a box
// as tall as the song's holding one small row.
async function wrappedIsTrue(page, period) {
  const facts = await page.evaluate(async (period) => {
    const tz = -new Date().getTimezoneOffset();
    const wrapped = await (await fetch(`/api/v1/guilds/local/wrapped?period=${period}&tz=${tz}`)).json();
    // Minutes in a length as the page writes it ("59 h 22 min", "59시간 22분", "45 s").
    const minutes = (text) => {
      const hours = /([\d,]+)\s*(h|시간)/.exec(text);
      const mins = /(\d+)\s*(min|분)/.exec(text);
      const secs = /(\d+)\s*(s|초)\b/.exec(text);
      return (
        (hours ? Number(hours[1].replace(/,/g, '')) * 60 : 0) +
        (mins ? Number(mins[1]) : 0) +
        (secs ? Number(secs[1]) / 60 : 0)
      );
    };
    const tiles = [...document.querySelectorAll('.wrapped .tiles:not(.moments) .tile')];
    const moments = [...document.querySelectorAll('.wrapped .moment')];
    const first = document.querySelector('.wrapped-first');
    const song = document.querySelector('.wrapped-song');
    const row = first?.querySelector('.row');
    const head = first?.querySelector('.card-head');
    return {
      wrapped,
      total: minutes(tiles[1]?.querySelector('.v')?.textContent ?? ''),
      // The longest day's tile is the one whose sub says a length and plays; the busiest ones have charts.
      longest: minutes(
        moments.find((tile) => !tile.querySelector('.spark') && tile.querySelector('.sub'))?.querySelector('.sub')
          ?.textContent ?? '',
      ),
      // The busiest day's chart has a column for each day of the week, the busiest hour's for each hour.
      day: moments.some((tile) => tile.querySelectorAll('.spark i').length === 7),
      hour: moments.some((tile) => tile.querySelectorAll('.spark i').length === 24),
      song: Boolean(song),
      side: Boolean(song && first && song.getBoundingClientRect().top === first.getBoundingClientRect().top),
      fill: row && first && head ? row.offsetHeight / (first.offsetHeight - head.offsetHeight) : 1,
    };
  }, period);
  const { wrapped } = facts;
  const alone = (values) => values.filter((value) => value === Math.max(...values)).length === 1;
  const problems = [];
  if ((facts.day || facts.hour) && wrapped.days < 7)
    problems.push(`a busiest moment from ${wrapped.days} days of music`);
  if (facts.day && !alone(wrapped.weekdays)) problems.push('a busiest day from a tie');
  if (facts.hour && !alone(wrapped.hours)) problems.push('a busiest hour from a tie');
  if (facts.song && (wrapped.song?.plays ?? 0) < 2) problems.push('a song of the time played once');
  if (wrapped.longestDay && facts.longest > facts.total)
    problems.push(`longest day ${facts.longest} min over ${facts.total}`);
  if (wrapped.longestDay && facts.longest * wrapped.days < facts.total)
    problems.push(`${wrapped.days} days of at most ${facts.longest} min under ${facts.total}`);
  if (facts.side && facts.fill < 0.5)
    problems.push(`the first track's row fills ${Math.round(facts.fill * 100)} % of its card`);
  if (problems.length > 0) throw new Error(`Wrapped says what is not true: ${problems.join('; ')}`);
}
// Wrapped at a time, and both checks on it, their problems said together.
async function wrappedChecked(page, period) {
  await wrappedAt(page, period);
  const problems = [];
  await wrappedIsTrue(page, period).catch((error) => problems.push(error.message));
  await oneStyle(page).catch((error) => problems.push(error.message));
  if (problems.length > 0) throw new Error(problems.join('; '));
}
await sweep('wrapped', SIZES, (page) => wrappedChecked(page, 'last-12-months'), { discord: true });
await sweep('wrapped-few', FEW, (page) => wrappedChecked(page, firstMonth), { discord: true });
await sweep('wrapped-empty', FEW, (page) => wrappedAt(page, '2020'));
await sweep('wrapped-periods', FEW, async (page) => {
  await wrappedAt(page, 'last-12-months');
  await page.click('[data-act="period"]');
  await page.waitForSelector('.dialog .choice');
});
await sweep(
  'wrapped-picture',
  FEW,
  async (page) => {
    await wrappedAt(page, 'last-12-months');
    await page.click('[data-act="picture"]');
    await page.waitForSelector('.picture-preview:not([hidden])', { timeout: 30000 });
  },
  { discord: true },
);
await sweep('forced-wrapped', FEW, (page) => wrappedAt(page, 'last-12-months'), { forced: true });
// The pictures themselves, saved at their full size to look at: both shapes, both themes and languages, from the
// year and from the first month.
for (const theme of ONLY && !ONLY.has('pictures') ? [] : ['dark', 'light']) {
  for (const lang of ['ko', 'en']) {
    for (const [name, period] of [
      ['year', 'last-12-months'],
      ['few', firstMonth],
    ]) {
      const setting = { theme, lang, width: 1440, height: 900 };
      const { context, page, errors } = await open({ ...setting, discord: true });
      const findings = [];
      try {
        await wrappedAt(page, period);
        await page.click('[data-act="picture"]');
        for (const shape of ['story', 'square']) {
          if (shape === 'square') await page.click('.picture .seg button:nth-child(2)');
          await page.waitForSelector('.picture-preview:not([hidden])', { timeout: 30000 });
          const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('[data-act="save-picture"]'),
          ]);
          await download.saveAs(path.join(OUT, `picture-${name}-${shape}-${theme}-${lang}.png`));
        }
      } catch (error) {
        findings.push({ kind: 'walk', where: `pictures ${name}`, detail: String(error) });
        process.stdout.write(`  pictures ${name} ${theme} ${lang}: ${error}\n`);
      } finally {
        report.push({ state: `pictures-${name}`, ...setting, findings, errors });
        await context.close();
      }
    }
  }
}
// ---- added in 0.3 ---------------------------------------------------------------------------------------------------
// Something to play again for the states below.
await api('POST', '/guilds/local/playlists/Friday%20night/load', { at: 'end' }).catch(() => {});
// What the player did by itself, under the title (paused with nobody listening), put in by standing between the page
// and its connection.
async function player(page, change) {
  const inject = await intercept(page);
  await page.reload();
  await page.waitForSelector('.app .card');
  await page.waitForTimeout(300);
  const now = await api('GET', '/guilds/local/player');
  const queue = await api('GET', '/guilds/local/queue');
  const track = now.track ?? queue.items[0]?.track ?? null;
  inject({ type: 'player', player: { ...now, track, ...change, version: now.version + 1000 } });
  await page.waitForTimeout(200);
}
await sweep('notice', FEW, async (page) => {
  await player(page, {
    status: 'paused',
    positionMs: 64_000,
    durationMs: 214_000,
    notice: 'paused with nobody listening',
  });
  await page.waitForSelector('.now .player-note:not([hidden])');
});
// A track whose fetch waits for its turn among every server's fetches.
await sweep('waiting', FEW, async (page) => {
  await player(page, { status: 'loading', positionMs: 0, progress: null, waiting: true });
});
// The server's choices in the menu: their names start at one place, whatever stands before them (Everyone's people icon
// and the roles' dots: the dots were 6 px narrower, and the roles' names 6 px left of Everyone), and the choice made is
// the brand's blue, its check and an "on" switch alike (they wore the play green beside the chosen segments' blue).
async function settingsLook(page) {
  const wrong = await page.evaluate(() => {
    const problems = [];
    const lefts = new Set(
      [...document.querySelectorAll('.sheet .choice[data-choice] > .grow')]
        .filter((label) => label.getClientRects().length > 0)
        .map((label) => Math.round(label.getBoundingClientRect().left)),
    );
    if (lefts.size > 1) problems.push(`the choices' names start at ${[...lefts].join(', ')}`);
    // The tokens as the browser writes them, to compare with what it computed.
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('i');
    document.body.append(probe);
    const colour = (token) => {
      probe.style.color = root.getPropertyValue(token);
      return getComputedStyle(probe).color;
    };
    const accent = colour('--accent');
    const key = colour('--key');
    probe.remove();
    for (const check of document.querySelectorAll(
      '.sheet .choice:is([aria-pressed="true"], [aria-checked="true"]) .check',
    ))
      if (getComputedStyle(check).color !== accent) problems.push(`a chosen check in ${getComputedStyle(check).color}`);
    for (const toggle of document.querySelectorAll('.sheet .switch[aria-checked="true"]')) {
      const track = getComputedStyle(toggle, '::before').backgroundColor;
      if (track !== key) problems.push(`an on switch in ${track}`);
    }
    return problems;
  });
  if (wrong.length > 0) throw new Error(wrong.join('; '));
}
// The menu of someone who manages the server, in the made-up Discord: the DJ role and the alerts channel.
await sweep(
  'menu-discord',
  FEW,
  async (page) => {
    await page.click('[data-act="menu"]');
    await page.waitForSelector('.sheet .section .choice[aria-pressed="true"] >> nth=1');
    await page.waitForTimeout(400);
    await settingsLook(page);
  },
  { discord: true },
);
// An add that does not go through (an address on a private network, which jukecord does not fetch): the reason under
// the field, said there alone (a toast in the bar said it a second time).
await sweep('add-failed', FEW, async (page) => {
  // The refusal is an answer of 400, which the browser reports on its console: expected here.
  page.expectedErrors = [/status of 400/];
  await page.fill('#add-input', 'http://10.0.0.1/tune');
  await page.click('.add [type="submit"]');
  await page.waitForSelector('.add-failed:not([hidden])');
  await page.waitForTimeout(300);
  if ((await page.locator('.toast').count()) > 0) throw new Error('the reason is said in a toast as well');
  // The add card's filled key is Add, what Enter does: Play now cuts off the track everyone is hearing.
  const filled = await page.locator('.add .key.primary').getAttribute('data-at');
  if (filled !== 'end') throw new Error(`the add card's filled key is "${filled}", not Add`);
});
// Someone who may only look, in the made-up Discord: no grips, no keys on the rows, the saved playlists to look at.
await sweep(
  'view-only',
  FEW,
  async (page) => {
    await tool(page, 'load');
    await page.waitForSelector('.dialog .channel');
  },
  { discord: { view: true } },
);
// The queue's tools say what they do in words (Shuffle, Take turns where there is room, and the key that lists the rest
// with theirs: as six bare icons on a short window, Take turns and Remove duplicates could not be told), on the line of
// the queue's title, so the queue under it keeps its rows (and on a wide window short of height, the search too).
async function toolsInWords(page) {
  const problems = await page.evaluate(() => {
    const tools = document.querySelector('.card-head .tools:has(> .tools-more)');
    const found = [...tools.querySelectorAll(':scope > .key:not(.tools-more)')]
      .filter((key) => key.getClientRects().length > 0 && !key.querySelector('.label')?.getClientRects().length)
      .map((key) => `${key.dataset.act} without its word`);
    const middle = (element) => {
      const box = element.getBoundingClientRect();
      return (box.top + box.bottom) / 2;
    };
    const head = tools.closest('.card-head');
    const title = middle(head.querySelector('h2'));
    const sameLine = window.innerWidth > 1100 ? [tools, head.querySelector('.head-search')] : [tools];
    for (const part of sameLine) {
      if (Math.abs(middle(part) - title) > 1) found.push(`${part.className} off the title's line`);
    }
    return found;
  });
  if (problems.length > 0) throw new Error(`the queue's head: ${problems.join(', ')}`);
}
// Wide windows short of height (a 1366 by 768 laptop with the browser's bars, a 1920 by 1080 screen at 150 %): two
// columns, the playing card shorter, the add field and the queue's rows in sight.
await sweep(
  'short-wide',
  [
    [1366, 657],
    [1280, 610],
    [1920, 700],
  ],
  toolsInWords,
  { touch: false },
);
// A laptop's 1024 by 768 with a mouse: two columns, the queue's tools on the title's line, in words.
await sweep('laptop-tools', [[1024, 768]], toolsInWords, { touch: false });
// Touch screens as wide but short (an iPad Air held sideways under Safari's bars, an Android tablet under Chrome's):
// one column, as a phone, since their keys are taller.
await sweep(
  'short-tablet',
  [
    [1180, 750],
    [1280, 700],
  ],
  null,
  { touch: true },
);
// The keyboard: the page is told the player's states by standing between it and its connection, and a skip is answered
// here, so the server's player and queue stay as they are. Returns how to tell the page a state.
async function playingHere(page) {
  const inject = await intercept(page);
  await page.reload();
  await page.waitForSelector('.app .card');
  await page.waitForTimeout(300);
  const now = await api('GET', '/guilds/local/player');
  const queue = await api('GET', '/guilds/local/queue');
  const track = queue.items[0]?.track ?? null;
  let version = now.version + 1000;
  // Each state a newer version than the last, as the server numbers them.
  const tell = (change) => {
    version += 1;
    inject({ type: 'player', player: { ...now, ...change, version } });
  };
  tell({ status: 'playing', track, positionMs: 30_000, durationMs: 180_000 });
  await page.waitForTimeout(200);
  return { now, tell };
}
// A shortcut is the key as typed: B on a Dvorak keyboard, at N's place, skips nothing; N in Hangul input mode skips.
await sweep('keys-typed', [[1440, 900]], async (page) => {
  const { now } = await playingHere(page);
  const skips = [];
  // A skip names the track it is meant for (?track=), so the address may end in a query.
  await page.route(/\/api\/v1\/guilds\/[^/]+\/player\/skip(\?.*)?$/, (route) => {
    skips.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...now, votes: null }),
    });
  });
  // A key pressed with nothing focused, as a keyboard layout or an input mode reports it.
  const press = (key, code) =>
    page.evaluate(
      ([key, code]) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true })),
      [key, code],
    );
  await press('b', 'KeyN');
  await page.waitForTimeout(300);
  if (skips.length !== 0) throw new Error("B, typed at N's place on a Dvorak keyboard, skipped the track");
  await press('ㅜ', 'KeyN');
  await page.waitForTimeout(300);
  if (skips.length !== 1) throw new Error('N in Hangul input mode did not skip the track');
});
// A key turned off with the focus on it hands the focus on: Stop has it, and the player stops; the focus goes to the
// main key (Play, the queue waiting), not to the page.
await sweep('keys-focus', [[1440, 900]], async (page) => {
  const { tell } = await playingHere(page);
  await page.focus('.now [data-act="stop"]');
  tell({ status: 'idle', track: null });
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => document.activeElement?.closest('[data-act]')?.dataset.act ?? 'the page');
  if (focused !== 'pause') throw new Error(`Stop turned off left the focus on ${focused}`);
});

// ---- listening together -------------------------------------------------------------------------------------------
// A few tracks playing again for the states below, which need one.
await api('POST', '/guilds/local/playlists/Quiet%20hours/load', { at: 'end' });
await api('POST', '/guilds/local/player/resume').catch(() => {});
await until('playing');
// The lyrics while a track plays: beside the player on two columns, a sheet on one, the line being sung lit.
async function openLyrics(page) {
  await page.click('[data-act="lyrics"]');
  await page.waitForSelector('.lyrics .lyric.lit, .lyrics .empty, .lyrics-plain');
  await page.waitForTimeout(400);
}
await sweep('lyrics', SIZES, async (page) => {
  await openLyrics(page);
  // The lines fade out at the box's edges rather than being cut there (letters' stubs under the head's rule).
  const mask = await page.evaluate(() => getComputedStyle(document.querySelector('.lyrics-body')).maskImage);
  if (!/gradient/.test(mask)) throw new Error("the lyrics' lines are cut at the box's edges, not faded");
  // In a sheet (one column): the sheet's close key on the centre of the lyrics' head and inside it. A head shorter
  // than a finger's key left the key hanging across the line under it.
  const off = await page.evaluate(() => {
    const key = document.querySelector('.sheet .sheet-close')?.getBoundingClientRect();
    const head = document.querySelector('.sheet .lyrics .card-head');
    if (!key || !head) return null;
    const title = head.firstElementChild.getBoundingClientRect();
    const apart = Math.abs((key.top + key.bottom) / 2 - (title.top + title.bottom) / 2);
    const below = key.bottom - head.getBoundingClientRect().bottom;
    return apart > 0.5 || below > 0 ? `the close key ${apart.toFixed(1)} px off the head's centre` : null;
  });
  if (off) throw new Error(off);
});
// A wide window short of height, with a mouse: two columns (the shorter playing card), so the lyrics open in the right
// column as on any window with two columns, not as a sheet over both (the lyrics' rule for one column once lacked the
// layout's "up to 1100 px wide", and opened a sheet here).
await sweep(
  'lyrics-short-wide',
  [
    [1280, 700],
    [1366, 657],
  ],
  async (page) => {
    await openLyrics(page);
    // Where they opened: a sheet, the card in the right column, or neither.
    const where = await page.evaluate(() =>
      document.querySelector('.sheet .lyrics')
        ? 'a sheet'
        : document.querySelector('.col.side.lyrics-open > .lyrics-card:not([hidden]) > .lyrics')
          ? 'the right column'
          : 'nowhere to be seen',
    );
    if (where !== 'the right column') throw new Error(`the lyrics opened in ${where} beside two columns`);
    await toolsInWords(page);
  },
  { touch: false },
);
await sweep('lyrics-plain', FEW, async (page) => {
  page.lyricsKind = 'plain';
  await openLyrics(page);
});
// No lyrics found: the Lyrics key opens nothing (a card the column's height, or a whole sheet on a phone, held one
// line), and a toast says so.
await sweep('lyrics-none', FEW, async (page) => {
  page.lyricsKind = 'none';
  await page.click('[data-act="lyrics"]');
  await page.waitForSelector('.toast');
  const opened = await page.evaluate(() =>
    Boolean(document.querySelector('.sheet .lyrics, .lyrics-card:not([hidden])')),
  );
  if (opened) throw new Error('the lyrics opened to say there are none');
});
await sweep('lyrics-forced', FEW, openLyrics, { forced: true });
// The playing card's More menu (titled with the track, as a queued track's is, with Remove this track in it), and the
// card while the player is to stop after this track.
await sweep('now-more', FEW, async (page) => {
  await page.click('[data-act="now-more"]');
  await page.waitForSelector('.dialog [data-choice="stop-after"]');
  const [title, track] = await page.evaluate(() => [
    document.querySelector('.dialog h2')?.textContent,
    document.querySelector('.now .title')?.textContent,
  ]);
  if (title !== track) throw new Error(`the playing track's More is titled "${title}", not "${track}"`);
  if ((await page.locator('.dialog [data-choice="drop"]').count()) === 0) throw new Error('More has no Remove');
});
// From the top of the track, so it does not end (and stop) while these pages are looked at.
await api('POST', '/guilds/local/player/seek', { positionMs: 0 });
await api('PUT', '/guilds/local/player/stop-after', { on: true });
// The head keeps one line: the words are under the track (beside the state they pushed Lyrics and More onto a second
// line of a phone's head), with the key that plays on after it, which asks for that (answered here, so the server
// stops after the track for every page of the state).
await sweep('stops-after', FEW, async (page) => {
  await page.waitForSelector('.now .stop-note:not([hidden])');
  const off = await page.evaluate(() => {
    const head = document.querySelector('.card[aria-labelledby="now-h"] > .card-head');
    const keys = head.querySelector('.head-keys').getBoundingClientRect();
    const title = head.querySelector('#now-h').getBoundingClientRect();
    return Math.abs((keys.top + keys.bottom) / 2 - (title.top + title.bottom) / 2);
  });
  if (off > 0.5)
    throw new Error(`the playing card's head takes two lines (its keys ${off.toFixed(1)} px off its title)`);
  const asked = [];
  await page.route(/\/api\/v1\/guilds\/[^/]+\/player\/stop-after$/, async (route) => {
    asked.push(route.request().postDataJSON());
    await route.fulfill({ json: await api('GET', '/guilds/local/player') });
  });
  await page.click('.now [data-act="keep-playing"]');
  await page.waitForTimeout(300);
  if (asked[0]?.on !== false) throw new Error(`Keep playing asked for ${JSON.stringify(asked[0] ?? null)}`);
});
await api('PUT', '/guilds/local/player/stop-after', { on: false });
// Playing again if the track ended meanwhile (it stopped after it).
await api('POST', '/guilds/local/player/resume').catch(() => {});
await until('playing');
// The sleep timer: its choices, and the listening bar with thirty minutes set (phones show its key alone).
async function listenHere(page) {
  await page.click('[data-act="listen"]');
  await page.waitForSelector('[data-act="sleep"]:not([hidden])');
}
// The timer's choices: the dialog says it stops this browser alone, and its rows are told by their words (each with the
// same timer icon said nothing).
await sweep('sleep-menu', FEW, async (page) => {
  await listenHere(page);
  await page.click('[data-act="sleep"]');
  await page.waitForSelector('.dialog [data-sleep="30"]');
  if (!(await page.locator('.dialog .dialog-note').textContent())?.trim())
    throw new Error('the timer does not say what stops');
  const icons = await page.locator('.dialog .choice > svg:not(.check)').count();
  if (icons > 0) throw new Error(`the timer's choices carry ${icons} icons`);
});
await sweep('sleep', [...NARROW, ...FEW], async (page) => {
  await listenHere(page);
  await page.click('[data-act="sleep"]');
  await page.click('.dialog [data-sleep="30"]');
  await page.waitForSelector('[data-act="sleep"][aria-pressed="true"]');
});
await api('DELETE', '/guilds/local/queue');
await api('POST', '/guilds/local/player/stop').catch(() => {});
// Listening with nothing playing, the timer set: the bar keeps to the phone's width.
await sweep('sleep-idle', NARROW, async (page) => {
  await listenHere(page);
  await page.click('[data-act="sleep"]');
  await page.click('.dialog [data-sleep="30"]');
  await page.waitForSelector('[data-act="sleep"][aria-pressed="true"]');
});

// Inviting: a listening link for guests with its QR code and the links that work, and the host's login link for a
// friend. The key beside the listeners opens it.
await api('POST', '/guilds/local/playlists/Quiet%20hours/load', { at: 'end' });
await api('POST', '/guilds/local/player/resume').catch(() => {});
await until('playing');
async function invite(page) {
  // The links the walk made on its earlier pages go first: each page makes one, and a dozen made in the same minute is
  // no server's list. The seed's two older ones stay, so the list shows links that differ beside the one made here.
  for (const link of await api('GET', '/guilds/local/listen-links'))
    if (Date.now() - link.createdAt < 3_600_000) await api('DELETE', `/guilds/local/listen-links/${link.id}`);
  await page.click('[data-act="invite"]');
  await page.waitForSelector('.dialog .invite');
}
await sweep('invite', FEW, async (page) => {
  await invite(page);
  await page.click('.dialog [data-act="invite-make"]');
  await page.waitForSelector('.dialog .qr');
  // Copy on a page over plain http (a LAN address), where browsers give no clipboard: the link is selected instead,
  // and the line says so (it said "the token is selected", the tokens' words).
  await page.click('.dialog [data-act="invite-copy"]');
  const said = (await page.locator('.dialog .copy-result').textContent()) ?? '';
  if (/token|토큰/i.test(said)) throw new Error(`Copy on a listening link says: ${said}`);
  // The links that work: the one just made is marked (the rows read word for word the same), each row says who made it
  // and when, and no part of the line under the date breaks inside itself (the made-by part wrapped alone after a dot).
  await page.waitForSelector('.dialog .invite-links .channel .badge');
  const rows = await page.$$eval('.dialog .invite-links .channel', (items) =>
    items.map((item) => {
      // Each part one line: no taller than one line of its words (the mark is a box of its own height).
      const parts = [...item.querySelectorAll('.sub > :not(.badge)')];
      const broken = parts.some(
        (part) => part.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(part).lineHeight) + 1,
      );
      return { marked: Boolean(item.querySelector('.badge')), broken };
    }),
  );
  if (rows.filter((row) => row.marked).length !== 1 || !rows[0]?.marked)
    throw new Error(`marked as new: ${rows.map((row) => row.marked).join(', ')}`);
  if (rows.some((row) => row.broken)) throw new Error('a part of a link row breaks across lines');
});
// The question over the Invite dialog (revoking a link): the dialog under it steps aside while it is open, taking no
// clicks, and the question says which link. Over a dialog on top of every shade, the list's Revoke stayed bright and
// pressable under the question; then shaded, shorter and at the same top, the question still cut across it (half a
// line of the Invite dialog under its edge, a phone's QR code sliced in two).
await sweep('invite-revoke', FEW, async (page) => {
  await invite(page);
  await page.click('.dialog [data-act="invite-make"]');
  await page.waitForSelector('.dialog .invite-links [data-key="revoke"]');
  await page.locator('.dialog .invite-links [data-key="revoke"]').first().click();
  await page.waitForSelector('.dialog .key.danger');
  await page.waitForTimeout(300);
  const under = await page.evaluate(() => {
    const below = document.querySelector('.dialog [data-act="invite-make"]');
    const box = below.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return below.contains(hit) ? 'the Invite dialog under the question takes clicks' : null;
  });
  if (under) throw new Error(under);
  const shown = await page.$$eval(
    '.dialog',
    (dialogs) => dialogs.filter((dialog) => dialog.getClientRects().length > 0).length,
  );
  if (shown !== 1) throw new Error(`${shown} dialogs show at once`);
  const text = (await page.locator('.dialog .dialog-text').textContent()) ?? '';
  if (!/until|까지/.test(text)) throw new Error(`the question does not say which link: ${text}`);
});
await sweep('invite-friend', FEW, async (page) => {
  await invite(page);
  await page.click('.dialog .invite-tabs button:nth-child(2)');
  await page.click('.dialog [data-act="invite-friend"]');
  await page.waitForSelector('.dialog [data-pane="friend"] .qr');
});
// Listening links made by the host, for the guests' states below: each guest's page takes one of a link's 25 places, so
// a new link every twenty pages (a server keeps at most fifty links).
const links = { hash: '', used: 20 };
async function guestLink() {
  if (links.used >= 20) {
    const made = await api('POST', '/guilds/local/listen-links', { days: 7 });
    links.hash = new URL(made.url).hash;
    links.used = 0;
  }
  links.used += 1;
  return links.hash;
}
// A guest's panel: in with a listening link, the player and the queue, the lyrics, the menu. The bar says it is a guest
// once, on the account key: its pill says the connection as anyone's does (it said "Guest" as well, by a lamp that told
// no state).
async function asGuest(page) {
  await page.goto(`${BASE}/listen${await guestLink()}`);
  await page.waitForSelector('.app .card');
  await page.waitForSelector('.bar .pill.tone-play');
  const pill = (await page.locator('.bar .pill').textContent()) ?? '';
  if (/guest|손님/i.test(pill)) throw new Error(`a guest's pill says: ${pill}`);
}
// A guest's card says nobody listens yet as the other cards say an empty list (a bare "Nobody" in the corner of a card
// the column's height read as unfinished).
await sweep(
  'guest',
  SIZES,
  async (page) => {
    await asGuest(page);
    const people = await page.locator('.guest-people > li:not(.empty)').count();
    if (people === 0 && !(await page.locator('.guest-people > li.empty').isVisible()))
      throw new Error("the guest's card does not say nobody listens yet");
  },
  { login: false },
);
await sweep(
  'guest-lyrics',
  FEW,
  async (page) => {
    await asGuest(page);
    await openLyrics(page);
  },
  { login: false },
);
await sweep(
  'guest-menu',
  FEW,
  async (page) => {
    await asGuest(page);
    await page.click('[data-act="menu"]');
    await page.waitForSelector('.sheet .section');
    await page.waitForTimeout(400);
  },
  { login: false },
);
// A friend the host let in to control, from a login link.
await sweep(
  'friend',
  FEW,
  async (page) => {
    const link = await api('POST', '/login-links?scope=control');
    await page.goto(link.url.replace(new URL(link.url).origin, BASE));
    await page.waitForSelector('.app .card');
  },
  { login: false },
);
// A friend let in to look only (the View link): the add card says why its keys are off, in this login's terms. It
// said only the DJ role could change the music, on a jukecord with no Discord and no roles at all.
await sweep(
  'friend-view',
  FEW,
  async (page) => {
    const link = await api('POST', '/login-links?scope=read');
    await page.goto(link.url.replace(new URL(link.url).origin, BASE));
    await page.waitForSelector('.add-card .look-only:not([hidden])');
    const why = (await page.locator('.add-card .look-only').textContent()) ?? '';
    if (/DJ/.test(why)) throw new Error(`a View login is told: ${why}`);
  },
  { login: false },
);
// A guest whose listening link has ended, on the login page: told to ask whoever shared it for a new one, without the
// host's commands for a machine the guest never sees.
await sweep(
  'login-guest',
  FEW,
  async (page) => {
    await page.goto(`${BASE}/login?error=listen-ended`);
    await page.waitForSelector('.login .card .notice');
    if (await page.locator('.login-commands').count()) throw new Error("a guest is shown the host's commands");
  },
  { login: false },
);
// Guests among the people listening, in the made-up Discord.
await sweep('listeners-guest', FEW, null, {
  discord: {
    listeners: {
      people: [
        ...MADE_UP.listeners.people,
        { id: null, name: 'Guest', avatar: null, guest: true },
        { id: null, name: 'Friend', avatar: null, friend: true },
      ],
      count: 6,
    },
  },
});
// What another app shared, on the page that adds it: for the host, and for a guest (who only listens).
const SHARED = `/add?title=Paper%20Boats&text=${encodeURIComponent('Listen to this https://media.example/demo005')}`;
// What came reads as words (its name over its address, in no box like a field's), and a key leaves without a change:
// Cancel beside the keys that add; for a guest, who may not add, no key that does nothing, and one back to the player
// (it had three dead keys and the logo for a way back).
await sweep('share', FEW, async (page) => {
  await page.goto(`${BASE}${SHARED}`);
  await page.waitForSelector('.share-card .share-input');
  if ((await page.locator('.share-card .share-name').textContent()) !== 'Paper Boats')
    throw new Error('the shared title is not shown');
  if (await page.locator('.share-card .secret').count()) throw new Error('what was shared sits in a box like a field');
  const keys = await page.$$eval('.share-keys .key', (found) => found.map((key) => key.dataset.act));
  if (keys.join() !== 'share-leave,share-end,share-next,share-now') throw new Error(`the share keys: ${keys.join()}`);
});
await sweep(
  'share-guest',
  FEW,
  async (page) => {
    await asGuest(page);
    await page.goto(`${BASE}${SHARED}`);
    await page.waitForSelector('.share-card .share-why');
    const keys = await page.$$eval('.share-keys .key', (found) =>
      found.map((key) => `${key.dataset.act}${key.disabled ? ' (off)' : ''}`),
    );
    if (keys.join() !== 'share-leave') throw new Error(`a guest's share keys: ${keys.join()}`);
  },
  { login: false },
);
await api('DELETE', '/guilds/local/queue');
await api('POST', '/guilds/local/player/stop').catch(() => {});

// ---- how people share the music, and the sound -------------------------------------------------------------------
// A queue and a track playing again (the walk above left the queue empty and the player stopped).
await api('POST', '/guilds/local/playlists/Friday%20night/load', { at: 'end' });
await api('POST', '/guilds/local/player/resume').catch(() => {});
await until('playing');
// The Skip key of someone whose Skip is a vote: it says what its count is of, as a count ("votes 1/2", "투표 1/2"; the
// old "1/2표" read as a half), and once their vote is in, that they voted. The row of keys stays one line, or the main
// key alone over the other four, at every width (a longer count once left a key alone on a second line).
async function skipSays(page, voted) {
  // The count comes with the live state, a moment after the page: waited for (and said missing below if it never came).
  await page.waitForSelector('.now [data-act="skip"] .votes', { timeout: 10000 }).catch(() => {});
  const { text, lang, rows } = await page.evaluate(() => {
    const row = document.querySelector('.now .keys');
    const tops = new Map();
    for (const key of row?.querySelectorAll(':scope > .key') ?? []) {
      if (key.hidden || !key.offsetParent) continue;
      const top = Math.round(key.getBoundingClientRect().top);
      tops.set(top, (tops.get(top) ?? 0) + 1);
    }
    return {
      text: row?.querySelector('[data-act="skip"] .votes')?.textContent ?? '',
      lang: document.documentElement.lang,
      rows: [...tops.values()],
    };
  });
  const want = lang === 'ko' ? `${voted ? '투표함' : '투표'} 1/2` : `${voted ? 'voted' : 'votes'} 1/2`;
  if (text !== want) throw new Error(`Skip's count says "${text}", not "${want}"`);
  if (rows.length > 2 || (rows.length === 2 && rows[0] !== 1)) throw new Error(`the keys lie in rows of ${rows}`);
}
// Someone without the DJ role, with a vote to skip under way: the Skip key says how it stands, at every width (the
// count stays on the key when a narrow row shows icons alone), and the bar does not call them "View only" while their
// Skip works.
await sweep(
  'vote-skip',
  SIZES,
  async (page) => {
    await skipSays(page, false);
    const said = (await page.locator('.bar .pill').textContent()) ?? '';
    if (/View only|보기 전용/.test(said)) throw new Error(`the bar says "${said}" while Skip is a vote`);
  },
  { discord: { control: false, votes: { on: true, votes: 1, needed: 2, voted: false } } },
);
// The same person once their vote is in: the key says they voted.
await sweep('vote-skip-voted', SIZES, (page) => skipSays(page, true), {
  discord: { control: false, votes: { on: true, votes: 1, needed: 2, voted: true } },
});
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
// The same with a DJ role chosen: the vote's hint says how Skip from everyone else works.
await sweep(
  'menu-settings-role',
  FEW,
  async (page) => {
    await page.click('[data-act="menu"]');
    await page.waitForSelector('.sheet .settings .switch');
    await page.waitForTimeout(400);
    const problems = [];
    await settingsLook(page).catch((error) => problems.push(error.message));
    await noLostHue(page).catch((error) => problems.push(error.message));
    if (problems.length > 0) throw new Error(problems.join('; '));
  },
  { discord: { djRole: true } },
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
    synced = await page.evaluate(() => document.querySelector('.listen .what span')?.textContent?.includes('In sync'));
  }
  let still = true;
  for (const preset of ['night', 'bass']) {
    await api('PUT', '/guilds/local/voice/sound', { preset });
    await page.waitForTimeout(2500);
    still &&= await page.evaluate(() => document.querySelector('.listen .what span')?.textContent?.includes('In sync'));
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

// ---- discovery: search and pick, a link dropped on the page ------------------------------------------------------
// Phones (upright, by touch), the tablet, a short laptop and a wide one: where the list lengthens a page that scrolls
// (one column), and where it shares a column that does not scroll with the queue (two columns: the queue keeps three
// rows on the wide one, and gives the room of its rows to the results on the short one).
const DISCOVERY = [
  [360, 780],
  [390, 844],
  [744, 1000],
  [1024, 768],
  [1440, 900],
];
// A made-up search: the seeded tracks as YouTube would list them (title, channel, length, cover), put between the
// page and jukecord, so no search reaches a site.
const FOUND = [];
// Each made-up result's picture, by the result's address: the seed's covers are pictures in jukecord's cache (their
// own addresses lead nowhere), sent where the panel asks jukecord for a search result's picture.
const PICTURES = new Map();
for (const entry of await api('GET', '/guilds/local/history?limit=60')) {
  if (FOUND.length >= 8 || FOUND.some((found) => found.url === entry.track.url)) continue;
  const { id, url, title, uploader, durationMs, thumbnail } = entry.track;
  PICTURES.set(url, `${BASE}/api/v1/guilds/local/tracks/${id}/cover`);
  FOUND.push({ url, title, uploader, durationMs, thumbnail });
}
async function searchFor(page, words) {
  await page.route(/\/api\/v1\/guilds\/[^/]+\/search\?/, (route) =>
    route.fulfill({ json: { query: new URL(route.request().url()).searchParams.get('q') ?? '', results: FOUND } }),
  );
  // jukecord would fetch a result's picture from the address the search found; here it is the seed's cover.
  await page.route(/\/api\/v1\/guilds\/[^/]+\/search\/cover\?/, (route) => {
    const cover = PICTURES.get(new URL(route.request().url()).searchParams.get('url') ?? '');
    if (cover) return route.continue({ url: cover });
    return route.fulfill({
      status: 404,
      json: { error: { code: 'not-found', message: 'no search found that address' } },
    });
  });
  await page.locator('#add-input').fill(words);
  await page.waitForSelector('#add-found [role="option"]');
}
// The queue as people have it while they look for more.
await api('POST', '/guilds/local/playlists/Friday%20night/load', { at: 'end' });
await sweep('search', DISCOVERY, async (page) => {
  await searchFor(page, 'paper boats');
  // The keyboard on the second result.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  // The list shows three whole results at least (at 1440 by 900 the queue's rows left it two), and ends on whole rows:
  // the one its foot cuts shows half of itself or more, or none of itself (a few pixels of the next cover, or its ring
  // alone, sat over the line of keys).
  const problems = await page.evaluate(() => {
    const list = document.querySelector('#add-found');
    const box = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll('[role="option"]')].map((row) => row.getBoundingClientRect());
    const whole = rows.filter((row) => row.top >= box.top - 0.5 && row.bottom <= box.bottom + 0.5).length;
    const found = whole < 3 ? [`${whole} whole results in sight`] : [];
    for (const row of rows) {
      if (row.top >= box.bottom - 0.5 || row.bottom <= box.bottom + 0.5) continue;
      const shown = box.bottom - row.top;
      if (shown < row.height / 2) found.push(`${shown.toFixed(1)} px of a result at the foot`);
    }
    return found;
  });
  if (problems.length > 0) throw new Error(`the results: ${problems.join(', ')}`);
});
// Nothing found for the words: the list says so.
await sweep(
  'search-none',
  [
    [360, 780],
    [1440, 900],
  ],
  async (page) => {
    await page.route(/\/api\/v1\/guilds\/[^/]+\/search\?/, (route) =>
      route.fulfill({ json: { query: 'zzz', results: [] } }),
    );
    await page.locator('#add-input').fill('nothing like this');
    await page.waitForSelector('.found-state:not([hidden])');
  },
);
// Escape in the add field: first the results close, the words staying; again, the words go, as a search field's do.
await sweep('add-escape', [[1440, 900]], async (page) => {
  await searchFor(page, 'paper boats');
  await page.keyboard.press('Escape');
  if ((await page.inputValue('#add-input')) !== 'paper boats') throw new Error('the first Escape took the words');
  if (await page.locator('#add-found').isVisible()) throw new Error('the first Escape left the results open');
  await page.keyboard.press('Escape');
  if ((await page.inputValue('#add-input')) !== '') throw new Error('a second Escape kept the words');
});
// A link from another window held over the page: the add card says where it goes.
await sweep(
  'drop-link',
  [
    [390, 844],
    [1440, 900],
  ],
  async (page) => {
    const held = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/uri-list', 'https://media.example/demo001');
      return transfer;
    });
    await page.dispatchEvent('main', 'dragenter', { dataTransfer: held });
    await page.waitForSelector('.add-card.drop-target');
  },
);
// Likes: the playing track's heart, and the liked list beside the history (the walk logs in as the host, whose likes
// these are).
// Loading the playlist above started it already; resume refuses when it plays, which is fine.
await api('POST', '/guilds/local/player/resume').catch(() => {});
await until('playing');
{
  const playing = await api('GET', '/guilds/local/player');
  await api('PUT', `/guilds/local/likes/${playing.track.id}`);
  const liked = new Set([playing.track.id]);
  for (const entry of await api('GET', '/guilds/local/history?limit=40')) {
    if (liked.size >= 6 || liked.has(entry.track.id)) continue;
    await api('PUT', `/guilds/local/likes/${entry.track.id}`);
    liked.add(entry.track.id);
  }
}
await sweep('liked', DISCOVERY, async (page) => {
  await page.click('.library-seg [data-view="liked"]');
  await page.waitForSelector('.history .row .like-key[aria-pressed="true"]');
});
// A liked row's keys behind its one key, on a phone.
await sweep('liked-menu', [[360, 780]], async (page) => {
  await page.click('.library-seg [data-view="liked"]');
  await page.locator('.history .row .lib-more:visible').first().click();
  await page.waitForSelector('.dialog .menu-list .choice');
});
await sweep('history-keys', DISCOVERY, async (page) => {
  await page.click('.library-seg [data-view="history"]');
  await page.waitForSelector('.history .row');
  // The line under each title (when, how long, who added it) whole on a laptop's window and wider: at 1440 px three
  // keys beside it cut every row's to "3:00 added by ...".
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll(window.innerWidth >= 1024 ? '.history .row .sub' : 'none')]
      .filter((line) => line.offsetParent && line.scrollWidth > line.clientWidth + 1)
      .map((line) => line.textContent),
  );
  if (cut.length > 0) throw new Error(`the history's lines are cut: ${cut.slice(0, 3).join(' | ')}`);
});
// Autoplay from the server's plays (the seeded history: nothing to fetch). Nothing playing and nothing queued: the add
// card says autoplay is on, and the queue's key shows it.
await api('DELETE', '/guilds/local/queue');
await api('POST', '/guilds/local/player/stop').catch(() => {});
await api('PUT', '/guilds/local/player/autoplay', { mode: 'history' });
await sweep(
  'autoplay-empty',
  [
    [360, 780],
    [390, 844],
    [1024, 768],
    [1440, 900],
  ],
  async (page) => {
    await page.waitForSelector('.auto-note:not([hidden])');
  },
);
await sweep(
  'autoplay-menu',
  [
    [390, 844],
    [1440, 900],
  ],
  async (page) => {
    // Its own key on a wide card, the tools list on a narrow one (phones), as the queue's tools.
    await tool(page, 'autoplay');
    await page.waitForSelector('.dialog .choice[data-mode="history"]');
  },
);
// One track added with nothing after it: when it starts, autoplay queues the next, which says who added it.
{
  const history = await api('GET', '/guilds/local/history?limit=1');
  await api('POST', '/guilds/local/queue', { input: history[0].track.url });
  let picked = false;
  for (let i = 0; i < 50 && !picked; i += 1) {
    picked = (await api('GET', '/guilds/local/queue')).items.some((item) => item.addedBy === 'autoplay');
    if (!picked) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!picked) throw new Error('autoplay queued nothing');
}
await sweep('autoplay-row', DISCOVERY, async (page) => {
  await page.waitForSelector('.queue-list .row');
});
await api('PUT', '/guilds/local/player/autoplay', { mode: 'off' });
await api('DELETE', '/guilds/local/queue');
// Playlists in and out: a playlist's three kinds of file, and the import with a list pasted in.
await sweep(
  'playlist-export',
  [
    [390, 844],
    [1440, 900],
  ],
  async (page) => {
    await tool(page, 'load');
    await page.locator('.dialog .channel [data-key="more"]').first().click();
    await page.click('.dialog .choice[data-choice="export"]');
    await page.waitForSelector('.dialog .choice[data-format="m3u"]');
  },
);
await sweep(
  'playlist-import',
  [
    [360, 780],
    [390, 844],
    [1024, 768],
    [1440, 900],
  ],
  async (page) => {
    await tool(page, 'load');
    await page.click('.dialog [data-act="import"]');
    await page.waitForSelector('.dialog .paste');
    await page.locator('.dialog .import-form input[type="text"]').fill('Saturday');
    await page
      .locator('.dialog .paste')
      .fill(
        ['https://media.example/demo001', 'https://media.example/demo002', 'Example Band - Velvet Hours'].join('\n'),
      );
    // Filled, each field still shows its name (a placeholder alone went with the first letter), and Import is the
    // dialog's own key beside Close (it stood in the body, Close alone on a row under it).
    const named = await page.$$eval('.dialog .import-form .field-label', (labels) =>
      labels
        .filter((label) => label.getClientRects().length > 0 && label.textContent.trim())
        .map((label) => label.htmlFor),
    );
    if (named.join() !== 'import-name,import-list') throw new Error(`the filled fields' names shown: ${named.join()}`);
    // The keys of the dialog on top (the last in the page; the playlists' own lie under it).
    const keys = await page.$$eval('.dialog', (dialogs) =>
      [...dialogs.at(-1).querySelectorAll('.dialog-keys .key')].map((key) => key.dataset.act ?? ''),
    );
    if (keys.join() !== 'import-go,') throw new Error(`the dialog's keys: ${keys.join()}`);
  },
);
// The queue's tools behind their key on a phone, autoplay among them with its mode.
await api('POST', '/guilds/local/playlists/Friday%20night/load', { at: 'end' });
await api('PUT', '/guilds/local/player/autoplay', { mode: 'history' });
await sweep(
  'queue-tools',
  [
    [360, 780],
    [390, 844],
  ],
  async (page) => {
    await page.click('[data-act="queue-tools"]');
    await page.waitForSelector('.dialog [data-tool="autoplay"]');
  },
);
await api('PUT', '/guilds/local/player/autoplay', { mode: 'off' });

// The README's second row of phone pictures, beside the first (the player, the queue, the statistics): the lyrics, a
// search's results and a listening link's QR code, in each theme, with a Discord bot, while a track plays. The link's
// words are an example address: the walk's own is its container's name and a code from a throwaway server.
for (const theme of ONLY && !ONLY.has('readme') ? [] : ['light', 'dark']) {
  await api('POST', '/guilds/local/player/resume').catch(() => {});
  await until('playing');
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
  await madeUpLyrics(page);
  await asDiscord(page);
  const link = await api('POST', '/login-links');
  await page.goto(link.url.replace(new URL(link.url).origin, BASE));
  await page.waitForSelector('.history .row');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  const shot = async (n) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `readme-phone-${n}-${theme}.png`) });
  };
  // The lyrics, as the sheet a phone opens.
  await page.evaluate(() => window.scrollTo(0, 0));
  await openLyrics(page);
  await shot(4);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // What a search found, under the add field.
  await page.locator('#add-input').scrollIntoViewIfNeeded();
  await searchFor(page, 'paper boats');
  await page.evaluate(() => document.querySelector('.add-card')?.scrollIntoView({ block: 'start' }));
  await shot(5);
  await page.keyboard.press('Escape');
  await page.fill('#add-input', '');
  // A listening link and its QR code.
  await page.evaluate(() => window.scrollTo(0, 0));
  await invite(page);
  await page.click('.dialog [data-act="invite-make"]');
  await page.waitForSelector('.dialog .qr');
  // The link just made, in the list of links that work (the list is fetched again after it is made).
  await page.waitForSelector('.dialog .invite-links > li.channel');
  await page.evaluate(() => {
    const url = document.querySelector('.dialog .invite-url');
    if (url) url.textContent = 'https://music.example.com/listen#7Kq2vX9pL4mN8wR3tY6bZ1cF5hJ0sD';
    // The QR code in the middle, and the made link's row in view under it (a heading over nothing read as a gap).
    document.querySelector('.dialog .qr')?.scrollIntoView({ block: 'center' });
    document.querySelector('.dialog .invite-links > li')?.scrollIntoView({ block: 'nearest' });
  });
  await shot(6);
  await context.close();
}

// ---- the cover's light ---------------------------------------------------------------------------------------------
// The light behind the glass is the cover's, and a soft light, not a tint: with the boldest covers playing (a green, an
// amber, and the seed's most saturated, a purple), what the light adds to the field's colour and to a card's stays
// small, measured on the page's picture in OKLab against the same places with the light off (the field and the glass
// have a blue of their own). 0.3.0 washed the whole panel in the cover's colour (the field's chroma up to 0.107, a
// card's face up to 0.039, with the green cover of the README's picture); and the light must still be seen at the top.
const COVER_LIGHT = { covers: ['demo002', 'demo014', 'demo006'], field: 0.03, face: 0.02, lift: 0.01 };
// A colour (0 to 255 each) in OKLab: lightness and the two axes, whose length is the chroma.
function oklab([r, g, b]) {
  const linear = (value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
// The mean colour of some boxes ([x, y, width, height]) of the page as it is drawn, read from its picture on a blank
// page's canvas (the panel's own page refuses pictures from data: addresses, rightly).
async function drawn(page, boxes) {
  const png = await page.screenshot();
  const blank = await page.context().newPage();
  const means = await blank.evaluate(
    async ([data, boxes]) => {
      const picture = new Image();
      picture.src = `data:image/png;base64,${data}`;
      await picture.decode();
      const canvas = document.createElement('canvas');
      canvas.width = picture.width;
      canvas.height = picture.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(picture, 0, 0);
      return boxes.map(([x, y, width, height]) => {
        const pixels = ctx.getImageData(Math.round(x), Math.round(y), width, height).data;
        const sum = [0, 0, 0];
        for (let at = 0; at < pixels.length; at += 4) for (let c = 0; c < 3; c += 1) sum[c] += pixels[at + c];
        return sum.map((value) => value / (pixels.length / 4));
      });
    },
    [png.toString('base64'), boxes],
  );
  await blank.close();
  return means;
}
await sweep(
  'cover-light',
  [
    [390, 844],
    [1440, 900],
    [1920, 1080],
  ],
  async (page) => {
    const problems = [];
    for (const cover of COVER_LIGHT.covers) {
      const played = await api('POST', '/guilds/local/player/play', { input: `https://media.example/${cover}` });
      const title = played.items[0]?.track.title ?? '';
      // The page shows it, and its light is on (motion is off on the walk's pages: no fade to wait for).
      await page.waitForFunction((title) => document.title.startsWith(title), title);
      await page.waitForSelector('.ambient > div.on');
      await page.waitForTimeout(300);
      // The field above the first card and in the gap under it, and the face of the add card in its padding.
      const where = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('main .card')].filter((card) => card.offsetParent);
        const first = cards[0].getBoundingClientRect();
        const next = cards.map((card) => card.getBoundingClientRect()).find((box) => box.top > first.bottom - 1);
        const add = document.querySelector('.add-card').getBoundingClientRect();
        const middle = first.left + first.width / 2 - 50;
        return [
          [middle, first.top - 7, 100, 3],
          [middle, (first.bottom + next.top) / 2 - 1, 100, 3],
          [add.left + 4, add.top + add.height / 2 - 3, 6, 6],
        ];
      });
      const [top, gap, face] = (await drawn(page, where)).map(oklab);
      // The same places without the light: what the light adds there, apart from the panel's own colours (its field
      // and its glass have a blue of their own, which is not the cover's).
      await page.evaluate(() => {
        document.querySelector('.ambient').style.visibility = 'hidden';
      });
      const [bareTop, bareGap, bareFace] = (await drawn(page, where)).map(oklab);
      await page.evaluate(() => {
        document.querySelector('.ambient').style.visibility = '';
      });
      // The colour the light adds: how far it moves a place's colour, its lightness aside.
      const tint = (lit, bare) => Math.hypot(lit[1] - bare[1], lit[2] - bare[2]);
      const lift = Math.hypot(...top.map((value, at) => value - bareTop[at]));
      const field = Math.max(tint(top, bareTop), tint(gap, bareGap));
      if (field > COVER_LIGHT.field)
        problems.push(`${cover}: the light adds ${field.toFixed(3)} of colour to the field`);
      if (tint(face, bareFace) > COVER_LIGHT.face)
        problems.push(`${cover}: the light adds ${tint(face, bareFace).toFixed(3)} of colour to a card`);
      if (lift < COVER_LIGHT.lift) problems.push(`${cover}: the light shows ${lift.toFixed(3)} at the top`);
    }
    if (problems.length > 0) throw new Error(`the cover's light tints the panel: ${problems.join('; ')}`);
  },
);

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
// How many different values the pages show (a page at most, and on average), and which ones the whole walk saw: the
// fewer, the more the panel reads as one system.
const measured = report.filter((entry) => entry.distinct);
if (measured.length > 0) {
  process.stdout.write('\ndistinct values per page (at most / on average), and all the walk saw:\n');
  for (const [kind, name] of [
    ['fonts', 'font sizes'],
    ['controls', 'control heights'],
    ['radii', 'corner radii'],
    ['paddings', 'paddings'],
    ['gaps', 'gaps and margins'],
  ]) {
    const counts = measured.map((entry) => entry.distinct[kind].length);
    const all = [...new Set(measured.flatMap((entry) => entry.distinct[kind]))].sort(
      (a, b) => (Number.parseFloat(a) || 0) - (Number.parseFloat(b) || 0),
    );
    const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    process.stdout.write(`  ${name}: ${Math.max(...counts)} / ${mean.toFixed(1)}; ${all.join(', ')}\n`);
  }
}
