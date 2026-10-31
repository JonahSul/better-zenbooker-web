import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = relativePath => readFile(path.join(root, relativePath), 'utf8');

test('Contact page uses the shared shell and keeps booking and appointment help distinct', async () => {
  const [page, shell] = await Promise.all([source('app/contact/page.tsx'), source('components/customer-shell.tsx')]);
  assert.match(page, /<CustomerShell/);
  assert.match(page, /<ContactForm\s*\/>/);
  assert.match(page, /href="\/book"/);
  assert.match(page, /href="\/appointments"/);
  assert.doesNotMatch(page, /tel:|\+1-406-|Billings|Montana/i, 'contact details come from owner configuration, not copied demo identity');
  assert.match(shell, /href="\/contact"|href:\s*'\/contact'/);
});

test('public message form has bounded name, email and message fields with durable-receipt copy and no notification controls', async () => {
  const [form, core] = await Promise.all([source('components/contact-form.tsx'), source('lib/contact-core.ts')]);
  assert.match(form, /fetch\('\/api\/contact\/config',[\s\S]*cache:'no-store'/);
  assert.match(form, /fetch\('\/api\/contact\/messages'/);
  assert.match(form, /name="name"[\s\S]*maxLength=\{80\}/);
  assert.match(form, /name="email"[\s\S]*maxLength=\{254\}/);
  assert.match(form, /name="message"[\s\S]*maxLength=\{4000\}/);
  assert.match(form, /Thanks—we’ve received your message\./);
  assert.match(form, /We could not confirm receipt\./);
  assert.match(core, /\.strict\(\)/);
  assert.doesNotMatch(form, /attachment|notification|BCC|recipient/i);
  assert.doesNotMatch(form, /Analytics|dataLayer|captureConversion/i);
});

test('inquiries workspace keeps Contact, real appointments and legacy date requests in separate panes', async () => {
  const [page, workspace] = await Promise.all([source('app/admin/inquiries/page.tsx'), source('components/booking-inquiry-workspace.tsx')]);
  assert.match(page, /requireChatGPTUser\('\/admin\/inquiries'\)/);
  assert.match(page, /getGoogleAdmin\(\)/);
  assert.match(page, /if\(!admin\)redirect\('\/admin'\)/);
  assert.match(workspace, /ContactInbox/);
  assert.match(workspace, /ContactNotificationsPanel/);
  assert.match(workspace, /<AppointmentsAdmin\s*\/>/);
  assert.match(workspace, /<InquiriesAdmin\s*\/>/);
  assert.match(workspace, /Contact messages/);
  assert.match(workspace, /Website appointments/);
  assert.match(workspace, /Legacy date requests/);
});

test('notification panel requires an explicit check or item dispatch and exposes only status presence', async () => {
  const panel = await source('components/contact-notifications-panel.tsx');
  const audit = await source('components/console-panels.tsx');
  assert.match(panel, /purpose="CLOUDFLARE_EMAIL_API_TOKEN"/);
  assert.match(panel, /Sender domain verified\./);
  assert.match(audit, /row\.target\.domainEnabled\?'Sender domain verified\.'/);
  assert.match(panel, /onClick=\{\(\)=>void action\('check-sender'/);
  assert.match(panel, /!status\?\.sender\.evidenceFresh/);
  assert.match(panel, /window\.confirm\('Send this one pending notification now\?'/);
  assert.match(panel, /row\.state!=='pending'/);
  assert.match(panel, /expectedRevision:row\.revision/);
  assert.match(panel, /blocked history is not sent automatically/i);
  assert.doesNotMatch(panel, /status\.(?:to|bcc|subjectPrefix)\b|config\.(?:to|bcc|subjectPrefix)\b/);
});
