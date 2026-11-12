/**
 * The lyrics of the track playing: beside the player on a window with two columns (in the right column, in place of
 * the voice channel and the history while open), and as a sheet on a window with one column (a phone). The line being
 * sung is lit and kept in sight, the lines before and after it dimmer; a person who may change the music can choose a
 * line to play the track from there. Plain words when the lyrics have no timings, "none found" otherwise, and the
 * source credited under them.
 *
 * Nothing here runs while the lyrics are closed. Open, a timer four times a second finds the line being sung (a
 * search in the lines, no drawing) and changes two lines' look only when the line changes.
 */
import { sayError } from '../../../src/core/say.ts';
import { ApiError, api, type Lyrics } from '../api.ts';
import { ONE_COLUMN } from '../columns.ts';
import { clock, fill, h, icon } from '../dom.ts';
import type { Live } from '../live.ts';
import { mayControl, positionNow, state, t, watch } from '../state.ts';
import { problem, sheet } from '../ui/layers.ts';

// A line is lit this much before its time: the eye reaches it as the voice does.
const LEAD_MS = 150;
// After the person scrolls the lines themselves, they are not moved back to the line being sung for this long.
const HANDS_OFF_MS = 4000;
// The lyrics kept for the tracks seen lately, so opening the view again or a track coming back asks nothing.
const KEPT = 20;

// Whether the lyrics are open, and who wants to know when that changes (the Lyrics key).
let open = false;
const listeners = new Set<() => void>();
// Set by the view once it is made: what the Lyrics key does.
let toggle: () => void = () => {};

/** Opens the lyrics, or closes them when open (the Lyrics key in the playing card). */
export function toggleLyrics(): void {
  toggle();
}

/** Whether the lyrics are open. */
export function lyricsOpen(): boolean {
  return open;
}

/** Calls `fn` whenever the lyrics open or close. */
export function whenLyricsChange(fn: () => void): void {
  listeners.add(fn);
}

// The same rule as the player's: the menu's motion switch, and the system's wish for less motion.
function moving(): boolean {
  return state.motion && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// What the view shows: the lyrics of a track, or why there are none to show.
type View =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'lyrics'; readonly lyrics: Lyrics };

