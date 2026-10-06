import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, utimesSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDocument, makeImage, makeArtboard } from '../packages/core/dist/index.js';
import { assertCodexCompatibleItems } from './mcp-schema-compat.mjs';

const base = process.env.PICTOCITY_URL, root = process.env.PICTOCITY_TEST_OWNED_ROOT;
assert.ok(base && root, 'Requires an explicitly owned, isolated server data root');
const health = await (await fetch(base + '/api/health')).json();
assert.equal(health.app, 'Pictocity'); assert.equal(resolve(health.paths.data), resolve(root));
const tag = randomUUID(), asset = join(root, 'assets', `mcp-set-${tag}.png`), out = join(root, `mcp-set-${tag}`);
assert.equal(existsSync(asset), false); assert.equal(existsSync(out), false);
mkdirSync(out); mkdirSync(join(root, 'assets'), { recursive: true });
const png = color => { const c = createCanvas(8, 8); c.getContext('2d').fillStyle = color; c.getContext('2d').fillRect(0, 0, 8, 8); return c.toBuffer('image/png'); };
const red = png('red'), blue = png('blue'), sha = b => createHash('sha256').update(b).digest('hex');
assert.equal(red.length, blue.length); writeFileSync(asset, red);
utimesSync(asset, new Date('2026-10-03T00:00:00Z'), new Date('2026-10-03T00:00:00Z'));
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
const transport = new StdioClientTransport({ command: process.execPath, args: [process.env.PICTOCITY_MCP_ENTRY ?? 'packages/mcp/dist/index.js'], env, stderr: 'pipe' });
const client = new Client({ name: 'pictocity-export-set-contract', version: '1.0.0' });
const report = { schema: 'pictocity-export-set-mcp/v1', root, cases: [], files: [], scope: 'Production SDK stdio and real renderer; engineering fixtures, no creative approval' };
let id;
const ok = name => { report.cases.push(name); console.log('ok ' + name); };
const call = args => client.callTool({ name: 'export_set', arguments: { docId: id, ...args } });
const decode = r => { assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content.find(c => c.type === 'text').text); };
const request = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(r.ok, await r.clone().text()); return r.json(); };
try {
  await client.connect(transport);
  const tools = await client.listTools(); assertCodexCompatibleItems(tools);
  const schema = tools.tools.find(t => t.name === 'export_set').inputSchema;
  for (const name of ['docId', 'expectedRev', 'expectedResources']) assert.ok(schema.required.includes(name));
  assert.equal(schema.properties.scales.items.type, 'number'); ok('export_set exposes typed scales and required reviewed guards');
  const doc = createDocument({ name: 'MCP Export Set', width: 256, height: 64 });
  doc.assets.photo = { id: 'photo', name: 'Owned image', src: `/assets/mcp-set-${tag}.png`, mime: 'image/png', width: 8, height: 8 };
  doc.layers = [0, 128].map((x, i) => makeArtboard({ name: i ? 'B' : 'A', x, y: 0, width: 128, height: 64, children: [makeImage({ assetId: 'photo', x, y: 0, width: 128, height: 64 })] }));
  id = (await request('/api/docs', { document: doc })).id;
  assert.ok((await call({ format: 'png', scales: [1, 2] })).isError); assert.deepEqual(readdirSync(out), []); ok('missing reviewed guards refuse before publishing');
  const preflight = decode(await client.callTool({ name: 'preflight_document', arguments: { docId: id } }));
  const guards = { expectedRev: preflight.revision, expectedResources: preflight.resourceSnapshot.sha256 };
  const result = decode(await call({ ...guards, format: 'png', scales: [1, 2], allArtboards: true, dir: out }));
  assert.equal(result.files.length, 4); assert.equal(result.resourceSnapshot.sha256, guards.expectedResources);
  for (const f of result.files) {
    const bytes = readFileSync(f.path); assert.equal(sha(bytes), f.sha256);
    const image = await loadImage(bytes), c = createCanvas(image.width, image.height); c.getContext('2d').drawImage(image, 0, 0);
    assert.deepEqual([image.width, image.height], f.name.includes('@2x') ? [256, 128] : [128, 64]);
    assert.deepEqual([...c.getContext('2d').getImageData(0, 0, 1, 1).data], [255, 0, 0, 255]);
    report.files.push({ name: f.name, path: f.path, sha256: f.sha256, width: image.width, height: image.height });
  }
  ok('one plugin call returns four actual artboard/scale outputs and their hashes');
  const before = result.files.map(f => sha(readFileSync(f.path)));
  assert.ok((await call({ ...guards, expectedRev: guards.expectedRev + 1, format: 'png', scales: [1, 2], allArtboards: true, dir: out })).isError);
  assert.deepEqual(result.files.map(f => sha(readFileSync(f.path))), before); ok('stale revision preserves every previous output');
  const original = statSync(asset), ns = statSync(asset, { bigint: true }); writeFileSync(asset, blue); utimesSync(asset, original.atime, original.mtime);
  assert.equal(statSync(asset).size, original.size); assert.equal(statSync(asset, { bigint: true }).mtimeNs, ns.mtimeNs);
  assert.ok((await call({ ...guards, format: 'png', scales: [1, 2], allArtboards: true, dir: out })).isError);
  assert.deepEqual(result.files.map(f => sha(readFileSync(f.path))), before); ok('equal-size and equal-mtime image change refuses and preserves the set');
  const refreshed = decode(await client.callTool({ name: 'preflight_document', arguments: { docId: id } }));
  assert.ok((await call({ expectedRev: refreshed.revision, expectedResources: refreshed.resourceSnapshot.sha256, format: 'png', scales: [1, 1], dir: out })).isError);
  assert.deepEqual(result.files.map(f => sha(readFileSync(f.path))), before); ok('duplicate scales refuse without publication');
  const final = await (await fetch(base + '/api/health')).json();
  assert.equal(final.renderer.resources.snapshots, 0); assert.equal(final.renderer.resources.bytes, 0);
  assert.equal(final.exportSets.live.length, 0); assert.equal(final.exportSets.bytes, 0);
  assert.equal(readdirSync(out).length, 4); ok('plugin completion retires resource snapshots and export-set quotas');
} catch (error) { report.failure = String(error); throw error; }
finally {
  if (id) { const r = await fetch(base + '/api/docs/' + id, { method: 'DELETE' }); assert.ok(r.ok); }
  await client.close(); unlinkSync(asset);
  if (process.env.PICTOCITY_MCP_SET_REPORT) writeFileSync(process.env.PICTOCITY_MCP_SET_REPORT, JSON.stringify(report, null, 2));
}
console.log(`${report.cases.length} export-set MCP checks passed`);
