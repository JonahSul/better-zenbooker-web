import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.NEXT_PUBLIC_HOSTED_BOOKING_URL = 'https://booking.example.test/calendar';
process.env.NEXT_PUBLIC_HOSTED_SERVICE_IDS = 'fixture-service-01';

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === 'zod/v3') return require(specifier);
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const hostedCore = await loadTs('lib/hosted-booking-core.ts');
let consentGate = Promise.resolve();
const consentClient = {
  currentAnalyticsEpoch: () => 1,
  analyticsReferenceAllowed: () => true,
  refreshPurposeConsent: () => consentGate,
};
const bookingClient = await loadTs('lib/hosted-booking-client.ts', {
  './consent-client': consentClient,
  './hosted-booking-core': hostedCore,
});
const panelCore = await loadTs('lib/hosted-booking-panel-core.ts', {
  './hosted-booking-core': hostedCore,
  './hosted-booking-client': bookingClient,
});

test('Book and Back are reversible view changes so the conversation component remains mounted', async () => {
  assert.equal(panelCore.bookingPanelView('conversation', 'book'), 'booking');
  assert.equal(panelCore.bookingPanelView('booking', 'back'), 'conversation');
  const source = await readFile(path.join(root, 'components/visitor-support.tsx'), 'utf8');
  assert.match(source, /bookingVisited&&<section className="support-booking-view" hidden=\{view!=='booking'\}>/);
  assert.match(source, /onBack=\{\(\)=>\{setView\(current=>bookingPanelView\(current,'back'\)\)/);
  assert.match(source, /const \[turns,setTurns\]=useState/);
  assert.match(source, /setView\(current=>bookingPanelView\(current,'book'\)\)/);
});

test('the shared panel starts without a personalized iframe in SSR and keeps Google/profile details out of shared HTML', async () => {
  const React = require('react');
  const icons = new Proxy({}, { get: (_target, name) => function Icon(props) { return React.createElement('span', { ...props, 'data-icon': String(name) }); } });
  const jsxRuntime = require('react/jsx-runtime');
  const panelSource = await readFile(path.join(root, 'components/hosted-booking-panel.tsx'), 'utf8');
  const compiled = ts.transpileModule(panelSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    if (specifier === 'react') return React;
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    if (specifier === 'lucide-react') return icons;
    if (specifier === '../lib/account-controller') return {
      GENERIC_ACCOUNT_SNAPSHOT: {
        customer: { configured: false, authenticated: false, adminEligible: false, profile: null, expiresAt: null, prefillPending: false, prefillReturnTo: null },
        admin: { configured: false, authenticated: false, email: null, expiresAt: null },
        customerRead: { availability: 'loading', httpStatus: null, reason: null },
        adminRead: { availability: 'loading', httpStatus: null, reason: null, nativeSignInPath: null }, loading: false,
      },
      accountController: { subscribe: () => () => {}, snapshot: () => ({}) },
    };
    if (specifier === '../lib/account-surface') return { accountSurface: { booking: () => () => {}, snapshot: () => ({}) } };
    if (specifier === '../lib/customer-visit-client') return { recordCurrentVisit: async () => ({}) };
    if (specifier === '../lib/booking-continuity') return { saveBookingContinuity: () => ({ saved: false }), takeBookingContinuity: () => ({ restored: false }) };
    if (specifier === './connected-account-menu') return { customerAccountRequest: async () => ({}) };
    if (specifier === './offering-tiles') return Object.assign(() => null, { useCurrentOfferings: () => ({ loaded: true, revision: 0, offerings: [] }) });
    if (specifier === '../lib/consent-client') return { currentAnalyticsEpoch: () => 0, analyticsReferenceAllowed: () => false };
    if (specifier === '../lib/hosted-booking-client') return { resolveHostedNavigation: async input => hostedCore.buildHostedBookingUrl(input) };
    if (specifier === './hosted-booking-panel.css') return {};
    if (specifier === '../lib/hosted-booking-core') return hostedCore;
    if (specifier === '../lib/hosted-booking-panel-core') return panelCore;
    throw new Error(`Unexpected panel import: ${specifier}`);
  }, loaded, loaded.exports);
  const html = require('react-dom/server').renderToStaticMarkup(React.createElement(loaded.exports.default, { returnTo: 'book' }));
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /Preparing booking/);
  assert.match(html, /No account is needed/);
  assert.match(html, /Open booking in a new tab/);
  assert.doesNotMatch(html, /Sign in with Google|Use Google contact details|customer@gmail\.com|Customer Fixture|customer_name/);
});

