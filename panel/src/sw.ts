/**
 * The panel's service worker: what makes jukecord installable as an app, and what opens its page when jukecord cannot
 * be reached (the page then says it is not answering and tries again, instead of the browser's error).
 *
 * It keeps only the panel's own files (sw-rules.ts) and asks jukecord for each first, so an update shows as it does
 * without a worker: the panel's "updated: reload" message stays the way a new version is taken. Each build is a new
 * worker (its copy's name carries the build), which drops the old copy when it takes over.
 */
import { SW_SHELL, swRoute } from './sw-rules.ts';

// The build this worker belongs to, set by scripts/build-panel.ts: a new build is a new worker with a new copy.
declare const BUILD: string;
const COPY = `jukecord-panel-${BUILD}`;

// The worker's own scope, typed as what it is (the panel's TypeScript knows the page, not the worker).
const worker = self as unknown as {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: Location;
};
interface ExtendableEvent {
  waitUntil(work: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(answer: Promise<Response>): void;
}

// Installed: the page and the files it starts with, asked fresh (not from the browser's cache), are kept.
worker.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .open(COPY)
      .then((copy) => copy.addAll(SW_SHELL.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => worker.skipWaiting()),
  );
});

// Taking over: the copies of older builds go.
worker.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== COPY).map((name) => caches.delete(name))))
      .then(() => worker.clients.claim()),
  );
});

// Asks jukecord, keeps what it answered, and gives the copy only when jukecord cannot be reached.
async function fresh(request: Request, key: string): Promise<Response> {
  const copy = await caches.open(COPY);
  try {
    const answer = await fetch(request);
    if (answer.ok) await copy.put(key, answer.clone());
    return answer;
  } catch (error) {
    const kept = await copy.match(key);
    if (kept) return kept;
    throw error;
  }
}

// A font piece: the copy when it has it (its name changes with its content), else asked and kept.
async function kept(request: Request): Promise<Response> {
  const copy = await caches.open(COPY);
  const found = await copy.match(request);
  if (found) return found;
  const answer = await fetch(request);
  if (answer.ok) await copy.put(request, answer.clone());
  return answer;
}

worker.addEventListener('fetch', (event: FetchEvent) => {
  const request = event.request;
  const route = swRoute(new URL(request.url), request.method, request.mode, worker.location.origin);
  // Anything else is the browser's to ask, as if there were no worker.
  if (route === null) return;
  // Every page is the panel's one page: kept as "/".
  if (route === 'page') event.respondWith(fresh(request, '/'));
  else if (route === 'font') event.respondWith(kept(request));
  else event.respondWith(fresh(request, new URL(request.url).pathname));
});
