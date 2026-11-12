/**
 * The sleep timer: this browser stops listening after 15, 30 or 60 minutes, or when the track playing now ends. It is
 * this browser's alone (the music goes on for everyone else), it is not kept across a reload, and it shows only while
 * this browser listens. The last seconds fade the sound out rather than cutting it.
 *
 * While no timer is set nothing runs; while one is, a timer once a second counts down the key's minutes and starts
 * the fade near the end.
 */
import { fill, h, icon } from '../dom.ts';
import { state, t, watch } from '../state.ts';
import { showDialog, toast } from '../ui/layers.ts';

// How long the sound takes to fade out before it stops.
const FADE_MS = 8000;

/** What the timer needs from the listening bar: to stop listening, and to turn the sound down while it fades. */
export interface SleepHooks {
  /** Stops listening in this browser, as the Listen key would. */
  stop(): void;
  /** How loud the sound is to be, as a share of the volume chosen (1 is as chosen). */
  fade(level: number): void;
}

/** The sleep timer's key for the listening bar. */
export function sleepKey(hooks: SleepHooks): HTMLButtonElement {
  const key = h('button', { class: 'key sleep', type: 'button', 'data-act': 'sleep', 'aria-haspopup': 'dialog' });
  // When the music is to stop here (a time on this browser's clock), or the track it stops after; neither: no timer.
  let until: number | null = null;
  let afterTrack: number | null = null;
  let ticking = 0;

  // The key: its icon, and what is set (the time left, or the end of the track); its words say both.
  const draw = () => {
    const words = t();
    const set = until !== null || afterTrack !== null;
    const left = until === null ? '' : clockLeft(until - Date.now());
    const label = afterTrack !== null ? words.sleepEnd : set ? left : words.sleep;
    const sign = `${set}|${label}`;
    if (key.dataset.sign !== sign) {
      key.dataset.sign = sign;
      fill(key, icon('timer'), h('span', { class: set && afterTrack === null ? 'label num' : 'label' }, label));
    }
    key.setAttribute('aria-pressed', String(set));
    const named = set ? `${words.sleep}: ${afterTrack !== null ? words.sleepEnd : words.sleepLeft(left)}` : words.sleep;
    key.title = named;
    key.setAttribute('aria-label', named);
    // Only while this browser listens: there is nothing to stop otherwise.
    key.hidden = !state.listening;
  };

  // No timer any more: the sound back as chosen, the counting stopped.
  const clear = () => {
    until = null;
    afterTrack = null;
    window.clearInterval(ticking);
    ticking = 0;
    hooks.fade(1);
    draw();
  };

  // The timer's end: the sound has faded, listening stops here, and the bar says why.
  const end = () => {
    clear();
    hooks.stop();
    toast(t().sleepStopped, 'load', 'timer');
  };

  // Once a second while a time is set: the minutes on the key, and the fade in the last seconds.
  const tick = () => {
    if (until === null) return;
    const left = until - Date.now();
    if (left <= 0) {
      end();
      return;
    }
    hooks.fade(left < FADE_MS ? left / FADE_MS : 1);
    draw();
  };

  const set = (minutes: number | 'track') => {
    clear();
    if (minutes === 'track') {
      afterTrack = state.player?.track?.id ?? null;
      // Nothing playing to wait for the end of: nothing is set.
      if (afterTrack === null) return;
    } else {
      until = Date.now() + minutes * 60_000;
      // Faster near the end, for a smooth fade; a second otherwise is plenty for minutes.
      ticking = window.setInterval(tick, 250);
    }
    draw();
  };

  key.onclick = () => {
    const words = t();
    const box = h('div', { class: 'menu-list' });
    const dialog = showDialog(words.sleep, box);
    const current = afterTrack !== null ? 'track' : until !== null ? 'time' : 'off';
    const choice = (value: number | 'track' | 'off', text: string, pressed: boolean) => {
      const button = h(
        'button',
        { class: 'choice', type: 'button', 'aria-pressed': String(pressed), dataset: { sleep: String(value) } },
        icon(value === 'off' ? 'x' : 'timer'),
        h('span', { class: 'grow' }, text),
        icon('check', 'check'),
      );
      // The end of the track needs one playing.
      if (value === 'track') button.disabled = !state.player?.track;
      button.onclick = () => {
        dialog.close();
        if (value === 'off') clear();
        else set(value);
      };
      return button;
    };
    fill(
      box,
      ...[15, 30, 60].map((minutes) => choice(minutes, words.sleepMinutes(minutes), false)),
      choice('track', words.sleepEndChoice, current === 'track'),
      current === 'off' ? null : choice('off', words.sleepOff, false),
    );
  };

  // The track it waited for has ended (another one, or none): the end. Listening stopped by the person: no timer.
  watch(['player'], () => {
    if (afterTrack !== null && state.player?.track?.id !== afterTrack) end();
  });
  watch(['listening'], () => {
    if (!state.listening && (until !== null || afterTrack !== null)) clear();
    draw();
  });
  watch(['lang'], draw);
  draw();
  return key;
}

// Minutes and seconds left, as the key shows them ("23:41"), never below zero.
function clockLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
