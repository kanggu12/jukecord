/**
 * The voice channel's sound: the presets' table, and the places that must agree with it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPlain, isPreset, PRESET_STAGES, SOUND_PRESETS } from '../../src/core/sound.ts';
import { SoundPresetSchema } from '../../src/web/schemas.ts';

describe('the sound presets', () => {
  it('are the same list in the API schema as in the table', () => {
    // The schema writes them out (for TypeBox's types); a preset added to one list and not the other fails here.
    const literals = (SoundPresetSchema.anyOf as { const: string }[]).map((entry) => entry.const);
    assert.deepEqual(literals, [...SOUND_PRESETS]);
    assert.deepEqual(Object.keys(PRESET_STAGES), [...SOUND_PRESETS]);
  });

  it('call only full volume without a preset plain, and know their own names', () => {
    assert.equal(isPlain({ volume: 100, preset: 'off' }), true);
    assert.equal(isPlain({ volume: 99, preset: 'off' }), false);
    assert.equal(isPlain({ volume: 100, preset: 'night' }), false);
    assert.equal(isPreset('bass'), true);
    assert.equal(isPreset('nightcore'), false);
  });

  it('lift no frequency by more than 1 dB in all, so the cached peaks stay under 0 dB', () => {
    for (const preset of SOUND_PRESETS) {
      const stages = PRESET_STAGES[preset];
      // The gains add up everywhere; each lift adds at most its own size somewhere.
      const gain = stages.reduce((sum, stage) => sum + (stage.kind === 'gain' ? stage.db : 0), 0);
      const lifts = stages.reduce((sum, stage) => sum + (stage.kind !== 'gain' ? Math.max(0, stage.db) : 0), 0);
      assert.ok(gain + lifts <= 1, `${preset} can lift a frequency by ${gain + lifts} dB`);
    }
  });
});
