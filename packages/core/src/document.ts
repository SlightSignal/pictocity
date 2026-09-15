import polygonClipping from "polygon-clipping";
import type {
  AdDocument, Asset, GroupLayer, Layer, Op, TextLayer, ShapeLayer, ImageLayer, FillLayer, AdjustmentLayer, BrushLayer, LayerComp, Keyframe, BlendMode, LayerStyles, TextRun,
} from "./types.js";
import { BLEND_MODES } from "./types.js";

let counter = 0;
export function uid(prefix = "l"): string {
  counter = (counter + 1) % 0xffff;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function nowIso(): string { return new Date().toISOString(); }

export const MAX_DIMENSION = 8192;

/** Clamp a document dimension to something every renderer can allocate. */
export function clampDimension(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_DIMENSION, Math.max(1, n)) : fallback;
}

export function createDocument(init: Partial<Pick<AdDocument, "name" | "width" | "height" | "background" | "id">> = {}): AdDocument {
  const t = nowIso();
  return {
    version: 1,
    id: init.id ?? uid("doc"),
    name: init.name ?? "Untitled",
    width: clampDimension(init.width, 1080),
    height: clampDimension(init.height, 1080),
    background: init.background === undefined ? "#ffffff" : init.background,
    layers: [],
    assets: {},
    guides: [],
    rev: 0,
    createdAt: t,
    updatedAt: t,
  };
}

const base = (name: string, type: Layer["type"]) => ({
  id: uid(), name, type, visible: true, locked: false, opacity: 1, blend: "normal" as const,
  x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1,
});

export function makeText(p: Partial<TextLayer> & { text: string }): TextLayer {
  return {
    ...base(p.name ?? p.text.slice(0, 24), "text"), type: "text",
    fontFamily: "Poppins", fontSize: 64, fontWeight: 700, fontStyle: "normal", color: "#111111",
    align: "left", verticalAlign: "top", lineHeight: 1.15, letterSpacing: 0, wrap: true,
    width: 600, height: 120,
    ...p,
  } as TextLayer;
}

export function makeShape(p: Partial<ShapeLayer> = {}): ShapeLayer {
  return {
    ...base(p.name ?? "Shape", "shape"), type: "shape", shape: "rect", fill: "#4f6df5", strokeColor: null, strokeWidth: 0, radius: 0,
    width: 300, height: 200,
    ...p,
  } as ShapeLayer;
}

export function makeImage(p: Partial<ImageLayer> & { assetId: string }): ImageLayer {
  return { ...base(p.name ?? "Image", "image"), type: "image", fit: "cover", ...p } as ImageLayer;
}

export function makeFill(p: Partial<FillLayer> = {}): FillLayer {
  return { ...base(p.name ?? "Fill", "fill"), type: "fill", fill: { kind: "solid", color: "#ffffff" }, ...p } as FillLayer;
}

export function makeAdjustment(p: Partial<AdjustmentLayer> = {}): AdjustmentLayer {
  return { ...base(p.name ?? "Adjustment", "adjustment"), type: "adjustment", adjustment: {}, ...p } as AdjustmentLayer;
}

export function makeBrush(p: Partial<BrushLayer> = {}): BrushLayer {
  return { ...base(p.name ?? "Paint", "brush"), type: "brush", strokes: [], ...p } as BrushLayer;
}

export function makeGroup(p: Partial<GroupLayer> = {}): GroupLayer {
  return { ...base(p.name ?? "Group", "group"), type: "group", children: [], ...p } as GroupLayer;
}

/** An artboard with its own locked background fill. */
export function makeArtboard(p: Partial<GroupLayer> & { width: number; height: number; background?: string | null }): GroupLayer {
  const { background = "#ffffff", ...rest } = p;
  const bg = makeFill({ name: "Background", x: 0, y: 0, width: p.width, height: p.height, fill: { kind: "solid", color: background ?? "#ffffff" }, locked: true, visible: background !== null });
  return makeGroup({ name: p.name ?? "Artboard", x: 0, y: 0, children: [bg], ...rest, artboard: true });
}

export function artboards(doc: AdDocument): GroupLayer[] {
  return doc.layers.filter((l): l is GroupLayer => isGroup(l) && !!l.artboard);
}

export const PASTEBOARD = "#3b3b3b";

/** The artboard a layer lives in (its top-level ancestor if that is an artboard). */
export function artboardOf(doc: AdDocument, id: string): GroupLayer | null {
  let cur = id;
  for (;;) {
    const loc = findParent(doc, cur);
    if (!loc) return null;
    if (!loc.parent) { const top = findLayer(doc, cur); return top && isGroup(top) && top.artboard ? top : null; }
    cur = loc.parent.id;
  }
}

/** Scale a layer tree by `s` mapping the `from` frame onto the `to` frame (positions, sizes, type, effects). */
export function rescaleLayerTree(root: Layer, s: number, from: { x: number; y: number }, to: { x: number; y: number }) {
  const visit = (l: Layer) => {
    l.x = Math.round((to.x + (l.x - from.x) * s) * 10) / 10; l.y = Math.round((to.y + (l.y - from.y) * s) * 10) / 10;
    l.width = Math.round(l.width * s * 10) / 10; l.height = Math.round(l.height * s * 10) / 10;
    if (l.type === "text") { l.fontSize = Math.round(l.fontSize * s * 10) / 10; l.letterSpacing = Math.round(l.letterSpacing * s * 10) / 10; }
    if (l.type === "shape") { if (l.radius) l.radius *= s; if (l.strokeWidth) l.strokeWidth *= s; }
    if (l.type === "brush") l.strokes = l.strokes.map((st) => ({ ...st, size: st.size * s, points: st.points.map((v) => v * s) }));
    if (l.mask?.kind === "shape") l.mask = { ...l.mask, x: l.mask.x * s, y: l.mask.y * s, width: l.mask.width * s, height: l.mask.height * s, feather: (l.mask.feather ?? 0) * s, radius: (l.mask.radius ?? 0) * s };
    if (l.mask?.kind === "paint") l.mask = { ...l.mask, strokes: l.mask.strokes.map((st) => ({ ...st, size: st.size * s, points: st.points.map((v) => v * s) })) };
    if (l.styles) {
      if (l.styles.dropShadow) { l.styles.dropShadow.blur *= s; l.styles.dropShadow.x *= s; l.styles.dropShadow.y *= s; }
      if (l.styles.innerShadow) { l.styles.innerShadow.blur *= s; l.styles.innerShadow.x *= s; l.styles.innerShadow.y *= s; }
      if (l.styles.outerGlow) l.styles.outerGlow.size *= s;
      if (l.styles.innerGlow) l.styles.innerGlow.size *= s;
      if (l.styles.stroke) l.styles.stroke.size *= s;
    }
    if (isGroup(l)) l.children.forEach(visit);
  };
  visit(root);
}

/**
 * Copy layers into another artboard, keeping their position relative to the source frame
 * (and optionally scaling them to fit the target frame). Used to build an ad set from one design.
 */
export function copyToArtboardOps(doc: AdDocument, ids: string[], targetId: string, opts: { fit?: boolean; link?: boolean } = {}): { ops: Op[]; newIds: string[] } {
  const target = findLayer(doc, targetId);
  if (!target || !isGroup(target) || !target.artboard) throw new OpError(`${targetId} is not an artboard`);
  const ops: Op[] = []; const newIds: string[] = [];
  let index = target.children.length;
  for (const id of ids) {
    const l = findLayer(doc, id);
    if (!l || l.id === target.id) continue;
    const src = artboardOf(doc, id);
    const from = src ? { x: src.x, y: src.y, width: src.width, height: src.height } : { x: 0, y: 0, width: doc.width, height: doc.height };
    const s = opts.fit ? Math.min(target.width / from.width, target.height / from.height) : 1;
    const copy = cloneWithNewIds(l);
    copy.name = l.name;
    if (opts.link) {
      // Link source and copy (and their descendants pairwise) so content edits follow.
      const pair = (a: Layer, b: Layer) => {
        if (!isGroup(a)) { const linkId = a.linkId ?? uid("link"); if (!a.linkId) ops.push({ type: "layer.set", id: a.id, props: { linkId } }); b.linkId = linkId; }
        if (isGroup(a) && isGroup(b)) a.children.forEach((c, i) => b.children[i] && pair(c, b.children[i]));
      };
      pair(l, copy);
    }
    const coversFrame = Math.abs(l.x - from.x) < 1 && Math.abs(l.y - from.y) < 1 && Math.abs(l.width - from.width) < 1 && Math.abs(l.height - from.height) < 1 && !l.rotation;
    if (opts.fit && coversFrame && (l.type === "fill" || l.type === "adjustment" || l.type === "image")) {
      // Backgrounds stretch to the new frame instead of leaving bands.
      Object.assign(copy, { x: target.x, y: target.y, width: target.width, height: target.height });
    } else rescaleLayerTree(copy, s, from, { x: target.x + (opts.fit ? (target.width - from.width * s) / 2 : 0), y: target.y + (opts.fit ? (target.height - from.height * s) / 2 : 0) });
    ops.push({ type: "layer.add", layer: copy, parentId: target.id, index: index++ });
    newIds.push(copy.id);
  }
  return { ops, newIds };
}

