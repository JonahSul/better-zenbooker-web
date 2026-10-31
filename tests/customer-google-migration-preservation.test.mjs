import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';

const base = process.env.TEST_CUSTOMER_GOOGLE_MIGRATION_BASE_URL ?? '';
const token = process.env.TEST_CUSTOMER_GOOGLE_MIGRATION_TOKEN ?? '';
const config = process.env.TEST_CUSTOMER_GOOGLE_MIGRATION_CONFIG ?? '';
const persist = process.env.TEST_CUSTOMER_GOOGLE_MIGRATION_PERSIST ?? '';
const dbName = process.env.TEST_CUSTOMER_GOOGLE_MIGRATION_NAME ?? '';
const phase = process.env.TEST_CUSTOMER_GOOGLE_MIGRATION_PHASE ?? '';
const parsed = base ? new URL(base) : null;
const enabled = !!parsed && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  && parsed.port === '8801' && !!token
  && /\.sites-runtime\/customer-google-migration-fixture\/wrangler\.json$/i.test(config.replaceAll('\\', '/'))
  && /\.wrangler\/customer-google-migration-local-01$/i.test(persist.replaceAll('\\', '/'))
  && dbName === 'site-creator-d1'
  && ['seed', 'verify'].includes(phase);

if (base && !enabled) throw new Error('Migration preservation tests require their exact fresh loopback fixture, persist path, and phase.');

const seedPath = path.resolve('.sites-runtime/customer-google-migration-fixture/legacy-seed.json');

async function call(action, body = {}) {
  const response = await fetch(`${base}/__qa/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Customer-Google-Migration': token, Connection: 'close' },
    body: JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Migration fixture returned non-JSON for ${action} (${response.status}).`); }
  return { status: response.status, result };
}

test(`legacy customer Google encrypted records migration ${phase || 'proof'}`, {
  skip: !enabled && 'Set the exact TEST_CUSTOMER_GOOGLE_MIGRATION_* variables for the staged local migration fixture.',
}, async () => {
  if (phase === 'seed') {
    const now = Date.now();
    const response = await call('seed-legacy', { now });
    assert.equal(response.status, 200);
    assert.equal(response.result.seeded, true);
    assert.equal(response.result.migrations, 27, 'seed runs after exactly migrations 0000 through 0026');
    assert.deepEqual(response.result.snapshot && {
      stateCount: response.result.snapshot.stateCount,
      sessionCount: response.result.snapshot.sessionCount,
      credentialPresent: response.result.snapshot.credentialPresent,
      credentialStatePresent: response.result.snapshot.credentialStatePresent,
    }, { stateCount: 2, sessionCount: 1, credentialPresent: true, credentialStatePresent: true });
    await mkdir(path.dirname(seedPath), { recursive: true });
    await writeFile(seedPath, JSON.stringify({
      now,
      state: response.result.state,
      verifier: response.result.verifier,
      token: response.result.token,
      fingerprint: response.result.fingerprint,
      digest: response.result.snapshot.digest,
    }), { encoding: 'utf8', flag: 'wx' });
    return;
  }

  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  const response = await call('verify-legacy', {
    now: seed.now,
    pendingState: seed.state,
    expectedVerifier: seed.verifier,
    sessionToken: seed.token,
    beforeDigest: seed.digest,
  });
  assert.equal(response.status, 200);
  const result = response.result;
  assert.equal(result.migrations, 29, 'the actual 0027 and 0028 migrations were applied after seeding');
  assert.equal(result.preservedBeforeReads, true, 'all preexisting customer Google fields and fake encrypted Zenbooker credential bytes match their pre-migration digest');
  assert.deepEqual(result.counts, { states: 2, sessions: 1 });
  assert.equal(result.legacyCredentialPreserved, true, 'the fake encrypted credential and its state remain readable at the same revision');
  assert.equal(result.migratedColumnsPresent, true);
  assert.equal(result.sessionReadable, true);
  assert.equal(result.syntheticProfileMatches, true);
  assert.equal(result.legacyPurposeDefaultsToBooking, true);
  assert.equal(result.pendingIntentPreserved, true);
  assert.equal(result.stateReadable, true);
  assert.equal(result.pendingStatePurposeDefaultsToBooking, true);
  assert.equal(result.stateReturnContextFallsBack, true);
  assert.equal(result.verifierDecrypts, true);
  assert.equal(result.intentConsumableOnce, true);
  assert.equal(JSON.stringify(result).includes('Synthetic Legacy Customer'), false);
  assert.equal(JSON.stringify(result).includes('legacy-customer@example.invalid'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-zenbooker-api-key-fixture-only'), false);
  await unlink(seedPath);
});
