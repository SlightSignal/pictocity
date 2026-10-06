import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, statSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDocument, makeImage, makeShape } from "../packages/core/dist/index.js";
// Exercise the current source without writing build artifacts owned by another worker.
if (process.env.PICTOCITY_TEST_SOURCE === "1") {
  const { registerHooks } = await import("node:module"), { default: ts } = await import("typescript");
  const sources = new Map(["resource-snapshot", "render-service"].map((name) => [pathToFileURL(resolve(`packages/server/dist/${name}.js`)).href, resolve(`packages/server/src/${name}.ts`)]));
  registerHooks({ load(url, context, nextLoad) {
    const source = sources.get(url);
    return source ? { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText } : nextLoad(url, context);
  } });
}
const { SnapshotPool } = await import("../packages/server/dist/resource-snapshot.js");
const { RenderService } = await import("../packages/server/dist/render-service.js");

const fixtureRoot = resolve("tools"), root = mkdtempSync(join(fixtureRoot, ".snapshot-tests-"));
const assets = join(root, "assets"), fonts = join(root, "fonts"), snapshots = join(root, "snapshots");
for (const dir of [assets, fonts, snapshots]) mkdirSync(dir);
const pool = () => new SnapshotPool(undefined, snapshots);
const imageFile = join(assets, "photo.png"), fontFile = join(fonts, "Poppins-Regular.ttf");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = (color) => { const c = createCanvas(8, 8), ctx = c.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 8, 8); return c.toBuffer("image/png"); };
const red = png("#ff0000"), blue = png("#0000ff");
const picture = () => { const doc = createDocument({ width: 8, height: 8 }); doc.assets.image = { id: "image", name: "Photo", src: "/assets/photo.png", mime: "image/png", width: 8, height: 8 }; doc.layers = [makeImage({ assetId: "image", width: 8, height: 8 })]; return doc; };
const pixel = async (bytes) => { const image = await loadImage(Buffer.from(bytes)), c = createCanvas(image.width, image.height); c.getContext("2d").drawImage(image, 0, 0); return [...c.getContext("2d").getImageData(0, 0, 1, 1).data]; };
const waitFor = async (condition, ms = 10000) => { const deadline = Date.now() + ms; while (!condition()) { if (Date.now() > deadline) throw new Error("Condition timed out"); await new Promise((r) => setTimeout(r, 10)); } };
let count = 0, service, http;
const caseFilter = process.env.PICTOCITY_TEST_CASE ? new RegExp(process.env.PICTOCITY_TEST_CASE) : undefined;
const nativeSymlinks = process.env.PICTOCITY_TEST_NATIVE_SYMLINKS === "1";
const report = { moduleMode: process.env.PICTOCITY_TEST_SOURCE === "1" ? "current-source-in-memory" : "built-dist", symlinkMode: nativeSymlinks ? "native" : "controlled-namespace-resolution", cases: [] };
const test = async (name, run) => { if (caseFilter && !caseFilter.test(name)) return; writeFileSync(imageFile, red); await run(); assert.deepEqual(readdirSync(snapshots), [], "All owned snapshots must be removed"); count++; report.cases.push(name); console.log("ok " + name); };
const withOverrides = async (overrides, run) => {
  const originals = overrides.map(([object, key]) => object[key]);
  try { for (const [object, key, value] of overrides) object[key] = value; syncBuiltinESMExports(); return await run(); }
  finally { overrides.forEach(([object, key], i) => { object[key] = originals[i]; }); syncBuiltinESMExports(); }
};
const withStreamingHttp = async (status, run) => {
  let closed = false;
  http = createServer((_req, response) => {
    response.writeHead(status); response.write(Buffer.alloc(1024));
    const timer = setInterval(() => response.write(Buffer.alloc(1024)), 10);
    response.once("close", () => { clearInterval(timer); closed = true; });
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  try { await run(`http://127.0.0.1:${http.address().port}/audio`, () => closed); }
  finally { http.closeAllConnections(); await new Promise((r) => http.close(r)); http = undefined; }
};
try {
  await test("Windows case aliases preserve both document names and copy one physical file", async () => {
    const alias = join(assets, "Photo.png"), doc = picture(), p = pool();
    // This probe needs a case-insensitive filesystem; never turn an unavailable premise into a pass.
    assert.equal(statSync(alias, { bigint: true }).ino, statSync(imageFile, { bigint: true }).ino);
    doc.assets.other = { ...doc.assets.image, id: "other", src: "/assets/Photo.png" }; doc.layers.push(makeImage({ assetId: "other", width: 8, height: 8 }));
    const original = JSON.stringify(doc), frozen = await p.capture(doc, assets, fonts);
    try {
      assert.deepEqual(frozen.report.assets.map((a) => [a.id, a.file, a.sha256]), [["image", "photo.png", digest(red)], ["other", "Photo.png", digest(red)]]);
      assert.equal(frozen.report.bytes, red.length); assert.equal(readdirSync(frozen.assetsDir).length, 1);
      assert.deepEqual(readFileSync(join(frozen.assetsDir, "Photo.png")), red); assert.equal(JSON.stringify(doc), original);
      const { docId, revision, documentSha256, assets: records, fonts: fontRecords } = frozen.report;
      assert.equal(frozen.report.sha256, digest(JSON.stringify({ docId, revision, documentSha256, assets: records, fonts: fontRecords })));
    } finally { await frozen.release(); }
    assert.equal(p.stats().bytes, 0); assert.equal(p.stats().snapshots, 0);
  });
  for (const namespace of ["asset", "font"]) await test(`${namespace} symlink retargeting refuses changed identity even with identical bytes`, async () => {
    // By default only namespace resolution is controlled. Set PICTOCITY_TEST_NATIVE_SYMLINKS=1
    // to require real symlinks; an unavailable native premise fails rather than silently passing.
    // Handles, copies, identities, byte validation, quotas and cleanup always use actual files.
    const library = namespace === "asset" ? assets : fonts, name = namespace === "asset" ? "alias.png" : "alias.ttf", alias = join(library, name);
    const otherName = namespace === "asset" ? "alias-other.png" : "alias-other.ttf", otherAlias = join(library, otherName);
    const a = join(library, "target-a.bin"), b = join(library, "target-b.bin");
    if (!nativeSymlinks) { writeFileSync(alias, "namespace placeholder"); writeFileSync(otherAlias, "namespace placeholder"); } writeFileSync(a, red);
    try {
      for (const replacement of [blue, red]) {
        writeFileSync(b, replacement); let current = a;
        if (nativeSymlinks) for (const file of [alias, otherAlias]) { rmSync(file, { force: true }); fs.symlinkSync(a, file, "file"); }
        const originalRealpath = fs.realpathSync, originalAsyncRealpath = fsPromises.realpath;
        await withOverrides(nativeSymlinks ? [] : [
          [fs, "realpathSync", (file, ...args) => resolve(String(file)) === alias ? a : resolve(String(file)) === otherAlias ? current : originalRealpath(file, ...args)],
          [fsPromises, "realpath", async (file, ...args) => resolve(String(file)) === alias ? a : resolve(String(file)) === otherAlias ? current : originalAsyncRealpath(file, ...args)],
        ], async () => {
          const p = pool(), doc = namespace === "asset" ? picture() : createDocument();
          if (namespace === "asset") {
            doc.assets.image.src = `/assets/${name}`; doc.assets.other = { ...doc.assets.image, id: "other", src: `/assets/${otherName}` };
            doc.layers.push(makeImage({ assetId: "other", width: 8, height: 8 }));
          }
          await assert.rejects(() => p.capture(doc, assets, fonts, { onProgress: (done) => {
            if (done === 2) { if (nativeSymlinks) { rmSync(otherAlias); fs.symlinkSync(b, otherAlias, "file"); } else current = b; }
          } }), (error) => error.status === 409);
          assert.equal(p.stats().snapshots, 0); assert.equal(p.stats().bytes, 0); assert.deepEqual(readdirSync(snapshots), []);
        });
      }
    } finally { for (const file of [alias, otherAlias, a, b]) rmSync(file, { force: true }); }
  });
  await test("non-success infinite HTTP audio is cancelled before quota is released", async () => {
    await withStreamingHttp(503, async (url, closed) => {
      const p = pool(); await assert.rejects(() => p.capture(createDocument(), assets, fonts, { audioSource: url }), (error) => error.status === 400);
      await waitFor(closed, 1000); assert.equal(p.stats().snapshots, 0); assert.equal(p.stats().bytes, 0);
    });
  });
  await test("HTTP audio setup failure cancels the body and closes any opened output", async () => {
    for (const setup of ["open", "reader"]) await withStreamingHttp(200, async (url, closed) => {
      const originalOpen = fsPromises.open, originalFetch = globalThis.fetch, p = pool();
      const overrides = setup === "open" ? [[fsPromises, "open", async (file, ...args) => {
        if (String(file).endsWith(join("media", "audio.bin"))) throw new Error("Injected audio output setup failure");
        return originalOpen(file, ...args);
      }]] : [[globalThis, "fetch", async (...args) => { const response = await originalFetch(...args); response.body.getReader = () => { throw new Error("Injected audio reader setup failure"); }; return response; }]];
      await withOverrides(overrides, async () => {
        await assert.rejects(() => p.capture(createDocument(), assets, fonts, { audioSource: url }), /Injected audio .* setup failure/);
        await waitFor(closed, 1000); assert.equal(p.stats().snapshots, 0); assert.equal(p.stats().bytes, 0); assert.deepEqual(readdirSync(snapshots), []);
      });
    });
  });
  await test("replaced source bytes and preserved timestamps cannot change a retained snapshot", async () => {
    const p = pool(), doc = picture(), before = statSync(imageFile), frozen = await p.capture(doc, assets, fonts);
    try { writeFileSync(imageFile, blue); utimesSync(imageFile, before.atime, before.mtime); assert.deepEqual(readFileSync(join(frozen.assetsDir, "photo.png")), red); assert.equal(frozen.report.assets[0].sha256, digest(red)); assert.equal(doc.assets.image.src, "/assets/photo.png"); }
    finally { await frozen.release(); } assert.equal(p.stats().bytes, 0); assert.equal(p.stats().snapshots, 0);
  });
  await test("changed bytes during capture refuse even with restored timestamps", async () => {
    const p = pool(), before = statSync(imageFile);
    await assert.rejects(() => p.capture(picture(), assets, fonts, { onProgress: (done) => { if (done === 1) { writeFileSync(imageFile, blue); utimesSync(imageFile, before.atime, before.mtime); } } }), (error) => error.status === 409);
    assert.equal(p.stats().bytes, 0); assert.equal(p.stats().snapshots, 0);
  });
  await test("all legacy namespace spellings copy the same bytes without rewriting the document", async () => {
    for (const src of ["/assets/photo.png", "assets/photo.png", "photo.png"]) { const doc = picture(); doc.assets.image.src = src; const frozen = await pool().capture(doc, assets, fonts); try { assert.deepEqual(readFileSync(join(frozen.assetsDir, "photo.png")), red); assert.equal(doc.assets.image.src, src); } finally { await frozen.release(); } }
  });
  await test("multiple IDs referring to one image copy it once", async () => {
    const doc = picture(); doc.assets.other = { ...doc.assets.image, id: "other" }; doc.layers.push(makeImage({ assetId: "other", width: 8, height: 8 })); const frozen = await pool().capture(doc, assets, fonts);
    try { assert.equal(frozen.report.assets.length, 2); assert.equal(frozen.report.bytes, red.length); } finally { await frozen.release(); }
  });
  await test("hidden image masks and enabled patterns are frozen together", async () => {
    const doc = picture(); doc.layers[0].visible = false; const shape = makeShape({ width: 8, height: 8 }); shape.mask = { kind: "raster", assetId: "mask" }; shape.styles = { patternOverlay: { enabled: true, assetId: "pattern", opacity: 1, scale: 1, blend: "normal" } }; doc.layers.push(shape);
    for (const id of ["mask", "pattern"]) { doc.assets[id] = { ...doc.assets.image, id, src: `/assets/${id}.png` }; writeFileSync(join(assets, `${id}.png`), blue); }
    const frozen = await pool().capture(doc, assets, fonts); try { assert.deepEqual(new Set(frozen.report.assets.map((a) => a.id)), new Set(["image", "mask", "pattern"])); } finally { await frozen.release(); }
  });
  await test("unused broken records do not block renders but do block complete project packages", async () => {
    const doc = createDocument(); doc.assets.image = picture().assets.image; doc.assets.image.src = "/assets/absent.png"; const p = pool(), frozen = await p.capture(doc, assets, fonts); await frozen.release(); await assert.rejects(() => p.capture(doc, assets, fonts, { allAssets: true }), (error) => error.status === 422); assert.equal(p.stats().bytes, 0);
  });
  await test("traversal and remote image records refuse without retaining resource files", async () => {
    for (const src of ["/assets/../outside.png", "assets/folder/photo.png", "https://example.invalid/photo.png"]) { const doc = picture(); doc.assets.image.src = src; const p = pool(); await assert.rejects(() => p.capture(doc, assets, fonts), (error) => error.status === 422); assert.equal(p.stats().snapshots, 0); }
  });
  await test("added font bytes stay fixed after their original file is replaced", async () => {
    copyFileSync(resolve("fonts/Poppins-Regular.ttf"), fontFile); const original = readFileSync(fontFile), frozen = await pool().capture(picture(), assets, fonts);
    try { copyFileSync(resolve("fonts/Poppins-Bold.ttf"), fontFile); assert.deepEqual(readFileSync(join(frozen.fontsDir, "Poppins-Regular.ttf")), original); assert.equal(frozen.report.fonts[0].sha256, digest(original)); } finally { await frozen.release(); rmSync(fontFile); }
  });
  await test("local audio bytes are frozen and identified by their digest", async () => {
    const file = join(root, "audio.wav"); writeFileSync(file, "original engineering audio bytes"); const frozen = await pool().capture(picture(), assets, fonts, { audioSource: file });
    try { writeFileSync(file, "replacement audio bytes"); assert.equal(readFileSync(frozen.audioPath, "utf8"), "original engineering audio bytes"); assert.equal(frozen.report.audio.sha256, digest(Buffer.from("original engineering audio bytes"))); } finally { await frozen.release(); }
  });
  await test("HTTP audio is bounded and frozen from its actual response bytes", async () => {
    const bytes = Buffer.from("HTTP engineering audio bytes"); http = createServer((_req, response) => response.end(bytes)); http.listen(0, "127.0.0.1"); await once(http, "listening");
    const frozen = await pool().capture(picture(), assets, fonts, { audioSource: `http://127.0.0.1:${http.address().port}/audio` });
    try { assert.deepEqual(readFileSync(frozen.audioPath), bytes); assert.equal(frozen.report.audio.sha256, digest(bytes)); } finally { await frozen.release(); await new Promise((r) => http.close(r)); http = undefined; }
  });
  await test("capture cancellation cleans copied files and releases its quota", async () => {
    const controller = new AbortController(), p = pool(); await assert.rejects(() => p.capture(picture(), assets, fonts, { signal: controller.signal, onProgress: (done) => { if (done === 1) controller.abort(); } }), (error) => error.status === 499); assert.equal(p.stats().bytes, 0);
  });
  await test("per-export byte budget refuses without leaving a partial snapshot", async () => {
    const p = new SnapshotPool({ snapshots: 5, bytes: 1024, perSnapshot: red.length - 1, files: 1024 }, snapshots); await assert.rejects(() => p.capture(picture(), assets, fonts), (error) => error.status === 413); assert.equal(p.stats().bytes, 0);
  });
  await test("aggregate byte budget and live-snapshot capacity cannot be bypassed", async () => {
    const p = new SnapshotPool({ snapshots: 1, bytes: red.length, perSnapshot: 1024, files: 1024 }, snapshots), first = await p.capture(picture(), assets, fonts);
    try { await assert.rejects(() => p.capture(picture(), assets, fonts), (error) => error.status === 429); } finally { await first.release(); }
    const bytes = new SnapshotPool({ snapshots: 5, bytes: red.length - 1, perSnapshot: 1024, files: 1024 }, snapshots); await assert.rejects(() => bytes.capture(picture(), assets, fonts), (error) => error.status === 429); assert.equal(bytes.stats().bytes, 0);
  });
  await test("cleanup failure retains its disk quota until a successful physical retry", async () => {
    let failed = false; const p = new SnapshotPool({ snapshots: 1, bytes: 1024, perSnapshot: 1024, files: 1024 }, snapshots, async (path) => { if (!failed) { failed = true; throw new Error("Injected locked snapshot directory"); } await rm(path, { recursive: true, force: true }); }), frozen = await p.capture(picture(), assets, fonts);
    await assert.rejects(() => frozen.release(), /locked snapshot/); assert.equal(p.stats().bytes, red.length); assert.equal(p.stats().snapshots, 1); assert.equal(p.stats().cleanupErrors.length, 1); assert.equal(readdirSync(snapshots).length, 1); await assert.rejects(() => p.capture(picture(), assets, fonts), (error) => error.status === 429); await p.cleanup(); assert.equal(p.stats().bytes, 0); assert.equal(p.stats().snapshots, 0); assert.deepEqual(p.stats().cleanupErrors, []);
  });
  await test("an HTTP resource stream cannot exceed the snapshot budget and is cancelled on refusal", async () => {
    http = createServer((_req, response) => { response.writeHead(200); const timer = setInterval(() => response.write(Buffer.alloc(1024)), 5); response.once("close", () => clearInterval(timer)); }); http.listen(0, "127.0.0.1"); await once(http, "listening"); const p = new SnapshotPool({ snapshots: 5, bytes: 64, perSnapshot: 64, files: 1024 }, snapshots);
    await assert.rejects(() => p.capture(createDocument(), assets, fonts, { audioSource: `http://127.0.0.1:${http.address().port}/audio` }), (error) => error.status === 413); assert.equal(p.stats().bytes, 0); await new Promise((r) => http.close(r)); http = undefined;
  });
  await test("resource preparation timeout reports a deadline and cleans a stalled HTTP transfer", async () => {
    http = createServer((_req, _response) => {}); http.listen(0, "127.0.0.1"); await once(http, "listening"); service = new RenderService(fonts, undefined, 100, pool());
    await assert.rejects(() => service.withSnapshot(createDocument(), assets, { audioSource: `http://127.0.0.1:${http.address().port}/stalled` }, async () => { throw new Error("Must not start rendering"); }), (error) => error.status === 504); assert.equal(service.status().resources.snapshots, 0); await service.close(); service = undefined; await new Promise((r) => http.close(r)); http = undefined;
  });
  const worker = join(root, "delayed-renderer.mjs");
  writeFileSync(worker, `import {registerFonts,renderToBuffer} from ${JSON.stringify(pathToFileURL(resolve("packages/server/dist/node-env.js")).href)}; process.on('message',async m=>{if(m.cancel){process.disconnect();return;} if(m.doc.name==='crash'){process.exit(7);} process.send({phase:'rendering'}); setTimeout(async()=>{try{registerFonts(m.fontsDir);const value=await renderToBuffer(m.doc,m.assetsDir);process.send({done:true,value},()=>process.disconnect());}catch(e){process.send({done:true,error:{message:e.message,status:e.status}},()=>process.disconnect());}},m.options.delay??0);});`);
  await test("queued cancellation then close waits for pending allocation and physical cleanup", async () => {
    // Hold both captures before renderer launch; only mkdtemp scheduling is controlled.
    const removed = [], p = new SnapshotPool(undefined, snapshots, async (directory) => { await rm(directory, { recursive: true, force: true }); removed.push(directory); });
    let unblockActive, unblockQueued, requests = 0, allocated, closing, outcomes;
    const activeGate = new Promise((resolve) => { unblockActive = resolve; }), queuedGate = new Promise((resolve) => { unblockQueued = resolve; });
    const originalMkdtemp = fsPromises.mkdtemp;
    service = new RenderService(fonts, undefined, 10000, p);
    try {
      await withOverrides([[fsPromises, "mkdtemp", async (prefix, ...args) => {
        if (prefix !== join(snapshots, "pictocity-resources-")) return originalMkdtemp(prefix, ...args);
        const request = ++requests; await (request === 1 ? activeGate : queuedGate);
        const directory = await originalMkdtemp(prefix, ...args); if (request === 2) allocated = directory; return directory;
      }]], async () => {
        const controller = new AbortController(), active = service.run("raster", picture(), assets), queued = service.run("raster", picture(), assets, {}, controller.signal);
        outcomes = Promise.allSettled([active, queued]); await waitFor(() => requests === 2);
        assert.equal(service.status().queued.length, 1); controller.abort(); assert.equal(service.status().queued.length, 0);
        let closed = false; closing = service.close().then(() => { closed = true; }); unblockActive();
        await waitFor(() => service.status().active === null); await new Promise((r) => setTimeout(r, 20));
        const closedWhilePending = closed, quotaWhilePending = p.stats().snapshots;
        unblockQueued(); await closing; const results = await outcomes;
        assert.deepEqual({ closedWhilePending, quotaWhilePending, lateDirectoryExists: existsSync(allocated), lateDirectoryRemoved: removed.includes(allocated) },
          { closedWhilePending: false, quotaWhilePending: 1, lateDirectoryExists: false, lateDirectoryRemoved: true },
          "close must retain cancelled allocation quota and await physical cleanup");
        assert.equal(results[1].status, "rejected"); assert.equal(results[1].reason.status, 499);
        assert.ok(allocated && removed.includes(allocated), "the late allocated directory must be physically removed");
        assert.equal(existsSync(allocated), false); assert.equal(p.stats().snapshots, 0); assert.equal(p.stats().bytes, 0);
        assert.deepEqual(p.stats().cleanupErrors, []);
      });
    } finally { unblockActive(); unblockQueued(); if (outcomes) await outcomes; if (closing) await closing; await service.close(); service = undefined; }
  });
  await test("queued native exports keep both document edits and red source pixels after external replacement", async () => {
    const p = pool(); service = new RenderService(fonts, pathToFileURL(worker), 10000, p); const doc = picture(), first = service.run("raster", doc, assets, { delay: 500 }), second = service.run("raster", doc, assets);
    await waitFor(() => service.status().queued.length === 1 && service.status().resources.capturing.length === 0 && service.status().active?.phase === "rendering"); doc.layers[0].x = 999; const before = statSync(imageFile); writeFileSync(imageFile, blue); utimesSync(imageFile, before.atime, before.mtime);
    for (const output of await Promise.all([first, second])) assert.deepEqual(await pixel(output), [255, 0, 0, 255]); assert.equal(p.stats().bytes, 0); await service.close(); service = undefined;
  });
  await test("one request snapshot preserves consistent PNG and embedded SVG bytes across source changes", async () => {
    service = new RenderService(fonts, undefined, 10000, pool()); const doc = picture();
    await service.withSnapshot(doc, assets, {}, async (resources) => { const first = await service.run("raster", doc, assets); writeFileSync(imageFile, blue); const second = await service.run("raster", doc, assets), svg = await service.run("svg", doc, assets); assert.deepEqual(await pixel(first), [255, 0, 0, 255]); assert.deepEqual(first, second); assert.ok(svg.includes(red.toString("base64"))); assert.equal(resources.assets[0].sha256, digest(red)); });
    assert.equal(service.status().resources.snapshots, 0); await service.close(); service = undefined;
  });
  await test("renderer crash releases its resources and subsequent native work succeeds", async () => {
    service = new RenderService(fonts, pathToFileURL(worker), 10000, pool()); const doc = picture(); doc.name = "crash"; await assert.rejects(() => service.run("raster", doc, assets), /exited/); doc.name = "after crash"; assert.deepEqual(await pixel(await service.run("raster", doc, assets)), [255, 0, 0, 255]); assert.equal(service.status().resources.bytes, 0); await service.close(); service = undefined;
  });
  await test("shutdown waits for cancelled queued and active snapshots to be removed", async () => {
    service = new RenderService(fonts, pathToFileURL(worker), 10000, pool()); const active = service.run("raster", picture(), assets, { delay: 5000 }), queued = service.run("raster", picture(), assets); const outcomes = Promise.allSettled([active, queued]); await waitFor(() => service.status().active?.phase === "rendering"); await service.close(); const results = await outcomes; assert.ok(results.every((result) => result.status === "rejected")); assert.equal(service.status().resources.bytes, 0); assert.equal(service.status().resources.snapshots, 0); service = undefined;
  });
  assert.ok(count, "The requested test filter must match at least one case");
  console.log(`${count} resource snapshot tests passed`);
  if (process.env.PICTOCITY_TEST_REPORT) writeFileSync(process.env.PICTOCITY_TEST_REPORT, JSON.stringify(report, null, 2));
} finally {
  if (service) await service.close();
  if (http) await new Promise((r) => http.close(r));
  const rel = relative(fixtureRoot, resolve(root)); assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "Cleanup target must stay under the workspace fixture root");
  rmSync(root, { recursive: true, force: true });
}
