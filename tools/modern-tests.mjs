import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDocument, makeImage, makeText, makeShape } from "../packages/core/dist/index.js";
import { inspectResources, loadAssets, ImageCache } from "../packages/server/dist/assets.js";
import { RenderService } from "../packages/server/dist/render-service.js";
import { renderToBuffer } from "../packages/server/dist/node-env.js";

const root = mkdtempSync(join(tmpdir(), "pictocity-modern-"));
const assets = join(root, "assets"); mkdirSync(assets);
let count = 0, server, service;
const report = { cases: [], responsiveness: null };
const test = async (name, action) => { await action(); count++; report.cases.push(name); console.log("ok " + name); };
const waitFor = async (condition, ms = 10000) => { const start = Date.now(); while (!(await condition())) { if (Date.now() - start > ms) throw new Error("Condition timed out"); await new Promise((r) => setTimeout(r, 25)); } };
function png(color) { const c = createCanvas(8, 8), ctx = c.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 8, 8); return c.toBuffer("image/png"); }
const asset = { id: "image", name: "Photo", src: "/assets/photo.png", width: 8, height: 8, mime: "image/png" };
const picture = () => { const doc = createDocument({ width: 8, height: 8 }); doc.assets.image = { ...asset }; doc.layers = [makeImage({ assetId: "image", width: 8, height: 8 })]; return doc; };
try {
  await test("missing image refuses instead of exporting a blank layer", async () => { const doc = picture(); const { report } = await inspectResources(doc, assets); assert.equal(report.ok, false); assert.equal(report.issues[0].assetId, "image"); await assert.rejects(() => renderToBuffer(doc, assets), (e) => e.status === 422); });
  await test("missing masks, patterns, records and character fonts are checked", async () => {
    const doc = createDocument(); const shape = makeShape(); shape.mask = { kind: "raster", assetId: "mask" }; shape.styles = { patternOverlay: { enabled: true, assetId: "pattern", scale: 1, opacity: 1, blend: "normal" } };
    const text = makeText({ text: "Hello", fontFamily: "sans-serif", runs: [{ start: 0, end: 1, fontFamily: "Pictocity nonexistent family 92831" }] }); doc.layers = [shape, text];
    const { report } = await inspectResources(doc, assets); assert.deepEqual(new Set(report.issues.map((i) => i.code)), new Set(["missing_font", "missing_asset_record"])); assert.equal(report.issues.length, 3);
  });
  await test("unused image records do not block rendering", async () => { const doc = createDocument(); doc.assets.image = { ...asset }; assert.equal((await inspectResources(doc, assets)).report.ok, true); });
  await test("same-size image replacement with preserved timestamp invalidates cache", async () => {
    const file = join(assets, "photo.png"); const red = png("#ff0000"), blue = png("#0000ff"); assert.equal(red.length, blue.length); writeFileSync(file, red); const before = statSync(file); const doc = picture(); const first = await loadAssets(doc, assets);
    writeFileSync(file, blue); utimesSync(file, before.atime, before.mtime); const second = await loadAssets(doc, assets); assert.notEqual(first.get("image"), second.get("image"));
    const c = createCanvas(8, 8), ctx = c.getContext("2d"); ctx.drawImage(second.get("image"), 0, 0); assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [0, 0, 255, 255]);
  });
  await test("existing relative asset paths retain the same pixels without rewriting documents", async () => {
    const digests = [], rasters = [];
    for (const src of ["/assets/photo.png", "assets/photo.png", "photo.png"]) {
      const doc = picture(); doc.assets.image.src = src;
      const { report } = await inspectResources(doc, assets); assert.equal(report.ok, true); digests.push(report.assets[0].sha256);
      rasters.push(await renderToBuffer(doc, assets)); assert.equal(doc.assets.image.src, src);
    }
    assert.equal(new Set(digests).size, 1); assert.deepEqual(rasters[0], rasters[1]); assert.deepEqual(rasters[1], rasters[2]);
  });
  await test("asset namespace refuses traversal and remote sources", async () => { for (const src of ["/assets/../outside.png", "assets/../outside.png", "assets/folder/photo.png", "https://example.com/image.png", "C:\\outside.png"]) { const doc = picture(); doc.assets.image.src = src; assert.equal((await inspectResources(doc, assets)).report.ok, false); } });
  await test("corrupted replacement never serves a cached previous image", async () => { writeFileSync(join(assets, "photo.png"), "invalid"); assert.equal((await inspectResources(picture(), assets)).report.ok, false); });
  await test("cache eviction is bounded by decoded bytes and tracks recent use", () => { const cache = new ImageCache(800); cache.set("a", { width: 10, height: 10 }); cache.set("b", { width: 10, height: 10 }); cache.get("a"); cache.set("c", { width: 10, height: 10 }); assert.equal(cache.get("b"), undefined); assert.equal(cache.stats().bytes, 800); cache.set("huge", { width: 1000, height: 1000 }); assert.equal(cache.stats().bytes, 800); });
  await test("direct raster and comp render inputs cannot bypass work bounds", async () => { const doc = createDocument({ width: 1000, height: 1000 }); for (const opts of [{ scale: 100 }, { scale: NaN }, { format: "mp4" }, { colors: 1 }, { dpi: 0 }]) await assert.rejects(() => renderToBuffer(doc, assets, opts), (e) => e.status === 400); });
  const fixture = join(root, "renderer.mjs"); writeFileSync(fixture, `process.on('message', m => { if(m.cancel) { process.disconnect(); return; } if(m.doc.name==='crash') { process.exit(7); } process.send({phase:'rendering'}); setTimeout(()=> { process.send({done:true,value:m.doc.name},()=>process.disconnect()); },m.options.delay??50); });`);
  service = new RenderService(resolve("fonts"), pathToFileURL(fixture), 2000);
  await test("queued documents are immutable and queue saturation refuses promptly", async () => {
    const doc = createDocument({ name: "original" }); const first = service.run("preflight", doc, assets, { delay: 300 }); const queued = Array.from({ length: 4 }, () => service.run("preflight", doc, assets)); doc.name = "mutated";
    await assert.rejects(() => service.run("preflight", doc, assets), (e) => e.status === 429);
    assert.deepEqual(await Promise.all([first, ...queued]), Array(5).fill("original"));
  });
  await test("queued cancellation removes its work and frees queue capacity", async () => { const doc = createDocument(); const first = service.run("preflight", doc, assets, { delay: 200 }); const c = new AbortController(); const queued = service.run("preflight", doc, assets, {}, c.signal); const caught = assert.rejects(() => queued, /cancelled/); c.abort(); await caught; assert.equal(service.status().queued.length, 0); await first; });
  await test("renderer crash refuses its task and subsequent work succeeds", async () => { await assert.rejects(() => service.run("preflight", createDocument({ name: "crash" }), assets), /exited/); assert.equal(await service.run("preflight", createDocument({ name: "after crash" }), assets), "after crash"); });
  await test("active cancellation closes the renderer before accepting another job", async () => { const c = new AbortController(); const active = service.run("preflight", createDocument(), assets, { delay: 1000 }, c.signal); const caught = assert.rejects(() => active, /cancelled/); await waitFor(() => service.status().active?.phase === "rendering"); c.abort(); await caught; assert.equal(service.status().active, null); });
  await test("deadline refuses a stalled task and renderer remains usable", async () => { await assert.rejects(() => service.run("preflight", createDocument(), assets, { delay: 2500 }), (e) => e.status === 504); assert.equal(await service.run("preflight", createDocument({ name: "after deadline" }), assets), "after deadline"); });
  await service.close(); service = undefined;

  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening"); const port = socket.address().port; await new Promise((r) => socket.close(r));
  server = spawn(process.execPath, ["packages/server/dist/index.js"], { env: { ...process.env, PICTOCITY_DATA: root, PICTOCITY_PORT: String(port) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let serverLog = ""; server.stdout.on("data", (b) => serverLog += b); server.stderr.on("data", (b) => serverLog += b);
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, body) => { const r = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  await waitFor(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { if (server.exitCode !== null) throw new Error(serverLog); return false; } });
  await test("preflight and all major export formats propagate resource errors", async () => { const doc = picture(); const created = await request("/api/docs", { document: doc }); const id = created.body.id; assert.equal((await request(`/api/docs/${id}/preflight`)).body.ok, false); for (const format of ["png", "svg", "psd", "gif", "mp4"]) { const result = await request(`/api/docs/${id}/export`, { format, duration: 0.1 }); assert.equal(result.status, 422, JSON.stringify(result)); assert.ok(result.body.report.issues.length); } });
  await test("stale export and excessive scale refuse without publishing", async () => { const d = (await request("/api/docs", { width: 48, height: 32 })).body; assert.equal((await request(`/api/docs/${d.id}/export`, { expectedRev: 99 })).status, 409); assert.equal((await request(`/api/docs/${d.id}/export`, { scale: 1e9 })).status, 400); });
  await test("invalid font uploads preserve existing fonts and create no corrupt file", async () => {
    const original = readFileSync(join(root, "fonts", "Poppins-Regular.ttf"));
    const upload = (name) => fetch(base + "/api/fonts", { method: "POST", headers: { "content-type": "application/octet-stream", "x-filename": name }, body: "invalid font" });
    assert.equal((await upload("Poppins-Regular.ttf")).status, 409); assert.deepEqual(readFileSync(join(root, "fonts", "Poppins-Regular.ttf")), original);
    assert.equal((await upload("Invalid.ttf")).status, 400); assert.equal(existsSync(join(root, "fonts", "Invalid.ttf")), false);
  });
  await test("portable import cannot overwrite an existing document's image", async () => { const file = join(assets, "photo.png"); writeFileSync(file, png("#ff0000")); const before = readFileSync(file); const imported = await request("/api/docs/import-package", { doc: picture(), assets: { image: png("#0000ff").toString("base64") } }); assert.equal(imported.status, 201); assert.deepEqual(readFileSync(file), before); const restored = (await request(`/api/docs/${imported.body.id}`)).body; assert.notEqual(restored.assets.image.src, "/assets/photo.png"); });
  await test("real MP4 export preserves frames while health and edits remain responsive", async () => {
    const d = (await request("/api/docs", { name: "Responsive export", width: 1024, height: 576, background: "#ff0000" })).body; const output = join(root, "responsive.mp4");
    let finished = false; const exporting = request(`/api/docs/${d.id}/export`, { format: "mp4", duration: 2, fps: 24, expectedRev: 0, path: output }).finally(() => finished = true);
    await waitFor(async () => !!(await request("/api/render-status")).body.active);
    const latency = []; let samplesWhileActive = 0;
    for (let i = 0; i < 12; i++) { const start = performance.now(); const h = await request("/api/health"); latency.push(performance.now() - start); if (!finished) samplesWhileActive++; assert.equal(h.status, 200); }
    const edit = await request(`/api/docs/${d.id}/ops`, { expectedRev: 0, ops: [{ type: "doc.set", props: { background: "#0000ff" } }] }); assert.equal(edit.status, 200);
    const out = await exporting; assert.equal(out.status, 200, JSON.stringify(out)); assert.equal(out.body.frames, 48); assert.ok(samplesWhileActive >= 3); assert.ok(Math.max(...latency) < 1000);
    const probe = JSON.parse(execFileSync(process.env.PICTOCITY_FFPROBE ?? "ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json", output])); assert.equal(Number(probe.streams[0].nb_read_frames), 48);
    const pixels = execFileSync(process.env.PICTOCITY_FFMPEG ?? "ffmpeg", ["-v", "error", "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 3e6 }); assert.ok(pixels[0] > 200 && pixels[2] < 30);
    report.responsiveness = { samples: latency.length, samplesWhileActive, maxHealthMs: Math.max(...latency), medianHealthMs: [...latency].sort((a,b) => a-b)[6], frames: out.body.frames, immutableRevision: 0 };
  });
  await test("disconnect cancels a real video and publishes no partial output", async () => {
    const d = (await request("/api/docs", { width: 1280, height: 720 })).body; const c = new AbortController(); const file = join(root, "cancelled.mp4");
    const exporting = fetch(base + `/api/docs/${d.id}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "mp4", duration: 20, path: file }), signal: c.signal }); const caught = assert.rejects(() => exporting, /abort/i);
    await waitFor(async () => (await request("/api/render-status")).body.active?.phase === "rendering"); c.abort(); await caught;
    await waitFor(async () => !(await request("/api/render-status")).body.active, 15000); assert.equal(existsSync(file), false);
  });
  console.log(`${count} modern reliability tests passed`);
  if (process.env.PICTOCITY_TEST_REPORT) writeFileSync(process.env.PICTOCITY_TEST_REPORT, JSON.stringify(report, null, 2));
} finally {
  if (service) await service.close();
  if (server && server.exitCode === null) { server.kill(); await once(server, "close"); }
  rmSync(root, { recursive: true, force: true });
}
