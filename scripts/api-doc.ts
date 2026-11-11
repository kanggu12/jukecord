/**
 * Writes the operations table of docs/API.md from the operation table (src/web/api.ts), between the markers
 * <!-- operations:start --> and <!-- operations:end -->. The packaging tests fail when the document is out of date.
 *
 *   node scripts/api-doc.ts          rewrite the table
 *   node scripts/api-doc.ts --check  exit 1 when it is out of date
 */
import fs from 'node:fs';
import { COMMANDS } from '../src/cli/commands.ts';
import { SLASH_COMMANDS } from '../src/discord/commands.ts';
import { API, API_PREFIX, OPERATIONS, type OperationName } from '../src/web/api.ts';

const FILE = 'docs/API.md';
const START = '<!-- operations:start -->';
const END = '<!-- operations:end -->';

// Who may call it, in words.
const ACCESS = {
  public: 'anyone',
  read: 'read',
  control: 'control',
  admin: 'admin',
  host: 'the host',
} as const;

// The section titles, in the order of the table.
const TAGS = {
  player: 'Player',
  queue: 'Queue',
  history: 'History and statistics',
  playlists: 'Playlists',
  voice: 'Voice',
  server: 'Server',
  account: 'Your login',
  host: 'The host',
} as const;

/** The table as Markdown. */
export function operationsTable(): string {
  const parts: string[] = [];
  for (const [tag, title] of Object.entries(TAGS)) {
    const names = OPERATIONS.filter((name) => API[name].tag === tag);
    if (names.length === 0) continue;
    parts.push(
      `### ${title}`,
      '',
      '| Operation | Request | Needs | CLI | Discord |',
      '| :-- | :-- | :-- | :-- | :-- |',
    );
    for (const name of names as OperationName[]) {
      const spec = API[name];
      const slash = (SLASH_COMMANDS as Partial<Record<OperationName, string>>)[name];
      parts.push(
        `| \`${name}\` ${spec.summary} | \`${spec.method} ${API_PREFIX}${spec.path}\` | ${ACCESS[spec.access]} | \`jukecord ${COMMANDS[name].name}\` | ${slash ? `\`${slash}\`` : ''} |`,
      );
    }
    parts.push('');
  }
  return parts.join('\n').trim();
}

/** The document with the table replaced. */
export function withTable(document: string): string {
  const start = document.indexOf(START);
  const end = document.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${FILE} has no ${START} ... ${END} markers`);
  return `${document.slice(0, start + START.length)}\n\n${operationsTable()}\n\n${document.slice(end)}`;
}

if (import.meta.main) {
  const current = fs.readFileSync(FILE, 'utf8');
  const next = withTable(current);
  if (process.argv.includes('--check')) {
    if (next !== current) {
      process.stderr.write(`${FILE} is out of date: node scripts/api-doc.ts\n`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(FILE, next);
  }
}
