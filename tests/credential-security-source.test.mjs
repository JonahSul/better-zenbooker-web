import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('privileged route transitions hide children until any loaded GTM is unloaded', async () => {
  const [boundary, layout, footer] = await Promise.all([
    read('components/sensitive-route-boundary.tsx'),
    read('app/layout.tsx'),
    read('components/analytics.tsx'),
  ]);

  assert.match(layout, /<SensitiveRouteBoundary>\{children\}<\/SensitiveRouteBoundary>/);
  assert.match(boundary, /\['\/admin','\/setup','\/manage','\/book','\/appointments'\]/);
  assert.match(boundary, /document\.getElementById\('optional-gtm'\)/);
  assert.match(boundary, /window\.location\.reload\(\)/);
  assert.match(boundary, /checkedPath!==pathname\)return <main[^;]*Opening private workspace/s);
  for (const prefix of ['/admin', '/manage', '/setup', '/book', '/appointments']) assert.ok(footer.includes(`pathname?.startsWith('${prefix}')`));
  assert.match(footer, /return <footer className="route-footer"[^]*?Privacy[^]*?Terms[^]*?;return <footer[^]*?<AnalyticsConsent\/>/);
});

test('an existing admin session suppresses browser analytics without clearing the saved choice', async () => {
  const [consent, analytics] = await Promise.all([
    read('lib/purpose-consent-server.ts'),
    read('components/analytics.tsx'),
  ]);

  assert.match(consent, /analyticsSuppressed=!!cookieValue\(request,'__Host-admin_session'\)/);
  assert.match(consent, /analytics:!!analytics&&!analyticsSuppressed/);
  assert.match(consent, /analyticsSaved:!!analytics/);
  assert.match(analytics, /if\(result\.analyticsSuppressed\)\{enabled=false;publishConsent\(result\.analyticsSaved\?'allowed':''\)/);
  assert.match(analytics, /result\?\.containerId/);
  assert.match(analytics, /result\?\.configRevision/);
  assert.match(analytics, /loadedContainerIdentity!==identity/);
  assert.match(analytics, /reloadRequested=true;window\.location\.reload\(\)/);
  assert.doesNotMatch(analytics, /localStorage|sessionStorage|console\.log\(/);
});

test('credential hub shares the guarded write-only editor and preserves operator-secret authority', async () => {
  const [setup, server, route, canonicalRoute, store, runtime, dialog, oldPage, login] = await Promise.all([
    read('components/credential-setup.tsx'),
    read('lib/credential-server.ts'),
    read('app/api/setup/credentials/route.ts'),
    read('app/api/admin/credentials/route.ts'),
    read('lib/credential-store.ts'),
    read('lib/runtime-secrets.ts'),
    read('components/credential-dialog.tsx'),
    read('app/setup/credentials/page.tsx'),
    read('components/admin-login.tsx'),
  ]);

  assert.match(setup, /fetch\('\/api\/admin\/credentials',\{cache:'no-store'\}\)/);
  assert.match(setup, /<CredentialDialog purpose=\{key\}/);
  assert.match(setup, /status\.bootstrapOnly\|\|key==='ADMIN_GOOGLE_CLIENT_SECRET'/);
  assert.match(dialog, /type="password" name="secret"/);
  assert.match(dialog, /element\.reset\(\);setBusy\(true\)/);
  assert.match(dialog, /finally\{setBusy\(false\);element\.reset\(\);\}/);
  assert.match(dialog, /ChangeOpen\(value:boolean\)\{form\.current\?\.reset\(\);setMessage\(''\);setOpen\(value\);\}/i);
  assert.doesNotMatch(dialog, /localStorage|sessionStorage|console\.log\(/);
  assert.match(server, /if\(!await getGoogleAdmin\(request\)\)return rejected\(request,'Google owner sign-in required\.',403\)/,
    'credential management requires the verified Google owner session; visitor cookies do not grant access');
  assert.match(server, /request\.headers\.get\('origin'\)!==new URL\(request\.url\)\.origin/);
  assert.match(server, /new URL\(request\.url\)\.protocol!=='https:'/);
  assert.match(server, /secret:z\.string\(\)\.min\(12\)\.max\(2048\)/);
  assert.match(server, /An operator-managed key is already configured/);
  assert.match(server, /bootstrapSealed:state\.sealed_at!==null/);
  assert.match(server, /input\.shareWithBusiness[\s\S]*runtime\.ADMIN_GOOGLE_CLIENT_ID!==runtime\.GOOGLE_BUSINESS_CLIENT_ID/);
  assert.match(store, /if\(nativeValue\)return \{value:nativeValue,source:'native' as const\}/);
  assert.match(runtime, /let secret=runtime\.ADMIN_GOOGLE_CLIENT_SECRET;if\(!secret\)\{secret=\(await credentialStore\(\)\.resolve\('ADMIN_GOOGLE_CLIENT_SECRET'\)\)\.value\?\?undefined;\}/);
  assert.match(route, /export async function GET\(request:Request\)\{return credentialRoute\(request\);\}/);
  assert.match(route, /export async function POST\(request:Request\)\{return credentialRoute\(request\);\}/);
  assert.match(canonicalRoute, /export const GET=credentialRoute/);
  assert.match(canonicalRoute, /export const POST=credentialRoute/);
  assert.match(oldPage, /redirect\(credentialDestination\(/);
  assert.doesNotMatch(oldPage, /CredentialSetup|<input|type=["']password/);
  assert.match(login, /href="\/privacy"/);
  assert.match(login, /href="\/terms"/);
  assert.doesNotMatch(server, /safeJson\(\{[^}]*secret:/s);
});

test('privacy and terms describe the configured standalone installation without source-demo assumptions', async () => {
  const [privacy, terms] = await Promise.all([read('app/privacy/page.tsx'), read('app/terms/page.tsx')]);

  assert.match(privacy, /A preferred-date request is saved in this installation&apos;s workspace; it is not an appointment/);
  assert.match(privacy, /verified Google email is on the installation&apos;s owner allowlist/);
  assert.match(privacy, /The contact form asks for your name, email address and message/);
  assert.match(privacy, /A receipt means the message was saved to this installation&apos;s private workspace/);
  assert.match(privacy, /The per-field prefill state stays in page memory/);
  assert.match(privacy, /Analytics and Experiments are separate optional choices and start off/);
  assert.match(privacy, /Withdrawal stops future eligible measurement/);
  assert.match(privacy, /A person must review and approve any public help change/);
  assert.match(privacy, /No particular data-residency location, legal certification/);
  assert.match(terms, /A preferred-date request does not reserve time, establish availability or create an appointment/);
  assert.match(terms, /whose email is on the installation&apos;s owner allowlist/);
  assert.match(terms, /No particular data residency, legal compliance certification/);
  for (const content of [privacy, terms]) {
    assert.doesNotMatch(content, /public demonstration|private demo|live business website|Site identity|Montana|Billings|Sprinkler/i,
      'installation policy must not inherit the source demo business or native Sites access model');
  }
});
