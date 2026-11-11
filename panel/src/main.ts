/**
 * The panel's start: who is logged in, which server to show, the frame (the bar, the page, the listening bar), the
 * live connection, and the keyboard shortcuts.
 *
 * Pages: / (the player), /stats, /logs (the host only) and /login. Moving between them keeps the player screen and
 * the listening bar alive, so the music in this browser does not stop when someone looks at the statistics.
 */
import { ApiError, api, type Player, setCsrf, whenLoggedOut } from './api.ts';
import { avatarUrl, face, fill, guildIconUrl, h, icon, refill } from './dom.ts';
import { Live } from './live.ts';
import { logoMark } from './logo.ts';
import { collect, keep, mayControl, positionNow, state, t, update, watch } from './state.ts';
import { closeSheets, problem, toast } from './ui/layers.ts';
import { listenBar } from './views/listen.ts';
import { applyLook, menuSheet, serversSheet, shortcutsDialog } from './views/menu.ts';
import { loginPage, logsPage, statsPage, waitingPage } from './views/pages.ts';
import { act, addCard, historyCard, nowCard, queueCard, voiceCard } from './views/player.ts';

const root = document.getElementById('app') as HTMLElement;

type Route = 'player' | 'stats' | 'logs';

// The page a path shows; the log is the host's only.
function routeOf(path: string): Route {
  if (path.startsWith('/stats')) return 'stats';
  if (path.startsWith('/logs') && state.me?.kind === 'host') return 'logs';
  return 'player';
}

/** Goes to the login page (the login is gone or never was). */
function toLogin(error?: string): void {
  const next = location.pathname === '/login' ? '/' : location.pathname;
  location.assign(`/login?${new URLSearchParams({ ...(error ? { error } : {}), next })}`);
}

async function boot(): Promise<void> {
  applyLook();
  try {
    update({ status: await api.status() });
  } catch {
    // jukecord not answering: the login page and the frame say so through the live connection below.
  }
  if (location.pathname === '/login') {
    fill(root, loginPage(state.status, new URLSearchParams(location.search).get('error')));
    return;
  }
  whenLoggedOut(() => toLogin());
  let me: Awaited<ReturnType<typeof api.me>>;
  try {
    me = await api.me();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      toLogin();
      return;
    }
    problem(error);
    return;
  }
  setCsrf(me.csrf);
  update({ me });
  // Just after a start jukecord may not know its Discord servers yet (503), or may not answer at all: the page says
  // so and asks again (1 s, doubling up to 10 s) instead of staying blank.
  let guilds: Awaited<ReturnType<typeof api.guilds>> | null = null;
  for (let wait = 1000; guilds === null; wait = Math.min(10_000, wait * 2)) {
    try {
      guilds = await api.guilds();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        toLogin();
        return;
      }
      const starting = error instanceof ApiError && error.status === 503;
      fill(root, waitingPage(state.status, starting ? t().connectingDiscord : t().offline));
      await new Promise((resolve) => window.setTimeout(resolve, wait));
    }
  }
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('jukecord.guild');
  } catch {
    saved = null;
  }
  const guild = guilds.find((entry) => entry.id === saved) ?? guilds[0] ?? null;
  update({ guilds, guild });
  frame();
}

// The live connection, made once the frame is up.
let live: Live;

