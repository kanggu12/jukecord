/**
 * Writes the settings table of docs/README.md from the settings table (src/settings/definitions.ts), between the
 * markers <!-- settings:start --> and <!-- settings:end -->. The packaging tests fail when the guide is out of date.
 *
 *   node scripts/settings-doc.ts          rewrite the table
 *   node scripts/settings-doc.ts --check  exit 1 when it is out of date
 */
import fs from 'node:fs';
import { GROUPS, SETTINGS, type SettingDefinition } from '../src/settings/definitions.ts';

const FILE = 'docs/README.md';
const START = '<!-- settings:start -->';
const END = '<!-- settings:end -->';

// A setting's variables: its own, and the file one that holds a secret instead.
function variables(setting: SettingDefinition): string {
  return setting.file ? `\`${setting.name}\`, \`${setting.name}_FILE\`` : `\`${setting.name}\``;
}

// Its default: the value as written, the words of a default made from something else, or nothing.
function defaultOf(setting: SettingDefinition): string {
  if (setting.default !== null && setting.default !== '') return `\`${setting.default}\``;
  return setting.defaultNote?.en ?? '';
}

// The rows of a Markdown table with its columns padded to one width (as the rest of the guide's tables are), the
// default column centred.
function table(head: readonly string[], rows: readonly (readonly string[])[], centred: number): string[] {
  const widths = head.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)));
  const line = (cells: readonly string[]) =>
    `| ${cells
      .map((cell, column) => {
        const width = widths[column] ?? 0;
        if (column !== centred) return cell.padEnd(width);
        // Centred as a formatter does it: the extra space on the right.
        const left = Math.floor((width - cell.length) / 2);
        return `${' '.repeat(left)}${cell}`.padEnd(width);
      })
      .join(' | ')} |`;
  const rule = `| ${widths.map((width, column) => (column === centred ? `:${'-'.repeat(width - 2)}:` : `:${'-'.repeat(width - 1)}`)).join(' | ')} |`;
  return [line(head), rule, ...rows.map(line)];
}

/** The table as Markdown: a row of the group's name, then each of its settings. */
export function settingsTable(): string {
  const rows: string[][] = [];
  for (const group of GROUPS) {
    // A group in parts (the ways of logging in) has a row for each part; any other group one row.
    const sections = group.parts
      ? group.parts.map((part) => ({ title: `${group.label.en}: ${part.label.en}`, part: part.id }))
      : [{ title: group.label.en, part: undefined }];
    for (const section of sections) {
      const settings = SETTINGS.filter((setting) => setting.group === group.id && setting.part === section.part);
      if (settings.length === 0) continue;
      rows.push([`**${section.title}**`, '', '', '']);
      for (const setting of settings) {
        rows.push([
          variables(setting),
          defaultOf(setting),
          setting.applies === 'now' ? 'at once' : 'restart',
          setting.help.en,
        ]);
      }
    }
  }
  return table(['Variable', 'Default', 'Applies', 'What it sets'], rows, 1).join('\n');
}

/** The guide with the table replaced. */
export function withSettingsTable(document: string): string {
  const start = document.indexOf(START);
  const end = document.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${FILE} has no ${START} ... ${END} markers`);
  return `${document.slice(0, start + START.length)}\n\n${settingsTable()}\n\n${document.slice(end)}`;
}

if (import.meta.main) {
  const current = fs.readFileSync(FILE, 'utf8');
  const next = withSettingsTable(current);
  if (process.argv.includes('--check')) {
    if (next !== current) {
      process.stderr.write(`${FILE} is out of date: node scripts/settings-doc.ts\n`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(FILE, next);
  }
}
