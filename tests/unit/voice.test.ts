import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { type AudioPlayer, AudioPlayerStatus, type AudioResource } from '@discordjs/voice';
import type { Sound } from '../../src/core/sound.ts';
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

describe('VoiceOutput pauses and broken starts', () => {
  it('keeps a pause asked for while the stream was buffering, and applies it once the stream plays', () => {
    const { audio, output, media, cleanup } = setup();
    try {
      // The fake moves to Playing at once; a real player buffers first. Pausing then is lost in @discordjs/voice.
      audio.play = (resource: AudioResource<{ session: number }>) => {
        audio.calls.push(`play ${resource.metadata.session}`);
        audio.state = { status: AudioPlayerStatus.Buffering, resource };
      };
      output.start(media, 0, 1);
      output.pause();
      const pausesBefore = audio.calls.filter((call) => call === 'pause').length;
      // The stream starts to play: the wanted pause takes effect now.
      const before = audio.state;
      audio.state = before.resource
        ? { status: AudioPlayerStatus.Playing, resource: before.resource }
        : { status: AudioPlayerStatus.Playing };
      audio.emit('stateChange', before, audio.state);
      assert.equal(audio.calls.filter((call) => call === 'pause').length, pausesBefore + 1);
      // A resume clears the wish: the next start plays.
      output.resume();
      const again = audio.state;
      audio.emit('stateChange', { status: AudioPlayerStatus.Buffering }, again);
      assert.equal(audio.calls.filter((call) => call === 'pause').length, pausesBefore + 1);
    } finally {
      cleanup();
    }
  });

  it('survives an ffmpeg that cannot start for a seek', async () => {
    const { output, media, cleanup } = setup();
    try {
      // A missing program: spawn reports ENOENT as an error event, which would crash the process unhandled.
      (output as unknown as { ffmpeg: Ffmpeg }).ffmpeg = new Ffmpeg('/nonexistent/ffmpeg');
      output.start(media, 30_000, 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      output.stop();
    } finally {
      cleanup();
    }
  });
});

describe('VoiceOutput and the sound of the voice channel', () => {
  // An ffmpeg that is never there (nothing runs) and remembers which arguments the output asked it for.
  function recording() {
    const asked: string[] = [];
    const ffmpeg = new Ffmpeg('/nonexistent/ffmpeg');
    const seek = ffmpeg.seekArgs.bind(ffmpeg);
    const sound = ffmpeg.soundArgs.bind(ffmpeg);
    ffmpeg.seekArgs = (...args) => {
      asked.push('seek');
      return seek(...args);
    };
    ffmpeg.soundArgs = (...args) => {
      asked.push(`sound ${args[1]} ${args[3]}`);
      return sound(...args);
    };
    return { ffmpeg, asked };
  }

  it('sends the cached file as it is for the plain sound, and has ffmpeg make any other sound, from the top too', async () => {
    const { audio, media, cleanup } = setup();
    try {
      const { ffmpeg, asked } = recording();
      let current = { volume: 100, preset: 'off' } as Sound;
      const output = new VoiceOutput({
        ffmpeg,
        log: createLogger({ level: 'error', sinks: [] }),
        onEnded: () => {},
        parts: {
          createPlayer: () => audio as unknown as AudioPlayer,
          createResource: (_stream: Readable, session: number) =>
            ({ metadata: { session } }) as AudioResource<{ session: number }>,
        },
        sound: () => current,
      });
      output.start(media, 0, 1);
      output.start(media, 30_000, 2);
      current = { volume: 100, preset: 'bass' };
      output.start(media, 0, 3);
      output.start(media, 30_000, 4);
      // Plain from the top: no ffmpeg. Plain from the middle: the seek. A sound: ffmpeg's sound, faded in mid-track.
      assert.deepEqual(asked, ['seek', 'sound 0 false', 'sound 30000 true']);
      // The stream says which sound it has, until it stops.
      assert.deepEqual(output.streamSound(), { volume: 100, preset: 'bass' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      output.stop();
      assert.equal(output.streamSound(), null);
    } finally {
      cleanup();
    }
  });
});

describe('VoiceOutput replaced the moment its ffmpeg failed to start', () => {
  // Killing the handle of a process that never started ended this very test process with SIGKILL (Node 24.11).
  it('stops without signalling a process that never started (that would end jukecord itself)', () => {
    const { output, media, cleanup } = setup();
    try {
      (output as unknown as { ffmpeg: Ffmpeg }).ffmpeg = new Ffmpeg('/nonexistent/ffmpeg');
      // A seek, then at once another start and a stop: the first ffmpeg's error is still on its way.
      output.start(media, 30_000, 1);
      output.start(media, 60_000, 2);
      output.stop();
      // Still here: this test process was not signalled.
      assert.ok(true);
    } finally {
      cleanup();
    }
  });
});
