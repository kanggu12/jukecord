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
// Photographed: the phones, the laptops, and 2560 (the owner's screen, where what is stretched is seen every day).
const SHOOT = new Set([412, 390, 1440, 1366, 2560]);
// Only some states, for a quick look while working on one (ONLY=toast,menu tests/ui/run.sh <folder>): the other
// states, the README's pictures and the playing-along check are skipped; ONLY=readme takes the README's pictures
// alone, ONLY=pictures the panel's pictures and ONLY=listening the playing-along check. A whole walk leaves it unset,
// or walks in groups at once whose names together are every state and those three.
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
// Every page looked at from the example people's time zone: the seed's evenings are theirs (UTC+9), and looked at from
// the walk's own (UTC) the statistics' hours peaked at 10 to 16 and "Night Owls" were busiest at 11:00.
const ZONE = 'Asia/Seoul';
// Its offset in minutes east of UTC, for the walk's own requests that take one (Seoul keeps no summer time).
const ZONE_MINUTES = 540;
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
    timezoneId: ZONE,
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
  if (SHOOT.has(setting.width)) {
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

// ---- checks that several states share ----------------------------------------------------------------------------
// Each throws with what it found, as a state's own checks do.

// Waits for the page's next two frames: what the panel draws in a frame of its own (the edges' fades) is drawn by then.
async function twoFrames(page) {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

// The queue's head is laid out by the card's width alone: with the longest count and autoplay words it may show, it is
// as tall, and its search, tools and autoplay key stand where they stood (a count of "총 1시간 9분" where "총 39분"
// had been sent the tools onto a second line, moved the search 486 px and dropped the list 33 px; on a phone,
// Shuffle and the tools key took a line of their own). The search may give way: its right edge stays.
async function headSteady(page) {
  const moved = await page.evaluate(() => {
    const head = document.querySelector('.queue-head');
    if (!head?.getClientRects().length) return [];
    const ko = document.documentElement.lang === 'ko';
    const count = head.querySelector('h2 .count');
    const auto = head.querySelector('.autoplay-key .label');
    // Where each part stands: the head's height, the tops of all, the search's right edge, the tools' left.
    const where = () => {
      const box = (selector) => {
        const part = head.querySelector(selector);
        return part?.getClientRects().length ? part.getBoundingClientRect() : null;
      };
      const search = box('.head-search');
      const tools = box('.tools');
      const autoplay = box('.autoplay-key');
      return {
        'the head': head.getBoundingClientRect().height,
        "the search's top": search?.top,
        "the search's right": search?.right,
        "the tools' top": tools?.top,
        "the tools' left": tools?.left,
        "autoplay's top": autoplay?.top,
      };
    };
    const before = where();
    const was = [count.textContent, auto?.textContent];
    count.textContent = ko ? '1000곡 · 총 66시간 40분' : '1000 tracks · 66 h 40 min in all';
    if (auto) auto.textContent = ko ? '자동 재생: 비슷한 곡' : 'Autoplay: past plays';
    const after = where();
    count.textContent = was[0];
    if (auto) auto.textContent = was[1];
    return Object.keys(before)
      .filter((name) => before[name] !== undefined && Math.abs(before[name] - after[name]) > 0.5)
      .map((name) => `${name} by ${(after[name] - before[name]).toFixed(1)} px`);
  });
  if (moved.length > 0) throw new Error(`the queue's head moves with the length of its words: ${moved.join(', ')}`);
}

// The line under each queue and history row: who added the track whole on every row (at the line's end, "added by
// the ..." lost the name on every phone and the tablet); a part with no room left out whole, never cut through its
// words; and the history's rows all alike, with the length or without it.
async function rowsWhole(page) {
  const problems = await page.evaluate(() => {
    const found = [];
    for (const list of document.querySelectorAll('.queue-list, .history')) {
      if (!list.getClientRects().length) continue;
      let rows = 0;
      let lengths = 0;
      for (const line of list.querySelectorAll('.row .sub')) {
        if (!line.getClientRects().length) continue;
        rows += 1;
        const box = line.getBoundingClientRect();
        for (const part of line.children) {
          const at = part.getBoundingClientRect();
          // On the line's own row (a part with no room goes whole to a second one, which is not shown).
          const shown = at.width > 0 && at.top < box.bottom - 0.5;
          if (part.matches('.by') && !shown) found.push(`who added it is left out: ${line.title}`);
          if (shown && part.scrollWidth > part.clientWidth + 1) found.push(`"${part.textContent}" is cut`);
          if (shown && part.matches('.num')) lengths += 1;
        }
      }
      if (list.matches('.history') && lengths > 0 && lengths < rows)
        found.push(`${lengths} of ${rows} history rows show the length`);
    }
    return found.slice(0, 4);
  });
  if (problems.length > 0) throw new Error(`the rows' lines: ${problems.join('; ')}`);
}

// A box that scrolls fades out at an edge with more beyond it, over a row of what it holds and a line and its gap at
// least (--fade, 38 px or more: a lyric's line), as soon as a pixel lies beyond: a row the edge cuts reads as going on
// out of sight, not as cut through its words (the log's first record sliced through its letters, a sliver of a cover at
// the queue's foot, lyric lines halved at both edges, a dialog's list ending on a whole row with two more under it and
// nothing to say so; faded over only what lay beyond, the Invite dialog's third link showed the top halves of its
// letters under a 10 px fade). With nothing to scroll, no fade.
async function edgesFade(page) {
  await twoFrames(page);
  const problems = await page.evaluate(() => {
    const found = [];
    for (const box of document.querySelectorAll('.scroll, .found-list')) {
      if (!box.getClientRects().length) continue;
      const name = box.classList[0];
      const style = getComputedStyle(box);
      const masked = /gradient/.test(style.maskImage);
      if (box.scrollHeight <= box.clientHeight + 1) {
        if (masked) found.push(`${name} fades with nothing to scroll`);
        continue;
      }
      if (!masked) {
        found.push(`${name} scrolls with its edges cut, not faded`);
        continue;
      }
      // The fade at its fullest (--fade) is a row of what the box holds at least (the middle one of its rows' heights).
      const most = Number.parseFloat(style.getPropertyValue('--fade'));
      if (!Number.isFinite(most)) {
        found.push(`${name}'s fade is "${style.getPropertyValue('--fade')}", not a length`);
        continue;
      }
      const rows = [
        ...box.querySelectorAll(':scope > li, :scope > .log, .lyrics-lines > li:not(.pause), .menu-list > *'),
      ]
        .filter((row) => row.getClientRects().length)
        .map((row) => row.getBoundingClientRect().height)
        .sort((a, b) => a - b);
      const row = rows[Math.floor(rows.length / 2)];
      if (row !== undefined && most + 0.5 < row)
        found.push(`${name} fades over ${most} px at most, its rows are ${row}`);
      if (most < 38) found.push(`${name} fades over ${most} px, less than a line and its gap (38)`);
      // Each edge's fade as drawn (what the page told the box, up to --fade): the whole fade with a pixel or more
      // beyond it, none at an end.
      const drawn = (edge) => Math.min(most, Number.parseFloat(box.style.getPropertyValue(`--fade-${edge}`)) || 0);
      const beyond = { above: box.scrollTop, below: box.scrollHeight - box.clientHeight - box.scrollTop };
      for (const [edge, length] of Object.entries(beyond)) {
        if (Math.abs(drawn(edge) - (length >= 1 ? most : 0)) > 1)
          found.push(`${name} fades ${edge} over ${drawn(edge)} px, ${Math.round(length)} beyond`);
      }
    }
    return found;
  });
  if (problems.length > 0) throw new Error(`the scrolling boxes' edges: ${problems.join('; ')}`);
}

// Every choice made is marked in the brand's blue, as a chosen segment is (its soft blue): a choice in a list (the
// menu's page in use was a grey row beside the blue segments) and the history's two lists in its head (by weight alone,
// "Recently played | Liked" read as a heading and a stray word).
async function choicesInBlue(page) {
  const wrong = await page.evaluate(() => {
    // The token as the browser computes it, to compare with what the choices are drawn in.
    const probe = document.createElement('i');
    probe.style.background = 'var(--accent-soft)';
    document.body.append(probe);
    const soft = getComputedStyle(probe).backgroundColor;
    probe.remove();
    // A choice in a list in use, and the choice made in a row of choices.
    const inUse = '[aria-checked="true"], [aria-current="true"], [aria-current="page"], [aria-pressed="true"]';
    const chosen = document.querySelectorAll(`.choice:is(${inUse}), .seg button[aria-pressed="true"]`);
    return [...chosen]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => getComputedStyle(element).backgroundColor !== soft)
      .map((element) => `"${element.textContent.trim()}" on ${getComputedStyle(element).backgroundColor}`);
  });
  if (wrong.length > 0) throw new Error(`choices made out of the brand's blue: ${wrong.slice(0, 3).join(', ')}`);
}

// One order for adding a track, from the gentlest to the one that cuts off what everyone hears: the add card's keys
// (Add, Play next, Play now), a search result's picks under them, a history row's keys (after its heart, before its
// list key), and a queued row's (Play next, Play now, then Remove). The results and the history had them reversed.
async function oneOrder(page) {
  const orders = await page.evaluate(() => {
    const of = (selector, key) =>
      [...(document.querySelector(selector)?.children ?? [])].map((element) => element.dataset[key]).join();
    return {
      'the add card': [of('.add', 'at'), 'end,next,now'],
      'a result': [of('#add-found .picks', 'pick'), 'end,next,now'],
      // A history row's heart and the key that lists the rest in words, at every width (libraryKeys).
      'a history row': [of('.history .row .acts', 'key'), 'like,more'],
      // That list, open: the add card's order.
      "a history row's list": [of('.dialog .menu-list:has([data-choice="again"])', 'choice'), 'again,next,now'],
      'a queued row': [of('.queue-list .row:not(.next) .acts', 'key'), 'next,jump,remove,more'],
    };
  });
  const wrong = Object.entries(orders)
    .filter(([, [order, meant]]) => order !== '' && order.replace(/^,+|,+$/g, '') !== meant)
    .map(([name, [order, meant]]) => `${name}: ${order} (${meant} meant)`);
  if (wrong.length > 0) throw new Error(`the keys that add a track: ${wrong.join('; ')}`);
}

// Past the widest the page's content grows (1680 px), it stands in the middle at that width: on a 2560 px screen the
// queue's rows were 1,950 px wide, a title 1,700 px from its keys, and the add field 1,650 px. The bars' contents stand
// in the same column, their glass across the window (the logo and the account stood 420 px outside the cards at 2560).
async function pageCentred(page) {
  const off = await page.evaluate(() => {
    // Where a box's content starts and ends, inside its padding.
    const inside = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        left: box.left + Number.parseFloat(style.paddingLeft),
        right: box.right - Number.parseFloat(style.paddingRight),
      };
    };
    const main = document.querySelector('.main:not([hidden])') ?? document.querySelector('.page');
    const { left, right } = inside(main);
    if (right - left > 1680.5) return `the page's content is ${Math.round(right - left)} px wide`;
    const window = document.documentElement.clientWidth;
    const across = left - (window - right);
    if (Math.abs(across) > 1) return `the page's content stands ${across.toFixed(1)} px off the window's middle`;
    for (const [selector, name] of [
      ['.bar', 'the top bar'],
      ['.listen', 'the listening bar'],
    ]) {
      const bar = document.querySelector(selector);
      if (!bar?.getClientRects().length) continue;
      const edges = inside(bar);
      const span = (from, to) => `${Math.round(from)} to ${Math.round(to)}`;
      if (Math.abs(edges.left - left) > 0.5 || Math.abs(edges.right - right) > 0.5)
        return `${name}'s contents span ${span(edges.left, edges.right)}, the page's ${span(left, right)}`;
    }
    return null;
  });
  if (off) throw new Error(off);
}

