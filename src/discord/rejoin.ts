/**
 * Coming back to voice after a restart (an update, a crash, the machine started again).
 *
 * The voice channel each server's bot is in is kept in the database as the bot joins, is moved and leaves, from the
 * bus's voice events. jukecord stopping leaves every channel too; that is not kept, being jukecord's leaving and not
 * people's (freeze). When Discord is back after the start, the bot goes back to each kept channel that has people in
 * it, and says so there with the now-playing card (once an hour at most: a crash loop comes back each time): paused,
 * since a restart never plays by itself. A kept channel with nobody in it is forgotten, so the bot does not turn up
 * there later by surprise; unless its server asked the bot to stay in voice when everyone has left (the stay
 * setting): the bot goes back there all the same, since it would have stayed had jukecord not restarted.
 *
 * This file knows nothing of Discord itself: the bot hands it how to count the people in a channel, how to join one
 * and how to say it came back (see Bot), so it is tested without Discord.
 */
import type { Bus } from '../core/bus.ts';
import type { Logger } from '../log.ts';
import type { VoiceChannelRepository } from '../store/store.ts';

export interface VoiceMemoryOptions {
  readonly bus: Bus;
  readonly channels: VoiceChannelRepository;
  readonly log: Logger;
  /** The date in ms (Date.now by default): saying it came back is spaced by the date, across restarts. */
  readonly now?: () => number;
}

// How long after saying it came back in a server the bot comes back there quietly: a run that keeps crashing comes
// back each time, and a note in the channel's chat every half minute would be noise in people's channel.
const TELL_EVERY_MS = 3_600_000;

/** What coming back needs from Discord. */
export interface Rejoining {
  /** How many people (not bots) are in a voice channel now; 0 for a channel gone. */
  people(guildId: string, channelId: string): number;
  /** Whether a server asked the bot to stay in voice when everyone has left (false when not said). */
  stays?(guildId: string): boolean;
  /** Whether the server's bot is in a voice channel already (someone called it since the start). */
  inVoice(guildId: string): boolean;
  /** Joins a voice channel; rejects when the bot cannot. */
  join(guildId: string, channelId: string): Promise<unknown>;
  /** Says in the channel that the bot came back. */
  told(guildId: string, channelId: string): Promise<void>;
}

export class VoiceMemory {
  private readonly options: VoiceMemoryOptions;
  // Set while jukecord stops: its leaving every channel then is not to be kept.
  private frozen = false;
  private off: (() => void) | null = null;

  constructor(options: VoiceMemoryOptions) {
    this.options = options;
  }

  /** Starts keeping the channel each server's bot is in. */
  start(): void {
    const onVoice = ({ guildId, channel }: { guildId: string; channel: { channelId: string } | null }) => {
      if (this.frozen) return;
      // Joined or moved: kept. Left (a person's leave, nobody there, kicked, removed from the server): forgotten.
      if (channel) this.options.channels.remember(guildId, channel.channelId);
      else this.options.channels.forget(guildId);
    };
    this.options.bus.on('voice', onVoice);
    this.off = () => this.options.bus.off('voice', onVoice);
  }

  /** jukecord is stopping: the channels it leaves now stay kept for the restart. */
  freeze(): void {
    this.frozen = true;
    this.off?.();
    this.off = null;
  }

  /**
   * Goes back to each kept channel with people in it, or of a server where the bot stays in voice (forgetting the
   * others); returns how many it went back to.
   */
  async rejoin(discord: Rejoining): Promise<number> {
    let back = 0;
    // The servers to go back to, in the order they were kept; each one's channel is read again on its turn, since a
    // join takes up to twenty seconds and people use the bot meanwhile.
    for (const { guildId } of this.options.channels.all()) {
      // Called into voice since the start (a /play while another server's bot connected): it stays with the people
      // who called it, and the channel it is in is the one kept now.
      if (discord.inVoice(guildId)) continue;
      const channelId = this.options.channels.get(guildId);
      // Called and sent away again meanwhile (/join, then /leave): it stays away, as it was told.
      if (channelId === null) continue;
      // A server that asked the bot to stay is gone back to with nobody there: it stays there, as it would have.
      if (!discord.stays?.(guildId) && discord.people(guildId, channelId) === 0) {
        // Nobody there now: not to be gone back to later, when nobody expects the bot.
        this.options.channels.forget(guildId);
        continue;
      }
      try {
        await discord.join(guildId, channelId);
      } catch (error) {
        // Gone, or no longer allowed: nothing to come back to (unless the bot went elsewhere meanwhile: that is kept).
        if (this.options.channels.get(guildId) === channelId) this.options.channels.forget(guildId);
        this.options.log.info('could not come back to voice after a restart', {
          guild: guildId,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      back += 1;
      this.options.log.info('came back to voice after a restart', { guild: guildId });
      // Said there within the hour (restarts in a row): back quietly this time.
      const toldAt = this.options.channels.toldAt(guildId);
      const now = this.options.now?.() ?? Date.now();
      if (toldAt !== null && now - toldAt < TELL_EVERY_MS) continue;
      this.options.channels.told(guildId);
      // Saying so is a courtesy: a channel without the right to post in it still has the bot back.
      await discord
        .told(guildId, channelId)
        .catch((error: unknown) =>
          this.options.log.debug('could not say the bot came back', { guild: guildId, error }),
        );
    }
    return back;
  }
}
