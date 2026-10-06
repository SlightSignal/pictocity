// Select original store/atomic tests verbatim, retaining every assertion.
// This is a selected ten-case run, NOT a pass for the full codec/transport suite.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
await import('./build-hooks.mjs');
const { DocStore, RevisionConflict } = await import('../../packages/server/dist/store.js');
const { atomicWrite } = await import('../../packages/server/dist/atomic-file.js');
const { deepClone, makeShape, makeGroup } = await import('../../packages/core/dist/index.js');
const source = fs.readFileSync(resolve('tools/reliability-tests.mjs'), 'utf8');
const ast = ts.createSourceFile('reliability-tests.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set([
  'committed edits recover before a debounced snapshot',
  'incomplete log tail is retained for diagnosis and repaired before another edit',
  'missing log revision blocks editing instead of publishing partial recovery',
  'snapshot failure reports unhealthy persistence and can be retried',
  'failed atomic publication preserves its previous file',
  'stale revisions refuse without changing history or bytes',
  'locking then editing in one batch refuses the whole batch',
  'locked group protects its child',
  'failed history write does not publish document or revision',
  'listener failure does not turn a committed edit into a refusal',
]);
const selected = [];
function visit(node) {
  if (ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression) && ts.isCallExpression(node.expression.expression)) {
    const call = node.expression.expression;
    if (call.expression.getText(ast) === 'test' && ts.isStringLiteral(call.arguments[0]) && names.has(call.arguments[0].text)) selected.push({ name: call.arguments[0].text, source: node.getText(ast) });
  }
  ts.forEachChild(node, visit);
}
visit(ast); assert.equal(selected.length, 10);
const dir = resolve('tools/recovery-integrity-evidence/compatibility/selected-reliability'); fs.mkdirSync(dir, { recursive: true });
const envelope = (doc, ops, extra = {}) => ({ docId: doc.id, actor: 'test', ops, ...extra });
const report = { scope: 'Ten existing store/atomic cases, exact original bodies and assertions; full suite cannot-run (spawnSync EPERM)', originalSha256: createHash('sha256').update(source).digest('hex'), cases: [] };
const test = async (name, fn) => { await fn(); report.cases.push(name); console.log('ok ' + name); };
const inputs = { assert, join, dir, DocStore, RevisionConflict, atomicWrite, deepClone, makeShape, makeGroup, envelope, test, ...Object.fromEntries(['writeFileSync', 'readFileSync', 'mkdirSync', 'rmSync', 'existsSync'].map(k => [k, fs[k]])) };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
await new AsyncFunction(...Object.keys(inputs), selected.map(item => item.source).join('\n'))(...Object.values(inputs));
fs.writeFileSync(join(dir, 'original-test-bodies.txt'), selected.map(item => item.source).join('\n\n'));
fs.writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
console.log('10 selected existing reliability tests passed (full suite remains cannot-run)');
