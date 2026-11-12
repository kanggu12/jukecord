/**
 * The voice channel's sound preset, applied to this browser's own playing along with WebAudio, so that a browser hears
 * the same sound as the voice channel. The presets are core/sound.ts's table: the same shelves, peak and gain the voice
 * output asks ffmpeg for, which BiquadFilterNode computes with the same formulas.
 *
 * The audio element goes through WebAudio only once a preset is on (a page that never meets one plays it as it is),
 * and stays there after (an element can be handed to WebAudio once): with the preset off again, nothing is between
 * the element and the speakers but this browser's volume. That volume is then a gain at the end, after the preset, as
 * the voice channel's volume comes after its preset; each browser keeps its own. Browsers let WebAudio make sound only
 * after a press on the page, so the context is made (or woken) in the press of the Listen key, and the element is
 * handed over only while the context runs: a context the browser holds back would silence it.
 */
import { PRESET_STAGES, type SoundPreset, type SoundStage } from '../../src/core/sound.ts';

export class SoundGraph {
  private readonly audio: HTMLAudioElement;
  // Told when the browser starts or stops letting WebAudio make sound (a phone locked or unlocked, a call).
  private readonly changed: () => void;
  // Made in the first press of the Listen key, where the browser allows it to run.
  private context: AudioContext | null = null;
  // The element as WebAudio's source, and this browser's volume at the end; null until a preset first needs them.
  private source: MediaElementAudioSourceNode | null = null;
  private output: GainNode | null = null;
  // The preset's nodes in between, made again when the preset changes.
  private chain: AudioNode[] = [];
  private preset: SoundPreset = 'off';
  private volume = 1;

  constructor(audio: HTMLAudioElement, changed: () => void = () => {}) {
    this.audio = audio;
    this.changed = changed;
  }

  /** In the press of the Listen key: makes the context, or wakes it, while the browser allows it. */
  unlock(): void {
    // Browsers without WebAudio play the track as it is.
    if (typeof AudioContext === 'undefined') return;
    if (!this.context) {
      this.context = new AudioContext();
      // A phone suspends WebAudio when it locks or takes a call, where a plain element would play on: the listening
      // bar then asks for a press of Listen, which wakes it (see held).
      this.context.onstatechange = () => this.changed();
    }
    this.wake();
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

  /** The voice channel's preset, from the server: applied at once where the context runs, else at the next press. */
  setPreset(preset: SoundPreset): void {
    if (preset === this.preset) return;
    this.preset = preset;
    this.apply();
  }

  /** This browser's own volume, 0 to 1: the element's, or the gain at the end once the element is WebAudio's. */
  setVolume(volume: number): void {
    this.volume = volume;
    if (this.output) this.output.gain.value = volume;
    else this.audio.volume = volume;
  }

  // Puts the preset between the element and the speakers. Nothing to do for the plain sound on an element never
  // handed over, or before the browser lets the context run.
  private apply(): void {
    const context = this.context;
    if (this.preset === 'off' && !this.source) return;
    if (context?.state !== 'running') return;
    if (!this.source || !this.output) {
      this.source = context.createMediaElementSource(this.audio);
      this.output = context.createGain();
      this.output.connect(context.destination);
      // The volume moves to the gain at the end; the element itself plays at full.
      this.audio.volume = 1;
      this.output.gain.value = this.volume;
    }
    this.source.disconnect();
    for (const node of this.chain) node.disconnect();
    this.chain = PRESET_STAGES[this.preset].map((stage) => stageNode(context, stage));
    // The element, the preset's steps in order, the volume.
    let last: AudioNode = this.source;
    for (const node of this.chain) {
      last.connect(node);
      last = node;
    }
    last.connect(this.output);
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