/**
 * Ops that add a new artboard to the right of the existing ones and grow the document (the pasteboard) to fit.
 * The first artboard also turns the document background into a pasteboard grey.
 */
export function addArtboardOps(doc: AdDocument, init: { name?: string; width: number; height: number; background?: string | null; adoptExisting?: boolean }): { ops: Op[]; artboard: GroupLayer } {
  const existing = artboards(doc);
  const gap = 100;
  const x = existing.length ? Math.max(...existing.map((a) => a.x + a.width)) + gap : 0;
  const artboard = makeArtboard({ name: init.name ?? `Artboard ${existing.length + 1}`, width: init.width, height: init.height, background: init.background, x, y: 0 });
  // Children are positioned in document space, so move the background with the frame.
  for (const c of artboard.children) { c.x += x; }
  const ops: Op[] = [{ type: "layer.add", layer: artboard, parentId: null, index: doc.layers.length }];
  if (init.adoptExisting) {
    // "Artboard from layers": the current top-level layers move into the new artboard, above its background.
    const loose = doc.layers.filter((l) => !(isGroup(l) && l.artboard));
    loose.forEach((l, i) => ops.push({ type: "layer.move", id: l.id, parentId: artboard.id, index: 1 + i }));
    if (!init.background && doc.background && !existing.length) ops.push({ type: "layer.set", id: artboard.children[0].id, props: { fill: { kind: "solid", color: doc.background } } });
  }
  const props: Partial<Pick<AdDocument, "width" | "height" | "background">> = {};
  if (x + init.width > doc.width || !existing.length) props.width = Math.min(MAX_DIMENSION, Math.max(existing.length ? doc.width : 0, x + init.width));
  if (init.height > doc.height || !existing.length) props.height = Math.min(MAX_DIMENSION, Math.max(existing.length ? doc.height : 0, init.height));
  if (!existing.length) props.background = PASTEBOARD;
  if (Object.keys(props).length) ops.push({ type: "doc.set", props });
  return { ops, artboard };
}

// ---- Tree navigation ---------------------------------------------------------

export function isGroup(l: Layer): l is GroupLayer { return l.type === "group"; }

export function* walk(layers: Layer[], parent: GroupLayer | null = null, depth = 0): Generator<{ layer: Layer; parent: GroupLayer | null; depth: number; index: number }> {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    yield { layer, parent, depth, index: i };
    if (isGroup(layer)) yield* walk(layer.children, layer, depth + 1);
  }
}

export function findLayer(doc: AdDocument, id: string): Layer | undefined {
  for (const { layer } of walk(doc.layers)) if (layer.id === id) return layer;
  return undefined;
}

export function findParent(doc: AdDocument, id: string): { parent: GroupLayer | null; siblings: Layer[]; index: number } | undefined {
  for (const { layer, parent, index } of walk(doc.layers)) {
    if (layer.id === id) return { parent, siblings: parent ? parent.children : doc.layers, index };
  }
  return undefined;
}

export function containerOf(doc: AdDocument, parentId: string | null): Layer[] | undefined {
  if (parentId === null) return doc.layers;
  const p = findLayer(doc, parentId);
  return p && isGroup(p) ? p.children : undefined;
}

export function flatten(doc: AdDocument): Layer[] {
  return [...walk(doc.layers)].map((w) => w.layer);
}

export function isDescendant(doc: AdDocument, ancestorId: string, id: string): boolean {
  const a = findLayer(doc, ancestorId);
  if (!a || !isGroup(a)) return false;
  for (const { layer } of walk(a.children)) if (layer.id === id) return true;
  return false;
}

export function deepClone<T>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

/** Optional object properties: setting them to null removes them (JSON has no undefined). */
const CLEARABLE = new Set(["mask", "styles", "filters", "crop", "tags", "textTransform", "path", "dash", "arrows", "linkId", "pressures", "radii", "onPath", "clipToBelow", "vertical", "runs", "quad", "baselineShift", "textScaleX", "textScaleY", "kerning"]);

/** Clone a layer subtree with fresh ids (for duplicate). */
export function cloneWithNewIds(layer: Layer): Layer {
  const c = deepClone(layer);
  const rename = (l: Layer) => { l.id = uid(); if (isGroup(l)) l.children.forEach(rename); };
  rename(c);
  c.name = `${layer.name} copy`;
  return c;
}

// ---- Ops ------------------------------------------------------------------------

export class OpError extends Error {}

/**
 * Apply one op to a document in place and return its inverse.
 * Throws OpError when the op is invalid; the doc is left unchanged in that case.
 */
const LAYER_TYPES = new Set(["text", "shape", "image", "fill", "adjustment", "brush", "group"]);
const NUMERIC_LAYER_KEYS = ["x", "y", "width", "height", "rotation", "scaleX", "scaleY", "opacity", "fillOpacity", "fontSize", "lineHeight", "letterSpacing", "strokeWidth", "radius", "sides", "innerRadius", "baselineShift", "textScaleX", "textScaleY"];
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** Reject values that would poison the document: non-finite numbers, unknown types, wrong shapes. */
const REQUIRED_NUMERIC = new Set(["x", "y", "width", "height", "rotation", "scaleX", "scaleY", "opacity", "fontSize", "lineHeight", "letterSpacing", "strokeWidth"]);
const REQUIRED_OTHER = new Set(["name", "visible", "locked", "blend", "text", "fontFamily", "color", "assetId", "strokes", "adjustment", "shape", "align", "verticalAlign", "wrap"]);

function validateProps(props: Record<string, unknown>): void {
  for (const k of NUMERIC_LAYER_KEYS) {
    if (!(k in props)) continue;
    const v = props[k];
    if (v === null) { if (REQUIRED_NUMERIC.has(k)) throw new OpError(`${k} can't be cleared`); continue; } // null clears an optional prop (undo relies on this)
    if (!finite(v)) throw new OpError(`${k} must be a finite number`);
  }
  for (const k of REQUIRED_OTHER) if (k in props && (props[k] === null || props[k] === undefined)) throw new OpError(`${k} can't be cleared`);
  if (finite(props.opacity)) props.opacity = Math.max(0, Math.min(1, props.opacity as number));
  if (finite(props.fillOpacity)) props.fillOpacity = Math.max(0, Math.min(1, props.fillOpacity as number));
  if (finite(props.width) && (props.width as number) <= 0) throw new OpError("width must be positive");
  if (finite(props.height) && (props.height as number) <= 0) throw new OpError("height must be positive");
  if (finite(props.fontSize) && (props.fontSize as number) <= 0) throw new OpError("fontSize must be positive");
  if ("blend" in props && !BLEND_MODES.includes(props.blend as BlendMode)) throw new OpError(`unknown blend mode ${String(props.blend)}`);
  if ("text" in props && typeof props.text !== "string") throw new OpError("text must be a string");
  if ("strokes" in props && !Array.isArray(props.strokes)) throw new OpError("strokes must be an array");
  if ("children" in props) throw new OpError("children can't be set directly - use layer.add / layer.move");
}

