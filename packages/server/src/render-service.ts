import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import type { AdDocument } from "@pictocity/core";
import type * as Renderer from "./node-env.js";
import type { ResourceReport } from "./assets.js";
import { SnapshotPool, resourceSnapshotContext, type ResourceSnapshot, type SnapshotReport } from "./resource-snapshot.js";

export const renderContext = new AsyncLocalStorage<AbortSignal>();
type Kind = "raster" | "video" | "gif" | "html" | "psd" | "svg" | "preflight";
type Options = Record<string, unknown>;
interface Job {
  id: number; doc: AdDocument; assetsDir: string; kind: Kind; options: Options;
  status: { id: number; docId: string; revision: number; kind: Kind; phase: string; completed: number; total: number };
  resolve: (value: unknown) => void; reject: (error: Error) => void;
  signal?: AbortSignal; abort?: () => void; child?: ChildProcess;
  timer?: ReturnType<typeof setTimeout>; forceTimer?: ReturnType<typeof setTimeout>;
  encoderPid?: number; settled?: boolean; cancellation?: Error;
  preparing: Promise<ResourceSnapshot>; snapshot?: ResourceSnapshot; ownsSnapshot: boolean; captureController: AbortController;
  cleanupDone: Promise<void>; cleanupResolved: () => void;
}
const errorWithStatus = (message: string, status: number) => Object.assign(new Error(message), { status });

/** One isolated native renderer, at most four queued immutable document snapshots. */
export class RenderService {
  private queue: Job[] = [];
  // Queue membership ends before preparation/cleanup does (for example on cancellation).
  private unfinished = new Set<Job>();
  private active?: Job;
  private sequence = 0;
  private stopping = false;
  private scopes = new Map<AbortController, Promise<void>>();
  constructor(private fontsDir: string, private entry = new URL("./render-process.js", import.meta.url), private timeoutMs = 180_000, private snapshots = new SnapshotPool()) {}
  status() { return { active: this.active?.status ?? null, queued: this.queue.map((j) => j.status), capacity: 4, resources: this.snapshots.stats() }; }
  async withSnapshot<T>(doc: AdDocument, assetsDir: string, options: { audioSource?: string; allAssets?: boolean }, action: (report: SnapshotReport) => Promise<T>, signal = renderContext.getStore()): Promise<T> {
    if (this.stopping) throw errorWithStatus("Renderer is shutting down", 503);
    if (Buffer.byteLength(JSON.stringify(doc)) > 16 * 1024 * 1024) throw errorWithStatus("Document exceeds the 16 MiB render snapshot budget", 413);
    const controller = new AbortController(), abort = () => controller.abort();
    let scopeResolved!: () => void;
    this.scopes.set(controller, new Promise<void>((resolve) => { scopeResolved = resolve; }));
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    let expired = false;
    const timer = setTimeout(() => { expired = true; abort(); }, this.timeoutMs);
    let snapshot: ResourceSnapshot | undefined;
    try {
      snapshot = await this.snapshots.capture(structuredClone(doc), assetsDir, this.fontsDir, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return await resourceSnapshotContext.run(snapshot, () => action(snapshot!.report));
    } catch (error) {
      if (expired) throw errorWithStatus("Export resource preparation timed out", 504);
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      try { await snapshot?.release(); } finally { this.scopes.delete(controller); scopeResolved(); }
    }
  }
  run(kind: Kind, doc: AdDocument, assetsDir: string, options: Options = {}, signal = renderContext.getStore()): Promise<unknown> {
    if (this.stopping) return Promise.reject(errorWithStatus("Renderer is shutting down", 503));
    if (signal?.aborted) return Promise.reject(errorWithStatus("Export cancelled", 499));
    if (this.active && this.queue.length >= 4) return Promise.reject(errorWithStatus("Export queue is full. Wait for a current export to finish.", 429));
    if (Buffer.byteLength(JSON.stringify(doc)) > 16 * 1024 * 1024) return Promise.reject(errorWithStatus("Document exceeds the 16 MiB render snapshot budget", 413));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const frozenDoc = structuredClone(doc), frozenOptions = structuredClone(options), captureController = new AbortController();
      const shared = resourceSnapshotContext.getStore();
      let job: Job;
      const preparing = shared ? Promise.resolve(shared) : this.snapshots.capture(frozenDoc, assetsDir, this.fontsDir, {
        audioSource: typeof frozenOptions.audioPath === "string" ? frozenOptions.audioPath : undefined,
        signal: captureController.signal, allowMissing: kind === "preflight", onProgress: (completed, total) => { if (job && !job.child && !job.cancellation) { job.status.completed = completed; job.status.total = total; } },
      });
      let cleanupResolved!: () => void;
      const cleanupDone = new Promise<void>((resolve) => { cleanupResolved = resolve; });
      job = { id, doc: frozenDoc, assetsDir, options: frozenOptions, kind, signal, resolve, reject, preparing, ownsSnapshot: !shared, captureController, cleanupDone, cleanupResolved,
        status: { id, docId: doc.id, revision: doc.rev, kind, phase: "queued", completed: 0, total: 0 } };
      this.unfinished.add(job);
      // Observe failures even for a queued capture; it must not become an unhandled rejection.
      void preparing.catch((error) => this.finish(job, undefined, error));
      job.abort = () => this.cancel(job, errorWithStatus("Export cancelled", 499));
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job); job.timer = setTimeout(() => this.cancel(job, errorWithStatus("Export timed out", 504)), this.timeoutMs);
      if (signal?.aborted) job.abort(); this.pump();
    });
  }
  private async finish(job: Job, value?: unknown, error?: Error) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer); clearTimeout(job.forceTimer);
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
    this.queue = this.queue.filter((j) => j !== job);
    try { const snapshot = await job.preparing; if (job.ownsSnapshot) await snapshot.release(); }
    catch (cleanupError) { error ??= cleanupError as Error; }
    if (this.active === job) this.active = undefined;
    if (error || job.cancellation) job.reject(error ?? job.cancellation!); else job.resolve(value);
    job.cleanupResolved();
    this.unfinished.delete(job);
    this.pump();
  }
  private cancel(job: Job, error: Error) {
    if (job.settled || job.cancellation) return;
    job.cancellation = error;
    job.captureController.abort();
    if (!job.child) { this.finish(job, undefined, error); return; }
    job.status.phase = "cancelling";
    if (job.child.connected) job.child.send({ cancel: true }, () => undefined);
    // Cooperative cancellation normally closes FFmpeg and temp files. A stuck native call gets a bounded fallback.
    job.forceTimer = setTimeout(() => { this.killEncoder(job); job.child?.kill(); }, 10_000);
  }
  private killEncoder(job: Job) {
    if (job.encoderPid) { try { process.kill(job.encoderPid); } catch { /* encoder has already exited */ } job.encoderPid = undefined; }
  }
  private pump() {
    if (this.active || this.stopping) return;
    const job = this.queue.shift(); if (!job) return;
    this.active = job; job.status.phase = "capturing";
    void job.preparing.then((snapshot) => {
      job.snapshot = snapshot;
      if (!job.settled && !job.cancellation) this.start(job);
    }, (error) => this.finish(job, undefined, error));
  }
  private start(job: Job) {
    job.status.phase = "starting"; job.status.completed = 0; job.status.total = 0;
    try {
      const child = spawn(process.execPath, [fileURLToPath(this.entry)], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true, serialization: "advanced" });
      job.child = child; let result: unknown, failure: Error | undefined, received = false, stderr = "";
      child.stdout?.resume(); child.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-65536); });
      child.on("message", (raw) => {
        const message = raw as { phase?: string; completed?: number; total?: number; encoder?: number | null; done?: boolean; value?: unknown; error?: { message: string; status?: number; report?: ResourceReport } };
        if (message.phase) job.status.phase = job.cancellation ? "cancelling" : message.phase;
        if (message.completed !== undefined) { job.status.completed = message.completed; job.status.total = message.total ?? 0; }
        if (message.encoder !== undefined) job.encoderPid = message.encoder ?? undefined;
        if (message.done) { received = true; result = message.value; if (message.error) failure = Object.assign(new Error(message.error.message), { status: message.error.status ?? 500, report: message.error.report }); }
      });
      child.once("error", (error) => { failure = error; if (!child.pid) this.finish(job, undefined, error); });
      child.once("close", (code) => {
        this.killEncoder(job);
        if (!received && !failure && !job.cancellation) failure = new Error(`Renderer exited before completing (${code}): ${stderr.slice(-4000)}`);
        this.finish(job, result, failure);
      });
      child.send({ kind: job.kind, doc: job.doc, assetsDir: job.snapshot!.assetsDir, fontsDir: job.snapshot!.fontsDir,
        snapshotReport: job.snapshot!.report, options: { ...job.options, ...(job.snapshot!.audioPath ? { audioPath: job.snapshot!.audioPath } : {}) } }, (error) => { if (error) this.cancel(job, error); });
    } catch (error) { this.finish(job, undefined, error as Error); }
  }
  async close() {
    this.stopping = true;
    const scopeWork = [...this.scopes.values()]; for (const controller of this.scopes.keys()) controller.abort();
    const jobs = [...this.unfinished];
    for (const job of jobs) this.cancel(job, errorWithStatus("Renderer is shutting down", 503));
    await Promise.all([...jobs.map((job) => job.cleanupDone), ...scopeWork]);
    await this.snapshots.cleanup();
  }
}