// What this login cannot press is not drawn, nor what does nothing here: every key, field and slider shown on the
// page's cards and in the listening bar can be pressed, but a key at work for a moment (busy, or the main key's place
// while the track gets ready). A login that may only look saw about 45 dim keys (the queue's tools, Autoplay, the
// sound's key, Leave, Join and the volume, a Pause beside the Skip that was its vote, three add keys on every history
// row), and an empty queue five dead tools under a live search.
async function nothingDead(page) {
  const dead = await page.evaluate(() =>
    [...document.querySelectorAll('.main :is(button, input, select), .listen :is(button, input)')]
      .filter((control) => control.getClientRects().length > 0 && getComputedStyle(control).visibility !== 'hidden')
      .filter(
        (control) =>
          control.disabled || (control.getAttribute('aria-disabled') === 'true' && !control.matches('.busy, .getting')),
      )
      .map(
        (control) =>
          control.dataset.act ??
          control.dataset.key ??
          control.getAttribute('aria-label') ??
          control.textContent.trim(),
      ),
  );
  if (dead.length > 0) throw new Error(`keys drawn that cannot be pressed: ${dead.slice(0, 6).join(', ')}`);
}

// A history row's keys, at every width: its heart and the key that lists the rest in words, each for a login that can
// press it (at 2560 px the list gave way to three bare icons, and a login that may only look had them all, dim).
async function libraryKeys(page, want) {
  const shown = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll('.history .row')]
        .filter((row) => row.getClientRects().length > 0)
        .map((row) =>
          [...row.querySelectorAll('.acts > *')]
            .filter((key) => key.getClientRects().length > 0 && getComputedStyle(key).visibility !== 'hidden')
            .map((key) => key.dataset.key)
            .join(),
        ),
    ),
  ]);
  const wrong = shown.filter((keys) => keys !== want);
  if (wrong.length > 0) throw new Error(`history rows show "${wrong.join('" | "')}", not "${want}"`);
}

// Who listens in browsers stands at the end of its row (the faces, or "Nobody"), with Invite after it or without it: for
// a login that may not invite, "Listening in browsers Nobody" ran together.
async function listenersEnd(page) {
  const apart = await page.evaluate(() => {
    const row = document.querySelector('.listeners');
    const last = [...row.children].filter((part) => part.getClientRects().length > 0).at(-1);
    const end = row.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(row).paddingRight);
    return end - last.getBoundingClientRect().right;
  });
  if (apart > 0.5) throw new Error(`who listens in browsers stands ${apart.toFixed(1)} px short of the row's end`);
}

// ---- the walk ---------------------------------------------------------------------------------------------------
await api('POST', '/guilds/local/player/stop').catch(() => {});
// Nothing playing: past the widest the page grows, its content in the middle.
await sweep('idle', SIZES, pageCentred);
await sweep('login', FEW);

