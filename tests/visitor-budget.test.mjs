import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secret = 'qa-only-admission-context-secret-32-bytes-minimum';
const bearerToken = '12'.repeat(32);
const verifier = createHash('sha256').update(bearerToken).digest('hex');
const model = '@cf/openai/gpt-oss-20b';
const body = JSON.stringify({
  messages: [{ role: 'user', content: 'Where can I find current availability?' }],
  tools: [],
  max_tokens: 200,
});
const now = Date.now();
const session = 'ab'.repeat(32);
const securitySubject = '71'.repeat(32);
const expectedBudgetSchema = '64A22D36010041A6B111ABBA38195E442AB4288D29096D97CDF1F89B256F5168';

const workerSource = `
import { handleVisitorAi } from ${JSON.stringify(path.join(root, 'integrations/visitor-ai/worker.ts'))};
let calls = 0;
let imageInfoCalls = 0;
let imageTransformCalls = 0;
const ai = { async run(_model, input) { calls++; if(input.messages?.[0]?.content === 'synthetic timeout') throw new Error('synthetic timeout'); return {choices:[{message:{content:'synthetic response'}}],usage:{prompt_tokens:12,completion_tokens:7,total_tokens:19}}; } };
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/__qa/calls') return Response.json({calls,imageInfoCalls,imageTransformCalls});
  const images={async info(){imageInfoCalls++;return {width:1,height:1,format:'png'};},input(){return {transform(){return {output:async()=>{imageTransformCalls++;return {response:()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/webp'}})};}};}};}};
  return handleVisitorAi(request, ai, env.VISITOR_AI_BEARER_VERIFIER, images, env);
} };
`;

async function fixture(t, pricing = {}) {
  const schema = await readFile(path.join(root, 'drizzle/0035_visitor_budget.sql'), 'utf8');
  assert.equal(createHash('sha256').update(schema).digest('hex').toUpperCase(), expectedBudgetSchema,
    'D1 proof is pinned to the schema revision approved for the empty helper database');
  const bundled = await build({
    stdin: { contents: workerSource, resolveDir: root, sourcefile: 'visitor-budget-fixture.ts', loader: 'ts' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['node:net'],
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    script: bundled.outputFiles[0].text,
    modules: true,
    compatibilityDate: '2026-05-22',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { GUARD_DB: `visitor-budget-${randomUUID()}` },
    bindings: {
      VISITOR_AI_BEARER_VERIFIER: verifier,
      VISITOR_AI_CONTEXT_KEY: secret,
      VISITOR_AI_INSTALLATION_ID: 'qa-installation',
      VISITOR_AI_POLICY_REVIEWED_UNTIL: pricing.reviewedUntil ?? '2035-01-01T00:00:00.000Z',
      VISITOR_AI_OUTPUT_BOUND_VERIFIED: pricing.outputBoundVerified ?? 'true',
    },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('GUARD_DB');
  let statement = '';
  let inTrigger = false;
  for (const line of schema.split(/\r?\n/)) {
    if (!line.trim()) continue;
    statement += `${line}\n`;
    if (/^\s*CREATE TRIGGER\b/i.test(line)) inTrigger = true;
    if ((!inTrigger && /;\s*$/.test(line)) || (inTrigger && /^\s*END;\s*$/.test(line))) {
      await db.prepare(statement).run();
      statement = '';
      inTrigger = false;
    }
  }
  assert.equal(statement.trim(), '', 'all budget schema statements were applied');
  const base = 'https://visitor-budget.test';
  const counters = async () => (await (await mf.dispatchFetch(base + '/__qa/calls')).json());
  const callCount = async () => (await counters()).calls;
  const send = async (token, rawBody = body) => mf.dispatchFetch(base + '/infer', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
      ...(token ? { 'X-Visitor-Admission': token } : {}),
    },
    body: rawBody,
  });
  const sendImage = async (token, rawBytes) => mf.dispatchFetch(base + '/images/normalize', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'image/png', ...(token ? { 'X-Visitor-Admission': token } : {}) },
    body: rawBytes,
  });
  return { mf, send, sendImage, counters, callCount, db };
}

