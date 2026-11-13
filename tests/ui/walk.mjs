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
// `control: false`, a person without the server's DJ role; `votes`, how a vote to skip stands in the state.
async function asDiscord(
  page,
  { name = MADE_UP.me.name, guild = MADE_UP.guild, view = false, listeners = MADE_UP.listeners, control, votes } = {},
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
            ? { ...body, roles: MADE_UP.roles, channels: MADE_UP.channels, alertsChannelId: MADE_UP.channels[0].id }
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
if (!ONLY || ONLY.has('listening')) {
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

// Wrapped: the seed's year of plays, the server's first month (a few plays), and a time with none; the times to
// choose from, the picture to save, and the page in a contrast theme.
const year = await api('GET', '/guilds/local/wrapped?period=last-12-months');
const firstMonth = year.months.at(-1) ?? 'last-12-months';
async function wrappedAt(page, period) {
  await page.goto(`${BASE}/stats/wrapped?period=${period}`);
  await page.waitForSelector('.wrapped .page-body > *');
}
await sweep('wrapped', SIZES, (page) => wrappedAt(page, 'last-12-months'), { discord: true });
await sweep('wrapped-few', FEW, (page) => wrappedAt(page, firstMonth), { discord: true });
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
// The menu of someone who manages the server, in the made-up Discord: the DJ role and the alerts channel.
await sweep(
  'menu-discord',
  FEW,
  async (page) => {
    await page.click('[data-act="menu"]');
    await page.waitForSelector('.sheet .section .choice[aria-pressed="true"] >> nth=1');
    await page.waitForTimeout(400);
  },
  { discord: true },
);
// An add that does not go through (an address on a private network, which jukecord does not fetch): the reason under
// the field as well as in the bar.
await sweep('add-failed', FEW, async (page) => {
  // The refusal is an answer of 400, which the browser reports on its console: expected here.
  page.expectedErrors = [/status of 400/];
  await page.fill('#add-input', 'http://10.0.0.1/tune');
  await page.click('.add [type="submit"]');
  await page.waitForSelector('.add-failed:not([hidden])');
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
// Wide windows short of height (a 1366 by 768 laptop with the browser's bars, a 1920 by 1080 screen at 150 %): two
// columns, the playing card shorter, the add field and the queue's rows in sight.
await sweep(
  'short-wide',
  [
    [1366, 657],
    [1280, 610],
    [1920, 700],
  ],
  null,
  { touch: false },
);
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
await sweep('lyrics', SIZES, openLyrics);
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
  },
  { touch: false },
);
await sweep('lyrics-plain', FEW, async (page) => {
  page.lyricsKind = 'plain';
  await openLyrics(page);
});
await sweep('lyrics-none', FEW, async (page) => {
  page.lyricsKind = 'none';
  await openLyrics(page);
});
await sweep('lyrics-forced', FEW, openLyrics, { forced: true });
// The playing card's More menu, and the card while the player is to stop after this track.
await sweep('now-more', FEW, async (page) => {
  await page.click('[data-act="now-more"]');
  await page.waitForSelector('.dialog [data-choice="stop-after"]');
});
// From the top of the track, so it does not end (and stop) while these pages are looked at.
await api('POST', '/guilds/local/player/seek', { positionMs: 0 });
await api('PUT', '/guilds/local/player/stop-after', { on: true });
await sweep('stops-after', FEW);
await api('PUT', '/guilds/local/player/stop-after', { on: false });
// Playing again if the track ended meanwhile (it stopped after it).
await api('POST', '/guilds/local/player/resume').catch(() => {});
await until('playing');
// The sleep timer: its choices, and the listening bar with thirty minutes set (phones show its key alone).
async function listenHere(page) {
  await page.click('[data-act="listen"]');
  await page.waitForSelector('[data-act="sleep"]:not([hidden])');
}
await sweep('sleep-menu', FEW, async (page) => {
  await listenHere(page);
  await page.click('[data-act="sleep"]');
  await page.waitForSelector('.dialog [data-sleep="30"]');
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
  await page.click('[data-act="invite"]');
  await page.waitForSelector('.dialog .invite');
}
await sweep('invite', FEW, async (page) => {
  await invite(page);
  await page.click('.dialog [data-act="invite-make"]');
  await page.waitForSelector('.dialog .qr');
});
// The question over the Invite dialog (revoking a link): the dialog under it is shaded and takes no clicks. Over a
// dialog on top of every shade, the list's Revoke stayed bright and pressable under the question, and the two dialogs
// read as one box cut across.
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
// A guest's panel: in with a listening link, the player and the queue, the lyrics, the menu.
async function asGuest(page) {
  await page.goto(`${BASE}/listen${await guestLink()}`);
  await page.waitForSelector('.app .card');
  await page.waitForSelector('.bar .pill.tone-idle');
}
await sweep('guest', SIZES, asGuest, { login: false });
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
await sweep('share', FEW, async (page) => {
  await page.goto(`${BASE}${SHARED}`);
  await page.waitForSelector('.share-card .share-input');
});
await sweep(
  'share-guest',
  FEW,
  async (page) => {
    await asGuest(page);
    await page.goto(`${BASE}${SHARED}`);
    await page.waitForSelector('.share-card .share-why');
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
    await page.locator('.dialog .channel [data-key="export"]').first().click();
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
  await page.evaluate(() => {
    const url = document.querySelector('.dialog .invite-url');
    if (url) url.textContent = 'https://music.example.com/listen#7Kq2vX9pL4mN8wR3tY6bZ1cF5hJ0sD';
    document.querySelector('.dialog .qr')?.scrollIntoView({ block: 'center' });
  });
  await shot(6);
  await context.close();
}

// ---- the cover's light ---------------------------------------------------------------------------------------------
// The light behind the glass is the cover's, and a soft light, not a tint: with the boldest covers playing (a green, an
// amber, and the seed's most saturated, a purple), the field and a card's face stay near grey, measured on the page's
// picture in OKLCH. 0.3.0 washed the whole panel in the cover's colour (the field's chroma up to 0.107, a card's face
// up to 0.039, with the green cover of the README's picture); and the light must still be seen near the top.
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
const chroma = ([, a, b]) => Math.hypot(a, b);
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
      // The same top of the field without the light: how much the light shows there.
      await page.evaluate(() => {
        document.querySelector('.ambient').style.visibility = 'hidden';
      });
      const [bare] = (await drawn(page, [where[0]])).map(oklab);
      await page.evaluate(() => {
        document.querySelector('.ambient').style.visibility = '';
      });
      const lift = Math.hypot(...top.map((value, at) => value - bare[at]));
      const field = Math.max(chroma(top), chroma(gap));
      if (field > COVER_LIGHT.field) problems.push(`${cover}: the field's chroma ${field.toFixed(3)}`);
      if (chroma(face) > COVER_LIGHT.face) problems.push(`${cover}: a card's chroma ${chroma(face).toFixed(3)}`);
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
