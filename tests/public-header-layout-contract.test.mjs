import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

function header(markup, label) {
  const match = markup.match(/<header\b[\s\S]*?<\/header>/);
  assert.ok(match, `${label} should have a header`);
  return match[0];
}

test('public homepage and compiled template expose generic links and gate optional account/booking surfaces', async () => {
  const [home, template] = await Promise.all([read('app/page.tsx'), read('lib/public-template.tsx')]);
  assert.match(home, /<a data-measurement-element="home_contact_header" href="\/contact">Contact<\/a>/, 'contact remains a core public destination with its registered measurement target');
  assert.match(home, /ready\('booking'\)&&<><a data-measurement-element="home_book_header" href="\/book">Book<\/a>[\s\S]*?<a href="\/appointments">Appointments<\/a>/,
    'booking links are rendered only while the booking module is ready');
  assert.match(home, /ready\('google'\)&&<ConnectedAccountMenu\/>/,
    'the optional customer account control follows verified Google module readiness');
  assert.doesNotMatch(home, /href="\/admin(?:\/|"|\?)/, 'public navigation does not expose the owner console');

  assert.match(template, /<a data-measurement-element="home_contact_header" href="\/contact">Contact<\/a>/);
  assert.match(template, /data-public-booking="navigation"/);
  assert.match(template, /data-public-island="account"/);
  assert.match(template, /data-public-offerings="published"/);
  assert.match(template, /Business website/);
  assert.doesNotMatch(template, /Demo Business|Montana|Billings|Sprinkler/i);
});

test('compiled account mount stays empty of identity while its interactive control has an accessible name', async () => {
  const [template, accountMenu] = await Promise.all([
    read('lib/public-template.tsx'), read('components/account-menu.tsx'),
  ]);
  const publicHeader = header(template, 'cached template');
  const placeholder = publicHeader.match(/<div data-public-island="account">([\s\S]*?)<\/div>/)?.[1] ?? '';

  assert.equal(placeholder, '', 'cached HTML does not serialize visitor identity or a stale account state');
  assert.match(accountMenu, /aria-label="Open account menu"/);
  assert.match(accountMenu, /<span>Account<\/span>/);
});

test('header action styles cover the 480/481 and 700px source breakpoints without changing the global menu', async () => {
  const [globalCss, accountCss, supportCss] = await Promise.all([
    read('app/globals.css'), read('components/account-menu.css'), read('components/visitor-support.css'),
  ]);
  const css = `${globalCss}\n${accountCss}\n${supportCss}`;

  assert.doesNotMatch(css, /\.header-contact\s*>\s*a:first-child/, 'Contact visibility must not depend on child position');
  assert.match(css, /\.header-contact-link\s*\{[^}]*display\s*:\s*none/s, 'small-screen Contact should be selected by its semantic class');
  assert.match(accountCss, /\.header-contact\s*\{[^}]*flex-wrap\s*:\s*nowrap/s, 'header actions must not wrap');
  assert.match(accountCss, /@media\s*\(max-width:\s*480px\)/, 'the 480px compact account rule remains explicit');
  assert.match(css, /@media\s*\(max-width:\s*700px\)/, 'keep the coordinated small-screen breakpoint');
  assert.match(css, /\.header[^}]*\.account-menu-trigger[^}]*min-height\s*:\s*44px/s, 'Account keeps a 44px touch target');
  assert.match(css, /\.header[^}]*\.button[^}]*min-height\s*:\s*44px/s, 'Book keeps a matching 44px touch target');
  assert.match(css, /\.header[^}]*\.brand[^}]*min-width\s*:\s*0/s, 'the brand can shrink before actions are crowded');
  assert.match(css, /\.header[^}]*\.brand-wordmark[^}]*max-width\s*:\s*100%/s, 'the wordmark scales within its flexible brand area');
  assert.match(css, /\.header[^}]*\.account-menu-trigger[^}]*span[^}]*display\s*:\s*none/s, 'Account text may become icon-only without removing its accessible name');
});
