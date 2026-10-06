import { existsSync, mkdirSync, readdirSync, unlinkSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { join } from "node:path";
import type { AdDocument, AppliedOps, Op, OpEnvelope } from "@pictocity/core";
import { applyOps, createDocument, findLayer, findParent, deepClone, nowIso, OpError, linkedPropagationOps, isGroup, walk, BLEND_MODES, MAX_DIMENSION, normalizeLayer } from "@pictocity/core";
import { atomicWrite, durableAppend, preserveForRecovery } from "./atomic-file.js";

// Conservative admission limits, not promises about V8 heap use. Oversize files stay untouched.
const MAX_FILE_BYTES = 64 * 1024 * 1024, MAX_LIBRARY_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 100_000, MAX_DEPTH = 128;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const timestamp = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
function requireState(ok: unknown, message: string): asserts ok { if (!ok) throw new OpError(message); }
function safeId(v: unknown): v is string {
  return typeof v === "string" && !!v && v !== "." && v !== ".." && !/[\\/\x00-\x1f<>:"|?*]/.test(v) && !/[. ]$/.test(v) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v);
}
function readBounded(file: string, limit = MAX_FILE_BYTES): Buffer {
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd); requireState(stat.isFile(), `Not a regular file: ${file}`);
    requireState(stat.size <= limit, `Recovery byte limit ${limit} exceeded: ${file} (${stat.size})`);
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); requireState(n > 0, `File changed or read made no progress: ${file}`); offset += n; }
    requireState(fstatSync(fd).size === bytes.length, `File size changed during recovery: ${file}`);
    return bytes;
  } finally { closeSync(fd); }
}
function json(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
function boundedShape(value: unknown) {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    requireState(item.depth <= MAX_DEPTH && ++nodes <= 1_000_000, "Recovery structure limit exceeded (depth 128 / 1000000 values)");
    if (typeof item.value === "number") requireState(finite(item.value), "Non-finite persisted number");
    if (item.value && typeof item.value === "object") for (const [key, child] of Object.entries(item.value)) {
      requireState(!["__proto__", "constructor", "prototype"].includes(key), `Unsafe persisted key ${key}`);
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}
function validateAsset(a: unknown, legacySnapshot = false) {
  // Old snapshot imports may omit descriptive name/mime; source identity and
  // geometry remain mandatory. New asset.add records still require both fields.
  requireState(object(a) && typeof a.id === "string" && !!a.id && (typeof a.name === "string" || (legacySnapshot && a.name === undefined)) && typeof a.src === "string" && (typeof a.mime === "string" || (legacySnapshot && a.mime === undefined)) && finite(a.width) && a.width > 0 && finite(a.height) && a.height > 0, "Invalid asset shape");
}
function validateStrokes(strokes: unknown) {
  requireState(Array.isArray(strokes), "Invalid brush strokes");
  for (const s of strokes) requireState(object(s) && Array.isArray(s.points) && s.points.length % 2 === 0 && s.points.every(finite) && finite(s.size) && s.size > 0 && typeof s.color === "string" && finite(s.opacity) && finite(s.hardness), "Invalid brush stroke");
}
function validateLayerProps(p: Record<string, any>) {
  for (const k of ["x", "y", "width", "height", "rotation", "scaleX", "scaleY", "opacity", "fontSize", "lineHeight", "letterSpacing", "strokeWidth"]) if (k in p) requireState(finite(p[k]), `Invalid layer property ${k}`);
  for (const k of ["name", "text", "fontFamily", "color", "assetId"]) if (k in p) requireState(typeof p[k] === "string", `Invalid layer property ${k}`);
  for (const k of ["visible", "locked", "wrap"]) if (k in p) requireState(typeof p[k] === "boolean", `Invalid layer property ${k}`);
  if ("blend" in p) requireState(BLEND_MODES.includes(p.blend), "Invalid layer blend");
  if ("strokes" in p) validateStrokes(p.strokes);
}
function validateAddedLayer(raw: unknown) {
  requireState(object(raw) && typeof raw.id === "string" && !!raw.id, "Added layer requires a stable identity");
  const pending = [raw];
  while (pending.length) {
    const l = pending.pop()!; validateLayerProps(l);
    if (l.type === "group" && l.children !== undefined) { requireState(Array.isArray(l.children), "Invalid added group children"); for (const c of l.children) { requireState(object(c) && typeof c.id === "string" && !!c.id, "Invalid added child identity"); pending.push(c); } }
  }
  // Legacy layer.add records may omit defaults that the production core supplied deterministically.
  validateLayers([normalizeLayer(raw)]);
}
function validateLayers(layers: unknown) {
  requireState(Array.isArray(layers), "layers/children must be arrays"); const ids = new Set<string>(); const pending = [...layers];
  while (pending.length) {
    const l = pending.pop(); requireState(object(l), "Invalid layer");
    requireState(typeof l.id === "string" && !!l.id && !ids.has(l.id), "Missing or duplicate layer identity"); ids.add(l.id);
    requireState(typeof l.name === "string" && typeof l.visible === "boolean" && typeof l.locked === "boolean" && BLEND_MODES.includes(l.blend), "Invalid layer base shape");
    for (const k of ["x", "y", "width", "height", "rotation", "scaleX", "scaleY", "opacity"]) requireState(finite(l[k]), `Invalid layer ${k}`);
    requireState(l.width > 0 && l.height > 0 && l.opacity >= 0 && l.opacity <= 1, "Invalid layer dimensions/opacity");
    switch (l.type) {
      case "group": requireState(Array.isArray(l.children), "Invalid group children"); for (const c of l.children) pending.push(c); break;
      // Legacy imports omitted wrap; the renderer already treats absent wrap as
      // unwrapped. Preserve those bytes/semantics, never normalize to wrap=true.
      case "text": requireState(typeof l.text === "string" && typeof l.fontFamily === "string" && typeof l.color === "string" && finite(l.fontSize) && l.fontSize > 0 && finite(l.lineHeight) && finite(l.letterSpacing) && (l.wrap === undefined || typeof l.wrap === "boolean") && ["left", "center", "right", "justify"].includes(l.align) && ["top", "middle", "bottom"].includes(l.verticalAlign), "Invalid text layer"); break;
      case "shape": requireState(["rect", "ellipse", "line", "polygon", "star", "path"].includes(l.shape) && (l.fill === null || typeof l.fill === "string") && finite(l.strokeWidth) && l.strokeWidth >= 0, "Invalid shape layer"); break;
      case "image": requireState(typeof l.assetId === "string" && ["fill", "contain", "cover"].includes(l.fit), "Invalid image layer"); break;
      case "fill": requireState(object(l.fill) && ["solid", "linear", "radial", "pattern", "gradient"].includes(l.fill.kind), "Invalid fill layer");
        if (l.fill.kind === "solid") requireState(typeof l.fill.color === "string", "Invalid solid fill");
        if (l.fill.kind === "linear" || l.fill.kind === "radial") requireState(typeof l.fill.from === "string" && typeof l.fill.to === "string", "Invalid gradient colors");
        if (l.fill.kind === "linear") requireState(finite(l.fill.angle), "Invalid gradient angle");
        if (l.fill.kind === "pattern") requireState(typeof l.fill.assetId === "string" && finite(l.fill.scale), "Invalid pattern fill");
        if (l.fill.kind === "gradient") requireState(Array.isArray(l.fill.stops) && l.fill.stops.every((s: unknown) => object(s) && finite(s.pos) && typeof s.color === "string"), "Invalid gradient stops");
        break;
      case "adjustment": requireState(object(l.adjustment), "Invalid adjustment layer"); break;
      case "brush": validateStrokes(l.strokes); break;
      default: throw new OpError("Unknown persisted layer type");
    }
  }
}
function validateDocument(value: unknown, id: string): asserts value is AdDocument {
  boundedShape(value);
  requireState(object(value) && safeId(value.id) && value.id === id && value.version === 1, "Invalid snapshot identity/version");
  // Version-1 whole-document imports historically omitted createdAt. Keep that
  // unknown field absent rather than inventing a date or blocking a valid library.
  // A present malformed date and all revision/updatedAt checks remain strict.
  requireState(integer(value.rev) && value.rev >= 0 && typeof value.name === "string" && (value.createdAt === undefined || timestamp(value.createdAt)) && timestamp(value.updatedAt), "Invalid snapshot revision/name/timestamps");
  for (const k of ["width", "height"]) requireState(finite(value[k]) && value[k] >= 1 && value[k] <= MAX_DIMENSION, `Invalid document ${k}`);
  // Core's existing doc.set null-clearing semantics can omit a transparent background.
  requireState(value.background === undefined || value.background === null || typeof value.background === "string", "Invalid background");
  validateLayers(value.layers); requireState(object(value.assets), "Invalid assets map");
  for (const [key, a] of Object.entries(value.assets)) { validateAsset(a, true); requireState((a as any).id === key, "Asset map identity mismatch"); }
  requireState(Array.isArray(value.guides) && value.guides.every(g => object(g) && ["x", "y"].includes(g.axis) && finite(g.position)), "Invalid guides");
  if (value.comps !== undefined) requireState(Array.isArray(value.comps) && value.comps.every(c => object(c) && typeof c.id === "string" && typeof c.name === "string" && object(c.states)), "Invalid comps");
  if (value.selections !== undefined) requireState(Array.isArray(value.selections) && value.selections.every(s => object(s) && typeof s.id === "string" && typeof s.name === "string" && Array.isArray(s.rings) && s.rings.every((r: unknown) => Array.isArray(r) && r.length % 2 === 0 && r.every(finite))), "Invalid selections");
  if (value.animation !== undefined) requireState(object(value.animation) && finite(value.animation.fps) && value.animation.fps > 0 && finite(value.animation.duration) && value.animation.duration >= 0 && object(value.animation.tracks) && Object.values(value.animation.tracks).every(t => Array.isArray(t) && t.every(k => object(k) && finite(k.t))), "Invalid animation");
}
const DOC_KEYS = new Set(["name", "width", "height", "background", "guides", "comps", "selections", "animation", "linearBlending"]);
function validateOps(ops: unknown): asserts ops is Op[] {
  requireState(Array.isArray(ops), "Invalid operations array");
  for (const op of ops) {
    requireState(object(op), "Invalid operation");
    switch (op.type) {
      case "doc.set": requireState(object(op.props) && Object.keys(op.props).every(k => DOC_KEYS.has(k)), "Invalid doc.set properties"); break;
      case "layer.set": requireState(typeof op.id === "string" && !!op.id && object(op.props) && !["id", "type", "children"].some(k => k in op.props), "Invalid layer.set properties"); validateLayerProps(op.props); break;
      case "layer.add": requireState(op.parentId === null || typeof op.parentId === "string", "Invalid parent identity"); requireState(integer(op.index), "Invalid layer index"); validateAddedLayer(op.layer); break;
      case "layer.move": requireState(typeof op.id === "string" && !!op.id && (op.parentId === null || typeof op.parentId === "string") && integer(op.index), "Invalid layer.move"); break;
      case "layer.remove": case "asset.remove": requireState(typeof op.id === "string" && !!op.id, "Invalid removal identity"); break;
      case "layer.push": case "layer.splice": requireState(typeof op.id === "string" && !!op.id && typeof op.key === "string" && !["__proto__", "constructor", "prototype"].includes(op.key), "Invalid list operation"); if (op.type === "layer.push") requireState(Array.isArray(op.items), "Invalid pushed items"); else requireState(integer(op.index) && integer(op.count) && op.count >= 0 && (op.items === undefined || Array.isArray(op.items)), "Invalid splice"); break;
      case "asset.add": validateAsset(op.asset); break;
      default: throw new OpError("Unknown persisted operation type");
    }
    // Validate doc.set independently even when the record is already in the snapshot.
    if (op.type === "doc.set") {
      const probe = createDocument({ id: "probe" }); applyOps(probe, [deepClone(op) as Op]); validateDocument(probe, "probe");
    }
  }
}

/** True only for a prefix of JSON that still needs bytes, never for complete/invalid JSON. */
function incompleteJson(text: string): boolean {
  let i = 0; const end = Symbol("incomplete"), bad = Symbol("invalid");
  const ws = () => { while (i < text.length && /[ \t\r\n]/.test(text[i])) i++; };
  const next = () => { if (i === text.length) throw end; return text[i++]; };
  const string = () => {
    for (;;) { const c = next(); if (c === '"') return; if (c.charCodeAt(0) < 32) throw bad;
      if (c === "\\") { const e = next(); if (e === "u") { for (let n = 0; n < 4; n++) if (!/[0-9a-f]/i.test(next())) throw bad; } else if (!'"\\/bfnrt'.includes(e)) throw bad; }
    }
  };
  const value = (depth: number) => {
    if (depth > MAX_DEPTH) throw bad; ws(); const c = next();
    if (c === '"') { string(); return; }
    if (c === "{" || c === "[") {
      ws(); if (text[i] === (c === "{" ? "}" : "]")) { i++; return; }
      for (;;) {
        if (c === "{") { ws(); if (next() !== '"') throw bad; string(); ws(); if (next() !== ":") throw bad; }
        value(depth + 1); ws(); const sep = next(); if (sep === (c === "{" ? "}" : "]")) return; if (sep !== ",") throw bad;
      }
    }
    const literal = c === "t" ? "rue" : c === "f" ? "alse" : c === "n" ? "ull" : undefined;
    if (literal !== undefined) { for (const l of literal) if (next() !== l) throw bad; return; }
    if (c !== "-" && !/[0-9]/.test(c)) throw bad;
    let digit = c; if (c === "-") digit = next(); if (!/[0-9]/.test(digit)) throw bad;
    if (digit !== "0") while (i < text.length && /[0-9]/.test(text[i])) i++;
    if (text[i] === ".") { i++; if (!/[0-9]/.test(next())) throw bad; while (i < text.length && /[0-9]/.test(text[i])) i++; }
    if (text[i] === "e" || text[i] === "E") { i++; if (text[i] === "+" || text[i] === "-") i++; if (!/[0-9]/.test(next())) throw bad; while (i < text.length && /[0-9]/.test(text[i])) i++; }
  };
  try { ws(); if (text[i] !== "{") return false; value(0); ws(); return false; }
  catch (e) { return e === end; }
}

export class RevisionConflict extends OpError {}

export class DocStore {
  private docs = new Map<string, AdDocument>();
  private history = new Map<string, AppliedOps[]>();
  private journalCounts = new Map<string, number>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<(applied: AppliedOps) => void>();
  private saveErrors = new Map<string, string>();
  private recoveryErrors = new Map<string, string>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    const files = readdirSync(dir); let libraryBytes = 0;
    for (const f of files.filter(f => f.endsWith(".history.jsonl.recovery-error"))) {
      this.recoveryErrors.set(f.slice(0, -".history.jsonl.recovery-error".length), `Unresolved journal write; review retained marker ${join(dir, f)} before editing`);
    }
    // An unresolved append rollback is not made safe by syntactically replayable bytes.
    for (const f of files.filter(f => f.includes(".history.jsonl.recovery-") && f.endsWith(".bak"))) {
      const original = f.slice(0, f.lastIndexOf(".history.jsonl.recovery-"));
      try {
        const diagnosis = json(readBounded(join(dir, f.slice(0, -4) + ".diagnosis"), 64 * 1024));
        requireState(object(diagnosis) && diagnosis.rollbackSucceeded !== false, `Unresolved append rollback; inspect ${join(dir, f)}`);
      } catch (e) { this.recoveryErrors.set(original, `Recovery evidence requires review: ${join(dir, f)}: ${(e as Error).message}`); }
    }
    for (const f of files.filter(f => f.endsWith(".history.jsonl"))) {
      const id = f.slice(0, -14);
      if (!files.includes(id + ".json")) this.recoveryErrors.set(id, `Missing snapshot ${join(dir, id + ".json")}; retained orphan journal ${join(dir, f)}`);
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5), snapshot = join(dir, f);
      try {
        const bytes = readBounded(snapshot); libraryBytes += bytes.length;
        requireState(libraryBytes <= MAX_LIBRARY_BYTES, `Library recovery byte limit ${MAX_LIBRARY_BYTES} exceeded`);
        const doc = json(bytes); validateDocument(doc, id);
        // Only the validated prior snapshot is available if later recovery fails.
        this.docs.set(id, doc);
        if (this.recoveryErrors.has(id)) throw new Error(this.recoveryErrors.get(id));
        const { history, recovered, journal, repair, count } = this.loadHistory(doc);
        if (repair !== undefined) {
          requireState(repair.length <= MAX_FILE_BYTES, `Journal separator repair exceeds byte limit ${MAX_FILE_BYTES}`);
          preserveForRecovery(journal, { reason: "Repair incomplete JSON tail or add separator after valid unterminated record", snapshot, revision: doc.rev });
          atomicWrite(journal, repair);
        }
        if (recovered.rev !== doc.rev) {
          preserveForRecovery(snapshot, { reason: "Replay fully validated committed journal", journal, fromRevision: doc.rev, toRevision: recovered.rev });
          this.writeSnapshot(recovered);
        }
        if (count > 2000) {
          preserveForRecovery(journal, { reason: "Rotate validated history after snapshot publication", snapshot, revision: recovered.rev });
          atomicWrite(journal, history.map(a => JSON.stringify(a)).join("\n") + "\n");
        }
        this.docs.set(id, recovered); this.history.set(id, history.slice(-500)); this.journalCounts.set(id, count > 2000 ? history.length : count);
      } catch (e) {
        const prior = this.recoveryErrors.get(id);
        this.recoveryErrors.set(id, `${prior ? prior + "; " : ""}Could not recover ${snapshot}: ${(e as Error).message}; original files/recovery backups retained; restore/review before editing`);
        console.warn(this.recoveryErrors.get(id));
      }
    }
  }

  /** Stage complete recovery before changing either disk file or publishing any replayed state. */
  private loadHistory(doc: AdDocument) {
    const journal = join(this.dir, doc.id + ".history.jsonl"), history: AppliedOps[] = [], recovered = deepClone(doc);
    let repair: Buffer | undefined, count = 0;
    if (!existsSync(journal)) {
      requireState(doc.rev === 0, `Missing edit log for revision ${doc.rev}: ${journal}`);
      return { journal, history, recovered, repair, count };
    }
    const bytes = readBounded(journal); let offset = 0, previous: number | undefined, lineNo = 0;
    while (offset < bytes.length) {
      const start = offset, newline = bytes.indexOf(10, offset), terminated = newline !== -1;
      offset = terminated ? newline + 1 : bytes.length; lineNo++;
      const raw = bytes.subarray(start, terminated ? newline : bytes.length);
      if (!raw.length) continue; // Preserve the existing empty-line compatibility.
      let record: unknown;
      try { record = json(raw); }
      catch (e) {
        // A newline commits even a malformed record. A complete invalid JSON object is never a torn write.
        // Streaming decode exposes an incomplete final UTF-8 character without accepting replacement bytes.
        const decoder = new TextDecoder("utf-8", { fatal: true }); let text: string;
        try { text = decoder.decode(raw, { stream: true }); } catch { throw new Error(`Invalid UTF-8 in ${journal} line ${lineNo}`); }
        if (!terminated && incompleteJson(text)) { repair = Buffer.from(bytes.subarray(0, start)); break; }
        throw new Error(`Corrupt committed record in ${journal} line ${lineNo}: ${String(e)}`);
      }
      try {
        boundedShape(record);
        requireState(object(record) && record.docId === doc.id && integer(record.rev) && record.rev > 0 && timestamp(record.at) && typeof record.actor === "string", "Invalid record identity/revision/metadata");
        requireState(Array.isArray(record.ops) && record.ops.length > 0, "Empty committed operation record"); validateOps(record.ops); validateOps(record.inverse);
        if (record.expectedRev !== undefined) requireState(record.expectedRev === record.rev - 1, "Invalid committed expectedRev");
        if (record.label !== undefined) requireState(typeof record.label === "string", "Invalid record label");
        if (previous !== undefined) requireState(record.rev === previous + 1, `Edit log gap/duplicate/order after revision ${previous}`);
        requireState(++count <= MAX_RECORDS, `Recovery record limit ${MAX_RECORDS} exceeded`); previous = record.rev;
        if (record.rev > recovered.rev) {
          requireState(record.rev === recovered.rev + 1, `Edit log gap after snapshot revision ${recovered.rev}`);
          // Never re-run linked propagation: the stored batch already contains the propagated ops.
          for (const op of record.ops) { this.checkLocks(recovered, [op]); applyOps(recovered, [deepClone(op)]); }
          recovered.rev = record.rev; recovered.updatedAt = record.at; validateDocument(recovered, doc.id);
        }
        history.push(record as unknown as AppliedOps); if (history.length > 1500) history.shift();
      } catch (e) { throw new Error(`Invalid record in ${journal} line ${lineNo}: ${(e as Error).message}`); }
      if (!terminated) repair = Buffer.concat([bytes, Buffer.from("\n")]);
    }
    // A stale history ending below the snapshot cannot safely be followed by the next revision.
    requireState(previous === undefined ? doc.rev === 0 : previous >= doc.rev, `Missing journal revisions through snapshot revision ${doc.rev}: ${journal}`);
    return { journal, history, recovered, repair, count };
  }

  private requireEditable() { if (this.recoveryErrors.size || this.saveErrors.size) throw new OpError(`Persistence recovery requires review: ${[...this.recoveryErrors.values(), ...this.saveErrors.values()].join("; ")}`); }

  onApplied(fn: (applied: AppliedOps) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  list() {
    return [...this.docs.values()].map((d) => ({ id: d.id, name: d.name, width: d.width, height: d.height, rev: d.rev, updatedAt: d.updatedAt, layers: d.layers.length }));
  }

  get(id: string): AdDocument | undefined { return this.docs.get(id); }
  all(): AdDocument[] { return [...this.docs.values()]; }

  create(init: Parameters<typeof createDocument>[0]): AdDocument {
    this.requireEditable();
    const doc = createDocument(init);
    validateDocument(doc, doc.id); requireState(!this.docs.has(doc.id) && !existsSync(join(this.dir, doc.id + ".json")) && !existsSync(join(this.dir, doc.id + ".history.jsonl")), "Document id already exists on disk");
    this.writeSnapshot(doc);
    this.docs.set(doc.id, doc);
    this.history.set(doc.id, []);
    this.journalCounts.set(doc.id, 0);
    return doc;
  }

  /** Replace a whole document (used by import). */
  put(doc: AdDocument) {
    this.requireEditable(); validateDocument(doc, doc.id);
    requireState(doc.rev === 0 || this.docs.has(doc.id), "Standalone whole-document import requires revision 0; nonzero snapshots require their committed history");
    if (this.docs.has(doc.id) && (this.history.get(doc.id)?.length ?? 0) > 0) throw new OpError("Whole-document import requires a new document id once editing has begun");
    this.writeSnapshot(doc);
    this.docs.set(doc.id, doc);
    if (!this.history.has(doc.id)) this.history.set(doc.id, []);
    if (!this.journalCounts.has(doc.id)) this.journalCounts.set(doc.id, 0);
  }

  delete(id: string): boolean {
    this.requireEditable();
    if (!this.docs.delete(id)) return false;
    clearTimeout(this.saveTimers.get(id)); this.saveTimers.delete(id);
    this.history.delete(id);
    this.journalCounts.delete(id);
    this.saveErrors.delete(id); this.recoveryErrors.delete(id);
    for (const suffix of [".json", ".history.jsonl"]) { const p = join(this.dir, id + suffix); if (existsSync(p)) unlinkSync(p); }
    return true;
  }

  apply(envelope: OpEnvelope): AppliedOps {
    this.requireEditable();
    const doc = this.docs.get(envelope.docId);
    if (!doc) throw new OpError(`Document ${envelope.docId} not found`);
    if (this.recoveryErrors.has(doc.id)) throw new OpError(this.recoveryErrors.get(doc.id)!);
    if (envelope.expectedRev !== undefined) {
      if (!Number.isSafeInteger(envelope.expectedRev) || envelope.expectedRev < 0) throw new OpError("expectedRev must be a non-negative integer");
      if (envelope.expectedRev !== doc.rev) throw new RevisionConflict(`Document changed: expected revision ${envelope.expectedRev}, current revision ${doc.rev}`);
    }
    if (!Array.isArray(envelope.ops) || !envelope.ops.length) throw new OpError("ops must be a non-empty array");
    requireState(typeof envelope.actor === "string" && (envelope.label === undefined || typeof envelope.label === "string"), "Invalid operation actor/label");
    // Linked layers: content edits fan out to their siblings inside the same applied change (and the same undo).
    const ops = deepClone([...envelope.ops, ...linkedPropagationOps(doc, envelope.ops)]);
    envelope = { ...envelope, ops };
    const staged = deepClone(doc); const inverse: Op[] = [];
    // Locks are checked against preceding operations in this batch, including linked propagation.
    for (const op of ops) {
      // Persist the core defaults (including a generated identity) instead of replaying them afresh.
      if (op.type === "layer.add") op.layer = normalizeLayer(op.layer);
      this.checkLocks(staged, [op]); inverse.unshift(...applyOps(staged, [op]));
    }
    validateDocument(staged, doc.id); validateOps(ops); validateOps(inverse);
    requireState(doc.rev < Number.MAX_SAFE_INTEGER, "Document revision exhausted");
    staged.rev += 1;
    const applied: AppliedOps = { ...envelope, rev: staged.rev, inverse, at: nowIso() };
    const record = JSON.stringify(applied) + "\n";
    requireState((this.journalCounts.get(doc.id) ?? 0) < MAX_RECORDS, `Journal record limit ${MAX_RECORDS} would be exceeded; flush/reopen for validated rotation`);
    requireState(Buffer.byteLength(JSON.stringify(staged, null, 2)) <= MAX_FILE_BYTES && Buffer.byteLength(record) <= MAX_FILE_BYTES, `Edit exceeds recovery byte limit ${MAX_FILE_BYTES}`);
    const journal = join(this.dir, doc.id + ".history.jsonl");
    if (existsSync(journal)) {
      const fd = openSync(journal, "r");
      try { requireState(fstatSync(fd).size + Buffer.byteLength(record) <= MAX_FILE_BYTES, `Journal recovery byte limit ${MAX_FILE_BYTES} would be exceeded; flush/reopen for validated rotation or review large legacy history`); }
      finally { closeSync(fd); }
    }
    // A refused log write must leave the live document and history untouched.
    try { durableAppend(journal, record); }
    catch (e) { this.recoveryErrors.set(doc.id, `Journal write failed for ${doc.id}: ${(e as Error).message}; reopen/review before editing`); throw e; }
    this.journalCounts.set(doc.id, (this.journalCounts.get(doc.id) ?? 0) + 1);
    this.docs.set(doc.id, staged);
    const h = this.history.get(doc.id)!;
    h.push(applied);
    if (h.length > 500) h.splice(0, h.length - 500);
    this.save(doc.id);
    for (const fn of this.listeners) { try { fn(applied); } catch (e) { console.error("Document change listener failed", e); } }
    return applied;
  }

  historySince(id: string, rev: number): AppliedOps[] {
    return (this.history.get(id) ?? []).filter((a) => a.rev > rev);
  }

  /** Locked layers cannot be moved, edited or deleted by anyone until unlocked - same as Photoshop. */
  private checkLocks(doc: AdDocument, ops: Op[]) {
    for (const op of ops) {
      if ("id" in op && typeof op.id === "string") {
        let parent = findParent(doc, op.id)?.parent;
        while (parent) { if (parent.locked) throw new OpError(`Group "${parent.name}" is locked`); parent = findParent(doc, parent.id)?.parent; }
        if (op.type === "layer.remove" || op.type === "layer.move") {
          const layer = findLayer(doc, op.id);
          if (layer && isGroup(layer) && [...walk(layer.children)].some(({ layer: child }) => child.locked)) throw new OpError(`Group "${layer.name}" contains locked layers`);
        }
      }
      if ((op.type === "layer.add" || op.type === "layer.move") && op.parentId) {
        let parent = findLayer(doc, op.parentId);
        while (parent) { if (parent.locked) throw new OpError(`Group "${parent.name}" is locked`); parent = findParent(doc, parent.id)?.parent ?? undefined; }
      }
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
    const failures: string[] = [];
    for (const [id, timer] of this.saveTimers) {
      clearTimeout(timer); const doc = this.docs.get(id);
      try { if (doc) this.writeSnapshot(doc); this.saveTimers.delete(id); this.saveErrors.delete(id); }
      catch (e) { const message = (e as Error).message; failures.push(`${id}: ${message}`); this.saveErrors.set(id, message); }
    }
    if (failures.length) throw new Error(`Document flush failed: ${failures.join("; ")}`);
  }

  persistence() { return { ok: !this.saveErrors.size && !this.recoveryErrors.size, pending: this.saveTimers.size, errors: Object.fromEntries([...this.saveErrors, ...this.recoveryErrors]) }; }

  private writeSnapshot(doc: AdDocument) {
    try {
      const bytes = JSON.stringify(doc, null, 2); requireState(Buffer.byteLength(bytes) <= MAX_FILE_BYTES, `Snapshot byte limit ${MAX_FILE_BYTES} exceeded`);
      atomicWrite(join(this.dir, doc.id + ".json"), bytes); this.saveErrors.delete(doc.id);
    } catch (e) { this.saveErrors.set(doc.id, (e as Error).message); throw e; }
  }

  private save(id: string, delay = 150) {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.set(id, setTimeout(() => {
      const doc = this.docs.get(id);
      this.saveTimers.delete(id);
      try { if (doc) this.writeSnapshot(doc); this.saveErrors.delete(id); }
      catch (e) { this.saveErrors.set(id, (e as Error).message); console.error(`Document snapshot failed for ${id}`, e); this.save(id, 1000); }
    }, delay).unref());
  }
}
