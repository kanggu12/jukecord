import { api, type DatabaseTest, type HostSettingsView, type MoveState } from '../api.ts';
import { fill, h, icon } from '../dom.ts';
import { t } from '../state.ts';
import { foundText, messageOf, pagedDialog, problem, toast } from '../ui/layers.ts';

// The kinds of database a move can go to, each with the address it is written as (the password in a field of its own)
// and the word its description starts with (describeAddress: "SQLite (...)", "PostgreSQL (...)", "MariaDB (...)").
const KINDS = [
  { kind: 'sqlite', example: 'sqlite:jukecord-new.db', said: /^SQLite\b/ },
  { kind: 'postgres', example: 'postgres://jukecord@database:5432/jukecord', said: /^PostgreSQL\b/ },
  { kind: 'mysql', example: 'mysql://jukecord@database:3306/jukecord', said: /^(MySQL|MariaDB)\b/ },
] as const;
type Kind = (typeof KINDS)[number]['kind'];

/**
 * Waits for jukecord to answer again after a restart asked for at `asked` (a start after it): true once it has, false
 * after two minutes or once `still` says the page that waits is gone.
 */
export async function waitForRestart(asked: number, still: () => boolean): Promise<boolean> {
  for (let tries = 0; tries < 120 && still(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      // Up for less time than has passed since the restart was asked for: a new start.
      const status = await api.status();
      if (status.uptimeMs < Date.now() - asked) return true;
    } catch {
      // Not answering yet: it is stopping, or starting again.
    }
  }
  return false;
}

/**
 * Opens the move's dialog; `finished` runs when it closes (the page reads the settings again). `ca` gives the
 * authorities the page has not saved yet, which the test of an address trusts too.
 */
