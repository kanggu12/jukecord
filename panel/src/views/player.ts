/**
 * The player screen's cards: what plays now (the disc, the progress bar, the keys), the queue, adding tracks, the
 * voice channel with who listens in browsers, and what played recently.
 *
 * Each card builds its elements once and redraws only the parts that change, when the state it watches changes.
 * The progress bar moves on a 4-per-second timer only while something plays; nothing moves while idle or paused.
 */
import { api, type HistoryEntry, type Player, type QueueItem, type Track } from '../api.ts';
import { avatarUrl, clock, face, fill, h, icon, keepingFocus, refill } from '../dom.ts';
import type { IconName } from '../icons.ts';
import type { Live } from '../live.ts';
import { mayControl, positionNow, state, t, update, watch } from '../state.ts';
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

// "added by Alice" / "added by the host".
function addedBy(id: string | null, name: string | null): string {
  return id ? t().addedBy(name ?? id) : t().byHost;
}

// "3 min ago", "yesterday".
function ago(at: number): string {
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
  const art = h('div');
  const title = h('h3', { class: 'title' });
  const meta = h('div', { class: 'meta' });
  const error = h('div', { class: 'error', role: 'status' });
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
  const info = h('div', { class: 'info' }, title, meta, error, progress, keys);
  const body = h('div', { class: 'now' }, art, info);
  const card = h(
    'section',
    { class: 'card', 'aria-labelledby': 'now-h' },
    h('div', { class: 'card-head' }, h('h2', { id: 'now-h' }, ''), pill),
    body,
  );

  // Where a drag on the bar would seek to, shown in the tip while dragging.
  let dragging: number | null = null;
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
      refill(
        meta,
        `${track.uploader}|${by}`,
        track.uploader ? h('span', null, icon('music-2'), track.uploader) : null,
        h('span', null, icon('users'), by),
      );
    } else {
      refill(title, `idle|${words.idle}`, h('span', { class: 'muted' }, words.idle));
      refill(meta, `idle|${words.idleHint}`, h('span', null, words.idleHint));
    }
    error.hidden = !player?.error;
    refill(
      error,
      player?.error ?? '',
      player?.error ? icon('circle-alert') : null,
      player?.error ? words.couldNotPlay(player.error) : null,
    );
    progress.hidden = !track;
    // The keys: play, pause or resume, skip, stop, repeat, remove.
    const control = mayControl();
    const moving = status === 'playing' || status === 'loading';
    const queued = (state.queue?.items.length ?? 0) > 0;
    const pauseWords = moving ? words.pause : status === 'paused' ? words.resume : words.play;
    refill(pause, `${moving}|${pauseWords}`, icon(moving ? 'pause' : 'play'), pauseWords);
    // With nothing playing, the key starts the queue (when there is one).
    pause.disabled = !control || (!track && !queued);
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
    repeat.disabled = !control;
    bar.setAttribute('aria-disabled', String(!control || !track || status === 'loading'));
    bar.setAttribute('aria-label', words.nowPlaying);
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
  skip.onclick = () => void act(skip, () => api.skip(guild()));
  stop.onclick = () => void act(stop, () => api.stop(guild()));
  drop.onclick = () => void act(drop, () => api['remove-current'](guild()));
  repeat.onclick = () => {
    // Off, then the queue, then this track, then off again: the order music players use.
    const next = { off: 'queue', queue: 'track', track: 'off' } as const;
    void act(repeat, () => api.repeat(guild(), next[state.player?.repeat ?? 'off']));
  };

  watch(['player', 'lang', 'guild', 'me', 'queue'], draw);
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
  const list = h('ol', { class: 'list scroll', 'aria-live': 'off' });
  const card = h(
    'section',
    { class: 'card fill', 'aria-labelledby': 'queue-h' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', { id: 'queue-h' }, h('span', { class: 'name' }), count),
      searchField,
      h('div', { class: 'tools' }, shuffle, dedupe, save, load, clear),
    ),
    list,
  );

  // Dragging a row by its grip: which item, and where it would land.
  let dragged: QueueItem | null = null;

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
    remove.onclick = () => void act(remove, () => api.remove(guild(), item.id));
    more.onclick = () => trackMenu(item.id);
    const grip = h('span', { class: 'grip', title: words.dragToMove }, icon('grip-vertical'));
    const element = h(
      'li',
      { class: `row ${item.position === 0 ? 'next' : ''}`.trim(), dataset: { id: String(item.id) } },
      grip,
      h('span', { class: 'pos' }, item.position + 1),
      disc('sm', item.track, 'idle'),
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
      control ? h('div', { class: 'acts' }, jump, item.position > 0 ? next : null, remove, more) : h('div'),
    );
    if (control) {
      // Only the grip starts a drag, so text in the row can still be selected and links clicked.
      grip.onpointerdown = () => element.setAttribute('draggable', 'true');
      element.ondragstart = (event) => {
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
        void act(null, () => api.move(guild(), moving.id, index));
      };
      // Alt+arrow moves a row with the keyboard.
      element.onkeydown = (event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        const index = Math.max(0, item.position + (event.key === 'ArrowUp' ? -1 : 1));
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
    count.textContent = items.length > 0 ? `${items.length} · ${clock(total)}` : '';
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
    shuffle.disabled = !control || items.length < 2;
    dedupe.disabled = !control || items.length < 2;
    clear.disabled = !control || items.length === 0;
    save.disabled = !control || (items.length === 0 && !state.player?.track);
    load.disabled = !control;
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
    // After the redraw (a move with Alt+arrow, a track added by someone else) the same key of the same row gets the
    // keyboard focus back.
    keepingFocus(list, () => {
      if (items.length === 0) {
        fill(list, h('li', { class: 'empty' }, icon('list-music'), words.queueEmpty));
      } else if (shown.length === 0) {
        fill(list, h('li', { class: 'empty' }, icon('search'), words.noMatch));
      } else {
        const rows = document.createDocumentFragment();
        for (const item of shown) rows.append(row(item, control));
        list.replaceChildren(rows);
      }
    });
    list.scrollTop = scroll;
  };

  search.oninput = draw;
  shuffle.onclick = () => void act(shuffle, () => api.shuffle(guild()));
  dedupe.onclick = () =>
    void act(dedupe, async () => {
      const result = await api.dedupe(guild());
      toast(`${t().dedupe}: ${result.removed}`);
    });
  clear.onclick = async () => {
    const words = t();
    const ok = await confirmDialog({
      title: words.clearTitle,
      text: words.clearText(state.queue?.items.length ?? 0),
      ok: words.clear,
      danger: true,
    });
    if (ok) void act(clear, () => api.clear(guild()));
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
  watch(['queue', 'lang', 'guild', 'me'], draw);
  watch(['player'], () => {
    save.disabled = !mayControl() || ((state.queue?.items.length ?? 0) === 0 && !state.player?.track);
  });
  draw();
  return card;
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
  fill(
    box,
    choice('play', words.playNow, () => api.jump(guild(), id)),
    item.position > 0 ? choice('arrow-up-to-line', words.playNext, () => api.move(guild(), id, 0)) : null,
    item.position > 0
      ? choice('arrow-up', words.moveUp, (position) => api.move(guild(), id, Math.max(0, position - 1)))
      : null,
    item.position < length - 1
      ? choice('arrow-down', words.moveDown, (position) => api.move(guild(), id, position + 1))
      : null,
    choice('x', words.remove, () => api.remove(guild(), id), true),
  );
}

// The saved playlists: load, rename, delete.
async function playlistsDialog(): Promise<void> {
  const words = t();
  const box = h('ul', { class: 'list', style: 'padding: 0' });
  const dialog = showDialog(words.playlists, box);
  const draw = async () => {
    let playlists: Awaited<ReturnType<typeof api.playlists>>;
    try {
      playlists = await api.playlists(guild());
    } catch (error) {
      problem(error);
      return;
    }
    if (playlists.length === 0) {
      fill(box, h('li', { class: 'empty' }, icon('list-music'), words.noPlaylists));
      return;
    }
    fill(
      box,
      ...playlists.map((playlist) => {
        const loadKey = h('button', { class: 'key sm', type: 'button' }, icon('list-plus'), words.load);
        const renameKey = h(
          'button',
          { class: 'key sm square quiet', type: 'button', title: words.rename, 'aria-label': words.rename },
          icon('pencil'),
        );
        const deleteKey = h(
          'button',
          { class: 'key sm square quiet bad', type: 'button', title: words.delete, 'aria-label': words.delete },
          icon('trash-2'),
        );
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
            await act(renameKey, () => api['playlist-rename'](guild(), playlist.name, next));
            void draw();
          }
        };
        deleteKey.onclick = async () => {
          const ok = await confirmDialog({
            title: words.deleteTitle(playlist.name),
            text: words.deleteText,
            ok: words.delete,
            danger: true,
          });
          if (ok) {
            await act(deleteKey, () => api['playlist-delete'](guild(), playlist.name));
            void draw();
          }
        };
        return h(
          'li',
          { class: 'channel' },
          h(
            'span',
            { class: 'name' },
            h('b', null, playlist.name),
            h('span', { class: 'faint' }, ` · ${words.tracks(playlist.size)}`),
          ),
          renameKey,
          deleteKey,
          loadKey,
        );
      }),
    );
  };
  await draw();
}

