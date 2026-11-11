import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { VERSION } from '../../src/version.ts';

describe('version', () => {
  it('is a SemVer number', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('is the same in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    assert.equal(pkg.version, VERSION);
  });
});
