// Load isolated compiled candidate bytes at the existing test import URLs.
// No dependency or released/canonical dist file is modified.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = resolve(process.env.PICTOCITY_RECOVERY_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)));
const build = process.env.PICTOCITY_RECOVERY_BUILD ? resolve(process.env.PICTOCITY_RECOVERY_BUILD) : undefined;
const roots = ['core', 'server'].map(name => ({ name, url: pathToFileURL(join(root, 'packages', name, 'dist/')).href }));
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@pictocity/core') return { url: roots[0].url + 'index.js', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const match = roots.find(item => url.startsWith(item.url));
    if (build && match && url.endsWith('.js')) return { format: 'module', shortCircuit: true, source: readFileSync(join(build, match.name, fileURLToPath(url).slice(fileURLToPath(match.url).length)), 'utf8') };
    return next(url, context);
  },
});
