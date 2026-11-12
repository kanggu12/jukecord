/**
 * The panel's start: who is logged in, which server to show, the frame (the bar, the page, the listening bar), the
 * live connection, and the keyboard shortcuts.
 *
 * Pages: / (the player), /stats, /logs (the host only) and /login. Moving between them keeps the player screen and
 * the listening bar alive, so the music in this browser does not stop when someone looks at the statistics.
 */
import { ApiError, api, type Player, setCsrf, whenLoggedOut } from './api.ts';
import { avatarUrl, cssUrl, face, fill, guildIconUrl, h, icon, refill } from './dom.ts';
import { Live } from './live.ts';
import { logoMark } from './logo.ts';
import { collect, keep, liveWhy, mayControl, positionNow, state, t, update, watch } from './state.ts';
import { closeSheets, goTo, layerBack, layerOpen, problem, toast } from './ui/layers.ts';
import { listenBar } from './views/listen.ts';
import { applyLook, menuSheet, serversSheet, shortcutsDialog } from './views/menu.ts';
import { loginPage, logsPage, statsPage, waitingPage } from './views/pages.ts';
import { act, addCard, historyCard, nowCard, queueCard, refreshLikes, voiceCard } from './views/player.ts';

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
  // Who is logged in. jukecord not answering, or answering with a failure (busy, an error of its own): the page says
  // so and asks again (1 s, doubling up to 10 s), as for the servers below, instead of staying blank.
  let me: Awaited<ReturnType<typeof api.me>> | null = null;
  for (let wait = 1000; me === null; wait = Math.min(10_000, wait * 2)) {
    try {
      me = await api.me();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        toLogin();
        return;
      }
      // A request that never got an answer is jukecord not answering; an answer that is a failure is its own.
      fill(root, waitingPage(state.status, error instanceof ApiError ? t().startFailed : t().offline));
      await new Promise((resolve) => window.setTimeout(resolve, wait));
    }
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
// Whether it has been open for the server shown: until then the bar says "Connecting", after that "Reconnecting" (a
// server switch starts again from "Connecting", as the card does: nothing was lost).
let everOpen = false;

