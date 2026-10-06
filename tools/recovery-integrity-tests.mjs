import assert from 'node:assert/strict';
import fs, { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
await import('./recovery-integrity-fixtures/build-hooks.mjs');
const { DocStore } = await import('../packages/server/dist/store.js');
const { durableAppend } = await import('../packages/server/dist/atomic-file.js');
const { createDocument, makeShape, makeGroup, makeBrush, makeText, makeImage, makeFill, makeAdjustment, deepClone, applyOps } = await import('../packages/core/dist/index.js');
const root = resolve(process.env.PICTOCITY_RECOVERY_EVIDENCE ?? 'tools/recovery-integrity-evidence/red');
mkdirSync(root, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['packages/server/src/store.ts', 'packages/server/src/atomic-file.ts', 'tools/recovery-integrity-tests.mjs', 'tools/recovery-integrity-fixtures/build-hooks.mjs'];
const report = { scope: 'production DocStore and atomic functions; narrow fs fault hooks; no native/package/creative acceptance', build: process.env.PICTOCITY_RECOVERY_BUILD, sources: Object.fromEntries(sources.map(p => [p, hash(readFileSync(p))])), cases: [] };
if (process.env.PICTOCITY_RECOVERY_BUILD) {
  const build = resolve(process.env.PICTOCITY_RECOVERY_BUILD);
  report.productionSources = Object.fromEntries(['store.ts', 'atomic-file.ts'].map(p => [p, hash(readFileSync(join(build, '../source', p)))]));
  report.compiled = Object.fromEntries(['server/store.js', 'server/atomic-file.js', 'core/index.js'].map(p => [p, hash(readFileSync(join(build, p)))]));
}
let serial = 0;
function fixture(name, change = () => {}, log) {
  const dir = join(root, 'cases', `${++serial}-${name}`); mkdirSync(dir, { recursive: true });
  const doc = createDocument({ id: 'fixture', name: 'Prior snapshot' }); change(doc);
  const snapshot = join(dir, 'fixture.json'), journal = join(dir, 'fixture.history.jsonl');
  writeFileSync(snapshot, JSON.stringify(doc, null, 2)); if (log !== undefined) writeFileSync(journal, typeof log === 'function' ? log(doc) : log);
  return { dir, doc, snapshot, journal, before: readFileSync(snapshot), logBefore: existsSync(journal) ? readFileSync(journal) : undefined };
}
const rec = (doc, rev = 1, ops = [{ type: 'doc.set', props: { name: `Recovered ${rev}` } }], extra = {}) => ({ docId: doc.id, rev, ops, actor: 'test', inverse: [{ type: 'doc.set', props: { name: doc.name } }], at: doc.updatedAt, ...extra });
const line = record => JSON.stringify(record) + '\n';
const edit = doc => ({ docId: doc.id, actor: 'test', ops: [{ type: 'doc.set', props: { name: 'Next edit' } }] });
function preserved(f) { assert.deepEqual(readFileSync(f.snapshot), f.before, 'Prior snapshot bytes'); if (f.logBefore !== undefined) assert.deepEqual(readFileSync(f.journal), f.logBefore, 'Original journal bytes'); }
function refused(f, expectedRev = f.doc.rev) {
  const store = new DocStore(f.dir); assert.equal(store.persistence().ok, false, 'Recovery must report unhealthy');
  assert.equal(store.get(f.doc.id)?.rev, expectedRev); assert.throws(() => store.apply(edit(f.doc))); preserved(f);
  assert.equal(new DocStore(f.dir).persistence().ok, false, 'Disk reopen must remain unhealthy'); preserved(f);
  return store;
}
function hooked(patches, fn) {
  const old = Object.fromEntries(Object.keys(patches).map(k => [k, fs[k]]));
  try { Object.assign(fs, patches); syncBuiltinESMExports(); return fn(old); }
  finally { Object.assign(fs, old); syncBuiltinESMExports(); }
}
function backupEquals(dir, bytes) {
  const backups = readdirSync(dir).filter(p => p.includes('.recovery-') && p.endsWith('.bak'));
  assert.ok(backups.some(p => readFileSync(join(dir, p)).equals(bytes)), 'Exact original bytes retained in recovery backup');
  assert.ok(readdirSync(dir).some(p => p.includes('.recovery-') && p.endsWith('.diagnosis')), 'Retained diagnosis');
}
async function test(name, fn) {
  try { await fn(); report.cases.push({ name, status: 'pass' }); console.log('ok ' + name); }
  catch (error) { report.cases.push({ name, status: 'fail', message: error.message, stack: error.stack }); console.log('FAIL ' + name + ': ' + error.message); }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
}

await test('malformed snapshot remains visible as unhealthy and blocks library edits', () => {
  const f = fixture('malformed'); writeFileSync(f.snapshot, '{"id":'); f.before = readFileSync(f.snapshot);
  const store = new DocStore(f.dir); assert.equal(store.persistence().ok, false); assert.equal(store.get(f.doc.id), undefined);
  assert.throws(() => store.create({ id: f.doc.id })); assert.throws(() => store.put(f.doc)); preserved(f);
  assert.ok(JSON.stringify(store.persistence().errors).includes('fixture.json'));
});
for (const [name, modify] of [
  ['identity-mismatch', d => { d.id = 'another'; }], ['unsafe-id', d => { d.id = '../escape'; }],
  ['negative-revision', d => { d.rev = -1; }], ['fractional-revision', d => { d.rev = 0.5; }],
  ['missing-layers', d => { delete d.layers; }], ['wrong-assets', d => { d.assets = []; }],
  ['wrong-guides', d => { d.guides = [null]; }], ['invalid-layer', d => { d.layers = [{ id: 'broken', type: 'group', children: null }]; }],
  ['duplicate-layers', d => { d.layers = [makeShape({ id: 'a' }), makeShape({ id: 'a' })]; }],
  ['wrong-document-width', d => { d.width = '1080'; }], ['wrong-timestamp', d => { d.updatedAt = 3; }],
]) await test('invalid snapshot ' + name, () => {
  const f = fixture(name, modify), store = new DocStore(f.dir); assert.equal(store.persistence().ok, false); assert.equal(store.all().length, 0); preserved(f);
});
await test('orphan journal cannot become a healthy empty library', () => {
  const f = fixture('orphan', () => {}, d => line(rec(d))); fs.unlinkSync(f.snapshot);
  const store = new DocStore(f.dir); assert.equal(store.persistence().ok, false); assert.equal(store.all().length, 0); assert.throws(() => store.create()); assert.deepEqual(readFileSync(f.journal), f.logBefore);
});
await test('edited snapshot without its journal refuses conservatively', () => { const f = fixture('missing-history', d => { d.rev = 1; }); refused(f); });
await test('later healthy snapshot cannot hide an earlier recovery failure', () => {
  const f = fixture('sticky'); writeFileSync(join(f.dir, 'aaa.json'), '{'); const store = new DocStore(f.dir);
  assert.equal(store.persistence().ok, false); assert.equal(store.get(f.doc.id).rev, 0); assert.throws(() => store.apply(edit(f.doc)));
});
await test('complete malformed final journal line is never removed', () => { refused(fixture('committed-malformed', () => {}, '{"docId":\n')); });
await test('complete semantic invalid final journal line is never removed', () => { refused(fixture('committed-invalid', () => {}, d => line(rec(d, 1, [{ type: 'unknown' }])))); });
await test('syntactically complete invalid unterminated final line is corrupt', () => { refused(fixture('invalid-no-newline', () => {}, d => JSON.stringify(rec(d, 1, [{ type: 'unknown' }])))); });
for (const [name, revisions] of [['gap', [1, 3]], ['duplicate', [1, 1]], ['out-of-order', [2, 1]], ['negative', [-1]], ['zero', [0]]]) {
  await test('journal revisions reject ' + name, () => { refused(fixture(name, () => {}, d => revisions.map(r => line(rec(d, r))).join(''))); });
}
await test('duplicate already-snapshotted revisions refuse', () => { refused(fixture('old-duplicate', d => { d.rev = 2; }, d => line(rec(d, 1)) + line(rec(d, 1)) + line(rec(d, 2)))); });
await test('valid replay prefix is not published when a later record fails', () => { refused(fixture('later-invalid', () => {}, d => line(rec(d)) + line(rec(d, 2, [{ type: 'layer.remove', id: 'missing' }])))); });
await test('middle corruption plus partial tail leaves every original byte untouched', () => { refused(fixture('middle-invalid', () => {}, d => line(rec(d)) + '{bad}\n{"docId":')); });
for (const [name, ops] of [
  ['identity-change', [{ type: 'doc.set', props: { id: 'replaced', rev: 90 } }]],
  ['invalid-guides', [{ type: 'doc.set', props: { guides: [null] } }]],
  ['invalid-name', [{ type: 'doc.set', props: { name: 7 } }]],
  ['invalid-add', [{ type: 'layer.add', parentId: null, index: 0, layer: { id: 'x', type: 'group', children: 'bad' } }]],
  ['bad-index', [{ type: 'layer.move', id: 'missing', parentId: null, index: 'NaN' }]],
]) await test('semantic record rejects ' + name, () => { refused(fixture(name, () => {}, d => line(rec(d, 1, ops)))); });
await test('records already in snapshot still require valid operation shape', () => { refused(fixture('old-unknown-op', d => { d.rev = 1; }, d => line(rec(d, 1, [{ type: 'unknown' }])))); });
await test('valid committed edits replay and reopen', () => {
  const f = fixture('valid-replay', () => {}, d => line(rec(d)) + line(rec(d, 2))); const store = new DocStore(f.dir);
  assert.equal(store.persistence().ok, true); assert.equal(store.get(f.doc.id).name, 'Recovered 2'); assert.equal(new DocStore(f.dir).get(f.doc.id).rev, 2);
});
await test('valid already-snapshotted older history suffix survives and permits append', () => {
  const f = fixture('old-suffix', d => { d.rev = 9; }, d => [7, 8, 9].map(r => line(rec(d, r))).join(''));
  const store = new DocStore(f.dir); assert.equal(store.persistence().ok, true); assert.equal(store.get(f.doc.id).name, 'Prior snapshot');
  store.apply(edit(f.doc)); store.flush(); assert.equal(new DocStore(f.dir).get(f.doc.id).rev, 10);
});
await test('valid final complete line without newline gains a separator before next edit', () => {
  const f = fixture('complete-no-newline', () => {}, d => JSON.stringify(rec(d))); const store = new DocStore(f.dir);
  assert.equal(store.persistence().ok, true); store.apply(edit(f.doc)); store.flush();
  const reopened = new DocStore(f.dir); assert.equal(reopened.persistence().ok, true); assert.equal(reopened.get(f.doc.id).rev, 2); backupEquals(f.dir, f.logBefore);
});
await test('partial unterminated JSON tail preserves bytes and repairs before append', () => {
  const f = fixture('partial-tail', () => {}, d => line(rec(d)) + '{"docId":'); const store = new DocStore(f.dir);
  assert.equal(store.persistence().ok, true); assert.equal(store.get(f.doc.id).rev, 1); backupEquals(f.dir, f.logBefore);
  assert.equal(readFileSync(f.journal, 'utf8'), line(rec(f.doc))); store.apply(edit(f.doc)); store.flush();
  assert.equal(new DocStore(f.dir).get(f.doc.id).rev, 2);
});
await test('initial partial append preserves established empty-log recovery', () => {
  const f = fixture('initial-tail', () => {}, '{"docId":'); const store = new DocStore(f.dir); assert.equal(store.persistence().ok, true);
  backupEquals(f.dir, f.logBefore); assert.equal(readFileSync(f.journal).length, 0); store.apply(edit(f.doc)); store.flush(); assert.equal(new DocStore(f.dir).get(f.doc.id).rev, 1);
});
await test('unambiguously corrupt unterminated garbage is refused', () => { refused(fixture('garbage-tail', () => {}, 'not-json')); });
await test('failed recovery backup refuses without repairing or snapshotting', () => {
  const f = fixture('backup-fail', () => {}, '{"docId":'), original = fs.openSync, copy = fs.copyFileSync;
  hooked({ openSync(p, ...args) { if (String(p).includes('.recovery-')) throw new Error('injected backup failure'); return original(p, ...args); }, copyFileSync(a, b, ...args) { if (String(b).includes('.recovery-')) throw new Error('injected backup failure'); return copy(a, b, ...args); } }, () => {
    const store = new DocStore(f.dir); assert.equal(store.persistence().ok, false); assert.throws(() => store.apply(edit(f.doc))); preserved(f);
  });
});
await test('failed journal repair leaves prior snapshot and original journal unchanged', () => {
  const f = fixture('repair-fail', () => {}, d => line(rec(d)) + '{"docId":'), rename = fs.renameSync;
  hooked({ renameSync(a, b) { if (b === f.journal) throw new Error('injected repair failure'); return rename(a, b); } }, () => {
    const store = new DocStore(f.dir); assert.equal(store.persistence().ok, false); assert.equal(store.get(f.doc.id).rev, 0); preserved(f); backupEquals(f.dir, f.logBefore);
  });
});
await test('failed recovered snapshot publication refuses until disk reopen', () => {
  const f = fixture('snapshot-repair-fail', () => {}, d => line(rec(d))), rename = fs.renameSync;
  hooked({ renameSync(a, b) { if (b === f.snapshot) throw new Error('injected snapshot failure'); return rename(a, b); } }, () => {
    const store = new DocStore(f.dir); assert.equal(store.persistence().ok, false); assert.equal(store.get(f.doc.id).rev, 0); preserved(f); assert.throws(() => store.apply(edit(f.doc)));
  });
  assert.equal(new DocStore(f.dir).get(f.doc.id).rev, 1);
});
await test('durableAppend tolerates short real writes', () => {
  const f = fixture('short-writes'), write = fs.writeSync; const record = 'Short write ü\n';
  hooked({ writeSync(fd, bytes, offset, length, ...args) { return write(fd, bytes, offset, Math.min(length, 2), ...args); } }, () => durableAppend(f.journal, record));
  assert.equal(readFileSync(f.journal, 'utf8'), record);
});
await test('durableAppend refuses zero progress immediately', () => {
  const f = fixture('zero-progress'); let writes = 0;
  hooked({ writeSync() { if (++writes === 1) return 0; throw new Error('test prevented unbounded zero-progress loop'); } }, () => assert.throws(() => durableAppend(f.journal, 'record\n')));
  assert.equal(writes, 1, 'No second write after zero progress'); assert.equal(readFileSync(f.journal).length, 0);
});
for (const rollbackFails of [false, true]) await test('append write failure with ' + (rollbackFails ? 'failed' : 'successful') + ' rollback remains unhealthy', () => {
  const f = fixture('append-' + rollbackFails), store = new DocStore(f.dir); const write = fs.writeSync, truncate = fs.ftruncateSync;
  writeFileSync(f.journal, ''); let writes = 0, error, journalFd; const open = fs.openSync;
  hooked({ openSync(p, flags, ...args) { const fd = open(p, flags, ...args); if (p === f.journal && flags === 'a') journalFd = fd; else if (fd === journalFd) journalFd = undefined; return fd; }, writeSync(fd, bytes, offset, length, ...args) { if (fd !== journalFd) return write(fd, bytes, offset, length, ...args); if (++writes === 1) return write(fd, bytes, offset, Math.min(8, length), ...args); throw new Error('injected partial write failure'); }, ftruncateSync(fd, size) { if (rollbackFails) throw new Error('injected rollback truncate failure'); return truncate(fd, size); } }, () => {
    try { store.apply(edit(f.doc)); } catch (e) { error = e; }
  });
  (report.appendFaults ??= []).push({ rollbackFails, observed: String(error), rollbackSucceeded: error?.rollbackSucceeded });
  console.log('append fault observation: ' + String(error));
  assert.ok(error); assert.equal(store.persistence().ok, false); assert.equal(store.get(f.doc.id).rev, 0); assert.equal(store.historySince(f.doc.id, 0).length, 0); assert.throws(() => store.apply(edit(f.doc)));
  assert.equal(readFileSync(f.snapshot).equals(f.before), true); assert.ok(String(error).includes(rollbackFails ? 'rollback' : 'partial write'));
  if (rollbackFails) { assert.equal(readFileSync(f.journal).length, 8); backupEquals(f.dir, readFileSync(f.journal)); assert.equal(new DocStore(f.dir).persistence().ok, false, 'Unresolved rollback requires review on reopen'); }
  else { assert.equal(readFileSync(f.journal).length, 0); const reopened = new DocStore(f.dir); assert.equal(reopened.persistence().ok, true); reopened.apply(edit(f.doc)); reopened.flush(); assert.equal(new DocStore(f.dir).get(f.doc.id).rev, 1); }
});
await test('append fsync failure with unavailable backup sync is exposed without publishing', () => {
  const f = fixture('append-fsync-fail'), store = new DocStore(f.dir); let error;
  hooked({ fsyncSync() { throw new Error('injected sync failure'); } }, () => { try { store.apply(edit(f.doc)); } catch (e) { error = e; } });
  assert.ok(error); assert.equal(store.persistence().ok, false); assert.equal(store.get(f.doc.id).rev, 0); assert.ok(String(error).includes('rollback')); assert.throws(() => store.apply(edit(f.doc)));
});
await test('append descriptor stat failure closes the real descriptor', () => {
  const f = fixture('stat-fail'); let closed = 0, journalFd; const close = fs.closeSync, open = fs.openSync;
  hooked({ openSync(p, flags, ...args) { const fd = open(p, flags, ...args); if (p === f.journal && flags === 'a') journalFd = fd; return fd; }, fstatSync() { throw new Error('injected stat failure'); }, closeSync(fd) { if (fd === journalFd) { closed++; journalFd = undefined; } return close(fd); } }, () => assert.throws(() => durableAppend(f.journal, 'record\n')));
  assert.equal(closed, 1);
});
await test('supported layer/document schema and every operation family reopens', () => {
  const f = fixture('schema', d => {
    d.layers = [makeGroup({ id: 'g' }), makeShape({ id: 's' }), makeText({ id: 't', text: 'Text' }), makeBrush({ id: 'b' }), makeFill({ id: 'f' }), makeAdjustment({ id: 'j' }), makeImage({ id: 'i', assetId: 'a' })];
    d.assets.a = { id: 'a', name: 'image', src: '/assets/a.png', width: 10, height: 10, mime: 'image/png' };
    d.comps = [{ id: 'c', name: 'Comp', states: { t: { text: 'Alternative', opacity: 0 } } }]; d.selections = [{ id: 'sel', name: 'Selection', rings: [[0, 0, 2, 0, 2, 2]] }]; d.animation = { fps: 24, duration: 1000, tracks: { t: [{ t: 0, x: 0 }, { t: 1000, x: 5 }] } }; d.linearBlending = true;
  });
  const store = new DocStore(f.dir); assert.equal(store.persistence().ok, true);
  for (const ops of [[{ type: 'layer.move', id: 's', parentId: 'g', index: 0 }], [{ type: 'layer.set', id: 't', props: { text: 'New' } }], [{ type: 'layer.push', id: 'b', key: 'strokes', items: [{ points: [0, 0, 1, 1], size: 2, color: '#fff', opacity: 1, hardness: 1 }] }], [{ type: 'layer.splice', id: 'b', key: 'strokes', index: 0, count: 1 }], [{ type: 'layer.add', layer: makeShape({ id: 'new' }), parentId: null, index: -1 }], [{ type: 'layer.remove', id: 'new' }], [{ type: 'asset.add', asset: { id: 'extra', name: 'other', src: '/assets/other.png', width: 10, height: 10, mime: 'image/png' } }], [{ type: 'asset.remove', id: 'extra' }], [{ type: 'doc.set', props: { background: null, comps: null, animation: null } }]]) store.apply({ docId: f.doc.id, actor: 'test', ops });
  const reopened = new DocStore(f.dir); assert.equal(reopened.persistence().ok, true); assert.equal(reopened.get(f.doc.id).rev, 9); store.flush();
});

await test('minimal live layer.add preserves generated defaults and identity on reopen', () => {
  const f = fixture('live-defaults'), store = new DocStore(f.dir);
  const applied = store.apply({ docId: f.doc.id, actor: 'test', ops: [{ type: 'layer.add', layer: { type: 'shape' }, parentId: null, index: -1 }] });
  const id = store.get(f.doc.id).layers[0].id; assert.equal(applied.ops[0].layer.id, id);
  assert.equal(new DocStore(f.dir).get(f.doc.id).layers[0].id, id); store.flush();
});
await test('legacy layer.add may omit deterministic defaults but keeps its supplied identity', () => {
  const f = fixture('legacy-defaults', () => {}, d => line(rec(d, 1, [{ type: 'layer.add', layer: { id: 'legacy', type: 'shape' }, parentId: null, index: 0 }], { inverse: [{ type: 'layer.remove', id: 'legacy' }] })));
  const store = new DocStore(f.dir); assert.equal(store.persistence().ok, true); assert.equal(store.get(f.doc.id).layers[0].id, 'legacy');
});
await test('old layer.set still rejects poisoned required properties', () => {
  refused(fixture('old-poisoned-props', d => { d.rev = 1; d.layers = [makeShape({ id: 's' })]; }, d => line(rec(d, 1, [{ type: 'layer.set', id: 's', props: { width: 'bad' } }]))));
});
await test('partial tails inside strings, escapes, numbers, literals and UTF-8 recover', () => {
  for (const [i, tail] of ['{"x":"unfinished', '{"x":"a\\u00', '{"x":1e+', '{"x":tru', '{"x":[1,', Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xe2, 0x82])])].entries()) {
    const f = fixture('partial-prefix-' + i, () => {}, tail), store = new DocStore(f.dir); assert.equal(store.persistence().ok, true); backupEquals(f.dir, f.logBefore);
    assert.equal(readFileSync(f.journal).length, 0); assert.equal(new DocStore(f.dir).persistence().ok, true);
  }
});
await test('invalid UTF-8 in complete records refuses with exact bytes retained', () => {
  const f = fixture('utf8-corrupt', () => {}, d => Buffer.concat([Buffer.from(line(rec(d)).slice(0, -2)), Buffer.from([0xff]), Buffer.from('}\n')])); refused(f);
});
await test('bounded recovery refuses oversized files before allocating their body', () => {
  for (const kind of ['snapshot', 'journal']) {
    const f = fixture('oversize-' + kind, () => {}, ''), file = kind === 'snapshot' ? f.snapshot : f.journal;
    const size = 64 * 1024 * 1024 + 1; fs.truncateSync(file, size); const read = fs.readSync; let bodyRead = 0, fileFd;
    const open = fs.openSync;
    hooked({ openSync(p, ...args) { const fd = open(p, ...args); if (p === file) fileFd = fd; return fd; }, readSync(fd, ...args) { if (fd === fileFd) bodyRead++; return read(fd, ...args); } }, () => {
      const store = new DocStore(f.dir); assert.equal(store.persistence().ok, false); assert.match(JSON.stringify(store.persistence().errors), /byte limit/); assert.equal(bodyRead, 0);
    });
    assert.equal(fs.statSync(file).size, size);
  }
});
await test('zero-progress reads refuse without spinning or publishing', () => {
  const f = fixture('read-zero'); let reads = 0;
  hooked({ readSync() { reads++; return 0; } }, () => { const store = new DocStore(f.dir); assert.equal(store.persistence().ok, false); assert.equal(store.all().length, 0); });
  assert.equal(reads, 1); preserved(f);
});
await test('history rotation only follows complete replay and preserves original bytes', () => {
  const f = fixture('rotation', () => {}, d => Array.from({ length: 2002 }, (_, i) => line(rec(d, i + 1))).join(''));
  const store = new DocStore(f.dir); assert.equal(store.persistence().ok, true); assert.equal(store.get(f.doc.id).rev, 2002);
  backupEquals(f.dir, f.logBefore); assert.equal(readFileSync(f.journal, 'utf8').trim().split('\n').length, 1500); assert.equal(store.historySince(f.doc.id, 0).length, 500);
  assert.equal(new DocStore(f.dir).get(f.doc.id).rev, 2002);
});
await test('failed initial snapshot write remains unhealthy and refuses new edits', () => {
  const f = fixture('create-write-fail'), store = new DocStore(f.dir), rename = fs.renameSync;
  hooked({ renameSync(a, b) { if (String(b).endsWith('new.json')) throw new Error('injected create write failure'); return rename(a, b); } }, () => assert.throws(() => store.create({ id: 'new' })));
  assert.equal(store.persistence().ok, false); assert.equal(store.get('new'), undefined); assert.throws(() => store.apply(edit(f.doc))); preserved(f);
});
await test('unresolved append sync failure refuses even if journal JSON is complete on reopen', () => {
  const f = fixture('reopen-sync-fail'), store = new DocStore(f.dir);
  hooked({ fsyncSync() { throw new Error('injected persistent sync failure'); } }, () => assert.throws(() => store.apply(edit(f.doc))));
  assert.equal(new DocStore(f.dir).persistence().ok, false); assert.equal(new DocStore(f.dir).get(f.doc.id).rev, 0); assert.deepEqual(readFileSync(f.snapshot), f.before);
});
await test('failed append backup creation persists a reopen refusal when marker writes remain available', () => {
  const f = fixture('append-backup-unavailable'), store = new DocStore(f.dir); const open = fs.openSync, write = fs.writeSync; let fd, writes = 0;
  hooked({ openSync(p, flags, ...args) { const result = open(p, flags, ...args); if (p === f.journal && flags === 'a') fd = result; else if (result === fd) fd = undefined; return result; }, writeSync(target, bytes, offset, length, ...args) { if (target !== fd) return write(target, bytes, offset, length, ...args); if (++writes === 1) return write(target, bytes, offset, Math.min(length, 8), ...args); throw new Error('injected write failure'); }, copyFileSync() { throw new Error('injected copy failure'); } }, () => assert.throws(() => store.apply(edit(f.doc))));
  assert.equal(store.persistence().ok, false); assert.equal(readFileSync(f.journal).length, 8); assert.ok(existsSync(f.journal + '.recovery-error'));
  const reopened = new DocStore(f.dir); assert.equal(reopened.persistence().ok, false); assert.equal(reopened.get(f.doc.id).rev, 0); assert.equal(readFileSync(f.journal).length, 8); assert.deepEqual(readFileSync(f.snapshot), f.before);
});
await test('live metadata invalid for recovery is refused before disk mutation', () => {
  const f = fixture('live-metadata'), store = new DocStore(f.dir); assert.throws(() => store.apply({ ...edit(f.doc), actor: 3 })); assert.throws(() => store.apply({ ...edit(f.doc), label: {} }));
  assert.equal(store.persistence().ok, true); assert.equal(store.get(f.doc.id).rev, 0); assert.equal(existsSync(f.journal), false); preserved(f);
});
await test('rollback sync failure retains uncertainty even after real truncation', () => {
  const f = fixture('rollback-sync'), store = new DocStore(f.dir), open = fs.openSync, sync = fs.fsyncSync; let appendFd, repairFd, error;
  hooked({ openSync(p, flags, ...args) { const fd = open(p, flags, ...args); if (p === f.journal) { if (flags === 'a') appendFd = fd; if (flags === 'r+') repairFd = fd; } return fd; }, fsyncSync(fd) { if (fd === appendFd) throw new Error('injected append sync failure'); if (fd === repairFd) throw new Error('injected rollback sync failure'); return sync(fd); } }, () => { try { store.apply(edit(f.doc)); } catch (e) { error = e; } });
  assert.ok(String(error).includes('rollback sync')); assert.equal(error.rollbackSucceeded, false); assert.equal(store.persistence().ok, false); assert.equal(readFileSync(f.journal).length, 0); assert.deepEqual(readFileSync(f.snapshot), f.before);
  assert.equal(new DocStore(f.dir).persistence().ok, false); assert.equal(store.get(f.doc.id).rev, 0);
});
await test('journal close uncertainty refuses publication and disk reopen', () => {
  const f = fixture('close-fail'), store = new DocStore(f.dir), open = fs.openSync, close = fs.closeSync; let journalFd;
  hooked({ openSync(p, flags, ...args) { const fd = open(p, flags, ...args); if (p === f.journal && flags === 'a') journalFd = fd; return fd; }, closeSync(fd) { close(fd); if (fd === journalFd) { journalFd = undefined; throw new Error('injected close uncertainty after actual close'); } } }, () => assert.throws(() => store.apply(edit(f.doc))));
  assert.equal(store.persistence().ok, false); assert.equal(store.get(f.doc.id).rev, 0); assert.equal(store.historySince(f.doc.id, 0).length, 0); assert.deepEqual(readFileSync(f.snapshot), f.before);
  assert.equal(new DocStore(f.dir).persistence().ok, false); assert.ok(existsSync(f.journal + '.recovery-error'));
});

report.passed = report.cases.filter(c => c.status === 'pass').length; report.failed = report.cases.length - report.passed;
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(`${report.passed} passed, ${report.failed} failed; retained evidence: ${root}`);
process.exitCode = report.failed ? 1 : 0;
