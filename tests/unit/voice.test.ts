import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { type AudioPlayer, AudioPlayerStatus, type AudioResource } from '@discordjs/voice';
import { VoiceOutput, type VoiceParts } from '../../src/discord/voice.ts';
import { createLogger } from '../../src/log.ts';
import { Ffmpeg } from '../../src/media/ffmpeg.ts';

// An audio player that only records calls and lets the test drive its state, the way @discordjs/voice reports it.
class FakeAudioPlayer extends EventEmitter {
  state: { status: AudioPlayerStatus; resource?: AudioResource<{ session: number }> } = {
    status: AudioPlayerStatus.Idle,
  };
  readonly calls: string[] = [];

  play(resource: AudioResource<{ session: number }>): void {
    this.calls.push(`play ${resource.metadata.session}`);
    this.move({ status: AudioPlayerStatus.Playing, resource });
  }
  pause(): boolean {
    this.calls.push('pause');
    return true;
  }
  unpause(): boolean {
    this.calls.push('unpause');
    return true;
  }
  stop(): boolean {
    this.calls.push('stop');
    this.move({ status: AudioPlayerStatus.Idle });
    return true;
  }
  /** The stream ran out: what the library does at the end of a track. */
  finish(): void {
    this.move({ status: AudioPlayerStatus.Idle });
  }
  private move(next: FakeAudioPlayer['state']): void {
    const before = this.state;
    this.state = next;
    this.emit('stateChange', before, next);
  }
}

function setup() {
  const audio = new FakeAudioPlayer();
  const parts: VoiceParts = {
    createPlayer: () => audio as unknown as AudioPlayer,
    createResource: (_stream: Readable, session: number) =>
      ({ metadata: { session } }) as AudioResource<{ session: number }>,
  };
  const ended: number[] = [];
  const output = new VoiceOutput({
    ffmpeg: new Ffmpeg('ffmpeg'),
    log: createLogger({ level: 'error', sinks: [] }),
    onEnded: (session) => ended.push(session),
    parts,
  });
  // A real file, so the read stream the output opens has something behind it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-voice-'));
  const file = path.join(dir, 'a.opus');
  fs.writeFileSync(file, Buffer.alloc(16));
  return {
    audio,
    output,
    ended,
    media: { file, durationMs: 180_000 },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('VoiceOutput', () => {
  it('reports the end of the session it was started with', () => {
    const { audio, output, ended, media, cleanup } = setup();
    try {
      output.start(media, 0, 7);
      audio.finish();
      assert.deepEqual(ended, [7]);
    } finally {
      cleanup();
    }
  });

  it('does not take its own stop, or a replaced stream, for the end of a track', () => {
    const { audio, output, ended, media, cleanup } = setup();
    try {
      output.start(media, 0, 1);
      output.stop();
      output.start(media, 0, 2);
      // Starting again replaces the resource without going idle; then a pause and resume pass through.
      output.start(media, 0, 3);
      output.pause();
      output.resume();
      assert.deepEqual(ended, []);
      assert.deepEqual(audio.calls, ['play 1', 'stop', 'play 2', 'play 3', 'pause', 'unpause']);
    } finally {
      cleanup();
    }
  });
});
