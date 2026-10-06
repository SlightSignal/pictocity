import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDocument, makeShape } from "../packages/core/dist/index.js";
import { assertCodexCompatibleItems } from "./mcp-schema-compat.mjs";

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string"));
async function connect(base) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [process.env.PICTOCITY_MCP_ENTRY ?? "packages/mcp/dist/index.js"], env: { ...env, PICTOCITY_URL: base }, stderr: "pipe" });
  const client = new Client({ name: "pictocity-contract-test", version: "1.0.0" });
  await client.connect(transport);
  assert.deepEqual(client.getServerVersion(), { name: "pictocity", version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version });
  return client;
}
const base = process.env.PICTOCITY_URL; if (!base) throw new Error("Run against an isolated PICTOCITY_URL");
let client = await connect(base), id;
try {
  const tools = await client.listTools(); assert.ok(tools.tools.some((t) => t.name === "export_document"));
  assertCodexCompatibleItems(tools);
  const layerSchemas = tools.tools.find((t) => t.name === "add_layer").inputSchema.properties.layer.anyOf;
  assert.deepEqual(layerSchemas.map((s) => s.properties.type.const), ["text", "shape", "image", "fill", "adjustment", "brush", "group"]);
  console.log("ok MCP add_layer exposes all layer types with Codex-compatible items");
  assert.ok(tools.tools.find((t) => t.name === "apply_ops").inputSchema.properties.expectedRev); console.log(`ok MCP handshake and ${tools.tools.length} tool schemas`);
  assert.ok(tools.tools.some((t) => t.name === "preflight_document"));
  const response = await fetch(base + "/api/docs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "MCP contract", width: 32, height: 32 }) });
  const doc = await response.json(); id = doc.id;
  const result = await client.callTool({ name: "apply_ops", arguments: { docId: id, expectedRev: 0, ops: [{ type: "doc.set", props: { name: "MCP edited" } }] } });
  assert.ok(!result.isError); const stale = await client.callTool({ name: "apply_ops", arguments: { docId: id, expectedRev: 0, ops: [{ type: "doc.set", props: { name: "Stale" } }] } });
  assert.ok(stale.isError); assert.equal((await (await fetch(base + "/api/docs/" + id)).json()).name, "MCP edited"); console.log("ok MCP revisions refuse stale overwrites");
  const check = await client.callTool({ name: "preflight_document", arguments: { docId: id } }); assert.ok(!check.isError); const preflight = JSON.parse(check.content[0].text); assert.equal(preflight.ok, true); console.log("ok MCP project resource preflight");
  assert.ok(tools.tools.find((t) => t.name === "export_document").inputSchema.properties.expectedResources);
  const staleExport = await client.callTool({ name: "export_document", arguments: { docId: id, expectedRev: 0, format: "png" } }); assert.ok(staleExport.isError);
  const staleResources = await client.callTool({ name: "export_document", arguments: { docId: id, expectedRev: preflight.revision, expectedResources: "0".repeat(64), format: "png" } }); assert.ok(staleResources.isError);
  const guardedExport = await client.callTool({ name: "export_document", arguments: { docId: id, expectedRev: preflight.revision, expectedResources: preflight.resourceSnapshot.sha256, format: "png" } }); assert.ok(!guardedExport.isError); console.log("ok MCP reviewed revision and resource fingerprint guard actual exports");
} finally { if (id) await fetch(base + "/api/docs/" + id, { method: "DELETE" }); await client.close(); }
let docRequests = 0;
const wrong = createServer((req, res) => { if (req.url !== "/api/health") docRequests++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); });
wrong.listen(0, "127.0.0.1"); await once(wrong, "listening");
try {
  client = await connect(`http://127.0.0.1:${wrong.address().port}`);
  const result = await client.callTool({ name: "list_documents", arguments: {} }); assert.ok(result.isError); assert.equal(docRequests, 0);
  console.log("ok MCP refuses an older or wrong application before accessing its documents");
} finally { await client.close(); wrong.close(); await once(wrong, "close"); }
const raceDoc = createDocument({ name: "Race", width: 32, height: 32 }); raceDoc.id = "race"; raceDoc.rev = 5; raceDoc.layers = [makeShape({ id: "shape", name: "Target" })];
const guards = [];
const race = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/health") return res.end(JSON.stringify({ ok: true, app: "Pictocity" }));
  if (req.method === "GET") return res.end(JSON.stringify(raceDoc));
  let body = ""; for await (const part of req) body += part; const request = JSON.parse(body); guards.push(request.expectedRev); res.statusCode = 409; res.end(JSON.stringify({ error: "Document changed while tool was planning" }));
});
race.listen(0, "127.0.0.1"); await once(race, "listening");
try {
  client = await connect(`http://127.0.0.1:${race.address().port}`);
  for (const [name, args] of [["update_layer", { layerId: "shape", props: { x: 2 } }], ["duplicate_layer", { layerId: "shape" }], ["remove_layer", { layerId: "shape" }], ["export_document", { format: "png" }]]) { const result = await client.callTool({ name, arguments: { docId: "race", ...args } }); assert.ok(result.isError); }
  assert.deepEqual(guards, [5, 5, 5, 5]); console.log("ok MCP read-derived layer edits and exports carry their fetched revision");
} finally { await client.close(); race.close(); await once(race, "close"); }
const layerDoc = createDocument({ id: "layer-contract", name: "Layer contract", width: 32, height: 32 });
layerDoc.assets.picture = { id: "picture", name: "Fixture", src: "fixture.png", width: 12, height: 8 };
let layerRequests = 0, addedLayer;
const layers = createServer(async (req, res) => {
  layerRequests++; res.setHeader("content-type", "application/json");
  if (req.url === "/api/health") return res.end(JSON.stringify({ ok: true, app: "Pictocity" }));
  if (req.method === "GET" && req.url === "/api/docs/layer-contract") return res.end(JSON.stringify(layerDoc));
  if (req.method !== "POST" || req.url !== "/api/docs/layer-contract/ops") { res.statusCode = 404; return res.end(JSON.stringify({ error: "Unexpected fixture request" })); }
  let body = ""; for await (const part of req) body += part; const request = JSON.parse(body);
  assert.equal(request.expectedRev, layerDoc.rev); assert.equal(request.ops.length, 1); assert.equal(request.ops[0].type, "layer.add");
  addedLayer = request.ops[0].layer; layerDoc.layers.push(addedLayer); layerDoc.rev++;
  res.end(JSON.stringify({ rev: layerDoc.rev }));
});
layers.listen(0, "127.0.0.1"); await once(layers, "listening");
try {
  client = await connect(`http://127.0.0.1:${layers.address().port}`);
  const add = (layer) => client.callTool({ name: "add_layer", arguments: { docId: layerDoc.id, layer } });
  for (const layer of [
    { type: "text", text: "Headline", onPath: { preset: "arc-up" } },
    { type: "shape", preset: "heart", fill: null, mask: { kind: "shape", shape: "ellipse", x: 0, y: 0, width: 32, height: 32 } },
    { type: "image", assetId: "picture", fit: "contain" },
    { type: "fill", fill: { kind: "gradient", type: "diamond", angle: 0, stops: [{ pos: 0, color: "#000000" }, { pos: 1, color: "#ffffff", opacity: 0.5 }] } },
    { type: "adjustment", adjustment: { brightness: 1.2 } },
    { type: "brush", strokes: [{ points: [0, 0, 4, 4], size: 2, color: "#ffffff" }] },
    { type: "group", name: "Group" },
  ]) { const result = await add(layer); assert.ok(!result.isError, JSON.stringify(result)); assert.equal(addedLayer.type, layer.type); }
  console.log("ok MCP add_layer still builds all seven layer types with revision guards");
  const vectors = [
    { layer: { type: "shape", quad: [0, 0, 0, 40, 0, -40, 0, 0] }, path: ["quad"] },
    { layer: { type: "shape", radii: [1, 2, 3, 4] }, path: ["radii"] },
    { layer: { type: "fill", fill: { kind: "linear", from: "#000000", to: "#ffffff", angle: 0, stops: [0.2, 0.8] } }, path: ["fill", "stops"] },
  ];
  for (const prefix of ["filters", "adjustment"]) {
    const type = prefix === "filters" ? "shape" : "adjustment";
    for (const channel of ["shadows", "midtones", "highlights"]) vectors.push({ layer: { type, [prefix]: { colorBalance: { shadows: [1, 2, 3], midtones: [4, 5, 6], highlights: [7, 8, 9] } } }, path: [prefix, "colorBalance", channel] });
    for (const channel of ["r", "g", "b"]) vectors.push({ layer: { type, [prefix]: { channelMixer: { r: [1, 0, 0, 0], g: [0, 1, 0, 0], b: [0, 0, 1, 0] } } }, path: [prefix, "channelMixer", channel] });
    for (const channel of ["rgb", "r", "g", "b"]) vectors.push({ layer: { type, [prefix]: { curves: { [channel]: [[0, 255]] } } }, path: [prefix, "curves", channel, 0] });
  }
  assert.equal(vectors.length, 23);
  for (const { layer, path } of vectors) {
    const values = path.reduce((value, key) => value[key], layer);
    const result = await add(layer); assert.ok(!result.isError, `${path.join(".")}: ${JSON.stringify(result)}`);
    assert.deepEqual(path.reduce((value, key) => value[key], addedLayer), values);
    for (const invalid of [values.slice(1), [...values, 0], ["invalid", ...values.slice(1)], [null, ...values.slice(1)]]) {
      const malformed = structuredClone(layer); const parent = path.slice(0, -1).reduce((value, key) => value[key], malformed); parent[path.at(-1)] = invalid;
      const before = layerRequests; const rejected = await add(malformed);
      assert.ok(rejected.isError, `${path.join(".")} accepted ${JSON.stringify(invalid)}`); assert.equal(layerRequests, before, "Malformed vectors must fail before HTTP access");
    }
  }
  for (const malformed of [{ type: "unknown" }, { type: "text" }, { type: "image" }, { type: "shape", opacity: 2 }]) {
    const before = layerRequests; assert.ok((await add(malformed)).isError); assert.equal(layerRequests, before);
  }
  console.log("ok MCP all 23 numeric vectors retain exact lengths, numeric types and pre-HTTP validation");
} finally { await client.close(); layers.close(); await once(layers, "close"); }
console.log("9 MCP contract checks passed");
