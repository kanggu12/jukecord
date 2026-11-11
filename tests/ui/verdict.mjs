// Reads the walk's report and fails (exit 1) when anything was found: a measurement, a page error, or a step of the
// walk that could not be done. Used by .github/workflows/look.yml after tests/ui/run.sh.
import fs from 'node:fs';

const report = JSON.parse(fs.readFileSync(process.argv[2] ?? 'report.json', 'utf8'));
let problems = 0;
for (const entry of report) {
  for (const finding of entry.findings) {
    problems += 1;
    if (problems <= 50)
      console.log(
        `${entry.state} ${entry.theme} ${entry.lang} ${entry.width}: [${finding.kind}] ${finding.where}: ${finding.detail}`,
      );
  }
  for (const error of entry.errors ?? []) {
    problems += 1;
    if (problems <= 50) console.log(`${entry.state} ${entry.theme} ${entry.lang} ${entry.width}: page error: ${error}`);
  }
}
console.log(`${report.length} pages, ${problems} problems`);
process.exit(problems > 0 ? 1 : 0);