// What an add did, as a toast: how many went in and what was left out.
function added(result: { items: unknown[]; skippedTooLong: number; skippedFull: number }): void {
  const words = t();
  const parts = [words.added(result.items.length)];
  if (result.skippedTooLong > 0) parts.push(words.leftLong(result.skippedTooLong));
  if (result.skippedFull > 0) parts.push(words.leftFull(result.skippedFull));
  toast(parts.join(' · '), result.skippedTooLong + result.skippedFull > 0 ? 'pause' : 'play');
}

/** Adding: an address or search words, to the end of the queue or to play now. */
export function addCard(): HTMLElement {
  const input = h('input', { type: 'text', autocomplete: 'off', enterkeyhint: 'go', id: 'add-input' });
  const field = h('label', { class: 'field' }, icon('link'), input);
  const add = h('button', { class: 'key', type: 'submit' });
  const now = h('button', { class: 'key primary', type: 'button' });
  const form = h('form', { class: 'add' }, field, add, now);
  const card = h('section', { class: 'card', 'aria-label': 'add' }, form);

  const draw = () => {
    const words = t();
    input.placeholder = words.addPlaceholder;
    input.setAttribute('aria-label', words.addPlaceholder);
    card.setAttribute('aria-label', words.add);
    fill(add, icon('list-plus'), words.add);
    fill(now, icon('play'), words.playNow);
    const control = mayControl();
    input.disabled = !control;
    add.disabled = !control;
    now.disabled = !control;
    field.title = control ? '' : words.lookOnlyHint;
  };
  // Both keys look the input up; while that runs (a playlist can take seconds) the keys say so.
  const submit = async (button: HTMLButtonElement, playNow: boolean) => {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    fill(button, icon('loader-circle', 'spin'), t().adding);
    const result = await act(button, () => (playNow ? api['play-now'](guild(), text) : api.add(guild(), text)));
    // The key gets its own words back.
    draw();
    if (result) {
      input.value = '';
      added(result);
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    void submit(add, false);
  };
  now.onclick = () => void submit(now, true);
  watch(['lang', 'guild', 'me'], draw);
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
    // Browser-only is said once, in the top bar; here the card explains it.
    pill.hidden = browserOnly;
    fill(pill, h('span', { class: 'dot' }), current ? words.connected : words.notInVoice);
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
              here ? h('span', { class: 'badge tone-play' }, words.connected) : join,
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
      state.listeners.count > 0 ? h('span', { class: 'faint num' }, String(state.listeners.count)) : null,
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

/** What played recently, with a key to add it again. */
export function historyCard(): HTMLElement {
  const count = h('span', { class: 'count' });
  const list = h('ol', { class: 'list scroll history' });
  const card = h(
    'section',
    { class: 'card fill', 'aria-labelledby': 'history-h' },
    h('div', { class: 'card-head' }, h('h2', { id: 'history-h' }, h('span', { class: 'name' }), count)),
    list,
  );
  const row = (entry: HistoryEntry) => {
    const words = t();
    const again = h(
      'button',
      {
        class: 'key sm square quiet',
        type: 'button',
        title: words.addAgain,
        'aria-label': words.addAgain,
        dataset: { key: 'again' },
      },
      icon('rotate-ccw'),
    );
    again.disabled = !mayControl();
    again.onclick = () =>
      void act(again, async () => {
        added(await api.add(guild(), entry.track.url));
      });
    return h(
      'li',
      { class: 'row', dataset: { id: `${entry.playedAt}-${entry.track.id}` } },
      disc('sm', entry.track, 'idle'),
      h(
        'div',
        { class: 'text' },
        h(
          'div',
          { class: 'name' },
          h('a', { href: entry.track.url, target: '_blank', rel: 'noopener noreferrer' }, entry.track.title),
        ),
        h(
          'div',
          { class: 'sub' },
          h('span', { dataset: { at: String(entry.playedAt) } }, ago(entry.playedAt)),
          entry.track.durationMs !== null ? h('span', { class: 'num' }, clock(entry.track.durationMs)) : null,
          h('span', null, addedBy(entry.addedBy, entry.addedByName)),
        ),
      ),
      h('div', { class: 'acts' }, again),
    );
  };
  const draw = () => {
    const words = t();
    (card.querySelector('#history-h .name') as HTMLElement).textContent = words.history;
    count.textContent = state.history.length > 0 ? String(state.history.length) : '';
    keepingFocus(list, () => {
      if (state.history.length === 0) fill(list, h('li', { class: 'empty' }, icon('history'), words.noHistory));
      else fill(list, ...state.history.map(row));
    });
  };
  watch(['history', 'lang', 'me', 'guild'], draw);
  draw();
  // "3 min ago" keeps up once a minute by changing those words only: rebuilt rows would drop the keyboard focus.
  window.setInterval(() => {
    for (const span of list.querySelectorAll<HTMLElement>('[data-at]')) span.textContent = ago(Number(span.dataset.at));
  }, 60_000);
  return card;
}
