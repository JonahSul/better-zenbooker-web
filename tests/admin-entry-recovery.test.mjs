import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the Admin landing checks native identity before protected reads and renders normal recovery without redirecting away', async () => {
  const source = await readFile(path.join(root, 'app/admin/page.tsx'), 'utf8');
  assert.match(source, /getChatGPTUser\(\)/);
  assert.match(source, /if\(!await getChatGPTUser\(\)\)return\s*<NativeAdminRecovery\s*\/>/);
  assert.match(source, /<NativeAdminRecovery\s*\/>[\s\S]*?getGoogleAdmin\(\)/);
  assert.doesNotMatch(source, /requireChatGPTUser\(['"]\/admin['"]\)/);
  assert.doesNotMatch(source, /redirect\(/);
});

test('native Admin recovery offers the normal top-level sign-in and generic account menu only', async () => {
  const page = await readFile(path.join(root, 'app/admin/page.tsx'), 'utf8');
  const imports = [...page.matchAll(/import\s+(\{[^}]*\}|[\w$]+)\s+from\s+['"]([^'"]+)['"]/g)];
  const recoveryImport = imports.find(([, binding]) => binding.includes('NativeAdminRecovery'));
  assert.ok(recoveryImport, 'the route should import its recovery component');
  const modulePath = path.resolve(root, 'app/admin', recoveryImport[2]);
  const source = await readFile(modulePath.endsWith('.tsx') ? modulePath : `${modulePath}.tsx`, 'utf8');
  assert.match(source, /ConnectedAccountMenu/);
  assert.match(source, /chatGPTSignInPath\(['"]\/admin['"]\)/);
  assert.match(source, /target="_top"/);
  assert.match(source, /Continue to administration/);
  assert.doesNotMatch(source, /AdminShell|Overview|AdminLogin|AdminPanel|credentials|private/i);
});

test('only the native-authenticated AdminLogin surface opts into direct Google sign-in presentation', async () => {
  const [page, login, wrapper, menu] = await Promise.all([
    readFile(path.join(root, 'app/admin/page.tsx'), 'utf8'),
    readFile(path.join(root, 'components/admin-login.tsx'), 'utf8'),
    readFile(path.join(root, 'components/admin-account-menu.tsx'), 'utf8'),
    readFile(path.join(root, 'components/account-menu.tsx'), 'utf8'),
  ]);
  assert.match(page, /<AdminLogin\s*\/>/,
    'only a native-authenticated user can reach this direct Google sign-in page');
  assert.match(login, /<AdminAccountMenu\s+onSignIn=/);
  assert.match(wrapper, /explicitAdminEntry=\{!!onSignIn\}/);
  assert.match(menu, /controls\.showAdmin\|\|explicitAdminEntry/);
  assert.match(menu, /actions\.adminSignIn[\s\S]*?Sign in to administration/);
});