/** Fill in defaults and drop garbage so any incoming layer is safe to render. */
export function normalizeLayer(raw: unknown): Layer {
  if (!raw || typeof raw !== "object") throw new OpError("layer must be an object");
  const l = raw as Record<string, unknown>;
  if (!LAYER_TYPES.has(String(l.type))) throw new OpError(`unknown layer type ${String(l.type)}`);
  if (typeof l.id !== "string" || !l.id) l.id = uid("l");
  if (typeof l.name !== "string") l.name = String(l.type);
  for (const [k, d] of [["x", 0], ["y", 0], ["width", 100], ["height", 100], ["rotation", 0], ["scaleX", 1], ["scaleY", 1], ["opacity", 1]] as [string, number][]) if (!finite(l[k])) l[k] = d;
  if (l.scaleX === 0) l.scaleX = 1; if (l.scaleY === 0) l.scaleY = 1;
  if ((l.width as number) <= 0) l.width = 1; if ((l.height as number) <= 0) l.height = 1;
  l.opacity = Math.max(0, Math.min(1, l.opacity as number));
  l.visible = l.visible !== false; l.locked = l.locked === true;
  if (!BLEND_MODES.includes(l.blend as BlendMode)) l.blend = "normal";
  switch (l.type) {
    case "text": { if (typeof l.text !== "string") l.text = ""; if (!finite(l.fontSize) || (l.fontSize as number) <= 0) l.fontSize = 32; if (typeof l.fontFamily !== "string") l.fontFamily = "Poppins"; if (!finite(l.lineHeight) || (l.lineHeight as number) <= 0) l.lineHeight = 1.2; if (!finite(l.letterSpacing)) l.letterSpacing = 0; if (typeof l.color !== "string") l.color = "#000000"; if (!["left", "center", "right", "justify"].includes(String(l.align))) l.align = "left"; if (!["top", "middle", "bottom"].includes(String(l.verticalAlign))) l.verticalAlign = "top"; if (l.fontWeight === undefined) l.fontWeight = 400; if (l.fontStyle !== "italic") l.fontStyle = "normal"; if (typeof l.wrap !== "boolean") l.wrap = true; break; }
    case "shape": { if (!["rect", "ellipse", "line", "polygon", "star", "path"].includes(String(l.shape))) l.shape = "rect"; if (!finite(l.strokeWidth) || (l.strokeWidth as number) < 0) l.strokeWidth = 0; if (l.fill !== null && typeof l.fill !== "string") l.fill = "#000000"; if (l.strokeColor !== null && l.strokeColor !== undefined && typeof l.strokeColor !== "string") l.strokeColor = null; break; }
    case "image": { if (typeof l.assetId !== "string") throw new OpError("image layer needs assetId"); if (!["cover", "contain", "fill"].includes(String(l.fit))) l.fit = "cover"; break; }
    case "fill": { const f = l.fill as { kind?: string } | undefined; if (!f || typeof f !== "object" || !["solid", "linear", "radial", "pattern", "gradient"].includes(String(f.kind))) l.fill = { kind: "solid", color: "#ffffff" }; break; }
    case "brush": { const strokes = Array.isArray(l.strokes) ? l.strokes : []; l.strokes = strokes.filter((st) => st && Array.isArray((st as { points?: unknown }).points) && ((st as { points: unknown[] }).points).every(finite) && finite((st as { size?: unknown }).size)).map((st) => ({ opacity: 1, hardness: 1, color: "#000000", ...(st as object) })); break; }
    case "adjustment": { if (!l.adjustment || typeof l.adjustment !== "object") l.adjustment = {}; break; }
    case "group": { l.children = Array.isArray(l.children) ? (l.children as unknown[]).map(normalizeLayer) : []; break; }
  }
  if (l.styles !== undefined && l.styles !== null && typeof l.styles !== "object") delete l.styles;
  if (l.filters !== undefined && l.filters !== null && typeof l.filters !== "object") delete l.filters;
  return l as unknown as Layer;
}

export function applyOp(doc: AdDocument, op: Op): Op {
  if (!op || typeof op !== "object" || typeof (op as { type?: unknown }).type !== "string") throw new OpError("op must be an object with a type");
  switch (op.type) {
    case "doc.set": {
      for (const k of ["width", "height"] as const) {
        if (k in op.props) {
          const v = op.props[k];
          if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > MAX_DIMENSION) throw new OpError(`${k} must be between 1 and ${MAX_DIMENSION}`);
        }
      }
      // Absent properties are recorded as null so the inverse can remove them again (JSON drops undefined).
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(op.props) as (keyof typeof op.props)[]) prev[k] = (doc as any)[k] === undefined ? null : deepClone((doc as any)[k]);
      for (const [k, v] of Object.entries(deepClone(op.props))) { if (v === null || v === undefined) delete (doc as any)[k]; else (doc as any)[k] = v; }
      return { type: "doc.set", props: prev as any };
    }
    case "layer.add": {
      normalizeLayer(op.layer);
      if (findLayer(doc, op.layer.id)) throw new OpError(`Layer ${op.layer.id} already exists`);
      const list = containerOf(doc, op.parentId);
      if (!list) throw new OpError(`Parent ${op.parentId} is not a group`);
      const index = Math.max(0, Math.min(op.index, list.length));
      list.splice(index, 0, deepClone(op.layer));
      return { type: "layer.remove", id: op.layer.id };
    }
    case "layer.remove": {
      const loc = findParent(doc, op.id);
      if (!loc) throw new OpError(`Layer ${op.id} not found`);
      const [removed] = loc.siblings.splice(loc.index, 1);
      return { type: "layer.add", layer: removed, parentId: loc.parent?.id ?? null, index: loc.index };
    }
    case "layer.set": {
      const layer = findLayer(doc, op.id);
      if (!layer) throw new OpError(`Layer ${op.id} not found`);
      validateProps(op.props as Record<string, unknown>);
      if (layer.type === "text" && typeof op.props.text === "string" && (layer as TextLayer).runs?.length && !("runs" in op.props)) {
        (op.props as Record<string, unknown>).runs = remapRuns((layer as TextLayer).text, op.props.text as string, (layer as TextLayer).runs) ?? null;
      }
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(op.props)) {
        if (k === "id" || k === "type" || k === "children") continue;
        const old = (layer as any)[k];
        prev[k] = old === undefined ? null : deepClone(old);
        const v = op.props[k];
        // null clears an optional property (required ones were already rejected by validateProps), so undo is exact.
        if (v === null || v === undefined) delete (layer as any)[k];
        else (layer as any)[k] = deepClone(v);
      }
      return { type: "layer.set", id: op.id, props: prev };
    }
    case "layer.move": {
      const loc = findParent(doc, op.id);
      if (!loc) throw new OpError(`Layer ${op.id} not found`);
      if (op.parentId === op.id || (op.parentId && isDescendant(doc, op.id, op.parentId))) throw new OpError("Cannot move a layer into itself");
      const inverse: Op = { type: "layer.move", id: op.id, parentId: loc.parent?.id ?? null, index: loc.index };
      const [layer] = loc.siblings.splice(loc.index, 1);
      const target = containerOf(doc, op.parentId);
      if (!target) { loc.siblings.splice(loc.index, 0, layer); throw new OpError(`Target ${op.parentId} is not a group`); }
      const index = Math.max(0, Math.min(op.index, target.length));
      target.splice(index, 0, layer);
      return inverse;
    }
    case "layer.push": {
      const layer = findLayer(doc, op.id);
      if (!layer) throw new OpError(`Layer ${op.id} not found`);
      const arr = (layer as any)[op.key];
      if (!Array.isArray(arr)) throw new OpError(`${op.key} is not a list`);
      arr.push(...deepClone(op.items));
      return { type: "layer.splice", id: op.id, key: op.key, index: arr.length - op.items.length, count: op.items.length };
    }
    case "layer.splice": {
      const layer = findLayer(doc, op.id);
      if (!layer) throw new OpError(`Layer ${op.id} not found`);
      const arr = (layer as any)[op.key];
      if (!Array.isArray(arr)) throw new OpError(`${op.key} is not a list`);
      const removed = arr.splice(op.index, op.count, ...deepClone(op.items ?? []));
      return { type: "layer.splice", id: op.id, key: op.key, index: op.index, count: op.items?.length ?? 0, items: removed };
    }
    case "asset.add": {
      const prev = doc.assets[op.asset.id];
      doc.assets[op.asset.id] = deepClone(op.asset);
      return prev ? { type: "asset.add", asset: prev } : { type: "asset.remove", id: op.asset.id };
    }
    case "asset.remove": {
      const prev = doc.assets[op.id];
      if (!prev) throw new OpError(`Asset ${op.id} not found`);
      delete doc.assets[op.id];
      return { type: "asset.add", asset: prev };
    }
    default: throw new OpError(`unknown op type ${String((op as { type?: unknown }).type)}`);
  }
}

export function applyOps(doc: AdDocument, ops: Op[]): Op[] {
  const snapshot = deepClone(doc);
  const inverse: Op[] = [];
  try {
    for (const op of ops) inverse.unshift(applyOp(doc, op));
  } catch (e) {
    Object.assign(doc, snapshot);
    throw e;
  }
  doc.updatedAt = nowIso();
  return inverse;
}

export function asset(doc: AdDocument, id: string): Asset | undefined { return doc.assets[id]; }

// ---- Geometry -----------------------------------------------------------------

export interface Point { x: number; y: number }

