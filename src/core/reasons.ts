/**
 * Why a track could not be got, said plainly. What yt-dlp and ffmpeg print is for the log; people see one of a few
 * short reasons (the panel and the bot translate these), so the same failure reads the same everywhere.
 */

/**
 * YouTube's "sign in to confirm you're not a bot", in the words yt-dlp passes on, and in the sentence jukecord puts in
 * their place (media/ytdlp.ts). Not "sign in to confirm" alone: that is also how YouTube asks for an age.
 */
export const BOT_CHECK = /confirm you.?re not a bot|prove it is not a bot/i;

/** The reasons a person can be shown; `the site answered N` carries the HTTP status. */
export const REASONS = {
  botCheck: 'YouTube is refusing this server for now',
  privateNetwork: 'that address is on a private network',
  unavailable: 'the video is unavailable',
  notYet: 'it has not started yet',
  nothingToPlay: 'there is nothing to play at that address',
  tooLarge: 'the file is too large',
  tooLong: 'getting it took too long',
  noSuchSite: 'no such site',
  nothingFound: 'nothing was found',
  failed: 'it could not be downloaded',
  offline: 'jukecord cannot reach the internet',
} as const;

/** The short reason for a failure, from the full text of the error. */
export function plainReason(message: string): string {
  if (BOT_CHECK.test(message)) return REASONS.botCheck;
  if (/private network/i.test(message)) return REASONS.privateNetwork;
  // Nothing jukecord can play there: a page it does not know, no sound in it, or sound locked by DRM. Before the
  // check below, which "requested format is not available" would also match.
  if (
    /unsupported url|nothing playable|no video formats|requested format is not available|drm protected/i.test(message)
  )
    return REASONS.nothingToPlay;
  // Removed, private, for members or Premium members only, age-restricted or blocked in this country: the site will
  // not give it.
  if (
    /video unavailable|private video|has been removed|is not available|members-only|only available to|age-restricted|confirm your age|inappropriate for some users|blocked it/i.test(
      message,
    )
  )
    return REASONS.unavailable;
  // A premiere or a live stream that has not begun.
  if (/premieres? in|premiere will begin|live event will begin/i.test(message)) return REASONS.notYet;
  if (/larger than jukecord fetches/i.test(message)) return REASONS.tooLarge;
  // The machine jukecord runs on reaches no site at all: no name server answers (the address guard says so in these
  // words), no route out, a connection refused. Before "no such site": an offline machine was told every name, even
  // youtube.com's, did not exist, and a search "could not be downloaded".
  if (
    /cannot reach the internet|EAI_AGAIN|Temporary failure in name resolution|ENETUNREACH|EHOSTUNREACH|Network is unreachable|No route to host|ECONNREFUSED|Connection refused/i.test(
      message,
    )
  )
    return REASONS.offline;
  const status = /HTTP Error (\d{3})/i.exec(message)?.[1];
  if (status) return `the site answered ${status}`;
  if (/no such site|getaddrinfo|ENOTFOUND|Name or service not known|nodename nor servname/i.test(message))
    return REASONS.noSuchSite;
  if (/nothing was found/i.test(message)) return REASONS.nothingFound;
  if (/took longer|took too long|timed out|timeout/i.test(message)) return REASONS.tooLong;
  return REASONS.failed;
}

/**
 * Whether a failure says something about the track itself that trying again will not change: removed, private,
 * members-only, age-restricted, blocked, an address with nothing playable, a file too large, a page that is gone (404,
 * 410) or withheld for legal reasons (451), an address refused as private. A failure of the network, the site's
 * servers or a time limit is not, and neither is a premiere still to come: the same track may work later.
 */
export function permanentFailure(message: string): boolean {
  const reason = plainReason(message);
  // The short reasons that describe the track; everything else describes the moment.
  const forGood: readonly string[] = [
    REASONS.unavailable,
    REASONS.nothingToPlay,
    REASONS.privateNetwork,
    REASONS.tooLarge,
    'the site answered 404',
    'the site answered 410',
    'the site answered 451',
  ];
  return forGood.includes(reason);
}
