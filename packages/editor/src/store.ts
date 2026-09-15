import { create } from "zustand";
import type { AdDocument, AppliedOps, Layer, Op, OpEnvelope, ServerMessage, ClientMessage } from "@pictocity/core";
import { applyOps, deepClone, findLayer, findParent, uid, isGroup, walk, cloneWithNewIds, makeGroup, makeShape, makeImage, makeAdjustment, layerBounds, cropOps, flipOps, ringsToPath, artboardOf, toLocal, combineSelections, captureComp, applyCompOps, keyframeOf, combineShapes as combineShapesCore, shapeToAnchors, anchorsToPath, traceRegions, type LayerStyles } from "@pictocity/core";
import { rotateMembers } from "./transform";
import { ensureAssets, TOKEN } from "./env";

export type Tool = "move" | "direct" | "marquee" | "lasso" | "wand" | "text" | "shape" | "pen" | "brush" | "eraser" | "clone" | "heal" | "gradient" | "crop" | "eyedropper" | "hand" | "zoom" | "rotate";
export type ShapeKind = "rect" | "ellipse" | "line" | "polygon" | "star";

export interface HistoryEntry { label: string; ops: Op[]; inverse: Op[]; mergeKey?: string; at: number }

export interface Presence { selection: string[]; cursor?: { x: number; y: number }; seen: number }

interface State {
  clientId: string;
  actor: string;
  connection: "offline" | "connecting" | "online";
  doc: AdDocument | null;
  docs: { id: string; name: string; width: number; height: number; rev: number; updatedAt: string }[];
  fonts: string[];
  /** Families served from fonts/ (available to both renderers); others are server-side system fonts. */
  servedFonts: string[];
  selection: string[];
  hoverId: string | null;
  tool: Tool;
  shapeKind: ShapeKind;
  autoSelectGroup: boolean;
  zoom: number;
  pan: { x: number; y: number };
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  log: AppliedOps[];
  presence: Record<string, Presence>;
  editingTextId: string | null;
  /** Character range selected in the inline text editor (for per-character styling). */
  textSelection: { id: string; start: number; end: number } | null;
  fgColor: string;
  bgColor: string;
  brush: { size: number; hardness: number; opacity: number };
  /** Pixel selection (marching ants): document-space rings (several areas, holes). */
  pixelSelection: number[][] | null;
  lastSelection: number[][] | null;
  lassoKind: "free" | "polygon";
  gradientType: "linear" | "radial" | "angle" | "reflected" | "diamond";
  gradientToTransparent: boolean;
  marqueeKind: "rect" | "ellipse";
  showGrid: boolean;
  gridSize: number;
  wandTolerance: number;
  styleClipboard: LayerStyles | null;
  recentColors: string[];
  selectionFeather: number;
  selectionTransform: boolean;
  distortMode: "skew" | "distort" | "perspective" | null;
  recentDocs: { id: string; name: string }[];
  panelsHidden: boolean;
  showTimeline: boolean;
  animTime: number;
  playing: boolean;
  /** View rotation in degrees (Rotate View tool). */
  viewRotation: number;
  /** Photoshop's Extras (⌘H): selection edges, guides, bounding boxes. */
  showExtras: boolean;
  guidesLocked: boolean;
  menuHidden: boolean;
  /** Photoshop "mask selected": brush/eraser paint the selected layer's mask instead of pixels. */
  editMask: boolean;
  cropRect: { x: number; y: number; width: number; height: number } | null;
  showGuides: boolean;
  showRulers: boolean;
  toast: string | null;
  modal: "new" | "open" | "size" | "variant" | "artboard" | "copyto" | "shortcuts" | "export" | "saveas" | "exports" | "prefs" | null;

  // actions
  connect(docId: string): void;
  refreshDocs(): Promise<void>;
  createDoc(init: { name: string; width: number; height: number; background: string | null }): Promise<void>;
  dispatch(ops: Op[], label: string, opts?: { mergeKey?: string }): void;
  setLocal(ops: Op[]): void;
  undo(): void;
  redo(): void;
  revertTo(rev: number): void;
  select(ids: string[], opts?: { toggle?: boolean }): void;
  setTool(t: Tool): void;
  setShapeKind(k: ShapeKind): void;
  setView(zoom: number, pan?: { x: number; y: number }): void;
  set<K extends keyof State>(k: K, v: State[K]): void;
  showToast(msg: string): void;

