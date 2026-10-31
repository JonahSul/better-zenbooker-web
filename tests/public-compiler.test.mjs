import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeRequire = createRequire(import.meta.url);
const read = (file) => readFile(path.join(root, file), 'utf8');
const artifacts = JSON.parse(await read('generated/public-artifacts.json'));

async function loadCompiler() {
  const source = await read('lib/public-compiler.ts');
  const coreSource = await read('lib/experiment-core.ts');
  const coreJs = ts.transpileModule(coreSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const coreModule = { exports: {} };
  new Function('require', 'module', 'exports', coreJs)(nodeRequire, coreModule, coreModule.exports);
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === '../generated/public-artifacts.json') return artifacts;
    if (specifier === './experiment-core') return coreModule.exports;
    if (specifier === './site-config') {
      return { DEMO_ORIGIN: 'https://business.example.test' };
    }
    if (specifier === './discovery') return { homeStructuredData: { '@context': 'https://schema.org', '@graph': [] } };
    throw new Error(`Unexpected public compiler import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(requireMock, loaded, loaded.exports);
  return loaded.exports;
}

const compiler = await loadCompiler();

test('the generated public baseline is generic static HTML with named interaction mounts', () => {
  assert.equal(artifacts.rendererVersion, 'public-v4-m2');
  assert.ok(artifacts.assetManifestHash.length === 64);
  assert.match(artifacts.entry, /^\/_islands\/public-[A-Za-z0-9_-]+\.js$/);
  assert.ok(artifacts.styles.length >= 1);
  assert.ok(artifacts.body.length > 1000, 'generated public body must not be an unbuilt placeholder');
  for (const island of ['account', 'inquiry', 'reviews', 'analytics', 'experiments', 'support']) {
    assert.ok(artifacts.body.includes(`data-public-island="${island}"`), `missing ${island} island root`);
  }
  assert.match(artifacts.body, /<h1\b/);
  assert.match(artifacts.body, /<h1\b[^>]*>Business website<\/h1>/, 'generic baseline heading retains its registered measurement marker');
  assert.match(artifacts.body, /Owner approved business information\./);
  assert.doesNotMatch(artifacts.body, /Demo Business|Montana|Billings|Sprinkler|seasonal/i);
  assert.doesNotMatch(artifacts.body, /<div[^>]+id=["'](?:root|__next)["']/i);
  assert.doesNotMatch(artifacts.body, /data-admin|admin-dashboard|admin-chat|private-manager/i);
  assert.equal(compiler.publicArtifacts.rendererVersion, artifacts.rendererVersion);
});

function assertSingleSupportMount(html, label) {
  assert.equal((html.match(/data-public-island="support"/g) ?? []).length, 1, `${label} has exactly one support mount`);
  assert.doesNotMatch(html, /class="support-launcher"|id="visitor-support-dialog"/,
    `${label} keeps optional support UI out of the compiled snapshot until module readiness is confirmed`);
}

test('compiled baseline and altered compositions each contain one generic optional support mount', async () => {
  const control = await compiler.compilePublicDocument({}, artifacts);
  const alternate = await compiler.compilePublicDocument({ headline: 'A clearer way to book a service' }, artifacts);
  assertSingleSupportMount(artifacts.baseline.html, 'built baseline');
  assertSingleSupportMount(control.html, 'compiled control');
  assertSingleSupportMount(alternate.html, 'altered composition');
  assert.match(control.html, new RegExp(`<script type="module" src="${artifacts.entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"></script>`));
  assert.match(alternate.html, /A clearer way to book a service/);
});

test('headline composition preserves the fixed home heading measurement marker', async () => {
  const result = await compiler.compilePublicDocument({ headline: 'A different seasonal headline' }, artifacts);
  const h1 = result.html.match(/<h1\b[^>]*>A different seasonal headline<\/h1>/)?.[0];
  assert.ok(h1, 'the alternate headline is emitted');
  assert.match(h1, /data-measurement-element="home_heading"/);
  assert.equal((result.html.match(/data-measurement-element="home_heading"/g) ?? []).length, 1);
});

test('public compiler emits deterministic variants and escapes copy without changing section structure', async () => {
  const control = await compiler.compilePublicDocument({}, artifacts);
  const repeatedControl = await compiler.compilePublicDocument({}, artifacts);
  const alternate = await compiler.compilePublicDocument({ headline: 'A clearer service headline' }, artifacts);
  assert.equal(control.hash, repeatedControl.hash);
  assert.equal(control.html, repeatedControl.html);
  assert.notEqual(control.hash, alternate.hash);
  assert.equal(control.hash.length, 64);
  assert.equal((control.html.match(/<h1\b[^>]*>/g) ?? []).length, 1);
  assert.equal((alternate.html.match(/<h1\b[^>]*>/g) ?? []).length, 1);
  assert.match(alternate.html, /A clearer service headline/);
  assert.equal((alternate.html.match(/data-public-island=/g) ?? []).length, 6);
  const escaped = await compiler.compilePublicDocument({ headline: 'Care & seasonal preparation' }, artifacts);
  assert.match(escaped.html, /Care &amp; seasonal preparation/);
  await assert.rejects(compiler.compilePublicDocument({ headline: '<script>alert(1)</script> Unsafe heading' }, artifacts));
  await assert.rejects(compiler.compilePublicDocument({ service: 'arbitrary' }, artifacts));
  await assert.rejects(compiler.compilePublicDocument({ headline: 'x'.repeat(141) }, artifacts));
});

test('public island entry mounts only reserved roots and never hydrates the complete page', async () => {
  const source = await read('client/public-islands.tsx');
  assert.match(source, /import \{createRoot,hydrateRoot\} from 'react-dom\/client'/);
  assert.match(source, /document\.querySelectorAll\('\[data-public-island="'\+name\+'"\]'\)/);
  assert.match(source, /createRoot\(node\)\.render\(<Component\/>\)/);
  assert.match(source, /import \{createRoot,hydrateRoot\} from 'react-dom\/client'/);
  assert.match(source, /account:ConnectedAccountMenu,inquiry:InquiryForm,reviews:Reviews,analytics:AnalyticsConsent,experiments:ExperimentsConsent,support:VisitorSupport/);
  assert.match(source, /const optionalModules:Record<string,string>=\{account:'google',reviews:'reviews',analytics:'analytics',experiments:'experiments',support:'visitor_support'\}/);
  assert.match(source, /ready\[module\]===true&&\(name!=='support'\|\|ready\.ai===true\)/,
    'optional client mounts wait for server readiness, including the AI master gate for support');
  assert.doesNotMatch(source, /hydrateRoot\(document\.(?:body|documentElement)/);
  assert.doesNotMatch(source, /AdminLogin|AdminChat|AdminDashboard|Recharts|memory.graph/i);
});

test('analytics and experiment controls load server-verified independent grants before optional behavior', async () => {
  const template = await read('lib/public-template.tsx');
  assert.match(template, /data-public-island="analytics"/);
  assert.match(template, /data-public-island="experiments"/);
  assert.doesNotMatch(template, /googletagmanager\.com|<iframe|preconnect/i);

  const analytics = await read('components/analytics.tsx');
  assert.match(analytics, /let enabled=false/);
  assert.match(analytics, /consentSnapshot\(\)/);
  assert.match(analytics, /subscribePurposeConsent\(update\)/);
  assert.match(analytics, /refreshPurposeConsent\(\)\.then\(update\)/);
  assert.match(analytics, /choosePurposeConsent\('analytics',allow\)/);
  assert.match(analytics, /if\(result\.analytics\)maybeBind\(result\)/);
  assert.doesNotMatch(analytics, /verifyConsent|readCookie\(['"](?:analytics|purpose)/);
  assert.match(analytics, /if\(!allow\)enabled=false/);
  assert.match(analytics, /location\.reload\(\)/);

  const experiments = await read('components/experiments-consent.tsx');
  assert.match(experiments, /consentSnapshot\(\)/);
  assert.match(experiments, /subscribePurposeConsent\(update\)/);
  assert.match(experiments, /refreshPurposeConsent\(\)\.then\(update\)/);
  assert.match(experiments, /choosePurposeConsent\('experiments',value\)/);
  assert.match(experiments, /disabled=\{!ready\|\|busy\}/);
  assert.match(experiments, /window\.location\.reload\(\)/);
  assert.doesNotMatch(experiments, /sessionStorage|localStorage/);
});

test('generated assets are local public assets and the build records an asset-manifest hash', async () => {
  for (const url of [artifacts.entry, ...artifacts.styles]) {
    const local = path.join(root, 'public', url.replace(/^\//, '').replaceAll('/', path.sep));
    const bytes = await readFile(local);
    assert.ok(bytes.length > 0, `missing generated asset ${url}`);
  }
  const build = await read('scripts/build-public.mjs');
  assert.match(build, /createHash\('sha256'\)\.update\(JSON\.stringify\(files\)\)/);
  assert.match(build, /assetManifestHash/);
  assert.match(build, /await writeFile\('generated\/public-artifacts\.json',JSON\.stringify\(artifact\)\)/);
  const entryPath = path.join(root, 'public', artifacts.entry.replace(/^\//, '').replaceAll('/', path.sep));
  const entry = await readFile(entryPath, 'utf8');
  assert.match(entry, /support-launcher/);
  assert.match(entry, /visitor-support-dialog/);
});

test('Worker serves compiled experiment documents only after the module readiness gate', async () => {
  const worker = await read('worker/index.ts');
  const runtime = await read('lib/experiment-runtime.ts');
  assert.match(worker, /const exp=u\.pathname==='\/'&&\['GET','HEAD'\]\.includes\(request\.method\)\?await moduleStatus\(bindings as unknown as ModuleEnv,'experiments'\):null/);
  assert.match(worker, /exp\?\.status==='ready'&&exp\.config\.servePublicDocument===true/);
  assert.match(worker, /serveExperimentDocument\(new Request\(request,\{headers\}\)\)/);
  assert.match(runtime, /const approved=await[\s\S]*new ApprovedBaselineStore\(store\.db\)\.compatible\(digest\)/);
  assert.match(runtime, /snapshotContextMatches\(snapshot\.html,digest\)/,
    'the selected experiment snapshot is bound to the current published business context');
  assert.match(runtime, /'X-Public-Snapshot':selected\.hash/);
  assert.match(worker, /'noindex, nofollow'/);
  assert.match(worker, /'private, no-store'/);
});
