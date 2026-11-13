import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { encryptTokens, decryptTokens, randomToken, sha256, timingSafeEqual } from '../src/crypto.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
test('token encryption round trips with fresh nonces and host binding', async () => {
  const value = { access_token: 'secret-access', refresh_token: 'secret-refresh', expires_at: 12345 };
  const first = await encryptTokens(value, key, 'host-a');
  const second = await encryptTokens(value, key, 'host-a');
  assert.notEqual(first, second);
  assert.ok(!first.includes('secret'));
  assert.deepEqual(await decryptTokens(first, key, 'host-a'), value);
  await assert.rejects(decryptTokens(first, key, 'host-b'), /Unable to decrypt/);
  const parts = first.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await assert.rejects(decryptTokens(parts.join('.'), key, 'host-a'), /Unable to decrypt/);
  await assert.rejects(decryptTokens(first, btoa('short'), 'host-a'), /Invalid token encryption key/);
});
test('random tokens and PKCE digests use base64url and fixed digest comparison', async () => {
  const a = randomToken(), b = randomToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a, b);
  assert.equal(await sha256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(await timingSafeEqual(a, a), true);
  assert.equal(await timingSafeEqual(a, b), false);
  assert.equal(await timingSafeEqual(a, ''), false);
});
