/**
 * The panel's service worker keeps the panel's own pages and files, never the API, the audio, the logins or the health
 * checks; and the manifest makes the panel installable with icons from the mark and a share target into the queue.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { SW_SHELL, swRoute } from '../../panel/src/sw-rules.ts';

const SITE = 'https://music.example.com';
const route = (path: string, mode = 'cors', method = 'GET') => swRoute(new URL(path, SITE), method, mode, SITE);

describe('the service worker', () => {
  it("answers the panel's pages and files", () => {
    for (const page of ['/', '/stats', '/listen', '/add?url=x', '/login'])
      assert.equal(route(page, 'navigate'), 'page');
    for (const file of [
      '/app.js',
      '/style.css',
      '/theme.js',
      '/favicon.svg',
      '/manifest.webmanifest',
      '/icons/icon-192.png',
    ])
      assert.equal(route(file), 'file', file);
    assert.equal(route('/fonts/pretendard-0-AbCd.woff2'), 'font');
  });

  it('leaves the API, the audio, logging in, the health checks and other sites to the browser', () => {
    for (const path of [
      '/api/v1/guilds/local/queue',
      '/api/v1/guilds/local/tracks/3/audio?format=opus',
      '/api/v1/events',
      '/auth/listen',
      '/auth/link/abc',
      '/healthz',
      '/readyz',
      '/metrics',
      '/unknown.js',
    ]) {
      assert.equal(route(path), null, path);
      // Not even as a page.
      if (!path.startsWith('/unknown')) assert.equal(route(path, 'navigate'), null, path);
    }
    assert.equal(route('/app.js', 'cors', 'POST'), null);
    assert.equal(swRoute(new URL('https://cdn.example.com/app.js'), 'GET', 'cors', SITE), null);
  });

  it('keeps only what it answers', () => {
    for (const path of SW_SHELL) assert.notEqual(route(path, path === '/' ? 'navigate' : 'cors'), null, path);
  });
});

describe('the manifest', () => {
  const manifest = JSON.parse(fs.readFileSync('panel/manifest.webmanifest', 'utf8')) as {
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
    share_target: { action: string; method: string; params: Record<string, string> };
  };

  it('installs the panel as an app with icons of both kinds at the sizes browsers ask for, all there', () => {
    assert.equal(manifest.display, 'standalone');
    for (const purpose of ['any', 'maskable']) {
      for (const size of ['192x192', '512x512']) {
        const icon = manifest.icons.find((entry) => entry.purpose === purpose && entry.sizes === size);
        assert.ok(icon, `${purpose} ${size}`);
        assert.ok(fs.existsSync(`panel${icon.src}`), icon.src);
        // A PNG of that size: its header says so.
        const png = fs.readFileSync(`panel${icon.src}`);
        assert.equal(png.readUInt32BE(16), Number(size.split('x')[0]));
      }
    }
    assert.ok(fs.existsSync('panel/icons/apple-touch-icon.png'));
  });

  it('takes what another app shares to the page that adds it', () => {
    assert.deepEqual(manifest.share_target, {
      action: '/add',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    });
  });
});