export function moveWizard(
  view: HostSettingsView,
  finished: () => void,
  ca: () => string | undefined = () => undefined,
): void {
  const words = t();
  const content = h('div', { class: 'wizard' });
  const { keys, close, done } = pagedDialog(words.move, content);
  void done.then(() => {
    stopped = true;
    finished();
  });
  // What the pages share: the kind chosen, the address typed and its test, whether to empty a database with data, the
  // copy's state as last read, and whether the dialog is gone (its polling stops then).
  let kind: Kind | null = null;
  let address = '';
  let password = '';
  let tested: { url: string; password: string; result: DatabaseTest } | null = null;
  let replace = false;
  let move: MoveState | null = view.move.state;
  let stopped = false;
  // A copy stopped from here: its page says so, with a key to copy again.
  let stoppedCopy = false;
  const shown = view.settings.find((setting) => setting.name === 'JUKECORD_DATABASE_URL')?.shown ?? '';
  const current = foundText(shown);
  // The kind of the database in use: SQLite's file is not moved into another (the data folder's is the only one a
  // move offers); a server of the same kind is another server, which can be.
  const inUse = KINDS.find((option) => option.said.test(shown))?.kind ?? null;
  const who = words.supervisors[view.restart.supervisor] ?? view.restart.supervisor;

  // A page: its step's place among the four, its own content, and its keys (Back first, the step's key last).
  const show = (step: number, body: Node[], back: (() => void) | null, next: HTMLButtonElement | null) => {
    const steps = words.moveSteps;
    fill(
      content,
      h(
        'ol',
        { class: 'wizard-steps', 'aria-label': words.moveStep(step, steps.length, steps[step - 1] ?? '') },
        ...steps.map((name, index) =>
          h('li', { 'aria-current': index + 1 === step ? 'step' : null, class: index + 1 < step ? 'done' : '' }, name),
        ),
      ),
      ...body,
    );
    const backKey = h('button', { class: 'key', type: 'button' }, words.wizardBack);
    backKey.onclick = () => back?.();
    backKey.hidden = back === null;
    const cancel = h('button', { class: 'key', type: 'button' }, words.cancel);
    cancel.onclick = () => close();
    fill(keys, cancel, backKey, next);
  };

  // Step 1: which kind of database.
  const chooseKind = () => {
    const list = h('div', { class: 'menu-list', role: 'radiogroup', 'aria-label': words.moveKind });
    const next = h('button', { class: 'key primary', type: 'button' }, words.wizardNext);
    next.disabled = kind === null;
    next.onclick = () => enterAddress();
    for (const option of KINDS) {
      const [name, hint] =
        option.kind === 'sqlite'
          ? [words.moveSqlite, words.moveSqliteHint]
          : option.kind === 'postgres'
            ? [words.movePostgres, words.movePostgresHint]
            : [words.moveMysql, words.moveMysqlHint];
      const used = option.kind === inUse;
      const choice = h(
        'button',
        { class: 'choice', type: 'button', role: 'radio', 'aria-checked': String(kind === option.kind) },
        icon('database'),
        h(
          'span',
          { class: 'grow' },
          h('span', { class: 'choice-name' }, name),
          // The kind in use says so in its words, before what it is.
          h('span', { class: 'choice-hint' }, used ? `${words.moveInUse}\u00a0· ${hint}` : hint),
        ),
        icon('check', 'check'),
      );
      // The data folder's SQLite file is the one in use: no other SQLite file to move to.
      if (used && option.kind === 'sqlite') {
        choice.disabled = true;
        choice.setAttribute('aria-disabled', 'true');
      }
      choice.onclick = () => {
        // Another kind: the address typed for the last one is not this one's.
        if (kind !== option.kind) {
          address = '';
          tested = null;
        }
        kind = option.kind;
        for (const other of list.children) other.setAttribute('aria-checked', String(other === choice));
        next.disabled = false;
      };
      list.append(choice);
    }
    show(1, [h('p', { class: 'wizard-note wizard-from faint' }, words.moveFrom(current)), list], null, next);
  };

  // Step 2: its address, and a server's password in a field of its own (never in the address that is shown), tried
  // before going on.
  const enterAddress = () => {
    const example = KINDS.find((option) => option.kind === kind)?.example ?? '';
    const input = h('input', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      value: address,
      placeholder: example,
      'aria-label': words.moveAddress,
    });
    const secret = h('input', {
      type: 'password',
      autocomplete: 'off',
      value: password,
      placeholder: words.movePassword,
      'aria-label': words.movePassword,
    });
    const test = h('button', { class: 'key', type: 'button' }, words.setTest);
    const found = h('div', { class: 'wizard-found', 'aria-live': 'polite' });
    const next = h('button', { class: 'key primary', type: 'button' }, words.wizardNext);
    // The address and password tried last are the ones in the fields.
    const same = () => tested !== null && tested.url === input.value.trim() && tested.password === secret.value;
    // On only for the address that was tried and found usable, a database with data only once emptying is chosen.
    const ready = () => {
      const usable = same() && Boolean(tested?.result.ok);
      next.disabled = !usable || ((tested?.result.rows ?? 0) > 0 && !replace);
    };
    const drawFound = () => {
      if (!tested || !same()) {
        fill(found, h('p', { class: 'wizard-note faint' }, words.moveTestFirst));
        return;
      }
      const result = tested.result;
      if (!result.ok) {
        fill(
          found,
          h(
            'p',
            { class: 'test-verdict tone-bad' },
            icon('circle-alert'),
            h('span', null, foundText(result.problem ?? '')),
          ),
        );
        return;
      }
      // What answered, and what it holds: nothing, a new file, or jukecord's rows (then whether to empty it).
      const facts = [result.server, result.roundTripMs === null ? null : `${result.roundTripMs} ms`].filter(Boolean);
      const holds = result.newFile
        ? words.moveNewFile
        : (result.rows ?? 0) > 0
          ? words.moveHolds(result.rows ?? 0)
          : words.moveEmpty;
      const toggle = h('button', {
        class: 'switch',
        type: 'button',
        role: 'switch',
        'aria-checked': String(replace),
        'aria-label': words.moveReplace,
      });
      toggle.onclick = () => {
        replace = !replace;
        toggle.setAttribute('aria-checked', String(replace));
        ready();
      };
      fill(
        found,
        h(
          'p',
          { class: 'test-verdict' },
          icon('check'),
          h('span', null, `${foundText(result.where)}${facts.length > 0 ? ` · ${facts.join(', ')}` : ''}`),
        ),
        h('p', { class: 'wizard-note faint' }, holds),
        (result.rows ?? 0) > 0
          ? h(
              'div',
              { class: 'line' },
              h(
                'div',
                { class: 'grow' },
                h('div', null, words.moveReplace),
                h('div', { class: 'faint' }, words.moveReplaceHint),
              ),
              toggle,
            )
          : null,
      );
    };
    input.oninput = () => {
      address = input.value;
      drawFound();
      ready();
    };
    secret.oninput = () => {
      password = secret.value;
      drawFound();
      ready();
    };
    for (const field of [input, secret]) {
      field.onkeydown = (event) => {
        // Enter tries the address (the dialog's own Next stays a key to press).
        if (event.key !== 'Enter') return;
        event.preventDefault();
        test.click();
      };
    }
    test.onclick = async () => {
      const url = input.value.trim();
      if (!url) return;
      test.disabled = true;
      fill(test, icon('loader-circle', 'spin'), words.setTesting);
      try {
        const given = secret.value;
        tested = { url, password: given, result: await api['settings-test-database'](url, ca(), given || undefined) };
        replace = false;
      } catch (error) {
        tested = null;
        fill(
          found,
          h('p', { class: 'test-verdict tone-bad' }, icon('circle-alert'), h('span', null, messageOf(error))),
        );
        return;
      } finally {
        test.disabled = false;
        fill(test, words.setTest);
      }
      drawFound();
      ready();
    };
    next.onclick = () => void startCopy();
    // A SQLite file has no password: the field is a server's only.
    show(
      2,
      [
        h(
          'div',
          { class: 'wizard-fields' },
          h('label', { class: 'field' }, input),
          kind === 'sqlite' ? null : h('label', { class: 'field' }, secret),
          test,
        ),
        found,
      ],
      () => chooseKind(),
      next,
    );
    drawFound();
    ready();
    input.focus();
  };

  // Step 3: the copy, started here or under way already.
  const startCopy = async () => {
    try {
      move = await api['database-move'](
        tested?.url ?? address.trim(),
        replace,
        (tested?.password ?? password) || undefined,
      );
    } catch (error) {
      problem(error);
      return;
    }
    stoppedCopy = false;
    copying();
  };
  const copying = () => {
    const meter = h('div', {
      class: 'copy-meter',
      role: 'progressbar',
      'aria-label': words.moveCopy,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    });
    const fillBar = h('div', { class: 'copy-meter-fill' });
    meter.append(fillBar);
    const line = h('p', { class: 'wizard-note wizard-progress' });
    // The keys by the copy's state: Stop alone while it runs; Back with Next once it is done, with Copy again once it
    // failed or was stopped.
    const next = h('button', { class: 'key primary', type: 'button' }, words.wizardNext);
    next.onclick = () => switching();
    const again = h('button', { class: 'key primary', type: 'button' }, words.moveCopyAgain);
    again.onclick = () => void startCopy();
    const stop = h('button', { class: 'key', type: 'button' }, icon('circle-stop'), words.moveStop);
    const cancel = h('button', { class: 'key', type: 'button' }, words.cancel);
    cancel.onclick = () => close();
    const backKey = h('button', { class: 'key', type: 'button' }, words.wizardBack);
    backKey.onclick = () => enterAddress();
    const stopCopy = async () => {
      stop.disabled = true;
      try {
        await api['database-move-cancel']();
      } catch (error) {
        stop.disabled = false;
        problem(error);
        return;
      }
      // Said on the page itself, plainly, with the key to copy again.
      move = null;
      stoppedCopy = true;
      drawState();
    };
    stop.onclick = () => void stopCopy();
    // The keys put in place when the copy's state changes, not at every reading of it (a key drawn anew under the
    // pointer twice a second could not be pressed).
    let keysOf = '';
    const setKeys = (state: string, ...list: HTMLButtonElement[]) => {
      if (keysOf === state) return;
      keysOf = state;
      fill(keys, ...list);
    };
    const drawState = () => {
      const now = move;
      const share = now && now.total > 0 ? Math.min(100, Math.round((now.rows / now.total) * 100)) : 0;
      meter.setAttribute('aria-valuenow', String(now?.phase === 'copied' ? 100 : share));
      fillBar.style.width = `${now?.phase === 'copied' ? 100 : share}%`;
      if (stoppedCopy) {
        fill(line, icon('circle-stop'), h('span', null, words.moveStopped));
        line.className = 'wizard-note wizard-progress';
        setKeys('stopped', cancel, backKey, again);
        return;
      }
      if (!now) return;
      if (now.phase === 'failed') {
        fill(line, icon('circle-alert'), h('span', null, words.moveFailed(foundText(now.error ?? ''))));
        line.className = 'wizard-note wizard-progress tone-bad';
        setKeys('failed', cancel, backKey, again);
      } else if (now.phase === 'copied') {
        fill(line, icon('check'), h('span', null, words.moveCopied(now.rows, ((now.ms ?? 0) / 1000).toFixed(1))));
        line.className = 'wizard-note wizard-progress';
        setKeys('copied', cancel, backKey, next);
      } else {
        fill(
          line,
          icon('loader-circle', 'spin'),
          h(
            'span',
            null,
            `${words.moveCopying(now.rows, now.total)}${now.table ? ` · ${words.moveCopyingTable(now.table)}` : ''}`,
          ),
        );
        line.className = 'wizard-note wizard-progress';
        setKeys('copying', stop);
      }
    };
    show(
      3,
      [
        h('p', { class: 'wizard-note wizard-where faint' }, foundText(move?.where ?? tested?.result.where ?? '')),
        meter,
        line,
      ],
      () => enterAddress(),
      null,
    );
    drawState();
    // The copy's state read again every half second while it runs and the dialog is open.
    const poll = async () => {
      while (!stopped && !stoppedCopy && move?.phase === 'copying' && content.isConnected) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const read = (await api['database-move-status']()).state;
          // Stopped from here meanwhile: what was read before the stop is no news.
          if (stoppedCopy) break;
          move = read;
        } catch {
          // Missed once: read again at the next turn.
        }
        drawState();
      }
    };
    void poll();
  };

  // Step 4: the switch, and the restart on the new database.
  const switching = () => {
    const go = h('button', { class: 'key primary', type: 'button' }, icon('rotate-ccw'), words.moveSwitch);
    const refused = view.restart.refusal;
    go.disabled = refused !== null;
    const said = h('div', { class: 'wizard-found', 'aria-live': 'polite' });
    go.onclick = async () => {
      const asked = Date.now();
      go.disabled = true;
      fill(go, icon('loader-circle', 'spin'), words.moveSwitching);
      try {
        await api['database-move-switch']();
      } catch (error) {
        fill(said, h('p', { class: 'test-verdict tone-bad' }, icon('circle-alert'), h('span', null, messageOf(error))));
        fill(go, icon('rotate-ccw'), words.moveSwitch);
        go.disabled = false;
        return;
      }
      // jukecord stops, copies the rest, and starts again on the new database: the dialog waits for it.
      const back = await waitForRestart(asked, () => !stopped);
      if (stopped) return;
      if (back) toast(t().setRestarted);
      else toast(t().setStillDown, 'bad', 'circle-alert');
      close();
    };
    // From where to where, and what the copy holds; then what the switch does (the music pauses meanwhile).
    const copied = move?.rows ?? 0;
    show(
      4,
      [
        h(
          'p',
          { class: 'wizard-note wizard-route' },
          h('span', { class: 'route' }, words.moveFromTo(current, foundText(move?.where ?? ''))),
          h('span', { class: 'faint' }, words.moveRowsCopied(copied)),
        ),
        h('p', { class: 'wizard-note wizard-text' }, words.moveSwitchText(who)),
        ...(refused
          ? [h('p', { class: 'test-verdict tone-bad' }, icon('circle-alert'), h('span', null, words.moveNoRestart))]
          : []),
        said,
      ],
      () => copying(),
      go,
    );
  };

  // A move under way opens at its copy; else at the start.
  if (move && (move.phase === 'copying' || move.phase === 'copied' || move.phase === 'failed')) copying();
  else chooseKind();
}
