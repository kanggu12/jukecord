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
import { sayError, translate } from '../../../src/core/say.ts';
import { inUseWords, writtenWords } from '../../../src/settings/words.ts';
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
// (The provider's and the directory's take the authorities the page has not saved yet; Discord's are the world's.)
const LOGIN_TESTS: Readonly<
  Record<string, (values: Record<string, string>, name: string, ca: string | undefined) => Promise<LoginTest>>
> = {
  'discord-login': (values) => api['auth-test-discord'](values),
  sso: (values, _name, ca) => api['auth-test-oidc'](values, ca),
  directory: (values, name, ca) => api['auth-test-ldap'](values, name || undefined, ca),
};

// The addresses that can be tried before they are saved, and the test of each.
const SERVER_TESTS: Readonly<Record<string, (url: string, ca: string | undefined) => Promise<ServerTest>>> = {
  JUKECORD_CACHE_URL: (url, ca) => api['settings-test-cache'](url, ca),
  JUKECORD_BUS_URL: (url, ca) => api['settings-test-bus'](url, ca),
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
  // The certificates pasted in the authorities' section and not saved yet: every test of the page trusts them too.
  let caText = '';
  const pendingCa = (): string | undefined => (caText.trim() === '' ? undefined : caText);

  const title = h('h1');
  const bar = h('section', { class: 'card restart-bar', hidden: true, role: 'status' });
  // The sections: an index beside the cards on a wide window, a row of keys under the title on a narrow one.
  const index = h('nav', { class: 'settings-index' });
  const jump = h('nav', { class: 'settings-jump' });
  const cards = h('div', { class: 'settings-cards' });
  const page = h(
    'main',
    { class: 'page settings-page' },
    h('div', { class: 'page-head' }, title),
    jump,
    bar,
    h('div', { class: 'settings-layout' }, index, cards),
  );
  // The section being read: the index marks it as the place the page is at. It is the card across the middle of the
  // window (what the eye is on: a row brought into sight stands there), or the last card once the page has scrolled
  // to its end. Read again once a frame while the page scrolls (any box that scrolls it).
  let marking = 0;
  const markSection = (): void => {
    marking = 0;
    // The page left: nothing more to mark.
    if (!page.isConnected) {
      document.removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', onScroll);
      return;
    }
    const line = innerHeight / 2;
    const list = [...cards.children] as HTMLElement[];
    let current = list[0];
    for (const card of list) if (card.getBoundingClientRect().top <= line) current = card;
    // Scrolled to the end: the last card is what is read, though it may be short of the middle.
    const scroller = document.scrollingElement;
    if (scroller && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2)
      current = list.at(-1) ?? current;
    for (const link of index.children) {
      if ((link as HTMLElement).dataset.section === current?.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };
  const onScroll = (): void => {
    if (marking === 0) marking = requestAnimationFrame(markSection);
  };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  addEventListener('resize', onScroll, { passive: true });

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
  // A setting by its name, as last read.
  const settingNamed = (name: string): HostSetting | undefined => view?.settings.find((item) => item.name === name);

  // A key to the authorities' place under a finding that says the authority that signed a certificate is not trusted,
  // where the page can add one (not where the environment sets them): it brings the place into sight, ready to paste.
  const fixKey = (raw: string): HTMLElement | null => {
    if (!/to trust the authority that signed it/.test(raw) || !view || view.authorities.locked !== null) return null;
    const key = h('button', { class: 'text-key', type: 'button' }, t().caFixHere);
    key.onclick = () => {
      const place = document.getElementById('ca-paste');
      place?.scrollIntoView({ block: 'center' });
      place?.focus({ preventScroll: true });
    };
    return key;
  };

  // ---- words made from values ----

  // A choice's word as people read it ("memory" is "In memory"), or the word itself.
  const choiceWord = (word: string): string => t().choiceNames[word] ?? word;
  // A value as written, in words: a size or a duration in its unit, a choice by its name, the link services one after
  // another, anything else as it is.
  const valueWords = (setting: HostSetting, text: string | null): string | null => {
    if (text === null) return null;
    if (setting.kind === 'choice' || (setting.name === 'JUKECORD_CACHE_URL' && text === 'memory'))
      return choiceWord(text);
    if (setting.kind === 'list' && setting.choices) {
      const items = text
        .split(setting.separator ?? ',')
        .map((item) => item.trim())
        .filter((item) => item && item !== setting.off);
      return items.length > 0 ? items.map(choiceWord).join(' · ') : t().setOff;
    }
    return writtenWords(setting, text, state.lang);
  };
  // A setting's limits in words: "10 to 100000", "1 to 60 s" (one unit when both have it), Korean "1~60초".
  const rangeWords = (setting: HostSetting, low: string, high: string): string => {
    const words = t();
    const from = valueWords(setting, low) ?? low;
    const to = valueWords(setting, high) ?? high;
    const unitOf = (text: string) => /^[\d.]+\s?(\D*)$/.exec(text)?.[1] ?? null;
    const unit = unitOf(from);
    // The same unit on both: said once, after the second.
    const bare = unit && unit === unitOf(to) ? from.slice(0, from.length - unit.length).trim() : from;
    return words.setRange(bare, to);
  };
  // A setting's name in a line of words put by its label (a test's finding, a refusal): the page names settings so.
  const labelled = (text: string): string =>
    text.replaceAll(/\bJUKECORD_[A-Z0-9_]+\b/g, (name) => {
      const setting = settingNamed(name.replace(/_FILE$/, '')) ?? settingNamed(name);
      return setting ? say(setting.label) : name;
    });
  // A setting's problem as its row says it: its label first (bare: without it, under a field of its own), a value
  // outside its limits with the limits in words, in the page's language.
  const problemText = (name: string, message: string, bare = false): string => {
    const words = t();
    const setting = settingNamed(name);
    const label = setting ? say(setting.label) : name;
    const outside = /^(JUKECORD_\w+): (.+) is outside ([^\s-]+)-([^\s-]+)(?: \(.*\))?$/.exec(message);
    if (setting && outside && outside[1] === name)
      return words.setOutside(
        label,
        rangeWords(setting, outside[3] ?? '', outside[4] ?? ''),
        valueWords(setting, outside[2] ?? '') ?? '',
      );
    const said = translate(message, state.lang);
    const rest = labelled(said.startsWith(`${name}: `) ? said.slice(name.length + 2) : said);
    // A sentence of its own under a field: its first letter as a sentence has it.
    if (bare) return rest.charAt(0).toUpperCase() + rest.slice(1);
    return words.setProblemOf(label, rest);
  };

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
    jump.setAttribute('aria-label', words.setSections);
    // Scrolled to, not linked: a change of the address would draw the page anew and drop what is typed.
    const goTo = (group: string) => () =>
      document.getElementById(`settings-${group}`)?.scrollIntoView({ block: 'start' });
    fill(
      index,
      ...groups.map((group) => {
        const link = h(
          'button',
          { class: 'choice index-link', type: 'button', dataset: { section: `settings-${group.id}` } },
          say(group.label),
        );
        link.onclick = goTo(group.id);
        return link;
      }),
    );
    fill(
      jump,
      ...groups.map((group) => {
        const key = h('button', { class: 'key sm jump-key', type: 'button' }, say(group.label));
        key.onclick = goTo(group.id);
        return key;
      }),
    );
    fill(cards, ...groups.map((group) => groupCard(group.id, say(group.label), group.parts ?? [])));
    onScroll();
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
    // The authorities: what is trusted and from where, and a place to add or remove them (not a field of a path).
    if (group === 'authorities') {
      fill(card, head, ...authoritiesBody());
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
          const result = await (LOGIN_TESTS[part] ?? LOGIN_TESTS.sso)?.(values, name?.value.trim() ?? '', pendingCa());
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
    // Each change on a line of its own under its setting's name: what it was, what it becomes and when that applies;
    // a secret only as new or removed.
    const summary = h(
      'ul',
      { class: 'change-list' },
      ...settings.map((setting) => {
        const next = edits.get(setting.name) ?? null;
        const applies = setting.applies === 'now' ? words.setNow : words.setAfterRestart;
        // A value as the row shows it: its own, else its default (or what the default is, in words).
        const shown = (text: string | null) =>
          valueWords(setting, text ?? setting.default) ??
          (setting.defaultNote ? say(setting.defaultNote) : words.setNone);
        const change = setting.secret
          ? `${next === null ? words.setSecretGone : words.setSecretNew}\u00a0· ${applies}`
          : words.setChangeLine(shown(setting.value), shown(next), applies);
        return h(
          'li',
          null,
          h('b', { class: 'change-name' }, say(setting.label)),
          h('span', { class: 'change-to faint', title: change, 'data-clip': 'ok' }, change),
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
      // A change made meanwhile is read again first.
      if (error instanceof ApiError && error.code === 'conflict') {
        toast(words.setChangedElsewhere, 'pause', 'circle-alert');
        await load();
      } else if (error instanceof ApiError && error.problems.length > 0) {
        // Each problem at its setting, by its label: the first of them brought into sight, its field ready to type
        // in. Only a problem with no row of this section to say it is said in a toast.
        const here = new Set(settings.map((setting) => setting.name));
        const elsewhere: string[] = [];
        for (const found of error.problems) {
          const at = found.names.filter((name) => here.has(name));
          for (const name of at) problems.set(name, problemText(name, found.message));
          if (at.length === 0) elsewhere.push(labelled(translate(found.message, state.lang)));
        }
        for (const setting of settings) drawRow(setting.name);
        if (elsewhere.length > 0) toast(elsewhere.join(' '), 'bad', 'circle-alert');
        const first = settings.find((setting) => problems.has(setting.name));
        const row = first ? rows.get(first.name)?.row : null;
        if (row) {
          row.scrollIntoView({ block: 'center' });
          row
            .querySelector<HTMLElement>('.setting-control input, .setting-control button')
            ?.focus({ preventScroll: true });
          return;
        }
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
    const drawn = part
      ? partBlock(part.id, say(part.label))
      : groupCard(section, say(group?.label ?? { en: '', ko: '' }), []);
    old.replaceWith(drawn);
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

  // A row's state line and problem, from the setting and what is typed in it. Every row says where its value comes
  // from and when a change applies; a row at its default says it in a quieter tone, a changed one says so in words.
  const drawRow = (name: string): void => {
    const drawn = rows.get(name);
    const setting = settingNamed(name);
    if (!drawn || !setting) return;
    const words = t();
    const parts: string[] = [];
    let tone = '';
    let mark: IconName | null = null;
    // How the row reads: changed here, at its default, saved, or none of them (set elsewhere, refused, waiting).
    let look: 'changed' | 'default' | 'saved' | '' = '';
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
      look = 'changed';
      parts.push(setting.secret ? words.setRemoved : words.setToDefault);
    } else if (edits.has(name)) {
      // Changed and not saved yet: said in words, not by a colour at the row's edge.
      look = 'changed';
      parts.push(words.setUnsaved);
    } else {
      // Where the value comes from: saved here, or the default.
      if (!setting.pending && !setting.refused) look = setting.source === 'saved' ? 'saved' : 'default';
      parts.push(setting.source === 'saved' ? words.setSaved : words.setDefault);
    }
    // Its limits and its default, when it has them and is not a secret.
    if (!setting.secret && !setting.locked) {
      const limits =
        setting.min && setting.max
          ? rangeWords(setting, setting.min, setting.max)
          : setting.min
            ? words.setFrom(valueWords(setting, setting.min) ?? setting.min)
            : null;
      if (limits) parts.push(limits);
      if (setting.source === 'saved' && setting.default !== null && setting.kind !== 'boolean')
        parts.push(words.setDefaultIs(valueWords(setting, setting.default) ?? setting.default));
      else if (setting.source === 'saved' && setting.defaultNote) parts.push(say(setting.defaultNote));
    }
    // When it applies; saved and waiting for a restart, the value in use until then (a secret's never).
    parts.push(setting.applies === 'now' && !setting.pending ? words.setNow : words.setAfterRestart);
    if (setting.pending) {
      tone = 'tone-pause';
      mark = 'rotate-ccw';
      const running = setting.secret ? null : inUseWords(setting, setting.running, state.lang);
      if (running !== null) parts.push(words.setInUse(valueWords(setting, running) ?? running));
    }
    if (setting.refused) {
      tone = 'tone-bad';
      mark = 'circle-alert';
      parts.unshift(words.setRefused(labelled(foundText(setting.refused))));
    }
    drawn.state.className = `setting-state ${tone}`.trim();
    drawn.row.dataset.look = look;
    // Each part kept with the dot after it, so a line never starts with one.
    fill(drawn.state, mark ? icon(mark) : null, h('span', null, parts.join('\u00a0· ')));
    const said = problems.get(name);
    drawn.problem.hidden = !said;
    // The field with a problem is marked as such, for the eye and for a screen reader.
    drawn.row.toggleAttribute('data-problem', Boolean(said));
    for (const field of drawn.row.querySelectorAll('.setting-control input, .setting-control textarea')) {
      if (said) field.setAttribute('aria-invalid', 'true');
      else field.removeAttribute('aria-invalid');
    }
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
    if (setting.name === 'JUKECORD_TRUST_PROXY') return proxyControl(setting, id, changed);
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
    key.onclick = () => moveWizard(shown, () => void reread('database'), pendingCa);
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

  // The authorities' section: the file in use and where it comes from (locked where the environment sets it), each
  // certificate it holds, and, where the page may change it, a place to paste or pick a PEM with Save, and Remove.
  const authoritiesBody = (): Node[] => {
    const words = t();
    const shown = view;
    const setting = shown?.settings.find((item) => item.name === 'JUKECORD_CA_FILE');
    if (!shown || !setting) return [];
    const authorities = shown.authorities;
    const locked = authorities.locked !== null;
    // Where they come from, and whether a restart applies them: as every setting's state line says it.
    const state = h('p', { class: `setting-state ${authorities.pending ? 'tone-pause' : ''}`.trim() });
    const parts = [
      authorities.locked === 'environment'
        ? words.setByEnv(authorities.variable ?? setting.name)
        : authorities.locked === 'split'
          ? words.setBySplit
          : authorities.source === 'saved'
            ? words.setSaved
            : words.setDefault,
      // When a change applies; waiting for a restart, how many are in use until then.
      words.setAfterRestart,
      ...(authorities.pending && authorities.inUse > 0 ? [words.caInUse(authorities.inUse)] : []),
    ];
    fill(
      state,
      locked ? icon('lock') : authorities.pending ? icon('rotate-ccw') : null,
      h('span', null, parts.join('\u00a0· ')),
    );
    const remove = h('button', { class: 'key', type: 'button', dataset: { key: 'ca-remove' } }, words.setRemove);
    remove.hidden = locked || authorities.source !== 'saved';
    remove.onclick = () => void changeAuthorities(remove, () => api['settings-authorities-remove'](), words.caRemoved);
    const row = h(
      'div',
      { class: 'setting' },
      h(
        'div',
        { class: 'setting-text' },
        h(
          'div',
          { class: 'setting-name' },
          h('span', null, authorities.file ? words.caFrom(authorities.file) : words.caNone),
        ),
        h('p', { class: 'setting-help' }, say(setting.help)),
        state,
        authorities.problem
          ? h(
              'p',
              { class: 'setting-problem' },
              icon('circle-alert'),
              h('span', null, problemText(setting.name, authorities.problem, true)),
            )
          : null,
      ),
      h('div', { class: 'setting-control' }, remove),
    );
    // Each certificate: whose, who signed it, until when (an expired one in the problem's tone).
    const certificates =
      authorities.certificates.length > 0
        ? h(
            'ul',
            { class: 'cert-list' },
            ...authorities.certificates.map((certificate) => {
              const until = new Date(certificate.validTo);
              const day = words.dayOf(until.getMonth() + 1, until.getDate(), String(until.getFullYear()));
              const expired = until.getTime() < Date.now();
              return h(
                'li',
                { class: 'cert' },
                h('b', { class: 'cert-name', title: certificate.subject, 'data-clip': 'ok' }, certificate.subject),
                h(
                  'span',
                  { class: 'faint' },
                  [
                    certificate.issuer === certificate.subject ? words.caSelf : words.caSignedBy(certificate.issuer),
                    ...(certificate.authority ? [] : [words.caNotAuthority]),
                  ].join('\u00a0· '),
                ),
                h(
                  'span',
                  { class: expired ? 'text-bad' : 'faint' },
                  expired ? words.caExpired(day) : words.caUntil(day),
                ),
              );
            }),
          )
        : null;
    if (locked) return certificates ? [row, certificates] : [row];
    // Adding: pasted, or read from a file into the same place; saved with its own key. What is here is trusted by the
    // page's tests until it is saved (see pendingCa).
    const paste = h('textarea', {
      class: 'paste',
      rows: '6',
      id: 'ca-paste',
      spellcheck: 'false',
      placeholder: words.caPlaceholder,
    });
    paste.value = caText;
    const problemLine = h('p', { class: 'setting-problem', hidden: true });
    paste.oninput = () => {
      caText = paste.value;
      problemLine.hidden = true;
    };
    const picker = h('input', { type: 'file', accept: '.pem,.crt,.cer,.txt', hidden: true });
    const choose = h('button', { class: 'key', type: 'button' }, icon('folder-open'), words.chooseFile);
    choose.onclick = () => picker.click();
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      if (file.size > 1024 * 1024) {
        toast(words.fileTooLarge, 'bad', 'circle-alert');
        return;
      }
      paste.value = await file.text();
      caText = paste.value;
      problemLine.hidden = true;
    };
    const save = h(
      'button',
      { class: 'key primary', type: 'button', dataset: { key: 'ca-save' } },
      icon('save'),
      words.save,
    );
    save.onclick = () => {
      if (!caText.trim()) {
        paste.focus();
        return;
      }
      void changeAuthorities(save, () => api['settings-authorities-import'](caText), words.caSaved, problemLine);
    };
    const add = h(
      'div',
      { class: 'ca-add' },
      h('label', { class: 'field-label', for: 'ca-paste' }, words.caAdd),
      paste,
      h('p', { class: 'setting-help' }, words.caPasteHint),
      problemLine,
      h('div', { class: 'ca-keys' }, choose, save),
      picker,
    );
    return certificates ? [row, certificates, add] : [row, add];
  };

  // Saves or removes the authorities: the section and the bar drawn anew from the answer; a refusal said under the
  // place it came from (a key in the PEM, no certificate) by the setting's label, or in a toast where there is none.
  const changeAuthorities = async (
    key: HTMLButtonElement,
    work: () => Promise<{ view: HostSettingsView }>,
    done: string,
    problemLine?: HTMLElement,
  ): Promise<void> => {
    try {
      await busy(key, t().setSaving, async () => {
        const answer = await work();
        view = answer.view;
      });
    } catch (error) {
      const refused = error instanceof ApiError ? error.problems[0] : undefined;
      if (problemLine && refused) {
        problemLine.hidden = false;
        fill(
          problemLine,
          icon('circle-alert'),
          h('span', null, problemText(refused.names[0] ?? 'JUKECORD_CA_FILE', refused.message, true)),
        );
        problemLine.closest('.ca-add')?.querySelector<HTMLElement>('textarea')?.focus();
      } else problem(error);
      return;
    }
    caText = '';
    toast(done);
    redraw('authorities');
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
    // Each waiting setting by its section and label, a key that brings its row into sight (its field focused).
    const shown = view;
    const names = pending
      .map((name) => settingNamed(name))
      .filter((setting): setting is HostSetting => Boolean(setting))
      .flatMap((setting) => {
        const section =
          shown.groups.flatMap((group) => group.parts ?? []).find((part) => part.id === setting.part)?.label ??
          shown.groups.find((group) => group.id === setting.group)?.label;
        const go = h(
          'button',
          { class: 'key sm', type: 'button' },
          section ? words.setSectionOf(say(section), say(setting.label)) : say(setting.label),
        );
        go.onclick = () => {
          const row = rows.get(setting.name)?.row ?? document.getElementById(`settings-${setting.group}`);
          row?.scrollIntoView({ block: 'center' });
          row?.querySelector<HTMLElement>('input, button, textarea')?.focus({ preventScroll: true });
        };
        return [go];
      });
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
      h(
        'div',
        { class: 'restart-words' },
        // The icon in its own column, on the line of the words; the names under the words.
        icon('rotate-ccw', 'restart-mark'),
        h('b', null, words.setWaiting(pending.length)),
        // Why nothing would start jukecord again, in words; else the keys to the waiting rows, in a row that wraps.
        view.restart.refusal
          ? h('p', { class: 'restart-names faint' }, sayError(view.restart.refusal, state.lang))
          : h('div', { class: 'restart-names restart-keys' }, ...names),
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
    // In words: a size or a duration in its unit, a choice by its name ("In memory").
    const text = setting.secret
      ? (setting.shown ?? (setting.set ? words.setIsSet : words.setNotSet))
      : (valueWords(setting, setting.value ?? setting.default) ??
        (setting.defaultNote ? say(setting.defaultNote) : words.setNone));
    const element = h('span', { class: 'setting-value', id, title: text, 'data-clip': 'ok' }, text);
    // A locked address of the cache or the bus may still be tried (another one, before the environment changes).
    const test = SERVER_TESTS[setting.name];
    if (!test) return { element, reset: () => {} };
    return { element: h('div', { class: 'control-row' }, element, tryAnother(setting, test)), reset: () => {} };
  }

  // A key that opens a field to try an address with, which is never saved.
  function tryAnother(
    setting: HostSetting,
    test: (url: string, ca: string | undefined) => Promise<ServerTest>,
  ): HTMLElement {
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
      // What it holds, in words (the shared cache in memory is said so, not by its word).
      const shown = setting.shown === null ? null : (valueWords(setting, setting.shown) ?? setting.shown);
      const status = h(
        'span',
        { class: 'setting-value', id, title: shown ?? '', 'data-clip': 'ok' },
        shown ?? (setting.set ? words.setIsSet : words.setNotSet),
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
    test: (url: string, ca: string | undefined) => Promise<ServerTest>,
  ): Promise<void> {
    const words = t();
    const address = url();
    if (!address) return;
    await busy(key, words.setTesting, async () => {
      try {
        const result = await test(address, pendingCa());
        found.hidden = false;
        found.className = `setting-found ${result.ok ? '' : 'tone-bad'}`.trim();
        const text = result.ok
          ? result.where === 'memory'
            ? words.setTestedMemory
            : words.setTestedServer(result.server ?? result.where, result.roundTripMs ?? 0)
          : labelled(foundText(result.problem ?? ''));
        fill(
          found,
          icon(result.ok ? 'check' : 'circle-alert'),
          h('span', null, text, ...(result.ok ? [] : [' ', fixKey(result.problem ?? '')])),
        );
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
      for (const button of row.children)
        button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.word === chosen));
    };
    for (const choice of setting.choices ?? []) {
      // Each word as people read it ("Warnings" for warn); the setting keeps the word.
      const button = h('button', { type: 'button', dataset: { word: choice } }, choiceWord(choice));
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
    // Chips, each on or off by its fill (several may be on, unlike a row of choices).
    const row = h('div', { class: 'seg chips', role: 'group', id, 'aria-label': say(setting.label) });
    const show = (items: readonly string[]) => {
      for (const button of row.children)
        button.setAttribute('aria-pressed', String(items.includes((button as HTMLElement).dataset.word ?? '')));
    };
    for (const choice of setting.choices ?? []) {
      const button = h('button', { type: 'button', dataset: { word: choice } }, choiceWord(choice));
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

  // The reverse proxies whose word on a browser's address is taken: none, how many stand in front of jukecord, or
  // their addresses (every one only where it is set so already), with one field for the number or the addresses.
  function proxyControl(setting: HostSetting, id: string, changed: (text: string | null | undefined) => void): Control {
    const words = t();
    const current = (setting.value ?? setting.default ?? 'false').trim();
    type Kind = 'none' | 'count' | 'addresses' | 'all';
    const kindOf = (text: string): Kind =>
      /^(false)?$/i.test(text) ? 'none' : /^true$/i.test(text) ? 'all' : /^\d+$/.test(text) ? 'count' : 'addresses';
    const start = kindOf(current);
    let kind: Kind = start;
    const kinds: Kind[] = ['none', 'count', 'addresses', ...(start === 'all' ? (['all'] as const) : [])];
    const names: Record<Kind, string> = {
      none: words.proxyNone,
      count: words.proxyCount,
      addresses: words.proxyAddresses,
      all: words.proxyAll,
    };
    const typedAt = (at: Kind) => (at === start && (at === 'count' || at === 'addresses') ? current : '');
    const input = h('input', { type: 'text', id, autocomplete: 'off', spellcheck: 'false', value: typedAt(start) });
    const field = h('label', { class: 'field' }, input);
    const row = h('div', { class: 'seg', role: 'group', 'aria-label': say(setting.label) });
    const show = () => {
      for (const button of row.children)
        button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.word === kind));
      // The field for a number or for addresses only.
      field.hidden = kind === 'none' || kind === 'all';
      input.inputMode = kind === 'count' ? 'numeric' : 'text';
      input.placeholder = kind === 'count' ? '1' : '10.0.0.0/8, 172.16.0.0/12';
      input.setAttribute('aria-label', kind === 'count' ? words.proxyCountLabel : words.proxyAddressesLabel);
    };
    const tell = () => {
      const typed = input.value.trim();
      // None and every one are words of their own; a number or addresses as typed (one proxy when none is typed).
      const text =
        kind === 'none' ? 'false' : kind === 'all' ? 'true' : kind === 'count' ? typed || '1' : typed || undefined;
      changed(text === undefined || text === current ? undefined : text);
    };
    for (const each of kinds) {
      const button = h('button', { type: 'button', dataset: { word: each } }, names[each]);
      button.onclick = () => {
        // Another kind: what was typed for the other one does not carry over (a number is no address).
        if (each !== kind) input.value = typedAt(each);
        kind = each;
        show();
        tell();
        if (!field.hidden) input.focus();
      };
      row.append(button);
    }
    input.oninput = tell;
    show();
    return {
      element: h('div', { class: 'control-stack' }, row, field),
      reset: () => {
        kind = start;
        input.value = typedAt(start);
        show();
      },
    };
  }

  // Words, an address, a whole number, or a list typed with its separator.
  function textControl(setting: HostSetting, id: string, changed: (text: string | null | undefined) => void): Control {
    const words = t();
    const current = setting.value ?? '';
    // The published port is the port's own unless it says otherwise: its placeholder says which that is.
    const port = settingNamed('JUKECORD_PORT');
    const placeholder =
      setting.name === 'JUKECORD_PUBLISHED_PORT' && port
        ? words.setSamePort(port.value ?? port.default ?? '')
        : (valueWords(setting, setting.default) ?? (setting.defaultNote ? say(setting.defaultNote) : words.setNone));
    const input = h('input', {
      type: 'text',
      id,
      autocomplete: 'off',
      spellcheck: 'false',
      value: current,
      placeholder,
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
            h(
              'span',
              null,
              h('b', null, words.checkNames[check.name] ?? check.name),
              ' ',
              labelled(foundText(check.detail)),
              ...(check.status === 'fail' ? [' ', fixKey(check.detail)] : []),
            ),
          ),
        ),
      ),
    );
  }

  // A test that could not be asked at all (refused, or jukecord out of reach): why, where its finding would be.
  function showFailure(found: HTMLElement, error: unknown): void {
    found.hidden = false;
    found.className = `${found.className.split(' ')[0]} tone-bad`;
    const raw = error instanceof ApiError ? error.message : '';
    fill(
      found,
      h(
        'p',
        { class: 'test-verdict tone-bad' },
        icon('circle-alert'),
        h('span', null, labelled(messageOf(error)), ' ', fixKey(raw)),
      ),
    );
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
    setting.name !== 'JUKECORD_TRUST_PROXY' &&
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