await api('POST', '/guilds/local/player/resume');
await until('playing');
// A track playing, at every width: the queue's head steady with its longest words, every row's line whole with who
// added the track, the lists faded at their edges, the content in the middle past its widest; the history's rows with
// their heart and list key, the voice card's words in one column, the heart after the title.
await sweep('playing', SIZES, async (page) => {
  await headSteady(page);
  await rowsWhole(page);
  await edgesFade(page);
  await pageCentred(page);
  await libraryKeys(page, 'like,more');
  await voiceColumn(page);
  await heartAfterTitle(page);
  // The history's list shown, in its head.
  await choicesInBlue(page);
});
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
// The voice card's words in one column, after each row's icon: the bot's place, the channels, the sound and who listens
// (they started at 1084, 1080 and, for "Sound" with no icon, 1056 px).
async function voiceColumn(page) {
  const starts = await page.evaluate(() => {
    const card = document.querySelector('.card[aria-labelledby="voice-h"]');
    return [...card.querySelectorAll(':scope > .voice-now, .channels > .channel, :scope > .sound, :scope > .listeners')]
      .filter((row) => row.getClientRects().length > 0)
      .map((row) => {
        // The first thing after the row's icon: its words (or the slider that stands in their place).
        const first = [...row.children].find((part) => part.getClientRects().length > 0 && !part.matches('.icon'));
        return [row.classList[0], first ? first.getBoundingClientRect().left : null];
      })
      .filter(([, left]) => left !== null);
  });
  const lefts = starts.map(([, left]) => left);
  if (Math.max(...lefts) - Math.min(...lefts) > 0.5)
    throw new Error(`the voice card's words start at ${starts.map(([row, left]) => `${row} ${left}`).join(', ')}`);
}

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
    // And as far apart as each other, one under another: Leave from the first Join as the Joins (16 px against 8), and
    // the heads side by side as one line, of one height with their rules level (the voice card's was 13 px shorter, its
    // title 7 px higher than the playing card's).
    const uneven = await page.evaluate(() => {
      const found = [];
      const keys = [...document.querySelectorAll('.voice-now > .key, .channels .key')]
        .filter((key) => key.getClientRects().length > 0)
        .map((key) => key.getBoundingClientRect())
        .sort((a, b) => a.top - b.top);
      const gaps = keys.slice(1).map((key, at) => key.top - keys[at].bottom);
      if (gaps.length > 0 && Math.max(...gaps) - Math.min(...gaps) > 0.5)
        found.push(`the voice card's keys ${gaps.map((gap) => gap.toFixed(1)).join(', ')} px apart`);
      const heads = ['now-h', 'voice-h'].map((id) =>
        document.querySelector(`.card[aria-labelledby="${id}"] > .card-head`).getBoundingClientRect(),
      );
      // Side by side only (one column stacks them).
      if (heads[0].right <= heads[1].left && Math.abs(heads[0].bottom - heads[1].bottom) > 0.5)
        found.push(`the heads side by side end ${Math.abs(heads[0].bottom - heads[1].bottom).toFixed(1)} px apart`);
      return found;
    });
    if (uneven.length > 0) throw new Error(uneven.join('; '));
    await voiceColumn(page);
    // Its finger-sized keys leave the history's words the least room of any window: who added each track whole.
    await rowsWhole(page);
    await headSteady(page);
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
    timezoneId: ZONE,
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
    timezoneId: ZONE,
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
// The keys after the main key stay put as the music plays, pauses and stops (Resume was 11 px wider than Pause, 14 in
// Korean on a phone, and moved Skip, Stop and Repeat): the main key keeps one width whichever of its words it shows.
await sweep(
  'keys-stay',
  [
    [390, 844],
    [412, 915],
    [1440, 900],
  ],
  async (page) => {
    const inject = await intercept(page);
    await page.reload();
    await page.waitForSelector('.now .keys:not([hidden])');
    const now = await api('GET', '/guilds/local/player');
    const places = [];
    // Getting ready too: the main key's place then says so in words of its own, which move nothing either.
    for (const [step, change] of [
      { status: 'playing' },
      { status: 'idle', track: null },
      { status: 'paused' },
      { status: 'loading', positionMs: 0, progress: 0.42 },
      { status: 'loading', positionMs: 0, progress: null, waiting: true },
    ].entries()) {
      inject({ type: 'player', player: { ...now, ...change, version: now.version + 1000 + step } });
      await page.waitForTimeout(250);
      places.push(
        await page.evaluate(() =>
          [...document.querySelectorAll('.now .keys > .key')]
            .filter((key) => key.getClientRects().length > 0)
            .map((key) => `${key.dataset.act} ${Math.round(key.getBoundingClientRect().left * 2) / 2}`)
            .join(', '),
        ),
      );
    }
    if (new Set(places).size > 1) throw new Error(`the keys move: ${places.join(' / ')}`);
  },
);
// The menu, a sheet over the right column with its edge in the gap beside it, on the owner's 2560 px screen too, where
// the page stands in the middle (with the page's 16 px for its side, the sheet's edge cut across the column's cards).
await sweep('menu', [...FEW, [2560, 1400]], async (page) => {
  await page.click('[data-act="menu"]');
  await page.waitForSelector('.sheet .section');
  await page.waitForTimeout(400);
  // The page in use (in the menu on a phone) and the theme and language chosen, in the brand's blue.
  await choicesInBlue(page);
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
// The strip a toast hangs in above the listening bar, on a narrow window, is solid: nothing of the page shows through
// it (in the top bar, whose glass is its backdrop, its own blur saw nothing, and the row behind showed through its thin
// glass in the 8 px between the toast and the bar).
async function stripIsSolid(page) {
  const strip = await page.evaluate(() => {
    const element = document.querySelector('.toasts');
    const look = getComputedStyle(element);
    return {
      position: look.position,
      background: look.backgroundColor,
      // Where it ends, and where the listening bar starts: they meet (a pixel between them showed the page).
      bottom: element.getBoundingClientRect().bottom,
      bar: document.querySelector('.listen').getBoundingClientRect().top,
    };
  });
  if (strip.position !== 'absolute') return;
  if (!/^rgb\(/.test(strip.background)) throw new Error(`the toast's strip is ${strip.background}`);
  if (Math.abs(strip.bottom - strip.bar) > 0.5)
    throw new Error(`the toast's strip ends at ${strip.bottom} px, the listening bar starts at ${strip.bar}`);
}
await sweep('toast', NARROW, async (page) => {
  await tool(page, 'dedupe');
  await page.waitForSelector('.toast');
  await stripIsSolid(page);
});
await sweep(
  'toast-discord',
  NARROW,
  async (page) => {
    await tool(page, 'dedupe');
    await page.waitForSelector('.toast');
    await stripIsSolid(page);
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
// Entries of the same count share a place, in every ranked list on the page (two tracks played once each were 1st and
// 2nd, as if one had played less): a tie's places are one, and the count after it has its position's place.
async function placesShared(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main:not([hidden])') ?? document.body;
    // Each list's rows as [place, count].
    const lists = [
      ...[...main.querySelectorAll('.wrapped-tracks')].map((list) =>
        [...list.querySelectorAll('.row')].map((row) => [
          row.querySelector('.pos')?.textContent,
          row.querySelector('.n')?.textContent,
        ]),
      ),
      ...[...main.querySelectorAll('.ranks')].map((list) =>
        [...list.querySelectorAll('.rank')].map((row) => [
          row.querySelector('.num')?.textContent,
          row.querySelector('.n')?.textContent,
        ]),
      ),
    ];
    const wrong = [];
    for (const rows of lists)
      rows.forEach(([place, count], index) => {
        if (index === 0) return;
        const [before, last] = rows[index - 1];
        if (count === last && place !== before) wrong.push(`two of ${count} at places ${before} and ${place}`);
        if (count !== last && Number(place) !== index + 1) wrong.push(`${count} at place ${place}, not ${index + 1}`);
      });
    return wrong;
  });
}
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
  problems.push(...(await placesShared(page)));
  await noLostHue(page).catch((error) => problems.push(error.message));
  // Wrapped stands on the title's line, at every width (on a phone it stood alone on a third line of the head).
  const apart = await page.evaluate(() => {
    const title = document.querySelector('.stats-head h1')?.getBoundingClientRect();
    const key = document.querySelector('.stats-head [data-route="wrapped"]')?.getBoundingClientRect();
    return title && key ? Math.abs(title.top + title.height / 2 - (key.top + key.height / 2)) : 0;
  });
  if (apart > 1) problems.push(`Wrapped stands ${Math.round(apart)} px off the title's line`);
  if (problems.length > 0) throw new Error(problems.join('; '));
});
// The column a chart's tip is about: lit, alone, and the tip at it, over it with its point at the column's middle, or
// beside its top (a column too tall for the tip over it) with its point on it; the column never under the tip. The
// last hour's tip stood over hours 18 to 22, pushed back inside the chart, its own column the others' grey.
async function tipAtColumn(page) {
  const off = await page.evaluate(() => {
    const tip = [...document.querySelectorAll('.chart-tip')].find((element) => !element.hidden);
    const lit = [...document.querySelectorAll('.bars .slot.on')];
    if (!tip || lit.length !== 1) return `${lit.length} columns lit, ${tip ? 'a' : 'no'} tip shown`;
    const slot = lit[0];
    const colour = (column) => getComputedStyle(column.firstElementChild).backgroundColor;
    const others = [...slot.parentElement.children].filter((other) => other !== slot && !other.matches('.zero'));
    if (others.some((other) => colour(other) === colour(slot))) return 'the lit column is the colour of the others';
    const box = tip.getBoundingClientRect();
    const bar = slot.firstElementChild.getBoundingClientRect();
    const point = Number.parseFloat(tip.style.getPropertyValue('--point'));
    const found = [];
    if (tip.dataset.side === 'above') {
      const aim = box.left + point - (bar.left + bar.width / 2);
      if (Math.abs(aim) > 1) found.push(`its point ${aim.toFixed(1)} px off the column's middle`);
      if (box.bottom > bar.top + 0.5) found.push('it lies over its column');
    } else {
      const at = box.top + point;
      if (at < bar.top - 0.5 || at > bar.bottom + 0.5)
        found.push(
          `its point at ${Math.round(at)}, the column from ${Math.round(bar.top)} to ${Math.round(bar.bottom)}`,
        );
      const apart = tip.dataset.side === 'right' ? box.left - bar.right : bar.left - box.right;
      if (apart < 0 || apart > 12) found.push(`it stands ${apart.toFixed(1)} px from its column`);
    }
    // A step inside its card at least (pushed to the chart's side, it stood 2 px from the card's edge).
    const card = tip.closest('.card').getBoundingClientRect();
    const side = Math.min(box.left - card.left, card.right - box.right);
    if (side < 7.5) found.push(`it stands ${side.toFixed(1)} px from its card's edge`);
    return found.length > 0 ? `the tip: ${found.join(', ')}` : null;
  });
  if (off) throw new Error(off);
}
await sweep('stats-tip', FEW, async (page) => {
  await page.goto(`${BASE}/stats`);
  await page.waitForSelector('.bars .slot');
  // In the middle of the window, as a person would have it when pointing at it (not under the bottom bar).
  await page
    .locator('.bars')
    .nth(1)
    .evaluate((element) => element.scrollIntoView({ block: 'center' }));
  // A short column of the hours, with the room for the tip over it.
  const short = await page.evaluate(() => {
    const columns = [...document.querySelectorAll('.bars')[1].querySelectorAll('.slot:not(.zero)')];
    const heights = columns.map((column) => column.firstElementChild.getBoundingClientRect().height);
    return heights.indexOf(Math.min(...heights));
  });
  await page.hover(`.bars >> nth=1 >> .slot:not(.zero) >> nth=${short}`);
  await tipAtColumn(page);
  // The last hour (an evening's, as tall as most), its tip kept inside the chart: the one photographed.
  await page.hover('.bars .slot:not(.zero) >> nth=-1');
  await tipAtColumn(page);
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
  // The records fade out at an edge with more beyond it (the first one in sight was sliced through its letters).
  await edgesFade(page);
});
// While the track gets ready there is nothing to press: the main key's place (and on a phone the listening bar's pause
// key) says the state, the loader turning, in words on the card ("Getting ready"), with no key's fill and not dimmed (a
// dim slab of the brand's blue saying "Pause" was the loudest thing on the card, and named what was not happening).
async function gettingReady(page) {
  const keys = await page.evaluate(() =>
    ['.now [data-act="pause"]', '.listen .mini > .key:first-child']
      .map((selector) => document.querySelector(selector))
      .filter((key) => key?.getClientRects().length)
      .map((key) => {
        const look = getComputedStyle(key);
        const face = key.querySelector('.face:not([aria-hidden="true"])');
        return {
          key: key.closest('.listen') ? "the bar's" : "the card's",
          busy: key.getAttribute('aria-disabled') === 'true',
          turning: [...key.querySelectorAll('svg.spin')].some((icon) => icon.getClientRects().length > 0),
          // The words: the card's shown face, or the bar's key's name (its icon alone, in a row of icons).
          words: face ? face.textContent : (key.getAttribute('aria-label') ?? ''),
          fill: look.backgroundColor,
          opacity: look.opacity,
        };
      }),
  );
  const wrong = keys
    .filter(
      (key) =>
        !key.busy ||
        !key.turning ||
        !/Getting\sready|준비\s중/.test(key.words) ||
        !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(key.fill) ||
        key.opacity !== '1',
    )
    .map((key) => JSON.stringify(key));
  if (keys.length === 0 || wrong.length > 0) throw new Error(`the keys while the track gets ready: ${wrong.join(' ')}`);
}

await sweep('loading', FEW, async (page) => {
  const inject = await intercept(page);
  await page.reload();
  await page.waitForSelector('.app .card');
  await page.waitForTimeout(300);
  const player = await api('GET', '/guilds/local/player');
  inject({ type: 'player', player: { ...player, status: 'loading', progress: 0.42, version: player.version + 1000 } });
  await page.waitForTimeout(200);
  await gettingReady(page);
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
  // One sentence that names the track and says why in words: the 0.3.3 review read "Could not play: Neon Rain: the
  // site answered 404", two colons and a number.
  const said = (await page.locator('.now .error').textContent()) ?? '';
  if (!said.includes('Neon Rain') || said.includes(':') || /\d{3}/.test(said))
    throw new Error(`the failed track reads "${said}"`);
});
// No live connection: before any state, the playing card's head says the connection's (connecting, in the colour of a
// wait, as the bar's label), and its body claims nothing (it said "Now playing" over "Connecting…", beside the bar's
// "Connecting").
await sweep('disconnected', FEW, async (page) => {
  await page.routeWebSocket(/\/api\/v1\/events/, (ws) => ws.close({ code: 1006, reason: 'gone' }).catch(() => {}));
  await page.reload();
  await page.waitForSelector('.app .card');
  await page.waitForTimeout(1500);
  const head = await page.evaluate(() => ({
    words: document.querySelector('#now-h')?.textContent ?? '',
    lamp: document.querySelector('#now-h .dot')?.className ?? '',
    title: document.querySelector('.now .title')?.getClientRects().length > 0,
  }));
  if (!/^(Connecting|연결\s중)$/.test(head.words) || !head.lamp.includes('tone-pause') || head.title)
    throw new Error(
      `connecting, the playing card says "${head.words}" (${head.lamp})${head.title ? ' over a title' : ''}`,
    );
});
// The playing track's heart right after the title's last word, on the line the title ends on, however it wraps (beside
// a title of two balanced lines it stood at the column's end, 320 px from the words).
async function heartAfterTitle(page) {
  const off = await page.evaluate(() => {
    const heart = document.querySelector('.now .title-row .like-key');
    const title = document.querySelector('.now .title');
    if (!heart?.getClientRects().length || !title?.getClientRects().length) return null;
    // The title's lines, one box each (it runs inline with the heart).
    const last = [...title.getClientRects()].at(-1);
    const key = heart.getBoundingClientRect();
    const middle = (key.top + key.bottom) / 2;
    if (middle < last.top || middle > last.bottom) return "the heart is not on the title's last line";
    const apart = key.left - last.right;
    return apart < 0 || apart > 8.5 ? `the heart stands ${apart.toFixed(1)} px after the title's last word` : null;
  });
  if (off) throw new Error(off);
}

// The seed's longest title playing, on phones and the tablet: the bar at the bottom shows it on one line.
{
  const queue = await api('GET', '/guilds/local/queue');
  const long = queue.items.find((item) => item.track.title.length > 60);
  if (long) await api('POST', `/guilds/local/queue/${long.id}/play`).catch(() => {});
  await until('playing');
  // The heart after the title's last word, which wraps here.
  await sweep('long-title', NARROW, heartAfterTitle);
}
// A queue of two hundred tracks (saved playlists loaded over and over), the long title still playing.
for (let i = 0; i < 16; i += 1) await api('POST', '/guilds/local/playlists/Friday%20night/load', { at: 'end' });
await sweep('long-queue', FEW, heartAfterTitle);
await api('DELETE', '/guilds/local/queue');
await api('POST', '/guilds/local/player/stop').catch(() => {});
// Nothing queued: the queue's card has no search and no tool that would do nothing (a live search over the empty list
// and five dead tools), and its message stands in the middle of the card where the card fills its column (two
// columns), or the card ends at it (one column): it stood at the top of a card the column's height.
async function queueAtRest(page) {
  const problems = await page.evaluate(() => {
    const found = [];
    const card = document.querySelector('.card[aria-labelledby="queue-h"]');
    const list = card.querySelector('.queue-list');
    const message = list.querySelector(':scope > .empty');
    if (card.querySelector('.head-search')?.getClientRects().length) found.push('a search field');
    const box = list.getBoundingClientRect();
    const said = message?.getBoundingClientRect();
    const side = document.querySelector('.card[aria-labelledby="voice-h"]')?.getBoundingClientRect();
    if (said && side && side.left >= card.getBoundingClientRect().right) {
      const off = (said.top + said.bottom) / 2 - (box.top + box.bottom) / 2;
      if (Math.abs(off) > 1) found.push(`its message ${off.toFixed(1)} px off the middle of the card's room`);
    } else if (card.getBoundingClientRect().bottom - box.bottom > 1.5) {
      found.push(`the card runs ${Math.round(card.getBoundingClientRect().bottom - box.bottom)} px past its message`);
    }
    return found;
  });
  if (problems.length > 0) throw new Error(`the empty queue: ${problems.join('; ')}`);
  await nothingDead(page);
}
// Nothing playing and nothing queued: the playing card has no key that would do nothing (Lyrics for no track, More
// offering to stop after it, a disabled Play the width of a phone's card), nor has the queue's (above).
await sweep('empty', FEW, async (page) => {
  const live = await page.evaluate(() =>
    [...document.querySelectorAll('.now .keys, [data-act="lyrics"], [data-act="now-more"]')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.dataset.act ?? 'the transport keys'),
  );
  if (live.length > 0) throw new Error(`with nothing to play, the playing card shows ${live.join(', ')}`);
  await queueAtRest(page);
});

// Wrapped: the seed's year of plays, the server's first month (a few plays), and a time with none; the times to
// choose from, the picture to save, and the page in a contrast theme.
// Its months as the pages count them, in their time zone.
const year = await api('GET', `/guilds/local/wrapped?period=last-12-months&tz=${ZONE_MINUTES}`);
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
      // The busiest hour as the page says it, and the moments' grid: its columns, and each moment's width in it.
      hourSaid:
        moments.find((tile) => tile.querySelectorAll('.spark i').length === 24)?.querySelector('.v')?.textContent ??
        null,
      grid: (() => {
        const grid = document.querySelector('.wrapped .tiles.moments');
        if (!grid) return null;
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').map(Number.parseFloat);
        return {
          columns: columns.length,
          column: columns[0] ?? 0,
          across: grid.getBoundingClientRect().width,
          tiles: [...grid.children].map((tile) => ({
            width: tile.getBoundingClientRect().width,
            chart: Boolean(tile.querySelector('.spark')),
          })),
        };
      })(),
      window: window.innerWidth,
      // The first track's card's share of the page's width, on a window wide enough for two columns.
      wide:
        first && window.innerWidth > 1100
          ? first.getBoundingClientRect().width /
            (document.querySelector('.wrapped .page-body')?.getBoundingClientRect().width ?? 1)
          : 0,
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
  // Its column's width, with or without the song beside it (alone across the row, a laptop's card was 1,408 px wide
  // with its row in the first 360).
  if (facts.wide > 0.5) problems.push(`the first track's card is ${Math.round(facts.wide * 100)} % of the row wide`);
  // The busiest hour as the span it is, as the picture, the statistics' tip and the Discord card say it (the page said
  // "11:00", its picture "11:00 – 12:00").
  if (facts.hourSaid !== null && !/^\d{2}:00 [–~] \d{2}:00$/.test(facts.hourSaid))
    problems.push(`the busiest hour reads "${facts.hourSaid}"`);
  // The moments are tiles of the page's grid, as wide as the totals': four a row on a wide window, two on a narrower
  // one, where a moment with a chart takes its row (two days' moments were stretched across a laptop's row, 696 px).
  const grid = facts.grid;
  if (grid) {
    const wide = facts.window > 1100;
    if (grid.columns !== (wide ? 4 : 2)) problems.push(`the moments in ${grid.columns} columns`);
    for (const tile of grid.tiles) {
      const meant = !wide && tile.chart ? grid.across : grid.column;
      if (Math.abs(tile.width - meant) > 1)
        problems.push(`a moment ${Math.round(tile.width)} px wide in columns of ${Math.round(grid.column)}`);
    }
  }
  problems.push(...(await placesShared(page)));
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
// A time with no plays: nothing to save, so no key for it (a filled slab half a phone wide that did nothing).
await sweep('wrapped-empty', FEW, async (page) => {
  await wrappedAt(page, '2020');
  if (await page.locator('[data-act="picture"]').isVisible())
    throw new Error('Save as picture shows with nothing to save');
});
await sweep('wrapped-periods', FEW, async (page) => {
  await wrappedAt(page, 'last-12-months');
  await page.click('[data-act="period"]');
  await page.waitForSelector('.dialog .choice');
  // On a phone the periods' list ended on a whole row, January and February hidden under it with nothing to say so.
  await edgesFade(page);
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
  // Why it paused, without the state's word again: "Paused" over "Paused with nobody listening" said it twice.
  const state = ((await page.locator('#now-h').textContent()) ?? '').trim().toLowerCase();
  const why = ((await page.locator('.now .player-note').textContent()) ?? '').toLowerCase();
  if (!state || why.includes(state)) throw new Error(`the notice "${why}" says the head's "${state}" again`);
});
// A track whose fetch waits for its turn among every server's fetches. Nothing plays yet, so there is nothing to press:
// the main key's place and the listening bar's pause key say the state, quietly (gettingReady: a big Pause over
// "Waiting to download" at 0:00, then a dim one, named what was not happening).
await sweep('waiting', FEW, async (page) => {
  await player(page, { status: 'loading', positionMs: 0, progress: null, waiting: true });
  await gettingReady(page);
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
  await choicesInBlue(page).catch((error) => wrong.push(error.message));
  if (wrong.length > 0) throw new Error(wrong.join('; '));
}
// The vote to skip, with no DJ role chosen (everyone may skip: nothing to vote on): its switch dimmed and taking no
// presses, its hint saying why and read with it (bright and on, it read as working). With a role, a switch as any.
async function voteSwitch(page, role) {
  const vote = await page.evaluate(() => {
    const toggle = document.querySelector('.sheet .settings .switch');
    const hint = document.getElementById(toggle?.getAttribute('aria-describedby') ?? '');
    return {
      disabled: toggle?.disabled ?? null,
      opacity: toggle ? Number(getComputedStyle(toggle).opacity) : null,
      why: hint?.textContent ?? '',
    };
  });
  const right = role ? vote.disabled === false : vote.disabled === true && vote.opacity < 0.6 && vote.why !== '';
  if (!right) throw new Error(`the vote's switch ${role ? 'with' : 'without'} a DJ role: ${JSON.stringify(vote)}`);
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
    // "View only" is what the login may do, no state of the music: its lamp unlit (in the pause colour it read as
    // "paused").
    await page.waitForFunction(() =>
      /View\sonly|보기\s전용/.test(document.querySelector('.bar .pill')?.textContent ?? ''),
    );
    const lamp = (await page.locator('.bar .pill').getAttribute('class')) ?? '';
    if (!lamp.includes('tone-idle')) throw new Error(`the bar's "View only" is ${lamp}`);
    // Nothing drawn it cannot press: hearts on the history's rows (it may like), the sound in words, and Playlists.
    await nothingDead(page);
    await libraryKeys(page, 'like');
    await voiceColumn(page);
    await listenersEnd(page);
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
  async (page) => {
    await toolsInWords(page);
    await headSteady(page);
  },
  { touch: false },
);
// A laptop's 1024 by 768 with a mouse: two columns, the queue's tools on the title's line, in words.
await sweep(
  'laptop-tools',
  [[1024, 768]],
  async (page) => {
    await toolsInWords(page);
    await headSteady(page);
  },
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
await sweep('lyrics', SIZES, async (page) => {
  await openLyrics(page);
  // The lines fade out at the box's edges rather than being cut there, over a line at least: letters' stubs under the
  // head's rule, and over 24 and 32 px half lines still showed at both edges.
  await edgesFade(page);
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
    await headSteady(page);
    // The queue's foot under three rows showed a sliver of the fourth cover over the card's edge.
    await edgesFade(page);
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
// A list of choices holds its rows' words alike: each row's first line as far from its top as the others' (beside a row
// of one line, whose words stand in the middle of its height, a row with a hint under its name started them at its
// padding, and the rows' lines stood 46, then 42 px apart).
async function choicesInLine(page) {
  const offsets = await page.evaluate(() => {
    // The dialog on top: the last in the page.
    const dialog = [...document.querySelectorAll('.dialog')].at(-1);
    return [...dialog.querySelectorAll('.menu-list > .choice')]
      .filter((choice) => choice.getClientRects().length > 0)
      .map((choice) => {
        // Its first line: the name over a hint, or its words alone.
        const first = (choice.querySelector('.choice-name') ?? choice.querySelector('.grow')).getBoundingClientRect();
        return Math.round(((first.top + first.bottom) / 2 - choice.getBoundingClientRect().top) * 2) / 2;
      });
  });
  if (Math.max(...offsets) - Math.min(...offsets) > 0.5)
    throw new Error(`the choices' first lines stand ${offsets.join(', ')} px under their tops`);
}
// The playing card's More menu (titled with the track, as a queued track's is, with Remove this track in it): what can
// be done to the track alone (Invite to listen, which is not about the track, lives beside the people listening and in
// the menu), its rows alike.
await sweep('now-more', FEW, async (page) => {
  await page.click('[data-act="now-more"]');
  await page.waitForSelector('.dialog [data-choice="stop-after"]');
  const [title, track] = await page.evaluate(() => [
    document.querySelector('.dialog h2')?.textContent,
    document.querySelector('.now .title')?.textContent,
  ]);
  if (title !== track) throw new Error(`the playing track's More is titled "${title}", not "${track}"`);
  if ((await page.locator('.dialog [data-choice="drop"]').count()) === 0) throw new Error('More has no Remove');
  const choices = await page.$$eval('.dialog .menu-list > .choice', (found) => found.map((c) => c.dataset.choice));
  if (choices.join() !== 'stop-after,drop') throw new Error(`the playing track's More holds ${choices.join(', ')}`);
  await choicesInLine(page);
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
// The listening bar while this browser listens, as a person sees it: what its Stop and timer keys say, what the timer's
// key looks like, and how far its parts reach.
async function listeningBar(page) {
  return page.evaluate(() => {
    const words = (key) =>
      [...(key?.querySelectorAll('.label') ?? [])]
        .filter((label) => label.getClientRects().length > 0)
        .map((label) => label.textContent.trim())
        .join(' ');
    const sleep = document.querySelector('.listen [data-act="sleep"]');
    const parts = [...document.querySelectorAll('.listen > *')].filter((part) => part.getClientRects().length > 0);
    return {
      stop: words(document.querySelector('.listen [data-act="listen"]')),
      sleep: words(sleep),
      face: sleep ? getComputedStyle(sleep).backgroundColor : '',
      right: Math.max(...parts.map((part) => part.getBoundingClientRect().right)),
      width: window.innerWidth,
    };
  });
}
// The timer set for thirty minutes, from the bar: its key shows it is on and the time left, beside Stop in words, at
// every width (a phone showed a moon that looked the same set or not, and the Stop key as a circle of bars).
async function sleepSet(page) {
  await listenHere(page);
  const before = await listeningBar(page);
  await page.click('[data-act="sleep"]');
  await page.click('.dialog [data-sleep="30"]');
  await page.waitForSelector('[data-act="sleep"][aria-pressed="true"]');
  // The press's own tint under the pointer gone, as a person sees the key a moment later.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const after = await listeningBar(page);
  const problems = [];
  if (!before.stop || !before.sleep) problems.push(`the keys say "${before.stop}" and "${before.sleep}"`);
  // The Listen key while listening says so ("Listening"), as the timer's key says the time it is set to: "Stop" said
  // what the player's Stop says, which stops the music for everyone, and Korean "끄기" did not say what it turned off.
  if (!/^(Listening(\shere)?|(여기서\s)?듣는\s중)$/.test(before.stop))
    problems.push(`listening, the Listen key says "${before.stop}"`);
  if (!/^\d+:\d\d$/.test(after.sleep)) problems.push(`the set timer's key says "${after.sleep}", not the time left`);
  if (after.face === before.face) problems.push('the set timer looks as one not set');
  for (const bar of [before, after])
    if (bar.right > bar.width + 0.5) problems.push(`the bar reaches ${Math.round(bar.right)} px of ${bar.width}`);
  if (problems.length > 0) throw new Error(problems.join('; '));
}
// Phones, a small tablet's width between them and the tablets (at 561 to 680 px the bar ran past the window's edge
// while listening), the tablets and the laptops.
await sweep('sleep', [...NARROW, [600, 960], ...FEW], sleepSet);
await api('DELETE', '/guilds/local/queue');
await api('POST', '/guilds/local/player/stop').catch(() => {});
// Listening with nothing playing, the timer set: the bar keeps to the phone's width.
await sweep('sleep-idle', NARROW, sleepSet);

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
// A link made and shown: Copy is the dialog's one filled key (with Make the link filled too, the step done was as loud
// as the next, and a second press made a second link), whole in the dialog's room, and the dialog's body where it
// began (under a phone's fold, a press on Copy scrolled it by 6 px and cut the top off the choices under the title).
async function linkShown(page) {
  const shown = await page.evaluate(() => {
    const dialog = document.querySelector('.dialog:not([hidden])');
    const body = dialog.querySelector('.dialog-content');
    const filled = [...dialog.querySelectorAll('.key.primary')]
      .filter((key) => key.getClientRects().length > 0)
      .map((key) => key.dataset.act);
    const copy = [...dialog.querySelectorAll('[data-act="invite-copy"]')].find((key) => key.getClientRects().length);
    const key = copy?.getBoundingClientRect();
    const room = body.getBoundingClientRect();
    return {
      filled,
      scrolled: body.scrollTop,
      cut: !key || key.top < room.top - 0.5 || key.bottom > room.bottom + 0.5,
    };
  });
  const problems = [];
  if (shown.filled.join() !== 'invite-copy') problems.push(`filled keys: ${shown.filled.join(', ')}`);
  if (shown.scrolled > 0) problems.push(`the dialog's body scrolled by ${shown.scrolled} px`);
  if (shown.cut) problems.push("Copy is cut by the dialog's room");
  if (problems.length > 0) throw new Error(`with a link shown: ${problems.join('; ')}`);
}
// Copy on a page over plain http (the walk's own address, of a LAN address's kind), where browsers give no clipboard at
// all: the text is copied through its selection, as the browser's own Copy copies (it said "copy it by hand" every
// time, the usual self-hosting); and where that is refused too, the text stays selected and the line says so. `key`
// presses Copy, `shown` is where the text is shown in the dialog.
async function copies(page, key, shown) {
  const here = await page.evaluate(() => ({ clipboard: Boolean(navigator.clipboard), secure: window.isSecureContext }));
  if (here.clipboard || here.secure) throw new Error(`the walk's page is not plain http: ${JSON.stringify(here)}`);
  // The selection's Copy refused as well (a browser that allows neither): the text selected, the line saying so.
  await page.evaluate(() => {
    document.execCommand = () => false;
  });
  await page.click(key);
  const refused = await page.evaluate(
    (shown) => ({
      line: document.querySelector('.dialog .copy-result')?.className ?? '',
      selected: window.getSelection()?.toString() === document.querySelector(shown)?.textContent,
    }),
    shown,
  );
  if (!refused.line.includes('text-bad') || !refused.selected)
    throw new Error(`Copy with no way to copy: ${JSON.stringify(refused)}`);
  // The browser's own again: copied through the selection, the text shown and nothing left selected.
  await page.evaluate(() => {
    delete document.execCommand;
    window.copied = null;
    document.addEventListener('copy', () => {
      window.copied = window.getSelection()?.toString() ?? '';
    });
  });
  await page.click(key);
  const done = await page.evaluate(
    (shown) => ({
      line: document.querySelector('.dialog .copy-result')?.className ?? '',
      copied: window.copied === document.querySelector(shown)?.textContent,
      left: window.getSelection()?.toString() ?? '',
    }),
    shown,
  );
  if (done.line.includes('text-bad') || !done.copied || done.left)
    throw new Error(`Copy on plain http: ${JSON.stringify(done)}`);
}
await sweep('invite', FEW, async (page) => {
  await invite(page);
  await page.click('.dialog [data-act="invite-make"]');
  await page.waitForSelector('.dialog .qr');
  await copies(page, '.dialog [data-act="invite-copy"]', '.dialog .invite-url');
  // The line says what happened to a link (it said "the token is selected", the tokens' words).
  const said = (await page.locator('.dialog .copy-result').textContent()) ?? '';
  if (/token|토큰/i.test(said)) throw new Error(`Copy on a listening link says: ${said}`);
  await linkShown(page);
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
  await linkShown(page);
});
// An API token made in the menu, shown once in its dialog and copied there (on plain http too). Revoked once seen, so
// the menus after it list the seed's tokens alone.
await sweep('token', FEW, async (page) => {
  await page.click('[data-act="menu"]');
  await page.fill('.sheet [data-key="token-name"]', 'Walk');
  await page.click('.sheet [data-key="token-create"]');
  await page.waitForSelector('.dialog .secret');
  await copies(page, '.dialog .dialog-keys .key.primary', '.dialog .secret');
  for (const token of await api('GET', '/tokens'))
    if (token.name === 'Walk') await api('DELETE', `/tokens/${token.id}`);
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
// A guest's player. On a window with two columns: one column in the middle, the playing card and the queue, the queue
// ending at its last row, and the right column only while the lyrics are open (a card of 760 px held "Nobody is
// listening yet" and its link's end, which the listening bar and the menu say). On one column (a phone): the guest's
// card under the queue says who listens, nobody yet as the other cards say an empty list.
async function guestLayout(page) {
  const problems = await page.evaluate(() => {
    const found = [];
    const main = document.querySelector('.main');
    const [player, side] = main.querySelectorAll(':scope > .col');
    const at = player.getBoundingClientRect();
    if (side.classList.contains('lyrics-open')) return found;
    if (side.getClientRects().length > 0) {
      // One column: the guest's card under the player's, saying nobody listens yet when nobody does.
      if (side.getBoundingClientRect().top < at.bottom - 0.5) found.push("the guest's card stands beside the player");
      const people = side.querySelectorAll('.guest-people > li:not(.empty)').length;
      if (people === 0 && !side.querySelector('.guest-people > li.empty')?.getClientRects().length)
        found.push("the guest's card does not say nobody listens yet");
      return found;
    }
    // Two columns' window: the player alone, in the middle of the window.
    const across = at.left - (document.documentElement.clientWidth - at.right);
    if (Math.abs(across) > 1) found.push(`the player stands ${across.toFixed(1)} px off the window's middle`);
    // Its queue, when it scrolls not, ends at its last row (the list's 8 px and the card's edge under it).
    const card = document.querySelector('.card[aria-labelledby="queue-h"]');
    const list = card.querySelector('.queue-list');
    const last = list.lastElementChild;
    if (last && list.scrollHeight <= list.clientHeight + 1) {
      const room = card.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
      if (room > 12) found.push(`the queue's card runs ${Math.round(room)} px past its last row`);
    }
    return found;
  });
  if (problems.length > 0) throw new Error(problems.join('; '));
}
await sweep(
  'guest',
  SIZES,
  async (page) => {
    await asGuest(page);
    await guestLayout(page);
    await edgesFade(page);
  },
  { login: false },
);
await sweep(
  'guest-lyrics',
  FEW,
  async (page) => {
    await asGuest(page);
    await openLyrics(page);
    // Beside the player on two columns' windows (the right column only now), a sheet on one.
    await guestLayout(page);
    await edgesFade(page);
  },
  { login: false },
);
// A guest's menu: the player stands where it stands beside the lyrics while the sheet is open (over the column in the
// middle, the sheet's edge cut across its cards).
await sweep(
  'guest-menu',
  [...FEW, [2560, 1400]],
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
// A friend let in to look only (the View link): the add card says what this login may do, in its terms (it said only
// the DJ role could change the music, on a jukecord with no Discord and no roles at all), and shows no field or key it
// cannot use (a field that looked usable and three dim keys, Add the loudest thing on the card).
await sweep(
  'friend-view',
  FEW,
  async (page) => {
    const link = await api('POST', '/login-links?scope=read');
    await page.goto(link.url.replace(new URL(link.url).origin, BASE));
    await page.waitForSelector('.add-card .look-only:not([hidden])');
    const why = (await page.locator('.add-card .look-only').textContent()) ?? '';
    if (/DJ/.test(why)) throw new Error(`a View login is told: ${why}`);
    const unusable = await page.$$eval(
      '.add-card :is(input, .key)',
      (found) => found.filter((element) => element.getClientRects().length > 0).length,
    );
    if (unusable > 0) throw new Error(`a View login's add card shows ${unusable} field and keys it cannot use`);
    // Nor anywhere else: no heart (it may not like), no list key on the history's rows, no tool but Playlists.
    await nothingDead(page);
    await libraryKeys(page, '');
    await listenersEnd(page);
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
// Guests among the people listening, in the made-up Discord: as many faces as the row holds with Invite at its end
// (five faces and "+1" sent Invite onto a line of its own at 1440 px), the number of the rest beside them.
await sweep(
  'listeners-guest',
  FEW,
  async (page) => {
    await page.waitForSelector('.listeners .faces');
    const off = await page.evaluate(() => {
      const row = document.querySelector('.listeners');
      const invite = row.querySelector('[data-act="invite"]').getBoundingClientRect();
      const words = row.querySelector('.grow').getBoundingClientRect();
      const faces = row.querySelectorAll('.faces > *').length;
      return invite.top < words.bottom ? null : `Invite on a line of its own beside ${faces} faces`;
    });
    if (off) throw new Error(off);
  },
  {
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
  },
);
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
    // Titled as what it is for a guest, the link that came, with no queue it would go to (it was "Add to the queue",
    // over "jukecord's queue", then said a guest cannot add).
    const title = (await page.locator('.page.share h1').textContent()) ?? '';
    // Any space between the words (the panel's words may keep a phrase together with no-break spaces).
    if (/Add\sto\sthe\squeue|대기열에\s추가/.test(title)) throw new Error(`a guest's share page is titled "${title}"`);
    if (await page.locator('.share-card .share-server').count())
      throw new Error("a guest's share page names the queue it would go to");
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
  const { text, lang, rows, word, box, pressed } = await page.evaluate(() => {
    const row = document.querySelector('.now .keys');
    const tops = new Map();
    for (const key of row?.querySelectorAll(':scope > .key') ?? []) {
      if (key.hidden || !key.offsetParent) continue;
      const top = Math.round(key.getBoundingClientRect().top);
      tops.set(top, (tops.get(top) ?? 0) + 1);
    }
    const skip = row?.querySelector('[data-act="skip"]');
    const look = skip ? getComputedStyle(skip) : null;
    const seen = (colour) => colour && !/^rgba\(\d+, \d+, \d+, 0\)$/.test(colour) && colour !== 'transparent';
    return {
      text: skip?.querySelector('.votes')?.textContent ?? '',
      lang: document.documentElement.lang,
      rows: [...tops.values()],
      // The key's own word and its box, as a person sees them.
      word: skip?.querySelector('.label')?.getClientRects().length ? skip.querySelector('.label').textContent : '',
      box: Boolean(look && (seen(look.backgroundColor) || seen(look.borderTopColor))),
      pressed: skip?.getAttribute('aria-pressed') ?? null,
    };
  });
  const want = lang === 'ko' ? `${voted ? '투표 완료' : '투표'} 1/2` : `${voted ? 'vote cast' : 'votes'} 1/2`;
  if (text !== want) throw new Error(`Skip's count says "${text}", not "${want}"`);
  if (rows.length > 2 || (rows.length === 2 && rows[0] !== 1)) throw new Error(`the keys lie in rows of ${rows}`);
  // A key that looks like one and says what it does, at every width (on a phone it was its count beside a bare icon,
  // which read as a line of status), and the vote cast shown as a key that is on (before and after differed by a
  // letter).
  if (!word || !box) throw new Error(`the vote's Skip key says "${word}"${box ? '' : ' with no box round it'}`);
  if (pressed !== String(voted)) throw new Error(`the vote's Skip key is pressed: ${pressed}, voted: ${voted}`);
}
// Someone without the DJ role, with a vote to skip under way: the Skip key says how it stands, at every width a key
// with its word, its box and its count, and the bar does not call them "View only" while their Skip works.
await sweep(
  'vote-skip',
  SIZES,
  async (page) => {
    await skipSays(page, false);
    const said = (await page.locator('.bar .pill').textContent()) ?? '';
    if (/View\sonly|보기\s전용/.test(said)) throw new Error(`the bar says "${said}" while Skip is a vote`);
    // What a login may do is no state of the music: its lamp unlit (in the pause colour it read as "paused").
    const lamp = (await page.locator('.bar .pill').getAttribute('class')) ?? '';
    if (!lamp.includes('tone-idle')) throw new Error(`the bar's "${said}" is ${lamp}`);
    // The vote the one key of the transport, here and in the bar (a dim Pause stood beside the bar's Skip), and the
    // history's rows with their hearts alone (three dim add keys on every row at 2560 px).
    await nothingDead(page);
    await libraryKeys(page, 'like');
  },
  { discord: { control: false, votes: { on: true, votes: 1, needed: 2, voted: false } } },
);
// The same person once their vote is in: the key says they voted.
await sweep(
  'vote-skip-voted',
  SIZES,
  async (page) => {
    await skipSays(page, true);
    await nothingDead(page);
  },
  { discord: { control: false, votes: { on: true, votes: 1, needed: 2, voted: true } } },
);
// The menu of someone who manages the server, with the server's settings under the DJ role.
await sweep(
  'menu-settings',
  FEW,
  async (page) => {
    await page.click('[data-act="menu"]');
    await page.waitForSelector('.sheet .settings .switch');
    await page.waitForTimeout(400);
    await voteSwitch(page, false);
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
    await voteSwitch(page, true).catch((error) => problems.push(error.message));
    if (problems.length > 0) throw new Error(problems.join('; '));
  },
  { discord: { djRole: true } },
);
// Take turns now from the queue's tools (its own key on a wide card, the list behind the tools key on a narrow one),
// and the toast that says what moved.
await sweep('take-turns', [...NARROW, [1440, 900]], async (page) => {
  await tool(page, 'turns');
  await page.waitForSelector('.toast');
  await stripIsSolid(page);
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
// page and jukecord, so no search reaches a site. Every seeded track, the most recently played first (the history
// paged back until it has them all), so a search finds what it is asked for.
const FOUND = [];
// Each made-up result's picture, by the result's address: the seed's covers are pictures in jukecord's cache (their
// own addresses lead nowhere), sent where the panel asks jukecord for a search result's picture.
const PICTURES = new Map();
for (let before = null; ; ) {
  const played = await api('GET', `/guilds/local/history?limit=200${before ? `&before=${before}` : ''}`);
  for (const entry of played) {
    if (FOUND.some((found) => found.url === entry.track.url)) continue;
    const { id, url, title, uploader, durationMs, thumbnail } = entry.track;
    PICTURES.set(url, `${BASE}/api/v1/guilds/local/tracks/${id}/cover`);
    FOUND.push({ url, title, uploader, durationMs, thumbnail });
  }
  // The history's end, or every seeded track found.
  if (played.length < 200 || FOUND.length >= 30) break;
  before = played.at(-1).id;
}
// What the made-up search lists for some words, eight results as a search shows a page of them, the best match first:
// each searched word that starts a word of the title counts twice, one that starts a word of the artist's name once;
// the rest after them, as they were (searching "paper boats" listed "여름밤 옥상에서" first and the match fourth).
function foundFor(words) {
  const asked = words.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = (text) => {
    const own = (text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u);
    return asked.filter((word) => own.some((part) => part.startsWith(word))).length;
  };
  return FOUND.map((found, at) => ({ found, at, score: matched(found.title) * 2 + matched(found.uploader) }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, 8)
    .map((entry) => entry.found);
}
async function searchFor(page, words) {
  await page.route(/\/api\/v1\/guilds\/[^/]+\/search\?/, (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    return route.fulfill({ json: { query, results: foundFor(query) } });
  });
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
  // One order for adding a track: the results' keys as the add card's above them (Add, Play next, Play now), and so
  // the history's rows and the queue's (Play next before Play now); under those keys the results had them reversed.
  await oneOrder(page);
  // Brought into sight by the arrow keys on a phone, the chosen result stops clear of the listening bar (its frame sat
  // on the bar's edge).
  const gap = await page.evaluate(() => {
    const chosen = document.querySelector('#add-found [aria-selected="true"]')?.getBoundingClientRect();
    const bar = document.querySelector('.listen')?.getBoundingClientRect();
    return chosen && bar && chosen.top < bar.top ? bar.top - chosen.bottom : null;
  });
  if (gap !== null && gap < 7.5) throw new Error(`the chosen result stops ${gap.toFixed(1)} px from the listening bar`);
  await edgesFade(page);
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
  // "총 1시간 9분" took the head onto a second line where "총 39분" fitted on one.
  await headSteady(page);
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
    // A queue of 23 tracks ("1 h 9 min in all"): on a phone Shuffle and the tools key took a line of their own.
    await headSteady(page);
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
  // In the add card's order, as every list of the keys that add a track.
  await oneOrder(page);
  await choicesInLine(page);
});
await sweep('history-keys', DISCOVERY, async (page) => {
  await page.click('.library-seg [data-view="history"]');
  await page.waitForSelector('.history .row');
  // The line under each title whole with who added the track, at every width: at 1440 px three keys beside it cut
  // every row's to "3:00 added by ...", and on phones and the tablet the name was lost at the line's end. (Measured
  // part by part: the whole line never overflows, as its last part cuts itself short.)
  await rowsWhole(page);
  await oneOrder(page);
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
    // Autoplay's key and Playlists stay; nothing else in the empty queue's head (above).
    await queueAtRest(page);
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
        ['https://media.example/demo001', 'https://media.example/demo002', 'Quiet Atlas - Velvet Hours'].join('\n'),
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
// The queue as a server has it, first: the states before left it as each needed it (the track playing was the queue's
// next as well). Nothing playing and nothing queued, then a saved playlist loaded, which starts its first track and
// queues the rest; the search is for a track in neither.
const README_SEARCH = 'golden hour';
if (!ONLY || ONLY.has('readme')) {
  await api('POST', '/guilds/local/player/stop').catch(() => {});
  await api('DELETE', '/guilds/local/queue');
  await api('POST', '/guilds/local/playlists/Friday%20night/load', { at: 'end' });
  await until('playing');
}
for (const theme of ONLY && !ONLY.has('readme') ? [] : ['light', 'dark']) {
  await api('POST', '/guilds/local/player/resume').catch(() => {});
  await until('playing');
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: 'en-US',
    timezoneId: ZONE,
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
  await searchFor(page, README_SEARCH);
  await page.evaluate(() => document.querySelector('.add-card')?.scrollIntoView({ block: 'start' }));
  await shot(5);
  // As a stranger reads the picture: the first result is what was searched for, and the queue's next track is not
  // the one playing (the picture showed "Morning Light" playing and next, and the match for its words fourth).
  const seen = {
    ...(await page.evaluate(() => ({
      first: document.querySelector('#add-found [role="option"] .name')?.textContent ?? '',
      next: document.querySelector('.queue-list .row .name')?.textContent ?? '',
    }))),
    playing: (await api('GET', '/guilds/local/player')).track?.title ?? '',
  };
  const odd = [];
  if (!README_SEARCH.split(' ').every((word) => seen.first.toLowerCase().includes(word)))
    odd.push(`searching "${README_SEARCH}" lists "${seen.first}" first`);
  if (!seen.next || seen.next === seen.playing)
    odd.push(`the queue's next track is "${seen.next}", playing "${seen.playing}"`);
  report.push({
    state: 'readme-search',
    theme,
    lang: 'en',
    width: 412,
    findings: odd.map((detail) => ({ kind: 'walk', where: 'readme-phone-5', detail })),
    errors: [],
  });
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
