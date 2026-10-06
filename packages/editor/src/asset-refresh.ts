import type { AdDocument } from "@pictocity/core";
import { walk } from "@pictocity/core";

export interface AssetCheck {
  ok: boolean; docId: string; revision: number;
  issues: { message: string; assetId?: string }[];
  assets: { id: string; sha256: string }[];
  resourceSnapshot?: { sha256: string };
}
type Entry<T> = { src: string; sha256?: string; value?: T; state: "unchecked" | "loading" | "ready" | "error"; message?: string };
type Dependencies<T> = {
  check(doc: AdDocument, signal: AbortSignal): Promise<AssetCheck>;
  load(doc: AdDocument, id: string, sha256: string, signal: AbortSignal): Promise<T>;
  dispose(value: T): void;
  changed(pixelsChanged: boolean): void;
};

/** Includes hidden images, masks and patterns. No content hashing occurs in this traversal. */
function sources(doc: AdDocument) {
  const ids = new Set<string>();
  for (const { layer } of walk(doc.layers)) {
    if (layer.type === "image") ids.add(layer.assetId);
    if (layer.mask?.kind === "raster") ids.add(layer.mask.assetId);
    if (layer.styles?.patternOverlay?.enabled) ids.add(layer.styles.patternOverlay.assetId);
    if (layer.type === "fill" && layer.fill.kind === "pattern") ids.add(layer.fill.assetId);
  }
  return new Map([...ids].sort().map((id) => [id, doc.assets[id]?.src ?? ""]));
}
const aborted = () => new DOMException("Image refresh cancelled", "AbortError");
/** A timeout or lifecycle cancellation also settles callers when a transport ignores abort. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    if (signal.aborted) { void promise.catch(() => undefined); reject(aborted()); return; }
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** One coalesced preflight, followed by sequential changed-image loads; no polling. */
export class AssetRefresh<T> {
  private doc: AdDocument | null = null;
  private signature = "";
  private epoch = 0;
  private active = false;
  private entries = new Map<string, Entry<T>>();
  private scheduled?: ReturnType<typeof setTimeout>;
  private pending?: { controller: AbortController; promise: Promise<AssetCheck | null> };
  private checkError?: string;
  constructor(private deps: Dependencies<T>, private timeoutMs = 30_000, private debounceMs = 250) {}

