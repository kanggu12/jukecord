import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../../src/log.ts';
import {
  AddressError,
  isPrivateAddress,
  NoAnswerError,
  publicAddressesOnly,
  resolveAll,
} from '../../src/media/address.ts';
import { BusyError } from '../../src/media/busy.ts';
import { Resolver } from '../../src/media/resolver.ts';
import type { YtDlp } from '../../src/media/ytdlp.ts';
import { memoryStore } from '../support/store.ts';

describe('isPrivateAddress', () => {
  it('knows the private, loopback, link-local and shared ranges of both families', () => {
    for (const address of [
      '10.1.2.3',
      '127.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd12::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      // The same, as a URL writes it, and 127.0.0.1 likewise: these reached this machine before.
      '::ffff:a00:1',
      '::ffff:7f00:1',
      '::127.0.0.1',
      '64:ff9b::a00:1',
      '64:ff9b:1::c0a8:1',
      '2002:a00:1::',
      'ff02::1',
      'fec0::1',
      'fe80::1%eth0',
      'not-an-ip',
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of [
      '8.8.8.8',
      '172.32.0.1',
      '142.250.1.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
      '::ffff:808:808',
      '64:ff9b::808:808',
      '2002:808:808::1',
      '2a00:1450:4001::200e',
    ]) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });
});

describe('publicAddressesOnly', () => {
  it('refuses names that point inside and addresses that are not web pages, and remembers answers for ten minutes', async () => {
    let asked = 0;
    let now = 0;
    const answers: Record<string, string[]> = {
      'router.example': ['192.168.0.1'],
      'site.example': ['93.184.216.34'],
      'split.example': ['93.184.216.34', '10.0.0.5'],
    };
    const check = publicAddressesOnly(
      async (host) => {
        asked += 1;
        const found = answers[host];
        if (!found) throw new Error('ENOTFOUND');
        return found;
      },
      () => now,
    );
    await check(new URL('https://site.example/watch'));
    await assert.rejects(check(new URL('http://router.example/')), AddressError);
    // One private answer among public ones is enough to refuse.
    await assert.rejects(check(new URL('http://split.example/')), AddressError);
    await assert.rejects(check(new URL('http://127.0.0.1:8795/api/v1/me')), /private network/);
    await assert.rejects(check(new URL('http://[::1]/')), AddressError);
    // A URL writes [::ffff:127.0.0.1] as [::ffff:7f00:1]; it is this machine all the same.
    await assert.rejects(check(new URL('http://[::ffff:127.0.0.1]:8795/')), AddressError);
    await assert.rejects(check(new URL('file:///etc/passwd')), /http and https/);
    // A name that does not resolve is let through (yt-dlp says why it cannot reach it).
    await check(new URL('https://nowhere.example/'));
    const before = asked;
    await check(new URL('https://site.example/other'));
    assert.equal(asked, before, 'the answer was not remembered');
    now += 600_001;
    await check(new URL('https://site.example/other'));
    assert.equal(asked, before + 1);
  });
});

describe('Resolver limits', () => {
  it('refuses an address on a private network before yt-dlp runs, and a fifth lookup while four run', async () => {
    const store = memoryStore();
    const waiting: (() => void)[] = [];
    let runs = 0;
    const ytdlp = {
      lookup: () =>
        new Promise((resolve) => {
          runs += 1;
          waiting.push(() => resolve([]));
        }),
    } as unknown as YtDlp;
    const resolver = new Resolver({
      ytdlp,
      tracks: store.tracks,
      log: createLogger({ level: 'error', sinks: [] }),
      checkAddress: async (url) => {
        if (url.hostname === 'router.example') throw new AddressError('router.example is on a private network');
      },
    });
    await assert.rejects(resolver.resolve('http://router.example/x'), AddressError);
    assert.equal(runs, 0);
    const four = [1, 2, 3, 4].map((n) => resolver.resolve(`song ${n}`));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(resolver.resolve('song 5'), BusyError);
    for (const release of waiting) release();
    await Promise.all(four);
    // Room again once they are done.
    const fifth = resolver.resolve('song 5');
    await new Promise((resolve) => setImmediate(resolve));
    waiting.at(-1)?.();
    await fifth;
  });

  it('lets one person have two lookups running, not all four', async () => {
    const store = memoryStore();
    const waiting: (() => void)[] = [];
    const ytdlp = {
      lookup: () => new Promise((resolve) => waiting.push(() => resolve([]))),
    } as unknown as YtDlp;
    const resolver = new Resolver({ ytdlp, tracks: store.tracks, log: createLogger({ level: 'error', sinks: [] }) });
    const two = [resolver.resolve('a', undefined, 'alice'), resolver.resolve('b', undefined, 'alice')];
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(resolver.resolve('c', undefined, 'alice'), BusyError);
    // Someone else, and the host, still get in.
    const other = resolver.resolve('d', undefined, 'bob');
    const host = resolver.resolve('e');
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of waiting) release();
    await Promise.all([...two, other, host]);
    // Alice's turn again once hers are done.
    const again = resolver.resolve('f', undefined, 'alice');
    await new Promise((resolve) => setImmediate(resolve));
    waiting.at(-1)?.();
    await again;
  });

  it('lets one server have three lookups running, so another server still gets one', async () => {
    const store = memoryStore();
    const waiting: (() => void)[] = [];
    const ytdlp = {
      lookup: () => new Promise((resolve) => waiting.push(() => resolve([]))),
    } as unknown as YtDlp;
    const resolver = new Resolver({ ytdlp, tracks: store.tracks, log: createLogger({ level: 'error', sinks: [] }) });
    // Three people of one busy server, each within their own share.
    const busy = [
      resolver.resolve('a', undefined, 'alice', 'server-1'),
      resolver.resolve('b', undefined, 'bob', 'server-1'),
      resolver.resolve('c', undefined, 'carol', 'server-1'),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(resolver.resolve('d', undefined, 'dave', 'server-1'), BusyError);
    // The fourth place is left for another server.
    const other = resolver.resolve('e', undefined, 'erin', 'server-2');
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of waiting) release();
    await Promise.all([...busy, other]);
    // The busy server's share comes back once its lookups are done.
    const again = resolver.resolve('f', undefined, 'dave', 'server-1');
    await new Promise((resolve) => setImmediate(resolve));
    waiting.at(-1)?.();
    await again;
  });
});