async function modules() {
  const bundled = await build({
    entryPoints: [path.join(root, 'lib/visitor-budget-core.ts'), path.join(root, 'lib/visitor-budget-store.ts'), path.join(root, 'lib/visitor-budget-session.ts'), path.join(root, 'lib/visitor-image-admission.ts'), path.join(root, 'lib/visitor-abuse-store.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outdir: 'out',
  });
  const loaded = {};
  for (const output of bundled.outputFiles) {
    const module = await import(`data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}`);
    loaded[path.basename(output.path)] = module;
  }
  return loaded;
}

const core = await modules();
const budgetCore = core['visitor-budget-core.js'];
const budgetStoreModule = core['visitor-budget-store.js'];
const sessionStoreModule = core['visitor-budget-session.js'];
const imageAdmissionModule = core['visitor-image-admission.js'];
const abuseStoreModule = core['visitor-abuse-store.js'];

const installation = 'qa-installation';
const sessionIssuedAt = now - 1_000;
const sessionExpiresAt = sessionIssuedAt + 86_400_000;
async function admission({ requestKey = randomUUID(), purpose = 'visitor_text', modelName = model, sessionId = session, subjectId = securitySubject, rawBody = body, issuedAt = now, expiresAt = now + 30_000, policy = budgetCore.BUDGET_POLICY_VERSION, installationId = installation, sessionStart = sessionIssuedAt, sessionEnd = sessionExpiresAt } = {}) {
  const context = {
    installation: installationId,
    securitySubject: subjectId,
    version: 1,
    policy,
    session: sessionId,
    sessionIssuedAt: sessionStart,
    sessionExpiresAt: sessionEnd,
    requestKey,
    purpose,
    model: modelName,
    bodyDigest: await budgetCore.budgetDigest(rawBody),
    issuedAt,
    expiresAt,
  };
  return { context, token: await budgetCore.signBudgetContext(context, secret) };
}

test('signed admission context binds model, payload, session, purpose, request key, policy and time', async () => {
  const { token, context } = await admission();
  assert.deepEqual(await budgetCore.verifyBudgetContext(token, secret, body, model, now, installation), context);
  const mutations = [
    { ...context, version: 2 },
    { ...context, policy: 'other-policy' },
    { ...context, installation: 'other-installation' },
    { ...context, session: 'cd'.repeat(32) },
    { ...context, securitySubject: '72'.repeat(32) },
    { ...context, sessionIssuedAt: context.sessionIssuedAt - 1 },
    { ...context, sessionExpiresAt: context.sessionExpiresAt - 1 },
    { ...context, requestKey: randomUUID() },
    { ...context, purpose: 'operator_diagnostic' },
    { ...context, model: `${model}-other` },
    { ...context, bodyDigest: 'ef'.repeat(32) },
    { ...context, issuedAt: context.issuedAt - 1 },
    { ...context, expiresAt: context.expiresAt - 1 },
  ];
  for (const changed of mutations) {
    const [payload, mac] = token.split('.');
    const original = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const forged = `${Buffer.from(JSON.stringify({ ...original, ...changed })).toString('base64')}.${mac}`;
    await assert.rejects(budgetCore.verifyBudgetContext(forged, secret, body, model, now, installation), /Admission invalid/);
  }
  await assert.rejects(budgetCore.verifyBudgetContext(token, secret, body + ' ', model, now, installation), /Admission invalid/);
  await assert.rejects(budgetCore.verifyBudgetContext(token, 'different-admission-key-that-is-long-enough', body, model, now, installation), /Admission invalid/);
  await assert.rejects(budgetCore.verifyBudgetContext(token, secret, body, model, now, 'other-installation'), /Admission invalid/);
  await assert.rejects(budgetCore.verifyBudgetContext(token, secret, body, model, context.expiresAt, installation), /Admission invalid/);
  const future = await admission({ issuedAt: now + 5001, expiresAt: now + 30_001 });
  await assert.rejects(budgetCore.verifyBudgetContext(future.token, secret, body, model, now, installation), /Admission invalid/);
});

test('pricing reserves full text and vision contexts with a margin and fails closed when review or usage bounds expire', () => {
  const policy = { reviewedUntil: '2035-01-01T00:00:00.000Z', outputBoundVerified: 'true' };
  const text = budgetCore.worstCaseMicros(model, policy, now);
  const vision = budgetCore.worstCaseMicros('@cf/moondream/moondream3.1-9B-A2B', policy, now);
  assert.ok(Number.isSafeInteger(text) && text > 0 && text <= 500_000);
  assert.ok(Number.isSafeInteger(vision) && vision > 0 && vision <= 500_000);
  assert.throws(() => budgetCore.worstCaseMicros(model, { ...policy, reviewedUntil: '2020-01-01T00:00:00.000Z' }, now), error => error.reason === 'pricing');
  assert.throws(() => budgetCore.worstCaseMicros(model, { ...policy, outputBoundVerified: 'false' }, now), error => error.reason === 'pricing');
  assert.throws(() => budgetCore.worstCaseMicros(model, { reviewedUntil: '', outputBoundVerified: 'true' }, now), error => error.reason === 'pricing');
  assert.throws(() => budgetCore.worstCaseMicros('@cf/openai/unreviewed-model', policy, now), error => error.reason === 'pricing');
});

test('visitor inference denies bearer-only, stale pricing, and wrong purpose before any model call', async t => {
  const f = await fixture(t);
  const bearerOnly = await f.send(null);
  assert.equal(bearerOnly.status, 429);
  const stalePricing = await fixture(t, { reviewedUntil: '2020-01-01T00:00:00.000Z' });
  const stalePriceContext = await admission();
  assert.equal((await stalePricing.send(stalePriceContext.token)).status, 429);
  assert.equal(await stalePricing.callCount(), 0);
  const unknownModel = await admission({ modelName: '@cf/openai/unreviewed-model' });
  assert.equal((await f.send(unknownModel.token)).status, 429, 'a valid issuer signature cannot select an unreviewed model');
  assert.equal(await f.callCount(), 0);
  const signed = await admission();
  assert.equal((await f.send(signed.token)).status, 200);
  const wrongPurpose = await admission({ purpose: 'visitor_vision' });
  const purposeDenied = await f.send(wrongPurpose.token);
  assert.equal(purposeDenied.status, 429);
  const wrongBody = await f.send(signed.token, body + ' ');
  assert.equal(wrongBody.status, 429);
  assert.equal(await f.callCount(), 1, 'only the correctly signed, correctly scoped first request reached AI');
});

function countedImages(calls) {
  return {
    async info(stream) { calls.info++; await new Response(stream).arrayBuffer(); return { width: 1, height: 1, format: 'png' }; },
    input() { return { transform() { return { output: async () => { calls.transform++; return { response: () => new Response(new Uint8Array([1, 2, 3])) }; } }; } }; },
  };
}

async function invokeImageAdmission(f, context, rawBytes, calls) {
  const token = await budgetCore.signBudgetContext(context, secret);
  const request = new Request('https://visitor-budget.test/images/normalize', {
    method: 'POST', headers: { 'X-Visitor-Admission': token }, body: rawBytes,
  });
  const admitted = await imageAdmissionModule.admittedImages(request, {
    GUARD_DB: f.db,
    VISITOR_AI_CONTEXT_KEY: secret,
    VISITOR_AI_INSTALLATION_ID: installation,
  }, countedImages(calls));
  await admitted.images.info(new Response(rawBytes).body);
  await admitted.images.input(new Response(rawBytes).body).transform({ width: 1, height: 1, fit: 'scale-down' }).output({ format: 'image/webp', quality: 80, anim: false });
  await admitted.complete();
  return token;
}

test('image normalization denies bearer-only and raw-byte tampering before image inspection or transform', async t => {
  const f = await fixture(t);
  const bytes = Uint8Array.from([0, 255, 1, 13, 10]);
  const bearerOnly = await f.sendImage(null, bytes);
  assert.equal(bearerOnly.status, 429);
  const counters = await f.counters();
  assert.equal(counters.imageInfoCalls, 0);
  assert.equal(counters.imageTransformCalls, 0);

  const context = (await admission({ purpose: 'visitor_images', modelName: budgetCore.IMAGES_ADMISSION_MODEL, rawBody: bytes })).context;
  const tampered = Uint8Array.from([0, 255, 1, 13, 11]);
  const calls = { info: 0, transform: 0 };
  const token = await budgetCore.signBudgetContext(context, secret);
  const request = new Request('https://visitor-budget.test/images/normalize', { method: 'POST', headers: { 'X-Visitor-Admission': token }, body: tampered });
  await assert.rejects(imageAdmissionModule.admittedImages(request, {
    GUARD_DB: f.db, VISITOR_AI_CONTEXT_KEY: secret, VISITOR_AI_INSTALLATION_ID: installation,
  }, countedImages(calls)));
  assert.deepEqual(calls, { info: 0, transform: 0 });
  const daily = await f.db.prepare('SELECT calls FROM image_transform_daily').first();
  assert.equal(daily, null, 'tampered raw bytes consume no transform attempt');
});

test('the image ledger shares 100 transforms across sessions, binds replays, and does not debit the AI wallet', async t => {
  const f = await fixture(t);
  const bytes = Uint8Array.from([0, 1, 2, 255]);
  const calls = { info: 0, transform: 0 };
  const firstContext = (await admission({ purpose: 'visitor_images', modelName: budgetCore.IMAGES_ADMISSION_MODEL, rawBody: bytes })).context;
  const token = await invokeImageAdmission(f, firstContext, bytes, calls);
  const replayRequest = new Request('https://visitor-budget.test/images/normalize', { method: 'POST', headers: { 'X-Visitor-Admission': token }, body: bytes });
  const replay = await imageAdmissionModule.admittedImages(replayRequest, { GUARD_DB: f.db, VISITOR_AI_CONTEXT_KEY: secret, VISITOR_AI_INSTALLATION_ID: installation }, countedImages(calls));
  await assert.rejects(replay.images.info(new Response(bytes).body), error => error.reason === 'replay');
  assert.deepEqual(calls, { info: 1, transform: 1 });

  for (let index = 1; index < 100; index++) {
    const byte = Uint8Array.from([index & 255, (index + 1) & 255]);
    const operator = index % 2 === 0;
    const day = Math.floor(now / 86400000);
    const context = (await admission({
      purpose: operator ? 'operator_images' : 'visitor_images',
      modelName: budgetCore.IMAGES_ADMISSION_MODEL,
      subjectId: operator ? await budgetCore.budgetDigest('operator-security:' + installation) : index.toString(16).padStart(64, '0'),
      sessionId: operator ? await budgetCore.budgetDigest('operator-budget:' + installation + ':' + day) : (index + 1).toString(16).padStart(64, '0'),
      sessionStart: operator ? day * 86400000 : sessionIssuedAt,
      sessionEnd: operator ? (day + 1) * 86400000 : sessionExpiresAt,
      expiresAt: operator ? Math.min(now + 30_000, (day + 1) * 86400000 - 1) : now + 30_000,
      rawBody: byte,
    })).context;
    await invokeImageAdmission(f, context, byte, calls);
  }
  const before = { ...calls };
  const lastBytes = Uint8Array.from([101, 102]);
  const lastContext = (await admission({ purpose: 'visitor_images', modelName: budgetCore.IMAGES_ADMISSION_MODEL, subjectId: 'fe'.repeat(32), sessionId: 'fd'.repeat(32), rawBody: lastBytes })).context;
  const token101 = await budgetCore.signBudgetContext(lastContext, secret);
  const lastRequest = new Request('https://visitor-budget.test/images/normalize', { method: 'POST', headers: { 'X-Visitor-Admission': token101 }, body: lastBytes });
  const last = await imageAdmissionModule.admittedImages(lastRequest, { GUARD_DB: f.db, VISITOR_AI_CONTEXT_KEY: secret, VISITOR_AI_INSTALLATION_ID: installation }, countedImages(calls));
  await assert.rejects(last.images.info(new Response(lastBytes).body), error => error.reason === 'global');
  assert.deepEqual(calls, before, 'the 101st shared transform is refused before image inspection');
  const daily = await f.db.prepare('SELECT calls FROM image_transform_daily').first();
  assert.equal(daily.calls, 100);
  const wallet = await f.db.prepare('SELECT consumed_micros FROM inference_wallets').first();
  assert.equal(wallet, null, 'image resizing is metered separately and spends no AI wallet dollars');
});

test('same admission replay and digest conflicts never issue a second model call', async t => {
  const f = await fixture(t);
  const signed = await admission();
  const first = await f.send(signed.token);
  assert.equal(first.status, 200);
  const replay = await f.send(signed.token);
  assert.equal(replay.status, 429, 'the one-use request admission cannot be dispatched twice');
  const changedBody = body.replace('current availability', 'a different request');
  const conflict = await f.send(signed.token, changedBody);
  assert.equal(conflict.status, 429, 'payload no longer matches the signed digest');
  assert.equal(await f.callCount(), 1);
});

test('actual D1 reservation serializes concurrent last-cent attempts and retains unknown dispatch charges', async t => {
  const f = await fixture(t);
  const store = new budgetStoreModule.VisitorBudgetStore(f.db, () => now);
  const sessionId = 'cd'.repeat(32);
  const contexts = await Promise.all([0, 1].map(async () => (await admission({ sessionId })).context));
  const results = await Promise.allSettled(contexts.map(context => store.reserve(context, 500_000)));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1, 'only one full-wallet reservation wins');
  assert.equal(results.filter(row => row.status === 'rejected').length, 1, 'the competing transaction is rejected by the atomic D1 trigger');
  const winner = contexts.find((_, index) => results[index].status === 'fulfilled');
  assert.ok(winner);
  assert.equal(await store.dispatch(winner.requestKey), true);
  await store.finish(winner.requestKey, 'unknown');
  const wallet = await f.db.prepare('SELECT consumed_micros FROM inference_wallets WHERE session=?').bind(sessionId).first();
  const reservation = await f.db.prepare('SELECT state,cost_micros FROM inference_reservations WHERE request_key=?').bind(winner.requestKey).first();
  assert.equal(wallet.consumed_micros, 500_000);
  assert.deepEqual(reservation, { state: 'unknown', cost_micros: 500_000 });
});

test('D1 enforces one shared 100-call daily cap and four active leases across purposes', async t => {
  const f = await fixture(t);
  const store = new budgetStoreModule.VisitorBudgetStore(f.db, () => now);
  for (let index = 0; index < 4; index++) {
    const context = (await admission({ sessionId: (index.toString(16).padStart(2, '0')).repeat(32), subjectId: (index.toString(16).padStart(2, '0')).repeat(32), purpose: index % 2 ? 'operator_diagnostic' : 'visitor_text' })).context;
    await store.reserve(context, 1);
  }
  const fifth = (await admission({ sessionId: 'ff'.repeat(32), subjectId: 'ff'.repeat(32), purpose: 'operator_curation' })).context;
  await assert.rejects(store.reserve(fifth, 1), error => error.reason === 'concurrency');

  await f.db.prepare('UPDATE inference_reservations SET lease_until=0').run();
  const first = (await admission({ sessionId: '01'.repeat(32), subjectId: '01'.repeat(32), purpose: 'visitor_text' })).context;
  await store.reserve(first, 1);
  await f.db.prepare('UPDATE inference_reservations SET lease_until=0').run();
  const daily = await f.db.prepare('SELECT day FROM inference_daily LIMIT 1').first();
  await f.db.prepare('UPDATE inference_daily SET calls=99 WHERE day=?').bind(daily.day).run();
  const last = (await admission({ sessionId: '02'.repeat(32), subjectId: '02'.repeat(32), purpose: 'operator_curation' })).context;
  await store.reserve(last, 1);
  await f.db.prepare('UPDATE inference_reservations SET lease_until=0').run();
  const denied = (await admission({ sessionId: '03'.repeat(32), subjectId: '03'.repeat(32), purpose: 'visitor_vision' })).context;
  await assert.rejects(store.reserve(denied, 1), error => error.reason === 'global');
  const count = await f.db.prepare('SELECT calls FROM inference_daily WHERE day=?').bind(daily.day).first();
  assert.equal(count.calls, 100);
});

test('request-key replay is idempotent only for the exact reservation and identity', async t => {
  const f = await fixture(t);
  const store = new budgetStoreModule.VisitorBudgetStore(f.db, () => now);
  const { context } = await admission();
  const first = await store.reserve(context, 100);
  const replay = await store.reserve(context, 100);
  assert.equal(replay.request_key, first.request_key);
  assert.equal(await store.dispatch(context.requestKey), true);
  assert.equal(await store.dispatch(context.requestKey), false);
  await assert.rejects(store.reserve({ ...context, bodyDigest: '01'.repeat(32) }, 100), /Admission conflict/);
  await assert.rejects(store.reserve(context, 101), /Admission conflict/);
});

test('the signed visitor budget session has a fixed non-sliding 24-hour lifetime', async () => {
  const sessionRecord = { securitySubject, session, sessionIssuedAt, sessionExpiresAt };
  const token = await budgetCore.signBudgetSession(sessionRecord, secret);
  assert.deepEqual(await budgetCore.verifyBudgetSession(token, secret, now), sessionRecord);
  await assert.rejects(budgetCore.verifyBudgetSession(token, secret, sessionExpiresAt), /Inference admission denied/);
  await assert.rejects(budgetCore.verifyBudgetSession(token, 'another-secret-key-that-is-long-enough', now), /Inference admission denied/);
  const [payload, mac] = token.split('.');
  const tampered = `${Buffer.from(JSON.stringify({ ...sessionRecord, sessionExpiresAt: sessionExpiresAt + 1 })).toString('base64')}.${mac}`;
  await assert.rejects(budgetCore.verifyBudgetSession(tampered, secret, now), /Inference admission denied/);
});

async function applyFrameworkAbuseMigration(db) {
  const migration = await readFile(path.join(root, 'drizzle/0036_visitor_abuse.sql'), 'utf8');
  for (const raw of migration.split('--> statement-breakpoint')) {
    const statement = raw.trim();
    if (statement) await db.prepare(statement).run();
  }
}

test('the seven-day security subject recovers the canonical wallet after wallet-cookie loss and Forget', async t => {
  const f = await fixture(t);
  await applyFrameworkAbuseMigration(f.db);
  let clock = now;
  const ledger = new sessionStoreModule.VisitorBudgetSessionStore(f.db, installation, () => clock);
  const security = { subject: securitySubject, issuedAt: now - 1000, expiresAt: now - 1000 + 7 * 86400000 };
  const securityCookie = await budgetCore.signSecuritySubject(security, secret);
  assert.deepEqual(await budgetCore.verifySecuritySubject(securityCookie, secret, now), security);
  const visitorHash = await budgetCore.budgetDigest('support-session:before-forget');
  assert.equal(await ledger.resolveSubject(visitorHash, security.subject), security.subject);
  const recoveredWithoutSecurityCookies = await ledger.resolveSubject(visitorHash, '72'.repeat(32));
  assert.equal(recoveredWithoutSecurityCookies, security.subject, 'the surviving support visitor cookie recovers its prior subject when security/wallet cookies are omitted');
  const concurrentRecovery = await Promise.all([ledger.resolveSubject(visitorHash, '73'.repeat(32)), ledger.resolveSubject(visitorHash, '74'.repeat(32))]);
  assert.deepEqual(concurrentRecovery, [security.subject, security.subject], 'concurrent cookie recovery converges on the existing binding');
  const concurrent = await Promise.all([ledger.resolveWallet(security.subject), ledger.resolveWallet(security.subject)]);
  assert.equal(concurrent[0].session, concurrent[1].session, 'parallel first mints converge on one persisted canonical wallet');
  const canonical = await ledger.readWallet(security.subject);
  assert.equal(canonical.session, concurrent[0].session);

  const recoveredAfterWalletCookieClear = await ledger.resolveWallet(security.subject, null);
  assert.equal(recoveredAfterWalletCookieClear.session, canonical.session, 'clearing only the paid wallet cookie does not reset its active D1 balance');
  const newVisitorAfterForget = await budgetCore.budgetDigest('support-session:after-forget');
  assert.equal(await ledger.resolveSubject(newVisitorAfterForget, security.subject), security.subject, 'a valid security cookie keeps the subject across Forget');
  assert.equal((await ledger.resolveWallet(security.subject)).session, canonical.session);

  clock = canonical.sessionExpiresAt;
  const rolled = await ledger.resolveWallet(security.subject, null);
  assert.notEqual(rolled.session, canonical.session, 'the wallet rotates after its absolute 24-hour expiry');
  assert.equal(rolled.securitySubject, security.subject);
  assert.equal(rolled.sessionIssuedAt, clock);
});

test('a block raised just before wallet expiry remains active through rollover without minting a wallet', async t => {
  const f = await fixture(t);
  await applyFrameworkAbuseMigration(f.db);
  let clock = now;
  const ledger = new sessionStoreModule.VisitorBudgetSessionStore(f.db, installation, () => clock);
  const wallet = await ledger.resolveWallet(securitySubject);
  const offenseAt = wallet.sessionExpiresAt - 5 * 60 * 1000;
  clock = offenseAt;
  const abuse = new abuseStoreModule.VisitorAbuseStore(f.db, installation, () => clock);
  const block = await abuse.offense(securitySubject, 'session', 'qa-block-request-00000001', 'structured_jailbreak', 'bounded synthetic evidence', 'alphabetizing imaginary clouds', true);
  await ledger.retain(securitySubject, block.until);
  assert.equal(block.action, 'block');
  assert.equal(block.until, offenseAt + 86400000);

  clock = wallet.sessionExpiresAt;
  const stillBlocked = await abuse.blocked(securitySubject);
  assert.equal(stillBlocked.action, 'block');
  assert.ok(stillBlocked.until > clock, 'the block outlasts the expired 24-hour wallet');
  assert.equal(await ledger.readWallet(securitySubject), null, 'the blocked caller has no fresh wallet minted during the active block');
  const postForgetVisitor = await budgetCore.budgetDigest('support-session:blocked-rollover');
  assert.equal(await ledger.resolveSubject(postForgetVisitor, securitySubject), securitySubject, 'the signed security subject remains stable after Forget during an active block');
  assert.equal((await abuse.blocked(await ledger.readSubject(postForgetVisitor))).action, 'block');
  assert.equal(await ledger.readWallet(securitySubject), null, 'the active block path has no wallet to dispatch against');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM support_security_wallets WHERE installation_id=? AND security_subject=?').bind(installation, securitySubject).first()).count, 1);
});

test('a model timeout becomes unknown, stays charged, and retains its concurrency lease across expiry and pruning', async t => {
  const f = await fixture(t);
  const input = { ...JSON.parse(body), messages: [{ role: 'user', content: 'synthetic timeout' }] };
  const rawBody = JSON.stringify(input);
  const signed = await admission({ rawBody });
  const response = await f.send(signed.token, rawBody);
  assert.equal(response.status, 503);
  const reservation = await f.db.prepare('SELECT request_key,state,cost_micros,lease_until,session_expires_at FROM inference_reservations WHERE request_key=?').bind(signed.context.requestKey).first();
  assert.equal(reservation.state, 'unknown');
  assert.ok(reservation.cost_micros > 0);
  assert.equal(reservation.lease_until, 9223372036854775807);
  const walletBefore = await f.db.prepare('SELECT consumed_micros FROM inference_wallets WHERE session=?').bind(session).first();
  assert.equal(walletBefore.consumed_micros, reservation.cost_micros);
  const replay = await f.send(signed.token, rawBody);
  assert.equal(replay.status, 429);
  assert.equal(await f.callCount(), 1, 'unknown dispatch is never retried by reusing its signed request');
  const store = new budgetStoreModule.VisitorBudgetStore(f.db, () => reservation.session_expires_at + 8 * 86400000);
  await store.prune();
  const retained = await f.db.prepare('SELECT state,lease_until FROM inference_reservations WHERE request_key=?').bind(signed.context.requestKey).first();
  assert.deepEqual(retained, { state: 'unknown', lease_until: 9223372036854775807 }, 'unknown delivery is not auto-expired by cleanup');
  const walletAfter = await f.db.prepare('SELECT consumed_micros FROM inference_wallets WHERE session=?').bind(session).first();
  assert.equal(walletAfter.consumed_micros, walletBefore.consumed_micros);
});
