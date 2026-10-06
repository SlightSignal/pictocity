import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AdDocument } from "@pictocity/core";
import { assetFile, ResourceError, resourceReferences } from "./assets.js";

type FileRecord = { file: string; sha256: string; bytes: number };
export interface SnapshotReport {
  id: string; docId: string; revision: number; documentSha256: string; sha256: string; bundleSha256: string; bytes: number;
  assets: (FileRecord & { id: string })[]; fonts: FileRecord[]; audio?: FileRecord;
}
export interface ResourceSnapshot {
  assetsDir: string; fontsDir: string; audioPath?: string; report: SnapshotReport;
  release(): Promise<void>;
}
export const resourceSnapshotContext = new AsyncLocalStorage<ResourceSnapshot>();
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
const MAX_FILE = 64 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw failure("Export cancelled", 499); };
const fileIdentity = (value: { dev: bigint; ino: bigint }) => `${value.dev}:${value.ino}`;
const changed = () => failure("An export resource changed while the snapshot was prepared. Try exporting again.", 409);

/** Copies are private to a request/job, bounded across all live requests, and never hard links. */
export class SnapshotPool {
  private count = 0;
  private bytes = 0;
  private capturing = new Map<string, { docId: string; revision: number; completed: number; total: number }>();
  private cleanupTasks = new Map<string, () => Promise<void>>();
  private cleanupErrors = new Map<string, string>();
  constructor(readonly limits = { snapshots: 5, bytes: 512 * 1024 * 1024, perSnapshot: 256 * 1024 * 1024, files: 1024 }, private tempRoot = tmpdir(), private removeDirectory = (path: string) => rm(path, { recursive: true, force: true })) {}
  stats() { return { snapshots: this.count, bytes: this.bytes, limits: this.limits, capturing: [...this.capturing.values()], cleanupErrors: [...this.cleanupErrors.values()] }; }
  async cleanup() { await Promise.all([...this.cleanupTasks.values()].map((release) => release())); }
  async capture(doc: AdDocument, assetsDir: string, fontsDir: string, options: {
    audioSource?: string; signal?: AbortSignal; allowMissing?: boolean; allAssets?: boolean; onProgress?: (completed: number, total: number) => void;
  } = {}): Promise<ResourceSnapshot> {
    check(options.signal);
    if (this.count >= this.limits.snapshots) throw failure("Export resources are busy. Wait for a current export to finish.", 429);
    this.count++;
    const id = randomUUID();
    this.capturing.set(id, { docId: doc.id, revision: doc.rev, completed: 0, total: 0 });
    const progress = (completed: number, total: number) => { this.capturing.set(id, { docId: doc.id, revision: doc.rev, completed, total }); options.onProgress?.(completed, total); };
    let dir: string | undefined, bytes = 0, released = false, releaseTask: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (released) return Promise.resolve();
      if (releaseTask) return releaseTask;
      releaseTask = (async () => { try {
        if (dir) {
          // Only the exact directory allocated here can be recursively removed.
          const rel = relative(resolve(this.tempRoot), resolve(dir));
          if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Snapshot cleanup escaped its temporary root");
          await this.removeDirectory(dir);
        }
        this.bytes -= bytes; this.count--; released = true;
        this.capturing.delete(id); this.cleanupErrors.delete(id); this.cleanupTasks.delete(id);
      } catch (error) {
        // Retain quota and a retryable cleanup task if the filesystem cannot remove the bytes.
        const message = `Export resource cleanup failed; retained at ${dir ?? this.tempRoot}: ${(error as Error).message}`;
        this.capturing.delete(id); this.cleanupErrors.set(id, message);
        throw Object.assign(new Error(message), { status: 500, report: { resourceRecoveryPath: dir, snapshotId: id, retainedBytes: bytes } });
      } })();
      const task = releaseTask;
      void task.then(() => { releaseTask = undefined; }, () => { releaseTask = undefined; });
      return task;
    };
    this.cleanupTasks.set(id, release);
    const reserve = (size: number) => {
      if (bytes + size > this.limits.perSnapshot) throw failure("Export resources exceed the 256 MiB snapshot budget. Reduce the referenced images or added fonts.", 413);
      if (this.bytes + size > this.limits.bytes) throw failure("Current exports exceed the 512 MiB resource budget. Wait for another export to finish.", 429);
      bytes += size; this.bytes += size;
    };
    const copied = new Map<string, FileRecord>();
    const targets = new Map<string, string>();
    const sources: { resolveSource: () => string | Promise<string>; identity: string; record: FileRecord }[] = [];
    let completed = 0;
    try {
      dir = await mkdtemp(join(this.tempRoot, "pictocity-resources-"));
      const snapshotAssets = join(dir, "assets"), snapshotFonts = join(dir, "fonts");
      await mkdir(snapshotAssets); await mkdir(snapshotFonts); await mkdir(join(dir, "media"));
      const { refs } = resourceReferences(doc);
      if (options.allAssets) for (const asset of Object.values(doc.assets)) if (!refs.has(asset.id)) refs.set(asset.id, []);
      let fontNames: string[] = [];
      try { fontNames = (await readdir(fontsDir)).filter((f) => [".ttf", ".otf", ".woff", ".woff2"].includes(extname(f).toLowerCase())).sort(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const total = refs.size + fontNames.length + (options.audioSource ? 1 : 0);
      if (total > this.limits.files) throw failure("Export references too many resource files (limit 1024).", 413);
      progress(0, total);

      const read = async (source: string, target?: string, expectedIdentity?: string): Promise<{ record: FileRecord; identity: string }> => {
        const input = await open(source, "r"); let output: Awaited<ReturnType<typeof open>> | undefined;
        const digest = createHash("sha256"); let size = 0;
        try {
          const before = await input.stat({ bigint: true });
          if (expectedIdentity && fileIdentity(before) !== expectedIdentity) throw changed();
          if (!before.isFile()) throw new Error("Resource is not a regular file");
          if (before.size > BigInt(MAX_FILE)) throw failure("A resource exceeds the 64 MiB file budget.", 413);
          if (target) output = await open(target, "wx");
          const chunk = Buffer.allocUnsafe(64 * 1024);
          for (;;) {
            check(options.signal);
            const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            size += bytesRead;
            if (size > MAX_FILE) throw failure("A resource exceeds the 64 MiB file budget.", 413);
            if (target) reserve(bytesRead);
            const data = chunk.subarray(0, bytesRead); digest.update(data);
            if (output) {
              let written = 0;
              while (written < data.length) {
                const result = await output.write(data, written, data.length - written, null);
                if (!result.bytesWritten) throw new Error("Resource copy made no progress");
                written += result.bytesWritten;
              }
            }
          }
          const after = await input.stat({ bigint: true });
          if (BigInt(size) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw failure("An export resource changed while being copied. Try exporting again.", 409);
          if (!size) throw new Error("Resource is empty");
          return { record: { file: basename(target ?? source), sha256: digest.digest("hex"), bytes: size }, identity: fileIdentity(before) };
        } finally { try { await output?.close(); } finally { await input.close(); } }
      };
      const copy = async (source: string, target: string, resolveSource: () => string | Promise<string> = () => realpath(source)) => {
        // File identity handles aliases according to the actual filesystem, including
        // case-sensitive Windows directories. The document's namespace spelling stays intact.
        const identity = fileIdentity(await stat(source, { bigint: true })), key = identity + "\0" + dirname(target);
        let record = copied.get(key);
        if (!record) {
          const captured = await read(source, target, identity);
          record = captured.record; copied.set(key, record);
          targets.set(fileIdentity(await stat(target, { bigint: true })), key);
        } else {
          let existing: string | undefined;
          try { existing = fileIdentity(await stat(target, { bigint: true })); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (existing) { if (targets.get(existing) !== key) throw changed(); }
          else {
            reserve(record.bytes); await copyFile(join(dirname(target), record.file), target);
            targets.set(fileIdentity(await stat(target, { bigint: true })), key);
          }
        }
        // Validate every namespace alias, even when it reused another alias's private copy.
        sources.push({ resolveSource, identity, record });
        progress(++completed, total); return { ...record, file: basename(target) };
      };
      const assets: SnapshotReport["assets"] = [];
      for (const [id, layers] of refs) {
        const asset = doc.assets[id];
        try {
          if (!asset) throw new Error("No asset record exists");
          const src = asset.src, resolveSource = () => assetFile(assetsDir, src), source = resolveSource();
          // Keep the namespace filename (not a symlink target's filename) for legacy links.
          const name = asset.src.replace(/^\/?assets\//, "");
          const record = await copy(source, join(snapshotAssets, name), resolveSource);
          assets.push({ id, ...record, file: name });
        } catch (error) {
          if ((error as { status?: number }).status) throw error;
          if (options.allowMissing) continue; // The isolated preflight still reports every missing reference.
          throw new ResourceError({ ok: false, docId: doc.id, revision: doc.rev, fonts: [], assets: [], issues: [{
            code: asset ? "unreadable_asset" : "missing_asset_record", assetId: id, layerId: layers[0],
            message: `Image “${asset?.name ?? id}” cannot be copied for export: ${(error as Error).message}`,
          }] });
        }
      }
      const fonts: FileRecord[] = [];
      for (const name of fontNames) {
        const resolveSource = async () => {
          const sourceRoot = await realpath(fontsDir), source = await realpath(join(fontsDir, name));
          const rel = relative(sourceRoot, source);
          if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw failure("An added font resolves outside the font library.", 422);
          return source;
        };
        fonts.push({ ...await copy(await resolveSource(), join(snapshotFonts, name), resolveSource), file: name });
      }
      let audio: FileRecord | undefined, audioPath: string | undefined;
      if (options.audioSource) {
        audioPath = join(dir, "media/audio.bin");
        if (/^https?:\/\//i.test(options.audioSource)) {
          const response = await fetch(options.audioSource, { signal: options.signal });
          let output: Awaited<ReturnType<typeof open>> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          try {
            if (!response.ok || !response.body) throw failure(`Audio fetch failed (${response.status}).`, 400);
            output = await open(audioPath, "wx");
            const digest = createHash("sha256"); reader = response.body.getReader(); let size = 0;
            for (;;) {
              check(options.signal);
              const next = await reader.read(); if (next.done) break;
              const data = next.value;
              check(options.signal); size += data.byteLength;
              if (size > MAX_FILE) throw failure("Audio exceeds the 64 MiB file budget.", 413);
              reserve(data.byteLength); digest.update(data);
              let written = 0;
              while (written < data.byteLength) { const result = await output.write(data, written, data.byteLength - written, null); if (!result.bytesWritten) throw new Error("Audio copy made no progress"); written += result.bytesWritten; }
            }
            if (!size) throw failure("Audio is empty.", 422);
            audio = { file: "audio.bin", sha256: digest.digest("hex"), bytes: size };
          } finally {
            try {
              if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
              else await response.body?.cancel().catch(() => undefined);
            } finally { await output?.close(); }
          }
          progress(++completed, total);
        } else audio = await copy(resolve(options.audioSource), audioPath);
      }
      // Re-resolve every namespace after ALL copies, but hash each physical file only once.
      // Repeated document IDs must not multiply the bounded resource reads.
      const validated = new Map<string, FileRecord>();
      for (const { resolveSource, identity, record } of sources) {
        check(options.signal);
        let source: string;
        try {
          source = await resolveSource();
          if (fileIdentity(await stat(source, { bigint: true })) !== identity) throw changed();
        } catch { throw changed(); }
        let current = validated.get(identity);
        if (!current) { current = (await read(source, undefined, identity)).record; validated.set(identity, current); }
        if (current.sha256 !== record.sha256 || current.bytes !== record.bytes) throw changed();
      }
      check(options.signal);
      const identity = { docId: doc.id, revision: doc.rev, documentSha256: hash(JSON.stringify(doc)), assets, fonts };
      // The preflight fingerprint remains usable when an export adds optional audio.
      // The complete bundle fingerprint separately includes the captured audio bytes.
      const bundle = { ...identity, ...(audio ? { audio } : {}) };
      const report: SnapshotReport = { id, ...bundle, sha256: hash(JSON.stringify(identity)), bundleSha256: hash(JSON.stringify(bundle)), bytes };
      this.capturing.delete(id);
      return { assetsDir: snapshotAssets, fontsDir: snapshotFonts, audioPath, report, release };
    } catch (error) { await release(); throw error; }
  }
}