let service: RenderService;
export function configureRenderService(fontsDir: string) { service = new RenderService(fontsDir); return service; }
const call = async (kind: Kind, doc: AdDocument, assetsDir: string, options: Options = {}, signal?: AbortSignal) => {
  if (!service) throw new Error("Renderer has not been configured");
  return service.run(kind, doc, assetsDir, options, signal ?? renderContext.getStore());
};
export async function preflightDocument(doc: AdDocument, assetsDir: string) { return await call("preflight", doc, assetsDir) as ResourceReport; }
export async function renderToBuffer(doc: AdDocument, assetsDir: string, options: Parameters<typeof Renderer.renderToBuffer>[2] = {}) { return Buffer.from(await call("raster", doc, assetsDir, options) as Uint8Array); }
export async function renderVideo(doc: AdDocument, assetsDir: string, options: Parameters<typeof Renderer.renderVideo>[2] = {}) { const { signal, onProgress, onEncoder, ...serializable } = options; return Buffer.from(await call("video", doc, assetsDir, serializable, signal) as Uint8Array); }
export async function renderGif(doc: AdDocument, assetsDir: string, options: Parameters<typeof Renderer.renderGif>[2] = {}) { const { signal, ...serializable } = options; return Buffer.from(await call("gif", doc, assetsDir, serializable, signal) as Uint8Array); }
export async function renderHtmlBanner(doc: AdDocument, assetsDir: string) { return await call("html", doc, assetsDir) as string; }
export async function docToPsd(doc: AdDocument, assetsDir: string) { return Buffer.from(await call("psd", doc, assetsDir) as Uint8Array); }
export async function renderSvg(doc: AdDocument, assetsDir: string) { return await call("svg", doc, assetsDir) as string; }
