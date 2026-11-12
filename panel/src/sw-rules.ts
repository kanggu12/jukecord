/**
 * What the panel's service worker answers, and how: only the panel's own files and pages, never the API, the audio,
 * the logins or the health checks. A page and the panel's files are asked of jukecord first (so a new version shows at
 * once, as without a worker) and taken from the worker's copy only when jukecord cannot be reached; the font's pieces,
 * whose names carry their content's hash, come from the copy when it has them.
 */

/** How the worker answers a request: the page, a panel file, a font piece, or not at all (the browser asks). */
export type SwRoute = 'page' | 'file' | 'font' | null;

// The panel's own files at the top of the site: the script, the stylesheet, the theme's first script, the icon, the
// manifest, the licence of the font.
const FILES = new Set(['/app.js', '/style.css', '/theme.js', '/favicon.svg', '/manifest.webmanifest', '/OFL.txt']);
// What is never the worker's, whatever the request: the API (the audio is under it), logging in and out, a listening
// link's way in, the health checks and the figures.
const NEVER = /^\/(api|auth|healthz|readyz|metrics)(\/|$)/;

/** How the worker answers a request (its address on this site, its method, its mode). */
export function swRoute(url: URL, method: string, mode: string, origin: string): SwRoute {
  if (method !== 'GET' || url.origin !== origin || NEVER.test(url.pathname)) return null;
  // The pages the panel draws itself (/, /stats, /logs, /login, /listen, /add): its one page, index.html.
  if (mode === 'navigate') return 'page';
  if (url.pathname.startsWith('/fonts/')) return 'font';
  if (FILES.has(url.pathname) || url.pathname.startsWith('/icons/')) return 'file';
  return null;
}

/** What the worker keeps when it is installed: the page and the files it needs to start, the icons. */
export const SW_SHELL = [
  '/',
  '/app.js',
  '/style.css',
  '/theme.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
] as const;