function frame(): void {
  live = new Live({
    status: (status) => update({ live: status }),
    outdated: () => toast(t().reload, 'pause', 'refresh-cw'),
    message: (message) => receive(message),
    // 1013, jukecord asks to be tried again later: why is said now (in the person's language), and stays in the
    // bar's label (its title) and on the playing card until a connection is taken.
    waiting: (reason) => {
      update({ liveWaiting: reason });
      const why = liveWhy();
      if (why) toast(why, 'bad', 'wifi-off');
    },
    // 4401, the login is gone: to the login page. 4410, the server shown is closed to this login now: start again
    // with the servers it can open. 4403, this page's address is not the one jukecord expects: said on the page.
    ended: (code) => {
      if (code === 4401) toLogin();
      else if (code === 4410) location.reload();
      else {
        // Said now, and for as long as it lasts in the bar's label (whose title gives the reason) and on the playing
        // card, whole.
        update({ live: 'refused' });
        problem(t().wrongAddress);
      }
    },
  });

  // Open for the server shown: a drop from now on is a reconnection.
  watch(['live'], () => {
    if (state.live === 'open') everOpen = true;
  });

  // The bar.
  const version = h('span', { class: 'version' });
  const brand = h(
    'a',
    // Named in words: on a phone the name beside the mark is hidden, and the link would have no name.
    { class: 'brand', href: '/', 'data-route': 'player', 'aria-label': 'jukecord' },
    logoMark(26),
    h('b', null, 'jukecord'),
    version,
  );
  const serverIcon = h('span', { class: 'guild-icon' });
  const serverName = h('span', { class: 'label' });
  // Its name cut short when long, given whole in its title (the mark for the layout's instrument).
  const server = h(
    'button',
    { class: 'server', type: 'button', 'data-clip': 'ok' },
    serverIcon,
    serverName,
    icon('chevron-down'),
  );
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
  // Each page has one level-one heading: the player's is for screen readers (the cards carry their own titles).
  const playerTitle = h('h1', { class: 'sr' });
  watch(['lang'], () => {
    playerTitle.textContent = t().player;
  });
  playerTitle.textContent = t().player;
  const playerScreen = h(
    'main',
    { class: 'main' },
    playerTitle,
    h('div', { class: 'col' }, nowCard(live), queueCard(), addCard()),
    h('div', { class: 'col' }, voiceCard(), historyCard()),
  );
  // The cards rise into place once, when the panel opens; coming back from another page they are simply there.
  window.setTimeout(() => playerScreen.classList.add('risen'), 1200);
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
    // The sheet first: its history entry, when it is the newest, becomes the new page's (see goTo).
    closeSheets();
    goTo(path);
    show();
  };
  // Back and Forward: a layer's own entry closes the layer on top (or was the panel's own); any other is a page.
  window.onpopstate = (event) => {
    if (!layerBack(event.state)) show();
  };
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
    // A long name is cut short in the bar: the key's title gives it whole (and says what the key opens).
    server.title = guild ? `${words.servers}: ${guild.name}` : words.servers;
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
          ? ['pause', everOpen ? words.reconnecting : words.connectingLive]
          : state.status?.mode === 'browser-only'
            ? ['idle', words.browserOnly]
            : state.status && !state.status.discord
              ? ['bad', words.discordDown]
              : guild && !mayControl()
                ? ['pause', words.lookOnly]
                : ['play', words.connected];
    pill.className = `pill tone-${tone}`;
    pill.title =
      state.live === 'refused'
        ? words.wrongAddress
        : state.live !== 'open' && state.liveWaiting !== null
          ? (liveWhy() ?? '')
          : guild && !mayControl()
            ? words.lookOnlyHint
            : '';
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
        // Cut short when long (a Discord name can be 32 letters), with the whole name as its title.
        h('span', { class: 'name', title: name, 'data-clip': 'ok' }, name),
        icon('menu'),
      );
    // The name the key shows, then what it opens (a screen reader hears what is on the key).
    account.setAttribute('aria-label', name ? `${name}, ${words.menu}` : words.menu);
  };
  server.onclick = () => serversSheet(choose);
  // The key says whether its menu is open (screen readers, and the bar shows it held while it is).
  account.setAttribute('aria-haspopup', 'dialog');
  account.setAttribute('aria-expanded', 'false');
  // The key opens the menu and closes it again (on a phone the menu covers the page, and this key stays above it).
  const menuHooks = {
    opened: () => account.setAttribute('aria-expanded', 'true'),
    closed: () => account.setAttribute('aria-expanded', 'false'),
  };
  account.onclick = () => {
    if (account.getAttribute('aria-expanded') === 'true') closeSheets();
    else menuSheet(navigate, menuHooks);
  };
  watch(['status', 'guild', 'live', 'liveWaiting', 'lang', 'me', 'guilds'], drawBar);
  // The light behind the glass: the cover of the track playing, in two layers that take turns, so the old cover fades
  // out while the new one fades in. Nothing playing: the field rests near grey.
  const ambient = h('div', { class: 'ambient', 'aria-hidden': 'true' }, h('div'), h('div'));
  document.body.prepend(ambient);
  const layers = [...ambient.children] as HTMLElement[];
  // The cover asked for (the track playing now), the one on the top layer, and which layer is on top.
  let ambientCover: string | null = null;
  let shownCover: string | null = null;
  let ambientTop = 0;
  // While the layer that would take the next cover is still fading out its own, the change waits (a picture swapped
  // under a half-faded layer shows as a cut, which quick skips made every other time).
  let ambientWait = 0;
  const light = () => {
    ambientWait = 0;
    const cover = ambientCover;
    if (cover === shownCover) return;
    const top = layers[ambientTop];
    const free = layers[1 - ambientTop];
    if (!top || !free) return;
    if (!cover) {
      // Nothing playing: the light fades out and the field rests.
      top.classList.remove('on');
      shownCover = null;
      return;
    }
    // Still showing some of its old cover (its fade-out lasts 1.4 s): asked again in a moment, with whatever cover
    // is the newest by then. With motion off it is clear at once.
    if (Number(getComputedStyle(free).opacity) > 0.01) {
      ambientWait = window.setTimeout(light, 150);
      return;
    }
    free.style.backgroundImage = cssUrl(cover);
    // The new cover fades in over the old one, which fades out.
    free.classList.add('on');
    top.classList.remove('on');
    ambientTop = 1 - ambientTop;
    shownCover = cover;
  };
  watch(['player'], () => {
    const cover = state.player?.track?.thumbnail ?? null;
    if (cover === ambientCover) return;
    ambientCover = cover;
    // A change already waiting takes the newest cover when its turn comes.
    if (!ambientWait) light();
  });
  // The tab shows what plays; on its own watch, so player snapshots do not redraw the bar.
  watch(['player'], () => {
    document.title = state.player?.track ? `${state.player.track.title} · jukecord` : 'jukecord';
  });

  show();
  if (state.guild) live.show(state.guild.id);
  // At once on opening; later refreshes wait a moment for the server to write the entry.
  void refreshHistory(0);
  // This login's likes, for the hearts and the liked list.
  void refreshLikes();
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
  everOpen = false;
  update({ guild, player: null, queue: null, voice: null, listeners: { people: [], count: 0 }, history: [] });
  live.show(guild.id);
  void refreshHistory();
  void refreshLikes();
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
      // A whole state comes after (re)connecting: tracks may have played while this page was away, and likes may have
      // changed in another tab or in Discord.
      void refreshHistory(0);
      void refreshLikes();
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
    // Nor is a key pressed while a sheet or a dialog is open: arrows there move between its choices.
    if (
      layerOpen() ||
      target.closest('input, textarea, [contenteditable], .dialog, .sheet') ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
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
