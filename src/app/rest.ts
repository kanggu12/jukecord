/**
 * Resting: a server's player pauses when nobody hears it anywhere, instead of playing to nobody.
 *
 * Nobody hears a server when the bot is not in its voice channel and no browser of it plays along. The music used to
 * go on by the clock all the same: each track was fetched, and counted as a listen in the history and the statistics.
 * Now, once nobody has heard a playing server for a while (JUKECORD_REST_AFTER, two minutes by default: a page
 * reloads, a phone loses its line for a moment), its player pauses, with a notice that says why. People play on
 * themselves, from the panel, the card or a command: the music does not start again by itself.
 *
 * A bot that stays in voice (the leave-when-alone time at 0, or a server's own setting to stay) sounds in the channel,
 * which counts as heard: a channel playing all day for whoever comes in keeps playing.
 */
import type { Bus } from '../core/bus.ts';
import type { Clock } from '../core/clock.ts';
import { Countdowns } from '../core/countdowns.ts';
import { type GuildLanes, throwFromTimer } from '../core/lanes.ts';
import type { Players } from '../core/players.ts';
import type { Logger } from '../log.ts';

export interface RestOptions {
  readonly bus: Bus;
  readonly players: Players;
  /** The servers' lanes: a server rests in its own turn, a turn of its own (the countdown's). */
  readonly lanes: GuildLanes;
  /** Whether the bot is in the server's voice channel, which is where its sound goes. */
  readonly inVoice: (guildId: string) => boolean;
  /** How many browsers of the server play along. */
  readonly listeners: (guildId: string) => number;
  readonly clock: Clock;
  /** How long a playing server may go unheard before it rests; 0 never rests. */
  readonly afterMs: number;
  readonly log: Logger;
}

export class Rest {
  private readonly options: RestOptions;
  // One countdown per server nobody hears while it plays.
  private readonly waits: Countdowns;
  // The bus listeners, kept to remove them on stop.
  private readonly off: (() => void)[] = [];
  // How long a server may go unheard: the option's at first, the settings' after a change (JUKECORD_REST_AFTER).
  private afterMs: number;
  // Whether jukecord asked it to watch (start, until stop): a change of the time watches again only then.
  private started = false;

  constructor(options: RestOptions) {
    this.options = options;
    this.afterMs = options.afterMs;
    this.waits = new Countdowns(options.clock, options.afterMs, (guildId) => this.expired(guildId));
  }

  /** Starts watching every server (nothing at all when resting is off). */
  start(): void {
    this.started = true;
    this.watch();
  }

  /**
   * How long a playing server may go unheard from now on (0: never rests). Every wait starts again with the new time;
   * turned off, none is left running.
   */
  setAfter(ms: number): void {
    this.afterMs = ms;
    this.waits.setMs(ms);
    if (!this.started) return;
    this.unwatch();
    this.watch();
  }

  // Watches what can change whether a server is heard, once, while resting is on.
  private watch(): void {
    if (this.afterMs === 0 || this.off.length > 0) return;
    const { bus } = this.options;
    // What can change whether a server is heard, or whether it plays: its player, its voice channel, its browsers.
    const onPlayer = ({ guildId }: { guildId: string }) => this.check(guildId);
    const onVoice = ({ guildId }: { guildId: string }) => this.check(guildId);
    const onListeners = ({ guildId }: { guildId: string }) => this.check(guildId);
    bus.on('player', onPlayer);
    bus.on('voice', onVoice);
    bus.on('listeners', onListeners);
    this.off.push(
      () => bus.off('player', onPlayer),
      () => bus.off('voice', onVoice),
      () => bus.off('listeners', onListeners),
    );
    // The servers already playing when the watch starts.
    for (const player of this.options.players.all()) this.check(player.guildId);
  }

  /** Stops watching (shutting down): no countdown is left behind. */
  stop(): void {
    this.started = false;
    this.unwatch();
  }

  // Stops listening and drops every countdown.
  private unwatch(): void {
    for (const off of this.off.splice(0)) off();
    this.waits.disarmAll();
  }

  // Whether a server's player is playing (or getting the next track ready) while nobody hears it.
  private unheard(guildId: string): boolean {
    const player = this.options.players.existing(guildId);
    if (!player) return false;
    const { status } = player.snapshot();
    if (status !== 'playing' && status !== 'loading') return false;
    return !this.options.inVoice(guildId) && this.options.listeners(guildId) === 0;
  }

  // A countdown while it is unheard (a running one keeps its start), none otherwise.
  private check(guildId: string): void {
    if (this.unheard(guildId)) this.waits.arm(guildId);
    else this.waits.disarm(guildId);
  }

  // The wait is over: still unheard, so it rests. Looked at and paused in one turn of the server's, after whatever
  // change it waited behind; a failure is the countdown's, as it was when this ran in its timer.
  private expired(guildId: string): void {
    void this.options.lanes
      .later(guildId, async () => {
        if (!this.unheard(guildId)) return;
        if (await this.options.players.existing(guildId)?.rest())
          this.options.log.info('paused: nobody was listening', {
            guild: guildId,
            afterSeconds: Math.round(this.afterMs / 1000),
          });
      })
      .catch(throwFromTimer);
  }
}
