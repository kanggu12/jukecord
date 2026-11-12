/**
 * The panel's live connection as jukecord turns it away (1013, full): when it knocks again.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

// The panel's module, loaded as the test runs: it is the browser's code (window, WebSocket), type-checked with the
// panel's own settings (panel/tsconfig.json), which a static import would bring into the server's check without them.
const { Live } = (await import(new URL('../../panel/src/live.ts', import.meta.url).href)) as {
  Live: new (handlers: unknown) => { show(guild: string): void };
};

// What the panel's browser globals were before a test stood in for them.
const browserGlobals = globalThis as Record<string, unknown>;
const saved = { window: browserGlobals.window, location: browserGlobals.location, WebSocket: browserGlobals.WebSocket };
const random = Math.random;
afterEach(() => {
  Object.assign(globalThis, saved);
  Math.random = random;
});

// A browser that records its sockets and the waits the panel sets, and runs none of them.
function browser() {
  const sockets: { onclose: ((event: { code: number; reason: string }) => void) | null }[] = [];
  const waits: number[] = [];
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    binaryType = '';
    url: string;
    onopen = null;
    onmessage = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send() {}
    close() {}
  }
  Object.assign(globalThis, {
    WebSocket: FakeSocket,
    location: { protocol: 'http:', host: 'jukecord.example' },
    window: {
      setTimeout: (_fn: () => void, ms: number) => waits.push(ms),
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    },
  });
  return { sockets, waits };
}

describe("the panel's live connection", () => {
  it('knocks again no sooner than the fifteen seconds jukecord gives the tabs it asks whether they are still there', () => {
    const { sockets, waits } = browser();
    // The shortest share each panel draws.
    Math.random = () => 0;
    const handlers = new Proxy({}, { get: () => () => {} });
    const live = new Live(handlers);
    live.show('100000000000000001');
    // Turned away: jukecord is full. It asks the tabs that hold the places whether they are there, and closes the ones
    // that do not answer within fifteen seconds (src/web/events.ts): a knock before then finds no room again.
    sockets[0]?.onclose?.({ code: 1013, reason: 'jukecord is full' });
    assert.ok((waits.at(-1) ?? 0) >= 15_000, `knocked again after ${waits.at(-1)} ms`);
  });
});
