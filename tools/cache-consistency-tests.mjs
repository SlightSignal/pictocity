import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, utimesSync, unlinkSync, truncateSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import ts from "typescript";
import { createCanvas, Image as NativeImage, Path2D } from "@napi-rs/canvas";
import { createDocument, makeImage, makeGroup, renderDocument } from "@pictocity/core";

// Use candidate source in memory. Dependencies and released core remain untouched.
const candidate = resolve("."), editor = pathToFileURL(join(candidate, "packages/editor/src/")).href;
const inProcess = process.env.PICTOCITY_CACHE_TEST_IN_PROCESS === "1";
const serverEntry = pathToFileURL(resolve("packages/server/dist/index.js")).href;
const hookFixture = pathToFileURL(resolve("tools/cache-consistency-hooks.mjs")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (/components\/(CanvasView|Dialogs)\.tsx$/.test(context.parentURL ?? "") && ["react", "../store", "./Chrome"].includes(specifier)) return { url: hookFixture, shortCircuit: true };
    if (context.parentURL?.startsWith(editor) && specifier.startsWith(".")) {
      for (const ext of [".ts", ".tsx"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (inProcess && url === serverEntry) return { format: "module", shortCircuit: true, source: readFileSync(fileURLToPath(url), "utf8").replace("const server = createServer", "export const server = createServer") + "\nexport { store, renderer };\n" };
    if (url.startsWith(editor) && /\.tsx?$/.test(url)) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText };
    return next(url, context);
  },
});
const { AssetRefresh } = await import("../packages/editor/src/asset-refresh.ts");
const root = resolve("tools/cache-consistency-evidence", new Date().toISOString().replace(/[:.]/g, "-"));
for (const dir of [root, join(root, "data/assets"), join(root, "temp")]) mkdirSync(dir, { recursive: true });
const report = { scope: "isolated candidate source and headless server; no browser/native verification", transport: inProcess ? "in-process native renderer test adapter; subprocess isolation is NOT tested" : "production child-process renderer", root, cases: [], serverClosed: false };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const waitFor = async (condition, timeout = 10_000) => { const end = Date.now() + timeout; while (!await condition()) { assert.ok(Date.now() < end, "Condition timed out"); await delay(10); } };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = (color) => { const c = createCanvas(8, 8); c.getContext("2d").fillStyle = color; c.getContext("2d").fillRect(0, 0, 8, 8); return c.toBuffer("image/png"); };
const redPng = png("red"), bluePng = png("blue"), fixtureBytes = Math.max(redPng.length, bluePng.length);
const red = Buffer.concat([redPng, Buffer.alloc(fixtureBytes - redPng.length)]), blue = Buffer.concat([bluePng, Buffer.alloc(fixtureBytes - bluePng.length)]);
const picture = (id = "A", src = "/assets/photo.png") => {
  const doc = createDocument({ name: "Cache engineering fixture", width: 8, height: 8, background: null }); doc.id = id;
  doc.assets.image = { id: "image", name: "Engineering image", src, width: 8, height: 8, mime: "image/png" };
  doc.layers = [makeImage({ id: "same-layer", assetId: "image", width: 8, height: 8 })]; return doc;
};
const check = (doc, digest = hash(red)) => ({ ok: true, docId: doc.id, revision: doc.rev, assets: [{ id: "image", sha256: digest }], issues: [], resourceSnapshot: { sha256: digest } });
const test = async (name, fn) => { await fn(); report.cases.push(name); console.log("ok " + name); writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2)); };
function harness(options = {}) {
  let checks = 0, loads = 0, changes = 0; const disposed = [];
  const controller = new AssetRefresh({
    check: async (doc, signal) => { checks++; return options.check ? options.check(doc, signal) : check(doc); },
    load: async (doc, id, digest, signal) => { loads++; return options.load ? options.load(doc, id, digest, signal) : digest; },
    dispose: (value) => disposed.push(value), changed: (pixels) => { if (pixels) changes++; },
  }, options.timeout ?? 2000, 10);
  const doc = picture(); controller.syncDocument(doc); controller.setActive(true);
  return { controller, doc, disposed, counts: () => ({ checks, loads, changes }) };
}

