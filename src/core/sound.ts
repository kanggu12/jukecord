/**
 * The sound of a server's voice channel: its volume and a preset. The presets live here, as data, for the two places
 * that make them: the voice output turns them into ffmpeg filters (src/media/ffmpeg.ts), and a browser listening along
 * turns them into WebAudio nodes (panel/src/sound.ts), so the voice channel and the browsers hear the same sound.
 *
 * Every preset is a gain and a few of the filters of the Audio EQ Cookbook (a low shelf, a high shelf, a peak), which
 * ffmpeg's lowshelf, highshelf and equalizer and the browsers' BiquadFilterNode compute with the same formulas: the same
 * curve on both sides, not one like it. A preset that lifts a band first lowers everything by the lift less 1 dB, so the
 * most any frequency gains is 1 dB: the cached tracks' peaks are held under -1 dB when they are made, and stay under 0.
 * The volume is the voice channel's alone; each browser keeps its own. Nothing here needs Node or a browser: the panel's
 * bundle takes this file as it is.
 */

/** The presets, in the order people are offered them. */
export const SOUND_PRESETS = ['off', 'bass', 'voices', 'bright', 'night'] as const;

export type SoundPreset = (typeof SOUND_PRESETS)[number];

/** One step of a preset: a gain, a shelf (its slope 1, as WebAudio's shelves are) or a peak, each in dB. */
export type SoundStage =
  | { readonly kind: 'gain'; readonly db: number }
  | { readonly kind: 'lowshelf' | 'highshelf'; readonly hz: number; readonly db: number }
  | { readonly kind: 'peaking'; readonly hz: number; readonly db: number; readonly q: number };

/** Each preset's steps, in the order the sound goes through them. */
export const PRESET_STAGES: Readonly<Record<SoundPreset, readonly SoundStage[]>> = {
  // The track as it is: no step at all, so the voice channel gets the cached file untouched.
  off: [],
  // More bass: below about 100 Hz up 5 dB, which the gain before it leaves at +1 dB, the rest 4 dB down.
  bass: [
    { kind: 'gain', db: -4 },
    { kind: 'lowshelf', hz: 100, db: 5 },
  ],
  // Clearer voices: less boom below about 180 Hz, and 4 dB more where speech and singing are understood (2.8 kHz).
  voices: [
    { kind: 'gain', db: -3 },
    { kind: 'lowshelf', hz: 180, db: -3 },
    { kind: 'peaking', hz: 2800, db: 4, q: 0.9 },
  ],
  // Brighter: above about 5 kHz up 4 dB.
  bright: [
    { kind: 'gain', db: -3 },
    { kind: 'highshelf', hz: 5000, db: 4 },
  ],
  // Softer at night: the low end that carries through walls down 6 dB, the highs a little down, and 4 dB quieter.
  night: [
    { kind: 'lowshelf', hz: 200, db: -6 },
    { kind: 'highshelf', hz: 6000, db: -3 },
    { kind: 'gain', db: -4 },
  ],
};

/** A voice channel's sound: the volume in percent (0 to 200) and the preset. */
export interface Sound {
  readonly volume: number;
  readonly preset: SoundPreset;
}

/** The voice volume's range, in percent. */
export const VOLUME_MAX = 200;

/** The sound of a server that never chose one: the cached track as it is. */
export const PLAIN_SOUND: Sound = { volume: 100, preset: 'off' };

/** Whether a sound is the cached track as it is (full volume, no preset): then nothing is decoded or encoded again. */
export function isPlain(sound: Sound): boolean {
  return sound.volume === 100 && sound.preset === 'off';
}

/** Whether a word is one of the presets (for input from the panel, the API, the CLI and Discord). */
export function isPreset(value: string): value is SoundPreset {
  return (SOUND_PRESETS as readonly string[]).includes(value);
}
