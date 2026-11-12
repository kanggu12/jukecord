/**
 * The now-playing card kept current.
 *
 * A card answered to /np, to /pause and the like, or to a press of one of its keys showed the player as it was then;
 * the next change left it wrong, and its keys did something else than they showed. The last card of each server (the
 * newest one people look at) is now edited as the player changes: at most once every few seconds (Discord limits how
 * often a message may be edited, and a burst of changes is one edit with the newest state), and only when what the
 * card shows changed. A card that cannot be edited any more (deleted, its channel gone) is let go.
 */
import type { Clock, TimerHandle } from '../core/clock.ts';
import type { PlayerSnapshot } from '../core/player.ts';
import type { Logger } from '../log.ts';
import type { Lang } from './cards.ts';

/** A card as the bot sends it (embeds and keys). */
export type CardPayload = Parameters<typeof JSON.stringify>[0];

/** A card posted in a server, and how to draw it again. */
export interface KeptCard {
  /** Draws the card again with this payload; rejects when that cannot be done (the message gone). */
  edit(payload: CardPayload): Promise<unknown>;
  /** The language it was made in: a card in the channel is everyone's, and stays in its own language. */
  readonly lang: Lang;
}

export interface CardKeeperOptions {
  readonly clock: Clock;
  /** Draws the card of a snapshot in a language. */
  readonly render: (snapshot: PlayerSnapshot, lang: Lang) => CardPayload;
  readonly log: Logger;
  /** The fewest milliseconds between two edits of a server's card (5 s by default). */
  readonly everyMs?: number;
}

// One server's kept card: what it shows (as JSON, to see whether a change changes it), the snapshot to draw next, and
// the timer that holds the edit back.
interface Kept {
  readonly card: KeptCard;
  shown: string;
  latest: PlayerSnapshot | null;
  timer: TimerHandle | null;
  // On the steady clock.
  editedAt: number;
}

export class CardKeeper {
  private readonly options: CardKeeperOptions;
  private readonly everyMs: number;
  private readonly cards = new Map<string, Kept>();

  constructor(options: CardKeeperOptions) {
    this.options = options;
    this.everyMs = options.everyMs ?? 5000;
  }

  /** Keeps a card just posted (or just drawn again) with what it shows; it replaces the server's card before it. */
  keep(guildId: string, card: KeptCard, shown: CardPayload): void {
    this.drop(guildId);
    this.cards.set(guildId, {
      card,
      shown: JSON.stringify(shown),
      latest: null,
      timer: null,
      // Not edited yet: the first change shows at once (a card says what plays now, a press later included), the
      // ones after it at most every few seconds.
      editedAt: Number.NEGATIVE_INFINITY,
    });
  }

  /** Whether a server has a card kept current (for tests). */
  kept(guildId: string): boolean {
    return this.cards.has(guildId);
  }

  /** The player of a server changed: its card is drawn again soon, with the newest state. */
  changed(snapshot: PlayerSnapshot): void {
    const kept = this.cards.get(snapshot.guildId);
    if (!kept) return;
    kept.latest = snapshot;
    if (kept.timer !== null) return;
    const wait = Math.max(0, kept.editedAt + this.everyMs - this.options.clock.steady());
    kept.timer = this.options.clock.setTimeout(() => this.draw(snapshot.guildId, kept), wait);
  }

  /** Stops keeping every card (shutting down): no timer is left behind. */
  stop(): void {
    for (const guildId of [...this.cards.keys()]) this.drop(guildId);
  }

  // Draws a kept card again with the newest state, when that shows something else than the card does.
  private draw(guildId: string, kept: Kept): void {
    kept.timer = null;
    // Replaced by a newer card meanwhile: that one is drawn on its own.
    if (this.cards.get(guildId) !== kept || !kept.latest) return;
    const payload = this.options.render(kept.latest, kept.card.lang);
    const shown = JSON.stringify(payload);
    if (shown === kept.shown) return;
    kept.shown = shown;
    kept.editedAt = this.options.clock.steady();
    kept.card.edit(payload).catch((error: unknown) => {
      // Deleted, or its channel gone or closed to the bot: nothing more to keep current.
      if (this.cards.get(guildId) !== kept) return;
      this.drop(guildId);
      this.options.log.debug('stopped keeping a card that could not be edited', { guild: guildId, error });
    });
  }

  // Forgets a server's card and its timer.
  private drop(guildId: string): void {
    const kept = this.cards.get(guildId);
    if (kept?.timer != null) this.options.clock.clearTimeout(kept.timer);
    this.cards.delete(guildId);
  }
}