function frame(): void {
  live = new Live({
    status: (status) => update({ live: status }),
    outdated: () => toast(t().reload, 'pause', 'refresh-cw'),
    message: (message) => receive(message),
    // 4401, the login is gone: to the login page. 4410, the server shown is closed to this login now: start again
    // with the servers it can open. 4403, this page's address is not the one jukecord expects: said on the page.
    ended: (code) => {
      if (code === 4401) toLogin();
      else if (code === 4410) location.reload();
      else {
        // Said twice: once now, and for as long as it lasts in the bar's label (whose title gives the reason).
        update({ live: 'refused' });
        problem(t().wrongAddress);
      }
    },
  });

  // The bar.
  const version = h('span', { class: 'version' });
  const brand = h(
    'a',
    { class: 'brand', href: '/', 'data-route': 'player' },
    logoMark(26),
    h('b', null, 'jukecord'),
    version,
  );
  const serverIcon = h('span', { class: 'guild-icon' });
  const serverName = h('span', { class: 'label' });
  const server = h('button', { class: 'server', type: 'button' }, serverIcon, serverName, icon('chevron-down'));
  const pill = h('span', { class: 'pill' });
  const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
  const nav = h('nav', { class: 'nav' });
  const account = h('button', { class: 'account', type: 'button', 'data-act': 'menu' });
  const bar = h(
    'header',
    { class: 'bar' },
    brand,
    h('span', { class: 'divider' }),
    server,
    pill,
    h('div', { class: 'spacer' }, toasts),
    nav,
    account,
  );

  // The pages. The player screen is built once and kept; the others are built on each visit.
  const playerScreen = h(
    'main',
    { class: 'main' },
    h('div', { class: 'col' }, nowCard(live), queueCard(), addCard()),
    h('div', { class: 'col' }, voiceCard(), historyCard()),
  );
  const page = h('div', { class: 'page-slot', style: 'min-height:0;display:contents' });
  const listen = listenBar(live);
  fill(root, h('div', { class: 'app' }, bar, playerScreen, page, listen));

  let leave: (() => void) | null = null;
  const show = () => {
    const route = routeOf(location.pathname);
    leave?.();
    leave = null;
    playerScreen.hidden = route !== 'player';
    if (route === 'player') {
      fill(page);
    } else {
      const built = collect(() => (route === 'stats' ? statsPage() : logsPage()));
      leave = built.dispose;
      fill(page, built.value);
    }
    drawBar();
  };
  const navigate = (path: string) => {
    if (location.pathname !== path) history.pushState(null, '', path);
    closeSheets();
    show();
  };
  window.onpopstate = show;
  // Links inside the panel move between pages without reloading (which would stop the music here).
  document.addEventListener('click', (event) => {
    const link = (event.target as Element).closest('a[data-route]') as HTMLAnchorElement | null;
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(new URL(link.href).pathname);
  });

  const drawBar = () => {
    const words = t();
    const route = routeOf(location.pathname);
    version.textContent = state.status ? `v${state.status.version}` : '';
    const guild = state.guild;
    const iconUrl = guild ? guildIconUrl(guild.id, guild.icon) : null;
    refill(
      serverIcon,
      `${iconUrl}|${guild?.name}`,
      iconUrl ? h('img', { src: iconUrl, alt: '' }) : (guild?.name ?? '?').slice(0, 1),
    );
    serverName.textContent = guild?.name ?? '';
    server.title = words.servers;
    server.setAttribute('aria-label', `${words.servers}: ${guild?.name ?? ''}`);
    // Browser-only has one local queue (the bar's state says so); one server needs no chooser.
    server.hidden = state.status?.mode === 'browser-only';
    server.disabled = state.guilds.length <= 1;
    (server.querySelector('.icon:last-child') as SVGElement | null)?.toggleAttribute(
      'hidden',
      state.guilds.length <= 1,
    );
    // One label for the state of the connection, then whether this login may only look.
    const [tone, label] =
      state.live === 'refused'
        ? ['bad', words.refused]
        : state.live !== 'open'
          ? ['pause', words.reconnecting]
          : state.status?.mode === 'browser-only'
            ? ['idle', words.browserOnly]
            : state.status && !state.status.discord
              ? ['bad', words.discordDown]
              : guild && !mayControl()
                ? ['pause', words.lookOnly]
                : ['play', words.connected];
    pill.className = `pill tone-${tone}`;
    pill.title = state.live === 'refused' ? words.wrongAddress : guild && !mayControl() ? words.lookOnlyHint : '';
    refill(pill, label, h('span', { class: 'dot' }), label);
    // The links and the account key are rebuilt only when what they show changes: a click or the focus on them
    // must survive the status and guild updates.
    const host = state.me?.kind === 'host';
    refill(
      nav,
      `${route}|${state.lang}|${host}`,
      ...(
        [
          ['/', 'player', 'music-2', words.player],
          ['/stats', 'stats', 'chart-column', words.stats],
          ...(state.me?.kind === 'host' ? [['/logs', 'logs', 'scroll-text', words.logs]] : []),
        ] as [string, Route, 'music-2', string][]
      ).map(([path, name, iconName, text]) =>
        h(
          'a',
          { href: path, 'data-route': name, 'aria-current': route === name ? 'page' : null, title: text },
          icon(iconName),
          h('span', { class: 'label' }, text),
        ),
      ),
    );
    const me = state.me;
    // The host has no Discord name: "Host" in the panel's language.
    const name = me?.kind === 'host' ? words.host : (me?.name ?? '');
    if (me)
      refill(
        account,
        `${me.id}|${name}|${me.avatar}`,
        face(name, avatarUrl(me.id, me.avatar), 'sm'),
        h('span', { class: 'name' }, name),
        icon('menu'),
      );
    account.setAttribute('aria-label', words.menu);
  };
  server.onclick = () => serversSheet(choose);
  account.onclick = () => menuSheet(navigate);
  watch(['status', 'guild', 'live', 'lang', 'me', 'guilds'], drawBar);
  // The tab shows what plays; on its own watch, so player snapshots do not redraw the bar.
  watch(['player'], () => {
    document.title = state.player?.track ? `${state.player.track.title} · jukecord` : 'jukecord';
  });

  show();
  if (state.guild) live.show(state.guild.id);
  // At once on opening; later refreshes wait a moment for the server to write the entry.
  void refreshHistory(0);
  shortcuts();
  // Whether Discord is connected is asked again now and then (it is not part of the live updates).
  window.setInterval(async () => {
    try {
      const next = await api.status();
      const before = state.status;
      // Only a change of what the panel shows counts (the uptime changes every time and would redraw for nothing).
      const same =
        before !== null &&
        before.version === next.version &&
        before.discord === next.discord &&
        before.mode === next.mode &&
        before.login.discord === next.login.discord;
      if (!same) update({ status: next });
    } catch {
      // The live connection's state already says jukecord is away.
    }
  }, 30_000);
}

