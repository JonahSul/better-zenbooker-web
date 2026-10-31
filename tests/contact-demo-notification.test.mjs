import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relativePath, mocks = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const inquiryPersistence = await loadTs('lib/inquiry-persistence.ts', {
  './attribution-core': { ATTRIBUTION_WINDOW_MS: 7 * 86400000 },
});

function captureDb({ created = true, existingId = 'd6000000-0000-4000-8000-000000000001' } = {}) {
  const batches = [];
  const prepared = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() { return { id: existingId }; },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      batches.push(statements);
      return [{ results: created ? [{ id: statements[0].values[0] }] : [] }];
    },
  };
  return { db, batches, prepared };
}

const values = {
  submissionKey: 'demo-request-key', name: 'Synthetic Customer', contact: 'customer@example.invalid',
  service: 'demo service', area: 'Fixture City', preferredDate: '2026-11-10', source: 'website', note: 'Synthetic note',
};

test('legacy inquiry intent is atomically attached only for the explicit enabled demo event', async () => {
  const off = captureDb();
  await inquiryPersistence.saveInquiryWithConversion(off.db, 'fixture-workspace', values, null);
  assert.equal(off.batches[0].length, 1, 'no config means no legacy notification intent');

  const disabled = captureDb();
  await inquiryPersistence.saveInquiryWithConversion(disabled.db, 'fixture-workspace', values, null, {
    eligible: false, policyEligible: false, configRevision: 4, configFingerprint: null,
    credentialGeneration: null, attentionReason: 'notifications_off',
  });
  assert.equal(disabled.batches[0].length, 1, 'an event excluded from policy cannot create an outbox row');

  const blocked = captureDb();
  await inquiryPersistence.saveInquiryWithConversion(blocked.db, 'fixture-workspace', values, null, {
    eligible: false, policyEligible: true, configRevision: 4, configFingerprint: 'a'.repeat(64),
    credentialGeneration: 'b'.repeat(64), attentionReason: 'sender_check_required',
  });
  assert.equal(blocked.batches[0].length, 2, 'eligible event policy stores its intent in the same D1 batch as the inquiry');
  const [outbox] = blocked.batches[0].slice(1);
  assert.match(outbox.sql, /'inquiry\.demo_saved','demo_inquiry'/);
  assert.match(outbox.sql, /ON CONFLICT\(workspace_id,event,source_type,source_id\) DO NOTHING/);
  assert.equal(outbox.values[2], 'blocked');
  assert.equal(outbox.values[6], 'sender_check_required');
  assert.equal(outbox.values.at(-1), 'fixture-workspace');
  assert.equal(outbox.sql.includes('bcc'), false);

  const ready = captureDb();
  await inquiryPersistence.saveInquiryWithConversion(ready.db, 'fixture-workspace', values, null, {
    eligible: true, policyEligible: true, configRevision: 4, configFingerprint: 'a'.repeat(64),
    credentialGeneration: 'b'.repeat(64),
  });
  assert.equal(ready.batches[0][1].values[2], 'pending');

  const replay = captureDb({ created: false });
  const receipt = await inquiryPersistence.saveInquiryWithConversion(replay.db, 'fixture-workspace', values, null, {
    eligible: true, policyEligible: true, configRevision: 4, configFingerprint: 'a'.repeat(64),
    credentialGeneration: 'b'.repeat(64),
  });
  assert.deepEqual(receipt, { id: 'd6000000-0000-4000-8000-000000000001', created: false });
  assert.equal(replay.batches[0].length, 2);
  assert.notEqual(replay.batches[0][1].values.at(-2), receipt.id, 'replay intent SELECT is bound to the new uninserted candidate ID and cannot enqueue the existing inquiry');
});

