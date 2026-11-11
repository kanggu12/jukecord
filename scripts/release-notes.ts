/**
 * Prints a version's section of CHANGELOG.md, which is that release's notes. Exits 1 when the section is missing or
 * empty: a release without notes is a mistake.
 *
 *   node scripts/release-notes.ts v1.2.3
 */
import fs from 'node:fs';

/** The body of a version's section (without its heading), or null. */
export function notesFor(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const end = lines.findIndex(
    (line, index) => index > start && (line.startsWith('## [') || /^\[[^\]]+\]: /.test(line)),
  );
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
  return body || null;
}

if (import.meta.main) {
  const version = (process.argv[2] ?? '').replace(/^v/, '');
  const notes = notesFor(fs.readFileSync('CHANGELOG.md', 'utf8'), version);
  if (!notes) {
    process.stderr.write(`CHANGELOG.md has no notes for ${version}\n`);
    process.exit(1);
  }
  process.stdout.write(`${notes}\n`);
}
