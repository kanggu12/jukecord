/**
 * Sound in a Discord voice channel: the player's output for one server, and joining and leaving channels.
 *
 * The cached file is Opus in Ogg, which is what Discord carries, so it is sent as it is (no encoder in the image).
 * Starting in the middle of a track (after a seek, or when the bot joins mid-song) goes through an ffmpeg process
 * that cuts from that place. Voice is end-to-end encrypted (DAVE); @discordjs/voice does that with the davey library.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { type Client, PermissionFlagsBits } from 'discord.js';
import { ActionError, type VoiceControl } from '../app/actions.ts';
import { type Clock, systemClock } from '../core/clock.ts';
import { Countdowns } from '../core/countdowns.ts';
import type { PlayerOutput, PreparedMedia } from '../core/player.ts';
import type { Players } from '../core/players.ts';
import type { Logger } from '../log.ts';
import type { Ffmpeg } from '../media/ffmpeg.ts';

// Below this offset the file is played from its start: the 3 s fade-in at the top covers the difference.
const FROM_START_MS = 50;

/** The session a resource was started for, carried in its metadata so its end can be matched to the player's. */
interface Meta {
  readonly session: number;
}

/** What VoiceOutput needs from @discordjs/voice; tests pass fakes. */
export interface VoiceParts {
  createPlayer(): AudioPlayer;
  createResource(stream: Readable, session: number): AudioResource<Meta>;
}

const realParts: VoiceParts = {
  // Play on with no subscriber: during a reconnect the stream keeps time with the browsers instead of falling behind.
  createPlayer: () => createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
  createResource: (stream, session) =>
    createAudioResource(stream, { inputType: StreamType.OggOpus, metadata: { session } }),
};

/** The player's output in one server's voice channel. */
export class VoiceOutput implements PlayerOutput {
  readonly name = 'voice';
  readonly audio: AudioPlayer;
  private readonly ffmpeg: Ffmpeg;
  private readonly parts: VoiceParts;
  // The session being played; -1 after stop, so the "idle" that stopping causes is not taken for the end of a track.
  private session = -1;
  // What feeds the current resource, closed when it is replaced.
  private stream: Readable | null = null;
  private process: ChildProcess | null = null;
  private readonly log: Logger;

  constructor(options: { ffmpeg: Ffmpeg; onEnded: (session: number) => void; log: Logger; parts?: VoiceParts }) {
    this.ffmpeg = options.ffmpeg;
    this.log = options.log;
    this.parts = options.parts ?? realParts;
    this.audio = this.parts.createPlayer();
    this.audio.on('stateChange', (before, after) => {
      // The end of a track: a resource was playing and now nothing is.
      if (after.status !== AudioPlayerStatus.Idle || before.status === AudioPlayerStatus.Idle) return;
      const ended = (before.resource as AudioResource<Meta>).metadata.session;
      if (ended !== this.session) return;
      this.session = -1;
      options.onEnded(ended);
    });
    // A broken stream ends the resource (the player goes idle, which counts as the end); say why in the log.
    this.audio.on('error', (error) => options.log.warn('voice playback failed', { error }));
  }