test('demo source adapter rechecks the live inquiry revision and labels its private dispatch source', async () => {
  const sqlCalls = [];
  const sourceRow = {
    id: 'd7000000-0000-4000-8000-000000000001', revision: 9, name: 'Fixture Customer',
    contact: 'customer@example.invalid', service: 'demo service', area: 'Fixture City',
    preferredDate: '2026-11-10', note: 'Synthetic demo request', event: 'inquiry.demo_saved', sourceType: 'demo_inquiry',
  };
  class ContactStore {
    constructor(db, workspaceId, now = Date.now) { this.db = db; this.workspaceId = workspaceId; this.now = now; }
    async claimOutbox(input) { return { ...input, claimed: false, claimToken: null }; }
    async sourceForDispatch() { throw new Error('contact sources use the base implementation'); }
    async promoteNewOutbox(input) { return { id: input.id, revision: input.expectedRevision, state: 'blocked' }; }
  }
  const db = {
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; sqlCalls.push(this); return this; },
        async first() {
          if (this.sql.includes("source_type='demo_inquiry'")) return { id: 'demo-outbox' };
          if (this.sql.includes('JOIN contact_outbox')) return sourceRow;
          return { id: 'demo-outbox', revision: 2, state: 'blocked' };
        },
        async run() { return { meta: { changes: 1 } }; },
      };
    },
  };
  const loaded = await loadTs('lib/contact-demo-source-store.ts', {
    './contact-store': { ContactStore },
    './contact-core': { contactMessageInput: require('zod/v3').z.object({ email: require('zod/v3').z.string().email() }) },
  });
  const store = new loaded.ContactNotificationSourceStore(db, 'fixture-workspace', () => 1_800_000_000_000);
  const dispatch = await store.sourceForDispatch('demo-outbox', 'claim-token');
  assert.match(sqlCalls.at(-1).sql, /o\.source_revision=i\.updated_at/);
  assert.match(sqlCalls.at(-1).sql, /o\.claim_token=\?/);
  assert.match(sqlCalls.at(-1).sql, /i\.deleted_at IS NULL/);
  assert.deepEqual(dispatch, {
    id: sourceRow.id, revision: 9, name: 'Fixture Customer', email: 'customer@example.invalid',
    event: 'inquiry.demo_saved', sourceType: 'demo_inquiry',
    message: 'DEMO date request; not a confirmed appointment.\nContact: customer@example.invalid\nService: demo service\nArea: Fixture City\nPreferred date: 2026-11-10\n\nSynthetic demo request',
  });
});

async function loadInquiryRoute({ created, policyEligible }) {
  const state = { saved: [], dispatch: [], scheduled: [], measurement: [], attribution: 0, conversion: 0 };
  const notification = {
    async eligibility(event) { state.event = event; return { eligible: false, policyEligible, configRevision: 3, configFingerprint: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64) }; },
    async dispatchNew(input, actor) { state.dispatch.push({ input, actor }); },
  };
  const exports = await loadTs('app/api/inquiries/route.ts', {
    'cloudflare:workers': { env: { DB: {} }, waitUntil(promise) { state.scheduled.push(Promise.resolve(promise)); } },
    '../../../lib/element-measurement-core': { ELEMENT_DOCUMENT_HEADER: 'X-Measurement-Document' },
    '../../../lib/element-measurement-server': { async captureElementOutcome(request, kind, sourceId) { state.measurement.push({ documentId: request.headers.get('X-Measurement-Document'), kind, sourceId }); } },
    '../../../lib/contact-notification-server': { contactNotificationService: () => notification },
    '../../../lib/contact-store': { ContactStore: class { async outboxForSource(...args) { state.outboxArgs = args; return { id: 'd8000000-0000-4000-8000-000000000001', revision: 2 }; } } },
    '../../../lib/runtime-secrets': { SITE_PROJECT_ID: 'fixture-workspace' },
    '../../../lib/measurement-capture': { captureConversion() { state.conversion += 1; } },
    '../../../lib/inquiry-persistence': { async saveInquiryWithConversion(...args) { state.saved.push(args); return { id: 'd7000000-0000-4000-8000-000000000001', created }; } },
    '../../../lib/experiment-runtime': { async inquiryAttribution() { state.attribution += 1; return null; } },
    '../../../lib/admin-auth-server': { async adminGuard() { return null; } },
    'drizzle-orm': { and() {}, desc() {}, eq() {}, isNull() {} },
    '../../../db': { getDb() { return {}; } },
    '../../../db/schema': { inquiries: {} },
    '../../../lib/inquiry-validation': { inquiryInput: { safeParse(value) { return { success: true, data: value }; } }, updateInput: { safeParse() { return { success: false }; } } },
  });
  return { route: exports, state };
}

