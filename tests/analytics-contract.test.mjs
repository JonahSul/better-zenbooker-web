import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadContract() {
  const source = await readFile(path.join(root, 'lib/analytics-contract.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === './site-config') {
      return { DEMO_ORIGIN: 'https://demo.example.test' };
    }
    throw new Error(`Unexpected import in analytics contract: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(requireMock, module, module.exports);
  return module.exports;
}

const contract = await loadContract();

test('only a well-formed GTM web-container ID enables consent UI', () => {
  assert.equal(contract.validContainerId('GTM-PQ3SVPTK'), true);
  for (const id of ['', undefined, null, 'G-THR2KRPF', 'GTM-1', 'GTM-TOO-LONG-12345', 'https://www.googletagmanager.com/gtm.js?id=GTM-AAAAAAA']) {
    assert.equal(contract.validContainerId(id), false, `expected ${String(id)} to be disabled`);
  }
});

test('events produce no payload before affirmative consent', () => {
  for (const event of ['service_select', 'contact_click', 'generate_lead']) {
    assert.equal(contract.eventPayload(false, event, 'repair', 'form', '/'), null);
  }
});

test('consented action events contain only fixed values and public canonical context', () => {
  const allowed = [
    ['service_select', '1cde83b8-2c5b-4d80-a155-1b12353f4bf6', 'form'],
    ['contact_click', 'general', 'footer'],
    ['generate_lead', '745b0345-539d-4a9f-bc33-e46ac45ec43d', 'form'],
  ];
  for (const [name, service, placement] of allowed) {
    const payload = contract.eventPayload(true, name, service, placement, '/privacy?contact=private#section');
    assert.deepEqual(Object.keys(payload).sort(), ['event', 'page_location', 'page_referrer', 'placement', 'service']);
    assert.deepEqual(payload, {
      event: name,
      service,
      placement,
      page_location: 'https://demo.example.test/privacy',
      page_referrer: '',
    });
  }
  for (const bad of [
    ['other_event', 'repair', 'form'],
    ['generate_lead', 'private@email.example', 'form'],
    ['contact_click', 'general', 'https://private.example'],
  ]) {
    assert.equal(contract.eventPayload(true, ...bad, '/'), null);
  }
});

test('only the public root, privacy, and terms routes are canonical analytics paths', () => {
  const canonical = 'https://demo.example.test';
  for (const pathValue of ['/?email=person@example.com&name=Private', '/privacy?contact=4065551212#lead', '/terms?note=secret']) {
    const path = contract.publicAnalyticsPath(pathValue);
    assert.equal(path, pathValue.split(/[?#]/)[0]);
    assert.deepEqual(contract.analyticsContext(pathValue), { page_location: `${canonical}${path}`, page_referrer: '' });
  }
  for (const pathValue of ['/admin', '/admin/settings', '/admin/credentials', '/admin/analytics', '/admin/bookings', '/admin/reviews', '/admin/analysis', '/manage', '/manage/google-reviews', '/setup/credentials', '/unlisted/path', 'https://attacker.example/?token=secret']) {
    assert.equal(contract.publicAnalyticsPath(pathValue), null);
    assert.deepEqual(contract.analyticsContext(pathValue), { page_location: `${canonical}/`, page_referrer: '' });
    assert.equal(contract.eventPayload(true, 'contact_click', 'general', 'footer', pathValue), null);
  }
});

test('one page_view is queued only for consented public documents and does not count as an experiment exposure', async () => {
  for (const path of ['/', '/privacy?email=hidden', '/terms#section']) {
    const tracker = contract.createPageViewTracker();
    assert.equal(tracker.take(false, false, path), null, 'no analytics consent emits no page view');
    assert.equal(tracker.take(true, true, path), null, 'an admin-session cookie suppresses page views');
    const event = tracker.take(true, false, path);
    const allowedPath = path.split(/[?#]/)[0];
    assert.deepEqual(event, {
      event: 'page_view',
      page_location: `https://demo.example.test${allowedPath}`,
      page_referrer: '',
    });
    assert.equal(tracker.take(true, false, path), null, 'repeat grants and component remounts do not duplicate a document event');
  }
  for (const privatePath of ['/admin', '/admin/credentials', '/admin/analytics', '/admin/bookings', '/admin/reviews', '/manage', '/setup/credentials']) {
    const tracker = contract.createPageViewTracker();
    assert.equal(tracker.take(true, false, privatePath), null);
    assert.equal(tracker.take(true, false, '/')?.event, 'page_view', 'a rejected private path does not consume the public event slot');
  }

  const component = await readFile(path.join(root, 'components/analytics.tsx'), 'utf8');
  assert.match(component, /const documentPageView=createPageViewTracker\(\)/);
  assert.match(component, /documentPageView\.take\(allow,adminSessionPresent,location\.pathname\)/);
  assert.match(component, /if\(pageView\)window\.dataLayer\.push\(pageView\)/);
  assert.match(component, /send_page_view:false/);
  assert.doesNotMatch(component, /gtag\(['"]event['"],['"]page_view/);
  assert.doesNotMatch(component, /captureExposure|experiment_exposure/);
  assert.equal((component.match(/https:\/\/www\.googletagmanager\.com\/gtm\.js/g) ?? []).length, 1, 'the existing consent-gated GTM loader is the only tag loader');
});

test('a lead event is source-gated on successful persisted response', async () => {
  const source = await readFile(path.join(root, 'components/inquiry-form.tsx'), 'utf8');
  const rejectIndex = source.indexOf('if(!response.ok)throw');
  const leadIndex = source.indexOf("if(result.created)track('generate_lead',String(values.service),'form')");
  const catchIndex = source.indexOf('}catch(error)');
  assert.ok(rejectIndex >= 0 && leadIndex > rejectIndex && catchIndex > leadIndex,
    'lead event must occur after the response is accepted and before the error handler');
  assert.doesNotMatch(source, /track\(['"]generate_lead['"],[^)]*(?:values\.name|values\.contact|values\.preferredDate|values\.note)/);
});

test('GTM loading is behind explicit consent, and withdrawal stops local events', async () => {
  const component = await readFile(path.join(root, 'components/analytics.tsx'), 'utf8');
  assert.match(component, /enabled=allow&&valid/);
  assert.match(component, /if\(!allow\|\|!valid\)\{enabled=false;command\('consent','update'/);
  assert.match(component, /if\(!allow\|\|!valid\)\{enabled=false;command\('consent','update'/);
  assert.match(component, /if\(!document\.getElementById\('optional-gtm'\)\)[\s\S]*?document\.head\.appendChild\(script\)/);
  assert.match(component, /publishConsent\(allow\?'allowed':'declined'\)/);
  assert.match(component, /<details className="analytics-control"><summary>Analytics<\/summary>/);
  assert.match(component, /aria-label="Allow analytics"/);
  assert.match(component, /aria-label="Decline analytics"/);
  assert.match(component, /Withdraw consent/);
  assert.match(component, /role="status" aria-live="polite"/);
  assert.match(component, /location\.reload\(\)/, 'withdrawal after loading GTM must reload to unload running tags');
  assert.doesNotMatch(component, /<iframe|preconnect|gtag\.js/);
});
