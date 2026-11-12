/**
 * The player screen's cards: what plays now (the disc, the progress bar, the keys), the queue, adding tracks, the
 * voice channel with who listens in browsers, and what played recently.
 *
 * Each card builds its elements once and redraws only the parts that change, when the state it watches changes.
 * The progress bar moves on a 4-per-second timer only while something plays; nothing moves while idle or paused.
 */

import { sayError, sayFailure } from '../../../src/core/say.ts';
import {
  ApiError,
  api,
  type HistoryEntry,
  type Player,
  type PlaylistFile,
  type QueueItem,
  type SearchResult,
  type Track,
} from '../api.ts';
import { avatarUrl, clock, cssUrl, face, fill, h, icon, keepingFocus, refill } from '../dom.ts';
import type { IconName } from '../icons.ts';
import type { Live } from '../live.ts';
import { isLiked, keep, liveWhy, mayControl, positionNow, state, t, update, watch } from '../state.ts';
import { askDialog, confirmDialog, problem, showDialog, toast } from '../ui/layers.ts';

/** A disc: the track's picture in the middle, the rainbow rim while playing, white when paused. */
export function disc(size: 'lg' | 'sm', track: Track | null, mode: 'playing' | 'paused' | 'idle'): HTMLElement {
  const picture = track?.thumbnail
    ? h('img', { src: track.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' })
    : null;
  if (picture) picture.onerror = () => picture.remove();
  return h(
    'div',
    { class: `disc ${size === 'sm' ? 'sm' : ''} ${mode}`.trim(), 'aria-hidden': 'true' },
    h('div', { class: 'spinner' }, h('div', { class: 'label' }, picture)),
    h('div', { class: 'hole' }),
  );
}

/** A row's album: the cover in its case, and the disc half out of it with the cover again on its label. */
export function album(track: Track): HTMLElement {
  const picture = track.thumbnail
    ? h('img', { src: track.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' })
    : null;
  const vinyl = h('div', { class: 'vinyl' });
  const box = h('div', { class: 'case' }, picture ?? h('span', { class: 'note' }, icon('music-2')));
  if (picture) {
    // The label shows the same picture once it has loaded; a picture that fails leaves the case's note.
    picture.onload = () => vinyl.style.setProperty('--cover', cssUrl(picture.currentSrc || picture.src));
    picture.onerror = () => {
      picture.remove();
      box.append(h('span', { class: 'note' }, icon('music-2')));
    };
  }
  return h('div', { class: 'album', 'aria-hidden': 'true' }, box, vinyl);
}

/** Whether the panel moves: the menu's motion setting, and the system's own wish for less motion. */
export function moving(): boolean {
  return state.motion && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Plays a one-off animation on an element (a class its CSS animates), and takes the class away when it ends. */
export function flash(element: HTMLElement, name: string): void {
  if (!moving()) return;
  element.classList.remove(name);
  // Reading the layout restarts the animation when the class was there already.
  void element.offsetWidth;
  element.classList.add(name);
  const done = (event: Event) => {
    // Only the element's own animation ends it, not one of a row inside it.
    if (event.target !== element) return;
    element.classList.remove(name);
    element.removeEventListener('animationend', done);
  };
  element.addEventListener('animationend', done);
}

// The disc's mode from the player's status.
function discMode(player: Player | null): 'playing' | 'paused' | 'idle' {
  if (player?.status === 'playing') return 'playing';
  if (player?.status === 'paused') return 'paused';
  return 'idle';
}

/** Runs an action from a key: the key is busy meanwhile, and a refusal shows as a toast. */
export async function act<T>(button: HTMLButtonElement | null, run: () => Promise<T>): Promise<T | undefined> {
  if (button) button.disabled = true;
  try {
    return await run();
  } catch (error) {
    problem(error);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// The server shown (the panel only draws cards once one is chosen).
function guild(): string {
  return state.guild?.id ?? '';
}

/** The tracks this login liked, asked again (when the panel opens, after a reconnection, on another server). */
export async function refreshLikes(): Promise<void> {
  const id = guild();
  if (!id) return;
  try {
    const liked = await api.likes(id);
    if (state.guild?.id === id) update({ liked });
  } catch {
    // Kept as they were: the hearts say what was known, and the next refresh tries again.
  }
}

/**
 * Likes a track, or takes the like back: on the page at once (every heart of the track fills or empties), then asked
 * of jukecord; a refusal puts the hearts back and says why.
 */
export async function toggleLike(track: Track): Promise<void> {
  const before = state.liked ?? [];
  const liked = before.some((entry) => entry.track.id === track.id);
  update({
    liked: liked ? before.filter((entry) => entry.track.id !== track.id) : [{ track, likedAt: Date.now() }, ...before],
  });
  try {
    if (liked) await api.unlike(guild(), track.id);
    else await api.like(guild(), track.id);
  } catch (error) {
    update({ liked: before });
    problem(error);
  }
}

// Whether this login may like (a token that may only look may not).
function mayLike(): boolean {
  return Boolean(state.me) && state.me?.scope !== 'read';
}

// A heart that likes a track (pressed: liked), small for rows.
function heartKey(track: Track): HTMLButtonElement {
  const words = t();
  const heart = h(
    'button',
    {
      class: 'key sm square quiet like-key',
      type: 'button',
      title: words.like,
      'aria-label': words.like,
      'aria-pressed': String(isLiked(track.id)),
      dataset: { key: 'like' },
    },
    icon('heart'),
  );
  heart.disabled = !mayLike();
  heart.onclick = () => void toggleLike(track);
  return heart;
}

// "added by Alice" / "added by the host" / "added by Autoplay" (autoplay's rows carry "autoplay" for who added them).
function addedBy(id: string | null, name: string | null): string {
  if (id === 'autoplay') return t().byAutoplay;
  return id ? t().addedBy(name ?? id) : t().byHost;
}

/** "3 min ago", "yesterday". */
export function ago(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return t().justNow;
  if (minutes < 60) return t().minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t().hoursAgo(hours);
  return t().daysAgo(Math.floor(hours / 24));
}

/** What plays now. */
export function nowCard(live: Live): HTMLElement {
  const pill = h('span', { class: 'pill tone-idle' });
  const art = h('div', { class: 'art' });
  const title = h('h3', { class: 'title' });
  const meta = h('div', { class: 'meta' });
  const error = h('div', { class: 'error', role: 'status' });
  // Why there are no live updates, while there are none for a reason: in whole, where a touch screen shows it too.
  const liveNote = h('div', { class: 'live-note', role: 'status' });
  const fillBar = h('div', { class: 'fill' });
  const knob = h('div', { class: 'knob' });
  const tip = h('div', { class: 'tip', hidden: true });
  const bar = h('div', { class: 'track', role: 'slider', tabindex: '0', 'aria-valuemin': '0' }, fillBar, knob, tip);
  const now = h('span', { class: 'num' }, '0:00');
  const end = h('span', { class: 'num' }, '');
  const progress = h('div', { class: 'progress' }, bar, h('div', { class: 'times' }, now, end));
  const pause = h('button', { class: 'key primary', type: 'button', 'data-act': 'pause' });
  const skip = h('button', { class: 'key', type: 'button', 'data-act': 'skip' });
  const stop = h('button', { class: 'key', type: 'button', 'data-act': 'stop' });
  const drop = h('button', { class: 'key quiet bad', type: 'button', 'data-act': 'drop' });
  const repeat = h('button', { class: 'key square', type: 'button', 'data-act': 'repeat' });
  const keys = h('div', { class: 'keys' }, pause, skip, stop, repeat, drop);
  // The heart beside the title: liking is about the track, not the player, so it is not among the keys.
  const like = h(
    'button',
    { class: 'key sm square quiet like-key', type: 'button', 'data-act': 'like' },
    icon('heart'),
  );
  const titleRow = h('div', { class: 'title-row' }, title, like);
  const info = h('div', { class: 'info' }, titleRow, meta, error, liveNote, progress, keys);
  const body = h('div', { class: 'now' }, art, info);
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'now-h' },
    h('div', { class: 'card-head' }, h('h2', { id: 'now-h' }, ''), pill),
    body,
  );

  // Where a drag on the bar would seek to, shown in the tip while dragging.
  let dragging: number | null = null;
  // Brings the card back after Skip if no answer has done it by then.
  let skipTimer = 0;
  let drawnTrack: number | null | undefined;
  let drawnMode = '';

  const draw = () => {
    const player = state.player;
    const words = t();
    (card.querySelector('#now-h') as HTMLElement).textContent = words.nowPlaying;
    const mode = discMode(player);
    card.classList.toggle('playing', mode === 'playing');
    card.classList.toggle('paused', mode === 'paused');
    // The disc is rebuilt only when the track or the mode changes, so its spin is not restarted by every snapshot.
    const trackId = player?.track?.id ?? null;
    if (trackId !== drawnTrack || mode !== drawnMode) {
      fill(art, disc('lg', player?.track ?? null, mode));
      // The glow behind the disc takes the cover's colours.
      const cover = player?.track?.thumbnail;
      art.style.setProperty('--cover', cover ? cssUrl(cover) : 'none');
      // Another track (not the first drawing): it comes in from below.
      if (drawnTrack !== undefined && trackId !== drawnTrack && trackId !== null) {
        body.classList.remove('leaving');
        flash(body, 'enter');
      }
      drawnTrack = trackId;
      drawnMode = mode;
    }
    // The state, as a coloured label with a dot.
    const status = player?.status ?? 'idle';
    const tone = { playing: 'play', paused: 'pause', loading: 'load', idle: 'idle' }[status];
    pill.className = `pill tone-${tone}`;
    // Idle says itself in the title; a label saying it again would be noise.
    pill.hidden = status === 'idle';
    const label =
      status === 'loading' && player?.progress !== null && player?.progress !== undefined
        ? `${words.loading} ${Math.round(player.progress * 100)}%`
        : status === 'idle'
          ? words.idle
          : { playing: words.playing, paused: words.paused, loading: words.loading }[status];
    refill(pill, label, h('span', { class: 'dot' }), label);
    // The track. Everything below is redrawn only when what it shows changes (refill): the title link and the keys
    // must stay the same elements while snapshots arrive, or a click on them is lost.
    const track = player?.track ?? null;
    const by = addedBy(player?.addedBy ?? null, player?.addedByName ?? null);
    if (track) {
      refill(
        title,
        `${track.id}|${track.title}`,
        h('a', { href: track.url, target: '_blank', rel: 'noopener noreferrer' }, track.title),
      );
      title.removeAttribute('aria-hidden');
      refill(
        meta,
        `${track.uploader}|${by}`,
        track.uploader ? h('span', null, icon('music-2'), track.uploader) : null,
        h('span', null, icon('users'), by),
      );
    } else if (!player) {
      // No state yet: nothing is claimed about the player, only that the panel is connecting, or (refused for good)
      // that there are no live updates; why is said under it.
      const heading = state.live === 'refused' ? words.refused : `${words.connectingLive}…`;
      refill(title, `unknown|${heading}`, h('span', { class: 'muted' }, heading));
      refill(meta, 'unknown');
      title.removeAttribute('aria-hidden');
    } else {
      // Nothing playing: with tracks waiting, the Play key starts them; with none, adding one plays it.
      const hint = (state.queue?.items.length ?? 0) > 0 ? words.idleQueued : words.idleHint;
      refill(title, `idle|${words.idle}`, h('span', { class: 'muted' }, words.idle));
      title.removeAttribute('aria-hidden');
      refill(meta, `idle|${hint}`, h('span', null, hint));
    }
    error.hidden = !player?.error;
    refill(
      error,
      player?.error ?? '',
      player?.error ? icon('circle-alert') : null,
      player?.error ? words.couldNotPlay(sayFailure(player.error, state.lang)) : null,
    );
    // Refused for good, or turned away for now (jukecord full): the reason, which the bar keeps in its title only.
    const why = liveWhy();
    liveNote.hidden = !why;
    liveNote.classList.toggle('refused', state.live === 'refused');
    refill(liveNote, why ?? '', why ? icon('wifi-off') : null, why ? h('span', null, why) : null);
    progress.hidden = !track;
    // The keys: play, pause or resume, skip, stop, repeat, remove.
    const control = mayControl();
    const moving = status === 'playing' || status === 'loading';
    const queued = (state.queue?.items.length ?? 0) > 0;
    const pauseWords = moving ? words.pause : status === 'paused' ? words.resume : words.play;
    refill(pause, `${moving}|${pauseWords}`, icon(moving ? 'pause' : 'play'), pauseWords);
    // With nothing playing, the key starts the queue (when there is one); before the first state it waits.
    pause.disabled = !player || !control || (!track && !queued);
    refill(skip, words.skip, icon('skip-forward'), h('span', { class: 'label' }, words.skip));
    skip.title = words.skip;
    skip.disabled = !control || !track;
    refill(stop, words.stop, icon('square'), h('span', { class: 'label' }, words.stop));
    stop.title = words.stop;
    stop.disabled = !control || !track;
    refill(drop, words.drop, icon('x'), h('span', { class: 'label' }, words.drop));
    drop.title = words.dropHint;
    drop.disabled = !control || !track;
    const mode2 = player?.repeat ?? 'off';
    refill(repeat, mode2, icon(mode2 === 'track' ? 'repeat-1' : 'repeat'));
    repeat.setAttribute('aria-pressed', String(mode2 !== 'off'));
    const repeatLabel = { off: words.repeatOff, track: words.repeatTrack, queue: words.repeatQueue }[mode2];
    repeat.title = repeatLabel;
    repeat.setAttribute('aria-label', repeatLabel);
    repeat.disabled = !control || !player;
    bar.setAttribute('aria-disabled', String(!control || !track || status === 'loading'));
    bar.setAttribute('aria-label', words.seekLabel);
    like.hidden = !track;
    like.title = words.like;
    like.setAttribute('aria-label', words.like);
    like.setAttribute('aria-pressed', String(track !== null && isLiked(track.id)));
    like.disabled = !mayLike();
    tick();
  };

  // Moves the bar and the time; called four times a second while playing.
  const tick = () => {
    const player = state.player;
    if (!player?.track) return;
    const duration = player.durationMs ?? player.track.durationMs ?? 0;
    const at = dragging ?? positionNow(player, live.now());
    const ratio = duration > 0 ? Math.min(1, at / duration) : 0;
    fillBar.style.width = `${ratio * 100}%`;
    knob.style.left = `${ratio * 100}%`;
    now.textContent = clock(at);
    end.textContent = duration ? clock(duration) : '';
    bar.setAttribute('aria-valuemax', String(Math.round(duration / 1000)));
    bar.setAttribute('aria-valuenow', String(Math.round(at / 1000)));
    bar.setAttribute('aria-valuetext', `${clock(at)} / ${clock(duration)}`);
    bar.style.setProperty('--track-w', `${bar.clientWidth}px`);
  };

  // Seeking: a click or a drag on the bar, arrow keys on the focused bar.
  const ratioAt = (event: PointerEvent) => {
    const box = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  };
  const duration = () => state.player?.durationMs ?? state.player?.track?.durationMs ?? 0;
  const seek = (ms: number) => {
    void act(null, () => api.seek(guild(), Math.max(0, Math.round(ms))));
  };
  bar.onpointerdown = (event) => {
    if (bar.getAttribute('aria-disabled') === 'true') return;
    bar.setPointerCapture(event.pointerId);
    dragging = ratioAt(event) * duration();
    tick();
  };
  bar.onpointermove = (event) => {
    const at = ratioAt(event) * duration();
    tip.hidden = false;
    tip.style.left = `${ratioAt(event) * 100}%`;
    tip.textContent = clock(at);
    if (dragging !== null) {
      dragging = at;
      tick();
    }
  };
  bar.onpointerleave = () => {
    tip.hidden = true;
  };
  // A touch drag the browser turned into a scroll: the bar lets go instead of staying stuck where it was.
  bar.onpointercancel = () => {
    dragging = null;
    tip.hidden = true;
    tick();
  };
  bar.onpointerup = () => {
    if (dragging === null) return;
    const target = dragging;
    dragging = null;
    tip.hidden = true;
    seek(target);
  };
  bar.onkeydown = (event) => {
    if (bar.getAttribute('aria-disabled') === 'true' || !state.player) return;
    const step = event.key === 'ArrowRight' ? 10_000 : event.key === 'ArrowLeft' ? -10_000 : 0;
    if (!step) return;
    event.preventDefault();
    seek(positionNow(state.player, live.now()) + step);
  };

  pause.onclick = () => {
    const status = state.player?.status ?? 'idle';
    // Paused or idle: play on (or start the queue). Playing or loading: pause.
    void act(pause, () => (status === 'paused' || status === 'idle' ? api.resume(guild()) : api.pause(guild())));
  };
  skip.onclick = () => {
    // The track slides out to the right while the next one is asked for. The card does not wait for the answer to come
    // back: a slow one (seconds, while jukecord is busy) would leave it empty all that time.
    if (moving()) {
      body.classList.add('leaving');
      window.clearTimeout(skipTimer);
      skipTimer = window.setTimeout(() => body.classList.remove('leaving'), 900);
    }
    void act(skip, () => api.skip(guild())).finally(() => {
      // Nothing came to replace it (the end of the queue, a refusal): the card shows what it has again.
      window.setTimeout(() => body.classList.remove('leaving'), 400);
    });
  };
  stop.onclick = () => void act(stop, () => api.stop(guild()));
  like.onclick = () => {
    const track = state.player?.track;
    if (track) void toggleLike(track);
  };
  drop.onclick = () => void act(drop, () => api['remove-current'](guild()));
  repeat.onclick = () => {
    // Off, then the queue, then this track, then off again: the order music players use.
    const next = { off: 'queue', queue: 'track', track: 'off' } as const;
    void act(repeat, () => api.repeat(guild(), next[state.player?.repeat ?? 'off']));
  };

  watch(['player', 'lang', 'guild', 'me', 'queue', 'live', 'liveWaiting', 'liked'], draw);
  draw();
  // The moving parts move only while playing.
  window.setInterval(() => {
    if (state.player?.status === 'playing' && dragging === null) tick();
  }, 250);
  window.addEventListener('resize', () => tick());
  return card;
}

/** The queue, with its tools, search and the rows. */
export function queueCard(): HTMLElement {
  const count = h('span', { class: 'count' });
  const search = h('input', { type: 'search', autocomplete: 'off' });
  const searchField = h('label', { class: 'field head-search' }, icon('search'), search);
  const tool = (name: Parameters<typeof icon>[0], act: string) =>
    h('button', { class: 'key sm', type: 'button', 'data-act': act }, icon(name), h('span', { class: 'label' }));
  const shuffle = tool('shuffle', 'shuffle');
  const dedupe = tool('list-x', 'dedupe');
  const save = tool('save', 'save');
  const load = tool('folder-open', 'load');
  const clear = tool('trash-2', 'clear');
  clear.classList.add('quiet', 'bad');
  // Narrow cards (phones): Shuffle keeps its place and the other tools open from this key as a list.
  const toolsMore = h(
    'button',
    { class: 'key sm square quiet tools-more', type: 'button', 'data-act': 'queue-tools' },
    icon('ellipsis'),
  );
  const list = h('ol', { class: 'list scroll queue-list', 'aria-live': 'off' });
  // What happens when the queue runs out, beside its title: the mode in words, and a list of the three to choose from.
  const autoKey = h(
    'button',
    // As tall as the search field beside it on the same row.
    { class: 'key autoplay-key', type: 'button', 'data-act': 'autoplay', 'aria-haspopup': 'dialog' },
    icon('infinity'),
    h('span', { class: 'label' }),
  );
  const card = h(
    'section',
    { class: 'card fill', 'aria-labelledby': 'queue-h' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', { id: 'queue-h' }, h('span', { class: 'name' }), count),
      autoKey,
      searchField,
      h('div', { class: 'tools' }, shuffle, dedupe, save, load, clear, toolsMore),
    ),
    list,
  );
  const drawAutoplay = () => {
    const words = t();
    const mode = state.player?.autoplay ?? 'off';
    const label = words.autoplayKey[mode] ?? words.autoplay;
    (autoKey.querySelector('.label') as HTMLElement).textContent = label;
    autoKey.title = label;
    autoKey.setAttribute('aria-label', label);
    autoKey.classList.toggle('on', mode !== 'off');
    autoKey.disabled = !mayControl() || !state.player;
  };
  autoKey.onclick = () => autoplayDialog();
  watch(['player', 'lang', 'guild', 'me'], drawAutoplay);
  drawAutoplay();

  // Long queues draw their first rows only, a hundred more at each press of the last row's key: a thousand rows
  // rebuilt on every change would hold a phone still for seconds.
  const PAGE = 100;
  let shownLimit = PAGE;

  // Dragging a row by its grip: which item, and where it would land.
  let dragged: QueueItem | null = null;
  // The items drawn last time (null before the first state, and again after a server switch), so a row that is new
  // can slide in.
  let drawnIds: Set<number> | null = null;
  // The search the rows were last drawn for: rows glide only from one unfiltered drawing to the next (the rows of a
  // search that ends are not where they were drawn, and would glide over each other).
  let drawnQuery = '';
  // Removals asked for and not refused, by item, with when: a redraw that comes before the queue message taking them
  // away (another change's, or one sent before the removal) draws them out of sight too, until the queue no longer
  // has them, or for a few seconds at most.
  const leavingIds = new Map<number, number>();
  const LEAVE_MS = 3000;
  // Removals asked for in a server left behind are not the next one's rows.
  watch(['guild'], () => leavingIds.clear());

  // Removes items: their rows go out to the right (at once with motion off), then `run` asks jukecord. Done, the rows
  // stay out of sight until the queue's redraw takes them away: it comes a moment after the answer (jukecord sends
  // queue changes at most four times a second), and until then they must not show again. Refused, the reason is said
  // and the rows come back. Returns false when one of them is being removed already (Enter twice, a double click):
  // the first press's request is under way, and a second would be refused.
  const removeItems = (ids: number[], run: () => Promise<unknown>): boolean => {
    if (ids.some((id) => leavingIds.has(id))) return false;
    const asked = Date.now();
    for (const id of ids) leavingIds.set(id, asked);
    // The rows as drawn now (a redraw may come at any moment, so they are looked up again when needed).
    const rowsOf = () =>
      [...list.querySelectorAll<HTMLElement>('li.row')].filter((element) => ids.includes(Number(element.dataset.id)));
    // Shown again: refused, or still in the queue after a few seconds (the message taking them away did not come).
    const back = () => {
      for (const id of ids) if (leavingIds.get(id) === asked) leavingIds.delete(id);
      for (const element of rowsOf()) {
        element.classList.remove('leaving', 'gone');
        element.querySelector('[data-key="remove"]')?.removeAttribute('aria-disabled');
      }
    };
    if (moving()) for (const element of rowsOf()) element.classList.add('leaving');
    window.setTimeout(
      () =>
        void run().then(
          () => window.setTimeout(back, LEAVE_MS),
          (error: unknown) => {
            problem(error);
            back();
          },
        ),
      // The animation's length first, so the request does not race it.
      moving() ? 200 : 0,
    );
    return true;
  };

  const row = (item: QueueItem, control: boolean): HTMLElement => {
    const words = t();
    const jump = h(
      'button',
      {
        class: 'key sm square quiet',
        type: 'button',
        title: words.playNow,
        'aria-label': words.playNow,
        dataset: { key: 'jump' },
      },
      icon('play'),
    );
    const next = h(
      'button',
      {
        class: 'key sm square quiet next-key',
        type: 'button',
        title: words.playNext,
        'aria-label': words.playNext,
        dataset: { key: 'next' },
      },
      icon('arrow-up-to-line'),
    );
    const remove = h(
      'button',
      {
        class: 'key sm square quiet bad',
        type: 'button',
        title: words.remove,
        'aria-label': words.remove,
        dataset: { key: 'remove' },
      },
      icon('x'),
    );
    // A narrow card (a phone) has room for one key: it opens the row's keys as a list, with moves up and down in place
    // of the drag the phone does not have.
    const more = h(
      'button',
      {
        class: 'key sm square quiet more-key',
        type: 'button',
        title: words.trackMenu,
        'aria-label': words.trackMenu,
        dataset: { key: 'more' },
      },
      icon('ellipsis'),
    );
    jump.onclick = () => void act(jump, () => api.jump(guild(), item.id));
    next.onclick = () => void act(next, () => api.move(guild(), item.id, 0));
    remove.onclick = () => {
      // Pressed again while the first press is under way: nothing more to ask.
      if (!removeItems([item.id], () => api.remove(guild(), item.id))) return;
      // Done with, but not disabled: a disabled key drops the keyboard focus at once, and the focus must stay in the
      // row until the redraw passes it on to the row that takes its place.
      remove.setAttribute('aria-disabled', 'true');
    };
    more.onclick = () => trackMenu(item.id);
    // The first row is next already: its Play next holds the column without being a key.
    if (item.position === 0) {
      next.classList.add('ghost');
      next.disabled = true;
      next.tabIndex = -1;
      next.setAttribute('aria-hidden', 'true');
    }
    const grip = h('span', { class: 'grip', title: words.dragToMove }, icon('grip-vertical'));
    const element = h(
      'li',
      { class: `row ${item.position === 0 ? 'next' : ''}`.trim(), dataset: { id: String(item.id) } },
      grip,
      h('span', { class: 'pos' }, item.position + 1),
      album(item.track),
      h(
        'div',
        { class: 'text' },
        h(
          'div',
          { class: 'name' },
          h('a', { href: item.track.url, target: '_blank', rel: 'noopener noreferrer' }, item.track.title),
        ),
        h(
          'div',
          { class: 'sub' },
          item.position === 0 ? h('span', { class: 'badge tone-load' }, words.next) : null,
          item.track.durationMs !== null ? h('span', { class: 'num' }, clock(item.track.durationMs)) : null,
          h('span', null, addedBy(item.addedBy, item.addedByName)),
        ),
      ),
      // The menu key for everyone (it holds Like); the keys that change the queue for those who may.
      control ? h('div', { class: 'acts' }, jump, next, remove, more) : h('div', { class: 'acts' }, more),
    );
    if (control) {
      // Only the grip starts a drag, so text in the row can still be selected and links clicked.
      grip.onpointerdown = () => element.setAttribute('draggable', 'true');
      // A press of the grip that did not become a drag leaves the row as it was (a drag would have ended in dragend).
      grip.onpointerup = () => {
        if (!dragged) element.removeAttribute('draggable');
      };
      element.ondragstart = (event) => {
        // A title link or a cover dragged out of the row is that link's or picture's own drag (it carries its address);
        // only the row itself, made draggable by its grip, is a move.
        if (event.target !== element) return;
        dragged = item;
        element.classList.add('dragging');
        event.dataTransfer?.setData('text/plain', String(item.id));
      };
      element.ondragend = () => {
        dragged = null;
        element.removeAttribute('draggable');
        element.classList.remove('dragging');
        for (const other of list.querySelectorAll('.drop-before, .drop-after'))
          other.classList.remove('drop-before', 'drop-after');
      };
      element.ondragover = (event) => {
        if (!dragged || dragged.id === item.id) return;
        event.preventDefault();
        const box = element.getBoundingClientRect();
        const before = event.clientY < box.top + box.height / 2;
        element.classList.toggle('drop-before', before);
        element.classList.toggle('drop-after', !before);
      };
      element.ondragleave = () => element.classList.remove('drop-before', 'drop-after');
      element.ondrop = (event) => {
        event.preventDefault();
        if (!dragged || dragged.id === item.id) return;
        const before = element.classList.contains('drop-before');
        element.classList.remove('drop-before', 'drop-after');
        // The place it lands, counted without the dragged row itself.
        let index = item.position + (before ? 0 : 1);
        if (dragged.position < index) index -= 1;
        const moving = dragged;
        // Landing past the rows drawn: the next rows are drawn too, so it stays in sight.
        if (index >= shownLimit - 1) shownLimit += PAGE;
        void act(null, () => api.move(guild(), moving.id, index));
      };
      // Alt+arrow moves a row with the keyboard.
      element.onkeydown = (event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        const up = event.key === 'ArrowUp';
        // The first row has no place above it and the last none below: nothing to ask for (jukecord would refuse a
        // place past the end).
        if (up ? item.position === 0 : item.position >= (state.queue?.items.length ?? 0) - 1) return;
        const index = item.position + (up ? -1 : 1);
        // Moving past the rows drawn draws the next ones, so the row (and the focus on it) stays in sight.
        if (index >= shownLimit) shownLimit += PAGE;
        void act(null, () => api.move(guild(), item.id, index));
      };
    }
    return element;
  };

  const draw = () => {
    const words = t();
    const items = state.queue?.items ?? [];
    const control = mayControl();
    (card.querySelector('#queue-h .name') as HTMLElement).textContent = words.queue;
    const total = items.reduce((sum, item) => sum + (item.track.durationMs ?? 0), 0);
    // "13 tracks · 39:00 in all": the number with its unit, so it does not read as a time.
    // While searching, how many of the tracks the search shows.
    const searching = search.value.trim() !== '';
    const matching = searching
      ? items.filter((item) =>
          [item.track.title, item.track.uploader ?? '', item.addedByName ?? ''].some((text) =>
            text.toLowerCase().includes(search.value.trim().toLowerCase()),
          ),
        ).length
      : items.length;
    count.textContent =
      items.length === 0
        ? ''
        : searching
          ? words.tracksOf(matching, items.length)
          : `${words.tracks(items.length)} · ${words.total(clock(total))}`;
    search.placeholder = words.searchQueue;
    search.setAttribute('aria-label', words.searchQueue);
    for (const [button, label] of [
      [shuffle, words.shuffle],
      [dedupe, words.dedupe],
      [save, words.save],
      [load, words.load],
      [clear, words.clear],
    ] as const) {
      (button.querySelector('.label') as HTMLElement).textContent = label;
      button.title = label;
      button.disabled = !control && button !== load;
    }
    toolsMore.title = words.queueTools;
    toolsMore.setAttribute('aria-label', words.queueTools);
    toolsMore.disabled = !control;
    shuffle.disabled = !control || items.length < 2;
    dedupe.disabled = !control || items.length < 2;
    clear.disabled = !control || items.length === 0;
    save.disabled = !control || (items.length === 0 && !state.player?.track);
    load.disabled = !control || !state.queue;
    // The rows, filtered by the search; the scroll position survives the redraw.
    const query = search.value.trim().toLowerCase();
    const shown = query
      ? items.filter((item) =>
          [item.track.title, item.track.uploader ?? '', item.addedByName ?? ''].some((text) =>
            text.toLowerCase().includes(query),
          ),
        )
      : items;
    const scroll = list.scrollTop;
    // Rows glide from one unfiltered drawing to the next, with motion on: not while searching, and not on the drawing
    // that ends a search (its rows were drawn at their filtered places).
    const glide = moving() && !query && drawnQuery === '';
    // Where each row stands on the screen now (with any glide still under way), to glide it from there to its new
    // place after the redraw. Only reads: they take one layout between them.
    const before = new Map<string, number>();
    if (glide) {
      for (const element of list.querySelectorAll<HTMLElement>('li.row'))
        before.set(element.dataset.id ?? '', element.getBoundingClientRect().top);
    }
    // Forgotten: removals of items the queue no longer has (done), and of ones it still has after a few seconds (the
    // queue message that would take them away did not come; they show again).
    for (const [id, asked] of leavingIds) {
      if (Date.now() - asked > LEAVE_MS || !items.some((item) => item.id === id)) leavingIds.delete(id);
    }
    // After the redraw (a move with Alt+arrow, a track added by someone else) the same key of the same row gets the
    // keyboard focus back.
    keepingFocus(list, () => {
      if (!state.queue) {
        // No state yet (connecting): an empty list, not "the queue is empty".
        fill(list);
      } else if (items.length === 0) {
        fill(list, h('li', { class: 'empty' }, icon('list-music'), words.queueEmpty));
      } else if (shown.length === 0) {
        fill(list, h('li', { class: 'empty' }, icon('search'), words.noMatch));
      } else {
        const rows = document.createDocumentFragment();
        for (const item of shown.slice(0, shownLimit)) {
          const element = row(item, control);
          // Added since the last drawing (by anyone): it slides in. Not on the first drawing, nor in a search.
          if (drawnIds && !query && !drawnIds.has(item.id) && moving()) element.classList.add('enter');
          // Its removal is under way (this drawing is for another change): it stays out of sight, as it left, and
          // its key stays done with.
          if (leavingIds.has(item.id) && moving()) {
            element.classList.add('gone');
            element.querySelector('[data-key="remove"]')?.setAttribute('aria-disabled', 'true');
          }
          rows.append(element);
        }
        // The rest waits behind one key, which draws the next hundred.
        const left = shown.length - shownLimit;
        if (left > 0) {
          const more = h('button', { class: 'key sm', type: 'button' }, words.showMore(Math.min(PAGE, left), left));
          more.onclick = () => {
            const first = shownLimit;
            shownLimit += PAGE;
            draw();
            // The keyboard continues at the first row just drawn (the key itself is gone).
            list.querySelectorAll<HTMLElement>('li.row')[first]?.querySelector<HTMLElement>('a')?.focus();
          };
          rows.append(h('li', { class: 'more-rows' }, more));
        }
        list.replaceChildren(rows);
      }
    });
    list.scrollTop = scroll;
    if (glide && before.size > 0) glideRows(before);
    if (state.queue) drawnIds = new Set(items.map((item) => item.id));
    drawnQuery = query;
  };

  // Each row that was drawn before glides from its old place on the screen to its new one. Every position is read
  // first and every animation started after: an animation started between two reads makes the next read lay the page
  // out again, once per row (with a thousand queued and a hundred rows drawn, that held a phone still for most of a
  // second at each track start). Rows out of sight before and after are left alone; a row coming from further away
  // than the window is tall (a shuffle) fades in where it lands instead of streaking across the list.
  const glideRows = (before: Map<string, number>) => {
    // What of the list is seen: its box, inside the window (on a phone the page scrolls, and the list with it).
    const frame = list.getBoundingClientRect();
    const top = Math.max(frame.top, 0);
    const bottom = Math.min(frame.bottom, window.innerHeight);
    // The reads: where each row that was drawn before stands now, and how tall it is.
    const moves: { element: HTMLElement; from: number; to: number; height: number }[] = [];
    for (const element of list.querySelectorAll<HTMLElement>('li.row')) {
      const from = before.get(element.dataset.id ?? '');
      // New since the last drawing: it slides in by its own class instead.
      if (from === undefined) continue;
      const box = element.getBoundingClientRect();
      moves.push({ element, from, to: box.top, height: box.height });
    }
    // Whether a row standing at `at` shows any of itself in the list's seen part.
    const seen = (at: number, height: number) => at + height > top && at < bottom;
    // The writes: the animations, with no read between them.
    for (const { element, from, to, height } of moves) {
      const shift = from - to;
      // Not moved, or out of sight all the way: nothing anyone would see.
      if (Math.abs(shift) < 0.5 || (!seen(from, height) && !seen(to, height))) continue;
      if (Math.abs(shift) > window.innerHeight) {
        // From (or to) further than a window away: it fades in where it lands; leaving for far away, it just goes.
        if (seen(to, height)) element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
        continue;
      }
      // From its old place to its new one, settling like the panel's other movements.
      element.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], {
        duration: 320,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      });
    }
  };

  search.oninput = draw;
  shuffle.onclick = () => void act(shuffle, () => api.shuffle(guild()));
  dedupe.onclick = () =>
    void act(dedupe, async () => {
      const result = await api.dedupe(guild());
      toast(t().deduped(result.removed));
    });
  // The tools a narrow card hides, as a list; each runs what its key would.
  toolsMore.onclick = () => {
    const words = t();
    const box = h('div', { class: 'menu-list' });
    const dialog = showDialog(words.queue, box);
    const choice = (source: HTMLButtonElement, name: IconName, text: string, bad = false) => {
      const button = h(
        'button',
        // Named after the key it stands for, so tests (and people reading the page) can tell the choices apart.
        {
          class: `choice ${bad ? 'text-bad' : ''}`.trim(),
          type: 'button',
          dataset: { tool: source.dataset.act ?? '' },
        },
        icon(name),
        h('span', { class: 'grow' }, text),
      );
      button.disabled = source.disabled;
      button.onclick = () => {
        dialog.close();
        source.click();
      };
      return button;
    };
    fill(
      box,
      choice(dedupe, 'list-x', words.dedupe),
      choice(save, 'save', words.save),
      choice(load, 'folder-open', words.load),
      choice(clear, 'trash-2', words.clear, true),
    );
  };
  clear.onclick = async () => {
    const words = t();
    const ok = await confirmDialog({
      title: words.clearTitle,
      text: words.clearText(state.queue?.items.length ?? 0),
      ok: words.clear,
      danger: true,
    });
    // The rows sweep out to the right together, then the queue is cleared (refused, they come back with the reason).
    // Rows on their way out already are left to their own removal.
    if (ok) {
      const ids = (state.queue?.items ?? []).map((item) => item.id).filter((id) => !leavingIds.has(id));
      removeItems(ids, () => api.clear(guild()));
    }
  };
  save.onclick = async () => {
    const words = t();
    const name = await askDialog({
      title: words.saveTitle,
      text: words.saveText,
      placeholder: words.playlistName,
      ok: words.save,
    });
    if (!name) return;
    const saved = await act(save, () => api['playlist-save'](guild(), name));
    if (saved) toast(`${saved.name} · ${words.tracks(saved.size)}`);
  };
  load.onclick = () => void playlistsDialog();

  // The rows follow the queue only: a loading track sends a few snapshots a second, and rows rebuilt on each would
  // swallow clicks. The player decides one thing here, whether there is anything to save.
  // Another server starts again from its first rows (watched before the drawing, which then uses it).
  watch(['guild'], () => {
    shownLimit = PAGE;
    // The new server's rows are not new to its queue: none slides in as if just added.
    drawnIds = null;
  });
  watch(['queue', 'lang', 'guild', 'me'], draw);
  watch(['player'], () => {
    save.disabled = !mayControl() || ((state.queue?.items.length ?? 0) === 0 && !state.player?.track);
  });
  draw();
  return card;
}

// Autoplay's three modes to choose from, each with what it does; the one in use marked.
function autoplayDialog(): void {
  const words = t();
  const mode = state.player?.autoplay ?? 'off';
  const box = h('div', { class: 'menu-list' });
  const dialog = showDialog(words.autoplay, box);
  const option = (value: Player['autoplay'], label: string, hint: string) => {
    const button = h(
      'button',
      { class: 'choice', type: 'button', 'aria-current': String(value === mode), dataset: { mode: value } },
      h(
        'span',
        { class: 'grow' },
        h('span', { class: 'choice-name' }, label),
        h('span', { class: 'choice-hint' }, hint),
      ),
      icon('check', 'check'),
    );
    button.onclick = () => {
      dialog.close();
      if (value !== mode) void act(null, () => api.autoplay(guild(), value));
    };
    return button;
  };
  fill(
    box,
    option('off', words.autoplayOff, words.autoplayOffHint),
    option('history', words.autoplayHistory, words.autoplayHistoryHint),
    option('related', words.autoplayRelated, words.autoplayRelatedHint),
    // With a repeat on, the queue never runs out, so autoplay has nothing to do: said, not hidden.
    state.player && state.player.repeat !== 'off'
      ? h('p', { class: 'choice-note' }, icon('info', 'note-icon'), h('span', null, words.autoplayRepeat))
      : null,
  );
}

// A queued track's keys as a list (narrow cards and touch screens without dragging): play now, play next, one place
// up or down, remove. The place is read when a key is pressed: the queue may change while the list is open.
function trackMenu(id: number): void {
  const words = t();
  const now = () => state.queue?.items.find((entry) => entry.id === id) ?? null;
  const item = now();
  if (!item) return;
  const length = state.queue?.items.length ?? 0;
  const box = h('div', { class: 'menu-list' });
  const dialog = showDialog(item.track.title, box);
  const choice = (name: IconName, text: string, run: (position: number) => Promise<unknown>, bad = false) => {
    const button = h(
      'button',
      { class: `choice ${bad ? 'text-bad' : ''}`.trim(), type: 'button' },
      icon(name),
      h('span', { class: 'grow' }, text),
    );
    button.onclick = () => {
      dialog.close();
      // Gone from the queue meanwhile (played, removed by someone else): nothing to do.
      const current = now();
      if (current) void act(null, () => run(current.position));
    };
    return button;
  };
  // Like or Unlike: the track's, whoever may change the music.
  const liked = isLiked(item.track.id);
  const likeChoice = h(
    'button',
    { class: 'choice', type: 'button' },
    icon('heart'),
    h('span', { class: 'grow' }, liked ? words.unlike : words.like),
  );
  likeChoice.disabled = !mayLike();
  likeChoice.onclick = () => {
    dialog.close();
    void toggleLike(item.track);
  };
  const control = mayControl();
  fill(
    box,
    control ? choice('play', words.playNow, () => api.jump(guild(), id)) : null,
    control && item.position > 0 ? choice('arrow-up-to-line', words.playNext, () => api.move(guild(), id, 0)) : null,
    control && item.position > 0
      ? choice('arrow-up', words.moveUp, (position) => api.move(guild(), id, Math.max(0, position - 1)))
      : null,
    control && item.position < length - 1
      ? choice('arrow-down', words.moveDown, (position) => api.move(guild(), id, position + 1))
      : null,
    likeChoice,
    control ? choice('x', words.remove, () => api.remove(guild(), id), true) : null,
  );
}

// The saved playlists: load, rename, delete.
async function playlistsDialog(): Promise<void> {
  const words = t();
  const box = h('ul', { class: 'list', style: 'padding: 0' });
  // A playlist from a file or a pasted list, beside the Close key.
  const importKey = h(
    'button',
    { class: 'key', type: 'button', 'data-act': 'import' },
    icon('upload'),
    words.importKey,
  );
  importKey.disabled = !mayControl();
  importKey.onclick = () => importDialog(() => void draw());
  const dialog = showDialog(words.playlists, box, [importKey]);
  // The dialog's Close key (the last of its keys): where the keyboard goes when no playlist is left to stand on.
  const closeKey = () =>
    [...(box.closest('.dialog')?.querySelectorAll<HTMLElement>('.dialog-keys .key') ?? [])].at(-1) ?? null;
  const draw = async () => {
    let playlists: Awaited<ReturnType<typeof api.playlists>>;
    try {
      playlists = await api.playlists(guild());
    } catch (error) {
      problem(error);
      return;
    }
    // Drawn again after a rename or a deletion: the focus stays on the same key of the same playlist (found by its
    // number, which a rename keeps), or moves to the playlist now in a deleted one's place.
    keepingFocus(
      box,
      () => {
        if (playlists.length === 0) {
          fill(box, h('li', { class: 'empty' }, icon('list-music'), words.noPlaylists));
          return;
        }
        fill(box, ...playlists.map((playlist) => playlistRow(playlist)));
      },
      closeKey,
    );
  };
  // One playlist: its name and size, and its keys (each with a data-key, so the focus can find it again).
  const playlistRow = (playlist: { id: number; name: string; size: number }) => {
    const loadKey = h(
      'button',
      { class: 'key sm', type: 'button', dataset: { key: 'load' } },
      icon('list-plus'),
      words.load,
    );
    const renameKey = h(
      'button',
      {
        class: 'key sm square quiet',
        type: 'button',
        title: words.rename,
        'aria-label': `${words.rename}: ${playlist.name}`,
        dataset: { key: 'rename' },
      },
      icon('pencil'),
    );
    const deleteKey = h(
      'button',
      {
        class: 'key sm square quiet bad',
        type: 'button',
        title: words.delete,
        'aria-label': `${words.delete}: ${playlist.name}`,
        dataset: { key: 'delete' },
      },
      icon('trash-2'),
    );
    // The playlist as a file, of the kind chosen next.
    const exportKey = h(
      'button',
      {
        class: 'key sm square quiet',
        type: 'button',
        title: words.exportKey,
        'aria-label': `${words.exportKey}: ${playlist.name}`,
        dataset: { key: 'export' },
      },
      icon('download'),
    );
    exportKey.onclick = () => exportDialog(playlist.name);
    loadKey.onclick = async () => {
      const result = await act(loadKey, () => api['playlist-load'](guild(), playlist.name));
      if (result) {
        added(result);
        dialog.close();
      }
    };
    renameKey.onclick = async () => {
      const next = await askDialog({
        title: words.rename,
        placeholder: words.newName,
        value: playlist.name,
        ok: words.rename,
      });
      if (next && next !== playlist.name) {
        // Not made busy: a disabled key drops the keyboard focus, which the drawing after must keep.
        if ((await act(null, () => api['playlist-rename'](guild(), playlist.name, next))) !== undefined) {
          void draw();
        }
      }
    };
    deleteKey.onclick = async () => {
      const ok = await confirmDialog({
        title: words.deleteTitle(playlist.name),
        text: words.deleteText,
        ok: words.delete,
        danger: true,
      });
      if (ok && (await act(null, () => api['playlist-delete'](guild(), playlist.name))) !== undefined) void draw();
    };
    return h(
      'li',
      { class: 'channel', dataset: { id: String(playlist.id) } },
      h(
        'span',
        { class: 'name' },
        h('b', null, playlist.name),
        h('span', { class: 'faint' }, ` · ${words.tracks(playlist.size)}`),
      ),
      renameKey,
      deleteKey,
      exportKey,
      loadKey,
    );
  };
  await draw();
  // The list came after the dialog opened on its Close key: the keyboard starts at the first playlist's Load instead,
  // unless it has moved on meanwhile.
  if (document.activeElement === closeKey()) box.querySelector<HTMLElement>('[data-key="load"]')?.focus();
}

// A playlist as a file: the three kinds to choose from, each with what it holds; the choice is saved by the browser.
function exportDialog(name: string): void {
  const words = t();
  const box = h('div', { class: 'menu-list' });
  const dialog = showDialog(words.exportTitle(name), box);
  const kind = (format: PlaylistFile['format'], label: string, hint: string) => {
    const button = h(
      'button',
      { class: 'choice', type: 'button', dataset: { format } },
      icon('download'),
      h(
        'span',
        { class: 'grow' },
        h('span', { class: 'choice-name' }, label),
        h('span', { class: 'choice-hint' }, hint),
      ),
    );
    button.onclick = () => {
      dialog.close();
      void act(null, async () => {
        const file = await api['playlist-export'](guild(), name, format);
        // A link to the text, pressed and let go: the browser saves it under the file's name.
        const type = format === 'json' ? 'application/json' : format === 'm3u' ? 'audio/x-mpegurl' : 'text/plain';
        const link = h('a', { href: URL.createObjectURL(new Blob([file.content], { type })), download: file.filename });
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      });
    };
    return button;
  };
  fill(
    box,
    kind('text', words.formatText, words.formatTextHint),
    kind('m3u', words.formatM3u, words.formatM3uHint),
    kind('json', words.formatJson, words.formatJsonHint),
  );
}

// A playlist from a file or a pasted list: its name, the list (a file chosen fills it), and the key that imports it.
// `done` redraws the playlists under it.
function importDialog(done: () => void): void {
  const words = t();
  const name = h('input', {
    type: 'text',
    maxlength: '100',
    placeholder: words.playlistName,
    'aria-label': words.playlistName,
  });
  const paste = h('textarea', {
    class: 'paste',
    rows: '7',
    placeholder: words.importPaste,
    'aria-label': words.importPaste,
  });
  const picker = h('input', {
    type: 'file',
    accept: '.txt,.m3u,.m3u8,.json,text/plain,application/json,audio/x-mpegurl',
    hidden: true,
  });
  const choose = h('button', { class: 'key', type: 'button' }, icon('folder-open'), words.chooseFile);
  const go = h('button', { class: 'key primary', type: 'button' }, icon('upload'), words.importKey);
  const box = h(
    'div',
    { class: 'import-form' },
    h('p', { class: 'import-text' }, words.importText),
    h('label', { class: 'field' }, name),
    paste,
    picker,
    h('div', { class: 'import-keys' }, choose, go),
  );
  const dialog = showDialog(words.importTitle, box);
  choose.onclick = () => picker.click();
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast(words.fileTooLarge, 'bad', 'circle-alert');
      return;
    }
    paste.value = await file.text();
    // No name yet: the file's own, without its extension.
    if (!name.value.trim()) name.value = file.name.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 100);
  };
  go.onclick = async () => {
    const title = name.value.trim();
    if (!title) {
      name.focus();
      return;
    }
    if (!paste.value.trim()) {
      paste.focus();
      return;
    }
    fill(go, icon('loader-circle', 'spin'), words.importing);
    const result = await act(go, () => api['playlist-import'](guild(), title, paste.value));
    fill(go, icon('upload'), words.importKey);
    if (!result) return;
    toast(words.imported(result.playlist.name, result.tracks, result.leftOut), result.leftOut > 0 ? 'pause' : 'play');
    dialog.close();
    done();
  };
}

