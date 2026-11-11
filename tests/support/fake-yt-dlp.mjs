#!/usr/bin/env node
// A stand-in for yt-dlp in tests: answers --version, -J lookups and audio downloads (-o -) from files named in the
// environment, so the media code can be run end to end without reaching any site.
//
//   FAKE_YTDLP_INFO   a JSON file printed for -J
//   FAKE_YTDLP_AUDIO  an audio file streamed to stdout for -o -
//   FAKE_YTDLP_FAIL   when set, print it as an error and exit 1 (a removed video, say)
//   FAKE_YTDLP_ARGS   when set, append the received arguments to this file, one run per line (to check the flags)
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_YTDLP_ARGS) fs.appendFileSync(process.env.FAKE_YTDLP_ARGS, `${JSON.stringify(args)}\n`);

if (args.includes('--version')) {
  process.stdout.write('2026.10.26\n');
  process.exit(0);
}
if (process.env.FAKE_YTDLP_FAIL) {
  // yt-dlp's errors start with "ERROR:" on stderr.
  process.stderr.write(`ERROR: ${process.env.FAKE_YTDLP_FAIL}\n`);
  process.exit(1);
}
if (args.includes('-J')) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_YTDLP_INFO ?? '', 'utf8'));
  process.exit(0);
}
const output = args.indexOf('--output');
if (output !== -1 && args[output + 1] === '-') {
  // Stream the file like a download, and exit 0 once it is all written.
  fs.createReadStream(process.env.FAKE_YTDLP_AUDIO ?? '')
    .on('error', (error) => {
      process.stderr.write(`ERROR: ${error.message}\n`);
      process.exit(1);
    })
    .pipe(process.stdout);
} else {
  process.stderr.write(`ERROR: the fake yt-dlp does not know these arguments: ${args.join(' ')}\n`);
  process.exit(2);
}
