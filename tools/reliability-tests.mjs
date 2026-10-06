import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createDocument, makeShape, makeGroup, makeText, applyOps, deepClone } from "../packages/core/dist/index.js";
import { DocStore, RevisionConflict } from "../packages/server/dist/store.js";
import { renderVideo, renderGif } from "../packages/server/dist/node-env.js";
import { atomicWrite } from "../packages/server/dist/atomic-file.js";
import { videoPlan, encodeFrames } from "../packages/server/dist/video-export.js";

const dir = mkdtempSync(join(tmpdir(), "pictocity-reliability-"));
const ffmpeg = process.env.PICTOCITY_FFMPEG ?? "ffmpeg", ffprobe = process.env.PICTOCITY_FFPROBE ?? "ffprobe";
let passed = 0;
async function test(name, action) { await action(); passed++; console.log(`ok ${name}`); }
const envelope = (doc, ops, extra = {}) => ({ docId: doc.id, actor: "test", ops, ...extra });
try {
  await test("committed edits recover before a debounced snapshot", () => {
    const path = join(dir, "crash"); const store = new DocStore(path); const doc = store.create();
    store.apply(envelope(doc, [{ type: "doc.set", props: { name: "Recovered edit" } }]));
    assert.equal(JSON.parse(readFileSync(join(path, doc.id + ".json"))).rev, 0);
    const recovered = new DocStore(path); assert.equal(recovered.get(doc.id).rev, 1); assert.equal(recovered.get(doc.id).name, "Recovered edit"); store.flush();
  });
  await test("incomplete log tail is retained for diagnosis and repaired before another edit", () => {
    const path = join(dir, "tail"); const store = new DocStore(path); const doc = store.create();
    writeFileSync(join(path, doc.id + ".history.jsonl"), '{"docId":');
    const recovered = new DocStore(path); recovered.apply(envelope(doc, [{ type: "doc.set", props: { name: "After tail" } }])); recovered.flush();
    assert.equal(new DocStore(path).get(doc.id).name, "After tail");
  });
  await test("missing log revision blocks editing instead of publishing partial recovery", () => {
    const path = join(dir, "gap"); const store = new DocStore(path); const doc = store.create();
    writeFileSync(join(path, doc.id + ".history.jsonl"), JSON.stringify({ docId: doc.id, rev: 2, ops: [{ type: "doc.set", props: { name: "Wrong" } }] }) + '\n');
    const recovered = new DocStore(path); assert.equal(recovered.get(doc.id).rev, 0); assert.equal(recovered.persistence().ok, false);
    assert.throws(() => recovered.apply(envelope(doc, [{ type: "doc.set", props: { name: "Edit" } }])));
  });
  await test("snapshot failure reports unhealthy persistence and can be retried", () => {
    const path = join(dir, "snapshot"); const store = new DocStore(path); const doc = store.create();
    store.apply(envelope(doc, [{ type: "doc.set", props: { name: "Durable log" } }]));
    const file = join(path, doc.id + ".json"); rmSync(file); mkdirSync(file);
    assert.throws(() => store.flush()); assert.equal(store.persistence().ok, false);
    rmSync(file, { recursive: true }); store.flush(); assert.equal(store.persistence().ok, true);
  });
  await test("failed atomic publication preserves its previous file", () => {
    const file = join(dir, "destination-dir"); mkdirSync(file); writeFileSync(join(file, "sentinel"), "keep");
    assert.throws(() => atomicWrite(file, "new")); assert.equal(readFileSync(join(file, "sentinel"), "utf8"), "keep");
  });
  await test("GIF validates work bounds and cancellation", async () => {
    const doc = createDocument({ width: 48, height: 32 });
    await assert.rejects(() => renderGif(doc, dir, { fps: 100 }), /GIF/);
    await assert.rejects(() => renderGif(doc, dir, { maxColors: 1 }), /colors/);
    const controller = new AbortController(); controller.abort(); await assert.rejects(() => renderGif(doc, dir, { signal: controller.signal }), /cancel/);
  });
  await test("GIF preserves 24-frame animation and centisecond duration", async () => {
    const doc = createDocument({ width: 48, height: 32, background: "#ff0000" }); doc.animation = { fps: 24, duration: 1000, tracks: {} };
    const file = join(dir, "animation.gif"); writeFileSync(file, await renderGif(doc, dir));
    const streams = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file], { encoding: "utf8" })).streams;
    assert.equal(Number(streams[0].nb_read_frames), 24); assert.ok(Math.abs(Number(streams[0].duration) - 1) < 0.01);
  });
  await test("failed batch removes properties introduced before refusal", () => {
    const doc = createDocument(); const before = deepClone(doc);
    assert.throws(() => applyOps(doc, [{ type: "doc.set", props: { animation: { fps: 24, duration: 1000, tracks: {} } } }, { type: "layer.remove", id: "missing" }]));
    assert.deepEqual(doc, before);
  });
  await test("stale revisions refuse without changing history or bytes", () => {
    const store = new DocStore(join(dir, "revisions")); const doc = store.create(); store.flush();
    store.apply(envelope(doc, [{ type: "doc.set", props: { name: "First" } }], { expectedRev: 0 }));
    assert.throws(() => store.apply(envelope(doc, [{ type: "doc.set", props: { name: "Stale" } }], { expectedRev: 0 })), RevisionConflict);
    assert.equal(store.get(doc.id).name, "First"); assert.equal(store.historySince(doc.id, 0).length, 1); store.flush();
    assert.equal(new DocStore(join(dir, "revisions")).get(doc.id).name, "First");
  });
  await test("locking then editing in one batch refuses the whole batch", () => {
    const store = new DocStore(join(dir, "locks")); const doc = store.create();
    doc.layers = [makeShape({ id: "s" })]; store.put(doc); store.flush(); const before = deepClone(doc);
    assert.throws(() => store.apply(envelope(doc, [{ type: "layer.set", id: "s", props: { locked: true } }, { type: "layer.set", id: "s", props: { x: 42 } }])), /locked/);
    assert.deepEqual(store.get(doc.id), before); assert.equal(store.historySince(doc.id, 0).length, 0);
  });
  await test("locked group protects its child", () => {
    const store = new DocStore(join(dir, "group")); const doc = store.create();
    doc.layers = [makeGroup({ id: "g", locked: true, children: [makeShape({ id: "s" })] })]; store.put(doc);
    assert.throws(() => store.apply(envelope(doc, [{ type: "layer.set", id: "s", props: { x: 3 } }])), /locked/); store.flush();
  });
  await test("failed history write does not publish document or revision", () => {
    const store = new DocStore(join(dir, "disk")); const doc = store.create(); store.flush();
    mkdirSync(join(dir, "disk", doc.id + ".history.jsonl"));
    assert.throws(() => store.apply(envelope(doc, [{ type: "doc.set", props: { name: "Must not publish" } }])));
    assert.equal(store.get(doc.id).rev, 0); assert.equal(store.get(doc.id).name, "Untitled"); assert.equal(store.historySince(doc.id, 0).length, 0);
  });
  await test("listener failure does not turn a committed edit into a refusal", () => {
    const store = new DocStore(join(dir, "listener")); const doc = store.create();
    store.onApplied(() => { throw new Error("injected observer failure"); });
    assert.equal(store.apply(envelope(doc, [{ type: "doc.set", props: { name: "Committed" } }])).rev, 1); store.flush();
  });
  await test("video planning pads 1px and odd sizes without cropping", () => {
    assert.equal(videoPlan({ width: 1, height: 1 }).width, 2);
    assert.equal(videoPlan({ width: 63, height: 47 }).width, 64);
    assert.equal(videoPlan({ width: 63, height: 47 }).height, 48);
    assert.equal(videoPlan({ width: 63, height: 47 }, { scale: 0.1 }).width, 8);
    assert.equal(videoPlan({ width: 63, height: 47 }, { scale: 0.1 }).rasterWidth, 7);
  });
  await test("invalid fps, duration, scale, work budget and zero are refused", () => {
    for (const opts of [{ fps: 0 }, { fps: NaN }, { duration: 0 }, { duration: Infinity }, { scale: -1 }, { crf: -1 }, { timeoutMs: 0 }]) assert.throws(() => videoPlan({ width: 64, height: 64 }, opts));
    assert.throws(() => videoPlan({ width: 8000, height: 8000 }, { duration: 600, fps: 120 }), /budget/);
  });
  await test("missing FFmpeg rejects promptly rather than hanging", async () => {
    await assert.rejects(() => encodeFrames([], (async function* () { yield Buffer.alloc(64); })(), { ffmpegPath: join(dir, "missing.exe"), timeoutMs: 2000 }), /FFmpeg/);
  });
  const failing = join(dir, "early-exit.mjs"); writeFileSync(failing, "process.stderr.write('injected encoder failure'); process.exit(7);");
  await test("encoder exits during a blocked pipe write without crashing server", async () => {
    await assert.rejects(() => encodeFrames([failing], (async function* () { for (let i = 0; i < 20; i++) yield Buffer.alloc(1024 * 1024); })(), { ffmpegPath: process.execPath, timeoutMs: 3000 }), /FFmpeg/);
  });
  const hanging = join(dir, "hang.mjs"); writeFileSync(hanging, "setInterval(() => {}, 1000);");
  await test("stalled encoder is killed on timeout", async () => {
    await assert.rejects(() => encodeFrames([hanging], (async function* () { yield Buffer.alloc(1024 * 1024); })(), { ffmpegPath: process.execPath, timeoutMs: 150 }), /timed out/);
  });
  await test("cancellation interrupts an encoder blocked on backpressure", async () => {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 150);
    try { await assert.rejects(() => encodeFrames([hanging], (async function* () { yield Buffer.alloc(1024 * 1024); })(), { ffmpegPath: process.execPath, timeoutMs: 3000, signal: abort.signal }), /cancelled/); } finally { clearTimeout(timer); }
  });
  await test("already cancelled export never starts FFmpeg", async () => {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(() => renderVideo(createDocument(), dir, { signal: abort.signal }), /cancelled/);
  });
  // Real codec tests: unavailable binaries are a failure, never an implicit pass.
  execFileSync(ffmpeg, ["-version"], { stdio: "ignore" }); execFileSync(ffprobe, ["-version"], { stdio: "ignore" });
  const audio = join(dir, "short audio.wav"); execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "0.2", audio]);
  await test("real MP4 keeps 24 frames with short audio and reports padded dimensions", async () => {
    const doc = createDocument({ width: 63, height: 47, background: "#ff0000" });
    const bytes = await renderVideo(doc, dir, { ffmpegPath: ffmpeg, fps: 24, duration: 1, audioPath: audio });
    const file = join(dir, "real.mp4"); writeFileSync(file, bytes);
    const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
    const video = probe.streams.find((s) => s.codec_type === "video");
    assert.equal(video.width, 64); assert.equal(video.height, 48); assert.equal(Number(video.nb_read_frames), 24);
    assert.ok(Number(probe.format.duration) >= 0.99); assert.ok(probe.streams.some((s) => s.codec_type === "audio"));
    const pixels = execFileSync(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1024 * 1024 });
    const last = (24 - 1) * 64 * 48 * 3; assert.ok(pixels[last] > 200 && pixels[last + 1] < 30);
  });
  await test("real WebM exports exact frame count", async () => {
    const bytes = await renderVideo(createDocument({ width: 64, height: 48 }), dir, { ffmpegPath: ffmpeg, format: "webm", duration: 0.5, fps: 24 });
    const file = join(dir, "real.webm"); writeFileSync(file, bytes);
    const streams = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file], { encoding: "utf8" })).streams;
    assert.equal(streams[0].codec_name, "vp9"); assert.equal(Number(streams[0].nb_read_frames), 12);
  });
  console.log(`${passed} reliability tests passed`);
} finally { rmSync(dir, { recursive: true, force: true }); }
