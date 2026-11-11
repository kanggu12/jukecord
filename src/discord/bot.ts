/**
 * The Discord bot: logs in, registers the slash commands in every server it is in, and turns commands and button
 * presses into actions.
 *
 * It asks Discord for two intents only, Guilds and GuildVoiceStates: no message content and no member list, which are
 * privileged and which a music bot does not need. Commands are registered per server, where Discord applies them at
 * once (global ones can take a while to reach every server).
 */
import { createHash } from 'node:crypto';
import {
  ActivityType,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import {
  type ActionContext,
  ActionError,
  type Actions,
  type Directory,
  type GuildInfo,
  type MemberInfo,
  type RoleInfo,
} from '../app/actions.ts';
import type { Bus } from '../core/bus.ts';
import type { Players } from '../core/players.ts';
import type { Logger } from '../log.ts';
import type { Ffmpeg } from '../media/ffmpeg.ts';
import type { DiscordRepository, SettingsRepository, UserRepository } from '../store/store.ts';
import { parseTimestamp } from '../util/time.ts';
import {
  addedCard,
  djCard,
  done,
  historyCard,
  type Lang,
  langOf,
  note,
  nowCard,
  playlistsCard,
  problem,
  queueCard,
  statsCard,
} from './cards.ts';
import { commandDefinitions } from './commands.ts';
import { VoiceManager } from './voice.ts';

export interface BotOptions {
  readonly token: string;
  readonly actions: Actions;
  readonly players: Players;
  readonly bus: Bus;
  readonly ffmpeg: Ffmpeg;
  readonly settings: SettingsRepository;
  readonly log: Logger;
  /** The panel's address, for the "listen along" link; null when no public address is set. */
  readonly panelUrl: string | null;
  /** Where the fingerprint of the registered commands is kept. */
  readonly discord: DiscordRepository;
  /** How long the bot waits alone in a voice channel before leaving (0: never). */
  readonly voiceIdleMs: number;
  /** Where the people who use commands are remembered, so the panel can show who added what. */
  readonly users: UserRepository;
}

export class Bot implements Directory {
  readonly client: Client;
  readonly voice: VoiceManager;
  private readonly options: BotOptions;

  constructor(options: BotOptions) {
    this.options = options;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.voice = new VoiceManager({
      client: this.client,
      players: options.players,
      ffmpeg: options.ffmpeg,
      log: options.log,
      idleMs: options.voiceIdleMs,
      bus: options.bus,
    });
  }

  self(): { id: string; name: string; avatar: string | null } | null {
    const user = this.client.user;
    return user ? { id: user.id, name: user.displayName, avatar: user.avatar } : null;
  }

  guilds(): GuildInfo[] {
    return [...this.client.guilds.cache.values()]
      .map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  roles(guildId: string): RoleInfo[] {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    return (
      [...guild.roles.cache.values()]
        // @everyone is the "no DJ role" case, and bot-managed roles belong to their bots; neither is a DJ role.
        .filter((role) => role.id !== guild.id && !role.managed)
        // Highest first, the way Discord lists roles.
        .sort((a, b) => b.position - a.position)
        .map((role) => ({ id: role.id, name: role.name, color: role.color }))
    );
  }

  async member(guildId: string, userId: string): Promise<MemberInfo | null> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return null;
    try {
      // Fetched afresh: without the members intent Discord does not tell the bot when roles change.
      const member = await guild.members.fetch({ user: userId, force: true });
      return { roles: [...member.roles.cache.keys()], manage: member.permissions.has(PermissionFlagsBits.ManageGuild) };
    } catch (error) {
      // 10007 is Discord's "Unknown Member": not in the server. Anything else is a failure worth passing on.
      if ((error as { code?: number }).code === 10007) return null;
      throw error;
    }
  }

  // Remembers the name and avatar of whoever used a command, for the panel's "added by".
  private remember(interaction: ChatInputCommandInteraction | ButtonInteraction): void {
    try {
      this.options.users.upsert({
        id: interaction.user.id,
        name: interaction.user.displayName,
        avatar: interaction.user.avatar,
      });
    } catch (error) {
      this.options.log.debug('could not remember a user', { error });
    }
  }

  // The "listening to" line under the bot's name. Discord limits presence updates, so changes are sent at most every
  // 15 s, the newest one winning.
  private activity: string | null = null;
  private activityTimer: NodeJS.Timeout | null = null;
  private activitySentAt = 0;
  private showActivity(title: string | null): void {
    this.activity = title;
    if (this.activityTimer !== null) return;
    const wait = Math.max(0, this.activitySentAt + 15_000 - Date.now());
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      this.activitySentAt = Date.now();
      const name = this.activity;
      this.client.user?.setActivity(name ? { name: name.slice(0, 120), type: ActivityType.Listening } : undefined);
    }, wait);
    this.activityTimer.unref();
  }

  // After a play from Discord, joins the person's voice channel when the bot is not in one yet, as people expect from
  // a music bot. A failure here (no permission, say) does not undo the add; the person can still /join.
  private async autoJoin(interaction: ChatInputCommandInteraction, context: ActionContext): Promise<void> {
    if (!interaction.inCachedGuild() || this.voice.channel(context.guildId)) return;
    if (!interaction.guild.voiceStates.cache.get(interaction.user.id)?.channelId) return;
    try {
      await this.options.actions.join(context, null);
    } catch (error) {
      this.options.log.debug('could not join the voice channel after a play', { error });
    }
  }

  /** Whether the bot is logged in and receiving events. */
  ready(): boolean {
    return this.client.isReady();
  }

  /** Logs in and starts answering. Resolves once logged in; registration of commands follows in the background. */
  async start(): Promise<void> {
    const log = this.options.log;
    this.client.once(Events.ClientReady, (client) => {
      log.info('logged in to Discord', { as: client.user.tag, servers: client.guilds.cache.size });
      for (const guild of client.guilds.cache.values()) void this.register(guild);
    });
    // A server that adds the bot later gets the commands at once.
    this.client.on(Events.GuildCreate, (guild) => void this.register(guild));
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) void this.onCommand(interaction);
      else if (interaction.isButton()) void this.onButton(interaction);
      else if (interaction.isAutocomplete()) void this.onAutocomplete(interaction);
    });
    // The "listening to" line under the bot's name follows the last server that changed.
    this.options.bus.on('player', (snapshot) => {
      const title = snapshot.status === 'playing' ? (snapshot.track?.title ?? null) : null;
      this.showActivity(title);
    });
    // People coming and going in voice decide whether the bot is alone in its channel (see VoiceManager).
    this.client.on(Events.VoiceStateUpdate, (before, after) =>
      this.voice.voiceStateChanged(after.guild.id ?? before.guild.id),
    );
    await this.client.login(this.options.token);
  }

  /** Leaves voice everywhere and logs out. */
  async stop(): Promise<void> {
    this.voice.leaveAll();
    await this.client.destroy();
  }

  // Puts this version's commands in a server (replacing whatever an older version registered).
  private async register(guild: Guild): Promise<void> {
    try {
      const definitions = commandDefinitions();
      // Discord allows 200 registrations per server a day; a restart with unchanged commands registers nothing.
      const hash = createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
      if (this.options.discord.commandsHash(guild.id) === hash) return;
      await guild.commands.set(definitions);
      this.options.discord.setCommandsHash(guild.id, hash);
      this.options.log.info('registered commands', { server: guild.name });
    } catch (error) {
      this.options.log.warn('could not register commands', { server: guild.name, error });
    }
  }

  // Who is asking and whether they may change the music: everyone, unless the server set a DJ role. People who can
  // manage the server always may.
  private context(interaction: ChatInputCommandInteraction | ButtonInteraction): ActionContext | null {
    if (!interaction.inGuild()) return null;
    const role = this.options.settings.get(interaction.guildId).djRoleId;
    const roles = interaction.member.roles;
    const hasRole = role === null || (Array.isArray(roles) ? roles.includes(role) : roles.cache.has(role));
    const manager = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    return {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      mayControl: hasRole || manager,
      mayManage: manager,
    };
  }

  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const lang = langOf(interaction.locale);
    const context = this.context(interaction);
    if (!context) return;
    this.remember(interaction);
    const actions = this.options.actions;
    const options = interaction.options;
    try {
      // Lookups can take seconds; answer "thinking" first so Discord does not time the command out (3 s).
      await interaction.deferReply();
      switch (interaction.commandName) {
        case 'add': {
          const at = options.getString('where') === 'next' ? 'next' : 'end';
          const result = await actions.add(context, options.getString('input', true), at);
          await interaction.editReply({ embeds: [addedCard(result, lang)] });
          await this.autoJoin(interaction, context);
          return;
        }
        case 'play': {
          const result = await actions.playNow(context, options.getString('input', true));
          await interaction.editReply({ embeds: [addedCard(result, lang)] });
          await this.autoJoin(interaction, context);
          return;
        }
        case 'skip':
          await interaction.editReply(nowCard(actions.skip(context), lang, this.options.panelUrl));
          return;
        case 'drop':
          await interaction.editReply(nowCard(actions.removeCurrent(context), lang, this.options.panelUrl));
          return;
        case 'pause':
          await interaction.editReply(nowCard(actions.pause(context), lang, this.options.panelUrl));
          return;
        case 'resume':
          await interaction.editReply(nowCard(actions.resume(context), lang, this.options.panelUrl));
          return;
        case 'repeat':
          await interaction.editReply(
            nowCard(actions.repeat(context, options.getString('mode', true)), lang, this.options.panelUrl),
          );
          return;
        case 'seek': {
          let at: number;
          try {
            at = parseTimestamp(options.getString('time', true));
          } catch (error) {
            throw new ActionError('invalid', error instanceof Error ? error.message : String(error));
          }
          await interaction.editReply(nowCard(actions.seek(context, at), lang, this.options.panelUrl));
          return;
        }
        case 'stop':
          actions.stop(context);
          await interaction.editReply({ embeds: [done(lang)] });
          return;
        case 'np':
          await interaction.editReply(nowCard(actions.nowPlaying(context), lang, this.options.panelUrl));
          return;
        case 'queue':
          await interaction.editReply({
            embeds: [queueCard(actions.queue(context).items, options.getInteger('page') ?? 1, lang)],
          });
          return;
        case 'remove': {
          // People see 1-based numbers in /queue; the action takes the item's ID.
          const item = actions.queue(context).items[options.getInteger('position', true) - 1];
          if (!item) throw new ActionError('not-found', 'there is no track with that number in the queue');
          actions.remove(context, item.id);
          await interaction.editReply({ embeds: [done(lang)] });
          return;
        }
        case 'move': {
          const items = actions.queue(context).items;
          const item = items[options.getInteger('from', true) - 1];
          if (!item) throw new ActionError('not-found', 'there is no track with that number in the queue');
          actions.move(context, item.id, Math.min(options.getInteger('to', true), items.length) - 1);
          await interaction.editReply({ embeds: [done(lang)] });
          return;
        }
        case 'shuffle':
          actions.shuffle(context);
          await interaction.editReply({ embeds: [done(lang)] });
          return;
        case 'dedupe': {
          const removed = actions.dedupe(context);
          await interaction.editReply({
            embeds: [note(lang, `Removed ${removed} duplicates`, `중복 ${removed}곡 뺌`)],
          });
          return;
        }
        case 'clear': {
          const removed = actions.clear(context);
          await interaction.editReply({ embeds: [note(lang, `Removed ${removed} tracks`, `${removed}곡 뺌`)] });
          return;
        }
        case 'history':
          await interaction.editReply({ embeds: [historyCard(actions.history(context, 10), lang)] });
          return;
        case 'playlist':
          await this.onPlaylist(interaction, context, lang);
          return;
        case 'join': {
          const joined = await actions.join(context, options.getChannel('channel')?.id ?? null);
          await interaction.editReply({ embeds: [note(lang, `Joined ${joined.name}`, `${joined.name} 에 들어옴`)] });
          return;
        }
        case 'leave':
          actions.leave(context);
          await interaction.editReply({ embeds: [done(lang)] });
          return;
        case 'listen':
          await interaction.editReply({
            embeds: [
              this.options.panelUrl
                ? note(lang, `Listen along: ${this.options.panelUrl}`, `같이 듣기: ${this.options.panelUrl}`)
                : note(
                    lang,
                    'The panel has no public address set (JUKECORD_PUBLIC_URL)',
                    '패널 공개 주소가 정해지지 않음(JUKECORD_PUBLIC_URL)',
                  ),
            ],
          });
          return;
        case 'stats':
          await interaction.editReply({
            embeds: [
              statsCard(actions.stats(context, options.getInteger('days') ?? 30, offsetOf(interaction.locale)), lang),
            ],
          });
          return;
        case 'dj': {
          const sub = options.getSubcommand();
          const settings =
            sub === 'show'
              ? actions.settings(context)
              : actions.djRole(context, sub === 'set' ? options.getRole('role', true).id : null);
          await interaction.editReply({ embeds: [djCard(settings, lang)] });
          return;
        }
        case 'version': {
          const status = actions.status();
          await interaction.editReply({
            embeds: [note(lang, `jukecord ${status.version}`, `jukecord ${status.version}`)],
          });
          return;
        }
        default:
          // A command from an older registration that this version no longer has.
          await interaction.editReply({
            embeds: [problem(lang === 'ko' ? '지금 판에는 없는 명령' : 'This command no longer exists')],
          });
      }
    } catch (error) {
      await this.fail(interaction, error);
    }
  }

  private async onPlaylist(
    interaction: ChatInputCommandInteraction,
    context: ActionContext,
    lang: Lang,
  ): Promise<void> {
    const actions = this.options.actions;
    const options = interaction.options;
    switch (options.getSubcommand()) {
      case 'list':
        await interaction.editReply({ embeds: [playlistsCard(actions.playlists(context), lang)] });
        return;
      case 'save': {
        const saved = actions.playlistSave(context, options.getString('name', true));
        await interaction.editReply({
          embeds: [note(lang, `Saved "${saved.name}" (${saved.size})`, `"${saved.name}" 저장(${saved.size}곡)`)],
        });
        return;
      }
      case 'load': {
        const result = actions.playlistLoad(context, options.getString('name', true));
        await interaction.editReply({ embeds: [addedCard(result, lang)] });
        await this.autoJoin(interaction, context);
        return;
      }
      case 'rename': {
        const renamed = actions.playlistRename(
          context,
          options.getString('name', true),
          options.getString('new_name', true),
        );
        await interaction.editReply({
          embeds: [note(lang, `Renamed to "${renamed.name}"`, `"${renamed.name}" 로 바꿈`)],
        });
        return;
      }
      case 'delete':
        actions.playlistDelete(context, options.getString('name', true));
        await interaction.editReply({ embeds: [done(lang)] });
        return;
    }
  }

  // The pause, resume and skip buttons on a "now playing" card.
  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const lang = langOf(interaction.locale);
    const context = this.context(interaction);
    if (!context || !interaction.customId.startsWith('jukecord:')) return;
    this.remember(interaction);
    const actions = this.options.actions;
    try {
      const snapshot =
        interaction.customId === 'jukecord:pause'
          ? actions.pause(context)
          : interaction.customId === 'jukecord:resume'
            ? actions.resume(context)
            : actions.skip(context);
      // The card itself is updated in place, so the channel does not fill with copies.
      await interaction.update(nowCard(snapshot, lang, this.options.panelUrl));
    } catch (error) {
      await this.fail(interaction, error);
    }
  }

  // Playlist names as people type them.
  private async onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (!interaction.inGuild()) return;
    const typed = interaction.options.getFocused().toLowerCase();
    const names = this.options.actions
      .playlists({ guildId: interaction.guildId, userId: interaction.user.id, mayControl: false, mayManage: false })
      .map((playlist) => playlist.name)
      .filter((name) => name.toLowerCase().includes(typed))
      .slice(0, 25);
    await interaction.respond(names.map((name) => ({ name, value: name }))).catch(() => {});
  }

  // A failed command: the reason goes to the person who asked only (an ephemeral follow-up keeps the channel clean).
  private async fail(interaction: ChatInputCommandInteraction | ButtonInteraction, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ActionError))
      this.options.log.warn('a command failed', {
        command: interaction.isButton() ? interaction.customId : interaction.commandName,
        error,
      });
    try {
      if (interaction.deferred || interaction.replied) {
        if (interaction.isChatInputCommand()) await interaction.deleteReply().catch(() => {});
        await interaction.followUp({ embeds: [problem(message)], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ embeds: [problem(message)], flags: MessageFlags.Ephemeral });
      }
    } catch {
      // The interaction expired (15 min) or the channel is gone; nothing left to tell.
    }
  }
}

// Discord does not say a person's time zone. Korean users are almost all in Korea (UTC+9); everyone else gets UTC,
// which the card's day boundaries make visible only around midnight.
function offsetOf(locale: string): number {
  return locale.toLowerCase().startsWith('ko') ? 540 : 0;
}