  start(media: PreparedMedia, offsetMs: number, session: number): void {
    this.release();
    this.session = session;
    if (offsetMs < FROM_START_MS) {
      this.stream = fs.createReadStream(media.file);
    } else {
      // ffmpeg cuts from the offset and writes Ogg Opus to its stdout.
      const child = spawn(this.ffmpeg.program, this.ffmpeg.seekArgs(media.file, offsetMs), {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.process = child;
      this.stream = child.stdout;
    }
    // A file that vanished or an ffmpeg that failed must not take the process down: an unhandled stream error
    // would. The resource then ends early and the player moves on.
    this.stream.on('error', (error) => this.log.warn('the voice stream failed', { error }));
    this.audio.play(this.parts.createResource(this.stream, session));
  }

  pause(): void {
    // Silence frames while paused keep Discord's jitter buffer from glitching when the sound comes back.
    this.audio.pause(true);
  }

  resume(): void {
    this.audio.unpause();
  }

  stop(): void {
    this.session = -1;
    this.audio.stop(true);
    this.release();
  }

  // Closes what fed the previous resource: the file handle or the ffmpeg process.
  private release(): void {
    this.process?.kill('SIGKILL');
    this.process = null;
    this.stream?.destroy();
    this.stream = null;
  }
}

// One server's voice connection with its output.
interface Joined {
  readonly connection: VoiceConnection;
  readonly output: VoiceOutput;
  readonly channelId: string;
  readonly name: string;
}

/** Joining and leaving voice channels, one connection per server. */
export class VoiceManager implements VoiceControl {
  private readonly client: Client;
  private readonly players: Players;
  private readonly ffmpeg: Ffmpeg;
  private readonly log: Logger;
  private readonly joined = new Map<string, Joined>();
  // How long the bot stays alone in a channel, and the countdowns running per server.
  private readonly idleMs: number;
  private readonly idle: Countdowns;

  constructor(options: {
    client: Client;
    players: Players;
    ffmpeg: Ffmpeg;
    log: Logger;
    idleMs: number;
    clock?: Clock;
  }) {
    this.client = options.client;
    this.players = options.players;
    this.ffmpeg = options.ffmpeg;
    this.log = options.log;
    this.idleMs = options.idleMs;
    this.idle = new Countdowns(options.clock ?? systemClock, options.idleMs, (guildId) => {
      this.log.info('left voice: nobody was in the channel', {
        guild: guildId,
        channel: this.joined.get(guildId)?.name,
      });
      this.drop(guildId);
    });
  }

  /**
   * Called on every voice change in a server. When nobody but bots is left in the bot's channel, the bot leaves after
   * the idle time (JUKECORD_VOICE_IDLE); someone coming back cancels that. The music goes on for the browsers either
   * way: leaving voice only stops sending sound nobody is there to hear.
   */
  voiceStateChanged(guildId: string): void {
    const joined = this.joined.get(guildId);
    if (!joined || this.idleMs === 0) return;
    const channel = this.client.guilds.cache.get(guildId)?.channels.cache.get(joined.channelId);
    const people = channel?.isVoiceBased() ? channel.members.filter((member) => !member.user.bot).size : 0;
    if (people > 0) this.idle.disarm(guildId);
    else this.idle.arm(guildId);
  }

  channel(guildId: string): { channelId: string; name: string } | null {
    const joined = this.joined.get(guildId);
    return joined ? { channelId: joined.channelId, name: joined.name } : null;
  }

  async join(
    guildId: string,
    channelId: string | null,
    userId: string | null,
  ): Promise<{ channelId: string; name: string }> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new ActionError('not-found', 'the bot is not in that server');
    // No channel named: the one the person is in.
    const target = channelId ?? (userId ? (guild.voiceStates.cache.get(userId)?.channelId ?? null) : null);
    if (!target) throw new ActionError('invalid', 'join a voice channel first, or name one');
    const channel = guild.channels.cache.get(target);
    if (!channel?.isVoiceBased()) throw new ActionError('invalid', 'that is not a voice channel');
    // Missing permissions fail silently in Discord (the bot appears and says nothing); say it plainly instead.
    const me = guild.members.me;
    const allowed = me ? channel.permissionsFor(me) : null;
    if (!allowed?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new ActionError('forbidden', `the bot may not connect or speak in ${channel.name}`);
    }
    const current = this.joined.get(guildId);
    if (current?.channelId === target) return { channelId: target, name: channel.name };
    if (current) this.drop(guildId);
    const connection = joinVoiceChannel({
      channelId: target,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      // Deafened: the bot never listens, and showing that is honest to the people in the channel.
      selfDeaf: true,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      throw new ActionError('unavailable', 'could not connect to the voice channel in time');
    }
    const output = new VoiceOutput({
      ffmpeg: this.ffmpeg,
      log: this.log,
      onEnded: (session) => this.players.get(guildId).outputEnded(session),
    });
    connection.subscribe(output.audio);
    // Discord moves voice servers now and then: a disconnect that turns into a reconnect within 5 s is kept.
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        this.log.info('left voice after a disconnect that did not recover', { guild: guildId });
        this.drop(guildId);
      });
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      // Destroyed from outside (kicked, channel deleted): the player carries on for the browsers.
      if (this.joined.get(guildId)?.connection === connection) this.forget(guildId);
    });
    this.joined.set(guildId, { connection, output, channelId: target, name: channel.name });
    this.players.get(guildId).attach(output);
    this.log.info('joined voice', { guild: guildId, channel: channel.name });
    // Joined a channel that is already empty (the person left meanwhile): the countdown starts now.
    this.voiceStateChanged(guildId);
    return { channelId: target, name: channel.name };
  }

  leave(guildId: string): boolean {
    if (!this.joined.has(guildId)) return false;
    this.drop(guildId);
    return true;
  }

  /** Leaves every channel (shutting down). */
  leaveAll(): void {
    for (const guildId of [...this.joined.keys()]) this.drop(guildId);
  }

  // Detaches the output and closes the connection.
  private drop(guildId: string): void {
    const joined = this.forget(guildId);
    if (joined && joined.connection.state.status !== VoiceConnectionStatus.Destroyed) joined.connection.destroy();
  }

  // Detaches the output and forgets the connection, without closing it.
  private forget(guildId: string): Joined | undefined {
    const joined = this.joined.get(guildId);
    if (!joined) return undefined;
    this.joined.delete(guildId);
    this.idle.disarm(guildId);
    this.players.get(guildId).detach(joined.output);
    return joined;
  }
}
