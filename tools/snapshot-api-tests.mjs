import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, utimesSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer, createConnection } from "node:net";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDocument, makeImage, makeArtboard, captureComp } from "../packages/core/dist/index.js";

const retained = !!process.env.PICTOCITY_TEST_DATA;
const root = retained ? resolve(process.env.PICTOCITY_TEST_DATA) : mkdtempSync(join(tmpdir(), "pictocity-snapshot-api-"));
if (retained && existsSync(join(root, ".snapshot-api-used"))) throw new Error("Retained test data already used; choose a fresh copy.");
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, ".snapshot-api-used"), "Owned engineering fixture; preserves existing copied documents.");
const assets = join(root, "assets"), imageFile = join(assets, "snapshot-photo.png");
assert.equal(existsSync(imageFile), false, "Fixture must not replace an existing copied asset");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = (color) => { const c = createCanvas(8, 8), ctx = c.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 8, 8); return c.toBuffer("image/png"); };
const red = png("#ff0000"), blue = png("#0000ff");
writeFileSync(imageFile, red);
const picture = (name = "Snapshot API fixture") => { const doc = createDocument({ name, width: 128, height: 64 }); doc.assets.image = { id: "image", name: "Engineering red image", src: "/assets/snapshot-photo.png", mime: "image/png", width: 8, height: 8 }; doc.layers = [makeImage({ assetId: "image", width: 128, height: 64 })]; return doc; };
const pixel = async (file) => { const image = await loadImage(readFileSync(file)), c = createCanvas(image.width, image.height); c.getContext("2d").drawImage(image, 0, 0); return [...c.getContext("2d").getImageData(0, 0, 1, 1).data]; };
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening"); const port = socket.address().port; await new Promise((r) => socket.close(r));
const packaged = process.env.PICTOCITY_TEST_EXE ? resolve(process.env.PICTOCITY_TEST_EXE) : undefined;
const server = spawn(packaged ?? process.execPath, packaged ? ["--data", root] : [resolve("packages/server/dist/index.js")], { env: { ...process.env, PICTOCITY_PORT: String(port), PICTOCITY_DATA: root, PICTOCITY_TOKEN: "", ...(packaged ? { PICTOCITY_HEADLESS: "1" } : {}) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "", count = 0; for (const stream of [server.stdout, server.stderr]) stream.on("data", (bytes) => { log = (log + bytes.toString()).slice(-65536); });
const base = `http://127.0.0.1:${port}`;
const request = async (path, body) => { const response = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) }; };
const waitFor = async (condition, ms = 20000) => { const deadline = Date.now() + ms; while (!await condition()) { if (server.exitCode !== null) throw new Error(log); if (Date.now() > deadline) throw new Error("Condition timed out"); await new Promise((r) => setTimeout(r, 15)); } };
const report = { schema: "pictocity-resource-snapshot-api/v1", mode: packaged ? "packaged" : "source", ...(packaged ? { executable: packaged, executableSha256: hash(readFileSync(packaged)) } : {}), serverPid: server.pid, root, port, cases: [], exports: [], preservedProjects: [], serverClosed: false };
const test = async (name, run) => { writeFileSync(imageFile, red); await run(); const health = await request("/api/health"); assert.equal(health.body.renderer.resources.snapshots, 0); assert.equal(health.body.renderer.resources.bytes, 0); count++; report.cases.push(name); console.log("ok " + name); };
const create = async (doc) => { const result = await request("/api/docs", { document: doc }); assert.equal(result.status, 201, JSON.stringify(result)); return result.body; };
const blocker = async () => {
  const doc = await create(createDocument({ name: "Queue blocker", width: 1024, height: 576, background: "#222222" }));
  // Export sets reserve their destination directory. Keep this unrelated queue
  // blocker in its own destination so the test exercises renderer queuing.
  const done = request(`/api/docs/${doc.id}/export`, { format: "mp4", duration: 3, fps: 24, expectedRev: 0, path: join(root, "blocker-export", "blocker.mp4") });
  await waitFor(async () => (await request("/api/render-status")).body.active?.docId === doc.id);
  return { done };
};
try {
  await waitFor(async () => { try { return (await request("/api/health")).body.app === "Pictocity"; } catch { return false; } });
  report.health = (await request("/api/health")).body;
  assert.equal(report.health.ok, true, JSON.stringify(report.health.persistence));
  assert.equal(report.health.app, "Pictocity"); assert.equal(report.health.paths.data, root);
  assert.equal(report.health.version, JSON.parse(readFileSync(resolve("package.json"), "utf8")).version);
  if (packaged) {
    // Use a fresh, owned TEMP for this run. Exactly one live onefile payload must match it.
    const entries = readdirSync(tmpdir()).filter((name) => name.startsWith("_MEI")).map((name) => join(tmpdir(), name, "app/packages/mcp/dist/index.js")).filter(existsSync);
    assert.equal(entries.length, 1, "Packaged verification requires an isolated TEMP with one live payload");
    const entry = entries[0];
    assert.equal(hash(readFileSync(entry)), hash(readFileSync(resolve("packages/mcp/dist/index.js"))), "Bundled MCP source is stale");
    process.env.PICTOCITY_MCP_ENTRY = entry;
    report.bundledMcp = { path: entry, sha256: hash(readFileSync(entry)) };
  }
  const existing = (await request("/api/docs")).body;
  for (const doc of existing) { const check = await request(`/api/docs/${doc.id}/preflight`); assert.equal(check.status, 200); assert.equal(check.body.ok, true, JSON.stringify(check)); report.preservedProjects.push({ id: doc.id, revision: check.body.revision, assets: check.body.assets.length }); }

  await test("HTTP queued raster export uses captured red pixels after original replacement", async () => {
    const { done } = await blocker(), doc = await create(picture()), path = join(root, "queued-red.png");
    const exporting = request(`/api/docs/${doc.id}/export`, { format: "png", path, expectedRev: 0 });
    await waitFor(async () => { const state = (await request("/api/render-status")).body; return state.queued.some((job) => job.docId === doc.id) && !state.resources.capturing.some((job) => job.docId === doc.id); });
    const before = statSync(imageFile); writeFileSync(imageFile, blue); utimesSync(imageFile, before.atime, before.mtime);
    assert.equal((await done).status, 200); const out = await exporting; assert.equal(out.status, 200, JSON.stringify(out)); assert.deepEqual(await pixel(path), [255, 0, 0, 255]); assert.equal(out.body.resourceSnapshot.assets[0].sha256, hash(red)); report.exports.push({ path, sha256: hash(readFileSync(path)), snapshot: out.body.resourceSnapshot });
  });
  await test("a changed multi-request resource version refuses and preserves a previous output", async () => {
    const doc = await create(picture()), path = join(root, "versioned.png"), first = await request(`/api/docs/${doc.id}/export`, { format: "png", path, expectedRev: 0 }); assert.equal(first.status, 200); const before = hash(readFileSync(path));
    const same = await request(`/api/docs/${doc.id}/export`, { format: "png", path, expectedRev: 0, expectedResources: first.body.resourceSnapshot.sha256 }); assert.equal(same.status, 200); writeFileSync(imageFile, blue);
    const changed = await request(`/api/docs/${doc.id}/export`, { format: "png", path, expectedRev: 0, expectedResources: first.body.resourceSnapshot.sha256 }); assert.equal(changed.status, 409); assert.equal(hash(readFileSync(path)), before);
  });
  await test("one artboard batch publishes matching source digests and red pixels", async () => {
    const doc = picture("Snapshot artboards"); doc.width = 256; doc.layers = [0, 128].map((x, i) => makeArtboard({ name: `Board ${i+1}`, x, y: 0, width: 128, height: 64, children: [makeImage({ assetId: "image", x, y: 0, width: 128, height: 64 })] })); const created = await create(doc);
    const out = await request(`/api/docs/${created.id}/export`, { format: "png", artboards: true, expectedRev: 0 }); assert.equal(out.status, 200, JSON.stringify(out)); assert.equal(out.body.files.length, 2); assert.equal(out.body.resourceSnapshot.assets[0].sha256, hash(red)); for (const file of out.body.files) assert.deepEqual(await pixel(file.path), [255, 0, 0, 255]);
  });
  await test("layer comp batch and rasterized PDF use one captured resource version", async () => {
    const doc = picture("Snapshot comps"); doc.comps = [captureComp(doc, "First"), captureComp(doc, "Second")]; const created = await create(doc), out = await request(`/api/docs/${created.id}/export`, { format: "png", comps: true, expectedRev: 0 }); assert.equal(out.status, 200, JSON.stringify(out)); assert.equal(out.body.files.length, 2); for (const file of out.body.files) assert.deepEqual(await pixel(file.path), [255, 0, 0, 255]);
    const pdf = await request(`/api/docs/${created.id}/export`, { format: "pdf", expectedRev: 0 }); assert.equal(pdf.status, 200); assert.equal(pdf.body.resourceSnapshot.sha256, out.body.resourceSnapshot.sha256); assert.ok(readFileSync(pdf.body.path).subarray(0, 8).toString().startsWith("%PDF-"));
  });
  await test("complete project package freezes unused images as well as layer dependencies", async () => {
    const doc = picture("Snapshot portable package"); doc.assets.unused = { ...doc.assets.image, id: "unused", src: "/assets/snapshot-unused.png" }; writeFileSync(join(assets, "snapshot-unused.png"), blue); const created = await create(doc), { done } = await blocker();
    const packaging = request(`/api/docs/${created.id}/package`); await waitFor(async () => { const state = (await request("/api/render-status")).body; return state.queued.some((job) => job.docId === created.id) && !state.resources.capturing.some((job) => job.docId === created.id); }); writeFileSync(imageFile, blue); await done; const out = await packaging; assert.equal(out.status, 200, JSON.stringify(out)); assert.deepEqual(Buffer.from(out.body.assets.image, "base64"), red); assert.deepEqual(Buffer.from(out.body.assets.unused, "base64"), blue); assert.equal(out.body.resourceSnapshot.assets.length, 2);
  });
  await test("binary downloads carry the exact document revision and resource fingerprint", async () => {
    const doc = await create(picture()), response = await fetch(base + `/api/docs/${doc.id}/export?format=png&expectedRev=0`); assert.equal(response.status, 200); assert.equal(response.headers.get("X-Pictocity-Revision"), "0"); assert.match(response.headers.get("X-Pictocity-Resource-Snapshot"), /^[0-9a-f]{64}$/); const path = join(root, "binary-red.png"); writeFileSync(path, Buffer.from(await response.arrayBuffer())); assert.deepEqual(await pixel(path), [255, 0, 0, 255]);
  });
  await test("different output scales preserve separate files and exact raster dimensions", async () => {
    const doc = await create(picture("Snapshot output scales")), checked = await request(`/api/docs/${doc.id}/preflight`); assert.equal(checked.body.ok, true); const first = await request(`/api/docs/${doc.id}/export`, { format: "png", scale: 1, expectedRev: 0, expectedResources: checked.body.resourceSnapshot.sha256 }); assert.equal(first.status, 200); const firstHash = hash(readFileSync(first.body.path)); const second = await request(`/api/docs/${doc.id}/export`, { format: "png", scale: 2, expectedRev: 0, expectedResources: first.body.resourceSnapshot.sha256 }); assert.equal(second.status, 200); assert.notEqual(first.body.path, second.body.path); assert.ok(second.body.path.endsWith("@2x.png")); assert.equal(hash(readFileSync(first.body.path)), firstHash); const image = await loadImage(readFileSync(second.body.path)); assert.deepEqual([image.width,image.height],[256,128]); assert.deepEqual(await pixel(second.body.path),[255,0,0,255]);
  });
  await test("video keeps captured red pixels and original 440 Hz audio after both sources change", async () => {
    const ffmpeg = process.env.PICTOCITY_FFMPEG, audio = join(root, "snapshot-audio.wav"), replacement = join(root, "replacement-audio.wav");
    for (const [frequency, path] of [[440, audio], [880, replacement]]) execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=1`, path], { windowsHide: true });
    const originalAudio = hash(readFileSync(audio)), doc = await create(picture()), checked = await request(`/api/docs/${doc.id}/preflight`), { done } = await blocker(), path = join(root, "frozen-av.mp4"); const exporting = request(`/api/docs/${doc.id}/export`, { format: "mp4", duration: 0.5, fps: 24, audio, expectedRev: 0, expectedResources: checked.body.resourceSnapshot.sha256, path });
    await waitFor(async () => { const state = (await request("/api/render-status")).body; return state.queued.some((job) => job.docId === doc.id) && !state.resources.capturing.some((job) => job.docId === doc.id); }); writeFileSync(imageFile, blue); writeFileSync(audio, readFileSync(replacement)); await done;
    const out = await exporting; assert.equal(out.status, 200, JSON.stringify(out)); assert.equal(out.body.resourceSnapshot.audio.sha256, originalAudio); assert.equal(out.body.resourceSnapshot.sha256, checked.body.resourceSnapshot.sha256); assert.notEqual(out.body.resourceSnapshot.bundleSha256, out.body.resourceSnapshot.sha256); const probe = JSON.parse(execFileSync(process.env.PICTOCITY_FFPROBE, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", path], { windowsHide: true })); assert.equal(probe.streams.find((s) => s.codec_type === "video").nb_read_frames, "12"); const pixels = execFileSync(ffmpeg, ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { windowsHide: true }); assert.ok(pixels[0] > 220 && pixels[2] < 20);
    const pcm = execFileSync(ffmpeg, ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { windowsHide: true }); let crossings = 0; const from = 4800, to = 19200; for (let i=from+1; i<to; i++) if (pcm.readFloatLE((i-1)*4) <= 0 && pcm.readFloatLE(i*4) > 0) crossings++; const hz = crossings * 48000/(to-from); assert.ok(Math.abs(hz - 440) < 10, String(hz)); report.exports.push({ path, sha256: hash(readFileSync(path)), sourceAudioSha256: originalAudio, measuredHz: hz, scope: "Decoded pixels and frequency, not listening or creative approval." });
  });
  await test("corrupt captured image refuses without replacing the previous final export", async () => {
    const doc = await create(picture()), path = join(root, "preserved.png"), first = await request(`/api/docs/${doc.id}/export`, { format: "png", expectedRev: 0, path }); assert.equal(first.status, 200); const previous = hash(readFileSync(path)); writeFileSync(imageFile, "corrupt image"); const failed = await request(`/api/docs/${doc.id}/export`, { format: "png", expectedRev: 0, path }); assert.equal(failed.status, 422); assert.equal(hash(readFileSync(path)), previous);
  });
  writeFileSync(imageFile, red);
  const native = await create(picture("Pictocity Snapshot Verification")); report.nativeFixture = native;
  process.env.PICTOCITY_URL = base;
  for (const suite of ["api-tests", "mcp-tests"]) {
    const output = execFileSync(process.execPath, [resolve(`tools/${suite}.mjs`)], { env: process.env, windowsHide: true, encoding: "utf8", timeout: 120000 });
    if (process.env.PICTOCITY_TEST_REPORT) writeFileSync(join(resolve(process.env.PICTOCITY_TEST_REPORT, ".."), `${suite}.log`), output); console.log(output.trim().split(/\r?\n/).slice(-1)[0]);
  }
  console.log(`${count} resource snapshot API tests passed`);
} finally {
  if (server.exitCode === null) { server.kill(); await once(server, "close"); }
  const listening = () => new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => { socket.destroy(); if (error.code === "ECONNREFUSED") resolve(false); else reject(error); });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Shutdown port observation timed out")); });
  });
  const deadline = Date.now() + 10000;
  while (await listening()) { if (Date.now() > deadline) throw new Error("Owned server port remained open after launcher shutdown"); await new Promise((resolve) => setTimeout(resolve, 50)); }
  report.serverClosed = server.exitCode !== null || server.signalCode !== null;
  report.portReleased = true;
  if (process.env.PICTOCITY_TEST_REPORT) writeFileSync(process.env.PICTOCITY_TEST_REPORT, JSON.stringify(report, null, 2));
  if (!retained) { const rel = root.slice(resolve(tmpdir()).length); assert.ok(rel && (rel.startsWith("\\") || rel.startsWith("/"))); rmSync(root, { recursive: true, force: true }); }
}