// What an add did, as a toast: how many went in and what was left out.
function added(result: { items: unknown[]; skippedTooLong: number; skippedFull: number }): void {
  const words = t();
  const parts = [words.added(result.items.length)];
  if (result.skippedTooLong > 0) parts.push(words.leftLong(result.skippedTooLong));
  if (result.skippedFull > 0) parts.push(words.leftFull(result.skippedFull));
  toast(parts.join(' · '), result.skippedTooLong + result.skippedFull > 0 ? 'pause' : 'play');
}

/**
 * Whether typed text is an address (with or without its scheme) rather than search words, by the rule the server
 * reads it with (src/media/source.ts, parseInput): an address is added as it is, words are searched.
 */
export function looksLikeAddress(text: string): boolean {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return false;
  return /^https?:\/\/\S+$/i.test(trimmed) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(trimmed);
}

// Where an add puts what it finds: the end of the queue, next, or playing now.
type Where = 'end' | 'next' | 'now';

/**
 * Adding: an address or search words, to the end of the queue, next, or to play now. Words show what YouTube found
 * under the field a moment after typing stops (a list to pick from, with the keyboard or the pointer); a link pasted
 * or dropped anywhere on the player's page is added as the field would add it.
 */
export function addCard(): HTMLElement {
  // A combobox: the field keeps the keyboard, and the arrows move through the list it controls.
  const input = h('input', {
    type: 'text',
    autocomplete: 'off',
    enterkeyhint: 'go',
    id: 'add-input',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': 'add-found',
    'aria-describedby': 'add-found-keys',
  });
  const field = h('label', { class: 'field' }, icon('link'), input);
  const add = h('button', { class: 'key', type: 'submit', dataset: { at: 'end' } });
  const next = h('button', { class: 'key', type: 'button', dataset: { at: 'next' } });
  const now = h('button', { class: 'key primary', type: 'button', dataset: { at: 'now' } });
  const form = h('form', { class: 'add' }, field, add, next, now);
  // What a search found: a listbox of results, a line for the state of the search, and the keys that pick.
  const list = h('ul', { class: 'found-list', id: 'add-found', role: 'listbox' });
  const searchState = h('p', { class: 'found-state' });
  const keysHint = h('p', { class: 'found-keys', id: 'add-found-keys' });
  const found = h('div', { class: 'found', hidden: true }, searchState, list, keysHint);
  // How many were found, said to screen readers as the list changes.
  const said = h('p', { class: 'sr', role: 'status' });
  // Why the keys are off for someone who may only look, in words a touch screen shows too (a title it does not).
  const why = h('p', { class: 'look-only', hidden: true });
  // While a link brought in from outside is held over the page: where it goes.
  const dropNote = h('p', { class: 'drop-note', hidden: true }, icon('list-plus'), h('span'));
  // With autoplay on and nothing waiting: what happens when the queue runs out.
  const autoNote = h('p', { class: 'auto-note', hidden: true }, icon('infinity'), h('span'));
  const card = h(
    'section',
    { class: 'card add-card', 'aria-label': 'add' },
    form,
    found,
    said,
    why,
    autoNote,
    dropNote,
  );

  // The key whose add is running: its words and its busy state stay while the card redraws for other reasons.
  let busy: HTMLButtonElement | null = null;
  const keyOf = (where: Where) => (where === 'end' ? add : where === 'next' ? next : now);
  const draw = () => {
    const words = t();
    input.placeholder = words.addPlaceholder;
    input.setAttribute('aria-label', words.addPlaceholder);
    card.setAttribute('aria-label', words.add);
    if (busy !== add) fill(add, icon('list-plus'), words.add);
    if (busy !== next) fill(next, icon('arrow-up-to-line'), words.playNext);
    if (busy !== now) fill(now, icon('play'), words.playNow);
    const control = mayControl();
    input.disabled = !control;
    for (const key of [add, next, now]) key.disabled = !control || busy !== null;
    field.title = control ? '' : words.lookOnlyHint;
    why.hidden = control || !state.guild;
    why.textContent = words.lookOnlyHint;
    list.setAttribute('aria-label', words.foundLabel);
    keysHint.textContent = words.foundKeys;
    // Nothing playing and nothing waiting: the card glows to say where music comes from.
    card.classList.toggle(
      'invite',
      control && Boolean(state.player) && !state.player?.track && (state.queue?.items.length ?? 0) === 0,
    );
    // Autoplay on and the queue empty: the card says what happens when it runs out.
    const mode = state.player?.autoplay ?? 'off';
    autoNote.hidden = mode === 'off' || (state.queue?.items.length ?? 0) > 0;
    (autoNote.lastElementChild as HTMLElement).textContent = words.autoplayNote[mode] ?? '';
  };

  // ---- what a search found -----------------------------------------------------------------------------------
  // The results shown, the words they are for, the one the arrows are on (-1: none), and what this page found
  // lately, by the words in lower case (typing back a letter shows the earlier results at once).
  let results: SearchResult[] = [];
  let resultsFor = '';
  let active = -1;
  const known = new Map<string, SearchResult[]>();
  // The search under way, the wait after the last key, and whether the list is drawn over the field.
  let asking: AbortController | null = null;
  let typing = 0;

  // Words worth searching: two letters or more, not an address, from someone who may add.
  const searchable = (text: string) => text.length >= 2 && !looksLikeAddress(text) && mayControl();

  const setActive = (index: number) => {
    active = index;
    const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    options.forEach((option, at) => {
      option.setAttribute('aria-selected', String(at === index));
    });
    const chosen = options[index];
    if (chosen) {
      input.setAttribute('aria-activedescendant', chosen.id);
      chosen.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const close = () => {
    found.hidden = true;
    card.classList.remove('found-above');
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  };

  // Opens the list where it is seen without moving the field: over the field when the card stands at the foot of a
  // page that does not scroll (the two columns, the add card under the queue), under it everywhere else.
  const open = () => {
    if (!found.hidden) return;
    const pageScrolls = document.documentElement.scrollHeight > window.innerHeight + 1;
    const listen = document.querySelector('.listen')?.getBoundingClientRect().top ?? window.innerHeight;
    const above = !pageScrolls && card.getBoundingClientRect().bottom > listen - 120;
    card.classList.toggle('found-above', above);
    found.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  // One result as an option: its cover, title, channel and length, and the three picks a pointer can press (the
  // keyboard picks with Enter, Shift+Enter and Ctrl+Enter, which the line under the list says).
  const option = (result: SearchResult, index: number): HTMLElement => {
    const words = t();
    const picture = result.thumbnail
      ? h('img', { src: result.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' })
      : null;
    const cover = h('span', { class: 'cover' }, picture ?? h('span', { class: 'note' }, icon('music-2')));
    if (picture)
      picture.onerror = () => {
        picture.remove();
        cover.append(h('span', { class: 'note' }, icon('music-2')));
      };
    const pick = (where: Where, name: IconName, label: string) =>
      h('span', { class: 'pick', title: label, dataset: { pick: where } }, icon(name));
    const sub = [result.uploader, result.durationMs === null ? null : clock(result.durationMs)].filter(Boolean);
    const element = h(
      'li',
      { class: 'result', role: 'option', id: `add-found-${index}`, 'aria-selected': 'false' },
      cover,
      h(
        'span',
        { class: 'text' },
        // Two lines at most; the whole title is its title.
        h('span', { class: 'name', title: result.title, 'data-clip': 'ok' }, result.title),
        sub.length > 0 ? h('span', { class: 'sub', title: sub.join(' · '), 'data-clip': 'ok' }, sub.join(' · ')) : null,
      ),
      // For the pointer only: a screen reader hears the option, and its keys from the field's description.
      h(
        'span',
        { class: 'picks', 'aria-hidden': 'true' },
        pick('now', 'play', words.playNow),
        pick('next', 'arrow-up-to-line', words.playNext),
        pick('end', 'list-plus', words.add),
      ),
    );
    // A press on a pick plays or queues it; anywhere else on the row adds it, as Enter does. The field keeps the
    // keyboard (a pointer press on the list must not take it away and close the list).
    element.onpointerdown = (event) => event.preventDefault();
    element.onclick = (event) => {
      const where = (event.target as Element).closest<HTMLElement>('[data-pick]')?.dataset.pick as Where | undefined;
      void submit(where ?? 'end', result.url);
    };
    return element;
  };

  // Draws the results for the words (and the state of the search) and opens the list.
  const show = (text: string, shown: SearchResult[]) => {
    const words = t();
    results = shown;
    resultsFor = text;
    fill(list, ...results.map(option));
    list.removeAttribute('aria-busy');
    searchState.hidden = results.length > 0;
    fill(searchState, results.length > 0 ? null : words.foundNone);
    said.textContent = results.length > 0 ? words.foundCount(results.length) : words.foundNone;
    setActive(-1);
    open();
  };

  // Asks jukecord what YouTube finds for the words; an older question still under way is dropped.
  const ask = async (text: string) => {
    asking?.abort();
    const mine = new AbortController();
    asking = mine;
    const words = t();
    // While it looks: the earlier results stay (marked busy), or a line says it is looking.
    if (results.length === 0) {
      fill(searchState, icon('loader-circle', 'spin'), words.searching);
      searchState.hidden = false;
      open();
    } else {
      list.setAttribute('aria-busy', 'true');
    }
    try {
      const answer = await api.search(guild(), text, 8, mine.signal);
      known.set(text.toLowerCase(), answer.results);
      // Only for the words still in the field: typing on asked again already.
      if (input.value.trim() === text) show(text, answer.results);
    } catch (error) {
      if (mine.signal.aborted) return;
      list.removeAttribute('aria-busy');
      // Too many searches at once (typing fast): the results shown stay, and the next pause asks again.
      if (error instanceof ApiError && error.status === 429) return;
      // Otherwise why, in the list's place (a refusal, every lookup slot taken, YouTube refusing jukecord).
      const message = error instanceof ApiError ? sayError(error.message, state.lang) : words.networkFailed;
      results = [];
      fill(list);
      fill(searchState, icon('circle-alert'), message);
      searchState.hidden = false;
      said.textContent = message;
      open();
    } finally {
      if (asking === mine) asking = null;
    }
  };

  input.oninput = () => {
    const text = input.value.trim();
    window.clearTimeout(typing);
    if (!searchable(text)) {
      asking?.abort();
      results = [];
      resultsFor = '';
      close();
      return;
    }
    // Known on this page already: at once. Otherwise a moment after the last key.
    const seen = known.get(text.toLowerCase());
    if (seen) {
      asking?.abort();
      show(text, seen);
      return;
    }
    typing = window.setTimeout(() => void ask(text), 350);
  };

  input.onkeydown = (event) => {
    const options = results.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Closed with results for these words (after Escape): the arrows open it again.
      if (found.hidden && options > 0 && resultsFor === input.value.trim()) open();
      if (found.hidden || options === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // From none, Down goes to the first and Up to the last; past either end, round to the other.
      setActive(active < 0 ? (step > 0 ? 0 : options - 1) : (active + step + options) % options);
    } else if (event.key === 'Escape' && !found.hidden) {
      // The list closes; the words stay.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter') {
      // Enter adds, Shift+Enter plays next, Ctrl+Enter (Cmd+Enter on a Mac) plays now: the result the arrows are on,
      // or what is typed.
      event.preventDefault();
      const where: Where = event.ctrlKey || event.metaKey ? 'now' : event.shiftKey ? 'next' : 'end';
      const chosen = !found.hidden ? results[active] : undefined;
      void submit(where, chosen?.url);
    }
  };
  // Back in the field with results for its words: they show again.
  input.onfocus = () => {
    if (results.length > 0 && resultsFor === input.value.trim() && searchable(resultsFor)) open();
  };
  // Out of the card (Tab past the keys, a click elsewhere): the list closes. Within it (the keys) it stays.
  card.addEventListener('focusout', (event) => {
    const to = event.relatedTarget as Node | null;
    if (!to || !card.contains(to)) close();
  });

  // ---- adding --------------------------------------------------------------------------------------------------
  // What waits for its turn: links pasted or dropped while an add runs (one at a time from this card, in order).
  const waiting: { where: Where; text: string; fromField: boolean }[] = [];
  // Every key looks the input up; while that runs (a playlist can take seconds) the key says so. `text` is what to
  // add: a picked result's address, a dropped link, or (left out) what is typed.
  const submit = async (where: Where, text?: string, fromField = true): Promise<void> => {
    const what = (text ?? input.value).trim();
    if (!what) {
      input.focus();
      return;
    }
    if (busy) {
      // A link dropped meanwhile waits its turn; a second press of a key is the first one's.
      if (!fromField && waiting.length < 10) waiting.push({ where, text: what, fromField });
      return;
    }
    const button = keyOf(where);
    busy = button;
    fill(button, icon('loader-circle', 'spin'), t().adding);
    draw();
    const result = await act(button, () =>
      where === 'now' ? api['play-now'](guild(), what) : api.add(guild(), what, where),
    );
    // The key gets its own words back.
    busy = null;
    draw();
    if (result) {
      // From the field (typed, or a result picked): the field is cleared and the list goes.
      if (fromField) {
        input.value = '';
        results = [];
        resultsFor = '';
        close();
      }
      added(result);
    }
    const after = waiting.shift();
    if (after) void submit(after.where, after.text, after.fromField);
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const chosen = !found.hidden ? results[active] : undefined;
    void submit('end', chosen?.url);
  };
  // Play next and Play now act on the result the arrows are on, when the list is open; else on what is typed.
  for (const [key, where] of [
    [next, 'next'],
    [now, 'now'],
  ] as const) {
    key.onclick = () => {
      const chosen = !found.hidden ? results[active] : undefined;
      void submit(where, chosen?.url);
    };
  }

  // ---- links pasted or dropped anywhere on the player's page -----------------------------------------------
  // Only on the player's page, with nothing open over it, for someone who may add: the same add, busy state and
  // refusals as the field's.
  const welcome = () =>
    mayControl() && !card.closest('[hidden]') && !document.querySelector('.dialog, .sheet') && Boolean(state.guild);
  document.addEventListener('paste', (event) => {
    const target = event.target as HTMLElement | null;
    // Pasting into a field is typing.
    if (target?.closest('input, textarea, [contenteditable]') || !welcome()) return;
    const text = event.clipboardData?.getData('text')?.trim() ?? '';
    if (!looksLikeAddress(text)) return;
    event.preventDefault();
    void submit('end', text, false);
  });
  // A drag that started on this page (a queue row, a title link) is the page's own, not a link brought in.
  let ownDrag = false;
  document.addEventListener('dragstart', () => {
    ownDrag = true;
  });
  document.addEventListener('dragend', () => {
    ownDrag = false;
  });
  // Something brought in from outside: the add card says where it goes while it is held over the page.
  let over = 0;
  const holding = (on: boolean) => {
    card.classList.toggle('drop-target', on);
    dropNote.hidden = !on;
    (dropNote.lastElementChild as HTMLElement).textContent = t().dropHere;
  };
  const bringsLink = (event: DragEvent) =>
    !ownDrag &&
    [...(event.dataTransfer?.types ?? [])].some((type) => type === 'text/uri-list' || type === 'text/plain');
  document.addEventListener('dragenter', (event) => {
    if (!bringsLink(event) || !welcome()) return;
    over += 1;
    holding(true);
  });
  document.addEventListener('dragleave', (event) => {
    if (!bringsLink(event)) return;
    over = Math.max(0, over - 1);
    if (over === 0) holding(false);
  });
  document.addEventListener('dragover', (event) => {
    if (!bringsLink(event) || !welcome()) return;
    // Taken here, so the browser does not open the link in place of the panel (and stop the music here).
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (event) => {
    if (!bringsLink(event) || !welcome()) return;
    event.preventDefault();
    over = 0;
    holding(false);
    // The first address of a link list, else the text as it is.
    const list = event.dataTransfer?.getData('text/uri-list') ?? '';
    const text =
      list
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#')) ??
      event.dataTransfer?.getData('text/plain')?.trim() ??
      '';
    if (looksLikeAddress(text)) void submit('end', text, false);
  });

  watch(['lang', 'guild', 'me', 'player', 'queue'], draw);
  // Another server: its results are its own to look up.
  watch(['guild'], () => {
    asking?.abort();
    known.clear();
    results = [];
    resultsFor = '';
    close();
  });
  watch(['lang'], () => {
    // The words of the list's state and its count follow the language; the results stay.
    if (!found.hidden && results.length > 0) show(resultsFor, results);
  });
  draw();
  return card;
}

/** The voice channel: where the bot is, the channels it could join, and who listens in browsers. */
export function voiceCard(): HTMLElement {
  const pill = h('span', { class: 'pill tone-idle' });
  const where = h('div', { class: 'where' });
  const leave = h('button', { class: 'key sm', type: 'button' });
  const top = h('div', { class: 'voice-now' }, icon('radio', 'lg'), where, leave);
  const channels = h('ul', { class: 'channels scroll' });
  const listening = h('div', { class: 'listeners' });
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'voice-h' },
    h('div', { class: 'card-head' }, h('h2', { id: 'voice-h' }), pill),
    top,
    channels,
    listening,
  );

  const draw = () => {
    const words = t();
    (card.querySelector('#voice-h') as HTMLElement).textContent = words.voice;
    const voice = state.voice;
    const browserOnly = state.status?.mode === 'browser-only';
    const current = voice?.current ?? null;
    pill.className = `pill ${current ? 'tone-play' : 'tone-idle'}`;
    top.classList.toggle('joined', Boolean(current) && !browserOnly);
    // Browser-only is said once, in the top bar; here the card explains it.
    pill.hidden = browserOnly;
    fill(pill, h('span', { class: 'dot' }), current ? words.inVoice : words.notInVoice);
    if (browserOnly) {
      fill(where, h('span', { class: 'muted' }, words.noBot));
      leave.hidden = true;
      channels.hidden = true;
    } else {
      const people = voice?.channels.find((channel) => channel.id === current?.channelId)?.people;
      fill(
        where,
        // An empty name: the bot is in a channel this person cannot see in Discord.
        current ? h('b', null, current.name || words.hiddenChannel) : h('span', { class: 'muted' }, words.notInVoice),
        current && people !== undefined ? h('span', { class: 'faint' }, ` · ${words.people(people)}`) : null,
      );
      refill(leave, words.leave, icon('log-out'), words.leave);
      leave.hidden = !current;
      leave.disabled = !mayControl();
      channels.hidden = false;
      const list = voice?.channels ?? [];
      const control = mayControl();
      // Rebuilt only when a channel, its people, the bot's place or the rights change: a listener coming or going
      // must not take the Join key from under the pointer.
      const sign = JSON.stringify([list, current?.channelId ?? null, control, state.lang]);
      if (list.length === 0) {
        refill(channels, sign, h('li', { class: 'empty' }, words.noChannels));
      } else {
        refill(
          channels,
          sign,
          ...list.map((channel) => {
            const here = channel.id === current?.channelId;
            const join = h('button', { class: 'key sm', type: 'button' }, words.join);
            join.disabled = !control;
            join.onclick = () =>
              void act(join, async () => {
                const id = guild();
                const voice = await api.join(id, channel.id);
                // The answer for a server no longer shown is dropped.
                if (state.guild?.id === id) update({ voice });
              });
            return h(
              'li',
              { class: `channel ${here ? 'current' : ''}`.trim() },
              icon('volume-2'),
              h('span', { class: 'name' }, channel.name),
              h('span', { class: 'faint num' }, words.people(channel.people)),
              here ? h('span', { class: 'badge tone-play' }, words.botHere) : join,
            );
          }),
        );
      }
    }
    // Who listens in browsers.
    const people = state.listeners.people;
    fill(
      listening,
      icon('headphones'),
      h('span', { class: 'grow' }, words.listeningHere),
      people.length > 0
        ? h(
            'span',
            { class: 'faces' },
            ...people.slice(0, 6).map((person) => face(person.name, avatarUrl(person.id, person.avatar), 'sm')),
          )
        : h('span', { class: 'faint' }, words.nobody),
      // Faces say who; a number only for the browsers beyond the six faces shown.
      state.listeners.count > Math.min(6, people.length)
        ? h('span', { class: 'faint num' }, `+${state.listeners.count - Math.min(6, people.length)}`)
        : null,
    );
  };
  leave.onclick = () =>
    void act(leave, async () => {
      const id = guild();
      const voice = await api.leave(id);
      if (state.guild?.id === id) update({ voice });
    });
  watch(['voice', 'listeners', 'lang', 'status', 'guild', 'me'], draw);
  draw();
  return card;
}

// Which list the history card shows: what played lately, or what this login liked (kept in this browser).
function libraryView(): 'history' | 'liked' {
  try {
    return localStorage.getItem('jukecord.library') === 'liked' ? 'liked' : 'history';
  } catch {
    return 'history';
  }
}

/**
 * A row of the history or of the liked tracks: its album, title and a line under it, its heart, and keys to play it now,
 * next or at the end. A narrow card keeps the heart and puts the rest behind one key (see libraryMenu).
 */
function libraryRow(track: Track, id: string, sub: (HTMLElement | null)[]): HTMLElement {
  const words = t();
  const control = mayControl();
  const key = (name: IconName, label: string, data: string, run: () => Promise<unknown>) => {
    const button = h(
      'button',
      { class: 'key sm square quiet', type: 'button', title: label, 'aria-label': label, dataset: { key: data } },
      icon(name),
    );
    button.disabled = !control;
    button.onclick = () => void act(button, run);
    return button;
  };
  const now = key('play', words.playNow, 'now', async () => added(await api['play-now'](guild(), track.url)));
  const next = key('arrow-up-to-line', words.playNext, 'next', async () =>
    added(await api.add(guild(), track.url, 'next')),
  );
  const again = key('list-plus', words.addAgain, 'again', async () => added(await api.add(guild(), track.url)));
  const more = h(
    'button',
    {
      class: 'key sm square quiet lib-more',
      type: 'button',
      title: words.trackMenu,
      'aria-label': words.trackMenu,
      dataset: { key: 'more' },
    },
    icon('ellipsis'),
  );
  more.disabled = !control;
  more.onclick = () => libraryMenu(track);
  return h(
    'li',
    { class: 'row', dataset: { id } },
    album(track),
    h(
      'div',
      { class: 'text' },
      h(
        'div',
        { class: 'name' },
        h('a', { href: track.url, target: '_blank', rel: 'noopener noreferrer' }, track.title),
      ),
      h('div', { class: 'sub' }, ...sub),
    ),
    h('div', { class: 'acts' }, heartKey(track), now, next, again, more),
  );
}

// A history or liked row's keys as a list, on a narrow card: play now, play next, add.
function libraryMenu(track: Track): void {
  const words = t();
  const box = h('div', { class: 'menu-list' });
  const dialog = showDialog(track.title, box);
  const choice = (name: IconName, text: string, run: () => Promise<unknown>) => {
    const button = h('button', { class: 'choice', type: 'button' }, icon(name), h('span', { class: 'grow' }, text));
    button.onclick = () => {
      dialog.close();
      void act(null, run);
    };
    return button;
  };
  fill(
    box,
    choice('play', words.playNow, async () => added(await api['play-now'](guild(), track.url))),
    choice('arrow-up-to-line', words.playNext, async () => added(await api.add(guild(), track.url, 'next'))),
    choice('list-plus', words.addAgain, async () => added(await api.add(guild(), track.url))),
  );
}

/** What played recently and what this login liked, one list at a time, with keys to play each again. */
export function historyCard(): HTMLElement {
  const count = h('span', { class: 'count' });
  const list = h('ol', { class: 'list scroll history' });
  // The two lists, as a row of two choices; the card's heading names both, for screen readers.
  let view = libraryView();
  const choices = h('div', { class: 'seg library-seg', role: 'group' });
  const heading = h('h2', { id: 'history-h', class: 'sr' });
  // With the liked tracks shown: all of them into the queue.
  const addAll = h('button', { class: 'key sm', type: 'button', 'data-act': 'likes-add' });
  const card = h(
    'section',
    { class: 'card fill', 'aria-labelledby': 'history-h' },
    h('div', { class: 'card-head' }, heading, choices, count, h('div', { class: 'tools' }, addAll)),
    list,
  );
  const drawChoices = () => {
    const words = t();
    choices.setAttribute('aria-label', words.listChoice);
    const likedCount = state.liked?.length ?? 0;
    fill(
      choices,
      ...(
        [
          ['history', words.history, null],
          ['liked', words.liked, likedCount > 0 ? likedCount : null],
        ] as const
      ).map(([value, label, number]) => {
        const button = h(
          'button',
          { type: 'button', 'aria-pressed': String(view === value), dataset: { view: value } },
          label,
          number === null ? null : h('span', { class: 'seg-count' }, String(number)),
        );
        button.onclick = () => {
          if (view === value) return;
          view = value;
          keep('library', value);
          draw();
          // The likes asked again when their list is opened: another tab or Discord may have changed them.
          if (value === 'liked') void refreshLikes();
        };
        return button;
      }),
    );
  };
  const draw = () => {
    const words = t();
    heading.textContent = words.library;
    // No count: it would only ever say how many entries were asked for.
    count.textContent = '';
    drawChoices();
    fill(addAll, icon('list-plus'), words.addAll);
    addAll.hidden = view !== 'liked';
    addAll.disabled = !mayControl() || (state.liked?.length ?? 0) === 0;
    keepingFocus(list, () => {
      if (view === 'liked') {
        const liked = state.liked ?? [];
        if (liked.length === 0) fill(list, h('li', { class: 'empty' }, icon('heart'), words.noLiked));
        else
          fill(
            list,
            ...liked.map((entry) =>
              libraryRow(entry.track, `liked-${entry.track.id}`, [
                entry.track.uploader ? h('span', null, entry.track.uploader) : null,
                entry.track.durationMs !== null ? h('span', { class: 'num' }, clock(entry.track.durationMs)) : null,
              ]),
            ),
          );
        return;
      }
      if (state.history.length === 0) fill(list, h('li', { class: 'empty' }, icon('history'), words.noHistory));
      else
        fill(
          list,
          ...state.history.map((entry: HistoryEntry) =>
            libraryRow(entry.track, `${entry.playedAt}-${entry.track.id}`, [
              h('span', { dataset: { at: String(entry.playedAt) } }, ago(entry.playedAt)),
              entry.track.durationMs !== null ? h('span', { class: 'num' }, clock(entry.track.durationMs)) : null,
              h('span', null, addedBy(entry.addedBy, entry.addedByName)),
            ]),
          ),
        );
    });
  };
  addAll.onclick = () =>
    void act(addAll, async () => {
      added(await api['likes-add'](guild()));
    });
  watch(['history', 'lang', 'me', 'guild', 'liked'], draw);
  draw();
  // "3 min ago" keeps up once a minute by changing those words only: rebuilt rows would drop the keyboard focus.
  window.setInterval(() => {
    for (const span of list.querySelectorAll<HTMLElement>('[data-at]')) span.textContent = ago(Number(span.dataset.at));
  }, 60_000);
  return card;
}