/** Local (untransformed) point → document space, honouring rotation and scale. */
export function localToDocument(l: Layer, q: Point): Point {
  const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
  const r = (l.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = (q.x - l.width / 2) * l.scaleX, dy = (q.y - l.height / 2) * l.scaleY;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** The four corners of a layer's box after its transform (and quad distortion), in document space. */
export function layerCorners(l: Layer): Point[] {
  const q = l.quad ?? [0, 0, 0, 0, 0, 0, 0, 0];
  const local: Point[] = [{ x: q[0], y: q[1] }, { x: l.width + q[2], y: q[3] }, { x: l.width + q[4], y: l.height + q[5] }, { x: q[6], y: l.height + q[7] }];
  return local.map((p) => localToDocument(l, p));
}

/** 3x3 homography mapping four source points onto four destination points (row-major). */
export function homography(src: Point[], dst: Point[]): number[] {
  // Solve for h (8 unknowns) with Gaussian elimination.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c] || 1e-12;
    for (let k = c; k < 9; k++) A[c][k] /= d;
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c]; for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]; }
  }
  return [A[0][8], A[1][8], A[2][8], A[3][8], A[4][8], A[5][8], A[6][8], A[7][8], 1];
}

export function applyHomography(h: number[], p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8] || 1e-12;
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

export function layerBounds(l: Layer): { x: number; y: number; width: number; height: number } {
  const pts = layerCorners(l);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Convert a document-space point into a layer's local (untransformed) coordinates. */
export function toLocal(l: Layer, p: Point): Point {
  const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
  const r = (-l.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - cx, dy = p.y - cy;
  const lx = (dx * cos - dy * sin) / (l.scaleX || 1e-6), ly = (dx * sin + dy * cos) / (l.scaleY || 1e-6);
  return { x: lx + l.width / 2, y: ly + l.height / 2 };
}

export function hitTest(l: Layer, p: Point): boolean {
  const q = toLocal(l, p);
  return q.x >= 0 && q.y >= 0 && q.x <= l.width && q.y <= l.height;
}

/** Top-most visible, unlocked layer under a point (searching groups' children). */
export function pickLayer(doc: AdDocument, p: Point, opts: { includeLocked?: boolean; enterGroups?: boolean; pixelTest?: (layer: Layer, p: Point) => boolean | undefined } = {}): Layer | undefined {
  const search = (layers: Layer[]): Layer | undefined => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (!l.visible) continue;
      if (isGroup(l)) {
        const inner = search(l.children);
        if (inner) return opts.enterGroups ? inner : l;
        continue;
      }
      if (l.type === "adjustment") continue;
      if (l.locked && !opts.includeLocked) continue;
      if (hitTest(l, p)) {
        // Like Photoshop's auto-select: a transparent spot of a layer doesn't count as a hit.
        if (opts.pixelTest && opts.pixelTest(l, p) === false) continue;
        return l;
      }
    }
    return undefined;
  };
  return search(doc.layers);
}

/**
 * Ops that resize the canvas and scale the layout to fit the new size (uniformly, centred),
 * so one ad can be turned into another format. Full-canvas backgrounds are stretched to the new size.
 */
export function resizeLayoutOps(doc: AdDocument, width: number, height: number, opts: { scaleContent?: boolean } = {}): Op[] {
  const ops: Op[] = [{ type: "doc.set", props: { width, height } }];
  if (opts.scaleContent === false) return ops;
  const W = doc.width, H = doc.height;
  const s = Math.min(width / W, height / H);
  const ox = (width - W * s) / 2, oy = (height - H * s) / 2;
  const isFullCanvas = (l: Layer) => Math.abs(l.x) < 1 && Math.abs(l.y) < 1 && Math.abs(l.width - W) < 1 && Math.abs(l.height - H) < 1 && !l.rotation;
  for (const { layer: l } of walk(doc.layers)) {
    const props: Record<string, unknown> = {};
    if (isFullCanvas(l) && (l.type === "fill" || l.type === "adjustment" || l.type === "image" || l.type === "brush")) {
      props.width = width; props.height = height;
      if (l.type === "brush") props.x = ox; // keep strokes aligned with the scaled content
    } else {
      props.x = Math.round((l.x * s + ox) * 10) / 10; props.y = Math.round((l.y * s + oy) * 10) / 10;
      props.width = Math.round(l.width * s * 10) / 10; props.height = Math.round(l.height * s * 10) / 10;
    }
    if (l.type === "text") { props.fontSize = Math.round(l.fontSize * s * 10) / 10; props.letterSpacing = Math.round(l.letterSpacing * s * 10) / 10; }
    if (l.type === "shape") { if (l.radius) props.radius = l.radius * s; if (l.strokeWidth) props.strokeWidth = l.strokeWidth * s; }
    if (l.type === "brush") props.strokes = l.strokes.map((st) => ({ ...st, size: st.size * s, points: st.points.map((v) => v * s) }));
    if (l.mask?.kind === "shape") props.mask = { ...l.mask, x: l.mask.x * s, y: l.mask.y * s, width: l.mask.width * s, height: l.mask.height * s, feather: (l.mask.feather ?? 0) * s, radius: (l.mask.radius ?? 0) * s };
    if (l.mask?.kind === "paint") props.mask = { ...l.mask, strokes: l.mask.strokes.map((st) => ({ ...st, size: st.size * s, points: st.points.map((v) => v * s) })) };
    if (l.styles) {
      const st = deepClone(l.styles);
      if (st.dropShadow) { st.dropShadow.blur *= s; st.dropShadow.x *= s; st.dropShadow.y *= s; }
      if (st.outerGlow) st.outerGlow.size *= s;
      if (st.stroke) st.stroke.size *= s;
      props.styles = st;
    }
    ops.push({ type: "layer.set", id: l.id, props });
  }
  return ops;
}

/** Ops that crop the canvas to a rectangle (document pixels), shifting every layer and guide. */
export function cropOps(doc: AdDocument, rect: { x: number; y: number; width: number; height: number }): Op[] {
  const x = Math.round(rect.x), y = Math.round(rect.y);
  const width = clampDimension(rect.width, doc.width), height = clampDimension(rect.height, doc.height);
  const ops: Op[] = [{ type: "doc.set", props: { width, height, guides: doc.guides.map((g) => ({ axis: g.axis, position: g.position - (g.axis === "x" ? x : y) })) } }];
  for (const { layer: l } of walk(doc.layers)) ops.push({ type: "layer.set", id: l.id, props: { x: l.x - x, y: l.y - y } });
  return ops;
}

/** Mirror a layer (and, for groups, every descendant around the group's centre). */
export function flipOps(doc: AdDocument, id: string, axis: "x" | "y"): Op[] {
  const l = findLayer(doc, id);
  if (!l) return [];
  const mirror = (m: Layer, cx: number, cy: number): Op => {
    const props: Record<string, unknown> = { rotation: -m.rotation };
    if (axis === "x") { props.scaleX = -m.scaleX; props.x = Math.round((2 * cx - m.x - m.width) * 10) / 10; }
    else { props.scaleY = -m.scaleY; props.y = Math.round((2 * cy - m.y - m.height) * 10) / 10; }
    return { type: "layer.set", id: m.id, props };
  };
  if (isGroup(l)) {
    const kids = [...walk(l.children)].map((w) => w.layer);
    const boxes = kids.filter((k) => !isGroup(k)).map(layerBounds);
    if (!boxes.length) return [];
    const x0 = Math.min(...boxes.map((b) => b.x)), x1 = Math.max(...boxes.map((b) => b.x + b.width));
    const y0 = Math.min(...boxes.map((b) => b.y)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return kids.map((k) => mirror(k, cx, cy));
  }
  const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
  return [mirror(l, cx, cy)];
}

/** Bounding box of a flat [x,y,...] polygon. */
export function polygonBounds(points: number[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < points.length; i += 2) { x0 = Math.min(x0, points[i]); x1 = Math.max(x1, points[i]); y0 = Math.min(y0, points[i + 1]); y1 = Math.max(y1, points[i + 1]); }
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** Normalise a document-space polygon into a 0..1 SVG path for a path shape layer. */
export function polygonToPath(points: number[]): { path: string; x: number; y: number; width: number; height: number } {
  return ringsToPath([points]);
}

/** Several rings (areas and holes) into one normalised path; render with even-odd. */
export function ringsToPath(rings: number[][]): { path: string; x: number; y: number; width: number; height: number } {
  const b = polygonBounds(rings.flat());
  const parts: string[] = [];
  for (const points of rings) { for (let i = 0; i < points.length; i += 2) parts.push(`${i ? "L" : "M"}${((points[i] - b.x) / b.width).toFixed(4)} ${((points[i + 1] - b.y) / b.height).toFixed(4)}`); parts.push("Z"); }
  return { path: parts.join(" "), ...b };
}

type PC = [number, number][][][];
const toPC = (rings: number[][]): PC => rings.map((r) => { const pts: [number, number][] = []; for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]]); return [pts]; });
const fromPC = (mp: PC): number[][] => mp.flatMap((poly) => poly.map((ring) => ring.flatMap((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10])));

