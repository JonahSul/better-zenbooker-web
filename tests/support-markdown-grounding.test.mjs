import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = await import('typescript');
const supportSource = await readFile(path.join(root, 'lib/support-core.ts'), 'utf8');
const supportJs = ts.default.transpileModule(supportSource, {
  compilerOptions: { module: ts.default.ModuleKind.CommonJS, target: ts.default.ScriptTarget.ES2022 },
}).outputText;
const supportModule = { exports: {} };
new Function('require', 'module', 'exports', supportJs)(specifier => {
  if (specifier === 'zod/v3') return require(specifier);
  throw new Error(`Unexpected support-core dependency: ${specifier}`);
}, supportModule, supportModule.exports);
const support = supportModule.exports;
const groundingSource = await readFile(path.join(root, 'lib/support-grounding.ts'), 'utf8');
const groundingJs = await (async () => {
  return ts.default.transpileModule(groundingSource, {
    compilerOptions: { module: ts.default.ModuleKind.CommonJS, target: ts.default.ScriptTarget.ES2022 },
  }).outputText;
})();
const groundingModule = { exports: {} };
new Function('require', 'module', 'exports', groundingJs)(specifier => {
  if (specifier === 'zod/v3') return require(specifier);
  throw new Error(`Unexpected support-grounding dependency: ${specifier}`);
}, groundingModule, groundingModule.exports);
const grounding = groundingModule.exports;

const markdownPath = path.join(root, 'components/support-markdown.tsx');
const markdownSource = await readFile(markdownPath, 'utf8');
const markdownBundle = await build({
  stdin: { contents: markdownSource, resolveDir: root, sourcefile: 'components/support-markdown.tsx', loader: 'tsx' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  write: false,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const markdownModule = { exports: {} };
new Function('require', 'module', 'exports', markdownBundle.outputFiles[0].text)(require, markdownModule, markdownModule.exports);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function renderMarkdown(children) {
  const SupportMarkdown = markdownModule.exports.default ?? markdownModule.exports;
  return renderToStaticMarkup(React.createElement(SupportMarkdown, { children }));
}

test('incoming support questions route timing and procedural requests to verified unknown answers', () => {
  const cases = [
    ['How long does a fall blowout usually take?', 'unsupported_timing'],
    ['Would it be roughly an hour and a half?', 'unsupported_timing'],
    ['Can I drain the demo lines by gravity instead?', 'unsupported_procedure'],
    ['What pressure should I set the compressor to, and when do I open each zone?', 'unsupported_procedure'],
  ];
  for (const [question, expected] of cases) {
    assert.equal(grounding.routeSupportQuestion(question), expected, question);
  }
});

test('answer guard blocks unsupported durations and equipment or drain procedures, including paraphrases', () => {
  const cases = [
    ['Most systems take around 90 minutes.', 'unsupported_timing'],
    ['Expect the appointment to run for about one to two hours.', 'unsupported_timing'],
    ['Set the compressor to 50 PSI and open each zone until only air comes out.', 'unsupported_procedure'],
    ['Use gravity to empty the lines through the backflow drain.', 'unsupported_procedure'],
  ];
  for (const [answer, reason] of cases) {
    const result = grounding.guardSupportAnswer(answer, { photoDerived: false });
    assert.equal(result.allowed, false, answer);
    assert.equal(result.reason, reason, answer);
    assert.equal(result.answer, grounding.verifiedUnknownAnswer(reason));
  }
});

test('photo-derived certainty is withheld while cautious visual observations remain qualified', () => {
  const certain = grounding.guardSupportAnswer('The valve body is cracked and that is causing the leak.', { photoDerived: true });
  assert.equal(certain.allowed, false);
  assert.equal(certain.reason, 'photo_certainty');

  const cautious = grounding.guardSupportAnswer('The photo appears to show a wet area, but I cannot verify its cause from an image.', { photoDerived: true });
  assert.equal(cautious.allowed, true);
  assert.equal(cautious.reason, 'supported');
});

test('verified unknown responses do not supply a duration, pressure, or repair procedure', () => {
  for (const kind of ['unsupported_timing', 'unsupported_procedure', 'photo_certainty']) {
    const answer = grounding.verifiedUnknownAnswer(kind);
    assert.equal(typeof answer, 'string');
    assert.doesNotMatch(answer, /\b(?:\d+\s*(?:minutes?|hours?|psi)|gravity drain|compressor setting|open each zone)\b/i);
  }
});

test('support Markdown renders the approved subset and drops raw HTML, links, and images', () => {
  const html = renderMarkdown([
    '## What is known',
    '',
    'Use **bold** and *emphasis* with `plain code`.',
    '',
    '1. First item',
    '2. Second item',
    '',
    '<script>alert("x")</script><img src="https://evil.example/p.png" onerror="alert(1)">',
    '[unsafe link](javascript:alert(1))',
    '![image](https://evil.example/photo.png)',
  ].join('\n'));

  assert.match(html, /<h2>What is known<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<code>plain code<\/code>/);
  assert.match(html, /<ol>[\s\S]*<li>First item<\/li>[\s\S]*<\/ol>/);
  assert.doesNotMatch(html, /<script|<img|<a\b|href=|onerror=/i);
  assert.doesNotMatch(html, /javascript:|evil\.example|alert\(/i);
});

test('public answer redaction preserves readable Markdown link labels before safe rendering', () => {
  const answer = support.publicSupportAnswer([
    'Use **the booking page** for current options.',
    '[Open booking](https://widget.zenbooker.com/book/demoblowoutguttercleaning)',
    '[Unsafe](javascript:alert(1)) ![image](https://evil.example/diagram.png)',
    'Contact fixture-person@example.invalid or +1 (406) 555-0199.',
    '<script>alert("x")</script>',
  ].join('\n\n'));
  const html = renderMarkdown(answer);

  assert.match(html, /<strong>the booking page<\/strong>/);
  assert.match(html, /Open booking/);
  assert.match(html, /Unsafe/);
  assert.doesNotMatch(html, /\[Open booking\]\(|\[link omitted\]|https?:\/\/|javascript:|evil\.example|<script|<img|<a\b|href=|onerror=|alert\(/i);
  assert.doesNotMatch(html, /fixture-person@example\.invalid|555-0199/);
});
