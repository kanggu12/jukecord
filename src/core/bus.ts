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

/** Every event and its payload. */
export interface BusEvents {
  queue: [QueueChanged];
  player: [PlayerSnapshot];
}

/** Node's EventEmitter, typed with the events above so a misspelt event name or payload fails the type check. */
export class Bus extends EventEmitter<BusEvents> {
  constructor() {
    // Listeners include one per open panel tab; the default warning at 10 would fire on an ordinary evening.
    super();
    this.setMaxListeners(0);
  }
}
