/**
 * A light that moves with the music while this browser listens: the cover's glow behind the disc and the light behind
 * the glass follow the music's low end (its bass and kick drum), read from the panel's own audio through a WebAudio
 * analyser.
 *
 * Only opacity changes, which the browser hands to the compositor as it is, without laying anything out, drawing it
 * again or sorting its layers anew; the glow seems to swell because a wider layer of it fades in on the loudest beats,
 * not because anything changes size (a change of scale made the browser sort its layers at every change). It changes
 * at most 20 times a second, on a timer: asking for every animation frame would make the browser work through every
 * frame even when nothing changed. Nothing runs, and the audio graph sleeps, while the tab is hidden, the music is
 * paused or not heard in this browser, or motion is off (the menu's switch, or the system's wish for less motion); the
 * light is then exactly as it is without this.
 *
 * The analyser reads a copy of the element's stream (captureStream): for the light, the sound itself never goes
 * through WebAudio, so it plays as it always has, in the background and on a locked phone. Once the voice channel's
 * sound has the element go through WebAudio (a preset, see sound.ts), the analyser reads the sound there instead, in
 * the same AudioContext, before this browser's volume as the copy is; the context then stays awake for the sound when
 * the light rests. A browser without captureStream (Safari; and Firefox, whose mozCaptureStream silences the element
 * it copies) keeps the glow's slow breathing instead, until such a sound gives it the element's sound to read.
 */
import { pageAudio, type SoundGraph } from '../sound.ts';
import { state, watch } from '../state.ts';

// The bins of the analyser that hold the low end: at 48 kHz and 1024 points each bin is 47 Hz wide, so bins 1 to 4
// are about 47 to 234 Hz (bass and kick drum; bin 0 is mostly the recording's own rumble).
const LOW_FIRST = 1;
const LOW_LAST = 4;
// How often the low end is read, in milliseconds (20 times a second, enough for a kick drum's rise and fall), and the
// least change of the light worth writing: none while the music holds still.
const STEP_MS = 50;
const LEAST = 0.015;

// What moves: the glow behind the disc and its wider layer (made by the playing card), and the field's extra light.
let glow: HTMLElement | null = null;
let glowWide: HTMLElement | null = null;
let fieldLight: HTMLElement | null = null;

/** The playing card's two glow layers, which follow the low end (see style.css's .art .beat). */
export function lightGlow(near: HTMLElement, wide: HTMLElement): void {
  glow = near;
  glowWide = wide;
}

/** The extra layer of the field's light behind the glass, which brightens with the low end. */
export function lightField(layer: HTMLElement): void {
  fieldLight = layer;
}

// The same rule as the rest of the panel's motion: the menu's switch, and the system's wish for less motion.
function moving(): boolean {
  return state.motion && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Starts following the music of this browser's audio element (once, from the listening bar), read from the voice
 * channel's sound graph of the same element once that has it.
 */
export function followMusic(audio: HTMLAudioElement, sound: SoundGraph): void {
  // captureStream reads the element without taking its sound away; without it, only the sound graph has something to
  // follow (once a preset hands the element over), and without WebAudio nothing does.
  const capture = (audio as HTMLAudioElement & { captureStream?: () => MediaStream }).captureStream;
  if (typeof AudioContext === 'undefined') return;
  const readable = () => sound.routed() || typeof capture === 'function';
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  // The copy of the element's stream being read, stopped when another takes its place (each copy is fed until then).
  let copy: MediaStream | null = null;
  let bins: Uint8Array<ArrayBuffer> | null = null;
  // The timer that reads the low end while the light follows it (0: not following).
  let timer = 0;
  // The light's level now (0 to 1), the loudest low end lately (so quiet and loud recordings both move), and the last
  // level written to the page.
  let level = 0;
  let peak = 0.25;
  let written = -1;

  // The graph, made the first time it is needed (after the Listen key's press, which lets audio start), in the page's
  // one context: the sound into an analyser, and on into silence, so the browser keeps the analyser fed.
  const graph = () => {
    if (context) return;
    context = pageAudio();
    if (!context) return;
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    bins = new Uint8Array(analyser.frequencyBinCount);
    const silent = context.createGain();
    silent.gain.value = 0;
    analyser.connect(silent).connect(context.destination);
  };

  // The element's sound as it is now: from the sound graph once the element is WebAudio's (while the light follows:
  // the context runs for the sound then, and an analyser fed at rest would work for nothing), else a copy of its
  // stream (a new track, or a new place in it, is a new stream, read afresh).
  const connect = () => {
    if (!context || !analyser) return;
    source?.disconnect();
    source = null;
    for (const track of copy?.getTracks() ?? []) track.stop();
    copy = null;
    if (sound.routed()) {
      if (timer) sound.tap(analyser);
      return;
    }
    if (typeof capture !== 'function') return;
    const stream = capture.call(audio);
    if (stream.getAudioTracks().length === 0) return;
    copy = stream;
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
  };

  // Writes the light's look: the glow stronger, its wide layer seen on the loudest beats (the square keeps it for
  // them), the field a little brighter.
  const show = (value: number) => {
    glow?.style.setProperty('opacity', (0.12 + 0.55 * value).toFixed(3));
    glowWide?.style.setProperty('opacity', (0.5 * value * value).toFixed(3));
    fieldLight?.style.setProperty('opacity', (0.32 * value).toFixed(3));
  };

  // Back to the look without it: the inline values go, and the style sheet's are what show.
  const rest = () => {
    for (const element of [glow, glowWide, fieldLight]) element?.style.removeProperty('opacity');
    written = -1;
    level = 0;
  };

  // One reading: the low end now, a level that rises almost at once and falls over a few readings, written when the
  // change would show.
  const tick = () => {
    if (!analyser || !bins) return;
    analyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let bin = LOW_FIRST; bin <= LOW_LAST; bin += 1) sum += bins[bin] ?? 0;
    const energy = sum / ((LOW_LAST - LOW_FIRST + 1) * 255);
    // The loudest lately falls slowly (by about a sixth each second), so a quiet passage still moves after a loud one.
    peak = Math.max(energy, peak * 0.991, 0.25);
    const target = Math.min(1, energy / peak) ** 2;
    level += (target - level) * (target > level ? 0.8 : 0.27);
    if (Math.abs(level - written) >= LEAST) {
      show(level);
      written = level;
    }
  };

  // Whether the light follows the music now, and starts or stops it to match.
  const follow = () => {
    const on =
      readable() &&
      state.listening &&
      state.player?.status === 'playing' &&
      !audio.paused &&
      document.visibilityState === 'visible' &&
      moving();
    if (on && !timer) {
      graph();
      timer = window.setInterval(tick, STEP_MS);
      if (!source) connect();
      void context?.resume();
    } else if (!on && timer) {
      window.clearInterval(timer);
      timer = 0;
      rest();
      if (analyser) sound.untap(analyser);
      // The audio graph sleeps too, nothing computed while nothing moves; unless the sound itself goes through it (a
      // preset), which plays on. Handed over while it was falling asleep: woken again for the sound.
      if (context && !sound.routed()) {
        const sleeping = context;
        void sleeping.suspend().then(() => {
          if (sound.routed()) void sleeping.resume();
        });
      }
    }
  };

  // The element handed to the sound graph: read there from now on (the copy let go). A browser without captureStream
  // has had nothing to follow until now, and starts.
  sound.whenRouted(() => {
    connect();
    follow();
  });

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
