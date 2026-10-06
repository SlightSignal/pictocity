import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { productionDownload as helper, productionHelperPath } from './export-download-production.mjs';
const { createExportZip, planExportZip, exportFilename, exportArchiveName, prepareExportSetDownload, validateExportEnvelope, exportMemberSha256, readExportResponse, readExportJson, exportResponseError, EXPORT_DOWNLOAD_LIMITS: limits } = helper;
const root = resolve('tools/export-download-evidence', new Date().toISOString().replace(/[:.]/g, '-') + '-helper'), temp = join(root, 'temp');
mkdirSync(temp, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { scope: 'actual production helper and independent Python zipfile extraction; no DOM/native acceptance', sourceSha256: hash(readFileSync(productionHelperPath)), limits, cases: [], archives: [] };
const save = () => writeFileSync(join(root, 'helper-report.json'), JSON.stringify(report, null, 2));
const test = async (name, action) => { if (process.env.PICTOCITY_DOWNLOAD_CASE && !name.includes(process.env.PICTOCITY_DOWNLOAD_CASE)) return; try { await action(); report.cases.push({ name, status: 'pass' }); console.log('ok ' + name); } catch (e) { report.cases.push({ name, status: 'fail', error: String(e), stack: e.stack }); throw e; } finally { save(); } };
await test('SHA-256 padding, boundary, multichunk, Unicode and binary vectors match independent Node crypto', async () => {
  const vectors = [Buffer.alloc(0), Buffer.from('abc'), Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), Buffer.from('陶器 café 😀 e\u0301\0\r\n'), ...[55, 56, 63, 64, 65, 127, 128, 129, limits.crcChunkBytes - 1, limits.crcChunkBytes, limits.crcChunkBytes + 1, limits.crcChunkBytes * 3 + 65].map(n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 71 + 255) & 255))), Buffer.alloc(1_000_000, 0x61)];
  assert.equal(hash(vectors[0]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hash(vectors[1]), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const original = globalThis.crypto; Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    report.digests = [];
    for (const bytes of vectors) { const digest = await exportMemberSha256(bytes); assert.equal(digest, hash(bytes)); report.digests.push({ bytes: bytes.length, sha256: digest }); }
    const padded = Buffer.concat([Buffer.from([98, 99]), vectors[3], Buffer.from([100])]);
    assert.equal(await exportMemberSha256(padded.subarray(2, padded.length - 1)), hash(vectors[3]));
  } finally { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original }); }
});
await test('streamed response enforces declared and actual bounds before convenience readers or concatenation', async () => {
  assert.equal(typeof readExportResponse, 'function', 'Production response reader is required');
  for (const declared of [undefined, '7']) {
    let cancelled = 0;
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.from([0, 255])); c.enqueue(Uint8Array.from([3, 4, 5, 6, 7])); c.close(); }, cancel() { cancelled++; } }), { headers: declared ? { 'content-length': declared } : {} });
    response.arrayBuffer = response.blob = response.json = () => { throw new Error('Unbounded convenience reader used'); };
    assert.deepEqual(new Uint8Array(await readExportResponse(response, 7)), Uint8Array.from([0, 255, 3, 4, 5, 6, 7])); assert.equal(response.body.locked, false); assert.equal(cancelled, 0);
  }
  for (const declared of ['8', '-1', '1.5', 'abc', '1, 2', '9007199254740992']) {
    let cancelled = 0, pulls = 0;
    const response = new Response(new ReadableStream({ pull() { pulls++; }, cancel() { cancelled++; } }, { highWaterMark: 0 }), { headers: { 'content-length': declared } });
    await assert.rejects(readExportResponse(response, 7)); assert.equal(cancelled, 1); assert.equal(pulls, 0); assert.equal(response.body.locked, false);
  }
  for (const declared of [undefined, '2']) {
    let cancelled = 0, pulls = 0;
    const response = new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(4)); }, cancel() { cancelled++; } }, { highWaterMark: 0 }), { headers: declared ? { 'content-length': declared } : {} });
    await assert.rejects(readExportResponse(response, 3), /length|limit|size/i); assert.equal(cancelled, 1); assert.equal(pulls, 1); assert.equal(response.body.locked, false);
  }
  const truncated = new Response(Uint8Array.of(1), { headers: { 'content-length': '2' } });
  await assert.rejects(readExportResponse(truncated, 3), /length|truncat/i); assert.equal(truncated.body.locked, false);
});
await test('portable names refuse Windows device aliases and macOS UTF-8 or decomposed byte overruns', async () => {
  for (const name of ['CONIN$.png', 'CONOUT$.txt', 'CLOCK$', 'CON .png', 'LPT0.txt', '陶'.repeat(180), 'é'.repeat(90), 'x\u200d.png', 'x\ufe0f.png']) assert.throws(() => exportFilename(name), undefined, JSON.stringify(name));
  exportFilename('陶'.repeat(80)); exportFilename('é'.repeat(80));
  exportFilename(exportArchiveName('𐐀'.repeat(100)));
});
await test('stream cancellation, source errors and wrong MIME/encoding cancel and release the reader', async () => {
  for (const preAborted of [true, false]) {
    const controller = new AbortController(); let cancelled = 0, source;
    const response = new Response(new ReadableStream({ start(c) { source = c; }, cancel() { cancelled++; } }, { highWaterMark: 0 }));
    if (preAborted) controller.abort();
    const pending = readExportResponse(response, limits.envelopeBytes, controller.signal);
    if (!preAborted) { await new Promise(r => setTimeout(r, 0)); controller.abort(); }
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
    assert.throws(() => source.enqueue(Uint8Array.of(9)), /closed|state/i);
  }
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/vnd.pictocity.export-set', 'content-encoding': 'gzip' }]) {
    let cancelled = 0;
    const response = new Response(new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 }), { headers });
    await assert.rejects(readExportResponse(response, 8, undefined, 'application/vnd.pictocity.export-set'), /type|Encoded/); assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
  }
  const errored = new Response(new ReadableStream({ pull(c) { c.error(new Error('Owned stream failure')); } }, { highWaterMark: 0 }));
  await assert.rejects(readExportResponse(errored, 8), /Owned stream failure/); assert.equal(errored.body.locked, false);
  // Exercise the slab boundary and many small chunks without retaining an unbounded chunk list.
  const bytes = Buffer.alloc(limits.crcChunkBytes * 2 + 65); for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
  let offset = 0;
  const chunked = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) { c.close(); return; } const end = Math.min(bytes.length, offset + 17003); c.enqueue(bytes.subarray(offset, end)); offset = end; } }, { highWaterMark: 0 }));
  assert.deepEqual(Buffer.from(await readExportResponse(chunked, bytes.length)), bytes); assert.equal(chunked.body.locked, false);
  const zero = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(0)); } }, { highWaterMark: 0 })), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(readExportResponse(zero, 8, controller.signal), { name: 'AbortError' }); assert.equal(zero.body.locked, false); } finally { clearTimeout(timer); }
});
await test('JSON success and errors use a bounded streamed body and preserve cancellation', async () => {
  assert.deepEqual(await readExportJson(new Response('{"files":[]}')), { files: [] });
  assert.equal(await exportResponseError(new Response('{"error":"Owned export error"}'), 'fallback'), 'Owned export error');
  assert.equal(await exportResponseError(new Response('not JSON'), 'fallback'), 'fallback');
  let cancelled = 0;
  const huge = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(limits.jsonBytes + 1)); }, cancel() { cancelled++; } }, { highWaterMark: 0 }));
  assert.equal(await exportResponseError(huge, 'fallback'), 'fallback'); assert.equal(cancelled, 1); assert.equal(huge.body.locked, false);
  const controller = new AbortController(); controller.abort(); const response = new Response('{}');
  await assert.rejects(exportResponseError(response, 'fallback', controller.signal), { name: 'AbortError' }); assert.equal(response.body.locked, false);
});
const png = color => { const canvas = createCanvas(16, 8), ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 16, 8); return canvas.toBuffer('image/png'); };
const realPngs = [{ name: '赤い陶器.png', bytes: png('red'), mime: 'image/png' }, { name: 'Café @2x.png', bytes: png('blue'), mime: 'image/png' }];
const formats = [...realPngs, { name: 'banner.html', mime: 'text/html', bytes: Buffer.from('<!doctype html><p>陶器 café</p>') }, { name: 'vector.svg', mime: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>') }, { name: 'portable.pictocity', mime: 'application/json', bytes: Buffer.from('{"name":"捕获"}') }, { name: 'spot.webm', mime: 'video/webm', bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 255, 13, 10]) }];
const expected = files => ({ files: files.length, revision: 7, resources: 'a'.repeat(64), documentName: '陶器 Café' });
const envelope = (files, mutate = manifest => manifest) => {
  const manifest = mutate({ version: 1, resourceSnapshot: { revision: 7, sha256: 'a'.repeat(64) }, files: files.map(f => ({ name: f.name, mime: f.mime, bytes: f.bytes.length, sha256: hash(f.bytes) })) });
  const json = Buffer.from(JSON.stringify(manifest)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(json.length);
  const bytes = Buffer.concat([prefix, json, ...files.map(f => f.bytes)]); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
};
async function extract(blob, files, label) {
  const archive = join(root, label + '.zip'); writeFileSync(archive, Buffer.from(await blob.arrayBuffer()));
  const entries = files.map((f, i) => { const path = join(root, label + '-original-' + i); writeFileSync(path, f.bytes); return { name: f.name, path }; });
  const manifest = join(root, label + '-expected.json'); writeFileSync(manifest, JSON.stringify({ archive, files: entries }));
  const log = join(root, label + '-python.log'), fd = openSync(log, 'w');
  // File descriptors avoid launcher pipes; extraction remains a real Python process.
  try { execFileSync(process.env.PICTOCITY_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [resolve('tools/export-download-verify.py'), manifest], { windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, TEMP: temp, TMP: temp } }); }
  finally { closeSync(fd); }
  const output = readFileSync(log, 'utf8');
  report.archives.push(JSON.parse(output)); console.log(output.trim());
}
await test('real PNGs and mixed-format UTF-8 members independently extract to exact bytes and CRCs', async () => {
  await extract((await createExportZip(realPngs)).blob, realPngs, 'real-pngs');
  const prepared = await prepareExportSetDownload(envelope(formats), expected(formats));
  assert.equal(prepared.archived, true); assert.equal(prepared.save.name, '陶器 Café-exports.zip'); assert.equal(prepared.save.blob.type, 'application/zip');
  await extract(prepared.save.blob, formats, 'formats');
  for (const [i, f] of prepared.members.entries()) { assert.equal(f.name, formats[i].name); assert.equal(f.blob.type, formats[i].mime); assert.deepEqual(Buffer.from(await f.blob.arrayBuffer()), formats[i].bytes); }
});
await test('single-member set preserves its actual filename, MIME and bytes without ZIP wrapping', async () => {
  const prepared = await prepareExportSetDownload(envelope(realPngs.slice(0, 1)), expected(realPngs.slice(0, 1)));
  assert.equal(prepared.archived, false); assert.equal(prepared.save.name, realPngs[0].name); assert.equal(prepared.save.blob.type, 'image/png');
  assert.deepEqual(Buffer.from(await prepared.save.blob.arrayBuffer()), realPngs[0].bytes);
});
await test('the full 64-member ZIP and nonzero-offset byte views independently extract', async () => {
  const source = Buffer.from([200, 201, 0, 255, 123, 202]), files = Array.from({ length: 64 }, (_, i) => ({ name: `Member-${i}-陶.png`, bytes: source.subarray(2, 5) }));
  await extract((await createExportZip(files)).blob, files, '64-members');
});
await test('archive order, headers, dates and bytes are deterministic for identical captured members', async () => {
  const first = await createExportZip(formats), second = await createExportZip(formats);
  assert.deepEqual(Buffer.from(await first.blob.arrayBuffer()), Buffer.from(await second.blob.arrayBuffer()));
  assert.deepEqual(first.entries.map(e => e.name), formats.map(f => f.name));
});
await test('zero, invalid, unsafe, malformed Unicode, reserved and case/normalization-colliding names refuse', async () => {
  assert.throws(() => planExportZip([]), /1–64/);
  for (const name of ['', '.', '..', '../x.png', 'folder/x.png', 'folder\\x.png', '/x', 'C:x', 'x\0.png', 'x\n.png', 'x\u007f.png', 'x\u202e.png', 'x.', 'x ', 'CON.png', 'aux', 'Lpt9.pdf', 'COM¹.png', 'name?.png', '\ud800.png', 'a'.repeat(181), '／x.png']) assert.throws(() => exportFilename(name), undefined, JSON.stringify(name));
  for (const names of [['a.png', 'A.PNG'], ['é.png', 'e\u0301.png'], ['Ｋ.png', 'K.png'], ['ß.png', 'SS.png']]) assert.throws(() => planExportZip(names.map(name => ({ name, bytes: 1 }))), /collide/);
  assert.equal(exportFilename('a'.repeat(180)).length, 180); assert.equal(exportFilename('陶'.repeat(80)).length, 240); // portable NFD/UTF-8 budget supersedes draft's 540 bytes
  for (const doc of ['CON', '..', '', 'a'.repeat(1000), 'C:/bad?\0']) exportFilename(exportArchiveName(doc));
});
await test('payload, entry and all ZIP64 sentinel/offset limits are checked without allocating output', async () => {
  assert.throws(() => planExportZip(Array.from({ length: 65 }, (_, i) => ({ name: `${i}.png`, bytes: 1 }))), /1–64/);
  assert.equal(planExportZip(Array.from({ length: 64 }, (_, i) => ({ name: `${i}.png`, bytes: 1 }))).entries.length, 64);
  for (const bytes of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => planExportZip([{ name: 'one', bytes }]), /size/);
  assert.equal(planExportZip([{ name: 'one', bytes: limits.envelopeBytes }]).size, limits.envelopeBytes + 104);
  assert.throws(() => planExportZip([{ name: 'one', bytes: limits.envelopeBytes + 1 }]), /128 MiB/);
  for (const bytes of [0xffffffff, 0x100000000]) assert.throws(() => planExportZip([{ name: 'one', bytes }]), /ZIP64/);
  assert.throws(() => planExportZip([{ name: 'one', bytes: 0xffffff00 }, { name: 'two', bytes: 1024 }]), /ZIP64/);
  assert.throws(() => planExportZip([{ name: 'one', bytes: 0xffffffff - 100 }]), /ZIP64/);
  await assert.rejects(createExportZip([{ name: 'bad', bytes: new Uint8Array(new SharedArrayBuffer(1)) }]), /Invalid/);
});
await test('CRC work yields and cancellation retires before an archive result can be returned', async () => {
  const controller = new AbortController(), data = new Uint8Array(limits.crcChunkBytes * 3); let bytesDone = 0, yielded = false;
  const timer = setTimeout(() => { yielded = true; controller.abort(); }, 0);
  try { await assert.rejects(createExportZip([{ name: 'large.png', bytes: data }], controller.signal, n => { bytesDone += n; }), { name: 'AbortError' }); } finally { clearTimeout(timer); }
  assert.ok(yielded); assert.equal(bytesDone, limits.crcChunkBytes);
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(createExportZip(realPngs, aborted.signal), { name: 'AbortError' });
  const chunks = []; const complete = await createExportZip([{ name: 'three', bytes: data }], undefined, n => chunks.push(n)); assert.deepEqual(chunks, [limits.crcChunkBytes, limits.crcChunkBytes, limits.crcChunkBytes]); assert.equal(complete.blob.size, data.length + 108);
});
await test('full manifest and every member hash reject corruption, truncation, trailing bytes and mismatched capture', async () => {
  const good = envelope(realPngs), corrupt = good.slice(0); new Uint8Array(corrupt)[corrupt.byteLength - 1] ^= 1;
  for (const data of [good.slice(0, good.byteLength - 1), corrupt, new Uint8Array([...new Uint8Array(good), 0]).buffer]) await assert.rejects(validateExportEnvelope(data, expected(realPngs)));
  for (const mutate of [m => ({ ...m, version: 2 }), m => ({ ...m, resourceSnapshot: { ...m.resourceSnapshot, revision: 8 } }), m => ({ ...m, resourceSnapshot: { ...m.resourceSnapshot, sha256: 'b'.repeat(64) } }), m => ({ ...m, files: m.files.slice(0, 1) }), m => ({ ...m, files: m.files.map(f => ({ ...f, sha256: undefined })) }), m => ({ ...m, files: m.files.map(f => ({ ...f, bytes: 0 })) }), m => ({ ...m, files: [...m.files.slice(0, 1), { ...m.files[1], name: m.files[0].name }] })]) await assert.rejects(prepareExportSetDownload(envelope(realPngs, mutate), expected(realPngs)));
  const tooLong = new ArrayBuffer(limits.envelopeBytes + 1); await assert.rejects(validateExportEnvelope(tooLong, expected(realPngs)), /size/);
  const invalidUtf8 = good.slice(0); new Uint8Array(invalidUtf8)[4] = 0xff; await assert.rejects(validateExportEnvelope(invalidUtf8, expected(realPngs)));
  const manifest = new ArrayBuffer(4); new DataView(manifest).setUint32(0, limits.manifestBytes + 1); await assert.rejects(validateExportEnvelope(manifest, expected(realPngs)), /manifest/);
  for (const mutate of [m => ({ ...m, resourceSnapshot: null }), m => ({ ...m, files: null }), m => ({ ...m, files: [null, m.files[1]] }), m => ({ ...m, files: m.files.map(f => ({ ...f, mime: 'image/png\n' })) }), m => ({ ...m, files: m.files.map(f => ({ ...f, bytes: 1.5 })) }), m => ({ ...m, files: m.files.map(f => ({ ...f, bytes: Number.MAX_SAFE_INTEGER })) })]) await assert.rejects(prepareExportSetDownload(envelope(realPngs, mutate), expected(realPngs)));
  for (const patch of [{ files: 0 }, { files: 65 }, { revision: -1 }, { revision: 0.5 }, { resources: 'bad' }, { documentName: null }]) await assert.rejects(validateExportEnvelope(good, { ...expected(realPngs), ...patch }), /reviewed/);
});
await test('abort settles real chunked SHA-256 and preparation without a secure-origin crypto dependency', async () => {
  const controller = new AbortController(); let completed = false, yielded = false;
  const timer = setTimeout(() => { yielded = true; controller.abort(); }, 0);
  try {
    const pending = exportMemberSha256(new Uint8Array(limits.crcChunkBytes * 3), controller.signal).then(() => { completed = true; });
    await assert.rejects(pending, { name: 'AbortError' }); assert.ok(yielded); assert.equal(completed, false);
  } finally { clearTimeout(timer); }
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(exportMemberSha256(new Uint8Array(0), cancelled.signal), { name: 'AbortError' });
  await assert.rejects(prepareExportSetDownload(envelope(realPngs), expected(realPngs), cancelled.signal), { name: 'AbortError' });
  const original = globalThis.Blob; let allocations = 0;
  globalThis.Blob = class extends original { constructor(...args) { allocations++; super(...args); } };
  try { const corrupt = envelope(realPngs); new Uint8Array(corrupt)[corrupt.byteLength - 1] ^= 1; await assert.rejects(prepareExportSetDownload(corrupt, expected(realPngs)), /manifest/); assert.equal(allocations, 0, 'All advertised SHA-256 values must pass before ZIP/member output allocation'); }
  finally { globalThis.Blob = original; }
});
console.log(report.cases.length + ' production ZIP helper checks passed. Evidence: ' + root);
