import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

test('shared account entry is wired into public, customer and Admin page shells without public Admin links', async () => {
  const [template, home, islands, customerShell, adminShell, bookingPanel, appointmentsPage] = await Promise.all([
    read('lib/public-template.tsx'),
    read('app/page.tsx'),
    read('client/public-islands.tsx'),
    read('components/customer-shell.tsx'),
    read('components/admin-shell.tsx'),
    read('components/hosted-booking-panel.tsx'),
    read('app/appointments/page.tsx'),
  ]);

  assert.ok(/data-public-island="account"/.test(template), 'public template needs a generic account island');
  assert.ok(!/href="\/admin"/.test(template), 'cached public HTML must not include an unconditional Admin entry');
  assert.ok(!/href="\/admin"/.test(home), 'the public home page must not include an unconditional Admin footer entry');
  assert.ok(/account:\s*ConnectedAccountMenu/.test(islands), 'the static public entry must hydrate the connected shared account menu');
  assert.ok(/<ConnectedAccountMenu\b/.test(customerShell), 'CustomerShell needs the connected shared menu');
  assert.ok(/<AdminAccountMenu\b/.test(adminShell), 'Admin shell needs the shared menu');
  assert.ok(!/hosted-booking-account|Use Google contact details|Sign in with Google/.test(bookingPanel), 'booking details belong in the shared menu');
  assert.ok(!/PUBLIC_SERVICE_LINKS\.map|<label>Service<select/.test(bookingPanel), 'static marketing services must not act as current offerings');
  assert.ok(/<CustomerShell\b/.test(appointmentsPage), 'appointment route shares the account-enabled CustomerShell');
});

test('cached public template has a generic account entry and no personalized account fields', async () => {
  const [template, accountMenu, accountController] = await Promise.all([
    read('lib/public-template.tsx'), read('components/account-menu.tsx'), read('lib/account-controller.ts'),
  ]);
  assert.ok(/data-public-island="account"/.test(template), 'public template needs a generic account island');
  assert.ok(/GENERIC_ACCOUNT_SNAPSHOT/.test(accountMenu), 'public account SSR should use generic state');
  assert.ok(!/customer\.email|customer_name|customer_email|google_subject|profile\.email/.test(template), 'static HTML must not contain identity fields');
  assert.ok(!/localStorage|document\.cookie|sessionStorage/.test(accountController), 'identity must remain in memory');
});

test('public menu coordination failure remains visible and does not gate the configured Google action', async () => {
  const [connectedMenu, accountController] = await Promise.all([
    read('components/connected-account-menu.tsx'),
    read('lib/account-controller.ts'),
  ]);
  assert.ok(/CustomerAuthCoordinator/.test(connectedMenu), 'connect and logout should use the shared coordinator');
  assert.ok(/lock_unavailable|coordination unavailable/i.test(connectedMenu), 'missing Web Locks should produce a visible actionable state');
  assert.ok(/Retry/i.test(connectedMenu), 'the unavailable action needs a retry path');
  assert.doesNotMatch(connectedMenu, /const configured=snapshot\.customer\.configured&&.*navigator\.locks/);
  assert.ok(/showGoogleSignIn/.test(accountController), 'the Google guest action is projected from server configuration and status');
});
