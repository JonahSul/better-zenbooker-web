import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptValue, encryptValue } from '../lib/encrypted-value.ts';

const fixtureKey = Buffer.alloc(32, 0x5a).toString('base64');
const syntheticSecret = 'fixture-only-not-a-real-oauth-secret';
const projectAad = 'app-credential:v1:fixture-project:ADMIN_GOOGLE_CLIENT_SECRET';

test('credential values use randomized AES-GCM ciphertext and decrypt only with matching key and AAD', async () => {
  const first = await encryptValue(syntheticSecret, projectAad, fixtureKey);
  const second = await encryptValue(syntheticSecret, projectAad, fixtureKey);

  assert.match(first, /^v1\.[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*$/);
  assert.notEqual(first, second, 'encryption must use a fresh nonce');
  assert.equal(first.includes(syntheticSecret), false);
  assert.equal(await decryptValue(first, projectAad, fixtureKey), syntheticSecret);
  await assert.rejects(decryptValue(first, `${projectAad}:other-project`, fixtureKey));
  await assert.rejects(decryptValue(first, projectAad, Buffer.alloc(32, 0x6b).toString('base64')));
});

test('malformed and modified ciphertexts fail closed without returning secret material', async () => {
  const encrypted = await encryptValue(syntheticSecret, projectAad, fixtureKey);
  const [version, nonce, ciphertext] = encrypted.split('.');
  const tampered = `${version}.${nonce}.${ciphertext.slice(0, -2)}AA`;

  await assert.rejects(decryptValue('plaintext', projectAad, fixtureKey));
  await assert.rejects(decryptValue(tampered, projectAad, fixtureKey));
});
