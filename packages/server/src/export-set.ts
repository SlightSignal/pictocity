import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, realpath, lstat, rm, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadImage } from "@napi-rs/canvas";
import { artboards, applyCompOps, applyOps, deepClone, findLayer, isGroup, walk, type AdDocument } from "@pictocity/core";
import { renderContext, renderToBuffer, renderVideo, renderGif, renderHtmlBanner, renderSvg, docToPsd, type RenderService } from "./render-service.js";
import { resourceSnapshotContext, type SnapshotReport } from "./resource-snapshot.js";
import { videoPlan } from "./video-export.js";
import { encodePdf } from "./formats.js";
import type { ExportFormat } from "./node-env.js";

const MiB = 1024 * 1024;
export const EXPORT_SET_LIMITS = Object.freeze({ live: 2, files: 64, perSetBytes: 256 * MiB, downloadBytes: 128 * MiB, bytes: 512 * MiB, lifetimeMs: 600_000, responseMs: 30_000 });
const formats = new Set(["png", "png8", "jpg", "jpeg", "webp", "avif", "gif", "tif", "tiff", "bmp", "pdf", "svg", "psd", "html", "mp4", "webm"]);
const failure = (message: string, status = 400, report?: unknown) => Object.assign(new Error(message), { status, report });
const check = (signal: AbortSignal) => { if (signal.aborted) throw signal.reason instanceof Error && (signal.reason as { status?: number }).status ? signal.reason : failure("Export set cancelled", 499); };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safe = (name: string) => name.replace(/[^\w.-]+/g, "_");
const yes = (value: unknown) => value === true || value === "true";
type Query = Record<string, unknown>;
type Member = { name: string; label: string; scale: number; comp?: string; artboard?: string; pages?: string[] };
type FileResult = { name: string; label: string; bytes: number; sha256: string; mime: string; width?: number; height?: number; pages?: number; frames?: number; fps?: number; duration?: number; path?: string; url?: string };
type Fingerprint = { sha256: string; bytes: number; identity: string };
const identity = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`;

function filename(name: string) {
  if (!name || name.length > 180 || name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw failure(`Invalid export filename: ${name}`);
  return name;
}
function number(q: Query, key: string, lo: number, hi: number, fallback: number, integer = false) {
  if (q[key] === undefined) return fallback;
  const n = Number(q[key]);
  if (!["number", "string"].includes(typeof q[key]) || q[key] === "" || !Number.isFinite(n) || n < lo || n > hi || (integer && !Number.isInteger(n))) throw failure(`${key} must be ${integer ? "an integer " : ""}between ${lo} and ${hi}`);
  return n;
}
function board(doc: AdDocument, ref: string) {
  const matches = artboards(doc).filter((a) => a.id === ref || a.name.toLowerCase() === ref.toLowerCase());
  const byId = findLayer(doc, ref);
  if (byId && isGroup(byId) && byId.artboard) return byId;
  if (matches.length !== 1) throw failure(matches.length ? "Artboard name is ambiguous; use its id" : "artboard not found", matches.length ? 400 : 404);
  return matches[0];
}
function comp(doc: AdDocument, ref: string) {
  const exact = doc.comps?.find((c) => c.id === ref);
  if (exact) return exact;
  const matches = (doc.comps ?? []).filter((c) => c.name.toLowerCase() === ref.toLowerCase());
  if (matches.length !== 1) throw failure(matches.length ? "Comp name is ambiguous; use its id" : "comp not found", matches.length ? 400 : 404);
  return matches[0];
}

/** Expand and validate the ENTIRE set before resource capture or renderer admission. */
export function planExportSet(doc: AdDocument, q: Query, exportsDir: string) {
  const requested = String(q.format ?? "png");
  if (!formats.has(requested)) throw failure(`unknown format ${requested}`);
  const format = requested === "jpg" ? "jpeg" : requested === "tif" ? "tiff" : requested;
  const ext = format === "jpeg" ? "jpg" : format === "png8" ? "png" : format;
  const video = format === "mp4" || format === "webm";
  const download = q.destination === "download";
  if (q.destination !== undefined && !["download", "server"].includes(String(q.destination))) throw failure("destination must be download or server");
  for (const key of ["artboards", "comps", "transparent", "trim", "lossless"]) if (q[key] !== undefined && ![true, false, "true", "false"].includes(q[key] as never)) throw failure(`${key} must be a boolean`);
  const quality = number(q, "quality", 1, 100, 90), colors = number(q, "colors", 2, 256, 256, true), dpi = number(q, "dpi", 36, 2400, 72);
  const allBoards = yes(q.artboards), allComps = yes(q.comps);
  for (const key of ["artboard", "comp"]) if (q[key] !== undefined && (typeof q[key] !== "string" || !q[key])) throw failure(`${key} must be a nonempty id or name`);
  if (allBoards && q.artboard) throw failure("Choose artboards or one artboard, not both");
  if (allComps && q.comp) throw failure("Choose comps or one comp, not both");
  const boards = allBoards ? artboards(doc) : q.artboard ? [board(doc, String(q.artboard))] : [];
  const comps = allComps ? doc.comps ?? [] : q.comp ? [comp(doc, String(q.comp))] : [];
  if (allBoards && !boards.length) throw failure("Document has no artboards", 404);
  if (allComps && !comps.length) throw failure("Document has no layer comps", 404);
  if (format === "pdf" && allBoards && boards.length > EXPORT_SET_LIMITS.files) throw failure("PDF exceeds the 64-page limit", 413);
  if (video && boards.length) throw failure("Video export currently uses the whole canvas. Choose Whole canvas.");
  if (video && yes(q.transparent)) throw failure("MP4 and WebM currently export opaque video. Choose an image format for transparency.");
  const rawScales = q.scales ?? [q.scale ?? 1];
  if (!Array.isArray(rawScales) || !rawScales.length || rawScales.length > EXPORT_SET_LIMITS.files) throw failure("scales must be a nonempty array with at most 64 entries");
  const scales = rawScales.map((s) => { const n = Number(s); if (!["number", "string"].includes(typeof s) || !Number.isFinite(n) || n <= 0) throw failure("Scale must be positive and finite"); return n; });
  if (new Set(scales).size !== scales.length) throw failure("Duplicate scales would collide");
  if (["psd", "svg", "html"].includes(format) && scales.some((s) => s !== 1)) throw failure("PSD, SVG and HTML export at their original size; choose scale 1");
  for (const key of ["dir", "path", "audio"]) if (q[key] !== undefined && (typeof q[key] !== "string" || !q[key] || q[key].includes("\0"))) throw failure(`${key} must be a nonempty path string`);
  if (q.path && q.dir) throw failure("Choose path or dir, not both");
  if (download && (q.path || q.dir)) throw failure("Downloads do not accept server destinations");
  const members: Member[] = [];
  for (const scale of scales) for (const c of comps.length ? comps : [undefined]) for (const a of format === "pdf" && allBoards ? [undefined] : boards.length ? boards : [undefined]) {
    const targets = format === "pdf" && allBoards ? boards : a ? [a] : [doc];
    for (const target of targets) {
      const w = Math.ceil(target.width * scale), h = Math.ceil(target.height * scale);
      if (![w, h].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 16384) || w * h > 64e6) throw failure("Requested export exceeds the 16384-side / 64 MP limit. Reduce scale.");
    }
    if (video) videoPlan(doc, { format, scale, fps: number(q, "fps", 1, 120, doc.animation?.fps ?? 24), duration: number(q, "duration", 0.001, 600, doc.animation ? doc.animation.duration / 1000 : 5), crf: number(q, "crf", 0, format === "webm" ? 63 : 51, format === "webm" ? 32 : 20) });
    if (format === "gif") {
      const fps = number(q, "fps", 1, 50, doc.animation?.fps ?? 12);
      for (const target of targets) {
        const p = videoPlan({ ...target, animation: doc.animation }, { scale, fps, ...(doc.animation ? {} : { duration: 1 / fps }) });
        if (fps > 50 || p.rasterWidth > 4096 || p.rasterHeight > 4096 || p.frames * p.rasterWidth * p.rasterHeight > 500e6) throw failure("GIF exceeds the 50 fps, 4096-pixel side or 500-million-pixel work budget");
      }
    }
    const suffix = scale === 1 ? "" : `@${scale}x`;
    const stem = `${safe(doc.name)}${c ? `-${safe(c.name)}` : ""}${a ? `-${safe(a.name)}` : ""}${allBoards || allComps ? "" : `-${doc.rev}`}${suffix}`;
    members.push({ name: filename(`${stem}.${ext}`), label: c?.name ?? a?.name ?? doc.name, scale, comp: c?.id, artboard: a?.id, ...(format === "pdf" && allBoards ? { pages: boards.map((b) => b.id) } : {}) });
    if (members.length > EXPORT_SET_LIMITS.files) throw failure("Export set exceeds the 64-file limit", 413);
  }
  if (new Set(members.map((m) => m.name.toLowerCase())).size !== members.length) throw failure("Export filenames collide after sanitizing names (case-insensitive)");
  if (q.path && members.length !== 1) throw failure("A multi-file set requires dir, not path");
  if (q.path) members[0].name = filename(basename(String(q.path)));
  return { members, format, quality, colors, dpi, download, directory: download ? undefined : resolve(q.path ? dirname(String(q.path)) : String(q.dir ?? exportsDir)), q };
}
type Plan = ReturnType<typeof planExportSet>;

async function write(file: string, bytes: Uint8Array | string) {
  const handle = await open(file, "wx");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function readBounded(file: string, maximum: number, signal: AbortSignal) {
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) throw failure(`Export transaction file exceeds its ${maximum}-byte read budget: ${file}`, 413);
    const bytes = Buffer.allocUnsafe(before.size); let offset = 0;
    while (offset < bytes.length) { check(signal); const part = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), null); if (!part.bytesRead) throw failure(`Export transaction file changed: ${file}`, 409); offset += part.bytesRead; }
    const extra = await handle.read(Buffer.allocUnsafe(1), 0, 1, null);
    if (extra.bytesRead) throw failure(`Export transaction file grew: ${file}`, 409);
    check(signal); return bytes;
  } finally { await handle.close(); }
}
async function fingerprint(file: string, signal: AbortSignal): Promise<Fingerprint | undefined> {
  let handle;
  try {
    const link = await lstat(file, { bigint: true });
    if (!link.isFile() || link.isSymbolicLink()) throw failure(`Destination is not a regular file: ${file}`);
    handle = await open(file, "r"); const before = await handle.stat({ bigint: true });
    if (identity(link) !== identity(before)) throw failure(`Destination changed: ${file}`, 409);
    if (before.size > BigInt(EXPORT_SET_LIMITS.perSetBytes)) throw failure(`Previous export exceeds the 256 MiB backup budget: ${file}`, 413);
    const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(64 * 1024); let bytes = 0;
    for (;;) { check(signal); const part = await handle.read(chunk, 0, chunk.length, null); if (!part.bytesRead) break; bytes += part.bytesRead; if (bytes > EXPORT_SET_LIMITS.perSetBytes) throw failure("Destination grew beyond backup budget", 413); hash.update(chunk.subarray(0, part.bytesRead)); }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes) !== before.size) throw failure(`Destination changed: ${file}`, 409);
    return { sha256: hash.digest("hex"), bytes, identity: identity(before) };
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  finally { await handle?.close(); }
}
function same(a?: Fingerprint, b?: Fingerprint) { return a?.identity === b?.identity && a?.sha256 === b?.sha256 && a?.bytes === b?.bytes; }

function variant(doc: AdDocument, member: Member, transparent: boolean) {
  const d = deepClone(doc);
  if (member.comp) applyOps(d, applyCompOps(d, comp(d, member.comp)));
  if (transparent) d.background = null;
  return d;
}
/** Crop non-raster formats without substituting another format or repeating the whole canvas. */
function crop(doc: AdDocument, ref: string) {
  const a = board(doc, ref), x = a.x, y = a.y;
  doc.width = a.width; doc.height = a.height; doc.layers = [a]; doc.background = null;
  for (const { layer } of walk(doc.layers)) { layer.x -= x; layer.y -= y; }
  if (doc.animation) for (const frames of Object.values(doc.animation.tracks)) for (const frame of frames) { if (frame.x !== undefined) frame.x -= x; if (frame.y !== undefined) frame.y -= y; }
  return doc;
}
async function renderMember(doc: AdDocument, member: Member, plan: Plan, assets: string): Promise<{ bytes: Buffer; info: FileResult }> {
  let d = variant(doc, member, yes(plan.q.transparent));
  const a = member.artboard ? board(d, member.artboard) : undefined;
  const region = a ? { region: { x: a.x, y: a.y, width: a.width, height: a.height }, rootLayerIds: [a.id] } : {};
  let bytes: Buffer, extra: Partial<FileResult> = {};
  const { format, quality, colors, dpi } = plan;
  if (member.pages) {
    const pages = []; let total = 0;
    for (const id of member.pages) {
      const ab = board(d, id);
      const jpeg = await renderToBuffer(d, assets, { format: "jpeg", quality, scale: member.scale, region: { x: ab.x, y: ab.y, width: ab.width, height: ab.height }, rootLayerIds: [id] });
      total += jpeg.length; if (total > EXPORT_SET_LIMITS.perSetBytes / 2) throw failure("PDF pages exceed the 128 MiB assembly budget", 413);
      pages.push({ jpeg, width: Math.ceil(ab.width * member.scale), height: Math.ceil(ab.height * member.scale), title: ab.name });
    }
    bytes = encodePdf(pages, dpi); extra.pages = pages.length;
  } else if (format === "mp4" || format === "webm") {
    const options = { format: format as "mp4" | "webm", scale: member.scale, fps: plan.q.fps === undefined ? undefined : Number(plan.q.fps), duration: plan.q.duration === undefined ? undefined : Number(plan.q.duration), crf: plan.q.crf === undefined ? undefined : Number(plan.q.crf), audioPath: resourceSnapshotContext.getStore()?.audioPath };
    bytes = await renderVideo(d, assets, options); const p = videoPlan(d, options); extra = { width: p.width, height: p.height, frames: p.frames, fps: p.fps, duration: p.duration };
  } else if (["gif", "psd", "svg", "html"].includes(format)) {
    if (member.artboard) d = crop(d, member.artboard);
    bytes = format === "gif" ? await renderGif(d, assets, { scale: member.scale, fps: plan.q.fps === undefined ? undefined : Number(plan.q.fps), maxColors: colors }) : format === "psd" ? await docToPsd(d, assets) : Buffer.from(format === "svg" ? await renderSvg(d, assets) : await renderHtmlBanner(d, assets));
    extra = { width: Math.ceil(d.width * member.scale), height: Math.ceil(d.height * member.scale) };
  } else {
    bytes = await renderToBuffer(d, assets, { format: format as ExportFormat, scale: member.scale, quality, colors, dpi, lossless: yes(plan.q.lossless), transparent: !!a || yes(plan.q.trim) || yes(plan.q.transparent), trim: yes(plan.q.trim), ...region });
    extra = { width: Math.ceil((a?.width ?? d.width) * member.scale), height: Math.ceil((a?.height ?? d.height) * member.scale) };
    if (yes(plan.q.trim)) {
      if (format === "bmp") extra = { width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) };
      else if (format === "tiff") extra = { width: bytes.readUInt32LE(18), height: bytes.readUInt32LE(30) };
      else if (format === "pdf") extra = { pages: 1 }; // PDF physical page sizes live in its MediaBox.
      else { const image = await loadImage(bytes); extra = { width: image.width, height: image.height }; }
    }
  }
  const mime = format === "pdf" ? "application/pdf" : format === "svg" ? "image/svg+xml" : format === "html" ? "text/html" : format === "psd" ? "image/vnd.adobe.photoshop" : format === "mp4" || format === "webm" ? `video/${format}` : format === "png8" ? "image/png" : `image/${format}`;
  return { bytes, info: { name: member.name, label: member.label, bytes: bytes.length, sha256: digest(bytes), mime, ...extra } };
}

type Transaction = { id: string; docId: string; revision: number; phase: string; directory?: string; bytes: number; completed: number; total: number; recovery?: unknown; controller: AbortController; done: Promise<void>; finish: () => void };
/** Process-local quotas plus an exclusive, cooperating-writer directory lock. No stale-lock stealing. */
export class ExportSetService {
  private live = new Map<string, Transaction>();
  private bytes = 0;
  private stopping = false;
  status() { return { limits: EXPORT_SET_LIMITS, bytes: this.bytes, live: [...this.live.values()].map(({ controller, done, finish, ...s }) => s) }; }
  async close() { this.stopping = true; const pending = [...this.live.values()]; for (const t of pending) t.controller.abort(failure("Export sets are shutting down", 503)); await Promise.all(pending.map((t) => t.done)); }
  async execute(doc: AdDocument, q: Query, exportsDir: string, assets: string, renderer: RenderService, signal = renderContext.getStore()) {
    const plan = planExportSet(doc, q, exportsDir);
    if (this.stopping) throw failure("Export sets are shutting down", 503);
    if (this.live.size >= EXPORT_SET_LIMITS.live) throw failure("Export sets are busy or awaiting recovery (limit two)", 429, this.status());
    let finish!: () => void;
    const t: Transaction = { id: randomUUID(), docId: doc.id, revision: doc.rev, phase: "validating", bytes: 0, completed: 0, total: plan.members.length, controller: new AbortController(), done: new Promise<void>((r) => { finish = r; }), finish: () => finish() };
    this.live.set(t.id, t);
    const abort = () => t.controller.abort(failure("Export set cancelled", 499)); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => t.controller.abort(failure("Export set exceeded its ten-minute deadline", 504)), EXPORT_SET_LIMITS.lifetimeMs);
    const activeSignal = t.controller.signal;
    const reserve = (n: number) => {
      if (t.bytes + n > EXPORT_SET_LIMITS.perSetBytes || (plan.download && t.bytes + n > EXPORT_SET_LIMITS.downloadBytes)) throw failure(`Export set exceeds its ${plan.download ? 128 : 256} MiB staged/backup budget`, 413);
      if (this.bytes + n > EXPORT_SET_LIMITS.bytes) throw failure("Export sets exceed the 512 MiB shared budget", 429);
      t.bytes += n; this.bytes += n;
    };
    const retire = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.bytes -= t.bytes; t.bytes = 0; this.live.delete(t.id); t.finish(); };
    let allocated = false, directoryIdentity = "", parentIdentity = "", parent = "", committed = false, retained = false;
    const files: FileResult[] = [], previous: (Fingerprint | undefined)[] = [], attempted: number[] = [];
    let resources!: SnapshotReport;
    const recovery = (cause: unknown, rollback?: unknown) => ({ transaction: t.id, committed, directory: t.directory,
      recoveryPaths: retained && t.directory ? [t.directory, join(t.directory, "journal.json"), join(t.directory, "backup"), join(t.directory, "new")].filter(existsSync) : [],
      files: files.map((f, i) => ({ ...f, target: plan.download ? undefined : join(parent, f.name), staged: t.directory ? join(t.directory, "new", String(i)) : undefined, backup: previous[i] && t.directory ? join(t.directory, "backup", String(i)) : undefined, previous: previous[i] })), cause: (cause as Error).message, rollback });
    const verifyOwnership = async () => {
      if (!t.directory || identity(await lstat(t.directory, { bigint: true })) !== directoryIdentity || JSON.parse((await readBounded(join(t.directory, "owner.json"), 4096, new AbortController().signal)).toString()).id !== t.id) throw failure("Export transaction directory ownership changed", 409);
      if (!plan.download && (await realpath(plan.directory!)) !== parent) throw failure("Export destination namespace changed", 409);
      if (!plan.download && identity(await lstat(parent, { bigint: true })) !== parentIdentity) throw failure("Export destination directory changed", 409);
    };
    const cleanup = async () => { if (allocated) { await verifyOwnership(); await rm(t.directory!, { recursive: true, force: false }); allocated = false; } };
    const journal = async () => {
      const file = join(t.directory!, "journal.json"), temp = join(t.directory!, `journal-${randomUUID()}.tmp`);
      try {
        await write(temp, JSON.stringify({ id: t.id, revision: doc.rev, resources, phase: t.phase, committed, members: files.map((f, i) => ({ ...f, target: plan.download ? undefined : join(parent, f.name), staged: join(t.directory!, "new", String(i)), backup: previous[i] ? join(t.directory!, "backup", String(i)) : undefined, previous: previous[i], attempted: attempted.includes(i) })) }, null, 2));
        await rename(temp, file);
      } finally { try { await unlink(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
    };
    try {
      check(activeSignal);
      if (plan.download) { t.directory = await mkdtemp(join(tmpdir(), "pictocity-export-set-")); allocated = true; }
      else {
        await mkdir(plan.directory!, { recursive: true }); parent = await realpath(plan.directory!); parentIdentity = identity(await lstat(parent, { bigint: true }));
        t.directory = join(parent, ".pictocity-export-set.lock");
        try { await mkdir(t.directory); allocated = true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw failure(`Export destination is owned by another set or needs recovery: ${t.directory}`, 409, { recoveryPaths: [t.directory] }); throw e; }
      }
      directoryIdentity = identity(await lstat(t.directory!, { bigint: true }));
      await write(join(t.directory!, "owner.json"), JSON.stringify({ id: t.id, pid: process.pid, created: new Date().toISOString() }));
      await mkdir(join(t.directory!, "new")); await mkdir(join(t.directory!, "backup"));
      if (!plan.download) {
        const names = await readdir(parent);
        for (const m of plan.members) if (names.some((n) => n !== m.name && n.toLowerCase() === m.name.toLowerCase())) throw failure(`Destination has a case-insensitive collision: ${m.name}`, 409);
        for (const m of plan.members) previous.push(await fingerprint(join(parent, m.name), activeSignal));
        if (previous.reduce((n, p) => n + (p?.bytes ?? 0), 0) > EXPORT_SET_LIMITS.perSetBytes) throw failure("Previous set exceeds the 256 MiB backup budget", 413);
      }
      t.phase = "capturing";
      await renderContext.run(activeSignal, () => renderer.withSnapshot(doc, assets, { audioSource: (plan.format === "mp4" || plan.format === "webm") && q.audio ? String(q.audio) : undefined }, async (report) => {
        resources = report;
        if (q.expectedResources !== undefined && q.expectedResources !== report.sha256) throw failure("Images or added fonts changed since the reviewed preflight. Refresh before exporting.", 409);
        for (const m of plan.members) {
          check(activeSignal); t.phase = "rendering";
          const rendered = await renderMember(doc, m, plan, assets);
          check(activeSignal); reserve(rendered.bytes.length); t.phase = "staging";
          await write(join(t.directory!, "new", String(files.length)), rendered.bytes);
          files.push(rendered.info); t.completed = files.length;
        }
        t.phase = "retiring resources";
      }, activeSignal)); // Every child closes before run resolves; snapshot removal MUST precede publication.
      check(activeSignal); await verifyOwnership();
      if (plan.download) {
        t.phase = "assembling download";
        const manifest = Buffer.from(JSON.stringify({ version: 1, resourceSnapshot: resources, files }));
        if (manifest.length > 64 * 1024) throw failure("Export-set manifest exceeds 64 KiB", 413);
        const size = 4 + manifest.length + files.reduce((n, f) => n + f.bytes, 0);
        if (size > EXPORT_SET_LIMITS.downloadBytes) throw failure("Download envelope exceeds 128 MiB", 413);
        // Allocate one bounded envelope, reading one member at a time; no separate retained set of buffers.
        const body = Buffer.allocUnsafe(size); body.writeUInt32BE(manifest.length); manifest.copy(body, 4); let offset = 4 + manifest.length;
        for (let i = 0; i < files.length; i++) { check(activeSignal); const bytes = await readBounded(join(t.directory!, "new", String(i)), files[i].bytes, activeSignal); if (bytes.length !== files[i].bytes || digest(bytes) !== files[i].sha256) throw failure("Staged download changed", 409); bytes.copy(body, offset); offset += bytes.length; }
        check(activeSignal); t.phase = "cleanup"; await cleanup(); check(activeSignal);
        // Retain admission/byte quota until the HTTP response finishes or is destroyed.
        this.bytes += size - t.bytes; t.bytes = size; t.phase = "sending";
        return { files, resourceSnapshot: resources, body, retire };
      }
      t.phase = "precommit";
      const currentNames = await readdir(parent);
      for (const m of plan.members) if (currentNames.some((n) => n !== m.name && n.toLowerCase() === m.name.toLowerCase())) throw failure(`Destination has a case-insensitive collision: ${m.name}`, 409);
      for (let i = 0; i < files.length; i++) {
        const target = join(parent, files[i].name), old = previous[i];
        if (!same(old, await fingerprint(target, activeSignal))) throw failure(`Destination changed while rendering: ${target}`, 409);
        if (old) {
          reserve(old.bytes); const bytes = await readBounded(target, old.bytes, activeSignal);
          if (digest(bytes) !== old.sha256) throw failure(`Destination changed before backup: ${target}`, 409);
          await write(join(t.directory!, "backup", String(i)), bytes);
        }
      }
      await journal();
      for (let i = 0; i < files.length; i++) {
        check(activeSignal); await verifyOwnership();
        if (!same(previous[i], await fingerprint(join(parent, files[i].name), activeSignal))) throw failure(`Destination changed before publication: ${files[i].name}`, 409);
        const staged = await fingerprint(join(t.directory!, "new", String(i)), activeSignal);
        if (staged?.sha256 !== files[i].sha256 || staged.bytes !== files[i].bytes) throw failure("Staged export changed before publication", 409);
      }
      t.phase = "publishing";
      for (let i = 0; i < files.length; i++) {
        check(activeSignal); await verifyOwnership();
        if (!same(previous[i], await fingerprint(join(parent, files[i].name), activeSignal))) throw failure(`Destination changed during publication: ${files[i].name}`, 409);
        attempted.push(i); await journal();
        await rename(join(t.directory!, "new", String(i)), join(parent, files[i].name));
      }
      check(activeSignal); t.phase = "commit ready"; await journal(); check(activeSignal); committed = true;
      for (const f of files) { f.path = join(parent, f.name); if (parent === await realpath(exportsDir)) f.url = `/exports/${encodeURIComponent(f.name)}`; }
      t.phase = "cleanup"; await cleanup(); retire();
      return { files, resourceSnapshot: resources };
    } catch (cause) {
      if (activeSignal.aborted && (cause as { status?: number }).status === 499 && (activeSignal.reason as { status?: number })?.status === 504) cause = activeSignal.reason;
      const rollback: { complete: boolean; errors: string[] } = { complete: true, errors: [] };
      if (attempted.length && !committed) {
        t.phase = "rolling back";
        for (const i of [...attempted].reverse()) try {
          await verifyOwnership();
          const target = join(parent, files[i].name), old = previous[i], current = await fingerprint(target, new AbortController().signal);
          if (same(current, old)) continue;
          if (current && current.sha256 !== files[i].sha256) throw new Error(`Target changed outside the transaction: ${target}`);
          if (old) {
            const backup = await fingerprint(join(t.directory!, "backup", String(i)), new AbortController().signal);
            if (backup?.sha256 !== old.sha256) throw new Error(`Recovery backup is missing or changed: ${target}`);
            await rename(join(t.directory!, "backup", String(i)), target);
          } else if (current) await unlink(target);
        } catch (e) { rollback.complete = false; rollback.errors.push((e as Error).message); }
      }
      if (!rollback.complete) { retained = true; t.phase = "recovery required"; }
      else try { t.phase = "cleanup"; await cleanup(); } catch (e) { retained = true; rollback.errors.push(`Cleanup failed: ${(e as Error).message}`); t.phase = "cleanup failed"; }
      if (retained) {
        t.recovery = { ...recovery(cause, rollback), ...((cause as { report?: object }).report ?? {}) }; clearTimeout(timer); signal?.removeEventListener("abort", abort); t.finish();
        throw failure(`Export set failed; ${committed ? "outputs were committed" : rollback.complete ? "previous outputs preserved" : "rollback incomplete"}. Recovery retained at ${t.directory}. ${(cause as Error).message}`, 500, t.recovery);
      }
      retire();
      if (committed) throw failure(`Exports were committed, but completion failed: ${(cause as Error).message}`, 500, recovery(cause, rollback));
      throw failure((cause as Error).message, (cause as { status?: number }).status ?? 500, { ...recovery(cause, rollback), ...((cause as { report?: object }).report ?? {}) });
    }
  }
}