describe('resolveAll', () => {
  // Name servers that answer each question with an error code, or the root's servers with an answer.
  const servers = (codes: { names: string; root: string | null }) => {
    const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
    return {
      resolve4: () => fail(codes.names),
      resolve6: () => fail(codes.names),
      resolveNs: () => (codes.root ? fail(codes.root) : Promise.resolve(['a.root-servers.net'])),
    } as never;
  };

  it("tells a site's broken DNS (SERVFAIL, the internet reachable) from no network", async () => {
    // A name server answered that it failed for this name, and the root's servers answer: the site's DNS is broken.
    await assert.rejects(
      resolveAll('broken.example', servers({ names: 'ESERVFAIL', root: null })),
      (error: unknown) => !(error instanceof NoAnswerError) && /does not resolve/.test(String(error)),
    );
    // A resolver in between that reaches nothing upstream (Docker's, systemd's) answers SERVFAIL for every name, the
    // root's included: no network.
    await assert.rejects(
      resolveAll('site.example', servers({ names: 'ESERVFAIL', root: 'ESERVFAIL' })),
      (error: unknown) => error instanceof NoAnswerError,
    );
    // No answer at all: no network, without asking the root.
    await assert.rejects(
      resolveAll('site.example', servers({ names: 'ETIMEOUT', root: null })),
      (error: unknown) => error instanceof NoAnswerError,
    );
  });
});
