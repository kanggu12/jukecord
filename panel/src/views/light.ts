/**
 * A light that moves with the music while this browser listens: the cover's glow behind the disc and the light behind
 * the glass follow the music's low end (its bass and kick drum), read from the panel's own audio through a WebAudio
 * analyser.
 *
 * Only opacity and transform change, which the browser composites without laying anything out or drawing it again,
 * at most once per animation frame and only when the change would show. Nothing runs, and the audio graph sleeps,
 * while the tab is hidden, the music is paused or not heard in this browser, or motion is off (the menu's switch, or
 * the system's wish for less motion); the light is then exactly as it is without this.
 *
 * The analyser reads a copy of the element's stream (captureStream): the sound itself never goes through WebAudio, so
 * it plays as it always has, in the background and on a locked phone. A browser without captureStream (Safari; and
 * Firefox, whose mozCaptureStream silences the element it copies) keeps the glow's slow breathing instead.
 */
import { state, watch } from '../state.ts';

// The bins of the analyser that hold the low end: at 48 kHz and 1024 points each bin is 47 Hz wide, so bins 1 to 4
// are about 47 to 234 Hz (bass and kick drum; bin 0 is mostly the recording's own rumble).
const LOW_FIRST = 1;
const LOW_LAST = 4;
// The fewest milliseconds between two changes of the light, and the least change worth making: about 35 changes a
// second at most, whatever the screen's own rate, and none while the music holds still.
const STEP_MS = 28;
const LEAST = 0.015;

// What moves: the glow behind the disc (made by the playing card), the field's extra light, and the field itself.
let glow: HTMLElement | null = null;
let field: HTMLElement | null = null;
let fieldLight: HTMLElement | null = null;

/** The playing card's glow layer, which follows the low end (see style.css's .art .beat). */
export function lightGlow(element: HTMLElement): void {
  glow = element;
}

/** The field behind the glass and the extra layer of its light that brightens with the low end. */
export function lightField(container: HTMLElement, layer: HTMLElement): void {
  field = container;
  fieldLight = layer;
}

// The same rule as the rest of the panel's motion: the menu's switch, and the system's wish for less motion.
function moving(): boolean {
  return state.motion && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Starts following the music of this browser's audio element (once, from the listening bar). */
export function followMusic(audio: HTMLAudioElement): void {
  // captureStream reads the element without taking its sound away; without it there is nothing to follow.
  const capture = (audio as HTMLAudioElement & { captureStream?: () => MediaStream }).captureStream;
  if (typeof capture !== 'function' || typeof AudioContext === 'undefined') return;
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let bins: Uint8Array<ArrayBuffer> | null = null;
  let frame = 0;
  // The light's level now (0 to 1), the loudest low end lately (so quiet and loud recordings both move), and the last
  // level written to the page and when.
  let level = 0;
  let peak = 0.25;
  let written = -1;
  let writtenAt = 0;

  // The graph, made the first time it is needed (after the Listen key's press, which lets audio start): the copy of
  // the stream into an analyser, and on into silence, so the browser keeps the analyser fed.
  const graph = () => {
    if (context) return;
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    bins = new Uint8Array(analyser.frequencyBinCount);
    const silent = context.createGain();
    silent.gain.value = 0;
    analyser.connect(silent).connect(context.destination);
  };

  // The element's stream as it is now: a new track (or a new place in it) is a new stream, read afresh.
  const connect = () => {
    if (!context || !analyser) return;
    source?.disconnect();
    source = null;
    const stream = capture.call(audio);
    if (stream.getAudioTracks().length === 0) return;
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
  };

  // Writes the light's look: the glow stronger and wider, the field a little brighter and closer.
  const show = (value: number) => {
    glow?.style.setProperty('opacity', (0.12 + 0.6 * value).toFixed(3));
    glow?.style.setProperty('transform', `scale(${(1.1 + 0.18 * value).toFixed(3)})`);
    fieldLight?.style.setProperty('opacity', (0.32 * value).toFixed(3));
    field?.style.setProperty('transform', `scale(${(1 + 0.035 * value).toFixed(4)})`);
  };

  // Back to the look without it: the inline values go, and the style sheet's are what show.
  const rest = () => {
    for (const element of [glow, fieldLight, field]) {
      element?.style.removeProperty('opacity');
      element?.style.removeProperty('transform');
    }
    written = -1;
    level = 0;
  };

  // One animation frame: the low end now, a level that rises at once and falls slowly, written when it shows.
  const tick = (now: number) => {
    frame = 0;
    if (!analyser || !bins) return;
    analyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let bin = LOW_FIRST; bin <= LOW_LAST; bin += 1) sum += bins[bin] ?? 0;
    const energy = sum / ((LOW_LAST - LOW_FIRST + 1) * 255);
    // The loudest lately falls slowly, so a quiet passage still moves after a loud one.
    peak = Math.max(energy, peak * 0.997, 0.25);
    const target = Math.min(1, energy / peak) ** 2;
    level += (target - level) * (target > level ? 0.55 : 0.1);
    if (Math.abs(level - written) >= LEAST && now - writtenAt >= STEP_MS) {
      show(level);
      written = level;
      writtenAt = now;
    }
    frame = requestAnimationFrame(tick);
  };

  // Whether the light follows the music now, and starts or stops it to match.
  const follow = () => {
    const on =
      state.listening &&
      state.player?.status === 'playing' &&
      !audio.paused &&
      document.visibilityState === 'visible' &&
      moving();
    if (on && !frame) {
      graph();
      if (!source) connect();
      void context?.resume();
      frame = requestAnimationFrame(tick);
    } else if (!on && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
      rest();
      // The audio graph sleeps too: nothing is computed while nothing moves.
      void context?.suspend();
    }
  };

  // A new file, or the element playing again after a pause or a seek: its stream is read afresh.
  audio.addEventListener('playing', () => {
    if (context) connect();
    follow();
  });
  audio.addEventListener('pause', follow);
  document.addEventListener('visibilitychange', follow);
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', follow);
  watch(['listening', 'player', 'motion'], follow);
}
