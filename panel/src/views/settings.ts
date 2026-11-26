/**
 * The host's settings page: every jukecord setting, group by group as jukecord's table orders them, each with what it
 * is, its value in a control of its kind, where the value comes from (its default, saved here, or the environment,
 * which wins and locks it) and when a change applies. Each section saves on its own, after a summary of what it
 * changes; a restart that changes wait for has its bar and key at the top. The addresses of the shared cache and the
 * bus and each way of logging in can be tried before saving; the database moves through a dialog of pages
 * (views/move.ts). The host's alone: the API refuses everyone else, and the panel offers the page to the host only.
 *
 * The page is drawn whole when the settings are read (at the start, after a save, a restart, a language change); a
 * control keeps its own state while it is used, so typing never redraws what is typed into.
 */
import { sayError } from '../../../src/core/say.ts';
import {
  ApiError,
  api,
  type BothWords,
  type HostSetting,
  type HostSettingsView,
  type LoginTest,
  type ServerTest,
  type ServiceInfo,
} from '../api.ts';
import { fill, h, icon } from '../dom.ts';
import type { IconName } from '../icons.ts';
import { state, t, watch } from '../state.ts';
import { lengthText, rounded } from '../time.ts';
import { confirmDialog, foundText, messageOf, problem, toast } from '../ui/layers.ts';
import { moveWizard, waitForRestart } from './move.ts';

// A setting's words in the language in use.
const say = (words: BothWords): string => words[state.lang];

// The secrets whose way somewhere other settings say: a change of any of these without the secret typed again is
// refused (a saved secret is never sent to a new place), so the page asks for the secret as soon as one changes.
const SECRET_WAYS: readonly { secret: string; to: readonly string[] }[] = [
  {
    secret: 'JUKECORD_LDAP_BIND_PASSWORD',
    to: ['JUKECORD_LDAP_URL', 'JUKECORD_LDAP_STARTTLS', 'JUKECORD_LDAP_CA_FILE', 'JUKECORD_LDAP_BIND_DN'],
  },
  { secret: 'JUKECORD_OIDC_CLIENT_SECRET', to: ['JUKECORD_OIDC_ISSUER', 'JUKECORD_OIDC_CLIENT_ID'] },
];

// The settings outside the Discord login's own part that its test takes from the page (its return address).
const DISCORD_LOGIN_TOO = ['JUKECORD_PUBLIC_URL', 'JUKECORD_PUBLISHED_PORT'];

// Each way of logging in's test, by its part of the Logins group.
const LOGIN_TESTS: Readonly<Record<string, (values: Record<string, string>, name: string) => Promise<LoginTest>>> = {
  'discord-login': (values) => api['auth-test-discord'](values),
  sso: (values) => api['auth-test-oidc'](values),
  directory: (values, name) => api['auth-test-ldap'](values, name || undefined),
};

// The addresses that can be tried before they are saved, and the test of each.
const SERVER_TESTS: Readonly<Record<string, (url: string) => Promise<ServerTest>>> = {
  JUKECORD_CACHE_URL: (url) => api['settings-test-cache'](url),
  JUKECORD_BUS_URL: (url) => api['settings-test-bus'](url),
};

/** A control of one setting: its element, and what it holds now (undefined: what is saved, untouched). */
interface Control {
  readonly element: HTMLElement;
  /** Puts the control back to the setting as it is (Undo). */
  reset(): void;
}

