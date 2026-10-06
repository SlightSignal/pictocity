// Transpile and import the actual browser helper; no substituted production functions.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
export const productionHelperPath = resolve('packages/editor/src/export-download.ts');
const helper = pathToFileURL(productionHelperPath).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/components/Dialogs.tsx') && specifier === '../export-download') return { url: helper, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === helper) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
    return next(url, context);
  },
});
export const productionDownload = await import(helper);
