/**
 * The event bus: how the player and the queue tell the panel, the Discord bot and the API that something changed.
 *
 * Producers do not know who listens. The web layer turns these events into WebSocket messages, the Discord layer
 * updates its cards, and tests subscribe to check the order of events.
 */
import { EventEmitter } from 'node:events';
import type { PlayerSnapshot } from './player.ts';

/** A server's queue changed; `version` grows by one with each change, so a client can tell it missed one. */
export interface QueueChanged {
  readonly guildId: string;
  readonly version: number;
}

/** The bot joined, moved or left a server's voice channel (`channel` is null after leaving). */
export interface VoiceChanged {
  readonly guildId: string;
  readonly channel: { readonly channelId: string; readonly name: string } | null;
}

/** Every event and its payload. */
export interface BusEvents {
  queue: [QueueChanged];
  player: [PlayerSnapshot];
  voice: [VoiceChanged];
}

/** Hears about a listener that threw: the event, the server it was about, and the error. */
export type ListenerFailure = (event: keyof BusEvents, guildId: string | null, error: unknown) => void;

/**
 * Node's EventEmitter, typed with the events above so a misspelt event name or payload fails the type check, and
 * calling every listener even when one throws. A failing listener (a panel's message, a card) must not keep the others
 * from hearing about the change, nor reach the code that emitted it: that is often a player's timer, where the error
 * would end the process and the music of every server with it.
 */
export class Bus extends EventEmitter<BusEvents> {
  private readonly failed: ListenerFailure;

  constructor(failed?: ListenerFailure) {
    // Listeners include one per open panel tab; the default warning at 10 would fire on an ordinary evening.
    super();
    this.setMaxListeners(0);
    this.failed =
      failed ??
      ((event, guildId, error) => {
        process.stderr.write(
          `jukecord: a listener of "${event}" (${guildId ?? 'no server'}) failed: ${String(error)}\n`,
        );
      });
  }

  override emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): boolean {
    // rawListeners keeps once() wrappers, which remove themselves when called, as emit would.
    const listeners = this.rawListeners(event) as ((...values: BusEvents[K]) => void)[];
    for (const listener of listeners) {
      try {
        listener.apply(this, args);
      } catch (error) {
        const guildId = (args[0] as { guildId?: unknown } | undefined)?.guildId;
        this.failed(event, typeof guildId === 'string' ? guildId : null, error);
      }
    }
    return listeners.length > 0;
  }
}