/** The host's settings page. */
export function settingsPage(): HTMLElement {
  // The settings as last read, the changes typed and not saved yet (null: back to the default), and each setting's
  // problem from the last save that refused it.
  let view: HostSettingsView | null = null;
  const edits = new Map<string, string | null>();
  const problems = new Map<string, string>();
  // The rows and controls as drawn, by setting, and each section's foot (its count and keys), by section.
  const rows = new Map<string, { row: HTMLElement; state: HTMLElement; problem: HTMLElement; control: Control }>();
  const foots = new Map<string, () => void>();
  // A restart asked for and not answered yet: the bar says so instead of offering it again.
  let restarting = false;

  const title = h('h1');
  const bar = h('section', { class: 'card restart-bar', hidden: true, role: 'status' });
  const index = h('nav', { class: 'settings-index' });
  const cards = h('div', { class: 'settings-cards' });
  const page = h(
    'main',
    { class: 'page settings-page' },
    h('div', { class: 'page-head' }, title),
    bar,
    h('div', { class: 'settings-layout' }, index, cards),
  );

  // The settings read again, and the page drawn from them; a failure is said, and the page keeps what it showed.
  const load = async (): Promise<void> => {
    try {
      view = await api['host-settings']();
    } catch (error) {
      problem(error);
      return;
    }
    draw();
  };

  // A setting's section: its part of the logins, or its group.
  const sectionOf = (setting: HostSetting): string => setting.part ?? setting.group;
  // The settings of a section, as the page shows them.
  const settingsOf = (section: string): HostSetting[] =>
    (view?.settings ?? []).filter((setting) => sectionOf(setting) === section);

  // The whole page from the settings read. What was typed and not saved goes (the page shows what is saved now): a
  // change kept with no control showing it would be saved unseen with its section.
  const draw = (): void => {
    const words = t();
    title.textContent = words.settings;
    rows.clear();
    foots.clear();
    edits.clear();
    problems.clear();
    if (!view) return;
    const shown = view;
    // The Services group only where there are services: a split jukecord's core and edges.
    const groups = shown.groups.filter((group) => group.id !== 'services' || shown.role !== 'all');
    index.setAttribute('aria-label', words.setSections);
    fill(
      index,
      ...groups.map((group) => {
        const link = h('button', { class: 'choice index-link', type: 'button' }, say(group.label));
        // Scrolled to, not linked: a change of the address would draw the page anew and drop what is typed.
        link.onclick = () => document.getElementById(`settings-${group.id}`)?.scrollIntoView({ block: 'start' });
        return link;
      }),
    );
    fill(cards, ...groups.map((group) => groupCard(group.id, say(group.label), group.parts ?? [])));
    drawBar();
  };

  // One group's card: its rows, its parts when it has some (each saved and tested apart), its foot.
  const groupCard = (group: string, label: string, parts: readonly { id: string; label: BothWords }[]) => {
    const head = h('div', { class: 'card-head' }, h('h2', { id: `settings-${group}-h` }, label));
    const card = h('section', {
      class: 'card settings-card',
      id: `settings-${group}`,
      'aria-labelledby': `settings-${group}-h`,
      // A group in parts saves part by part: the card is no section of its own then.
      ...(parts.length > 0 ? {} : { dataset: { section: group } }),
    });
    if (parts.length > 0) {
      fill(card, head, ...parts.map((part) => partBlock(part.id, say(part.label))));
      return card;
    }
    // The database's card has its move; the services' card its list of services above the settings that say them.
    fill(
      card,
      head,
      group === 'database' ? databaseRow() : null,
      group === 'services' ? servicesList() : null,
      h(
        'div',
        { class: 'setting-list' },
        // The database's address is its row above, changed by the move (a new address alone would leave the data).
        ...settingsOf(group)
          .filter((setting) => setting.name !== 'JUKECORD_DATABASE_URL')
          .map((setting) => settingRow(setting)),
      ),
      foot(group, label),
    );
    return card;
  };

  // A part of the logins: its title with its test, what the test found, its rows and its own foot.
  const partBlock = (part: string, label: string): HTMLElement => {
    const words = t();
    const found = h('div', { class: 'test-found', hidden: true, 'aria-live': 'polite' });
    const test = h('button', { class: 'key', type: 'button', dataset: { key: `test-${part}` } }, words.setTest);
    // The directory's test may look a person up by name (their groups and the level those give).
    const name =
      part === 'directory'
        ? h('input', {
            type: 'text',
            autocomplete: 'off',
            spellcheck: 'false',
            placeholder: words.setTestName,
            'aria-label': words.setTestName,
          })
        : null;
    test.onclick = async () => {
      const values: Record<string, string> = {};
      // What the part's rows hold now, saved or not (the Discord login's return address is the server's settings).
      for (const setting of view?.settings ?? []) {
        if (sectionOf(setting) !== part && !(part === 'discord-login' && DISCORD_LOGIN_TOO.includes(setting.name)))
          continue;
        const edit = edits.get(setting.name);
        if (edit !== undefined) values[setting.name] = edit ?? '';
      }
      await busy(test, words.setTesting, async () => {
        try {
          const result = await (LOGIN_TESTS[part] ?? LOGIN_TESTS.sso)?.(values, name?.value.trim() ?? '');
          if (result) showChecks(found, result);
        } catch (error) {
          showFailure(found, error);
        }
      });
    };
    const head = h(
      'div',
      { class: 'part-head' },
      h('h3', { id: `settings-${part}-h` }, label),
      h('div', { class: 'part-tools' }, name ? h('label', { class: 'field' }, name) : null, test),
    );
    return h(
      'div',
      {
        class: 'setting-part',
        id: `settings-${part}`,
        role: 'group',
        'aria-labelledby': `settings-${part}-h`,
        dataset: { section: part },
      },
      head,
      found,
      h('div', { class: 'setting-list' }, ...settingsOf(part).map((setting) => settingRow(setting))),
      foot(part, label),
    );
  };

  // A section's foot: how many changes it holds, Undo and Save (both off while it holds none). None where nothing can
  // be changed here (every setting set by the environment, a split's services).
  const foot = (section: string, label: string): HTMLElement | null => {
    const words = t();
    if (settingsOf(section).every((setting) => setting.locked !== null)) return null;
    const count = h('span', { class: 'faint' });
    const undo = h('button', { class: 'key', type: 'button' }, words.setUndo);
    const save = h(
      'button',
      { class: 'key primary save-key', type: 'button', dataset: { key: `save-${section}` } },
      icon('save'),
      words.save,
    );
    const names = () => settingsOf(section).map((setting) => setting.name);
    // Shown while the section holds a change: a card of settings as they are has nothing to save (a pair of keys off
    // under every card said nothing).
    const element = h('div', { class: 'settings-foot' }, count, undo, save);
    const refresh = () => {
      const changes = names().filter((name) => edits.has(name)).length;
      count.textContent = changes > 0 ? words.setEdits(changes) : '';
      element.hidden = changes === 0;
    };
    undo.onclick = () => {
      for (const name of names()) {
        edits.delete(name);
        problems.delete(name);
        rows.get(name)?.control.reset();
        drawRow(name);
      }
      refresh();
    };
    save.onclick = () => void saveSection(section, label);
    foots.set(section, refresh);
    refresh();
    return element;
  };

  // Saves a section's changes after a summary of them: all or nothing, each problem said at its setting.
  const saveSection = async (section: string, label: string): Promise<void> => {
    const words = t();
    const settings = settingsOf(section).filter((setting) => edits.has(setting.name));
    if (settings.length === 0 || !view) return;
    const values = Object.fromEntries(settings.map((setting) => [setting.name, edits.get(setting.name) ?? null]));
    // What each would become, as the summary shows it: a secret only as new or removed.
    const summary = h(
      'ul',
      { class: 'change-list' },
      ...settings.map((setting) => {
        const next = edits.get(setting.name) ?? null;
        const shownNext = setting.secret
          ? next === null
            ? words.setSecretGone
            : words.setSecretNew
          : (next ?? setting.default ?? words.setNone);
        return h(
          'li',
          null,
          h('span', { class: 'change-name' }, say(setting.label)),
          h('span', { class: 'change-to', title: shownNext, 'data-clip': 'ok' }, shownNext),
          h('span', { class: 'faint' }, setting.applies === 'now' ? words.setSaveNow : words.setSaveLater),
        );
      }),
    );
    if (!(await confirmDialog({ title: words.setSaveTitle(label), content: summary, ok: words.save }))) return;
    // The revisions read, so a change made meanwhile elsewhere is not overwritten unseen.
    const revisions = Object.fromEntries(settings.map((setting) => [setting.name, setting.revision]));
    try {
      const answer = await api['host-settings-change'](values, revisions);
      for (const setting of settings) {
        edits.delete(setting.name);
        problems.delete(setting.name);
      }
      view = answer.view;
      const later = answer.changed.filter((change) => change.applies === 'restart').length;
      toast(
        answer.changed.length === 0
          ? words.setNothing
          : later > 0
            ? words.setDoneLater(later)
            : words.setDone(answer.changed.length),
      );
      redraw(section);
    } catch (error) {
      // Each problem at its settings, and once in a toast; a change made meanwhile is read again first.
      if (error instanceof ApiError && error.code === 'conflict') {
        toast(words.setChangedElsewhere, 'pause', 'circle-alert');
        await load();
      } else if (error instanceof ApiError && error.problems.length > 0) {
        for (const found of error.problems)
          for (const name of found.names) problems.set(name, sayError(found.message, state.lang));
        for (const setting of settings) drawRow(setting.name);
        problem(error);
      } else problem(error);
    }
    // The keyboard back on the section's Save key, drawn anew.
    cards.querySelector<HTMLElement>(`[data-key="save-${section}"]`)?.focus();
  };

  // The settings read again for one section (after the move's dialog), the others' typing kept.
  const reread = async (section: string): Promise<void> => {
    try {
      view = await api['host-settings']();
    } catch (error) {
      problem(error);
      return;
    }
    redraw(section);
  };

  // A section drawn anew after its save, from the settings saved; the other sections keep what is typed in them, their
  // rows' states read again (a change of the port makes the published port wait for a restart too), and the bar.
  const redraw = (section: string): void => {
    const old = cards.querySelector<HTMLElement>(`[data-section="${CSS.escape(section)}"]`);
    const group = view?.groups.find((item) => item.id === section);
    const part = view?.groups.flatMap((item) => item.parts ?? []).find((item) => item.id === section);
    if (!old || !(group || part)) {
      draw();
      return;
    }
    old.replaceWith(
      part ? partBlock(part.id, say(part.label)) : groupCard(section, say(group?.label ?? { en: '', ko: '' }), []),
    );
    for (const name of rows.keys()) drawRow(name);
    drawBar();
  };

  // One setting's row: its label, what it is, its state line and its problem, beside its control.
  const settingRow = (setting: HostSetting): HTMLElement => {
    const id = `setting-${setting.name}`;
    const stateLine = h('p', { class: 'setting-state' });
    const problemLine = h('p', { class: 'setting-problem', hidden: true });
    const control = controlOf(setting, id, (text) => {
      // Back to what is saved: no change; anything else is one.
      if (text === undefined) edits.delete(setting.name);
      else edits.set(setting.name, text);
      problems.delete(setting.name);
      drawRow(setting.name);
      askForSecrets();
      foots.get(sectionOf(setting))?.();
    });
    const row = h(
      'div',
      { class: 'setting', dataset: { name: setting.name } },
      h(
        'div',
        { class: 'setting-text' },
        h('div', { class: 'setting-name' }, nameOf(setting, id)),
        h('p', { class: 'setting-help' }, say(setting.help)),
        stateLine,
        problemLine,
      ),
      h('div', { class: 'setting-control' }, control.element),
    );
    rows.set(setting.name, { row, state: stateLine, problem: problemLine, control });
    drawRow(setting.name);
    return row;
  };

  // A row's state line and problem, from the setting and what is typed in it.
  const drawRow = (name: string): void => {
    const drawn = rows.get(name);
    const setting = view?.settings.find((item) => item.name === name);
    if (!drawn || !setting) return;
    const words = t();
    const parts: (string | Node)[] = [];
    let tone = '';
    let mark: IconName | null = null;
    if (setting.locked) {
      // Locked: where it is set instead, with the lock.
      mark = 'lock';
      parts.push(
        setting.locked === 'environment'
          ? words.setByEnv(setting.variable ?? setting.name)
          : setting.locked === 'split'
            ? words.setBySplit
            : words.setAtStart,
      );
    } else if (edits.get(name) === null) {
      // Put back and not saved yet: what saving does.
      parts.push(setting.secret ? words.setRemoved : words.setToDefault);
    } else if (edits.has(name)) {
      // Changed and not saved yet: said in words (a coloured mark at the row's edge said it in a border's colour).
      parts.push(words.setUnsaved);
    }
    if (!setting.locked && !edits.has(name)) parts.push(setting.source === 'saved' ? words.setSaved : words.setDefault);
    // Its limits and its default, when it has them and is not a secret.
    if (!setting.secret && !setting.locked) {
      const limits =
        setting.min && setting.max
          ? words.setRange(setting.min, setting.max)
          : setting.min
            ? words.setFrom(setting.min)
            : null;
      if (limits) parts.push(limits);
      if (setting.source === 'saved' && setting.default !== null && setting.kind !== 'boolean')
        parts.push(words.setDefaultIs(setting.default));
      else if (setting.source === 'saved' && setting.defaultNote) parts.push(say(setting.defaultNote));
    }
    parts.push(setting.applies === 'now' ? words.setNow : words.setAfterRestart);
    // Waiting for a restart: the value in use until then (a secret's never).
    if (setting.pending) {
      tone = 'tone-pause';
      mark = 'rotate-ccw';
      parts.unshift(
        setting.running && !setting.secret ? `${words.setWaits}, ${words.setInUse(setting.running)}` : words.setWaits,
      );
    }
    if (setting.refused) {
      tone = 'tone-bad';
      mark = 'circle-alert';
      parts.unshift(words.setRefused(foundText(setting.refused)));
    }
    drawn.state.className = `setting-state ${tone}`.trim();
    // Each part kept with the dot after it, so a line never starts with one.
    fill(drawn.state, mark ? icon(mark) : null, h('span', null, parts.join('\u00a0· ')));
    const said = problems.get(name);
    drawn.problem.hidden = !said;
    fill(drawn.problem, said ? icon('circle-alert') : null, said ? h('span', null, said) : null);
  };

  // A secret whose way changes and that is saved: its field opened, saying it must be typed again (see SECRET_WAYS).
  const askForSecrets = (): void => {
    for (const { secret, to } of SECRET_WAYS) {
      const setting = view?.settings.find((item) => item.name === secret);
      const drawn = rows.get(secret);
      if (!setting || !drawn || setting.locked || !setting.set || edits.has(secret)) continue;
      const moving = to.some((name) => {
        const edit = edits.get(name);
        return edit !== undefined && edit !== null;
      });
      if (!moving) continue;
      problems.set(secret, t().setRetype);
      drawRow(secret);
    }
  };

  // The control of a setting, by its kind; locked, its value as words.
  const controlOf = (setting: HostSetting, id: string, changed: (text: string | null | undefined) => void): Control => {
    if (setting.locked) return lockedValue(setting, id);
    if (setting.secret) return secretControl(setting, id, changed);
    switch (setting.kind) {
      case 'boolean':
        return switchControl(setting, id, changed);
      case 'choice':
        return choiceControl(setting, id, changed);
      case 'duration':
      case 'size':
        return amountControl(setting, id, changed);
      case 'time':
        return timeControl(setting, id, changed);
      case 'list':
        return setting.choices ? listChoiceControl(setting, id, changed) : textControl(setting, id, changed);
      default:
        return textControl(setting, id, changed);
    }
  };

  // The database's address and its move: what is in use, and the key to the move's dialog (or the move under way).
  const databaseRow = (): HTMLElement | null => {
    const shown = view;
    const setting = shown?.settings.find((item) => item.name === 'JUKECORD_DATABASE_URL');
    if (!shown || !setting) return null;
    const words = t();
    const move = shown.move.state;
    const key = h(
      'button',
      { class: 'key', type: 'button', dataset: { key: 'move' } },
      icon('database'),
      move ? words.moveOpen : words.move,
    );
    key.hidden = setting.locked !== null;
    key.onclick = () => moveWizard(shown, () => void reread('database'));
    const failure = shown.move.lastFailure;
    return h(
      'div',
      { class: 'setting database-now' },
      h(
        'div',
        { class: 'setting-text' },
        h('div', { class: 'setting-name' }, h('span', null, say(setting.label))),
        // The database in use, as it says itself (never its user or password), in the place of what the setting is.
        h('p', { class: 'setting-help' }, foundText(setting.shown ?? '')),
        h(
          'p',
          { class: 'setting-state' },
          ...(setting.locked
            ? [
                icon('lock'),
                h(
                  'span',
                  null,
                  setting.locked === 'environment'
                    ? words.setByEnv(setting.variable ?? setting.name)
                    : words.setBySplit,
                ),
              ]
            : [h('span', null, move ? `${words.moveUnderWay} · ${move.where}` : words.setDatabaseNow)]),
        ),
        failure
          ? h(
              'p',
              { class: 'setting-problem' },
              icon('circle-alert'),
              h('span', null, words.moveLastFailed(failure.where, foundText(failure.reason))),
            )
          : null,
      ),
      h('div', { class: 'setting-control' }, key),
    );
  };

  // The services of a split jukecord: the core and each edge, with their version, how long they have run and whether
  // they are ready.
  const servicesList = (): HTMLElement | null => {
    const services = view?.services ?? [];
    if (services.length === 0) return null;
    const words = t();
    return h(
      'ul',
      { class: 'service-list', 'aria-label': words.setServices },
      ...services.map((service: ServiceInfo) =>
        h(
          'li',
          { class: 'service' },
          h('span', { class: `dot ${service.ready ? 'tone-play' : 'tone-bad'}`, 'aria-hidden': 'true' }),
          h('b', null, service.role === 'core' ? words.setCore : words.setEdge),
          h('span', { class: 'faint service-name', title: service.name, 'data-clip': 'ok' }, service.name),
          h('span', { class: 'muted' }, `v${service.version}`),
          service.startedAt
            ? h(
                'span',
                { class: 'muted' },
                words.setUp(lengthText(rounded(Date.now() - service.startedAt), state.lang)),
              )
            : null,
          h(
            'span',
            { class: service.ready ? 'muted' : 'text-bad' },
            service.ready ? words.setReady : words.setNotReady,
          ),
        ),
      ),
    );
  };

  // The bar at the top: the changes that wait for a restart, and the key that restarts (or why it cannot here).
  const drawBar = (): void => {
    const words = t();
    const pending = view?.restart.pending ?? [];
    bar.hidden = pending.length === 0 && !restarting;
    if (bar.hidden || !view) return;
    const names = pending
      .map((name) => view?.settings.find((setting) => setting.name === name))
      .filter((setting): setting is HostSetting => Boolean(setting))
      .map((setting) => say(setting.label));
    const key = h(
      'button',
      { class: 'key primary', type: 'button', dataset: { key: 'restart' } },
      icon(restarting ? 'loader-circle' : 'rotate-ccw', restarting ? 'spin' : ''),
      restarting ? words.setRestarting : words.setRestart,
    );
    key.disabled = restarting;
    key.hidden = view.restart.refusal !== null;
    key.onclick = () => void restart();
    fill(
      bar,
      icon('rotate-ccw', 'bar-mark'),
      h(
        'div',
        { class: 'restart-words' },
        h('b', null, words.setWaiting(pending.length)),
        h(
          'p',
          { class: 'restart-names faint' },
          view.restart.refusal ? sayError(view.restart.refusal, state.lang) : names.join(', '),
        ),
      ),
      key,
    );
  };

  // A restart, asked for after the question: the bar says so until jukecord answers again, then the page reads anew.
  const restart = async (): Promise<void> => {
    const words = t();
    const who = view ? (words.supervisors[view.restart.supervisor] ?? view.restart.supervisor) : '';
    if (!(await confirmDialog({ title: words.setRestartTitle, text: words.setRestartText(who), ok: words.setRestart })))
      return;
    const asked = Date.now();
    try {
      await api.restart();
    } catch (error) {
      problem(error);
      return;
    }
    restarting = true;
    drawBar();
    const back = await waitForRestart(asked, () => page.isConnected);
    restarting = false;
    if (!page.isConnected) return;
    if (back) {
      toast(words.setRestarted);
      await load();
    } else {
      drawBar();
      toast(words.setStillDown, 'bad', 'circle-alert');
    }
  };

  // ---- the controls ----

  // A locked setting: its value as words (a secret as set or not), nothing to change.
  function lockedValue(setting: HostSetting, id: string): Control {
    const words = t();
    const text = setting.secret
      ? (setting.shown ?? (setting.set ? words.setIsSet : words.setNotSet))
      : (setting.value ?? (setting.defaultNote ? say(setting.defaultNote) : words.setNone));
    const element = h('span', { class: 'setting-value', id, title: text, 'data-clip': 'ok' }, text);
    // A locked address of the cache or the bus may still be tried (another one, before the environment changes).
    const test = SERVER_TESTS[setting.name];
    if (!test) return { element, reset: () => {} };
    return { element: h('div', { class: 'control-row' }, element, tryAnother(setting, test)), reset: () => {} };
  }

  // A key that opens a field to try an address with, which is never saved.
  function tryAnother(setting: HostSetting, test: (url: string) => Promise<ServerTest>): HTMLElement {
    const words = t();
    const key = h('button', { class: 'key', type: 'button' }, words.setTestAnother);
    key.onclick = () => {
      const input = h('input', {
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: setting.default ?? 'redis://valkey:6379',
        'aria-label': `${say(setting.label)}: ${words.setTestAnother}`,
      });
      const go = h('button', { class: 'key', type: 'button' }, words.setTest);
      const found = h('p', { class: 'setting-found', hidden: true, 'aria-live': 'polite' });
      go.onclick = () => void tryServer(go, found, () => input.value.trim(), test);
      key.replaceWith(h('div', { class: 'control-row' }, h('label', { class: 'field' }, input), go));
      rows.get(setting.name)?.row.querySelector('.setting-text')?.append(found);
      input.focus();
    };
    return key;
  }

  // A secret: set or not, Change opens a field for a new one, Remove puts it away (saved ones only).
  function secretControl(
    setting: HostSetting,
    id: string,
    changed: (text: string | null | undefined) => void,
  ): Control {
    const words = t();
    const box = h('div', { class: 'control-row' });
    const test = SERVER_TESTS[setting.name];
    // What a test of the address typed found, under the setting's words: one line, hidden while the field is closed.
    const found = h('p', { class: 'setting-found', hidden: true, 'aria-live': 'polite' });
    const closed = () => {
      found.hidden = true;
      const status = h(
        'span',
        { class: 'setting-value', id, title: setting.shown ?? '', 'data-clip': 'ok' },
        setting.shown ?? (setting.set ? words.setIsSet : words.setNotSet),
      );
      const change = h('button', { class: 'key', type: 'button' }, words.setChange);
      change.onclick = () => opened();
      const remove = h('button', { class: 'key', type: 'button' }, words.setRemove);
      remove.hidden = !(setting.set && setting.source === 'saved');
      remove.onclick = () => {
        changed(null);
        // Not set once saved; the state line says that saving removes it.
        status.textContent = words.setNotSet;
        remove.hidden = true;
      };
      fill(box, status, change, remove);
    };
    const opened = () => {
      // An address with a password in it is read as it is typed; a password or a token is not shown.
      const input = h('input', {
        type: setting.kind === 'url' ? 'text' : 'password',
        id,
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: setting.kind === 'url' ? (setting.default ?? '') : '',
        'aria-label': say(setting.label),
      });
      input.oninput = () => changed(input.value.trim() === '' ? undefined : input.value);
      const keep = h('button', { class: 'key', type: 'button' }, words.setKeep);
      keep.onclick = () => {
        changed(undefined);
        closed();
      };
      const go = test ? h('button', { class: 'key', type: 'button' }, words.setTest) : null;
      if (go && test) {
        if (!found.isConnected) rows.get(setting.name)?.row.querySelector('.setting-text')?.append(found);
        go.onclick = () => void tryServer(go, found, () => input.value.trim(), test);
      }
      fill(box, h('label', { class: 'field' }, input), go, keep);
      input.focus();
    };
    closed();
    return { element: box, reset: closed };
  }

  // Tries an address and says what answered there, or why it cannot be used.
  async function tryServer(
    key: HTMLButtonElement,
    found: HTMLElement,
    url: () => string,
    test: (url: string) => Promise<ServerTest>,
  ): Promise<void> {
    const words = t();
    const address = url();
    if (!address) return;
    await busy(key, words.setTesting, async () => {
      try {
        const result = await test(address);
        found.hidden = false;
        found.className = `setting-found ${result.ok ? '' : 'tone-bad'}`.trim();
        const text = result.ok
          ? result.where === 'memory'
            ? words.setTestedMemory
            : words.setTestedServer(result.server ?? result.where, result.roundTripMs ?? 0)
          : foundText(result.problem ?? '');
        fill(found, icon(result.ok ? 'check' : 'circle-alert'), h('span', null, text));
      } catch (error) {
        showFailure(found, error);
      }
    });
  }

  // Yes or no.
  function switchControl(
    setting: HostSetting,
    id: string,
    changed: (text: string | null | undefined) => void,
  ): Control {
    const [yes = 'true', no = 'false'] = setting.words ?? [];
    const isOn = (text: string | null) => (text ?? setting.default ?? no).toLowerCase() === yes.toLowerCase();
    const toggle = h('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      id,
      'aria-label': say(setting.label),
    });
    const show = (on: boolean) => toggle.setAttribute('aria-checked', String(on));
    toggle.onclick = () => {
      const on = toggle.getAttribute('aria-checked') !== 'true';
      show(on);
      // Back where it was saved: no change.
      changed(on === isOn(setting.value) ? undefined : on ? yes : no);
    };
    show(isOn(setting.value));
    return { element: toggle, reset: () => show(isOn(setting.value)) };
  }

  // One of a few words.
  function choiceControl(
    setting: HostSetting,
    id: string,
    changed: (text: string | null | undefined) => void,
  ): Control {
    const current = setting.value ?? setting.default ?? '';
    const row = h('div', { class: 'seg', role: 'group', id, 'aria-label': say(setting.label) });
    const show = (chosen: string) => {
      for (const button of row.children) button.setAttribute('aria-pressed', String(button.textContent === chosen));
    };
    for (const choice of setting.choices ?? []) {
      const button = h('button', { type: 'button' }, choice);
      button.onclick = () => {
        show(choice);
        changed(choice === current ? undefined : choice);
      };
      row.append(button);
    }
    show(current);
    return { element: row, reset: () => show(current) };
  }

  // A list that takes some of a few words (the link services): each word on or off; none is the list's "off" word.
  function listChoiceControl(
    setting: HostSetting,
    id: string,
    changed: (text: string | null | undefined) => void,
  ): Control {
    const separator = setting.separator ?? ',';
    const itemsOf = (text: string | null) =>
      (text ?? '')
        .split(separator)
        .map((item) => item.trim())
        .filter((item) => item && item !== setting.off);
    const current = itemsOf(setting.value);
    const row = h('div', { class: 'seg', role: 'group', id, 'aria-label': say(setting.label) });
    const show = (items: readonly string[]) => {
      for (const button of row.children)
        button.setAttribute('aria-pressed', String(items.includes((button as HTMLElement).dataset.word ?? '')));
    };
    for (const choice of setting.choices ?? []) {
      const button = h('button', { type: 'button', dataset: { word: choice } }, choice);
      button.onclick = () => {
        const chosen = [...row.children]
          .filter((item) => (item === button) !== (item.getAttribute('aria-pressed') === 'true'))
          .map((item) => (item as HTMLElement).dataset.word ?? '');
        show(chosen);
        const text = chosen.length === 0 ? (setting.off ?? '') : chosen.join(`${separator} `);
        changed(chosen.join() === current.join() ? undefined : text);
      };
      row.append(button);
    }
    show(current);
    return { element: row, reset: () => show(current) };
  }

  // Words, an address, a whole number, or a list typed with its separator.
  function textControl(setting: HostSetting, id: string, changed: (text: string | null | undefined) => void): Control {
    const words = t();
    const current = setting.value ?? '';
    const input = h('input', {
      type: 'text',
      id,
      autocomplete: 'off',
      spellcheck: 'false',
      value: current,
      placeholder: setting.default ?? (setting.defaultNote ? say(setting.defaultNote) : words.setNone),
      ...(setting.kind === 'integer' ? { inputmode: 'numeric' } : {}),
      ...(setting.kind === 'url' ? { inputmode: 'url' } : {}),
      ...(setting.maxLength ? { maxlength: String(setting.maxLength) } : {}),
    });
    input.oninput = () => {
      const text = input.value.trim();
      // Emptied: the default once saved (when the setting was saved); as it was: no change.
      changed(text === current ? undefined : text === '' ? null : text);
    };
    const field = h('label', { class: 'field' }, input);
    const reset = () => {
      input.value = current;
    };
    // A saved one can go back to its default in one press.
    if (setting.source !== 'saved') return { element: field, reset };
    const back = h('button', { class: 'key', type: 'button', title: say(setting.label) }, t().setUseDefault);
    back.onclick = () => {
      input.value = '';
      changed(null);
    };
    return { element: h('div', { class: 'control-row' }, field, back), reset };
  }

  // A duration or a size: its number, and its unit chosen beside it (off, for a duration that can be).
  function amountControl(
    setting: HostSetting,
    id: string,
    changed: (text: string | null | undefined) => void,
  ): Control {
    const words = t();
    const size = setting.kind === 'size';
    const current = setting.value ?? setting.default ?? '';
    // The units offered: a size's by its smallest value, a duration's seconds to hours; one the value has besides.
    const units = size ? (/kib|kb/i.test(setting.min ?? '') ? ['KiB', 'MiB'] : ['MiB', 'GiB']) : ['s', 'm', 'h'];
    const parse = (text: string) => {
      const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
      if (!match) return { amount: text, unit: units[0] ?? '' };
      const unit = match[2] || (size ? 'B' : 's');
      return { amount: match[1] ?? '', unit };
    };
    const isOff = (text: string) => setting.off !== null && text === setting.off;
    const start = parse(current);
    if (!units.some((unit) => unit.toLowerCase() === start.unit.toLowerCase())) units.push(start.unit);
    let unit = isOff(current)
      ? (units[1] ?? units[0] ?? '')
      : (units.find((item) => item.toLowerCase() === start.unit.toLowerCase()) ?? start.unit);
    let off = isOff(current);
    const input = h('input', {
      type: 'text',
      id,
      inputmode: 'decimal',
      autocomplete: 'off',
      value: off ? '' : start.amount,
      'aria-label': say(setting.label),
    });
    const row = h('div', { class: 'seg unit-seg', role: 'group', 'aria-label': say(setting.label) });
    const label = (word: string) => (size ? word : (words.setUnits[word] ?? word));
    const choices = [...(setting.off !== null ? [null] : []), ...units];
    const show = () => {
      for (const button of row.children) {
        const word = (button as HTMLElement).dataset.unit ?? '';
        button.setAttribute('aria-pressed', String(off ? word === '' : word === unit));
      }
      input.disabled = off;
    };
    const tell = () => {
      const amount = input.value.trim();
      const text = off ? (setting.off ?? '') : amount === '' ? null : `${amount}${unit}`;
      changed(text === current ? undefined : text);
    };
    for (const choice of choices) {
      const button = h(
        'button',
        { type: 'button', dataset: { unit: choice ?? '' } },
        choice === null ? words.setOff : label(choice),
      );
      button.onclick = () => {
        off = choice === null;
        if (choice !== null) unit = choice;
        show();
        tell();
      };
      row.append(button);
    }
    input.oninput = tell;
    show();
    return {
      element: h('div', { class: 'control-row' }, h('label', { class: 'field amount' }, input), row),
      reset: () => {
        off = isOff(current);
        input.value = off ? '' : start.amount;
        unit = off ? unit : start.unit;
        show();
      },
    };
  }

  // A time of day, or off: its switch, and the time beside it.
  function timeControl(setting: HostSetting, id: string, changed: (text: string | null | undefined) => void): Control {
    const current = setting.value ?? setting.default ?? '';
    const offWord = setting.off ?? 'off';
    const toggle = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': say(setting.label) });
    const input = h('input', {
      type: 'text',
      id,
      inputmode: 'numeric',
      autocomplete: 'off',
      placeholder: '04:00',
      maxlength: '5',
      'aria-label': say(setting.label),
    });
    const show = (text: string) => {
      const on = text !== offWord && text !== '';
      toggle.setAttribute('aria-checked', String(on));
      input.disabled = !on;
      input.value = on ? text : '';
    };
    const tell = () => {
      const on = toggle.getAttribute('aria-checked') === 'true';
      const text = on ? input.value.trim() || '04:00' : offWord;
      changed(text === current ? undefined : text);
    };
    toggle.onclick = () => {
      const on = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(on));
      input.disabled = !on;
      if (on && !input.value) input.value = '04:00';
      tell();
    };
    input.oninput = tell;
    show(current);
    return {
      element: h('div', { class: 'control-row' }, toggle, h('label', { class: 'field time' }, input)),
      reset: () => show(current),
    };
  }

  // Each line of a way of logging in's test: its icon by how it went, its name, and what it found.
  function showChecks(found: HTMLElement, result: LoginTest): void {
    const words = t();
    const failed = result.checks.filter((check) => check.status === 'fail').length;
    found.hidden = false;
    fill(
      found,
      h(
        'p',
        { class: `test-verdict ${failed > 0 ? 'tone-bad' : ''}`.trim() },
        icon(failed > 0 ? 'circle-alert' : 'check'),
        h('b', null, failed > 0 ? words.setChecksFailed(failed) : words.setChecksOk),
      ),
      h(
        'ul',
        { class: 'checks', 'aria-label': words.setChecks },
        ...result.checks.map((check) =>
          h(
            'li',
            { class: check.status === 'fail' ? 'tone-bad' : check.status === 'warn' ? 'tone-pause' : '' },
            icon(check.status === 'ok' ? 'check' : 'circle-alert'),
            h('span', null, h('b', null, check.name), ' ', foundText(check.detail)),
          ),
        ),
      ),
    );
  }

  // A test that could not be asked at all (refused, or jukecord out of reach): why, where its finding would be.
  function showFailure(found: HTMLElement, error: unknown): void {
    found.hidden = false;
    found.className = `${found.className.split(' ')[0]} tone-bad`;
    fill(found, h('p', { class: 'test-verdict tone-bad' }, icon('circle-alert'), h('span', null, messageOf(error))));
  }

  draw();
  void load();
  // The page in the other language at once (what is typed stays: a draw keeps no control, so it is read again first).
  watch(['lang'], () => {
    if (edits.size === 0) draw();
    else drawBar();
  });
  return page;
}

// A setting's name: the label of its control where that is a field or a switch (pressing the name goes to it), else
// words (a row of choices and a value shown name themselves with their own label).
function nameOf(setting: HostSetting, id: string): HTMLElement {
  const fielded =
    !setting.locked &&
    !setting.secret &&
    !(setting.kind === 'choice' || (setting.kind === 'list' && setting.choices !== null));
  return fielded ? h('label', { for: id }, say(setting.label)) : h('span', null, say(setting.label));
}

// A key busy while what it started runs: its words say so, and it cannot be pressed twice.
async function busy(key: HTMLButtonElement, words: string, run: () => Promise<void>): Promise<void> {
  const before = [...key.childNodes];
  key.disabled = true;
  fill(key, icon('loader-circle', 'spin'), words);
  try {
    await run();
  } finally {
    key.replaceChildren(...before);
    key.disabled = false;
    if (key.isConnected) key.focus();
  }
}