/** Boolean combination of selections (rings in document space). */
export function combineSelections(a: number[][], b: number[][], op: "add" | "subtract" | "intersect" | "xor"): number[][] {
  const A = toPC(a) as unknown as polygonClipping.MultiPolygon, B = toPC(b) as unknown as polygonClipping.MultiPolygon;
  const r = op === "add" ? polygonClipping.union(A, B) : op === "subtract" ? polygonClipping.difference(A, B) : op === "intersect" ? polygonClipping.intersection(A, B) : polygonClipping.xor(A, B);
  return fromPC(r as unknown as PC).filter((ring) => ring.length >= 6);
}

/** Outer contours of every connected region in a bitmap, as separate rings. */
export function traceRegions(mask: Uint8Array, w: number, h: number, epsilon = 1.5): number[][] {
  const seen = new Uint8Array(w * h); const single = new Uint8Array(w * h); const out: number[][] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    // Flood-fill one component into `single`, trace it, then clear it.
    const comp: number[] = [start]; seen[start] = 1; single[start] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k], x = i % w, y = (i - x) / w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; single[j] = 1; comp.push(j); }
    }
    if (comp.length >= 4) { const ring = traceRegion(single, w, h, epsilon); if (ring.length >= 6) out.push(ring); }
    for (const i of comp) single[i] = 0;
  }
  return out;
}

function signedArea(p: number[]) { let a = 0; for (let i = 0, n = p.length; i < n; i += 2) { const j = (i + 2) % n; a += p[i] * p[j + 1] - p[j] * p[i + 1]; } return a / 2; }

/**
 * Invert a selection polygon within a frame: the frame's outline with the polygon as a hole,
 * joined through a zero-width bridge so it stays a single ring (works with nonzero and even-odd fills).
 */
export function invertPolygon(points: number[], frame: { x: number; y: number; width: number; height: number }): number[] {
  const outer = [frame.x, frame.y, frame.x + frame.width, frame.y, frame.x + frame.width, frame.y + frame.height, frame.x, frame.y + frame.height];
  let inner = [...points];
  // Opposite orientations so the inner ring becomes a hole.
  if (Math.sign(signedArea(outer)) === Math.sign(signedArea(inner))) { const r: number[] = []; for (let i = inner.length - 2; i >= 0; i -= 2) r.push(inner[i], inner[i + 1]); inner = r; }
  // Bridge from the outer corner nearest to the inner ring's nearest vertex.
  let best = 0, bd = Infinity;
  for (let i = 0; i < inner.length; i += 2) { const d = Math.hypot(inner[i] - outer[0], inner[i + 1] - outer[1]); if (d < bd) { bd = d; best = i; } }
  const ring: number[] = [];
  for (let k = 0; k < inner.length; k += 2) { const i = (best + k) % inner.length; ring.push(inner[i], inner[i + 1]); }
  ring.push(inner[best], inner[best + 1]);
  return [outer[0], outer[1], ...ring, outer[0], outer[1], outer[2], outer[3], outer[4], outer[5], outer[6], outer[7]];
}

/** A regular polygon approximation of an ellipse, for selections. */
export function ellipsePolygon(x: number, y: number, width: number, height: number, n = 64): number[] {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push(x + width / 2 + Math.cos(a) * width / 2, y + height / 2 + Math.sin(a) * height / 2); }
  return pts;
}

/** Outer boundary of a bitmap region as a polygon (radial-sweep tracing), simplified. Pixel coords are centres. */
export function traceRegion(mask: Uint8Array, w: number, h: number, epsilon = 1.5): number[] {
  let start = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const dirs = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]]; // clockwise from W
  const pts: number[] = [];
  let x = start % w, y = (start - x) / w, from = 0; // came "from" the west (outside)
  const sx = x, sy = y;
  const limit = w * h * 2;
  for (let n = 0; n < limit; n++) {
    pts.push(x + 0.5, y + 0.5);
    let found = -1;
    for (let k = 1; k <= 8; k++) { const d = (from + k) % 8; if (inside(x + dirs[d][0], y + dirs[d][1])) { found = d; break; } }
    if (found < 0) break; // single pixel
    x += dirs[found][0]; y += dirs[found][1];
    from = (found + 4) % 8; // direction pointing back to where we came from
    if (x === sx && y === sy) break;
  }
  return simplifyPolygon(pts, epsilon);
}

