/**
 * How a certificate from an authority jukecord does not trust is said (src/authorities.ts): Node's own advice to run it
 * with --use-system-ca taken out, JUKECORD_CA_FILE said in its place, and nothing added for a certificate that fails
 * for another reason (expired, made out to another name). In a file of its own: authorities.test.ts makes its process
 * trust a test authority, after which no certificate of one would fail here.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { untrustedAuthority, withAuthorityHint, withoutNodeAdvice } from '../../src/authorities.ts';
import { parseDatabaseAddress, type ServerAddress } from '../../src/store/address.ts';
import { connectionFailure } from '../../src/store/network.ts';
import { haveOpenssl, httpsServer, type TestAuthority, testAuthority } from '../support/tls.ts';

// Node's advice as Node 24 writes it after the reason (the test checks it is gone, wherever it is).
const ADVICE = '; if the root CA is installed locally, try running Node.js with --use-system-ca';

// An error with a code, as Node's TLS gives them, wrapped the way fetch wraps one ("fetch failed", the cause inside).
function failed(code: string, message: string, wrapped = false): Error {
  const error = Object.assign(new Error(message), { code });
  return wrapped ? new TypeError('fetch failed', { cause: error }) : error;
}

describe('a certificate from an authority jukecord does not trust', () => {
  it('is told by its code, down the causes, and only for an authority it cannot trace', () => {
    for (const code of [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
    ]) {
      assert.equal(untrustedAuthority(failed(code, 'x')), true, code);
      assert.equal(untrustedAuthority(failed(code, 'x', true)), true, `${code}, wrapped`);
    }
    // Expired, or made out to another name: another matter, which a file of authorities does not answer.
    assert.equal(untrustedAuthority(failed('CERT_HAS_EXPIRED', 'certificate has expired')), false);
    assert.equal(untrustedAuthority(failed('ERR_TLS_CERT_ALTNAME_INVALID', 'Hostname/IP does not match')), false);
    assert.equal(untrustedAuthority(new Error('no code')), false);
    assert.equal(untrustedAuthority('not an error'), false);
  });

  it("says JUKECORD_CA_FILE in place of Node's advice, and leaves other failures as they are", () => {
    const error = failed('UNABLE_TO_VERIFY_LEAF_SIGNATURE', `unable to verify the first certificate${ADVICE}`, true);
    const said = withAuthorityHint(`fetch failed (unable to verify the first certificate${ADVICE})`, error);
    assert.doesNotMatch(said, /use-system-ca/);
    assert.match(
      said,
      /^fetch failed \(unable to verify the first certificate\); to trust the authority that signed it, name its certificate in JUKECORD_CA_FILE$/,
    );
    // An expired certificate: Node's words, with nothing of the authorities added.
    const expired = failed('CERT_HAS_EXPIRED', 'certificate has expired');
    assert.equal(withAuthorityHint('certificate has expired', expired), 'certificate has expired');
    assert.equal(withoutNodeAdvice(`a${ADVICE} b${ADVICE}`), 'a b');
  });

  it("names both of a database's ways: its own sslrootcert, or JUKECORD_CA_FILE", () => {
    const address = parseDatabaseAddress('postgres://u:p@db.example.internal/jukecord?sslmode=verify-full', '/data');
    const refused = connectionFailure(
      failed('SELF_SIGNED_CERT_IN_CHAIN', `self-signed certificate in certificate chain${ADVICE}`),
      address as ServerAddress,
    );
    assert.ok(refused);
    assert.doesNotMatch(refused.message, /use-system-ca/);
    assert.match(
      refused.message,
      /\(see sslmode and sslrootcert in the address, or JUKECORD_CA_FILE for an authority of your own\)$/,
    );
    // An expired one: only the address's words, which are what the database's own TLS settings answer.
    const expired = connectionFailure(failed('CERT_HAS_EXPIRED', 'certificate has expired'), address as ServerAddress);
    assert.match(expired?.message ?? '', /\(see sslmode and sslrootcert in the address\)$/);
  });

  describe('from a real server', { skip: !haveOpenssl() && 'openssl is not installed' }, () => {
    let authority: TestAuthority;
    let server: { port: number; close(): Promise<void> };
    before(async () => {
      authority = testAuthority('jukecord-test-hint-ca');
      server = await httpsServer(authority, (_request, response) => response.end('ok'));
    });
    after(async () => {
      await server.close();
      authority.remove();
    });

    it("says it for fetch's own failure, as the provider's checks and the command meet it", async () => {
      const error = await fetch(`https://127.0.0.1:${server.port}/`).then(
        () => null,
        (failure: unknown) => failure,
      );
      assert.ok(error instanceof Error, 'the authority is not trusted in this process');
      assert.equal(untrustedAuthority(error), true);
      const cause = (error as Error & { cause?: Error }).cause?.message ?? '';
      const said = withAuthorityHint(`${error.message} (${cause})`, error);
      assert.doesNotMatch(said, /use-system-ca/);
      assert.match(said, /name its certificate in JUKECORD_CA_FILE$/);
    });
  });
});