// Switches to another server.
function choose(id: string): void {
  const guild = state.guilds.find((entry) => entry.id === id);
  if (!guild || guild.id === state.guild?.id) return;
  keep('guild', guild.id);
  // An open sheet (the menu with the old server's DJ role) belongs to the server it was opened for.
  closeSheets();
  update({ guild, player: null, queue: null, voice: null, listeners: { people: [], count: 0 }, history: [] });
  live.show(guild.id);
  void refreshHistory();
}

// Messages from the live connection.
function receive(message: Record<string, unknown>): void {
  if (message.type === 'error') {
    problem(String(message.message ?? 'error'));
    return;
  }
  if (typeof message.guild === 'string' && message.guild !== state.guild?.id) return;
  switch (message.type) {
    case 'state':
      update({
        player: message.player as Player,
        queue: message.queue as typeof state.queue,
        voice: message.voice as typeof state.voice,
        listeners: message.listeners as typeof state.listeners,
      });
      // A whole state comes after (re)connecting: tracks may have played while this page was away.
      void refreshHistory(0);
      return;
    case 'player': {
      const next = message.player as Player;
      const before = state.player;
      // Snapshots can arrive out of order on a busy connection; an older one is dropped.
      if (before && before.track?.id === next.track?.id && next.version < before.version) return;
      update({ player: next });
      // A track that ended or changed went into the history.
      if (before && (before.track?.id !== next.track?.id || (next.status === 'idle' && before.status !== 'idle'))) {
        void refreshHistory();
      }
      return;
    }
    case 'queue':
      update({ queue: message.queue as typeof state.queue });
      return;
    case 'voice':
      update({ voice: message.voice as typeof state.voice });
      return;
    case 'listeners':
      update({ listeners: message.listeners as typeof state.listeners });
      return;
  }
}

// The recent plays, asked again after a track changes (a short wait lets the server write the entry first).
let historyTimer = 0;
async function refreshHistory(wait = 400): Promise<void> {
  window.clearTimeout(historyTimer);
  historyTimer = window.setTimeout(async () => {
    const guild = state.guild?.id;
    if (!guild) return;
    try {
      const history = await api.history(guild, 50);
      // An answer for a server no longer shown is dropped.
      if (state.guild?.id === guild) update({ history });
    } catch (error) {
      if (state.guild?.id === guild) problem(error);
    }
  }, wait);
}

// Space plays or pauses, the arrows seek, N skips, / goes to the add field, ? lists these.
function shortcuts(): void {
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    // Typing in a field, or a key with Ctrl/Cmd/Alt, is not a shortcut.
    if (target.closest('input, textarea, [contenteditable], .dialog') || event.ctrlKey || event.metaKey || event.altKey)
      return;
    const guild = state.guild?.id;
    const player = state.player;
    if (event.key === '?') {
      event.preventDefault();
      shortcutsDialog();
      return;
    }
    if (!guild || routeOf(location.pathname) !== 'player') return;
    if (event.key === '/') {
      event.preventDefault();
      (document.getElementById('add-input') as HTMLInputElement | null)?.focus();
      return;
    }
    if (!mayControl() || !player?.track) return;
    // Space on a key the keyboard reached presses that key (as everywhere); on a key last clicked with the mouse it
    // plays or pauses, rather than pressing Skip or Shuffle again.
    const keyboardKey = target.closest('button, a, [role="slider"]')?.matches(':focus-visible') ?? false;
    if (event.key === ' ' && !keyboardKey) {
      event.preventDefault();
      void act(null, () => (player.status === 'paused' ? api.resume(guild) : api.pause(guild)));
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !target.closest('[role="slider"]')) {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 10_000 : -10_000;
      void act(null, () => api.seek(guild, Math.max(0, positionNow(player, live.now()) + step)));
    } else if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      void act(null, () => api.skip(guild));
    }
  });
}

void boot();