/** Douglas-Peucker on a flat [x,y,...] polyline. */
export function simplifyPolygon(pts: number[], epsilon: number): number[] {
  const n = pts.length / 2;
  if (n < 4) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((by - ay) * pts[i * 2] - (bx - ax) * pts[i * 2 + 1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

// ---- Text runs -------------------------------------------------------------------

/** Keep character-range styles attached to their characters after the text changes (common prefix/suffix diff). */
export function remapRuns(oldText: string, newText: string, runs: TextRun[] | undefined): TextRun[] | undefined {
  if (!runs?.length || oldText === newText) return runs;
  const o = [...oldText], n = [...newText];
  let p = 0; while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let q = 0; while (q < o.length - p && q < n.length - p && o[o.length - 1 - q] === n[n.length - 1 - q]) q++;
  const oldEnd = o.length - q, delta = n.length - o.length; // changed region [p, oldEnd) → [p, oldEnd + delta)
  const out: TextRun[] = [];
  for (const r of runs) {
    let { start, end } = r;
    if (end <= p) { /* before the edit */ }
    else if (start >= oldEnd) { start += delta; end += delta; }
    else { if (start > p) start = p; end = Math.max(start, Math.min(end, oldEnd) + delta > start ? Math.min(end, oldEnd) + delta : start); if (end > oldEnd + delta && r.end > oldEnd) end = r.end + delta; }
    start = Math.max(0, Math.min(start, n.length)); end = Math.max(0, Math.min(end, n.length));
    if (end > start) out.push({ ...r, start, end });
  }
  return out.length ? out : undefined;
}

// ---- Animation -----------------------------------------------------------------

const EASE: Record<string, (t: number) => number> = { linear: (t) => t, "ease-in": (t) => t * t, "ease-out": (t) => 1 - (1 - t) * (1 - t), "ease-in-out": (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) };
const ANIM_KEYS = ["x", "y", "opacity", "rotation", "scaleX", "scaleY"] as const;

/** The document as it looks at time t (ms): layer props interpolated between their keyframes. */
export function documentAtTime(doc: AdDocument, t: number): AdDocument {
  const anim = doc.animation;
  if (!anim) return doc;
  const out = deepClone(doc);
  for (const [id, kfs] of Object.entries(anim.tracks)) {
    if (!kfs.length) continue;
    const l = findLayer(out, id); if (!l) continue;
    const sorted = [...kfs].sort((a, b) => a.t - b.t);
    let a = sorted[0], b = sorted[0];
    for (const k of sorted) { if (k.t <= t) a = k; if (k.t >= t) { b = k; break; } b = k; }
    const span = b.t - a.t, u = span <= 0 ? 1 : Math.max(0, Math.min(1, (t - a.t) / span)), e = EASE[a.ease ?? "linear"](u);
    const target = l as unknown as Record<string, number | boolean>;
    for (const k of ANIM_KEYS) { const va = a[k] ?? (target[k] as number), vb = b[k] ?? va; if (va !== undefined) target[k] = va + (vb - va) * e; }
    if (a.visible !== undefined) target.visible = a.visible;
  }
  return out;
}

/** Snapshot the animatable props of a layer into a keyframe at time t. */
export function keyframeOf(l: Layer, t: number): Keyframe {
  return { t, x: l.x, y: l.y, opacity: l.opacity, rotation: l.rotation, scaleX: l.scaleX, scaleY: l.scaleY, visible: l.visible };
}

// ---- Layer comps ---------------------------------------------------------------

/** Snapshot the current visibility, position, opacity and text of every layer into a comp. */
export function captureComp(doc: AdDocument, name: string, id?: string): LayerComp {
  const states: LayerComp["states"] = {};
  for (const { layer: l } of walk(doc.layers)) {
    states[l.id] = { visible: l.visible, x: l.x, y: l.y, opacity: l.opacity, ...(l.type === "text" ? { text: l.text } : {}) };
  }
  return { id: id ?? uid("comp"), name, states };
}

/** Ops that restore a comp (only what differs from the current state). */
export function applyCompOps(doc: AdDocument, comp: LayerComp): Op[] {
  const ops: Op[] = [];
  for (const [id, st] of Object.entries(comp.states)) {
    const l = findLayer(doc, id);
    if (!l) continue;
    const props: Record<string, unknown> = {};
    if (st.visible !== undefined && st.visible !== l.visible) props.visible = st.visible;
    if (st.x !== undefined && st.x !== l.x) props.x = st.x;
    if (st.y !== undefined && st.y !== l.y) props.y = st.y;
    if (st.opacity !== undefined && st.opacity !== l.opacity) props.opacity = st.opacity;
    if (st.text !== undefined && l.type === "text" && st.text !== l.text) props.text = st.text;
    if (Object.keys(props).length) ops.push({ type: "layer.set", id, props });
  }
  return ops;
}

/** Normalised (0..1) paths for text on a path. */
export function textPathPreset(kind: "arc-up" | "arc-down" | "circle"): string {
  const pts: string[] = [];
  const range = kind === "arc-up" ? [180, 360] : kind === "arc-down" ? [180, 0] : [270, 630];
  const n = kind === "circle" ? 96 : 48;
  for (let i = 0; i <= n; i++) {
    const a = ((range[0] + ((range[1] - range[0]) * i) / n) * Math.PI) / 180;
    pts.push(`${i ? "L" : "M"}${(0.5 + 0.5 * Math.cos(a)).toFixed(4)} ${(0.5 + 0.5 * Math.sin(a)).toFixed(4)}`);
  }
  return pts.join(" ");
}

/** Flatten an SVG path (M/L/C/Q/Z, absolute) into a polyline [x,y,...]. */
export function flattenPath(d: string, scaleX = 1, scaleY = 1): number[] {
  const tokens = d.match(/[MLCQZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  const out: number[] = [];
  if (!tokens) return out;
  let i = 0, cmd = "", cx = 0, cy = 0, sx = 0, sy = 0;
  const num = () => Number(tokens[i++]);
  const push = (x: number, y: number) => { out.push(x * scaleX, y * scaleY); cx = x; cy = y; };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MLCQZ]$/i.test(t)) { cmd = t.toUpperCase(); i++; if (cmd === "Z") { push(sx, sy); continue; } }
    if (cmd === "M") { const x = num(), y = num(); sx = x; sy = y; push(x, y); }
    else if (cmd === "L") push(num(), num());
    else if (cmd === "C") { const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num(); const x0 = cx, y0 = cy; for (let k = 1; k <= 16; k++) { const u = k / 16, v = 1 - u; push(v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x, v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y); } }
    else if (cmd === "Q") { const x1 = num(), y1 = num(), x = num(), y = num(); const x0 = cx, y0 = cy; for (let k = 1; k <= 12; k++) { const u = k / 12, v = 1 - u; push(v * v * x0 + 2 * v * u * x1 + u * u * x, v * v * y0 + 2 * v * u * y1 + u * u * y); } }
    else i++;
  }
  return out;
}

// ---- Shape geometry: outlines, anchors and boolean operations -----------------------------

const KAPPA = 0.5522847498;

/** Pen-style anchors (normalised 0..1) for a basic shape, so it can become an editable path. */
export function shapeToAnchors(l: ShapeLayer): PathAnchor[] | null {
  const w = l.width, h = l.height;
  switch (l.shape) {
    case "rect": {
      const lim = (v: number) => Math.max(0, Math.min(v, w / 2, h / 2));
      const [tl, tr, br, bl] = (l.radii ?? [l.radius ?? 0, l.radius ?? 0, l.radius ?? 0, l.radius ?? 0]).map(lim);
      if (tl + tr + br + bl === 0) return [{ x: 0, y: 0, ox: 0, oy: 0 }, { x: 1, y: 0, ox: 0, oy: 0 }, { x: 1, y: 1, ox: 0, oy: 0 }, { x: 0, y: 1, ox: 0, oy: 0 }];
      // Two anchors per rounded corner with handles along the edges.
      const a: PathAnchor[] = [];
      const corner = (cx: number, cy: number, r: number, dirIn: [number, number], dirOut: [number, number]) => {
        // dirIn: direction of the edge arriving at the corner; dirOut: leaving. Both unit vectors in normalised units.
        const k = r * KAPPA;
        a.push({ x: (cx - dirIn[0] * r) / w, y: (cy - dirIn[1] * r) / h, ox: (dirIn[0] * k) / w, oy: (dirIn[1] * k) / h });
        a.push({ x: (cx + dirOut[0] * r) / w, y: (cy + dirOut[1] * r) / h, ox: (dirOut[0] * k) / w, oy: (dirOut[1] * k) / h });
      };
      corner(0, 0, tl, [0, -1], [1, 0]); corner(w, 0, tr, [1, 0], [0, 1]); corner(w, h, br, [0, 1], [-1, 0]); corner(0, h, bl, [-1, 0], [0, -1]);
      return a;
    }
    case "ellipse": {
      const kx = 0.5 * KAPPA, ky = 0.5 * KAPPA;
      return [{ x: 0.5, y: 0, ox: kx, oy: 0 }, { x: 1, y: 0.5, ox: 0, oy: ky }, { x: 0.5, y: 1, ox: -kx, oy: 0 }, { x: 0, y: 0.5, ox: 0, oy: -ky }];
    }
    case "polygon": case "star": {
      const n = Math.max(3, l.sides ?? (l.shape === "star" ? 5 : 6)), inner = l.shape === "star" ? (l.innerRadius ?? 0.5) : 1;
      const count = l.shape === "star" ? n * 2 : n; const a: PathAnchor[] = [];
      for (let i = 0; i < count; i++) { const ang = -Math.PI / 2 + (i / count) * Math.PI * 2, k = l.shape === "star" && i % 2 === 1 ? inner : 1; a.push({ x: 0.5 + Math.cos(ang) * 0.5 * k, y: 0.5 + Math.sin(ang) * 0.5 * k, ox: 0, oy: 0 }); }
      return a;
    }
    case "path": return l.path ? parsePenPath(l.path) : null;
    default: return null;
  }
}

/** Document-space outline polygons of a shape layer (flat [x,y,...] rings; path shapes may have several). */
export function shapeOutline(l: ShapeLayer): number[][] {
  const local: number[][] = [];
  if (l.shape === "path" && l.path) {
    // Split on M for multiple subpaths.
    for (const part of l.path.split(/(?=M)/i)) { const pts = flattenPath(part, l.width, l.height); if (pts.length >= 6) local.push(pts); }
  } else if (l.shape === "line") {
    const t = Math.max(1, l.strokeWidth) / 2;
    local.push([0, l.height / 2 - t, l.width, l.height / 2 - t, l.width, l.height / 2 + t, 0, l.height / 2 + t]);
  } else {
    const anchors = shapeToAnchors(l);
    if (anchors) local.push(flattenPath(anchorsToPath(anchors), l.width, l.height));
  }
  const cx = l.x + l.width / 2, cy = l.y + l.height / 2, r = (l.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return local.map((ring) => { const out: number[] = []; for (let i = 0; i < ring.length; i += 2) { const dx = (ring[i] - l.width / 2) * l.scaleX, dy = (ring[i + 1] - l.height / 2) * l.scaleY; out.push(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos); } return out; });
}

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

/** Combine shape layers into one path shape (Photoshop's unite / subtract front / intersect / exclude). Layers are ordered bottom to top. */
export function combineShapes(layers: ShapeLayer[], op: BooleanOp): ShapeLayer | null {
  if (layers.length < 2) return null;
  const toGeom = (l: ShapeLayer) => shapeOutline(l).map((ring) => { const pts: [number, number][] = []; for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]); return [pts]; });
  let result = toGeom(layers[0]) as unknown as polygonClipping.MultiPolygon;
  for (const l of layers.slice(1)) {
    const g = toGeom(l) as unknown as polygonClipping.MultiPolygon;
    result = op === "union" ? polygonClipping.union(result, g) : op === "subtract" ? polygonClipping.difference(result, g) : op === "intersect" ? polygonClipping.intersection(result, g) : polygonClipping.xor(result, g);
  }
  const rings = result.flatMap((poly) => poly);
  if (!rings.length) return null;
  const all = rings.flat();
  const x0 = Math.min(...all.map((p) => p[0])), y0 = Math.min(...all.map((p) => p[1])), x1 = Math.max(...all.map((p) => p[0])), y1 = Math.max(...all.map((p) => p[1]));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const d = rings.map((ring) => ring.map((p, i) => `${i ? "L" : "M"}${((p[0] - x0) / w).toFixed(4)} ${((p[1] - y0) / h).toFixed(4)}`).join(" ") + " Z").join(" ");
  const base = layers[0];
  return makeShape({ name: `${base.name} (${op})`, shape: "path", path: d, x: Math.round(x0), y: Math.round(y0), width: Math.round(w), height: Math.round(h), fill: base.fill, strokeColor: base.strokeColor, strokeWidth: base.strokeWidth, styles: base.styles, opacity: base.opacity, blend: base.blend });
}

/** Built-in custom shapes as normalised (0..1) paths, like Photoshop's shape library. */
export const CUSTOM_SHAPES: Record<string, string> = {
  arrow: "M0 0.35 L0.6 0.35 L0.6 0.1 L1 0.5 L0.6 0.9 L0.6 0.65 L0 0.65 Z",
  "double-arrow": "M0 0.5 L0.25 0.15 L0.25 0.35 L0.75 0.35 L0.75 0.15 L1 0.5 L0.75 0.85 L0.75 0.65 L0.25 0.65 L0.25 0.85 Z",
  heart: "M0.5 1 C0.5 1 0 0.65 0 0.32 C0 0.14 0.14 0 0.3 0 C0.39 0 0.46 0.05 0.5 0.12 C0.54 0.05 0.61 0 0.7 0 C0.86 0 1 0.14 1 0.32 C1 0.65 0.5 1 0.5 1 Z",
  "speech-bubble": "M0.1 0 L0.9 0 C0.95 0 1 0.05 1 0.1 L1 0.65 C1 0.7 0.95 0.75 0.9 0.75 L0.4 0.75 L0.2 1 L0.22 0.75 L0.1 0.75 C0.05 0.75 0 0.7 0 0.65 L0 0.1 C0 0.05 0.05 0 0.1 0 Z",
  check: "M0.05 0.55 L0.2 0.4 L0.4 0.6 L0.8 0.1 L0.95 0.25 L0.4 0.9 Z",
  cross: "M0.35 0 L0.65 0 L0.65 0.35 L1 0.35 L1 0.65 L0.65 0.65 L0.65 1 L0.35 1 L0.35 0.65 L0 0.65 L0 0.35 L0.35 0.35 Z",
  bolt: "M0.55 0 L0.15 0.55 L0.45 0.55 L0.35 1 L0.85 0.4 L0.55 0.4 Z",
  seal: (() => { const pts: string[] = []; const n = 24; for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2, r = i % 2 ? 0.42 : 0.5; pts.push(`${i ? "L" : "M"}${(0.5 + Math.cos(a) * r).toFixed(4)} ${(0.5 + Math.sin(a) * r).toFixed(4)}`); } return pts.join(" ") + " Z"; })(),
  triangle: "M0.5 0 L1 1 L0 1 Z",
  diamond: "M0.5 0 L1 0.5 L0.5 1 L0 0.5 Z",
  hexagon: "M0.25 0 L0.75 0 L1 0.5 L0.75 1 L0.25 1 L0 0.5 Z",
  ribbon: "M0 0.2 L1 0.2 L0.85 0.5 L1 0.8 L0 0.8 L0.15 0.5 Z",
};

