import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadCore() {
  const encryptedSource = await readFile(path.join(root, 'lib/encrypted-value.ts'), 'utf8');
  const encryptedJs = ts.transpileModule(encryptedSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const encryptedModule = { exports: {} };
  new Function('require', 'module', 'exports', encryptedJs)(() => { throw new Error('No encrypted-value imports expected'); }, encryptedModule, encryptedModule.exports);
  const source = await readFile(path.join(root, 'lib/google-reviews-core.ts'), 'utf8');
  const budgetSource = await readFile(path.join(root, 'lib/input-budget.ts'), 'utf8');
  const budgetJs = ts.transpileModule(budgetSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const budgetModule = { exports: {} };
  new Function('require', 'module', 'exports', budgetJs)(() => { throw new Error('Unexpected input-budget import'); }, budgetModule, budgetModule.exports);
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === './encrypted-value') return encryptedModule.exports;
    if (specifier === './input-budget') return budgetModule.exports;
    if (specifier === './site-config') {
      return { DEMO_ORIGIN: 'https://demo.example.test' };
    }
    if (specifier === 'zod/v3') return require('zod/v3');
    throw new Error(`Unexpected import in Google reviews core: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(requireMock, module, module.exports);
  return module.exports;
}

const core = await loadCore();
const encryptionKey = Buffer.alloc(32, 0x5a).toString('base64');
const config = {
  clientId: 'qa-client.apps.googleusercontent.com',
  clientSecret: 'qa-secret',
  encryptionKey,
};
const runtime = {
  GOOGLE_BUSINESS_CLIENT_ID: config.clientId,
  GOOGLE_BUSINESS_CLIENT_SECRET: config.clientSecret,
  GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY: encryptionKey,
  GOOGLE_BUSINESS_OWNER_USER_ID: 'site-owner-a',
  GOOGLE_BUSINESS_API_ACCESS_APPROVED: 'true',
};

test('Google integration config fails closed unless all credentials and API approval are valid', () => {
  assert.equal(core.googleConfig({}), null);
  assert.equal(core.googleConfig({ ...runtime, GOOGLE_BUSINESS_API_ACCESS_APPROVED: 'false' }), null);
  assert.equal(core.googleConfig({ ...runtime, GOOGLE_BUSINESS_CLIENT_ID: 'GTM-THR2KRPF' }), null);
  assert.equal(core.googleConfig({ ...runtime, GOOGLE_BUSINESS_CLIENT_SECRET: '' }), null);
  assert.equal(core.googleConfig({ ...runtime, GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY: 'not-a-key' }), null);
  assert.equal(core.googleConfig({ ...runtime, GOOGLE_BUSINESS_OWNER_USER_ID: '' }), null);
  assert.deepEqual(core.googleConfig(runtime), { ...config, ownerUserId: 'site-owner-a' });
});

test('refresh tokens encrypt at rest, bind to one Site user, and reject tampering', async () => {
  const token = 'refresh-token-fixture-do-not-use';
  const encrypted = await core.encryptRefreshToken(token, 'site-owner-a', encryptionKey);
  assert.match(encrypted, /^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]+=*$/);
  assert.equal(encrypted.includes(token), false);
  assert.equal(await core.decryptRefreshToken(encrypted, 'site-owner-a', encryptionKey), token);
  await assert.rejects(core.decryptRefreshToken(encrypted, 'site-owner-b', encryptionKey), { code: 'reauthorization_required' });
  const pieces = encrypted.split('.');
  pieces[2] = `${pieces[2][0] === 'A' ? 'B' : 'A'}${pieces[2].slice(1)}`;
  await assert.rejects(core.decryptRefreshToken(pieces.join('.'), 'site-owner-a', encryptionKey), { code: 'reauthorization_required' });
});

test('OAuth state is hashed and authorization URLs use fixed Google scope and callback', async () => {
  const state = 'random-one-time-state-fixture';
  const hash = await core.hashState(state);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, state);
  assert.equal(await core.hashState(state), hash);

  const url = new URL(core.authorizationUrl(config, state));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), config.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://demo.example.test/api/google-reviews/oauth-callback');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/business.manage');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('state'), state);
});

test('normalization preserves the provider rating and count without rounding or invented values', () => {
  const normalized = core.normalizeReviews({
    averageRating: 4.95,
    totalReviewCount: 37,
    reviews: [{
      reviewId: 'review-fixture-1',
      reviewer: { displayName: 'Fixture Reviewer' },
      starRating: 'FIVE',
      comment: '<script>alert(1)</script> genuine provider text stays text',
      updateTime: '2026-09-01T12:30:00Z',
    }],
  });
  assert.equal(normalized.averageRating, 4.95);
  assert.equal(normalized.totalReviewCount, 37);
  assert.equal(normalized.fiveStar, false);
  assert.equal(normalized.reviews[0].rating, 5);
  assert.equal(normalized.reviews[0].author, 'Fixture Reviewer');
  assert.equal(normalized.reviews[0].text, '<script>alert(1)</script> genuine provider text stays text');
  assert.equal(normalized.reviews[0].date, '2026-09-01T12:30:00Z');
  assert.equal(core.normalizeReviews({}).averageRating, null);
  assert.equal(core.normalizeReviews({}).totalReviewCount, null);
});

test('invalid provider review payloads are rejected instead of replaced with sample content', () => {
  assert.throws(() => core.normalizeReviews({ averageRating: 5.2, reviews: [] }), { code: 'invalid_provider_response' });
  assert.throws(() => core.normalizeReviews({ reviews: [{ reviewId: 'bad', starRating: 'SIX' }] }), { code: 'invalid_provider_response' });
});

test('location source links allow only HTTPS Google Maps domains', () => {
  assert.equal(core.safeMapsUrl('https://maps.google.com/maps?cid=123'), 'https://maps.google.com/maps?cid=123');
  assert.equal(core.safeMapsUrl('https://www.google.com/maps/place/example'), 'https://www.google.com/maps/place/example');
  for (const value of ['http://maps.google.com/example', 'https://google.example/maps', 'javascript:alert(1)', 'https://attacker.example/?next=https://maps.google.com']) {
    assert.equal(core.safeMapsUrl(value), null, value);
  }
});

test('review API adapter makes a fixed GET and passes through a 4.95 rating unchanged', async () => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ averageRating: 4.95, totalReviewCount: 20, reviews: [] });
  };
  const result = await core.fetchReviews('access-token-fixture', 'accounts/123', 'locations/456', fetcher);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews?pageSize=50&orderBy=updateTime%20desc');
  assert.equal(requests[0].init.method, undefined, 'review retrieval must use GET');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer access-token-fixture');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.equal(result.averageRating, 4.95);
  assert.equal(result.fiveStar, false);
  assert.equal(requests[0].url.includes('access-token-fixture'), false);
  await assert.rejects(core.fetchReviews('token', 'accounts/123?x=1', 'locations/456', fetcher), { code: 'invalid_selection' });
});

test('Business Profile OAuth exchange and revocation reject redirects without forwarding credentials', async () => {
  const requests = [];
  const redirectTarget = 'https://redirect-target.invalid/token?secret=must-not-be-forwarded';
  await assert.rejects(core.exchangeCode(config, 'one-time-code-fixture', async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 302, headers: { Location: redirectTarget } });
  }), error => error.code === 'provider_unavailable');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(requests[0].init), /redirect-target|must-not-be-forwarded/);

  requests.length = 0;
  const revoked = await core.revokeToken('fixture-refresh-token', async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 302, headers: { Location: redirectTarget } });
  });
  assert.equal(revoked, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(requests[0].init.redirect, 'manual');

  const successful = await core.revokeToken('fixture-refresh-token', async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 200 });
  });
  assert.equal(successful, true);
});

test('account and location discovery use only fixed read endpoints and validated provider resources', async () => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith('https://mybusinessaccountmanagement.googleapis.com/')) {
      return Response.json({ accounts: [{ name: 'accounts/123' }] });
    }
    return Response.json({ locations: [{
      name: 'locations/456',
      title: 'Verified Fixture Listing',
      metadata: { mapsUri: 'https://maps.google.com/maps?cid=456' },
    }] });
  };
  const result = await core.discoverLocations('access-token-fixture', fetcher);
  assert.equal(result.locations.length, 1);
  assert.equal(result.locations[0].accountName, 'accounts/123');
  assert.equal(result.locations[0].locationName, 'locations/456');
  assert.equal(result.locations[0].title, 'Verified Fixture Listing');
  assert.equal(result.locations[0].mapsUrl, 'https://maps.google.com/maps?cid=456');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ init }) => init.method === undefined), 'all Business Profile discovery operations must be GET requests');
  assert.ok(requests[0].url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?'));
  assert.ok(requests[1].url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations?'));
});

test('review UI source contains no self-serving review or aggregate-rating schema', async () => {
  const files = await Promise.all([
    readFile(path.join(root, 'components/reviews.tsx'), 'utf8'),
    readFile(path.join(root, 'app/page.tsx'), 'utf8'),
    readFile(path.join(root, 'lib/discovery.ts'), 'utf8'),
    readFile(path.join(root, 'components/trustindex-reviews.tsx'), 'utf8'),
  ]);
  for (const source of files) assert.doesNotMatch(source, /AggregateRating|"@type"\s*:\s*"Review"/);
  const display = files[0];
  assert.match(display, /Reviews are displayed only when the business connects a supported source/);
  assert.match(display, /<TrustindexReviews\s*\/>/);
  assert.doesNotMatch(display, /dangerouslySetInnerHTML/);
  assert.match(files[3], /sandbox="allow-scripts allow-popups"/);
  assert.match(files[3], /referrerPolicy="no-referrer"/);
});
