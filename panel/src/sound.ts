/**
 * The voice channel's sound preset, applied to this browser's own playing along with WebAudio, so that a browser hears
 * the same sound as the voice channel. The presets are core/sound.ts's table: the same shelves, peak and gain the voice
 * output asks ffmpeg for, which BiquadFilterNode computes with the same formulas.
 *
 * The audio element goes through WebAudio only once a preset is on: a page that never meets one plays the element as
 * it is. Handed over, it stays (an element can be handed to WebAudio once): with the preset off again, nothing is
 * between the element and the speakers but this browser's volume. That volume is then a gain at the end, after the
 * preset, as the voice channel's volume comes after its preset; each browser keeps its own. Browsers let WebAudio make
 * sound only after a press on the page, so the context is woken in the press of the Listen key too, and the element is
 * handed over only while the context runs: a context the browser holds back would silence it (until then the sound
 * stays as it is).
 *
 * The page has one AudioContext, shared with the light that moves with the music (views/light.ts): each running
 * context is a stream of its own to the sound hardware, and a phone's battery pays for each. Once the element is
 * handed over, the light reads the sound here, before this browser's volume (see tap), and the context stays awake
 * for the sound whatever the light does.
 */
import { PRESET_STAGES, type SoundPreset, type SoundStage } from '../../src/core/sound.ts';

// The page's one AudioContext, made by the first that needs it (the sound graph or the light).
let shared: AudioContext | null = null;

/** The page's AudioContext, made at the first call (null in a browser without WebAudio). */
export function pageAudio(): AudioContext | null {
  if (!shared && typeof AudioContext !== 'undefined') shared = new AudioContext();
  return shared;
}

export class SoundGraph {
  private readonly audio: HTMLAudioElement;
  // Told when the browser starts or stops letting WebAudio make sound (a phone locked or unlocked, a call).
  private readonly changed: () => void;
  // The page's context, once a preset needed it here (the light may have made it before).
  private context: AudioContext | null = null;
  // The element as WebAudio's source, and this browser's volume at the end; null until a preset first needs them.
  private source: MediaElementAudioSourceNode | null = null;
  private output: GainNode | null = null;
  // The sound after the preset and before the volume, where the light reads it (a gain of 1, always there once the
  // element is handed over, so the light's connection survives a change of preset).
  private point: GainNode | null = null;
  // The preset's nodes in between, made again when the preset changes.
  private chain: AudioNode[] = [];
  private preset: SoundPreset = 'off';
  private volume = 1;
  // Whether the Listen key was pressed on this page: before that the browser plays nothing here, and WebAudio made
  // without a press would only wait for one.
  private pressed = false;
  // Told once the element is handed over (the light reads it here from then on).
  private readonly handed: (() => void)[] = [];

  constructor(audio: HTMLAudioElement, changed: () => void = () => {}) {
    this.audio = audio;
    this.changed = changed;
  }

  /** In the press of the Listen key: makes the context, or wakes it, while the browser allows it, if a preset needs it. */
  unlock(): void {
    this.pressed = true;
    // Nothing to put between the element and the speakers: no WebAudio for the sound.
    if (this.preset === 'off' && !this.source) return;
    this.start();
  }

  // Takes the page's context when it has none (browsers without WebAudio play the track as it is) and wakes it; the
  // preset goes in once it runs.
  private start(): void {
    if (!this.context) {
      this.context = pageAudio();
      if (!this.context) return;
      // A phone suspends WebAudio when it locks or takes a call, where a plain element would play on: the listening
      // bar then asks for a press of Listen, which wakes it (see held). Only the sound's own state matters to the bar:
      // the light suspends the context it shares while the element is not handed over yet.
      this.context.addEventListener('statechange', () => {
        if (this.source) this.changed();
      });
    }
    if (this.context.state === 'running') this.apply();
    else this.wake();
  }

  /** Wakes the context made earlier, where the browser allows it without a press (the page shown again, a media key). */
  wake(): void {
    // Running once the browser says so: then a preset on (now or later) can be applied.
    this.context?.resume().then(
      () => this.apply(),
      () => {},
    );
  }

  /** Whether this browser's sound goes through WebAudio and the browser holds that back now: nothing is heard. */
  held(): boolean {
    return this.source !== null && this.context?.state !== 'running';
  }

  /** Whether the element is WebAudio's (a preset was on while listening here): its sound is read here, not copied. */
  routed(): boolean {
    return this.source !== null;
  }

  /** Calls `listener` once the element is handed to WebAudio; at once when it is already. */
  whenRouted(listener: () => void): void {
    if (this.source) listener();
    else this.handed.push(listener);
  }

  /**
   * Feeds `node` (of the page's context) the sound as this browser plays it, after the preset and before this
   * browser's volume; false while the element is not handed over (the light copies the element's stream then).
   */
  tap(node: AudioNode): boolean {
    if (!this.point) return false;
    this.point.connect(node);
    return true;
  }

  /** Stops feeding `node` (the light at rest). */
  untap(node: AudioNode): void {
    if (!this.point) return;
    try {
      this.point.disconnect(node);
    } catch {
      // Not connected to it: nothing to undo.
    }
  }

  /** The voice channel's preset, from the server: applied at once where the browser lets WebAudio run, else at the
   * next press of the Listen key. */
  setPreset(preset: SoundPreset): void {
    if (preset === this.preset) return;
    this.preset = preset;
    // The plain sound on an element never handed over needs nothing; before a press of Listen, nothing plays here.
    if (this.pressed && (preset !== 'off' || this.source)) this.start();
  }

  /** This browser's own volume, 0 to 1: the element's, or the gain at the end once the element is WebAudio's. */
  setVolume(volume: number): void {
    this.volume = volume;
    if (this.output) this.output.gain.value = volume;
    else this.audio.volume = volume;
  }

  // Puts the preset between the element and the speakers. Nothing to do for the plain sound on an element never
  // handed over, or before the browser lets the context run (never woken from here: a browser that keeps it held
  // would otherwise be asked again and again).
  private apply(): void {
    const context = this.context;
    if (this.preset === 'off' && !this.source) return;
    if (context?.state !== 'running') return;
    if (!this.source || !this.output || !this.point) {
      this.source = context.createMediaElementSource(this.audio);
      this.point = context.createGain();
      this.output = context.createGain();
      this.point.connect(this.output);
      this.output.connect(context.destination);
      // The volume moves to the gain at the end; the element itself plays at full.
      this.audio.volume = 1;
      this.output.gain.value = this.volume;
      // Whoever waited for the sound to be here (the light) reads it from now on.
      for (const listener of this.handed.splice(0)) listener();
    }
    this.source.disconnect();
    for (const node of this.chain) node.disconnect();
    this.chain = PRESET_STAGES[this.preset].map((stage) => stageNode(context, stage));
    // The element, the preset's steps in order, the point the light reads, the volume.
    let last: AudioNode = this.source;
    for (const node of this.chain) {
      last.connect(node);
      last = node;
    }
    last.connect(this.point);
  }
}

// One step of a preset as a WebAudio node: a gain, or a biquad (a shelf's slope is WebAudio's own 1, as ffmpeg is asked).
function stageNode(context: BaseAudioContext, stage: SoundStage): AudioNode {
  if (stage.kind === 'gain') {
    const gain = context.createGain();
    gain.gain.value = 10 ** (stage.db / 20);
    return gain;
  }
  const filter = context.createBiquadFilter();
  filter.type = stage.kind;
  filter.frequency.value = stage.hz;
  filter.gain.value = stage.db;
  if (stage.kind === 'peaking') filter.Q.value = stage.q;
  return filter;
}
