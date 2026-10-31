import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

test('aggregate activity stays on the protected Analytics admin page', async () => {
  const page = await read('app/admin/analytics/page.tsx');
  assert.match(page, /export const dynamic=['"]force-dynamic['"]/);
  assert.match(page, /requireChatGPTUser\(['"]\/admin\/analytics['"]\)/);
  assert.match(page, /if\(!admin\)redirect\(['"]\/admin['"]\)/);
  assert.match(page, /<ElementActivityPanel\s*\/>/);
});

test('report UI is aggregate-only and distinguishes other actions, empty data, and load failures', async () => {
  const panel = await read('components/element-activity-panel.tsx');
  assert.match(panel, /fetch\(['"]\/api\/admin\/analytics\/elements\/status['"],\{cache:['"]no-store['"]/);
  assert.match(panel, /fetch\(['"]\/api\/admin\/analytics\/elements\/report['"],\{method:['"]POST['"],cache:['"]no-store['"]/);
  for (const heading of ['Page', 'Element', 'Viewed', 'Actions', 'After view', 'Other actions', 'Rate']) {
    assert.ok(panel.includes(`'${heading}'`), `report table labels ${heading}`);
  }
  assert.match(panel, /<caption>Page element observations<\/caption>/);
  assert.match(panel, /<th scope="col"/);
  assert.match(panel, /role="region"[^>]*tabIndex=\{0\}/);
  assert.match(panel, /No observations in this period\./);
  assert.match(panel, /Element activity is unavailable\. Try again\./);
  assert.match(panel, /statusUnavailable\?['"]Collection status is unavailable\./);
  assert.match(panel, /Actions not matched to an earlier qualifying view in this report window/);
  assert.match(panel, /These are document observations, not people, attention or causal results\./);
  assert.match(panel, /Received requests are separate from confirmed bookings and revenue\./);
  assert.match(panel, /Google receipt is unverified/);
  assert.match(panel, /daily help curation schedule does not process these metrics/i);
  assert.match(panel, /<details><summary>Advanced context<\/summary>/);
  assert.doesNotMatch(panel, /visitorId|documentId|grantId|sourceHash|eventId/);
});

test('measurement and property reports are exposed through the fixed-owner native and typed read tools', async () => {
  const [native, typed, executor] = await Promise.all([
    read('lib/site-mcp.ts'), read('lib/mcp-call-contract.ts'), read('lib/admin-tools.ts'),
  ]);
  for (const name of ['measurement_element_status', 'measurement_element_report', 'analytics_property_configuration_status', 'analytics_property_configuration_save']) {
    assert.ok(native.includes(`name:'${name}'`), `native registry includes ${name}`);
    assert.ok(typed.includes(`'${name}'`), `native argument contract validates ${name}`);
  }
  assert.match(typed, /z\.object\(\{name:z\.literal\('measurement_element_report'\),arguments:elementReportInput/);
  assert.match(executor, /'measurement\.element_status','measurement\.element_report'/);
  assert.match(executor, /measurement\.element_status/);
  assert.match(executor, /measurement\.element_report/);
  assert.match(executor, /export async function executeAdminTool[\s\S]*?const admin=await getGoogleAdmin\(request\);if\(!admin\)throw new Error\('Google administration required'\)/,
    'typed read tools require a verified installer-allowlisted Google administrator session');
});