await test("refresh deduplicates simultaneous callers and coalesces scheduled focus checks", async () => {
  const gate = deferred(), h = harness({ check: () => gate.promise });
  const first = h.controller.refresh(); for (let i = 0; i < 20; i++) { assert.equal(h.controller.refresh(), first); h.controller.schedule(); }
  await delay(20); assert.equal(h.counts().checks, 1); gate.resolve(check(picture())); await first;
  assert.equal(h.counts().loads, 1); h.controller.setActive(false);
});
await test("same src and revision use per-asset digest and discard old ready values", async () => {
  let digest = hash(red); const h = harness({ check: (doc) => check(doc, digest) });
  await h.controller.refresh(); const before = JSON.stringify(h.doc);
  digest = hash(blue); await h.controller.refresh(); assert.equal(h.controller.getImage("image"), digest);
  assert.deepEqual(h.disposed, [hash(red)]); assert.equal(JSON.stringify(h.doc), before); assert.ok(h.counts().changes >= 4);
  await h.controller.refresh(); assert.equal(h.counts().loads, 2, "Unchanged bytes do not load again"); h.controller.setActive(false);
});
await test("missing/unreadable asset report clears current pixels and recovery reloads", async () => {
  let missing = false; const h = harness({ check: (doc) => missing ? { ...check(doc), ok: false, assets: [], issues: [{ assetId: "image", message: "Image is unreadable" }] } : check(doc) });
  await h.controller.refresh(); missing = true; await h.controller.refresh(); assert.equal(h.controller.getImage("image"), null);
  assert.deepEqual(h.controller.status().issues, ["Image is unreadable"]); missing = false; await h.controller.refresh(); assert.equal(h.controller.getImage("image"), hash(red)); h.controller.setActive(false);
});
await test("removed asset records and unreferenced images are evicted", async () => {
  const h = harness(); await h.controller.refresh(); const doc = picture(); delete doc.assets.image;
  h.controller.syncDocument(doc); assert.equal(h.controller.getImage("image"), null); assert.match(h.controller.status().issues[0], /no asset record/);
  doc.layers = []; h.controller.syncDocument(doc); assert.equal(h.controller.status().issues.length, 0); h.controller.setActive(false);
});
await test("obsolete preflight responses after document switch are ignored", async () => {
  const gate = deferred(), h = harness({ check: () => gate.promise }); const pending = h.controller.refresh(); await delay(0);
  h.controller.syncDocument(picture("B")); assert.equal(await pending, null); h.controller.setActive(false);
  gate.resolve(check(picture())); await delay(20); assert.equal(h.controller.getImage("image"), null); assert.equal(h.counts().loads, 0);
});
await test("obsolete image decode after switch is disposed without notifying new document", async () => {
  const gate = deferred(), h = harness({ load: () => gate.promise }); const pending = h.controller.refresh(); await waitFor(() => h.counts().loads === 1);
  h.controller.syncDocument(picture("B")); h.controller.setActive(false); assert.equal(await pending, null);
  const changes = h.counts().changes; gate.resolve("old decode"); await delay(0);
  assert.deepEqual(h.disposed, ["old decode"]); assert.equal(h.counts().changes, changes);
});
await test("revision and source changes fence same-document responses", async () => {
  for (const changed of [{ rev: 1 }, { src: "/assets/other.png" }]) {
    const gate = deferred(), h = harness({ check: () => gate.promise }); const pending = h.controller.refresh(); await delay(0);
    const doc = picture(); if (changed.rev) doc.rev = changed.rev; else doc.assets.image.src = changed.src;
    h.controller.syncDocument(doc); h.controller.setActive(false); gate.resolve(check(picture())); assert.equal(await pending, null);
    assert.equal(h.counts().loads, 0);
  }
});
await test("hidden/disconnected/unmounted activity cancels scheduled and in-flight work", async () => {
  const h = harness(); h.controller.setActive(false); await delay(30); assert.equal(h.counts().checks, 0);
  const gate = deferred(); const pendingHarness = harness({ check: (_doc, signal) => { signal.addEventListener("abort", () => { report.abortObserved = true; }); return gate.promise; } });
  const pending = pendingHarness.controller.refresh(); await delay(0); pendingHarness.controller.setActive(false);
  assert.equal(await pending, null); assert.ok(report.abortObserved); assert.equal(pendingHarness.controller.status().checking, false);
  gate.resolve(check(picture())); await delay(20); assert.equal(pendingHarness.counts().loads, 0);
  h.controller.setActive(true); await waitFor(() => h.counts().checks === 1); h.controller.setActive(false);
});
await test("failed and timed-out checks never keep cached pixels marked current", async () => {
  let fail = false; const h = harness({ check: (doc) => { if (fail) throw new Error("offline read failure"); return check(doc); } });
  await h.controller.refresh(); fail = true; assert.equal(await h.controller.refresh(), null); assert.equal(h.controller.getImage("image"), null);
  assert.match(h.controller.status().issues[0], /offline read failure/); h.controller.setActive(false);
  const stalled = harness({ check: () => new Promise(() => {}), timeout: 25 }); assert.equal(await stalled.controller.refresh(), null);
  assert.equal(stalled.controller.status().checking, false); assert.match(stalled.controller.status().issues[0], /timed out/); stalled.controller.setActive(false);
});
await test("bad revision reports and decode failures stay visible with empty image state", async () => {
  const h = harness({ check: (doc) => ({ ...check(doc), revision: 99 }) }); assert.equal(await h.controller.refresh(), null);
  assert.equal(h.controller.getImage("image"), null); assert.match(h.controller.status().issues[0], /Project changed/); h.controller.setActive(false);
  const decode = harness({ load: async () => { throw new Error("decode failed"); } }); await decode.controller.refresh(); assert.equal(decode.controller.getImage("image"), null);
  assert.match(decode.controller.status().issues[0], /decode failed/); decode.controller.setActive(false);
});

