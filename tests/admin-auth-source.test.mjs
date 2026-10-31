import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

test('opaque admin session is hashed, expires, and is bound to the first-party browser session', async () => {
  const source = await read('lib/admin-auth-server.ts');
  const visitor = await read('app/chatgpt-auth.ts');
  assert.match(source, /const token=cookieValue\(req,ADMIN_COOKIE\)/);
  assert.match(source, /eq\(adminSessions\.sessionHash,await sha256\(token\)\)/);
  assert.match(source, /eq\(adminSessions\.siteUserId,user\.userId\)/);
  assert.match(source, /gt\(adminSessions\.expiresAt,Date\.now\(\)\)/);
  assert.match(source, /allowedAdminEmail\(row\.email,true\)/);
  assert.match(source, /ADMIN_COOKIE='__Host-admin_session'/);
  assert.match(source, /ADMIN_COOKIE\+'='\+token\+'; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age='/);
  assert.match(source, /identity\.expiresAt/);
  assert.match(visitor, /__Host-browser_session/);
  assert.match(visitor, /userId:'browser:'\+await sha256\(token\)/);
  assert.doesNotMatch(visitor, /oai-authenticated-user|sites\.openai/i, 'the browser namespace does not trust native Sites identity headers');
  assert.doesNotMatch(source, /localStorage|sessionStorage|Bearer\s/);
});

test('OIDC state is one-time, browser-session-bound and expires before any code exchange', async () => {
  const source = await read('lib/admin-auth-server.ts');
  assert.match(source, /stateHash:await sha256\(state\),siteUserId:user\.userId,nonceHash:await sha256\(nonce\),configFingerprint:await adminConfigFingerprint\(config\),configRevision:boundary\.revision,expiresAt:Date\.now\(\)\+600000/);
  const consume = source.indexOf('getDb().delete(adminOauthStates)');
  const exchange = source.indexOf('(dependencies.exchangeToken??exchangeAdminCode)(config,code)');
  assert.ok(consume >= 0 && exchange > consume, 'state row must be consumed before token exchange');
  assert.match(source, /eq\(adminOauthStates\.stateHash,await sha256\(state\)\),eq\(adminOauthStates\.siteUserId,user\.userId\),gt\(adminOauthStates\.expiresAt,Date\.now\(\)\)/);
  assert.match(source, /await sha256\(claims\.nonce\)!==rows\[0\]\.nonceHash/);
  assert.match(source, /'Referrer-Policy':'no-referrer'/);
});

test('logout revokes local D1 session and expires the host-only cookie', async () => {
  const source = await read('lib/admin-auth-server.ts');
  assert.match(source, /if\(action==='logout'\)[\s\S]*?getDb\(\)\.delete\(adminSessions\)[\s\S]*?ADMIN_COOKIE\+'=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'/);
});

test('every inquiry read/update requires Google administration while public inquiry POST remains available', async () => {
  const route = await read('app/api/inquiries/route.ts');
  assert.match(route, /export async function GET\(request:Request\)\{const denied=await adminGuard\(request\)/);
  assert.match(route, /export async function PATCH\(request:Request\)\{const denied=await adminGuard\(request\)/);
  assert.match(route, /export async function POST\(request:Request\)\{return mutate\(request,false\);\}/);
});

test('Google Business Profile mutations use the verified owner guard; legacy routes stay redirects', async () => {
  const server = await read('lib/google-reviews-server.ts');
  assert.match(server, /if\(action!=='display'\)\{const denied=await adminGuard\(request\)/);
  assert.match(server, /user\.userId!==config\.ownerUserId\|\|!await getGoogleAdmin\(request\)/);
});

test('admin tools and manager pages require verified Google administration', async () => {
  const tools = await read('app/api/admin/tools/route.ts');
  const visitor = await read('app/chatgpt-auth.ts');
  assert.match(tools, /const denied=await adminGuard\(request\)/);
  const admin = await read('app/admin/page.tsx');
  assert.match(admin, /if\(!await getChatGPTUser\(\)\)return <NativeAdminRecovery\/>/);
  assert.match(admin, /getGoogleAdmin\(\)/);
  assert.match(visitor, /__Host-browser_session/);
  assert.doesNotMatch(visitor, /oai-authenticated-user/);
  const manager = await read('app/manage/page.tsx');
  assert.match(manager, /await requireChatGPTUser\('\/manage'\)/);
  assert.match(manager, /if\(!await getGoogleAdmin\(\)\)redirect\('\/admin'\)/);
  const reviews = await read('app/manage/google-reviews/page.tsx');
  assert.match(reviews, /redirect\('\/admin\/reviews'\)/);
  assert.doesNotMatch(reviews, /<form|<input|GoogleReviewsManage/);
});

test('production auth callback has no fixture bypass; dependencies are injected only by tests', async () => {
  const callbackRoute = await read('app/api/admin/auth/callback/route.ts');
  assert.match(callbackRoute, /adminAuthRoute\('callback',request\)/);
  assert.doesNotMatch(callbackRoute, /dependencies|exchangeToken|verifyToken|TEST_/);
  const server = await read('lib/admin-auth-server.ts');
  assert.match(server, /dependencies:AdminAuthDependencies=\{\}/);
  assert.match(server, /dependencies\.exchangeToken\?\?exchangeAdminCode/);
  assert.match(server, /dependencies\.verifyToken\?\?verifyGoogleAdminToken/);
  assert.doesNotMatch(server, /process\.env|TEST_USER|test-mode|x-test-/i);
});