  // compound edits used by menus and shortcuts
  deleteSelection(): void;
  duplicateSelection(): void;
  groupSelection(): void;
  ungroupSelection(): void;
  reorderSelection(dir: "up" | "down" | "top" | "bottom"): void;
  nudge(dx: number, dy: number): void;
  alignSelection(kind: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"): void;
  distributeSelection(axis: "x" | "y"): void;
  applyCrop(): void;
  transformSelection(kind: "flipH" | "flipV" | "rot90" | "rot-90" | "rot180"): void;
  fillPixelSelection(): void;
  hidePixelSelection(): void;
  maskFromSelection(mode: "reveal" | "hide"): void;
  mergeSelection(): Promise<void>;
  copyStyle(): void;
  pasteStyle(): void;
  setFgColor(c: string): void;
  linkSelection(unlink?: boolean): void;
  copyLayers(): void;
  toggleClipping(): void;
  combineShapes(op: import("@pictocity/core").BooleanOp): void;
  convertToPath(): void;
  styleTextRange(props: Partial<Omit<import("@pictocity/core").TextRun, "start" | "end">>): boolean;
  setAnimation(patch: Partial<import("@pictocity/core").Animation>): void;
  addKeyframe(): void;
  deleteKeyframe(layerId?: string, t?: number): void;
  soloLayer(id: string): void;
  saveComp(name: string, id?: string): void;
  applyComp(id: string): void;
  deleteComp(id: string): void;
  pasteLayers(payload: { layers: Layer[]; assets: Record<string, import("@pictocity/core").Asset>; docId: string }, inPlace?: boolean): void;
  rotateCanvas(deg: 90 | -90 | 180): void;
  applyAdjustmentToSelection(kind: string, value: unknown): void;
  invertPixelSelection(): void;
  setPixelSelection(rings: number[][] | null, mode?: "replace" | "add" | "subtract" | "intersect"): void;
  modifySelection(kind: "expand" | "contract" | "smooth" | "border", px: number): void;
  selectAllPixels(): void;
  selectionFromLayer(id: string, alpha: (l: Layer) => { canvas: HTMLCanvasElement; x: number; y: number; scale: number } | undefined): void;
  saveSelection(name: string): void;
  loadSelection(id: string): void;
  sendCursor(x: number, y: number): void;
  setLayerProps(id: string, props: Record<string, unknown>, label?: string, mergeKey?: string): void;
}

let ws: WebSocket | null = null;
let currentDocId: string | null = null;
let lastCursorSent = 0;
let soloVisibility: Set<string> | null = null;
let visibilityHooked = false;
/** Op counts of envelopes we've sent, so echoes can be matched and any server-added ops (linked layers) applied. */
const pendingCounts: number[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Edits made while the connection is down wait here and are replayed after the next snapshot. */
const outbox: OpEnvelope[] = [];

function send(msg: ClientMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return; }
  if (msg.kind === "ops") { outbox.push(msg.envelope); pendingCounts.pop(); }
}
// Closing the tab with edits still queued offline would lose them.
window.addEventListener("beforeunload", (e) => { if (outbox.length) { e.preventDefault(); e.returnValue = ""; } });

export const useStore = create<State>((set, get) => ({
  clientId: uid("ed"),
  actor: "",
  connection: "offline",
  doc: null,
  docs: [],
  fonts: [],
  servedFonts: [],
  selection: [],
  hoverId: null,
  tool: "move",
  shapeKind: "rect",
  autoSelectGroup: false,
  zoom: 1,
  pan: { x: 0, y: 0 },
  undoStack: [],
  redoStack: [],
  log: [],
  presence: {},
  editingTextId: null,
  textSelection: null,
  fgColor: "#4f6df5",
  bgColor: "#ffffff",
  brush: { size: 24, hardness: 0.9, opacity: 1 },
  pixelSelection: null,
  lastSelection: null,
  lassoKind: "free",
  gradientType: "linear",
  gradientToTransparent: false,
  marqueeKind: "rect",
  showGrid: false,
  gridSize: 50,
  wandTolerance: 32,
  styleClipboard: null,
  recentColors: ["#111111", "#ffffff", "#4f6df5", "#f2b24a", "#e5484d", "#1c8f5a"],
  selectionFeather: 0,
  selectionTransform: false,
  distortMode: null,
  recentDocs: [],
  panelsHidden: false,
  showTimeline: false,
  animTime: 0,
  playing: false,
  viewRotation: 0,
  showExtras: true,
  guidesLocked: false,
  menuHidden: false,
  editMask: false,
  cropRect: null,
  showGuides: true,
  showRulers: true,
  toast: null,
  modal: null,

  set: (k, v) => set({ [k]: v } as Partial<State>),
  showToast: (msg) => { set({ toast: msg }); setTimeout(() => { if (get().toast === msg) set({ toast: null }); }, 1800); },

  connect(docId) {
    const actor = `editor:${get().clientId}`;
    currentDocId = docId;
    set({ actor, connection: "connecting", selection: [], undoStack: [], redoStack: [], log: [], presence: {}, editingTextId: null });
    pendingCounts.length = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`);
    const sock = ws;
    sock.onopen = () => { set({ connection: "online" }); send({ kind: "subscribe", docId }); };
    sock.onclose = () => {
      if (ws !== sock) return;
      set({ connection: "offline" });
      reconnectTimer = setTimeout(() => { if (currentDocId === docId) get().connect(docId); }, 1500);
    };
    if (!visibilityHooked) {
      visibilityHooked = true;
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && get().connection === "offline" && currentDocId) get().connect(currentDocId); });
    }
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMessage;
      const st = get();
      if (msg.kind === "snapshot") {
        ensureAssets(msg.doc);
        const url = new URL(location.href); url.searchParams.set("doc", msg.doc.id); history.replaceState(null, "", url);
        // Replay anything edited while offline on top of the fresh snapshot, then send it.
        const queued = outbox.splice(0).filter((env) => env.docId === msg.doc.id);
        const doc = queued.length ? deepClone(msg.doc) : msg.doc;
        for (const env of queued) { try { applyOps(doc, env.ops); } catch { /* stale: drop */ continue; } pendingCounts.push(env.ops.length); ws?.send(JSON.stringify({ kind: "ops", envelope: env, clientRev: doc.rev })); }
        if (queued.length) get().showToast(`Reconnected — sent ${queued.length} change(s) made offline`);
        set({ doc, selection: st.selection.filter((id) => findLayer(doc, id)), recentDocs: [{ id: doc.id, name: doc.name }, ...st.recentDocs.filter((d) => d.id !== doc.id)].slice(0, 8) });
        fetch(`/api/docs/${docId}/history?since=0`).then((r) => r.json()).then((log: AppliedOps[]) => set({ log })).catch(() => undefined);
      } else if (msg.kind === "applied") {
        const a = msg.applied;
        if (!st.doc || a.docId !== st.doc.id) return;
        if (a.actor === st.actor) {
          // Our own op echoed back: already applied locally, adopt the rev - and apply anything the server appended
          // (linked-layer propagation), which we haven't seen yet.
          const sent = pendingCounts.shift() ?? a.ops.length;
          const extra = a.ops.slice(sent);
          let doc = st.doc;
          if (extra.length) { doc = deepClone(st.doc); try { applyOps(doc, extra); } catch { send({ kind: "subscribe", docId }); return; } }
          set({ doc: { ...doc, rev: a.rev }, log: [...st.log, a] });
          return;
        }
        const doc = deepClone(st.doc);
        try { applyOps(doc, a.ops); doc.rev = a.rev; }
        catch { send({ kind: "subscribe", docId }); return; }
        ensureAssets(doc);
        set({ doc, log: [...st.log, a], selection: st.selection.filter((id) => findLayer(doc, id)) });
        if (a.actor.startsWith("agent:")) {
          const touched = a.ops.map((o) => ("id" in o ? o.id : o.type === "layer.add" ? o.layer.id : "")).filter(Boolean);
          set({ presence: { ...get().presence, [a.actor]: { selection: touched, seen: Date.now() } } });
          setTimeout(() => { const p = get().presence[a.actor]; if (p && Date.now() - p.seen >= 3900) { const n = { ...get().presence }; delete n[a.actor]; set({ presence: n }); } }, 4000);
        }
      } else if (msg.kind === "rejected") {
        pendingCounts.shift();
        get().showToast(msg.reason);
        send({ kind: "subscribe", docId }); // resync
      } else if (msg.kind === "presence") {
        set({ presence: { ...st.presence, [msg.actor]: { selection: msg.selection, cursor: msg.cursor, seen: Date.now() } } });
      } else if (msg.kind === "error") get().showToast(msg.message);
    };
  },

  async refreshDocs() {
    const docs = await fetch("/api/docs").then((r) => r.json()).catch(() => []);
    set({ docs });
  },

  async createDoc(init) {
    const d = await fetch("/api/docs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init) }).then((r) => r.json());
    get().connect(d.id);
    set({ modal: null, zoom: 1, pan: { x: 0, y: 0 } });
  },

  /** Apply ops locally, record undo, send to the server. */
  dispatch(ops, label, opts = {}) {
    const st = get();
    if (!st.doc || !ops.length) return;
    const doc = deepClone(st.doc);
    let inverse: Op[];
    try { inverse = applyOps(doc, ops); }
    catch (e) { get().showToast((e as Error).message); return; }
    ensureAssets(doc);
    let undoStack = st.undoStack;
    const last = undoStack[undoStack.length - 1];
    if (opts.mergeKey && last && last.mergeKey === opts.mergeKey && Date.now() - last.at < 1200) {
      undoStack = [...undoStack.slice(0, -1), { ...last, ops: [...last.ops, ...ops], at: Date.now() }];
    } else undoStack = [...undoStack, { label, ops, inverse, mergeKey: opts.mergeKey, at: Date.now() }].slice(-200);
    set({ doc, undoStack, redoStack: [] });
    const envelope: OpEnvelope = { docId: doc.id, ops, actor: st.actor, label };
    pendingCounts.push(ops.length);
    send({ kind: "ops", envelope, clientRev: doc.rev });
  },

  /** Apply ops locally only (transient drag state). Not sent, not undoable. */
  setLocal(ops) {
    const st = get();
    if (!st.doc) return;
    const doc = deepClone(st.doc);
    try { applyOps(doc, ops); } catch { return; }
    set({ doc });
  },

  undo() {
    const st = get();
    const entry = st.undoStack[st.undoStack.length - 1];
    if (!entry || !st.doc) return;
    const doc = deepClone(st.doc);
    let redoOps: Op[];
    try { redoOps = applyOps(doc, entry.inverse); } catch (e) { get().showToast(`Can't undo: ${(e as Error).message}`); set({ undoStack: st.undoStack.slice(0, -1) }); return; }
    set({ doc, undoStack: st.undoStack.slice(0, -1), redoStack: [...st.redoStack, { ...entry, ops: redoOps, inverse: entry.inverse }] });
    pendingCounts.push(entry.inverse.length);
    send({ kind: "ops", envelope: { docId: doc.id, ops: entry.inverse, actor: st.actor, label: `Undo ${entry.label}` }, clientRev: doc.rev });
    reselectAfter(entry.inverse);
  },

  redo() {
    const st = get();
    const entry = st.redoStack[st.redoStack.length - 1];
    if (!entry || !st.doc) return;
    const doc = deepClone(st.doc);
    let inverse: Op[];
    try { inverse = applyOps(doc, entry.ops); } catch (e) { get().showToast(`Can't redo: ${(e as Error).message}`); set({ redoStack: st.redoStack.slice(0, -1) }); return; }
    set({ doc, redoStack: st.redoStack.slice(0, -1), undoStack: [...st.undoStack, { ...entry, inverse, at: Date.now() }] });
    pendingCounts.push(entry.ops.length);
    send({ kind: "ops", envelope: { docId: doc.id, ops: entry.ops, actor: st.actor, label: `Redo ${entry.label}` }, clientRev: doc.rev });
    reselectAfter(entry.ops);
  },

  /** Photoshop-style history click: roll the shared document back to a revision by applying stored inverses. */
  revertTo(rev) {
    const st = get();
    if (!st.doc) return;
    const later = st.log.filter((a) => a.rev > rev).sort((a, b) => b.rev - a.rev);
    const ops = later.flatMap((a) => a.inverse);
    if (!ops.length) return;
    get().dispatch(ops, `Revert to rev ${rev}`);
  },

  select(ids, opts = {}) {
    const st = get();
    let selection: string[];
    if (opts.toggle) selection = ids.reduce((acc, id) => (acc.includes(id) ? acc.filter((x) => x !== id) : [...acc, id]), st.selection);
    else selection = ids;
    set({ selection, editingTextId: null, editMask: selection.length === 1 && selection[0] === st.selection[0] ? st.editMask : false });
    if (st.doc) send({ kind: "presence", docId: st.doc.id, selection });
  },

  setTool: (tool) => set({ tool, editingTextId: null, cropRect: tool === "crop" ? get().cropRect : null }),
  setShapeKind: (shapeKind) => set({ shapeKind, tool: "shape" }),
  setView: (zoom, pan) => set({ zoom: Math.min(32, Math.max(0.02, zoom)), ...(pan ? { pan } : {}) }),

  deleteSelection() {
    const st = get();
    if (!st.doc) return;
    const ids = topLevelOnly(st.doc, st.selection);
    const ops: Op[] = ids.map((id) => ({ type: "layer.remove", id }));
    get().dispatch(ops, ids.length === 1 ? `Delete ${findLayer(st.doc, ids[0])?.name}` : `Delete ${ids.length} layers`);
    set({ selection: [] });
  },

  duplicateSelection() {
    const st = get();
    if (!st.doc) return;
    const ids = topLevelOnly(st.doc, st.selection);
    const ops: Op[] = []; const newIds: string[] = [];
    for (const id of ids) {
      const l = findLayer(st.doc, id); const loc = findParent(st.doc, id);
      if (!l || !loc) continue;
      const copy = cloneWithNewIds(l);
      ops.push({ type: "layer.add", layer: copy, parentId: loc.parent?.id ?? null, index: loc.index + 1 });
      newIds.push(copy.id);
    }
    get().dispatch(ops, "Duplicate layer");
    get().select(newIds);
  },

  groupSelection() {
    const st = get();
    if (!st.doc) return;
    const ids = topLevelOnly(st.doc, st.selection);
    if (!ids.length) return;
    const first = findParent(st.doc, ids[0])!;
    const parentId = first.parent?.id ?? null;
    const members = ids.filter((id) => (findParent(st.doc!, id)?.parent?.id ?? null) === parentId);
    const ordered = first.siblings.filter((l) => members.includes(l.id));
    const topIndex = Math.max(...ordered.map((l) => first.siblings.indexOf(l)));
    const group = makeGroup({ name: "Group", children: [] });
    const b = unionBounds(ordered);
    Object.assign(group, { x: b.x, y: b.y, width: b.width, height: b.height });
    const ops: Op[] = [
      { type: "layer.add", layer: group, parentId, index: topIndex + 1 },
      ...ordered.map((l, i) => ({ type: "layer.move" as const, id: l.id, parentId: group.id, index: i })),
    ];
    get().dispatch(ops, "Group layers");
    get().select([group.id]);
  },

  ungroupSelection() {
    const st = get();
    if (!st.doc) return;
    const ops: Op[] = []; const sel: string[] = [];
    for (const id of st.selection) {
      const g = findLayer(st.doc, id); const loc = findParent(st.doc, id);
      if (!g || !isGroup(g) || !loc) continue;
      g.children.forEach((c, i) => { ops.push({ type: "layer.move", id: c.id, parentId: loc.parent?.id ?? null, index: loc.index + 1 + i }); sel.push(c.id); });
      ops.push({ type: "layer.remove", id: g.id });
    }
    if (ops.length) { get().dispatch(ops, "Ungroup"); get().select(sel); }
  },

  reorderSelection(dir) {
    const st = get();
    if (!st.doc || !st.selection.length) return;
    const ops: Op[] = [];
    for (const id of st.selection) {
      const loc = findParent(st.doc, id); if (!loc) continue;
      const n = loc.siblings.length; let index = loc.index;
      if (dir === "up") index = Math.min(n - 1, loc.index + 1);
      if (dir === "down") index = Math.max(0, loc.index - 1);
      if (dir === "top") index = n - 1;
      if (dir === "bottom") index = 0;
      if (index !== loc.index) ops.push({ type: "layer.move", id, parentId: loc.parent?.id ?? null, index });
    }
    if (ops.length) get().dispatch(ops, dir === "up" ? "Bring forward" : dir === "down" ? "Send backward" : dir === "top" ? "Bring to front" : "Send to back");
  },

  nudge(dx, dy) {
    const st = get();
    if (!st.doc) return;
    const ops: Op[] = st.selection.map((id) => { const l = findLayer(st.doc!, id)!; return { type: "layer.set", id, props: { x: l.x + dx, y: l.y + dy } }; });
    get().dispatch(ops, "Nudge", { mergeKey: "nudge" });
  },

  alignSelection(kind) {
    const st = get();
    if (!st.doc) return;
    const tops = topLevelOnly(st.doc, st.selection).map((id) => findLayer(st.doc!, id)).filter((l): l is Layer => !!l && !l.locked);
    if (!tops.length) return;
    const boxOf = (l: Layer) => (isGroup(l) ? unionBounds([...walk(l.children)].map((w) => w.layer).filter((c) => !isGroup(c))) : layerBounds(l));
    // One layer aligns to the canvas; several align to their union, like Photoshop.
    const target = tops.length === 1 ? { x: 0, y: 0, width: st.doc.width, height: st.doc.height } : unionBounds(tops.map((l) => (isGroup(l) ? { ...l, ...boxOf(l), rotation: 0, scaleX: 1, scaleY: 1 } : l)));
    const ops: Op[] = [];
    for (const l of tops) {
      const b = boxOf(l);
      let dx = 0, dy = 0;
      if (kind === "left") dx = target.x - b.x; else if (kind === "hcenter") dx = target.x + target.width / 2 - (b.x + b.width / 2); else if (kind === "right") dx = target.x + target.width - (b.x + b.width);
      if (kind === "top") dy = target.y - b.y; else if (kind === "vcenter") dy = target.y + target.height / 2 - (b.y + b.height / 2); else if (kind === "bottom") dy = target.y + target.height - (b.y + b.height);
      dx = Math.round(dx); dy = Math.round(dy);
      if (!dx && !dy) continue;
      for (const m of [l, ...(isGroup(l) ? [...walk(l.children)].map((w) => w.layer) : [])]) ops.push({ type: "layer.set", id: m.id, props: { x: m.x + dx, y: m.y + dy } });
    }
    if (ops.length) get().dispatch(ops, `Align ${kind}`);
  },

  distributeSelection(axis) {
    const st = get();
    if (!st.doc) return;
    const tops = topLevelOnly(st.doc, st.selection).map((id) => findLayer(st.doc!, id)).filter((l): l is Layer => !!l && !l.locked);
    if (tops.length < 3) return;
    const boxOf = (l: Layer) => (isGroup(l) ? unionBounds([...walk(l.children)].map((w) => w.layer).filter((c) => !isGroup(c))) : layerBounds(l));
    const items = tops.map((l) => ({ l, b: boxOf(l) })).sort((a, b) => (axis === "x" ? a.b.x - b.b.x : a.b.y - b.b.y));
    const size = (b: { width: number; height: number }) => (axis === "x" ? b.width : b.height);
    const first = items[0].b, last = items[items.length - 1].b;
    const span = (axis === "x" ? last.x + last.width - first.x : last.y + last.height - first.y);
    const gap = (span - items.reduce((acc, it) => acc + size(it.b), 0)) / (items.length - 1);
    const ops: Op[] = [];
    let cursor = axis === "x" ? first.x : first.y;
    for (const it of items) {
      const d = Math.round(cursor - (axis === "x" ? it.b.x : it.b.y));
      if (d) for (const m of [it.l, ...(isGroup(it.l) ? [...walk(it.l.children)].map((w) => w.layer) : [])]) ops.push({ type: "layer.set", id: m.id, props: axis === "x" ? { x: m.x + d } : { y: m.y + d } });
      cursor += size(it.b) + gap;
    }
    if (ops.length) get().dispatch(ops, axis === "x" ? "Distribute horizontally" : "Distribute vertically");
  },

  transformSelection(kind) {
    const st = get();
    if (!st.doc) return;
    const tops = topLevelOnly(st.doc, st.selection).map((id) => findLayer(st.doc!, id)).filter((l): l is Layer => !!l && !l.locked);
    if (!tops.length) return;
    if (kind === "flipH" || kind === "flipV") {
      const ops = tops.flatMap((l) => flipOps(st.doc!, l.id, kind === "flipH" ? "x" : "y"));
      if (ops.length) get().dispatch(ops, kind === "flipH" ? "Flip horizontal" : "Flip vertical");
      return;
    }
    const delta = kind === "rot90" ? 90 : kind === "rot-90" ? -90 : 180;
    const boxOf = (l: Layer) => (isGroup(l) ? unionBounds([...walk(l.children)].map((w) => w.layer).filter((c) => !isGroup(c))) : layerBounds(l));
    const u = unionBounds(tops.map((l) => ({ ...l, ...boxOf(l), rotation: 0, scaleX: 1, scaleY: 1 })));
    const members = tops.flatMap((l) => [l, ...(isGroup(l) ? [...walk(l.children)].map((w) => w.layer) : [])]);
    const ops: Op[] = rotateMembers(members, { x: u.x + u.width / 2, y: u.y + u.height / 2 }, delta).map((m) => ({ type: "layer.set", id: m.id, props: m.props }));
    get().dispatch(ops, `Rotate ${delta}°`);
  },

  /** Fill the pixel selection with the foreground colour: a shape layer in the vector model. */
  fillPixelSelection() {
    const st = get();
    if (!st.doc || !st.pixelSelection) return;
    const { path, x, y, width, height } = ringsToPath(st.pixelSelection);
    const layer = makeShape({ name: "Fill", shape: "path", path, x, y, width, height, fill: st.fgColor, strokeColor: null, strokeWidth: 0 });
    const ab = st.selection.length ? artboardOf(st.doc, st.selection[0]) : null;
    const host = ab ?? st.doc.layers.find((l) => isGroup(l) && l.artboard && x >= l.x && y >= l.y && x < l.x + l.width && y < l.y + l.height);
    void ringsToPath;
    const parentId = host && isGroup(host) ? host.id : null;
    const index = host && isGroup(host) ? host.children.length : st.doc.layers.length;
    get().dispatch([{ type: "layer.add", layer, parentId, index }], "Fill selection");
    get().select([layer.id]);
  },

  /** Delete inside the pixel selection: erase on paint layers, hide through a painted mask on everything else. */
  hidePixelSelection() {
    const st = get();
    if (!st.doc || !st.pixelSelection) return;
    const ops: Op[] = [];
    for (const id of topLevelOnly(st.doc, st.selection)) {
      const l = findLayer(st.doc, id);
      if (!l || l.locked || isGroup(l) || l.type === "adjustment") continue;
      const rings = st.pixelSelection.map((ring) => { const local: number[] = []; for (let i = 0; i < ring.length; i += 2) { const q = toLocal(l, { x: ring[i], y: ring[i + 1] }); local.push(Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10); } return local; });
      const f = st.selectionFeather;
      const stroke = { points: rings[0], rings, size: f ? f * 2 : 1, color: "#000000", opacity: 1, hardness: f ? 0 : 1, erase: true, fill: true };
      if (l.type === "brush") ops.push({ type: "layer.push", id: l.id, key: "strokes", items: [stroke] });
      else {
        const mask = l.mask?.kind === "paint" ? { ...l.mask, strokes: [...l.mask.strokes, stroke] } : { kind: "paint" as const, base: "show" as const, strokes: [stroke] };
        ops.push({ type: "layer.set", id: l.id, props: { mask } });
      }
    }
    if (ops.length) get().dispatch(ops, "Delete selection");
  },

  /** Layer mask from the pixel selection: reveal (hide everything else) or hide the selected area. */
  maskFromSelection(mode) {
    const st = get();
    if (!st.doc || !st.pixelSelection) return;
    const ops: Op[] = [];
    for (const id of topLevelOnly(st.doc, st.selection)) {
      const l = findLayer(st.doc, id);
      if (!l || l.locked || l.type === "adjustment") continue;
      const rings = st.pixelSelection.map((ring) => { const local: number[] = []; for (let i = 0; i < ring.length; i += 2) { const q = toLocal(l, { x: ring[i], y: ring[i + 1] }); local.push(Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10); } return local; });
      const f = st.selectionFeather;
      const stroke = { points: rings[0], rings, size: f ? f * 2 : 1, color: "#ffffff", opacity: 1, hardness: f ? 0 : 1, fill: true, erase: mode === "hide" };
      ops.push({ type: "layer.set", id: l.id, props: { mask: { kind: "paint", base: mode === "reveal" ? "hide" : "show", strokes: [stroke] } } });
    }
    if (ops.length) get().dispatch(ops, mode === "reveal" ? "Mask: reveal selection" : "Mask: hide selection");
  },

  /** Merge the selected layers into one image layer (server renders them with their effects). */
  async mergeSelection() {
    const st = get();
    if (!st.doc) return;
    const ids = topLevelOnly(st.doc, st.selection).filter((id) => { const l = findLayer(st.doc!, id); return l && !l.locked; });
    if (!ids.length) return;
    const r = await fetch(`/api/docs/${st.doc.id}/rasterize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ layerIds: ids }) });
    const d = await r.json();
    if (!r.ok) { get().showToast(d.error ?? "Merge failed"); return; }
    // The asset arrives as its own op; wait for it, then swap the layers in one undoable batch.
    for (let i = 0; i < 50 && !get().doc?.assets[d.asset.id]; i++) await new Promise((res) => setTimeout(res, 80));
    const doc = get().doc!;
    const top = findParent(doc, ids[ids.length - 1]); if (!top) return;
    const layer = makeImage({ name: ids.length === 1 ? `${findLayer(doc, ids[0])!.name} (merged)` : "Merged", assetId: d.asset.id, x: d.x, y: d.y, width: d.width, height: d.height, fit: "fill" });
    const ops: Op[] = [{ type: "layer.add", layer, parentId: top.parent?.id ?? null, index: top.index + 1 }, ...ids.map((id) => ({ type: "layer.remove" as const, id }))];
    get().dispatch(ops, "Merge layers");
    get().select([layer.id]);
  },

  setAnimation(patch) {
    const st = get(); if (!st.doc) return;
    const anim = { fps: 12, duration: 3000, loop: true, tracks: {}, ...(st.doc.animation ?? {}), ...patch };
    get().dispatch([{ type: "doc.set", props: { animation: anim } }], "Timeline");
  },

  /** Snapshot the selected layers' position/opacity/rotation/scale as keyframes at the playhead. */
  addKeyframe() {
    const st = get(); if (!st.doc) return;
    const anim = { fps: 12, duration: 3000, loop: true, tracks: {}, ...(st.doc.animation ?? {}) };
    const tracks = { ...anim.tracks }; const t = Math.round(st.animTime);
    for (const id of st.selection) {
      const l = findLayer(st.doc, id); if (!l) continue;
      tracks[id] = [...(tracks[id] ?? []).filter((k) => k.t !== t), keyframeOf(l, t)].sort((a, b) => a.t - b.t);
    }
    if (t > anim.duration) anim.duration = t;
    get().dispatch([{ type: "doc.set", props: { animation: { ...anim, tracks } } }], "Add keyframe");
  },

  deleteKeyframe(layerId, t) {
    const st = get(); if (!st.doc?.animation) return;
    const tracks = { ...st.doc.animation.tracks }; const time = t ?? Math.round(st.animTime);
    for (const id of layerId ? [layerId] : st.selection) { if (!tracks[id]) continue; tracks[id] = tracks[id].filter((k) => k.t !== time); if (!tracks[id].length) delete tracks[id]; }
    get().dispatch([{ type: "doc.set", props: { animation: { ...st.doc.animation, tracks } } }], "Delete keyframe");
  },

  /** Apply a style to the selected characters of the text being edited; returns false when there is no range. */
  styleTextRange(props) {
    const st = get();
    const sel = st.textSelection;
    if (!st.doc || !sel || sel.end <= sel.start) return false;
    const l = findLayer(st.doc, sel.id);
    if (!l || l.type !== "text") return false;
    const runs = [...(l.runs ?? []), { start: sel.start, end: sel.end, ...props }];
    get().dispatch([{ type: "layer.set", id: l.id, props: { runs } }], "Character style");
    return true;
  },

  combineShapes(op) {
    const st = get();
    if (!st.doc) return;
    const order = [...walk(st.doc.layers)].map((w) => w.layer.id);
    const shapes = st.selection.map((id) => findLayer(st.doc!, id)).filter((l): l is import("@pictocity/core").ShapeLayer => !!l && l.type === "shape" && !l.locked).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    if (shapes.length < 2) { get().showToast("Select two or more shape layers"); return; }
    const result = combineShapesCore(shapes, op);
    if (!result) { get().showToast("The result would be empty"); return; }
    const top = findParent(st.doc, shapes[shapes.length - 1].id)!;
    get().dispatch([{ type: "layer.add", layer: result, parentId: top.parent?.id ?? null, index: top.index + 1 }, ...shapes.map((l) => ({ type: "layer.remove" as const, id: l.id }))], `Combine shapes (${op})`);
    get().select([result.id]);
  },

  convertToPath() {
    const st = get();
    if (!st.doc) return;
    const ops: Op[] = [];
    for (const id of st.selection) {
      const l = findLayer(st.doc, id);
      if (!l || l.type !== "shape" || l.shape === "path" || l.locked) continue;
      const anchors = shapeToAnchors(l);
      if (anchors) ops.push({ type: "layer.set", id, props: { shape: "path", path: anchorsToPath(anchors) } });
    }
    if (ops.length) { get().dispatch(ops, "Convert to path"); set({ tool: "direct" }); } else get().showToast("Select a rect, ellipse, polygon or star");
  },

  /** Photoshop's Alt+click between layers: clip the selected layers to the layer below them. */
  toggleClipping() {
    const st = get();
    if (!st.doc) return;
    const layers = st.selection.map((id) => findLayer(st.doc!, id)).filter((l): l is Layer => !!l && !l.locked);
    if (!layers.length) return;
    const clip = !layers.every((l) => l.clipToBelow);
    get().dispatch(layers.map((l) => ({ type: "layer.set" as const, id: l.id, props: { clipToBelow: clip ? true : null } })), clip ? "Create clipping mask" : "Release clipping mask");
  },

  /** Alt+click on an eye: show only this layer; Alt+click again restores what was visible before. */
  soloLayer(id) {
    const st = get();
    if (!st.doc) return;
    const all = [...walk(st.doc.layers)].map((w) => w.layer);
    const others = all.filter((l) => l.id !== id && findParent(st.doc!, l.id)?.parent === findParent(st.doc!, id)?.parent);
    const soloed = others.every((l) => !l.visible) && findLayer(st.doc, id)?.visible;
    if (soloed && soloVisibility) {
      const ops: Op[] = others.filter((l) => soloVisibility!.has(l.id)).map((l) => ({ type: "layer.set", id: l.id, props: { visible: true } }));
      soloVisibility = null;
      if (ops.length) get().dispatch(ops, "Unsolo");
      return;
    }
    soloVisibility = new Set(others.filter((l) => l.visible).map((l) => l.id));
    const ops: Op[] = others.filter((l) => l.visible).map((l) => ({ type: "layer.set", id: l.id, props: { visible: false } }));
    const self = findLayer(st.doc, id);
    if (self && !self.visible) ops.push({ type: "layer.set", id, props: { visible: true } });
    if (ops.length) get().dispatch(ops, "Solo layer");
  },

  saveComp(name, id) {
    const st = get();
    if (!st.doc) return;
    const comp = captureComp(st.doc, name, id);
    const comps = id ? (st.doc.comps ?? []).map((c) => (c.id === id ? comp : c)) : [...(st.doc.comps ?? []), comp];
    get().dispatch([{ type: "doc.set", props: { comps } }], id ? `Update comp ${name}` : `Save comp ${name}`);
  },

  applyComp(id) {
    const st = get();
    const c = st.doc?.comps?.find((x) => x.id === id);
    if (!st.doc || !c) return;
    const ops = applyCompOps(st.doc, c);
    if (ops.length) get().dispatch(ops, `Apply comp ${c.name}`); else get().showToast(`"${c.name}" is already applied`);
  },

  deleteComp(id) {
    const st = get();
    if (!st.doc) return;
    get().dispatch([{ type: "doc.set", props: { comps: (st.doc.comps ?? []).filter((c) => c.id !== id) } }], "Delete comp");
  },

  /** Copy the selected layers (and the assets they use) to the clipboard as JSON - works across documents on the same server. */
  copyLayers() {
    const st = get();
    if (!st.doc || !st.selection.length) return;
    const layers = topLevelOnly(st.doc, st.selection).map((id) => findLayer(st.doc!, id)).filter((l): l is Layer => !!l).map((l) => deepClone(l));
    const assets: Record<string, import("@pictocity/core").Asset> = {};
    const collect = (l: Layer) => { if (l.type === "image" && st.doc!.assets[l.assetId]) assets[l.assetId] = st.doc!.assets[l.assetId]; if (l.mask?.kind === "raster" && st.doc!.assets[l.mask.assetId]) assets[l.mask.assetId] = st.doc!.assets[l.mask.assetId]; if (l.styles?.patternOverlay?.assetId && st.doc!.assets[l.styles.patternOverlay.assetId]) assets[l.styles.patternOverlay.assetId] = st.doc!.assets[l.styles.patternOverlay.assetId]; if (isGroup(l)) l.children.forEach(collect); };
    layers.forEach(collect);
    const payload = JSON.stringify({ pictocity: 1, docId: st.doc.id, layers, assets });
    navigator.clipboard?.writeText(payload).catch(() => undefined);
    (window as unknown as { __pictocityClipboard?: string }).__pictocityClipboard = payload;
    get().showToast(`Copied ${layers.length} layer(s)`);
  },

  /** Image › Image Rotation: rotate the whole canvas, keeping every layer in place relative to it. */
  rotateCanvas(deg) {
    const st = get(); if (!st.doc) return;
    const d = st.doc, cx = d.width / 2, cy = d.height / 2;
    const swap = deg !== 180; const nw = swap ? d.height : d.width, nh = swap ? d.width : d.height;
    const members = [...walk(d.layers)].map((w) => w.layer);
    const ops: Op[] = rotateMembers(members, { x: cx, y: cy }, deg).map((m) => ({ type: "layer.set", id: m.id, props: m.props }));
    // Re-centre onto the new canvas.
    const dx = nw / 2 - cx, dy = nh / 2 - cy;
    for (const op of ops) if (op.type === "layer.set") { const p = op.props as Record<string, number>; if (typeof p.x === "number") p.x = Math.round((p.x + dx) * 10) / 10; if (typeof p.y === "number") p.y = Math.round((p.y + dy) * 10) / 10; }
    ops.unshift({ type: "doc.set", props: { width: nw, height: nh } });
    get().dispatch(ops, `Rotate canvas ${deg}°`);
  },

  /** Image › Adjustments › …: add the adjustment to the selected layers' filters, or as an adjustment layer when nothing is selected. */
  applyAdjustmentToSelection(kind, value) {
    const st = get(); if (!st.doc) return;
    const targets = st.selection.map((id) => findLayer(st.doc!, id)).filter((l): l is Layer => !!l && l.type !== "adjustment" && !isGroup(l));
    if (!targets.length) {
      const layer = makeAdjustment({ name: kind, width: st.doc.width, height: st.doc.height, adjustment: { [kind]: value } });
      get().dispatch([{ type: "layer.add", layer, parentId: null, index: st.doc.layers.length }], `Adjustment layer: ${kind}`); get().select([layer.id]); return;
    }
    get().dispatch(targets.map((l) => ({ type: "layer.set" as const, id: l.id, props: { filters: { ...(l.filters ?? {}), [kind]: value } } })), `Adjust: ${kind}`);
  },

  pasteLayers(payload, inPlace = false) {
    const st = get();
    if (!st.doc) return;
    const ops: Op[] = [];
    // Assets on this server are addressed by file, so another document can reference the same file.
    for (const a of Object.values(payload.assets)) if (!st.doc.assets[a.id]) ops.push({ type: "asset.add", asset: a });
    const sameDoc = payload.docId === st.doc.id;
    const ids: string[] = [];
    let index = st.doc.layers.length;
    for (const src of payload.layers) {
      const copy = cloneWithNewIds(src); copy.name = src.name;
      if (sameDoc && !inPlace) { copy.x += 20; copy.y += 20; for (const { layer } of walk(isGroup(copy) ? copy.children : [])) { layer.x += 20; layer.y += 20; } }
      ops.push({ type: "layer.add", layer: copy, parentId: null, index: index++ });
      ids.push(copy.id);
    }
    if (ops.length) { get().dispatch(ops, `Paste ${payload.layers.length} layer(s)`); get().select(ids); }
  },

  linkSelection(unlink = false) {
    const st = get();
    if (!st.doc) return;
    const layers = st.selection.map((id) => findLayer(st.doc!, id)).filter((l): l is Layer => !!l && !isGroup(l));
    if (layers.length < (unlink ? 1 : 2)) { get().showToast(unlink ? "Select linked layers" : "Select two or more layers to link"); return; }
    const linkId = unlink ? null : (layers.find((l) => l.linkId)?.linkId ?? uid("link"));
    get().dispatch(layers.map((l) => ({ type: "layer.set" as const, id: l.id, props: { linkId } })), unlink ? "Unlink layers" : "Link layers");
  },

  setFgColor(c) {
    const st = get();
    set({ fgColor: c, recentColors: [c, ...st.recentColors.filter((x) => x !== c)].slice(0, 16) });
  },

  invertPixelSelection() {
    const st = get();
    if (!st.doc || !st.pixelSelection) return;
    const sel = st.pixelSelection;
    // Invert within the artboard that contains the selection, else the whole canvas.
    const ab = st.doc.layers.find((l) => isGroup(l) && l.artboard && sel[0][0] >= l.x && sel[0][1] >= l.y && sel[0][0] < l.x + l.width && sel[0][1] < l.y + l.height);
    const f = ab ? { x: ab.x, y: ab.y, width: ab.width, height: ab.height } : { x: 0, y: 0, width: st.doc.width, height: st.doc.height };
    const frame = [[f.x, f.y, f.x + f.width, f.y, f.x + f.width, f.y + f.height, f.x, f.y + f.height]];
    get().setPixelSelection(combineSelections(frame, sel, "subtract"));
  },

  /** Replace / add (Shift) / subtract (Alt) / intersect the current selection with new rings. */
  setPixelSelection(rings, mode = "replace") {
    const st = get();
    const cur = st.pixelSelection;
    let next: number[][] | null;
    if (!rings || !rings.length) next = mode === "replace" ? null : cur;
    else if (mode === "replace" || !cur) next = mode === "subtract" || mode === "intersect" ? (cur ? null : null) : rings;
    else next = combineSelections(cur, rings, mode === "add" ? "add" : mode === "subtract" ? "subtract" : "intersect");
    if (next && !next.length) next = null;
    set({ pixelSelection: next, lastSelection: next ?? cur ?? st.lastSelection });
  },

  /** Expand / contract / smooth / border through raster morphology at a working resolution. */
  modifySelection(kind, px) {
    const st = get();
    if (!st.doc || !st.pixelSelection || px <= 0) return;
    const d = st.doc, scale = Math.min(1, 1600 / Math.max(d.width, d.height));
    const W = Math.ceil(d.width * scale), H = Math.ceil(d.height * scale), r = px * scale;
    const draw = (rings: number[][]) => { const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d")!; x.fillStyle = "#fff"; x.beginPath(); for (const ring of rings) { x.moveTo(ring[0] * scale, ring[1] * scale); for (let i = 2; i < ring.length; i += 2) x.lineTo(ring[i] * scale, ring[i + 1] * scale); x.closePath(); } x.fill("evenodd"); return c; };
    const dilate = (src: HTMLCanvasElement, rad: number) => { const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d")!; const steps = Math.max(8, Math.min(40, Math.round(rad * 2))); for (let ring = rad; ring > 0; ring -= Math.max(1, rad / 3)) for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; x.drawImage(src, Math.cos(a) * ring, Math.sin(a) * ring); } x.drawImage(src, 0, 0); return c; };
    const invert = (src: HTMLCanvasElement) => { const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d")!; x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); x.globalCompositeOperation = "destination-out"; x.drawImage(src, 0, 0); return c; };
    const erode = (src: HTMLCanvasElement, rad: number) => invert(dilate(invert(src), rad));
    let out: HTMLCanvasElement;
    const base = draw(st.pixelSelection);
    if (kind === "expand") out = dilate(base, r);
    else if (kind === "contract") out = erode(base, r);
    else if (kind === "smooth") out = dilate(erode(base, r), r);
    else { out = dilate(base, r); const x = out.getContext("2d")!; x.globalCompositeOperation = "destination-out"; x.drawImage(erode(base, r), 0, 0); }
    const px2 = out.getContext("2d")!.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) mask[i] = px2[i * 4 + 3] > 127 ? 1 : 0;
    const rings = traceRegions(mask, W, H, 1.2).map((ring) => ring.map((v) => Math.round((v / scale) * 10) / 10));
    get().setPixelSelection(rings.length ? rings : null);
  },

  selectAllPixels() {
    const st = get();
    if (!st.doc) return;
    const ab = st.selection.length ? artboardOf(st.doc, st.selection[0]) : null;
    const f = ab ? { x: ab.x, y: ab.y, width: ab.width, height: ab.height } : { x: 0, y: 0, width: st.doc.width, height: st.doc.height };
    get().setPixelSelection([[f.x, f.y, f.x + f.width, f.y, f.x + f.width, f.y + f.height, f.x, f.y + f.height]]);
  },

  /** Selection from a layer's transparency (Ctrl/Cmd-click its thumbnail). */
  selectionFromLayer(id, alpha) {
    const st = get();
    const l = st.doc ? findLayer(st.doc, id) : undefined;
    if (!l) return;
    const r = alpha(l);
    if (!r) { get().showToast("Layer isn't rendered yet"); return; }
    const W = r.canvas.width, H = r.canvas.height, px = r.canvas.getContext("2d")!.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) mask[i] = px[i * 4 + 3] > 8 ? 1 : 0;
    const rings = traceRegions(mask, W, H, 1.2).map((ring) => ring.map((v, i) => Math.round(((v + (i % 2 ? r.y : r.x)) / r.scale) * 10) / 10));
    get().setPixelSelection(rings.length ? rings : null);
  },

  saveSelection(name) {
    const st = get();
    if (!st.doc || !st.pixelSelection) return;
    const selections = [...(st.doc.selections ?? []).filter((x) => x.name !== name), { id: uid("sel"), name, rings: st.pixelSelection }];
    get().dispatch([{ type: "doc.set", props: { selections } }], `Save selection ${name}`);
  },

  loadSelection(id) {
    const st = get();
    const sel = st.doc?.selections?.find((x) => x.id === id);
    if (sel) get().setPixelSelection(sel.rings);
  },

  sendCursor(x, y) {
    const st = get();
    if (!st.doc) return;
    const now = Date.now();
    if (now - lastCursorSent < 120) return;
    lastCursorSent = now;
    send({ kind: "presence", docId: st.doc.id, selection: st.selection, cursor: { x, y } });
  },

  copyStyle() {
    const st = get(); const l = st.doc ? findLayer(st.doc, st.selection[st.selection.length - 1] ?? "") : undefined;
    if (!l) return;
    set({ styleClipboard: l.styles ? deepClone(l.styles) : {} });
    get().showToast(l.styles && Object.keys(l.styles).length ? "Layer style copied" : "Copied an empty style (paste to clear)");
  },

  pasteStyle() {
    const st = get();
    if (!st.doc || !st.styleClipboard) return;
    const ops: Op[] = st.selection.map((id) => ({ type: "layer.set", id, props: { styles: Object.keys(st.styleClipboard!).length ? deepClone(st.styleClipboard) : null } }));
    if (ops.length) get().dispatch(ops, "Paste layer style");
  },

  applyCrop() {
    const st = get();
    if (!st.doc || !st.cropRect) return;
    get().dispatch(cropOps(st.doc, st.cropRect), "Crop");
    set({ cropRect: null, tool: "move", pan: { x: st.pan.x + st.cropRect.x * st.zoom, y: st.pan.y + st.cropRect.y * st.zoom } });
  },

  setLayerProps(id, props, label, mergeKey) {
    const l = get().doc ? findLayer(get().doc!, id) : undefined;
    get().dispatch([{ type: "layer.set", id, props }], label ?? `Edit ${l?.name ?? "layer"}`, { mergeKey });
  },
}));

/** Like Photoshop: undoing a delete (or redoing an add) selects the layers that came back; removed layers drop out of the selection. */
function reselectAfter(ops: Op[]) {
  const st = useStore.getState();
  if (!st.doc) return;
  const added = ops.filter((o): o is Extract<Op, { type: "layer.add" }> => o.type === "layer.add").map((o) => o.layer.id);
  const selection = added.length ? added : st.selection.filter((id) => findLayer(st.doc!, id));
  if (selection.join() !== st.selection.join()) st.select(selection);
}

/** Drop ids whose ancestor is also selected so tree ops don't double up. */
export function topLevelOnly(doc: AdDocument, ids: string[]): string[] {
  return ids.filter((id) => {
    for (const other of ids) {
      if (other === id) continue;
      const o = findLayer(doc, other);
      if (o && isGroup(o) && [...walk(o.children)].some((w) => w.layer.id === id)) return false;
    }
    return true;
  });
}

export function unionBounds(layers: Layer[]) {
  const bs = layers.map(layerBounds);
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return { x, y, width: Math.max(...bs.map((b) => b.x + b.width)) - x, height: Math.max(...bs.map((b) => b.y + b.height)) - y };
}

export const selectedLayers = (s: State): Layer[] => (s.doc ? s.selection.map((id) => findLayer(s.doc!, id)).filter((l): l is Layer => !!l) : []);
