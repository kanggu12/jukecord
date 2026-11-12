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
  djRoleNow,
  type GuildInfo,
  type MemberInfo,
  type RoleInfo,
} from '../app/actions.ts';
import type { Bus } from '../core/bus.ts';
import { steadyNow } from '../core/clock.ts';
import type { Players } from '../core/players.ts';
import type { Logger } from '../log.ts';
import type { Ffmpeg } from '../media/ffmpeg.ts';
import type { DiscordRepository, SettingsRepository, UserRepository } from '../store/store.ts';
import { parseTimestamp } from '../util/time.ts';
import {
  addedCard,
  djCard,
  historyCard,
  type Lang,
  langOf,
  lyricsCard,
  note,
  nowCard,
  playlistsCard,
  problem,
  queueCard,
  statsCard,
} from './cards.ts';
import { commandDefinitions } from './commands.ts';
import { sayError } from './errors.ts';
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
  // Set by the first login: from then on the server list is known (a reconnect later keeps the list it had).
  private serversKnown = false;

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

  loaded(): boolean {
    return this.serversKnown;
  }

  guilds(): GuildInfo[] {
    return [...this.client.guilds.cache.values()]
      .map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  roles(guildId: string): RoleInfo[] {
    return this.knownRoles(guildId) ?? [];
  }

  /** A server's roles as Discord says now, or null for a server the bot does not see (then nothing is known). */
  knownRoles(guildId: string): RoleInfo[] | null {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return null;
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
  // On the steady clock (core/clock.ts).
  private activitySentAt = Number.NEGATIVE_INFINITY;
  private showActivity(title: string | null): void {
    // "Listening to" is the same line in every server; with more than one it would show one server's track to all.
    this.activity = this.client.guilds.cache.size === 1 ? title : null;
    if (this.activityTimer !== null) return;
    const wait = Math.max(0, this.activitySentAt + 15_000 - steadyNow());
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      this.activitySentAt = steadyNow();
      const name = this.activity;
      this.client.user?.setActivity(name ? { name: name.slice(0, 120), type: ActivityType.Listening } : undefined);
    }, wait);
    this.activityTimer.unref();
  }

  // After a play from Discord, joins the person's voice channel when the bot is not in one yet, as people expect from
  // a music bot. A failure here (no permission, say) does not undo the add; the person can still /join.
  // When the bot cannot join (the person is in no voice channel, or a permission is missing), the person is told,
  // privately: the track is in the queue, but nothing sounds in Discord yet.
  private async autoJoin(interaction: ChatInputCommandInteraction, context: ActionContext, lang: Lang): Promise<void> {
    if (!interaction.inCachedGuild() || this.voice.channel(context.guildId)) return;
    let reason: string;
    if (!interaction.guild.voiceStates.cache.get(interaction.user.id)?.channelId) {
      reason =
        lang === 'ko'
          ? '봇이 음성 채널에 없음: 음성 채널에 들어가 /참가'
          : 'The bot is not in a voice channel: join one and use /join';
    } else {
      try {
        await this.options.actions.join(context, null);
        return;
      } catch (error) {
        this.options.log.debug('could not join the voice channel after a play', { error });
        reason = sayError(error instanceof Error ? error.message : String(error), lang);
      }
    }
    await interaction.followUp({ embeds: [note(lang, reason, reason)], flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  /** Whether the bot is logged in and receiving events. */
  ready(): boolean {
    return this.client.isReady();
  }

  /** Logs in and starts answering. Resolves once logged in; registration of commands follows in the background. */
  async start(): Promise<void> {
    const log = this.options.log;
    this.client.once(Events.ClientReady, (client) => {
      this.serversKnown = true;
      log.info('logged in to Discord', { as: client.user.tag, servers: client.guilds.cache.size });
      for (const guild of client.guilds.cache.values()) void this.register(guild);
    });
    // A server that adds the bot later gets the commands at once.
    this.client.on(Events.GuildCreate, (guild) => void this.register(guild));
    // A server that removes the bot (an outage comes as GuildUnavailable instead, and needs nothing).
    this.client.on(Events.GuildDelete, (guild) => this.removed(guild.id));
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

  /**
   * The bot was removed from a server (kicked, or the server deleted). Its player stops, so nothing is fetched for a
   * server nobody can reach any more; the bot is out of its voice channel; and the commands are registered again if
   * the server adds the bot back: Discord removed them with the bot, and the stored fingerprint would say they are
   * there. The queue, the history and the playlists stay, for that day.
   */
  removed(guildId: string): void {
    this.options.log.info('removed from a server', { guild: guildId });
    this.options.discord.clearCommandsHash(guildId);
    this.voice.leave(guildId);
    this.options.players.existing(guildId)?.stop();
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

  // Who is asking and whether they may change the music: everyone, unless the server set a DJ role (one deleted in
  // Discord since counts as none, see djRoleNow). People who can manage the server always may.
  private context(interaction: ChatInputCommandInteraction | ButtonInteraction): ActionContext | null {
    if (!interaction.inGuild()) return null;
    const role = djRoleNow(
      this.options.settings.get(interaction.guildId).djRoleId,
      this.knownRoles(interaction.guildId),
    );
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
      // Lookups can take seconds; answer "thinking" first so Discord does not time the command out (3 s). Commands
      // that only look something up answer the person alone, so the channel keeps the music, not the questions.
      const sub = interaction.options.getSubcommand(false);
      const lookup =
        ['version', 'queue'].includes(interaction.commandName) ||
        (interaction.commandName === 'dj' && sub === 'show') ||
        (interaction.commandName === 'playlist' && sub === 'list');
      await interaction.deferReply(lookup ? { flags: MessageFlags.Ephemeral } : {});
      switch (interaction.commandName) {
        case 'add': {
          const at = options.getString('where') === 'next' ? 'next' : 'end';
          const result = await actions.add(context, options.getString('input', true), at);
          await interaction.editReply({ embeds: [addedCard(result, lang)] });
          await this.autoJoin(interaction, context, lang);
          return;
        }
        case 'play': {
          const result = await actions.playNow(context, options.getString('input', true));
          await interaction.editReply({ embeds: [addedCard(result, lang, true)] });
          await this.autoJoin(interaction, context, lang);
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
          await interaction.editReply({
            embeds: [note(lang, 'Stopped (the queue stays)', '재생 멈춤(대기열은 그대로)')],
          });
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
          const title = item.track.title;
          await interaction.editReply({ embeds: [note(lang, `Removed "${title}"`, `"${title}" 뺌`)] });
          return;
        }
        case 'move': {
          const items = actions.queue(context).items;
          const item = items[options.getInteger('from', true) - 1];
          if (!item) throw new ActionError('not-found', 'there is no track with that number in the queue');
          const to = Math.min(options.getInteger('to', true), items.length);
          actions.move(context, item.id, to - 1);
          const title = item.track.title;
          await interaction.editReply({
            embeds: [note(lang, `Moved "${title}" to ${to}`, `"${title}" ${to}번으로 옮김`)],
          });
          return;
        }
        case 'jump': {
          const item = actions.queue(context).items[options.getInteger('position', true) - 1];
          if (!item) throw new ActionError('not-found', 'there is no track with that number in the queue');
          await interaction.editReply(nowCard(actions.jump(context, item.id), lang, this.options.panelUrl));
          return;
        }
        case 'shuffle':
          actions.shuffle(context);
          await interaction.editReply({ embeds: [note(lang, 'Shuffled the queue', '대기열 섞음')] });
          return;
        case 'dedupe': {
          const removed = actions.dedupe(context);
          await interaction.editReply({
            embeds: [
              removed === 0
                ? note(lang, 'No duplicates', '중복 없음')
                : note(
                    lang,
                    removed === 1 ? 'Removed 1 duplicate' : `Removed ${removed} duplicates`,
                    `중복 ${removed}곡 뺌`,
                  ),
            ],
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
          await interaction.editReply({ embeds: [note(lang, `Joined ${joined.name}`, `${joined.name}에 들어옴`)] });
          return;
        }
        case 'leave': {
          // The channel's name, read before leaving it.
          const left = this.voice.channel(context.guildId)?.name ?? '';
          actions.leave(context);
          await interaction.editReply({ embeds: [note(lang, `Left ${left}`, `${left}에서 나감`)] });
          return;
        }
        case 'listen':
          await interaction.editReply({
            embeds: [
              this.options.panelUrl
                ? note(lang, `Listen along: ${this.options.panelUrl}`, `같이 듣기: ${this.options.panelUrl}`)
                : note(lang, 'The panel has no address people can open', '아직 열 수 있는 패널 주소가 없음'),
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
        case 'lyrics': {
          // The title of the track the lyrics are for: the action takes the track playing as it is called.
          const title = actions.nowPlaying(context).track?.title ?? '';
          const lyrics = await actions.lyrics(context);
          await interaction.editReply({ embeds: [lyricsCard(lyrics, title, options.getInteger('page') ?? 1, lang)] });
          return;
        }
        default:
          // A command from an older registration that this version no longer has.
          await interaction.editReply({
            embeds: [problem(lang === 'ko' ? '없어진 명령' : 'This command no longer exists')],
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
        await this.autoJoin(interaction, context, lang);
        return;
      }
      case 'rename': {
        const renamed = actions.playlistRename(
          context,
          options.getString('name', true),
          options.getString('new_name', true),
        );
        await interaction.editReply({
          embeds: [note(lang, `Renamed to "${renamed.name}"`, `새 이름: "${renamed.name}"`)],
        });
        return;
      }
      case 'delete': {
        const name = options.getString('name', true);
        actions.playlistDelete(context, name);
        await interaction.editReply({ embeds: [note(lang, `Deleted "${name}"`, `"${name}" 지움`)] });
        return;
      }
    }
  }

  // The pause, resume and skip buttons on a "now playing" card.
  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const context = this.context(interaction);
    if (!context || !interaction.customId.startsWith('jukecord:')) return;
    this.remember(interaction);
    const actions = this.options.actions;
    // "jukecord:pause:ko": the action, and the language the card was made in (older cards have none: the presser's).
    const [, action, made] = interaction.customId.split(':');
    const cardLang: Lang = made === 'ko' || made === 'en' ? made : langOf(interaction.locale);
    try {
      const snapshot =
        action === 'pause'
          ? actions.pause(context)
          : action === 'resume'
            ? actions.resume(context)
            : actions.skip(context);
      // The card itself is updated in place, so the channel does not fill with copies.
      await interaction.update(nowCard(snapshot, cardLang, this.options.panelUrl));
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
    const lang = langOf(interaction.locale);
    // A refusal from the actions, in the person's language; anything else is jukecord's own fault, logged in full
    // and shown as one plain line.
    const message =
      error instanceof ActionError
        ? sayError(error.message, lang)
        : lang === 'ko'
          ? '문제가 생김: 이유는 jukecord 로그에'
          : 'Something went wrong: the reason is in the log';
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
