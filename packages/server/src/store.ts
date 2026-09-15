import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AdDocument, AppliedOps, Op, OpEnvelope } from "@pictocity/core";
import { applyOps, createDocument, findLayer, nowIso, OpError, linkedPropagationOps } from "@pictocity/core";

export class DocStore {
  private docs = new Map<string, AdDocument>();
  private history = new Map<string, AppliedOps[]>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<(applied: AppliedOps) => void>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const doc = JSON.parse(readFileSync(join(dir, f), "utf8")) as AdDocument;
        this.docs.set(doc.id, doc);
        this.history.set(doc.id, this.loadHistory(doc.id));
      } catch (e) { console.warn(`skipping ${f}: ${(e as Error).message}`); }
    }
  }

  /** Reload the tail of the persisted history so revert and the History panel survive restarts. */
  private loadHistory(id: string): AppliedOps[] {
    const p = join(this.dir, id + ".history.jsonl");
    if (!existsSync(p)) return [];
    const all = readFileSync(p, "utf8").split("\n").filter(Boolean);
    // Rotate: keep the log from growing without bound (the document itself is the source of truth).
    if (all.length > 2000) writeFileSync(p, all.slice(-1500).join("\n") + "\n");
    const lines = all.slice(-500);
    const out: AppliedOps[] = [];
    for (const line of lines) { try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ } }
    return out;
  }

  onApplied(fn: (applied: AppliedOps) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  list() {
    return [...this.docs.values()].map((d) => ({ id: d.id, name: d.name, width: d.width, height: d.height, rev: d.rev, updatedAt: d.updatedAt, layers: d.layers.length }));
  }

  get(id: string): AdDocument | undefined { return this.docs.get(id); }
  all(): AdDocument[] { return [...this.docs.values()]; }

  create(init: Parameters<typeof createDocument>[0]): AdDocument {
    const doc = createDocument(init);
    this.docs.set(doc.id, doc);
    this.history.set(doc.id, []);
    this.save(doc.id);
    return doc;
  }

  /** Replace a whole document (used by import). */
  put(doc: AdDocument) {
    this.docs.set(doc.id, doc);
    if (!this.history.has(doc.id)) this.history.set(doc.id, []);
    this.save(doc.id);
  }

  delete(id: string): boolean {
    if (!this.docs.delete(id)) return false;
    this.history.delete(id);
    for (const suffix of [".json", ".history.jsonl"]) { const p = join(this.dir, id + suffix); if (existsSync(p)) unlinkSync(p); }
    return true;
  }

  apply(envelope: OpEnvelope): AppliedOps {
    const doc = this.docs.get(envelope.docId);
    if (!doc) throw new OpError(`Document ${envelope.docId} not found`);
    this.checkLocks(doc, envelope.ops);
    // Linked layers: content edits fan out to their siblings inside the same applied change (and the same undo).
    const ops = [...envelope.ops, ...linkedPropagationOps(doc, envelope.ops)];
    envelope = { ...envelope, ops };
    const inverse = applyOps(doc, ops);
    doc.rev += 1;
    const applied: AppliedOps = { ...envelope, rev: doc.rev, inverse, at: nowIso() };
    const h = this.history.get(doc.id)!;
    h.push(applied);
    if (h.length > 500) h.splice(0, h.length - 500);
    appendFileSync(join(this.dir, doc.id + ".history.jsonl"), JSON.stringify(applied) + "\n");
    this.save(doc.id);
    for (const fn of this.listeners) fn(applied);
    return applied;
  }

  historySince(id: string, rev: number): AppliedOps[] {
    return (this.history.get(id) ?? []).filter((a) => a.rev > rev);
  }

  /** Locked layers cannot be moved, edited or deleted by anyone until unlocked - same as Photoshop. */
  private checkLocks(doc: AdDocument, ops: Op[]) {
    for (const op of ops) {
      if (op.type === "layer.set") {
        const l = findLayer(doc, op.id);
        const keys = Object.keys(op.props);
        if (l?.locked && !(keys.length === 1 && keys[0] === "locked")) throw new OpError(`Layer "${l.name}" is locked`);
      } else if (op.type === "layer.remove" || op.type === "layer.move" || op.type === "layer.push" || op.type === "layer.splice") {
        const l = findLayer(doc, op.id);
        if (l?.locked) throw new OpError(`Layer "${l.name}" is locked`);
      }
    }
  }

  /** Write every pending document now (shutdown). */
  flush() {
    for (const [id, timer] of this.saveTimers) { clearTimeout(timer); const doc = this.docs.get(id); if (doc) { const file = join(this.dir, id + ".json"); writeFileSync(file + ".tmp", JSON.stringify(doc, null, 2)); renameSync(file + ".tmp", file); } }
    this.saveTimers.clear();
  }

  private save(id: string) {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.set(id, setTimeout(() => {
      const doc = this.docs.get(id);
      if (doc) { const file = join(this.dir, id + ".json"); writeFileSync(file + ".tmp", JSON.stringify(doc, null, 2)); renameSync(file + ".tmp", file); } // atomic: a crash mid-write can't corrupt the document
    }, 150));
  }
}
