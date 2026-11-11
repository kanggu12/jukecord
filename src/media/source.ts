/**
 * What people type to add music, turned into either an address or a search, and addresses into one canonical form.
 *
 * The canonical form is the cache key and the database's unique key for a track. Without it, "youtu.be/X",
 * "youtube.com/watch?v=X&t=30" and "music.youtube.com/watch?v=X" would be three tracks with three cached files.
 */

/** A line from the add box, a slash command or the CLI, after reading. */
export type Input = { readonly kind: 'url'; readonly url: URL } | { readonly kind: 'search'; readonly query: string };

// Query parameters that only say where a link was shared from; they never change what plays.
const TRACKING = /^(utm_[a-z]+|si|feature|fbclid|gclid|ref|ref_src|igshid|pp)$/i;

// A bare host and path the way people paste them ("youtu.be/abc", "soundcloud.com/a/b"): letters and dots before
// the first slash, no spaces anywhere.
const BARE_ADDRESS = /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i;

/** Reads one line: an http(s) address (with or without the scheme), or else words to search for. */
export function parseInput(text: string): Input {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('nothing to add');
  // Add the scheme people leave out, then let URL decide whether it is an address at all.
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : BARE_ADDRESS.test(trimmed) ? `https://${trimmed}` : null;
  if (candidate !== null) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'url', url };
    } catch {
      // Not a valid address after all: fall through and search for the text as typed.
    }
  }
  // Search words are capped: a pasted paragraph is a mistake, and the site would reject it anyway.
  return { kind: 'search', query: trimmed.slice(0, 200) };
}

// The 11-character video ID YouTube uses; anything else in that place is not a video.
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The YouTube video ID of an address, or null when it is not a YouTube video address. */
export function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [, first, second] = url.pathname.split('/');
    // watch?v=ID is the common form; shorts/, live/, embed/ and v/ carry the ID in the path.
    if (first === 'watch') id = url.searchParams.get('v');
    else if (first && ['shorts', 'live', 'embed', 'v'].includes(first)) id = second ?? null;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

/** Whether an address is a playlist page that should add all of its tracks. */
export function isPlaylistAddress(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  // A watch address with a list= is one video played from a playlist; people pasting it mean that video.
  if (host === 'youtube.com' && url.pathname === '/playlist' && url.searchParams.has('list')) return true;
  // SoundCloud sets are its playlists.
  if (host === 'soundcloud.com' && /^\/[^/]+\/sets\/[^/]+/.test(url.pathname)) return true;
  return false;
}

/**
 * The canonical form of a track's address.
 *
 * YouTube videos become https://www.youtube.com/watch?v=ID (no playlist, start time or share tag). Other addresses
 * keep their path and meaningful query, lose the fragment and tracking parameters, and get a lower-case host.
 */
export function canonicalSource(url: URL): string {
  const id = youtubeVideoId(url);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  const copy = new URL(url.href);
  copy.hash = '';
  copy.hostname = copy.hostname.toLowerCase();
  for (const key of [...copy.searchParams.keys()]) if (TRACKING.test(key)) copy.searchParams.delete(key);
  // URL keeps "?" after the last parameter is removed; drop it so the same page always has the same key.
  return copy.href.replace(/\?$/, '');
}