// A real isolated HTTP server exercises the new byte endpoint and unchanged export guards.
const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening"); const port = listener.address().port; await new Promise((r) => listener.close(r));
const serverEnv = { PICTOCITY_PORT: String(port), PICTOCITY_DATA: join(root, "data"), PICTOCITY_FONTS: join(root, "data/fonts"), PICTOCITY_TOKEN: "cache-test-token", TEMP: join(root, "temp"), TMP: join(root, "temp") };
let server, inProcessServer; const serverLog = [];
if (inProcess) {
  // Explicit opt-in for terminals that deny child creation. Actual production capture, queue,
  // cleanup, resource inspection, raster encoder and HTTP guards run; transport isolation does not.
  Object.assign(process.env, serverEnv);
  const { RenderService } = await import("../packages/server/dist/render-service.js");
  const { inspectResources } = await import("../packages/server/dist/assets.js");
  const nativeRenderer = await import("../packages/server/dist/node-env.js");
  RenderService.prototype.start = function (job) {
    job.child = { connected: false, kill() {} };
    void (async () => {
      try {
        const dir = job.snapshot.assetsDir;
        const value = job.kind === "preflight" ? { ...(await inspectResources(job.doc, dir)).report, resourceSnapshot: job.snapshot.report }
          : job.kind === "raster" ? await nativeRenderer.renderToBuffer(job.doc, dir, job.options)
          : (() => { throw new Error(`Test adapter does not implement ${job.kind}`); })();
        await this.finish(job, value);
      } catch (error) { await this.finish(job, undefined, error); }
    })();
  };
  inProcessServer = await import(serverEntry);
  await once(inProcessServer.server, "listening");
  serverLog.push("Explicit in-process renderer test adapter. Production subprocess transport untested.\n");
} else {
  server = spawn(process.execPath, [resolve("packages/server/dist/index.js")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...serverEnv } });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => serverLog.push(data.toString()));
}
const base = `http://127.0.0.1:${port}`, nativeFetch = globalThis.fetch;
const api = async (path, body) => { const r = await nativeFetch(base + path, { headers: { authorization: "Bearer cache-test-token", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json(), headers: r.headers }; };
const create = async (doc) => { const result = await api("/api/docs", { document: doc }); assert.equal(result.status, 201, JSON.stringify(result)); return (await api(`/api/docs/${result.body.id}`)).body; };
const imageFile = join(root, "data/assets/photo.png"); writeFileSync(imageFile, red);
let unmount;
try {
  await waitFor(async () => { if (server && server.exitCode !== null) throw new Error(serverLog.join("")); try { return (await api("/api/health")).body.ok; } catch { return false; } });
  const doc = await create(picture("http-A"));
  const checked = (await api(`/api/docs/${doc.id}/preflight`)).body;
  const imageUrl = (sha256, rev = doc.rev) => `/api/docs/${doc.id}/asset-content?${new URLSearchParams({ assetId: "image", sha256, expectedRev: String(rev) })}`;
  await test("content endpoint serves checked bytes without snapshots and rejects auth/hash/revision errors", async () => {
    const r = await nativeFetch(base + imageUrl(checked.assets[0].sha256), { headers: { authorization: "Bearer cache-test-token" } });
    assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store"); assert.equal(r.headers.get("X-Pictocity-Asset-SHA256"), hash(red)); assert.deepEqual(Buffer.from(await r.arrayBuffer()), red);
    assert.equal((await nativeFetch(base + imageUrl(hash(red)))).status, 401);
    assert.equal((await api(imageUrl("bad"))).status, 400); assert.equal((await api(imageUrl(hash(red), 5))).status, 409);
    assert.equal((await api("/api/health")).body.renderer.resources.snapshots, 0);
  });
  await test("same-size/timestamp replacement, missing file, unreadable bytes and recovery are detected", async () => {
    assert.equal(red.length, blue.length);
    const before = statSync(imageFile); writeFileSync(imageFile, blue); utimesSync(imageFile, before.atime, before.mtime);
    assert.equal((await api(imageUrl(hash(red)))).status, 409);
    const now = (await api(`/api/docs/${doc.id}/preflight`)).body; assert.equal(now.assets[0].sha256, hash(blue)); assert.equal(now.revision, checked.revision);
    unlinkSync(imageFile); assert.equal((await api(imageUrl(hash(blue)))).status, 422); assert.equal((await api(`/api/docs/${doc.id}/preflight`)).body.ok, false);
    writeFileSync(imageFile, "invalid image"); assert.equal((await api(`/api/docs/${doc.id}/preflight`)).body.ok, false);
    writeFileSync(imageFile, red); assert.equal((await api(`/api/docs/${doc.id}/preflight`)).body.ok, true);
    assert.equal((await api(`/api/docs/${doc.id}`)).body.rev, doc.rev); assert.equal((await api(`/api/docs/${doc.id}`)).body.assets.image.src, doc.assets.image.src);
  });
  await test("content endpoint accepts existing basename aliases and refuses oversized assets", async () => {
    const alias = await create(picture("http-alias", "photo.png")), report = (await api(`/api/docs/${alias.id}/preflight`)).body;
    const r = await nativeFetch(base + `/api/docs/${alias.id}/asset-content?assetId=image&sha256=${report.assets[0].sha256}&expectedRev=0`, { headers: { authorization: "Bearer cache-test-token" } }); assert.equal(r.status, 200); await r.arrayBuffer();
    const big = join(root, "data/assets/oversized.png"); writeFileSync(big, ""); truncateSync(big, 64 * 1024 * 1024 + 1);
    const oversized = await create(picture("oversized", "/assets/oversized.png")); const out = await api(`/api/docs/${oversized.id}/asset-content?assetId=image&sha256=${hash(red)}&expectedRev=0`);
    assert.equal(out.status, 422); assert.match(out.body.error, /64 MiB/);
  });

  // Minimal browser primitives, actual env/store modules, native decoding and core raster pixels.
  const objectUrls = new Map(); let objectUrlCount = 0;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { const url = `blob:cache-fixture-${++objectUrlCount}`; objectUrls.set(url, blob); return url; };
  URL.revokeObjectURL = (url) => objectUrls.delete(url);
  const nativeSrc = Object.getOwnPropertyDescriptor(NativeImage.prototype, "src");
  globalThis.Image = function () {
    const image = new NativeImage();
    Object.defineProperty(image, "src", { get: () => nativeSrc.get.call(image), set: (url) => {
      if (!url) return;
      const blob = objectUrls.get(url); assert.ok(blob, "Image must load guarded bytes from a blob URL");
      void blob.arrayBuffer().then((bytes) => nativeSrc.set.call(image, Buffer.from(bytes))).catch((error) => image.onerror?.(error));
    } }); return image;
  };
  globalThis.Path2D = Path2D;
  let downloadClicks = 0;
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible", createElement: (tag) => {
    if (tag === "a") return { click() { downloadClicks++; } }; assert.equal(tag, "canvas"); return createCanvas(1, 1);
  } });
  globalThis.window = new EventTarget(); globalThis.location = new URL(base + "/?token=cache-test-token");
  globalThis.history = { replaceState: (_a, _b, url) => { globalThis.location = new URL(url); } };
  const session = new Map(); globalThis.sessionStorage = { getItem: (key) => session.get(key), setItem: (key, value) => session.set(key, value) };
  let httpCalls = [], fetchInterceptor;
  window.fetch = (input, init) => { const url = typeof input === "string" ? input : input.url; httpCalls.push(url); return fetchInterceptor ? fetchInterceptor(url, init, () => nativeFetch(new URL(url, base), init)) : nativeFetch(new URL(url, base), init); };
  Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => window.fetch, set: (value) => { window.fetch = value; } });
  const env = await import("../packages/editor/src/env.ts"), storeModule = await import("../packages/editor/src/store.ts"), { useStore } = storeModule;
  globalThis.__cacheStore = storeModule;
  unmount = env.mountAssetRefresh(); useStore.setState({ doc, connection: "online" });
  const pixel = () => [...renderDocument(useStore.getState().doc, env.browserEnv, { cache: env.renderCache }).getContext("2d").getImageData(4, 4, 1, 1).data];
  await test("actual editor env and RenderCache replace red with blue at unchanged src/rev", async () => {
    await env.refreshAssets(); assert.deepEqual(pixel(), [255, 0, 0, 255]); const before = JSON.stringify(useStore.getState().doc);
    env.renderCache.set("sentinel", { canvas: createCanvas(2, 2), x: 0, y: 0 });
    const stat = statSync(imageFile); writeFileSync(imageFile, blue); utimesSync(imageFile, stat.atime, stat.mtime);
    await env.refreshAssets(); assert.equal(env.renderCache.get("sentinel"), undefined); assert.deepEqual(pixel(), [0, 0, 255, 255]);
    assert.equal(JSON.stringify(useStore.getState().doc), before); assert.equal(objectUrls.size, 0);
    for (const assetCall of httpCalls.filter((url) => url.includes("asset-content"))) assert.ok(assetCall.includes("sha256=") && assetCall.includes("expectedRev="));
    const loadCount = httpCalls.filter((url) => url.includes("asset-content")).length;
    await env.refreshAssets(); assert.equal(httpCalls.filter((url) => url.includes("asset-content")).length, loadCount);
    writeFileSync(join(root, "editor-blue.png"), renderDocument(doc, env.browserEnv, { cache: env.renderCache }).toBuffer("image/png"));
  });
  await test("actual env removal and corrupt-file failures show no old pixels and recover", async () => {
    unlinkSync(imageFile); await env.refreshAssets(); assert.equal(env.browserEnv.getImage("image"), null); assert.ok(env.assetStatus().issues.length); assert.notDeepEqual(pixel(), [0, 0, 255, 255]);
    writeFileSync(imageFile, "unreadable"); await env.refreshAssets(); assert.equal(env.browserEnv.getImage("image"), null);
    writeFileSync(imageFile, red); await env.refreshAssets(); assert.deepEqual(pixel(), [255, 0, 0, 255]);
  });
  await test("real raster group, mask and pattern dependencies invalidate on content change", async () => {
    const composite = structuredClone(doc), image = makeImage({ assetId: "image", width: 8, height: 8 });
    image.mask = { kind: "raster", assetId: "image", x: 0, y: 0, width: 8, height: 8 };
    image.styles = { patternOverlay: { enabled: true, assetId: "image", opacity: 1, blend: "normal", scale: 1 } };
    composite.layers = [makeGroup({ opacity: 0.8, children: [image] })]; useStore.setState({ doc: composite });
    await env.refreshAssets(); const before = pixel(); env.renderCache.set("group-sentinel", { canvas: createCanvas(2, 2), x: 0, y: 0 });
    writeFileSync(imageFile, blue); await env.refreshAssets(); assert.equal(env.renderCache.get("group-sentinel"), undefined); assert.notDeepEqual(pixel(), before);
    useStore.setState({ doc }); writeFileSync(imageFile, red); await env.refreshAssets();
  });
  await test("actual env hidden, disconnected and unmounted lifecycles stop refresh work", async () => {
    const before = httpCalls.length; document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus"));
    assert.equal(await env.refreshAssets(), null); await delay(300); assert.equal(httpCalls.length, before); assert.equal(env.browserEnv.getImage("image"), null);
    document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange")); await env.refreshAssets(); assert.deepEqual(pixel(), [255, 0, 0, 255]);
    useStore.setState({ connection: "offline" }); const offlineCount = httpCalls.length; window.dispatchEvent(new Event("focus")); await delay(300); assert.equal(httpCalls.length, offlineCount);
    useStore.setState({ connection: "online" }); await env.refreshAssets(); unmount(); unmount = undefined;
    const unmountedCount = httpCalls.length; window.dispatchEvent(new Event("focus")); await delay(300); assert.equal(httpCalls.length, unmountedCount);
    unmount = env.mountAssetRefresh(); await env.refreshAssets();
  });
  await test("env ignores aborted HTTP response after switching documents", async () => {
    const gate = deferred(); fetchInterceptor = (url, _init, next) => url.includes("/preflight") ? gate.promise : next();
    const pending = env.refreshAssets(); await delay(0); const switched = { ...doc, id: "never-request-B" };
    useStore.setState({ doc: switched, connection: "offline" }); gate.resolve(new Response(JSON.stringify(check(doc, hash(blue))), { headers: { "content-type": "application/json" } }));
    assert.equal(await pending, null); await delay(0); assert.equal(env.browserEnv.getImage("image"), null);
    fetchInterceptor = undefined; useStore.setState({ doc, connection: "online" }); await env.refreshAssets();
  });
  await test("store fences obsolete sockets, snapshots and history responses after switch", async () => {
    const sockets = []; globalThis.WebSocket = class {
      static OPEN = 1; readyState = 1; sent = []; constructor() { sockets.push(this); } close() {} send(value) { this.sent.push(JSON.parse(value)); }
    };
    const historyGate = deferred(); fetchInterceptor = (url, _init, next) => url.includes(`/docs/${doc.id}/history`) ? historyGate.promise : url.includes("/history") ? Promise.resolve(new Response("[]")) : next();
    useStore.getState().connect(doc.id); const a = sockets.at(-1); a.onopen(); a.onmessage({ data: JSON.stringify({ kind: "snapshot", doc }) });
    const bDoc = { ...doc, id: "socket-B" }; useStore.getState().connect(bDoc.id); const b = sockets.at(-1);
    assert.equal(useStore.getState().doc, null); a.onopen(); assert.equal(useStore.getState().connection, "connecting");
    a.onmessage({ data: JSON.stringify({ kind: "snapshot", doc }) }); assert.equal(useStore.getState().doc, null);
    b.onopen(); b.onmessage({ data: JSON.stringify({ kind: "snapshot", doc }) }); assert.equal(useStore.getState().doc, null, "Wrong document on current socket also ignored");
    b.onmessage({ data: JSON.stringify({ kind: "snapshot", doc: bDoc }) }); assert.equal(useStore.getState().doc.id, bDoc.id);
    historyGate.resolve(new Response(JSON.stringify([{ docId: doc.id, rev: 88 }]))); await delay(0);
    assert.deepEqual(useStore.getState().log, []); assert.equal(useStore.getState().doc.id, bDoc.id); a.onclose(); assert.equal(useStore.getState().connection, "online");
    fetchInterceptor = undefined; useStore.setState({ doc, connection: "online", log: [] });
  });
  const { EffectFixture, elements } = await import("./cache-consistency-hooks.mjs");
  const { CanvasView } = await import("../packages/editor/src/components/CanvasView.tsx");
  const { ExportDialog } = await import("../packages/editor/src/components/Dialogs.tsx");
  const attachButtons = (tree) => { for (const element of elements(tree)) if (element.type === "button" && element.ref) element.ref.current = { disabled: element.props.disabled, focus() {} }; };
  await test("CanvasView assetTick clears old composite pixels and layer rasters before new render", async () => {
    useStore.setState({ doc, connection: "online", showRulers: false, selection: [], zoom: 1, pan: { x: 0, y: 0 } });
    writeFileSync(imageFile, red); await env.refreshAssets();
    const stage = createCanvas(320, 240), wrap = Object.assign(new EventTarget(), { clientWidth: 320, clientHeight: 240 });
    const frames = new Map(); let frameId = 0;
    globalThis.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
    globalThis.cancelAnimationFrame = (id) => frames.delete(id);
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    const fixture = new EffectFixture(CanvasView, (tree) => {
      for (const element of elements(tree)) {
        if (element.type === "canvas" && element.ref) element.ref.current = stage;
        if (element.props?.className === "canvas-area" && element.ref) element.ref.current = wrap;
      }
    });
    const flush = () => { fixture.settle(); for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } fixture.settle(); };
    try {
      flush(); assert.deepEqual([...stage.getContext("2d").getImageData(4, 4, 1, 1).data], [255, 0, 0, 255]); assert.ok(window.__layerAlpha(doc.layers[0].id));
      const checkCount = httpCalls.filter((url) => url.includes("preflight")).length;
      useStore.setState({ zoom: 2 }); flush(); useStore.setState({ zoom: 1 }); flush();
      assert.equal(httpCalls.filter((url) => url.includes("preflight")).length, checkCount, "Ordinary renders do not create snapshots");
      writeFileSync(imageFile, blue); await env.refreshAssets();
      assert.notDeepEqual([...stage.getContext("2d").getImageData(4, 4, 1, 1).data], [255, 0, 0, 255], "Old composite is cleared before the replacement RAF");
      assert.equal(window.__layerAlpha(doc.layers[0].id), undefined); flush();
      assert.deepEqual([...stage.getContext("2d").getImageData(4, 4, 1, 1).data], [0, 0, 255, 255]);
      useStore.setState({ doc: { ...doc } }); fixture.settle(); const obsoleteFrame = [...frames.values()][0];
      useStore.setState({ doc: { ...doc, id: "canvas-B" }, connection: "offline" }); fixture.settle(); obsoleteFrame?.();
      assert.equal(window.__layerAlpha(doc.layers[0].id), undefined);
    } finally { fixture.close(); assert.equal(window.__layerAlpha, undefined); }
    useStore.setState({ doc, connection: "online" }); writeFileSync(imageFile, red); await env.refreshAssets();
  });
  await test("ExportDialog uses shared preflight and guards preview by revision and resource hash", async () => {
    const fixture = new EffectFixture(ExportDialog, attachButtons);
    try {
      fixture.settle(); await waitFor(() => { fixture.settle(); return elements(fixture.tree).some((e) => e.type === "button" && e.props.children === "Export" && !e.props.disabled); });
      const preview = elements(fixture.tree).find((e) => e.type === "img" && e.props.alt === "Export preview"); assert.ok(preview);
      const url = new URL(preview.props.src, base); assert.equal(url.searchParams.get("expectedRev"), String(doc.rev)); assert.match(url.searchParams.get("expectedResources"), /^[0-9a-f]{64}$/);
      document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); fixture.settle();
      assert.equal(elements(fixture.tree).some((e) => e.type === "img"), false); assert.ok(elements(fixture.tree).find((e) => e.type === "button" && e.props.children === "Export").props.disabled);
      document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange")); fixture.settle();
    } finally { fixture.close(); }
    assert.equal(fixture.setsAfterUnmount, 0);
  });
  await test("ExportDialog ignores late export responses and releases its progress polling on unmount", async () => {
    const fixture = new EffectFixture(ExportDialog, attachButtons), gate = deferred();
    try {
      fixture.settle(); await waitFor(() => { fixture.settle(); return elements(fixture.tree).some((e) => e.type === "button" && e.props.children === "Export" && !e.props.disabled); });
      fetchInterceptor = (url, _init, next) => url.includes("/export?") ? gate.promise : next();
      const before = downloadClicks; const exporting = elements(fixture.tree).find((e) => e.type === "button" && e.props.children === "Export").props.onClick(); fixture.settle();
      fixture.close(); gate.resolve(new Response(red, { headers: { "X-Pictocity-Resource-Snapshot": hash(red) } })); await exporting;
      assert.equal(downloadClicks, before); assert.equal(fixture.setsAfterUnmount, 0); assert.equal(objectUrls.size, 0);
      const statusCalls = httpCalls.filter((url) => url.includes("render-status")).length; await delay(550); assert.equal(httpCalls.filter((url) => url.includes("render-status")).length, statusCalls);
    } finally { if (fixture.alive) fixture.close(); fetchInterceptor = undefined; }
  });
  await test("unchanged export guards refuse stale resources/revisions and preserve prior output", async () => {
    const checked = (await api(`/api/docs/${doc.id}/preflight`)).body, path = join(root, "guarded-red.png");
    const first = await api(`/api/docs/${doc.id}/export`, { format: "png", path, expectedRev: doc.rev, expectedResources: checked.resourceSnapshot.sha256 }); assert.equal(first.status, 200, JSON.stringify(first));
    const saved = hash(readFileSync(path)); writeFileSync(imageFile, blue);
    assert.equal((await api(`/api/docs/${doc.id}/export`, { format: "png", path, expectedRev: doc.rev, expectedResources: checked.resourceSnapshot.sha256 })).status, 409);
    assert.equal((await api(`/api/docs/${doc.id}/export`, { format: "png", path, expectedRev: doc.rev + 1 })).status, 409); assert.equal(hash(readFileSync(path)), saved);
    const latest = (await api(`/api/docs/${doc.id}/preflight`)).body, response = await nativeFetch(base + `/api/docs/${doc.id}/export?format=png&expectedRev=${doc.rev}&expectedResources=${latest.resourceSnapshot.sha256}`, { headers: { authorization: "Bearer cache-test-token" } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("X-Pictocity-Revision"), String(doc.rev)); assert.equal(response.headers.get("X-Pictocity-Resource-Snapshot"), latest.resourceSnapshot.sha256);
    writeFileSync(join(root, "guarded-blue.png"), Buffer.from(await response.arrayBuffer()));
    const decoded = new NativeImage(); nativeSrc.set.call(decoded, readFileSync(join(root, "guarded-blue.png"))); await delay(0);
    const output = createCanvas(8, 8); output.getContext("2d").drawImage(decoded, 0, 0); const outputPixel = [...output.getContext("2d").getImageData(4, 4, 1, 1).data];
    assert.deepEqual(outputPixel, [0, 0, 255, 255]); await env.refreshAssets(); assert.deepEqual(pixel(), outputPixel);
    const status = (await api("/api/health")).body.renderer.resources; assert.equal(status.snapshots, 0); assert.equal(status.bytes, 0);
    report.exports = { red: saved, blue: hash(readFileSync(join(root, "guarded-blue.png"))), resourceSnapshot: latest.resourceSnapshot.sha256 };
  });
  URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
} finally {
  unmount?.();
  if (inProcessServer) { inProcessServer.store.flush(); await inProcessServer.renderer.close(); await new Promise((r) => inProcessServer.server.close(r)); report.serverClosed = !inProcessServer.server.listening; }
  else { if (server.exitCode === null) { const closed = once(server, "exit"); server.kill(); await closed; } report.serverClosed = server.exitCode !== null || server.signalCode !== null; }
  writeFileSync(join(root, "server.log"), serverLog.join("")); writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
}
console.log(`${report.cases.length} cache consistency regressions passed. Evidence: ${relative(candidate, root)}`);