test('legacy inquiry hook only schedules the initiating created row and never blocks its receipt', async () => {
  const first = await loadInquiryRoute({ created: true, policyEligible: true });
  const body = { name: 'Synthetic Customer', contact: 'customer@example.invalid', service: 'demo service', area: 'Fixture City', preferredDate: '2026-11-10', source: 'website', note: '' };
  const response = await first.route.POST(new Request('https://site.invalid/api/inquiries', {
    method: 'POST', headers: { origin: 'https://site.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { saved: true, id: 'd7000000-0000-4000-8000-000000000001', created: true });
  assert.equal(first.state.event, 'inquiry.demo_saved');
  assert.deepEqual(first.state.saved[0][4], { eligible: false, policyEligible: true, configRevision: 3, configFingerprint: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64) });
  assert.deepEqual(first.state.outboxArgs, ['demo_inquiry', 'd7000000-0000-4000-8000-000000000001']);
  assert.equal(first.state.scheduled.length, 1);
  await Promise.all(first.state.scheduled);
  assert.deepEqual(first.state.dispatch, [{ input: { id: 'd8000000-0000-4000-8000-000000000001', expectedRevision: 2 }, actor: 'system:demo-inquiry' }]);

  const replay = await loadInquiryRoute({ created: false, policyEligible: true });
  const replayResponse = await replay.route.POST(new Request('https://site.invalid/api/inquiries', {
    method: 'POST', headers: { origin: 'https://site.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal(replayResponse.status, 200);
  assert.equal(replay.state.scheduled.length, 0);
  assert.equal(replay.state.dispatch.length, 0);
  assert.equal(replay.state.conversion, 0);

  const blocked = await loadInquiryRoute({ created: true, policyEligible: false });
  const blockedResponse = await blocked.route.POST(new Request('https://site.invalid/api/inquiries', {
    method: 'POST', headers: { origin: 'https://site.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal(blockedResponse.status, 201);
  assert.equal(blocked.state.scheduled.length, 0);
});

test('demo outcome capture requires a new durable receipt and its registered document header', async () => {
  const documentId = 'd9000000-0000-4000-8000-000000000001';
  const body = { name: 'Synthetic Customer', contact: 'customer@example.invalid', service: 'demo service', area: 'Fixture City', preferredDate: '2026-11-10', source: 'website', note: '' };
  const first = await loadInquiryRoute({ created: true, policyEligible: false });
  const firstResponse = await first.route.POST(new Request('https://site.invalid/api/inquiries', {
    method: 'POST', headers: { origin: 'https://site.invalid', 'content-type': 'application/json', 'X-Measurement-Document': documentId }, body: JSON.stringify(body),
  }));
  assert.equal(firstResponse.status, 201);
  await Promise.all(first.state.scheduled);
  assert.deepEqual(first.state.measurement, [{ documentId, kind: 'demo_request_received', sourceId: 'd7000000-0000-4000-8000-000000000001' }]);

  const replay = await loadInquiryRoute({ created: false, policyEligible: false });
  const replayResponse = await replay.route.POST(new Request('https://site.invalid/api/inquiries', {
    method: 'POST', headers: { origin: 'https://site.invalid', 'content-type': 'application/json', 'X-Measurement-Document': documentId }, body: JSON.stringify(body),
  }));
  assert.equal(replayResponse.status, 200);
  assert.equal(replay.state.scheduled.length, 0, 'idempotent replay has no outcome work');

  const noHeader = await loadInquiryRoute({ created: true, policyEligible: false });
  const noHeaderResponse = await noHeader.route.POST(new Request('https://site.invalid/api/inquiries', {
    method: 'POST', headers: { origin: 'https://site.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal(noHeaderResponse.status, 201);
  assert.equal(noHeader.state.scheduled.length, 0, 'a receipt without a registered navigation is not attributed');
});
