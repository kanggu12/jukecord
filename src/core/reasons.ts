/**
 * Why a track could not be got, said plainly. What yt-dlp and ffmpeg print is for the log; people see one of a few
 * short reasons (the panel and the bot translate these), so the same failure reads the same everywhere.
 */

/** YouTube's "sign in to confirm you're not a bot", in the words yt-dlp passes on. */
export const BOT_CHECK = /sign in to confirm|confirm you.?re not a bot/i;

/** The reasons a person can be shown; `the site answered N` carries the HTTP status. */
export const REASONS = {
  botCheck: 'YouTube is refusing this server for now',
  privateNetwork: 'that address is on a private network',
  unavailable: 'the video is unavailable',
  nothingToPlay: 'there is nothing to play at that address',
  tooLong: 'getting it took too long',
  noSuchSite: 'no such site',
  nothingFound: 'nothing was found',
  failed: 'it could not be downloaded',
} as const;

/** The short reason for a failure, from the full text of the error. */
export function plainReason(message: string): string {
  if (BOT_CHECK.test(message)) return REASONS.botCheck;
  if (/private network/i.test(message)) return REASONS.privateNetwork;
  // Removed, private, members-only, age-restricted or blocked in this country: the site will not give it.
  if (
    /video unavailable|private video|has been removed|is not available|members-only|age-restricted|blocked it/i.test(
      message,
    )
  )
    return REASONS.unavailable;
  const status = /HTTP Error (\d{3})/i.exec(message)?.[1];
  if (status) return `the site answered ${status}`;
  if (/no such site|getaddrinfo|ENOTFOUND|Name or service not known|nodename nor servname/i.test(message))
    return REASONS.noSuchSite;
  if (/nothing was found/i.test(message)) return REASONS.nothingFound;
  if (/unsupported url|nothing playable|no video formats|requested format is not available/i.test(message))
    return REASONS.nothingToPlay;
  if (/took longer|took too long|timed out|timeout/i.test(message)) return REASONS.tooLong;
  return REASONS.failed;
}
