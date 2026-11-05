import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);

export async function loadTsTestModule(root, relativePath, overrides = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3') return require(specifier);
    if (specifier === 'node:net') return require(specifier);
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

export async function loadAbuseCore(root) {
  return loadTsTestModule(root, 'lib/visitor-abuse-core.ts');
}