  syncDocument(doc: AdDocument | null) {
    const refs = doc ? sources(doc) : new Map<string, string>();
    const signature = JSON.stringify([...refs]);
    const switched = doc?.id !== this.doc?.id;
    const changed = switched || signature !== this.signature;
    const revisionChanged = doc?.rev !== this.doc?.rev;
    const wasChecking = !!this.pending || !!this.scheduled;
    if (changed || revisionChanged) this.cancel();
    if (switched) { this.dropAll(); this.checkError = undefined; }
    this.doc = doc; this.signature = signature;
    let pixelsChanged = switched;
    for (const [id, entry] of this.entries) {
      if (!refs.has(id) || refs.get(id) !== entry.src) { this.drop(entry); this.entries.delete(id); pixelsChanged = true; }
    }
    for (const [id, src] of refs) if (!this.entries.has(id)) {
      this.entries.set(id, { src, state: src ? "unchecked" : "error", message: src ? undefined : `Image ${id} has no asset record.` });
      pixelsChanged = true;
    }
    if (pixelsChanged) this.deps.changed(true);
    if (changed || (revisionChanged && wasChecking)) this.schedule();
  }

  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (active) this.schedule(); else this.cancel();
    this.deps.changed(true);
  }

  schedule() {
    if (!this.active || !this.doc || this.pending || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.refresh(); }, this.debounceMs);
    this.deps.changed(false);
  }

  refresh(): Promise<AssetCheck | null> {
    if (!this.active || !this.doc) return Promise.resolve(null);
    if (this.pending) return this.pending.promise;
    clearTimeout(this.scheduled); this.scheduled = undefined;
    const doc = this.doc, epoch = this.epoch, controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, this.timeoutMs);
    const current = () => this.active && this.epoch === epoch && !controller.signal.aborted;
    this.checkError = undefined;
    // Start on a microtask so pending is installed before any completion or cancellation.
    const promise = Promise.resolve().then(async () => {
      try {
        if (!current()) return null;
        const report = await abortable(this.deps.check(doc, controller.signal), controller.signal);
        if (!current()) return null;
        if (report.docId !== doc.id || report.revision !== doc.rev) throw new Error("Project changed while images were checked. Refresh images again.");
        const checked = new Map(report.assets.map((asset) => [asset.id, asset.sha256]));
        const loads: [string, Entry<T>][] = [];
        let pixelsChanged = false;
        for (const [id, entry] of this.entries) {
          const sha256 = checked.get(id);
          if (!sha256) {
            this.drop(entry); entry.sha256 = undefined; entry.state = "error";
            entry.message = report.issues.find((issue) => issue.assetId === id)?.message ?? `Image ${id} was not available in the resource check.`;
            pixelsChanged = true;
          } else if (entry.sha256 !== sha256 || entry.state !== "ready") {
            this.drop(entry); entry.sha256 = sha256; entry.state = "loading"; entry.message = undefined;
            loads.push([id, entry]); pixelsChanged = true;
          }
        }
        // Remove old pixels immediately, before a replacement is decoded.
        this.deps.changed(pixelsChanged);
        for (const [id, entry] of loads) {
          if (!current()) return null;
          const load = this.deps.load(doc, id, entry.sha256!, controller.signal).then((value) => {
            if (!current() || this.entries.get(id) !== entry) { this.deps.dispose(value); return; }
            entry.value = value; entry.state = "ready"; this.deps.changed(true);
          }, (error: Error) => {
            if (!current() || this.entries.get(id) !== entry) return;
            entry.state = "error"; entry.message = `Image ${doc.assets[id]?.name ?? id} could not be refreshed: ${error.message}`;
            this.deps.changed(true);
          });
          await abortable(load, controller.signal);
        }
        return current() ? report : null;
      } catch (error) {
        if (this.epoch === epoch && this.active && (!controller.signal.aborted || expired)) {
          this.checkError = expired ? "Image check timed out. Refresh images to retry." : `Images could not be checked: ${(error as Error).message}`;
          // A failed check is not evidence that previously displayed pixels are still current.
          for (const entry of this.entries.values()) { this.drop(entry); entry.state = "unchecked"; }
          this.deps.changed(true);
        }
        return null;
      } finally {
        clearTimeout(timer);
        if (this.pending?.controller === controller) { this.pending = undefined; this.deps.changed(false); }
      }
    });
    this.pending = { controller, promise }; this.deps.changed(false);
    return promise;
  }

  getImage(id: string): T | null { const entry = this.entries.get(id); return this.active && entry?.state === "ready" ? entry.value ?? null : null; }
  status() {
    const issues = this.checkError ? [this.checkError] : [...this.entries].filter(([, entry]) => entry.state === "error").map(([, entry]) => entry.message!);
    return { checking: !!this.pending || !!this.scheduled, paused: !this.active, pendingImages: [...this.entries.values()].some((entry) => entry.state === "unchecked" || entry.state === "loading"), issues };
  }
  private drop(entry: Entry<T>) { if (entry.value !== undefined) this.deps.dispose(entry.value); entry.value = undefined; }
  private dropAll() { this.entries.forEach((entry) => this.drop(entry)); this.entries.clear(); }
  private cancel() {
    this.epoch++; clearTimeout(this.scheduled); this.scheduled = undefined;
    this.pending?.controller.abort(); this.pending = undefined;
    for (const entry of this.entries.values()) if (entry.state === "loading") entry.state = "unchecked";
  }
}