test('initial booking prefill uses any verified customer session without waiting for Admin status or a Web Lock', async () => {
  const source = await readFile(path.join(root, 'components/hosted-booking-panel.tsx'), 'utf8');
  assert.match(source, /customerAccountRequest<\{url:string\}>\('prefill'/);
  assert.match(source, /intent:'initial-booking'/);
  assert.match(source, /const customer=accountController\.refreshCustomer\(\)/);
  assert.match(source, /state\.customerRead\.availability==='ready'&&state\.customer\.authenticated/);
  assert.doesNotMatch(source, /Promise\.all\(\[.*refreshAdmin|await accountController\.refresh\(\)/s);
  assert.doesNotMatch(source, /account=signed_in|searchParams\.get\(['"]account['"]\)/);
  assert.doesNotMatch(source, /navigator\.locks/);
  assert.match(source, /intent:'initial-booking',returnTo/);
  assert.match(source, /abort\.signal\.aborted\|\|!accountController\.snapshot\(\)\.customer\.authenticated/);
  assert.match(source, /applyDetails=useCallback\(async\(intent:'manual'\|'oauth-return'='manual'\)/);
  assert.match(source, /consentBoundPrefillUrl\(result\.url,analyticsReferenceAllowed\(epoch\),context\.providerId\)/);
});

test('only an independently allowed Analytics reference survives into the private iframe URL', () => {
  const providerServiceId = 'fixture-service-01';
  const candidateUrl = new URL(hostedCore.HOSTED_BOOKING_URL);
  candidateUrl.search = new URLSearchParams({ embed: 'true', 'preselected-service': providerServiceId, customer_name: 'Fixture Customer', customer_email: 'customer@gmail.com', utm_content: 'app_ref_v1_' + 'a'.repeat(32) }).toString();
  const candidate = candidateUrl.href;
  const allowed = new URL(panelCore.consentBoundPrefillUrl(candidate, true, providerServiceId));
  assert.equal(allowed.searchParams.get('utm_content'), 'app_ref_v1_' + 'a'.repeat(32));
  assert.equal(allowed.searchParams.get('customer_email'), 'customer@gmail.com');
  const revokedOrStale = new URL(panelCore.consentBoundPrefillUrl(candidate, false, providerServiceId));
  assert.equal(revokedOrStale.searchParams.has('utm_content'), false);
  assert.equal(revokedOrStale.searchParams.get('customer_email'), 'customer@gmail.com');
  assert.equal(revokedOrStale.searchParams.get('preselected-service'), providerServiceId);
  assert.equal(panelCore.consentBoundPrefillUrl(candidate, true, 'different-provider-service'), null);
  assert.equal(panelCore.consentBoundPrefillUrl('https://attacker.invalid/', true), null);
});

test('guest navigation accepts only the current offering selection and strips stale Analytics reference', () => {
  const input = { offeringId: '32323232-3232-4232-8232-323232323232', offeringsRevision: 9, placement: 'booking' };
  const base = new URL(hostedCore.buildHostedBookingUrl(input));
  const providerServiceId = 'fixture-service-01';
  base.searchParams.set('preselected-service', providerServiceId);
  const resolvedCanonical = base.href;
  const decoratedUrl = new URL(resolvedCanonical); decoratedUrl.searchParams.set('utm_content', 'app_ref_v1_' + 'a'.repeat(32));
  const decorated = decoratedUrl.href;
  const allowed = new URL(panelCore.guestBookingFrameUrl(decorated, input, true, resolvedCanonical));
  assert.equal(allowed.origin, new URL(hostedCore.HOSTED_BOOKING_URL).origin);
  assert.equal(allowed.pathname, new URL(hostedCore.HOSTED_BOOKING_URL).pathname);
  assert.equal(allowed.searchParams.get('preselected-service'), providerServiceId);
  assert.equal(allowed.searchParams.get('utm_content'), `app_ref_v1_${'a'.repeat(32)}`);
  const noAnalytics = new URL(panelCore.guestBookingFrameUrl(decorated, input, false, resolvedCanonical));
  assert.equal(noAnalytics.searchParams.has('utm_content'), false);
  assert.equal(noAnalytics.searchParams.get('preselected-service'), providerServiceId);
  assert.equal(panelCore.guestBookingFrameUrl(decorated, input, true), null,
    'a static/legacy service hint cannot authorize a provider preselection');
  assert.equal(panelCore.guestBookingFrameUrl('https://attacker.invalid/book', input, true), null);
});

test('outer launch deadline covers consent recovery, falls back to guest URL, and ignores late personalized results', async () => {
  const input = { placement: 'booking' };
  const canonical = hostedCore.buildHostedBookingUrl(input);
  const fallback = panelCore.guestBookingFrameUrl(canonical, input, false);
  let releaseConsent;
  consentGate = new Promise(resolve => { releaseConsent = resolve; });
  let handoffCalls = 0;
  const work = bookingClient.resolveHostedNavigation(input, async () => {
    handoffCalls += 1;
    const decorated = new URL(canonical); decorated.searchParams.set('utm_content', 'app_ref_v1_' + 'b'.repeat(32));
    return Response.json({ url: decorated.href });
  });
  const selected = await panelCore.boundedBookingLaunch(work, fallback, 5);
  assert.equal(selected, fallback);
  releaseConsent();
  const late = await work;
  assert.notEqual(late, fallback);
  assert.equal(handoffCalls, 1);
  assert.equal(selected, fallback, 'a late consent response cannot replace the already chosen fallback');
  consentGate = Promise.resolve();
});

test('a rejected or never-resolving launch returns only the canonical guest destination', async () => {
  const fallback = panelCore.BOOKING_IFRAME_URL;
  assert.equal(await panelCore.boundedBookingLaunch(Promise.reject(new Error('private failure')), fallback, 20), fallback);
  assert.equal(await panelCore.boundedBookingLaunch(new Promise(() => {}), fallback, 5), fallback);
});

test('component fences late launch and service results before mounting the iframe', async () => {
  const source = await readFile(path.join(root, 'components/hosted-booking-panel.tsx'), 'utf8');
  assert.match(source, /useState<string\|null>\(null\)/);
  assert.match(source, /\{frameUrl\?<HostedBookingFrame url=\{frameUrl\}\/\>:<p role="status">Preparing booking/);
  assert.match(source, /boundedBookingLaunch/);
  assert.match(source, /boundedBookingLaunch\(work,fallback,2500\)/);
  assert.match(source, /resolveHostedNavigation\(context\.input,fetch,context\.canonical\)/);
  assert.match(source, /revision!==generation\.current/);
  assert.match(source, /intent:'initial-booking'/);
  assert.match(source, /initialAbort\.current\?\.abort\(\)/);
  assert.doesNotMatch(source, /navigator\.locks|searchParams\.get\(['"]account['"]\)/);
  assert.match(source, /accountController\.customerEpoch\(\)/);
  assert.match(source, /initialIdentity/);
  assert.match(source, /currentCustomer\.authenticated/);
  assert.match(source, /currentCustomer\.expiresAt<=Date\.now\(\)/);
  assert.match(source, /currentCustomer\.profile\?\.email!==initialIdentity\?\.email/);
  assert.match(source, /if\(!mounted\.current\|\|lifecycle!==initialLifecycle\.current\|\|prefillOnce\.current\)/);
  assert.match(source, /initialLifecycle\.current=lifecycle\+1/);
  assert.match(source, /\},\[placement,returnTo\]\)/,
    'only the initial placement/return context owns the first frame decision; account focus refresh does not rerun it');
});