/** The lyrics view, as a card for the right column (it moves into a sheet on one-column windows by itself). */
export function lyricsView(live: Live): HTMLElement {
  const heading = h('h2', { id: 'lyrics-h' });
  // The track's title, cut short on a narrow card (whole in its title).
  const what = h('span', { class: 'count lyrics-what', 'data-clip': 'ok' });
  const shut = h('button', { class: 'key sm square quiet lyrics-close', type: 'button', 'data-act': 'lyrics-close' });
  const head = h('div', { class: 'card-head' }, heading, what, h('div', { class: 'tools' }, shut));
  // The lines scroll here; the keyboard reaches the box itself when there are no keys in it (plain words, say).
  const body = h('div', { class: 'lyrics-body scroll', tabindex: '0' });
  const credit = h('p', { class: 'lyrics-credit' });
  const content = h('div', { class: 'lyrics', id: 'lyrics-view' }, head, body, credit);
  const card = h('section', { class: 'card fill lyrics-card', 'aria-labelledby': 'lyrics-h', hidden: true });

  let view: View = { kind: 'nothing' };
  // The track the view shows the lyrics of (or asks them for).
  let shownTrack: number | null = null;
  // The lyrics seen lately, by track, the newest last.
  const kept = new Map<number, Lyrics>();
  // Numbers each request: only the answer to the latest one is shown.
  let asked = 0;
  // The lines as drawn (their elements and times), the one lit, and when the person last scrolled them.
  let lines: { element: HTMLElement; atMs: number }[] = [];
  let lit = -1;
  let handsOffUntil = 0;
  let timer = 0;
  // The sheet the lyrics are in on a one-column window, and whether it is being closed to move them to the card.
  let closeSheet: (() => void) | null = null;
  let rehoming = false;
  // The windows with one column: the lyrics are a sheet there, as there is no column beside the player to show them in.
  const oneColumn = window.matchMedia(ONE_COLUMN);

  // The lyrics of the track playing: kept ones at once, else asked for (the answer may be for a track that has
  // ended meanwhile: kept, and the one playing now asked for).
  const load = async () => {
    const track = state.player?.track ?? null;
    const guild = state.guild?.id;
    // The track this view is for now: a snapshot of the same track does not ask again.
    shownTrack = track?.id ?? null;
    if (!track || !guild) {
      view = { kind: 'nothing' };
      draw();
      return;
    }
    const known = kept.get(track.id);
    if (known) {
      view = { kind: 'lyrics', lyrics: known };
      draw();
      return;
    }
    asked += 1;
    const mine = asked;
    view = { kind: 'loading' };
    draw();
    try {
      const lyrics = await api.lyrics(guild);
      kept.delete(lyrics.trackId);
      kept.set(lyrics.trackId, lyrics);
      while (kept.size > KEPT) kept.delete(kept.keys().next().value ?? lyrics.trackId);
      if (mine !== asked || !open) return;
      // For another track than the one playing now (it changed while LRCLIB answered): the one now is asked for.
      if (lyrics.trackId !== state.player?.track?.id) {
        void load();
        return;
      }
      view = { kind: 'lyrics', lyrics };
    } catch (error) {
      if (mine !== asked || !open) return;
      // Nothing playing any more, or LRCLIB not answering: said in the view, in the person's language.
      view = {
        kind: 'failed',
        message: error instanceof ApiError || error instanceof Error ? error.message : String(error),
      };
    }
    draw();
  };

  // A line of the lyrics: a key that plays from its time for someone who may change the music, words otherwise. A
  // pause between lines is a note, for the eye only.
  const line = (entry: { atMs: number; text: string }, control: boolean): HTMLElement => {
    const words = t();
    if (!entry.text) return h('li', { class: 'lyric pause', 'aria-hidden': 'true' }, '♪');
    // Its time first, for screen readers: the line's place in the song.
    const time = h('span', { class: 'sr' }, `${clock(entry.atMs)} `);
    if (!control) return h('li', { class: 'lyric' }, time, entry.text);
    const key = h(
      'button',
      { class: 'lyric', type: 'button', title: words.lyricsGoTo(clock(entry.atMs)) },
      time,
      entry.text,
    );
    key.onclick = () => {
      const guild = state.guild?.id;
      if (!guild) return;
      // The person chose this line: it is where the eye should stay.
      handsOffUntil = 0;
      api.seek(guild, entry.atMs).catch((error: unknown) => problem(error));
    };
    return h('li', null, key);
  };

  const draw = () => {
    const words = t();
    heading.textContent = words.lyrics;
    shut.title = words.lyricsClose;
    shut.setAttribute('aria-label', words.lyricsClose);
    fill(shut, icon('x'));
    // In a sheet, the sheet's own key closes it; in the card, this one.
    shut.hidden = closeSheet !== null;
    const track = state.player?.track ?? null;
    what.textContent = track?.title ?? '';
    what.title = track?.title ?? '';
    body.setAttribute('aria-label', words.lyrics);
    lines = [];
    lit = -1;
    const empty = (name: Parameters<typeof icon>[0], text: string, ...more: Node[]) =>
      fill(body, h('div', { class: 'empty' }, icon(name, name === 'loader-circle' ? 'spin' : ''), text, ...more));
    let source: Lyrics['source'] = null;
    if (view.kind === 'nothing') empty('music-2', words.idle);
    else if (view.kind === 'loading') empty('loader-circle', words.lyricsLooking);
    else if (view.kind === 'failed') {
      const retry = h('button', { class: 'key sm', type: 'button' }, icon('refresh-cw'), words.lyricsRetry);
      retry.onclick = () => void load();
      empty('circle-alert', sayError(view.message, state.lang), retry);
    } else {
      const lyrics = view.lyrics;
      source = lyrics.source;
      if (lyrics.kind === 'none') empty('mic-vocal', words.lyricsNone);
      else if (lyrics.kind === 'instrumental') empty('music-2', words.lyricsInstrumental);
      else if (lyrics.kind === 'plain' || lyrics.lines.length === 0) {
        fill(
          body,
          h('p', { class: 'lyrics-note' }, words.lyricsUntimed),
          h('p', { class: 'lyrics-plain' }, lyrics.text ?? ''),
        );
      } else {
        const control = mayControl();
        const list = h('ol', { class: 'lyrics-lines' });
        lines = lyrics.lines.map((entry) => {
          const item = line(entry, control);
          list.append(item);
          // The line itself is what is lit: the key inside the list item for someone who may choose it.
          return { element: item.querySelector<HTMLElement>('.lyric') ?? item, atMs: entry.atMs };
        });
        fill(body, list);
      }
    }
    // The source, credited under the words it gave (nothing to credit for "none found").
    fill(
      credit,
      source ? `${words.lyricsFrom} ` : null,
      source ? h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.name) : null,
    );
    credit.hidden = !source;
    body.scrollTop = 0;
    tick(true);
    pace();
  };

  // Finds the line being sung and lights it, keeping it in sight; `jump` puts it in place at once (a new track, the
  // view just opened) instead of gliding there.
  const tick = (jump = false) => {
    const player = state.player;
    if (lines.length === 0 || !player?.track || view.kind !== 'lyrics' || view.lyrics.trackId !== player.track.id) {
      return;
    }
    const at = positionNow(player, live.now()) + LEAD_MS;
    // The last line that has started: a search by halves, the lines being in time order.
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((lines[middle]?.atMs ?? 0) <= at) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (found === lit && !jump) return;
    lines[lit]?.element.classList.remove('lit');
    lines[lit]?.element.removeAttribute('aria-current');
    lit = found;
    const now = lines[lit]?.element;
    if (!now) return;
    now.classList.add('lit');
    now.setAttribute('aria-current', 'true');
    // Kept in sight a third of the way down, unless the person is reading elsewhere in the lines.
    if (Date.now() < handsOffUntil) return;
    const top = now.offsetTop - body.clientHeight * 0.35 + now.offsetHeight / 2;
    body.scrollTo({ top: Math.max(0, top), behavior: jump || !moving() ? 'auto' : 'smooth' });
  };

  // The timer runs only while the lyrics are open, timed and playing.
  const pace = () => {
    const running = open && lines.length > 0 && state.player?.status === 'playing';
    if (running && !timer) timer = window.setInterval(() => tick(), 250);
    if (!running && timer) {
      window.clearInterval(timer);
      timer = 0;
    }
  };

  // The person scrolling the lines (a wheel, a finger, the keyboard): the view lets them read for a while.
  const reading = () => {
    handsOffUntil = Date.now() + HANDS_OFF_MS;
  };
  body.addEventListener('wheel', reading, { passive: true });
  body.addEventListener('touchstart', reading, { passive: true });
  body.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) reading();
  });

  // Where the lyrics are shown: the card in the right column, or a sheet on a one-column window.
  const place = () => {
    const column = card.parentElement;
    if (!open) {
      card.hidden = true;
      column?.classList.remove('lyrics-open');
      if (closeSheet) {
        const close = closeSheet;
        closeSheet = null;
        rehoming = true;
        close();
        rehoming = false;
      }
      return;
    }
    if (oneColumn.matches) {
      card.hidden = true;
      column?.classList.remove('lyrics-open');
      if (!closeSheet) {
        const made = sheet({
          label: t().lyrics,
          // Closed by the person (its key, Escape, Back, the scrim): the lyrics are closed.
          onClose: () => {
            closeSheet = null;
            if (!rehoming) setOpen(false);
          },
        });
        made.body.classList.add('lyrics-sheet');
        made.body.append(content);
        closeSheet = made.close;
      }
    } else {
      if (closeSheet) {
        const close = closeSheet;
        closeSheet = null;
        rehoming = true;
        close();
        rehoming = false;
      }
      card.append(content);
      card.hidden = false;
      column?.classList.add('lyrics-open');
    }
    draw();
  };

  const setOpen = (on: boolean) => {
    if (open === on) return;
    open = on;
    for (const listener of listeners) listener();
    place();
    if (on) void load();
    pace();
  };
  toggle = () => setOpen(!open);
  shut.onclick = () => setOpen(false);
  // A window turned or resized past the rule: the lyrics move to where they belong now.
  oneColumn.addEventListener('change', () => {
    if (open) place();
  });

  // Another track: its lyrics. A seek, a pause or a resume: the lit line and the timer follow.
  watch(['player'], () => {
    if (!open) return;
    const track = state.player?.track?.id ?? null;
    if (track !== shownTrack) {
      shownTrack = track;
      void load();
      return;
    }
    tick(true);
    pace();
  });
  // The words in another language, and whether lines are keys (the rights may have changed).
  watch(['lang', 'me', 'guild'], () => {
    if (open) draw();
  });
  return card;
}