/** Split a cubic at t (de Casteljau) - returns the two halves' control points. */
function splitCubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number) {
  const lerp = (a: Point, b: Point) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const a = lerp(p0, p1), b = lerp(p1, p2), c = lerp(p2, p3), d = lerp(a, b), e = lerp(b, c), m = lerp(d, e);
  return { left: [p0, a, d, m], right: [m, e, c, p3] };
}

/** Insert an anchor on the segment closest to `p` (normalised coords) without changing the outline. */
export function insertAnchorNear(anchors: PathAnchor[], p: Point): PathAnchor[] | null {
  let best = { seg: -1, t: 0, d: Infinity };
  const n = anchors.length;
  for (let i = 0; i < n; i++) {
    const a = anchors[i], b = anchors[(i + 1) % n];
    const p0 = { x: a.x, y: a.y }, p1 = { x: a.x + a.ox, y: a.y + a.oy }, p2 = { x: b.x - b.ox, y: b.y - b.oy }, p3 = { x: b.x, y: b.y };
    for (let k = 0; k <= 32; k++) { const t = k / 32, u = 1 - t; const x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y; const d = Math.hypot(x - p.x, y - p.y); if (d < best.d) best = { seg: i, t, d }; }
  }
  if (best.seg < 0) return null;
  const a = anchors[best.seg], b = anchors[(best.seg + 1) % n];
  const { left, right } = splitCubic({ x: a.x, y: a.y }, { x: a.x + a.ox, y: a.y + a.oy }, { x: b.x - b.ox, y: b.y - b.oy }, { x: b.x, y: b.y }, best.t);
  const out = anchors.map((x) => ({ ...x }));
  out[best.seg] = { ...a, ox: left[1].x - a.x, oy: left[1].y - a.y };
  const mid: PathAnchor = { x: left[3].x, y: left[3].y, ox: right[1].x - left[3].x, oy: right[1].y - left[3].y };
  out[(best.seg + 1) % n] = { ...b, ox: b.x - right[2].x, oy: b.y - right[2].y };
  out.splice(best.seg + 1, 0, mid);
  return out;
}

/** Toggle an anchor between corner (no handles) and smooth (handles along the neighbouring direction). */
export function toggleAnchorSmooth(anchors: PathAnchor[], i: number): PathAnchor[] {
  const out = anchors.map((x) => ({ ...x })); const a = out[i];
  if (a.ox || a.oy) { a.ox = 0; a.oy = 0; return out; }
  const prev = out[(i - 1 + out.length) % out.length], next = out[(i + 1) % out.length];
  const dx = next.x - prev.x, dy = next.y - prev.y, len = Math.hypot(dx, dy) || 1, h = Math.hypot(next.x - a.x, next.y - a.y) / 3;
  a.ox = (dx / len) * h; a.oy = (dy / len) * h;
  return out;
}

export interface PathAnchor { x: number; y: number; ox: number; oy: number }

/** Parse a pen-style path (M, C segments, Z) in a 0..1 box into anchors with symmetric handles; null for other paths. */
export function parsePenPath(d: string): PathAnchor[] | null {
  const tokens = d.match(/[MCLZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  if (!tokens) return null;
  const anchors: PathAnchor[] = [];
  let i = 0; let cmd = "";
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MCLZ]$/i.test(t)) { cmd = t.toUpperCase(); i++; if (cmd === "Z") continue; }
    if (cmd === "M" || cmd === "L") { const x = num(), y = num(); anchors.push({ x, y, ox: 0, oy: 0 }); }
    else if (cmd === "C") {
      const c1x = num(), c1y = num(), c2x = num(), c2y = num(), x = num(), y = num();
      const prev = anchors[anchors.length - 1];
      if (prev && !prev.ox && !prev.oy) { prev.ox = c1x - prev.x; prev.oy = c1y - prev.y; }
      anchors.push({ x, y, ox: x - c2x, oy: y - c2y });
    } else return null;
  }
  if (anchors.length < 2) return null;
  // A closed path ends with a segment back to the first anchor: fold that segment's handle into anchor 0 instead of keeping a duplicate.
  const first = anchors[0], last = anchors[anchors.length - 1];
  if (anchors.length > 2 && Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) { if (!first.ox && !first.oy) { first.ox = last.ox; first.oy = last.oy; } anchors.pop(); }
  return anchors;
}

export function anchorsToPath(anchors: PathAnchor[], closed = true): string {
  const f = (v: number) => v.toFixed(4);
  let d = `M${f(anchors[0].x)} ${f(anchors[0].y)}`;
  const seg = (a: PathAnchor, b: PathAnchor) => ` C${f(a.x + a.ox)} ${f(a.y + a.oy)} ${f(b.x - b.ox)} ${f(b.y - b.oy)} ${f(b.x)} ${f(b.y)}`;
  for (let i = 1; i < anchors.length; i++) d += seg(anchors[i - 1], anchors[i]);
  if (closed) d += seg(anchors[anchors.length - 1], anchors[0]) + " Z";
  return d;
}

