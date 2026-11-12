/**
 * Discord without Discord: a bot that never logs in (no token is used, nothing reaches Discord) around players that
 * really play, and interactions made up the way discord.js hands them to the bot, recording what the bot answers.
 */
import { Actions } from '../../src/app/actions.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { Track } from '../../src/core/types.ts';
import { Bot } from '../../src/discord/bot.ts';
import { createLogger, MemorySink } from '../../src/log.ts';
import type { Ffmpeg } from '../../src/media/ffmpeg.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { FakeClock, FakeMedia } from './fakes.ts';
import { memoryStore } from './store.ts';

export const GUILD = '100000000000000001';
export const PERSON = '300000000000000001';

/** A bot over real actions and players, with a resolver that answers from a table. */
export function fakeBot(options: { found?: Record<string, () => Track[]> } = {}) {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const media = new FakeMedia();
  const logs = new MemorySink();
  const log = createLogger({ level: 'debug', sinks: [logs] });
  const queue = new QueueService(store.queue, bus);
  const players = new Players({
    queue,
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log,
    fetchTimeoutMs: 60_000,
  });
  const resolver = {
    resolve: async (input: string) => {
      const found = options.found?.[input];
      if (!found) throw new Error('nothing was found');
      return found();
    },
  } as unknown as Resolver;
  const actions = new Actions({ store, queue, players, resolver, log });
  const bot = new Bot({
    token: 'not used',
    actions,
    players,
    bus,
    ffmpeg: {} as Ffmpeg,
    settings: store.settings,
    log,
    panelUrl: 'https://music.example.com',
    discord: store.discord,
    voiceIdleMs: 0,
    users: store.users,
  });
  actions.setVoice(bot.voice, () => true, bot);
  return { clock, store, bus, media, logs, queue, players, actions, bot };
}

/** One thing the bot showed: a reply (private or not), a follow-up, a deleted reply, or a card updated in place. */
export interface Shown {
  readonly kind: 'reply' | 'followUp' | 'deleted' | 'update';
  readonly ephemeral: boolean;
  /** The embeds' and buttons' text, in one line per part. */
  readonly text: string;
  /** The payload as the bot gave it. */
  readonly payload: unknown;
}

// The text of a payload: each embed's author, title, description and footer, then each row's buttons.
function textOf(payload: unknown): string {
  const value = payload as {
    embeds?: { toJSON(): Record<string, unknown> }[];
    components?: { toJSON(): { components: { label?: string; custom_id?: string }[] } }[];
  };
  const parts: string[] = [];
  for (const embed of value.embeds ?? []) {
    const json = embed.toJSON() as {
      author?: { name: string };
      title?: string;
      description?: string;
      footer?: { text: string };
    };
    parts.push([json.author?.name, json.title, json.description, json.footer?.text].filter(Boolean).join(' | '));
  }
  for (const row of value.components ?? [])
    parts.push(
      row
        .toJSON()
        .components.map((button) => `[${button.label}${button.custom_id ? ` ${button.custom_id}` : ''}]`)
        .join(' '),
    );
  return parts.join('\n');
}

/** A made-up interaction: a slash command (with its options) or a button press, from a member with these rights. */
export function interaction(
  kind: 'command' | 'button',
  name: string,
  values: Record<string, unknown> = {},
  options: { locale?: string; roles?: string[]; manage?: boolean; guild?: unknown } = {},
) {
  const shown: Shown[] = [];
  let deferredEphemeral = false;
  const record = (kind: Shown['kind'], ephemeral: boolean, payload: unknown) =>
    shown.push({ kind, ephemeral, text: textOf(payload), payload });
  const made = {
    locale: options.locale ?? 'en-US',
    commandName: name,
    customId: name,
    guildId: GUILD,
    guild: options.guild ?? { id: GUILD, voiceStates: { cache: new Map() } },
    user: { id: PERSON, displayName: 'Alice', avatar: null },
    member: { roles: options.roles ?? [] },
    memberPermissions: { has: () => options.manage ?? false },
    deferred: false,
    replied: false,
    inGuild: () => true,
    inCachedGuild: () => options.guild !== undefined,
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    options: {
      getString: (key: string) => (values[key] as string | undefined) ?? null,
      getInteger: (key: string) => (values[key] as number | undefined) ?? null,
      getSubcommand: () => (values.sub as string | undefined) ?? null,
      getChannel: (key: string) => (values[key] ? { id: values[key] } : null),
      getRole: (key: string) => ({ id: values[key] }),
    },
    deferReply: async (deferral?: { flags?: number }) => {
      made.deferred = true;
      deferredEphemeral = Boolean(deferral?.flags);
    },
    editReply: async (payload: unknown) => {
      record('reply', deferredEphemeral, payload);
      return { id: `${900_000_000_000_000_000 + shown.length}`, channelId: '600000000000000001' };
    },
    followUp: async (payload: unknown) => record('followUp', true, payload),
    deleteReply: async () => record('deleted', false, {}),
    reply: async (payload: unknown) => {
      made.replied = true;
      record('reply', true, payload);
    },
    update: async (payload: unknown) => record('update', false, payload),
  };
  return { interaction: made, shown };
}

/** The bot's handlers, which discord.js calls; private to the bot, reached here as discord.js reaches them. */
export function handlers(bot: Bot) {
  return bot as unknown as {
    onCommand(interaction: unknown): Promise<void>;
    onButton(interaction: unknown): Promise<void>;
  };
}
