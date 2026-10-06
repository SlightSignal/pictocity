import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { deflateSync, brotliCompressSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { GlobalFonts } from '@napi-rs/canvas';
import ts from 'typescript';
import { installFontFixture } from './font-identity-frontend-fixture.mjs';

const baseline = process.argv.includes('--baseline');
const root = resolve(process.env.PICTOCITY_FONT_EVIDENCE ?? 'tools/font-identity-evidence/' + new Date().toISOString().replace(/[:.]/g, '-'));
if (existsSync(join(root, 'report.json'))) throw new Error('Choose fresh evidence directory');
mkdirSync(join(root, 'fonts'), { recursive: true });
const editor = pathToFileURL(resolve('packages/editor/src/')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@pictocity/core') return { url: pathToFileURL(resolve('packages/core/dist/index.js')).href, shortCircuit: true };
    if (context.parentURL?.startsWith(editor) && specifier.startsWith('.')) {
      const url = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const oldServer = baseline && url === pathToFileURL(resolve('packages/server/dist/node-env.js')).href;
    if (oldServer || (url.startsWith(editor) && url.endsWith('.ts'))) {
      const source = oldServer ? 'tools/font-identity-evidence/before/node-env.ts' : baseline && url.endsWith('/env.ts') ? 'tools/font-identity-evidence/before/env.ts' : fileURLToPath(url);
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    }
    return next(url, context);
  },
});
const nativeFetch = globalThis.fetch;
const fixture = installFontFixture();
const env = await import('../packages/editor/src/env.ts');
const production = await import('../packages/server/dist/node-env.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { scope: 'Production native registration and editor source with deterministic FontFace fixture; no native/browser acceptance', root, cases: [], observations: {}, files: [] };
report.sourceVersion = baseline ? 'Frozen pre-edit production source' : 'Candidate production source/build';
report.sourceHashes = Object.fromEntries((baseline ? ['tools/font-identity-evidence/before/node-env.ts', 'tools/font-identity-evidence/before/env.ts'] : ['packages/server/src/node-env.ts', 'packages/server/src/font-metadata.ts', 'packages/server/src/index.ts', 'packages/editor/src/env.ts']).map(file => [file, hash(readFileSync(file))]));
const test = async (name, run) => {
  try { await run(); report.cases.push({ name, status: 'pass' }); console.log('ok ' + name); }
  catch (error) { const status = /EPERM|cannot-run/i.test(error.message) ? 'cannot-run' : 'fail'; report.cases.push({ name, status, error: error.stack }); console.log(status.toUpperCase() + ' ' + name + ': ' + error.message); }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
};
const fonts = join(root, 'fonts');
for (const [name, source] of [['a-original.ttf', 'Regular'], ['Unrelated-Semibold.ttf', 'Regular'], ['Thin-Normal.ttf', 'Bold'], ['Black-Upright.ttf', 'Italic']]) {
  copyFileSync(resolve('fonts/Poppins-' + source + '.ttf'), join(fonts, name));
  report.files.push({ file: name, sha256: hash(readFileSync(join(fonts, name))) });
}
await test('already registered renamed regular bytes keep Poppins identity', () => {
  production.registerFontFile(fonts, 'a-original.ttf');
  const actual = production.registerFontFile(fonts, 'Unrelated-Semibold.ttf'); report.observations.renamedFamily = actual;
  assert.equal(actual, 'Poppins');
});
await test('browser uses embedded regular weight instead of misleading Semibold filename', async () => {
  fixture.list = [{ family: 'Poppins', files: ['Unrelated-Semibold.ttf'], faces: [{ file: 'Unrelated-Semibold.ttf', weight: 400, style: 'normal', stretch: 'normal' }] }];
  await env.loadFonts(); report.observations.frontendDescriptors = fixture.faces.map(f => f.descriptors);
  assert.equal(fixture.faces.at(-1).descriptors.weight, '400');
});
if (!baseline) {
  const metadata = await import('../packages/server/dist/font-metadata.js');
  const core = await import('../packages/core/dist/index.js');
  const regular = readFileSync(resolve('fonts/Poppins-Regular.ttf'));
  const directory = bytes => Array.from({ length: bytes.readUInt16BE(4) }, (_, i) => {
    const p = 12 + i * 16;
    return { tag: bytes.toString('latin1', p, p + 4), p, offset: bytes.readUInt32BE(p + 8), length: bytes.readUInt32BE(p + 12) };
  });
  const table = (bytes, tag) => directory(bytes).find(t => t.tag === tag);
  const mutate = (fn, bytes = regular) => { const result = Buffer.from(bytes); fn(result); return result; };
  const withTable = (tag, bytes, original = regular) => {
    const entry = table(original, tag), offset = Math.ceil(original.length / 4) * 4;
    const result = Buffer.concat([original, Buffer.alloc(offset - original.length), bytes]);
    result.writeUInt32BE(offset, entry.p + 8); result.writeUInt32BE(bytes.length, entry.p + 12); return result;
  };
  const nameTable = records => {
    const encoded = records.map(r => r.platform === 1 ? Buffer.from(r.name, 'latin1') : Buffer.from(r.name, 'utf16le').swap16());
    const start = 6 + records.length * 12, result = Buffer.alloc(start + encoded.reduce((n, b) => n + b.length, 0));
    result.writeUInt16BE(records.length, 2); result.writeUInt16BE(start, 4); let offset = 0;
    records.forEach((r, i) => {
      const p = 6 + i * 12;
      [r.platform ?? 3, r.encoding ?? 1, r.language ?? 0x409, r.id ?? 1, encoded[i].length, offset].forEach((v, j) => result.writeUInt16BE(v, p + j * 2));
      encoded[i].copy(result, start + offset); offset += encoded[i].length;
    }); return result;
  };
  const familyRecord = name => ({ name, platform: 3, encoding: 1, language: 0x409, id: 1 });
  const parsed = bytes => metadata.inspectFontBytes(bytes);
  const save = (name, bytes) => { const file = join(fonts, name); writeFileSync(file, bytes); report.files.push({ file: name, sha256: hash(bytes) }); return file; };
  const woff = original => {
    const entries = directory(original), start = 44 + entries.length * 20, header = Buffer.alloc(start); header.write('wOFF'); header.writeUInt32BE(original.readUInt32BE(0), 4); header.writeUInt16BE(entries.length, 12);
    let offset = start, sfntSize = 12 + entries.length * 16; const chunks = [header];
    entries.forEach((t, i) => {
      const bytes = original.subarray(t.offset, t.offset + t.length), zipped = deflateSync(bytes), data = zipped.length < bytes.length ? zipped : bytes, p = 44 + i * 20;
      header.write(t.tag, p, 'latin1'); header.writeUInt32BE(offset, p + 4); header.writeUInt32BE(data.length, p + 8); header.writeUInt32BE(bytes.length, p + 12); header.writeUInt32BE(original.readUInt32BE(t.p + 4), p + 16);
      const pad = Buffer.alloc((4 - data.length % 4) % 4); chunks.push(data, pad); offset += data.length + pad.length; sfntSize += Math.ceil(bytes.length / 4) * 4;
    }); header.writeUInt32BE(offset, 8); header.writeUInt32BE(sfntSize, 16); return Buffer.concat(chunks);
  };
  const base128 = value => { const bytes = [value & 127]; while ((value = Math.floor(value / 128))) bytes.unshift((value & 127) | 128); return Buffer.from(bytes); };
  const woff2 = original => {
    const entries = directory(original), header = Buffer.alloc(48), dir = [], chunks = []; let sfntSize = 12 + entries.length * 16;
    for (const t of entries) {
      // Custom tags, null transformations, including glyf/loca transform version 3.
      dir.push(Buffer.from([(t.tag === 'glyf' || t.tag === 'loca' ? 192 : 0) | 63]), Buffer.from(t.tag, 'latin1'), base128(t.length));
      chunks.push(original.subarray(t.offset, t.offset + t.length)); sfntSize += Math.ceil(t.length / 4) * 4;
    }
    const directoryBytes = Buffer.concat(dir), compressed = brotliCompressSync(Buffer.concat(chunks));
    header.write('wOF2'); header.writeUInt32BE(original.readUInt32BE(0), 4); header.writeUInt32BE(48 + directoryBytes.length + compressed.length, 8); header.writeUInt16BE(entries.length, 12); header.writeUInt32BE(sfntSize, 16); header.writeUInt32BE(compressed.length, 20);
    return Buffer.concat([header, directoryBytes, compressed]);
  };
  await test('renamed regular bold italic and duplicate files group by embedded family', () => {
    const result = production.registerFonts(fonts); report.observations.served = result;
    assert.equal(result.length, 1); assert.equal(result[0].family, 'Poppins'); assert.equal(result[0].files.length, 4);
    assert.deepEqual(result[0].faces.map(f => [f.file, f.weight, f.style]), [['Black-Upright.ttf', 400, 'italic'], ['Thin-Normal.ttf', 700, 'normal'], ['Unrelated-Semibold.ttf', 400, 'normal'], ['a-original.ttf', 400, 'normal']]);
    result[0].faces.forEach(f => assert.equal(f.sha256, hash(readFileSync(join(fonts, f.file)))));
  });
  await test('metadata is invariant under arbitrary TTF/OTF-extension renaming', () => {
    save('Unrelated-Thin.otf', regular);
    assert.deepEqual(metadata.inspectFontFile(join(fonts, 'Unrelated-Thin.otf')), parsed(regular));
    assert.equal(production.registerFontFile(fonts, 'Unrelated-Thin.otf'), 'Poppins');
  });
  await test('native pixels selected by descriptors equal production exporter pixels after renaming', async () => {
    const doc = core.createDocument({ width: 600, height: 100 }); doc.layers = [core.makeText({ text: 'Hamburgefonts 123', fontFamily: 'Poppins', fontWeight: 400, fontStyle: 'normal', fontSize: 42, x: 4, y: 4, width: 590, height: 90 })];
    const original = await production.renderToBuffer(doc, root); production.registerFontFile(fonts, 'Unrelated-Semibold.ttf');
    const renamed = await production.renderToBuffer(doc, root); assert.equal(hash(renamed), hash(original));
    report.observations.nativePixelSha256 = hash(renamed); writeFileSync(join(root, 'native-renamed.png'), renamed);
    // This exercises descriptor selection through the same canvas engine. Real browser pixels remain a gate.
    const face = production.registerFonts(fonts)[0].faces.find(f => f.file === 'Unrelated-Semibold.ttf');
    const described = core.deepClone(doc); described.layers[0].fontWeight = face.weight; described.layers[0].fontStyle = face.style;
    assert.equal(hash(await production.renderToBuffer(described, root)), hash(original));
  });
  await test('repeated native registrations do not add aliases or styles or share mutable descriptors', () => {
    const before = JSON.stringify(GlobalFonts.families), first = production.registerFonts(fonts);
    first[0].faces[0].weight = 123; first[0].files.push('fabricated.ttf');
    for (let i = 0; i < 3; i++) { const next = production.registerFonts(fonts); assert.equal(next[0].faces[0].weight, 400); assert.ok(!next[0].files.includes('fabricated.ttf')); }
    assert.equal(JSON.stringify(GlobalFonts.families), before);
  });
  await test('served registration leaves system font choices unchanged', () => {
    const before = production.listSystemFontFamilies(); production.registerFonts(fonts); const after = production.listSystemFontFamilies(); assert.deepEqual(after, before);
    after.push('Mutated Fixture'); assert.ok(!production.listSystemFontFamilies().includes('Mutated Fixture'));
  });
  await test('typographic family is preferred and native registers it honestly', () => {
    const bytes = withTable('name', nameTable([familyRecord('Legacy Fixture'), { ...familyRecord('Typographic Fixture'), id: 16 }]));
    assert.equal(parsed(bytes).metadata.family, 'Typographic Fixture'); save('Filename-Bold.ttf', bytes);
    assert.equal(production.registerFontFile(fonts, 'Filename-Bold.ttf'), 'Typographic Fixture'); assert.ok(GlobalFonts.has('Typographic Fixture'));
  });
  await test('Unicode Windows and Macintosh family encodings are supported', () => {
    for (const record of [{ ...familyRecord('Unicode Fixture'), platform: 0, language: 0, encoding: 4 }, familyRecord('Windows Fixture'), { ...familyRecord('Roman Fixture'), platform: 1, language: 0, encoding: 0 }]) assert.equal(parsed(withTable('name', nameTable([record]))).metadata.family, record.name);
  });
  await test('unsupported name encoding and equally ranked conflicting names are explicit', () => {
    const unsupported = parsed(withTable('name', nameTable([{ ...familyRecord('Encoded Fixture'), encoding: 2 }]))); assert.equal(unsupported.metadata, null); assert.match(unsupported.diagnostics.join(), /No supported/);
    const ambiguous = parsed(withTable('name', nameTable([familyRecord('First Fixture'), familyRecord('Other Fixture')]))); assert.equal(ambiguous.metadata, null); assert.match(ambiguous.diagnostics.join(), /Ambiguous/);
  });
  await test('invalid and truncated native font bytes return null with exact registration diagnostics', () => {
    for (const bytes of [Buffer.from('invalid font'), regular.subarray(0, 10)]) {
      const result = production.registerFontBytes(bytes); assert.equal(result.registered, false); assert.equal(result.family, null); assert.equal(result.face, null); assert.match(result.diagnostics.join(), /Native font registration failed/);
    }
    save('Invalid-Bold.ttf', Buffer.from('invalid font')); assert.equal(production.registerFontFile(fonts, 'Invalid-Bold.ttf'), null); assert.ok(production.fontDiagnostics().some(d => d.file === 'Invalid-Bold.ttf' && !d.registered));
  });
  await test('table directory ranges duplicate tags and overlaps are bounded', () => {
    for (const fn of [b => b.writeUInt32BE(0xfffffff0, table(b, 'name').p + 8), b => b.writeUInt32BE(0xffffffff, table(b, 'name').p + 12), b => b.write('name', table(b, 'post').p, 'latin1'), b => b.writeUInt32BE(table(b, 'name').offset, table(b, 'post').p + 8), b => b.writeUInt16BE(65535, 4)]) assert.equal(parsed(mutate(fn)).metadata, null);
  });
  await test('name record offsets lengths storage and UTF16 parity are bounded', () => {
    for (const fn of [b => b.writeUInt16BE(0, table(b, 'name').offset + 4), b => b.writeUInt16BE(65535, table(b, 'name').offset + 2), b => b.writeUInt16BE(65535, table(b, 'name').offset + 16)]) assert.equal(parsed(mutate(fn)).metadata, null);
    const names = nameTable([familyRecord('Fixture')]); names.writeUInt16BE(3, 14); assert.equal(parsed(withTable('name', names)).metadata, null);
  });
  await test('OS2 weights and slant come from bytes and invalid values are diagnosed', () => {
    const os = table(regular, 'OS/2').offset;
    for (const [weight, flags, expected] of [[600, 0, 'normal'], [400, 1, 'italic'], [400, 512, 'oblique']]) {
      const actual = parsed(mutate(b => { b.writeUInt16BE(4, os); b.writeUInt16BE(weight, os + 4); b.writeUInt16BE(flags, os + 62); })); assert.equal(actual.metadata.weight, weight); assert.equal(actual.metadata.style, expected);
    }
    for (const fn of [b => b.writeUInt16BE(0, os + 4), b => b.writeUInt16BE(1001, os + 4), b => b.writeUInt16BE(0, os + 6), b => { b.writeUInt16BE(4, os); b.writeUInt16BE(513, os + 62); }]) assert.equal(parsed(mutate(fn)).metadata, null);
  });
  await test('variable fonts disclose default-only limits and validate axis bounds', () => {
    const fvar = Buffer.alloc(36); fvar.writeUInt32BE(0x10000); fvar.writeUInt16BE(16, 4); fvar.writeUInt16BE(2, 6); fvar.writeUInt16BE(1, 8); fvar.writeUInt16BE(20, 10); fvar.writeUInt16BE(8, 14); fvar.write('wght', 16); fvar.writeInt32BE(100 * 65536, 20); fvar.writeInt32BE(400 * 65536, 24); fvar.writeInt32BE(900 * 65536, 28);
    const original = mutate(b => b.write('fvar', table(b, 'post').p, 'latin1'));
    const actual = parsed(withTable('fvar', fvar, original)); assert.match(actual.diagnostics.join(), /Variable font.*default/); assert.equal(actual.metadata.weight, 400);
    fvar.writeInt32BE(1000 * 65536, 24); assert.equal(parsed(withTable('fvar', fvar, original)).metadata, null);
  });
  await test('WOFF and WOFF2 descriptors use actual metadata and preserve native admission', () => {
    for (const [extension, convert] of [['woff', woff], ['woff2', woff2]]) {
      const bytes = convert(regular), inspection = parsed(bytes); assert.ok(inspection.metadata, inspection.diagnostics.join()); assert.equal(inspection.metadata.source, extension); assert.equal(inspection.metadata.family, 'Poppins'); assert.equal(inspection.metadata.weight, 400);
      const file = save('Misleading-Black.' + extension, bytes), key = GlobalFonts.registerFromPath(file);
      const nativeAccepted = !!key; if (key) GlobalFonts.remove(key);
      const result = production.registerFontBytes(bytes); assert.equal(result.registered, nativeAccepted);
      if (nativeAccepted) assert.equal(result.family, 'Poppins'); else assert.match(result.diagnostics.join(), /Native font registration failed/);
      report.observations[extension] = { nativeAccepted, inspection, registration: result };
      for (const bad of [bytes.subarray(0, 20), mutate(b => b.writeUInt32BE(0xffffffff, 8), bytes)]) assert.equal(parsed(bad).metadata, null);
    }
  });
  await test('native metadata fallback is filename-independent and repeatable without aliases', () => {
    let bytes = withTable('name', nameTable([familyRecord('Native Fallback Fixture')]));
    bytes = mutate(b => b.write('NOOS', table(b, 'OS/2').p, 'latin1'), bytes);
    assert.equal(parsed(bytes).metadata, null); const result = production.registerFontBytes(bytes); report.observations.fallback = result;
    assert.equal(result.registered, true); assert.equal(result.family, 'Native Fallback Fixture'); assert.equal(result.face.source, 'native'); assert.match(result.diagnostics.join(), /Missing.*OS\/2/);
    const before = JSON.stringify(GlobalFonts.families); result.face.weight = 123;
    save('Random-Bold.ttf', bytes); assert.equal(production.registerFontFile(fonts, 'Random-Bold.ttf'), 'Native Fallback Fixture'); assert.equal(production.registerFontBytes(bytes).face.weight, 400); assert.equal(JSON.stringify(GlobalFonts.families), before);
  });
  await test('ambiguous native fallback never fabricates a filename family', () => {
    const bytes = mutate(b => b.write('NOOS', table(b, 'OS/2').p, 'latin1'));
    const result = production.registerFontBytes(bytes); assert.equal(result.registered, true); assert.equal(result.family, null); assert.equal(result.face, null); assert.match(result.diagnostics.join(), /unavailable or ambiguous/);
  });
  await test('browser consumes regular bold italic metadata and leaves system names intact', async () => {
    fixture.list = production.registerFonts(fonts).filter(f => f.family === 'Poppins').map(f => ({ ...f, files: f.files.filter(file => ['Black-Upright.ttf', 'Thin-Normal.ttf', 'Unrelated-Semibold.ttf', 'a-original.ttf'].includes(file)) })).concat('Arial');
    const result = await env.loadFonts(); assert.ok(result.includes('Arial')); assert.ok(result.includes('Poppins')); assert.deepEqual(env.servedWeights.Poppins, [400, 700]);
    const faces = [...fixture.installed].filter(f => f.family === '"Poppins"');
    assert.equal(faces.length, 3); assert.ok(faces.some(f => f.descriptors.weight === '400' && f.descriptors.style === 'italic')); assert.ok(faces.some(f => f.descriptors.weight === '700' && f.descriptors.style === 'normal'));
    report.observations.loadedFaces = faces.map(f => ({ family: f.family, source: f.source, descriptors: f.descriptors }));
  });
  await test('browser repeated refresh adds no duplicate faces', async () => {
    const before = fixture.faces.length; await env.loadFonts(); await env.loadFonts(); assert.equal(fixture.faces.length, before); assert.equal([...fixture.installed].filter(f => f.family === '"Poppins"').length, 3);
  });
  await test('browser missing descriptors and exact decode failures remain visible', async () => {
    fixture.list = [{ family: 'Unavailable Fixture', files: ['Fake-Bold.ttf'] }];
    assert.deepEqual(await env.loadFonts(), []); assert.equal(env.servedFamilies.length, 0); assert.match(env.fontLoadIssues[0].message, /no valid metadata/);
    fixture.list = [{ family: 'Failed Fixture', files: ['Failed.ttf'], faces: [{ file: 'Failed.ttf', weight: 400, style: 'normal', stretch: 'normal' }] }];
    fixture.failures.add('url("/fonts/Failed.ttf")'); assert.deepEqual(await env.loadFonts(), []); assert.equal(env.fontLoadIssues[0].family, 'Failed Fixture'); assert.equal(env.fontLoadIssues[0].file, 'Failed.ttf'); assert.match(env.fontLoadIssues[0].message, /Fixture decode failure/);
    fixture.failures.clear(); assert.deepEqual(await env.loadFonts(), ['Failed Fixture']); assert.equal(env.fontLoadIssues.length, 0);
  });
  await test('obsolete browser loads cannot overwrite newer descriptors or install old faces', async () => {
    let release; const gate = new Promise(r => { release = r; }); let calls = 0;
    const info = family => [{ family, files: ['face.ttf'], faces: [{ file: 'face.ttf', weight: 400, style: 'normal', stretch: 'normal' }] }];
    fixture.fetch = async () => ++calls === 1 ? gate : new Response(JSON.stringify(info('Current Fixture')));
    const old = env.loadFonts(); await env.loadFonts(); release(new Response(JSON.stringify(info('Obsolete Fixture')))); await old;
    assert.deepEqual(env.servedFamilies, ['Current Fixture']); assert.ok(![...fixture.installed].some(f => f.family === '"Obsolete Fixture"')); fixture.fetch = null;
  });
  await test('failed font API refresh preserves system names and exposes the error', async () => {
    fixture.list = ['Arial']; assert.deepEqual(await env.loadFonts(), ['Arial']); fixture.fetch = async () => new Response('{}', { status: 503 });
    assert.deepEqual(await env.loadFonts(), ['Arial']); assert.equal(env.fontLoadIssues[0].message, 'Font API: 503'); fixture.fetch = null;
  });
  await test('changed descriptor digest reloads while unchanged descriptors reuse a face', async () => {
    const face = { file: 'face.ttf', weight: 600, style: 'normal', stretch: 'normal', sha256: 'a'.repeat(64) };
    fixture.list = [{ family: 'Refresh Fixture', files: ['face.ttf'], faces: [face] }]; await env.loadFonts(); const count = fixture.faces.length;
    await env.loadFonts(); assert.equal(fixture.faces.length, count); face.sha256 = 'b'.repeat(64); await env.loadFonts(); assert.equal(fixture.faces.length, count + 1); assert.equal(fixture.installed.size, 1);
  });
  // Real isolated HTTP server, production upload paths and restart; no UI driving.
  let server, log = '', base = process.env.PICTOCITY_FONT_TEST_URL; const data = resolve(process.env.PICTOCITY_FONT_TEST_DATA ?? join(root, 'api-data')); mkdirSync(data, { recursive: true });
  const start = async () => {
    if (process.env.PICTOCITY_FONT_TEST_URL) return;
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(r => listener.close(r)); base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [resolve('packages/server/dist/index.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PICTOCITY_DATA: data, PICTOCITY_FONTS: join(data, 'fonts'), PICTOCITY_PORT: String(port), PICTOCITY_TOKEN: '' } });
    server.on('error', e => { log += e.stack; }); for (const stream of [server.stdout, server.stderr]) stream.on('data', b => { log += b.toString(); });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (server.exitCode !== null) throw new Error(log); try { if ((await nativeFetch(base + '/api/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 20)); } throw new Error('Server startup cannot-run: ' + log);
  };
  const stop = async () => { if (server && server.exitCode === null && server.signalCode === null) { const closed = once(server, 'exit'); server.kill(); await closed; } };
  const upload = async (name, bytes) => { const response = await nativeFetch(base + '/api/fonts', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, body: bytes }); return { status: response.status, body: await response.json() }; };
  try {
    await test('upload API refreshes actual family descriptors for multiple misleading names', async () => {
      await start();
      for (const [name, source, weight, style] of [['Unrelated-Semibold.ttf', 'Regular', 400, 'normal'], ['Nothing-Thin.ttf', 'Bold', 700, 'normal'], ['Unknown-Upright.ttf', 'Italic', 400, 'italic']]) {
        const bytes = readFileSync(resolve('fonts/Poppins-' + source + '.ttf')), result = await upload(name, bytes);
        assert.equal(result.status, 201, JSON.stringify(result)); assert.equal(result.body.family, 'Poppins'); assert.equal(result.body.face.weight, weight); assert.equal(result.body.face.style, style); assert.equal(hash(readFileSync(join(data, 'fonts', name))), hash(bytes));
      }
      const list = await nativeFetch(base + '/api/fonts').then(r => r.json()), poppins = list.find(f => f.family === 'Poppins'); assert.equal(poppins.files.length, 6); assert.equal(poppins.faces.length, 6); assert.ok(list.some(f => typeof f === 'string')); report.observations.uploadList = poppins;
      fixture.list = list; await env.loadFonts(); assert.deepEqual(env.servedWeights.Poppins, [400, 700]);
    });
    await test('upload invalid and repeated/conflicting filenames retain exact original bytes', async () => {
      if (!existsSync(join(data, 'fonts/Unrelated-Semibold.ttf'))) throw new Error('cannot-run: upload server was unavailable');
      const bytes = readFileSync(join(data, 'fonts/Unrelated-Semibold.ttf'));
      assert.equal((await upload('Unrelated-Semibold.ttf', bytes)).status, 201);
      assert.equal((await upload('Unrelated-Semibold.ttf', readFileSync(resolve('fonts/Poppins-Bold.ttf')))).status, 409); assert.equal(hash(readFileSync(join(data, 'fonts/Unrelated-Semibold.ttf'))), hash(bytes));
      const invalid = await upload('Invalid.ttf', Buffer.from('not font')); assert.equal(invalid.status, 400); assert.match(invalid.body.diagnostics.join(), /Native font registration failed/); assert.equal(existsSync(join(data, 'fonts/Invalid.ttf')), false);
      assert.equal((await nativeFetch(base + '/api/fonts?diagnostics')).status, 200);
    });
    await test('JSON path and local URL uploads share the production descriptor path', async () => {
      if (!existsSync(join(data, 'fonts/Unrelated-Semibold.ttf'))) throw new Error('cannot-run: upload server was unavailable');
      for (const body of [{ path: join(data, 'fonts/Unrelated-Semibold.ttf') }, { url: base + '/fonts/Unrelated-Semibold.ttf', name: 'Unrelated-Semibold.ttf' }]) {
        const response = await nativeFetch(base + '/api/fonts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); assert.equal(result.family, 'Poppins'); assert.equal(result.face.weight, 400); assert.equal(result.face.style, 'normal');
      }
    });
    await test('API retains native-accepted ambiguous metadata with 422 and honest diagnostics', async () => {
      if (!existsSync(join(data, 'fonts/Unrelated-Semibold.ttf'))) throw new Error('cannot-run: upload server was unavailable');
      const bytes = mutate(b => b.write('NOOS', table(b, 'OS/2').p, 'latin1'));
      const result = await upload('Metadata-Unavailable.ttf', bytes); assert.equal(result.status, 422, JSON.stringify(result)); assert.equal(result.body.family, null); assert.equal(result.body.face, null); assert.match(result.body.diagnostics.join(), /unavailable or ambiguous/); assert.equal(hash(readFileSync(join(data, 'fonts/Metadata-Unavailable.ttf'))), hash(bytes));
      const list = await nativeFetch(base + '/api/fonts').then(r => r.json()); assert.ok(!list.some(f => typeof f === 'object' && f.files.includes('Metadata-Unavailable.ttf'))); assert.ok(!list.includes('Metadata-Unavailable'));
      const issues = await nativeFetch(base + '/api/fonts?diagnostics').then(r => r.json()); assert.ok(issues.some(d => d.file === 'Metadata-Unavailable.ttf' && d.registered)); report.observations.apiUnknownMetadata = result;
    });
    await test('restart reproduces upload descriptors and retained original filenames', async () => {
      if (process.env.PICTOCITY_FONT_RESTART_BEFORE) {
        const before = JSON.parse(readFileSync(process.env.PICTOCITY_FONT_RESTART_BEFORE, 'utf8')), after = await nativeFetch(base + '/api/fonts').then(r => r.json());
        assert.deepEqual(after.filter(f => typeof f !== 'string'), before); assert.ok(readdirSync(join(data, 'fonts')).includes('Unrelated-Semibold.ttf')); report.observations.restartList = after.filter(f => typeof f !== 'string'); report.observations.restartMode = 'Separate terminal stopped prior server and launched a fresh Node process; compared retained pre-stop descriptors'; return;
      }
      if (process.env.PICTOCITY_FONT_TEST_URL) throw new Error('cannot-run: external server restart requires a separate terminal run');
      if (!existsSync(join(data, 'fonts/Unrelated-Semibold.ttf'))) throw new Error('cannot-run: upload server was unavailable');
      const before = await nativeFetch(base + '/api/fonts').then(r => r.json()); await stop(); await start(); const after = await nativeFetch(base + '/api/fonts').then(r => r.json()); assert.deepEqual(after.filter(f => typeof f !== 'string'), before.filter(f => typeof f !== 'string'));
      assert.ok(readdirSync(join(data, 'fonts')).includes('Unrelated-Semibold.ttf')); report.observations.restartList = after.filter(f => typeof f !== 'string');
    });
    if (process.argv.includes('--existing-api')) {
      await test('existing API suite runs against this isolated production server', async () => {
        const child = spawn(process.execPath, [resolve('tools/api-tests.mjs')], { windowsHide: true, env: { ...process.env, PICTOCITY_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output += b.toString(); }); const [code] = await once(child, 'exit'); writeFileSync(join(root, 'existing-api.log'), output); assert.equal(code, 0, output); report.observations.existingApi = output.match(/\((\d+) ok\)/)?.[1] ?? 'see log';
      });
    }
  } finally {
    await stop(); writeFileSync(join(root, 'server.log'), log);
    report.serverClosed = process.env.PICTOCITY_FONT_TEST_URL ? null : !server || server.exitCode !== null || server.signalCode !== null;
    report.serverLifecycle = process.env.PICTOCITY_FONT_TEST_URL ? 'External terminal owns shutdown; use separate stop/port-release receipt' : 'Runner-owned child';
  }
}
report.passed = report.cases.filter(c => c.status === 'pass').length;
report.failed = report.cases.filter(c => c.status === 'fail').length;
report.cannotRun = report.cases.filter(c => c.status === 'cannot-run').length;
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(`${report.passed} passed; ${report.failed} failed; ${report.cannotRun} cannot-run. Evidence: ${root}`);
process.exitCode = report.failed ? 1 : 0;