/** Properties that linked layers share. Geometry (x, y, size, rotation, fontSize) stays per layer. */
export const LINKED_KEYS = new Set(["text", "runs", "fontFamily", "fontWeight", "fontStyle", "color", "align", "verticalAlign", "lineHeight", "textTransform", "underline", "strikethrough",
  "fill", "strokeColor", "strokeWidth", "radius", "sides", "innerRadius", "path", "dash", "arrows", "assetId", "fit", "crop", "adjustment", "strokes",
  "styles", "filters", "opacity", "fillOpacity", "blend", "tags", "name"]);

/** Extra layer.set ops that keep linked layers in sync with the given ops. */
export function linkedPropagationOps(doc: AdDocument, ops: Op[]): Op[] {
  const out: Op[] = [];
  const touched = new Set(ops.map((o) => ("id" in o ? o.id : "")));
  for (const op of ops) {
    if (op.type !== "layer.set") continue;
    const src = findLayer(doc, op.id);
    if (!src?.linkId) continue;
    const shared: Record<string, unknown> = {};
    for (const k of Object.keys(op.props)) if (LINKED_KEYS.has(k)) shared[k] = op.props[k];
    if (!Object.keys(shared).length) continue;
    for (const { layer } of walk(doc.layers)) {
      if (layer.id === src.id || layer.linkId !== src.linkId || layer.type !== src.type || touched.has(layer.id)) continue;
      out.push({ type: "layer.set", id: layer.id, props: deepClone(shared) });
    }
  }
  return out;
}

/** Common ad sizes; used by the editor's New dialog and exposed to the agent. */
export const AD_PRESETS: { name: string; width: number; height: number; group?: string }[] = [
  // Social
  { group: "Social", name: "Instagram / Facebook square (1:1)", width: 1080, height: 1080 },
  { group: "Social", name: "Instagram / Facebook feed portrait (4:5)", width: 1080, height: 1350 },
  { group: "Social", name: "Instagram / Facebook / TikTok story & reel (9:16)", width: 1080, height: 1920 },
  { group: "Social", name: "Facebook / LinkedIn link share (1.91:1)", width: 1200, height: 628 },
  { group: "Social", name: "Facebook cover", width: 820, height: 312 },
  { group: "Social", name: "X post (16:9)", width: 1600, height: 900 },
  { group: "Social", name: "X header", width: 1500, height: 500 },
  { group: "Social", name: "LinkedIn single image", width: 1200, height: 1200 },
  { group: "Social", name: "LinkedIn banner", width: 1584, height: 396 },
  { group: "Social", name: "Pinterest pin (2:3)", width: 1000, height: 1500 },
  { group: "Social", name: "YouTube thumbnail (16:9)", width: 1280, height: 720 },
  { group: "Social", name: "YouTube channel art", width: 2560, height: 1440 },
  { group: "Social", name: "Snapchat / vertical video (9:16)", width: 1080, height: 1920 },
  // Display (IAB / Google Ads)
  { group: "Display", name: "Medium rectangle", width: 300, height: 250 },
  { group: "Display", name: "Large rectangle", width: 336, height: 280 },
  { group: "Display", name: "Leaderboard", width: 728, height: 90 },
  { group: "Display", name: "Large leaderboard", width: 970, height: 90 },
  { group: "Display", name: "Billboard", width: 970, height: 250 },
  { group: "Display", name: "Half page", width: 300, height: 600 },
  { group: "Display", name: "Wide skyscraper", width: 160, height: 600 },
  { group: "Display", name: "Skyscraper", width: 120, height: 600 },
  { group: "Display", name: "Square", width: 250, height: 250 },
  { group: "Display", name: "Small square", width: 200, height: 200 },
  { group: "Display", name: "Mobile banner", width: 320, height: 50 },
  { group: "Display", name: "Large mobile banner", width: 320, height: 100 },
  { group: "Display", name: "Mobile interstitial (portrait)", width: 320, height: 480 },
  { group: "Display", name: "Mobile interstitial (landscape)", width: 480, height: 320 },
  { group: "Display", name: "Responsive display (landscape 1.91:1)", width: 1200, height: 628 },
  { group: "Display", name: "Responsive display (square)", width: 1200, height: 1200 },
  { group: "Display", name: "Responsive display logo (4:1)", width: 1200, height: 300 },
  // Video / screens
  { group: "Screens", name: "Full HD (16:9)", width: 1920, height: 1080 },
  { group: "Screens", name: "4K UHD", width: 3840, height: 2160 },
  { group: "Screens", name: "Digital signage portrait", width: 1080, height: 1920 },
  { group: "Screens", name: "Presentation (16:9)", width: 1920, height: 1080 },
  // Print at 300 dpi
  { group: "Print", name: "A4 portrait (300dpi)", width: 2480, height: 3508 },
  { group: "Print", name: "A4 landscape (300dpi)", width: 3508, height: 2480 },
  { group: "Print", name: "A5 (300dpi)", width: 1748, height: 2480 },
  { group: "Print", name: "A3 (300dpi)", width: 3508, height: 4961 },
  { group: "Print", name: "US Letter (300dpi)", width: 2550, height: 3300 },
  { group: "Print", name: "Business card 85×55mm (300dpi)", width: 1004, height: 650 },
  { group: "Print", name: "Postcard A6 (300dpi)", width: 1240, height: 1748 },
  { group: "Print", name: "DL flyer (300dpi)", width: 1240, height: 2599 },
  { group: "Print", name: "Poster 50×70cm (150dpi)", width: 2953, height: 4134 },
];

/** Starter gradient presets for the gradient editor. */
export const GRADIENT_PRESETS: { name: string; stops: { pos: number; color: string; opacity?: number }[] }[] = [
  { name: "Foreground to transparent", stops: [{ pos: 0, color: "#000000" }, { pos: 1, color: "#000000", opacity: 0 }] },
  { name: "Black to white", stops: [{ pos: 0, color: "#000000" }, { pos: 1, color: "#ffffff" }] },
  { name: "Sunset", stops: [{ pos: 0, color: "#ff8a00" }, { pos: 0.55, color: "#e52e71" }, { pos: 1, color: "#3a1c71" }] },
  { name: "Ocean", stops: [{ pos: 0, color: "#00c6ff" }, { pos: 1, color: "#0072ff" }] },
  { name: "Mint", stops: [{ pos: 0, color: "#a8ff78" }, { pos: 1, color: "#78ffd6" }] },
  { name: "Gold", stops: [{ pos: 0, color: "#f6d365" }, { pos: 0.5, color: "#fda085" }, { pos: 1, color: "#f6d365" }] },
  { name: "Night", stops: [{ pos: 0, color: "#0f2027" }, { pos: 0.5, color: "#203a43" }, { pos: 1, color: "#2c5364" }] },
  { name: "Photo fade (bottom)", stops: [{ pos: 0, color: "#000000", opacity: 0 }, { pos: 0.6, color: "#000000", opacity: 0 }, { pos: 1, color: "#000000", opacity: 0.85 }] },
];

/** Starter layer style presets, installed on first run when the server has none. */
export const DEFAULT_STYLE_PRESETS: { name: string; styles: LayerStyles }[] = [
  { name: "Soft shadow", styles: { dropShadow: { enabled: true, color: "#000000", blur: 24, x: 0, y: 12, opacity: 0.35 } } },
  { name: "Hard shadow", styles: { dropShadow: { enabled: true, color: "#000000", blur: 0, x: 6, y: 6, opacity: 1 } } },
  { name: "Outline (white)", styles: { stroke: { enabled: true, color: "#ffffff", size: 6, position: "outside" } } },
  { name: "Outline (black)", styles: { stroke: { enabled: true, color: "#000000", size: 4, position: "outside" } } },
  { name: "Neon glow", styles: { outerGlow: { enabled: true, color: "#39ff14", size: 28, opacity: 0.9 }, innerGlow: { enabled: true, color: "#ffffff", size: 6, opacity: 0.8 } } },
  { name: "Emboss", styles: { bevel: { enabled: true, size: 10, depth: 1, angle: 120, highlight: "#ffffff", shadow: "#000000", opacity: 0.6 } } },
  { name: "Sticker", styles: { stroke: { enabled: true, color: "#ffffff", size: 10, position: "outside" }, dropShadow: { enabled: true, color: "#000000", blur: 10, x: 0, y: 6, opacity: 0.35 } } },
  { name: "Gold foil", styles: { gradientOverlay: { enabled: true, from: "#f6d365", to: "#b8860b", angle: 90, opacity: 1, blend: "normal" }, bevel: { enabled: true, size: 6, depth: 1, angle: 120, highlight: "#ffffff", shadow: "#5a3d00", opacity: 0.7 }, dropShadow: { enabled: true, color: "#000000", blur: 8, x: 0, y: 4, opacity: 0.4 } } },
];
