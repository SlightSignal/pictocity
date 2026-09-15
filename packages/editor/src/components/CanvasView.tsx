import { useEffect, useRef, useState, useCallback } from "react";
import type { Layer, Op, TextLayer, GroupLayer } from "@pictocity/core";
import { renderDocument, layerCorners, layerBounds, pickLayer, findLayer, isGroup, walk, makeShape, makeText, makeBrush, makeFill, deepClone, fontString, toLocal, ellipsePolygon, traceRegion, parsePenPath, anchorsToPath, insertAnchorNear, toggleAnchorSmooth, type PathAnchor, type ShapeLayer } from "@pictocity/core";
import { localToDoc } from "../transform";
import { documentAtTime } from "@pictocity/core";
import { useStore, topLevelOnly, unionBounds } from "../store";
import { browserEnv, onAssetsChanged, measureText, renderCache } from "../env";

import { scaleProps, virtualLayer, mapMembersToBox, rotateMembers, type Handle, type Box } from "../transform";

export const RULER = 20;

interface Drag {
  kind: "move" | "scale" | "rotate" | "marquee" | "pan" | "draw" | "guide" | "brush" | "crop" | "pixelsel" | "lasso" | "gradient" | "pen" | "anchor" | "quad";
  corner?: number;
  /** Direct selection: which anchor / handle is being dragged. */
  anchor?: { index: number; part: "point" | "in" | "out"; anchors: PathAnchor[] };
  /** Transform-selection drags operate on the marching ants instead of layers. */
  onSelection?: { rings: number[][] };
  mode?: "replace" | "add" | "subtract";
  square?: boolean;
  rotateView?: boolean;
  pressures?: number[];
  /** Brush strokes go to the layer's paint mask instead of its pixels. */
  toMask?: boolean;
  axis?: "x" | "y";
  guideIndex?: number;
  /** Selection box at drag start for multi-layer / group transforms. */
  box?: Box;
  /** Brush stroke in progress: target layer id and points in layer-local pixels. */
  brushId?: string;
  points?: number[];
  start: { x: number; y: number };        // doc coords (or screen for pan)
  startScreen: { x: number; y: number };
  layers: Layer[];                          // snapshots at drag start (moving/scaling)
  handle?: Handle;
  angle0?: number;
  moved: boolean;
  current?: { x: number; y: number };
}

function descendants(l: Layer): Layer[] { return isGroup(l) ? [...walk(l.children)].map((w) => w.layer) : []; }

/** Group boxes are derived from their children for display and hit testing. */
function displayBounds(l: Layer) {
  if (isGroup(l)) {
    if (l.artboard) return layerBounds(l); // the frame, not the (clipped) children
    const kids = l.children.filter((c) => c.visible);
    return kids.length ? unionBounds(kids) : layerBounds(l);
  }
  return layerBounds(l);
}

export function CanvasView() {
  const doc = useStore((s) => s.doc);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const tool = useStore((s) => s.tool);
  const shapeKind = useStore((s) => s.shapeKind);
  const selection = useStore((s) => s.selection);
  const hoverId = useStore((s) => s.hoverId);
  const presence = useStore((s) => s.presence);
  const editingTextId = useStore((s) => s.editingTextId);
  const autoSelectGroup = useStore((s) => s.autoSelectGroup);
  const fgColor = useStore((s) => s.fgColor);
  const showGuides = useStore((s) => s.showGuides);
  const showRulers = useStore((s) => s.showRulers);
  const [guideDrag, setGuideDrag] = useState<{ axis: "x" | "y"; pos: number } | null>(null);
  const [brushPos, setBrushPos] = useState<{ x: number; y: number } | null>(null);
  const [lassoPts, setLassoPts] = useState<number[] | null>(null);
  const [gradLine, setGradLine] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const [pen, setPen] = useState<{ x: number; y: number; ox: number; oy: number }[]>([]);
  const penRef = useRef(pen); penRef.current = pen;
  const pixelSelection = useStore((s) => s.pixelSelection);
  const selectionTransform = useStore((s) => s.selectionTransform);
  const lassoKind = useStore((s) => s.lassoKind);
  const distortMode = useStore((s) => s.distortMode);
  const animTime = useStore((s) => s.animTime);
  const showTimeline = useStore((s) => s.showTimeline);
  const animating = showTimeline && !!doc?.animation && Object.keys(doc.animation.tracks).length > 0 && animTime > 0;
  const finishPolyLasso = (mode: "replace" | "add" | "subtract" = "replace") => {
    const pts = lassoPts; setLassoPts(null);
    if (pts && pts.length >= 6) useStore.getState().setPixelSelection([pts.map((v) => Math.round(v * 10) / 10)], mode);
  };
  useEffect(() => {
    const onKey = (e: Event) => { const cmd = (e as CustomEvent).detail as string; if (cmd === "finish") finishPolyLasso(); else if (cmd === "cancel") setLassoPts(null); };
    window.addEventListener("pictocity:lasso", onKey); return () => window.removeEventListener("pictocity:lasso", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lassoPts]);
  useEffect(() => { if (tool !== "lasso") setLassoPts(null); }, [tool]);
  const [cloneSource, setCloneSource] = useState<{ x: number; y: number } | null>(null);
  const cloneOffset = useRef<{ dx: number; dy: number } | null>(null);
  const marqueeKind = useStore((s) => s.marqueeKind);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const brush = useStore((s) => s.brush);
  const editMask = useStore((s) => s.editMask);
  const cropRect = useStore((s) => s.cropRect);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendered = useRef<{ canvas: HTMLCanvasElement; scale: number } | null>(null);
  /** Rasterised layers from the last render, for pixel-accurate hit testing (top-level and pass-through-group layers). */
  const rasters = useRef(new Map<string, { canvas: HTMLCanvasElement; x: number; y: number; scale: number }>());
  const pixelTest = (l: Layer, p: { x: number; y: number }): boolean | undefined => {
    if (l.type === "text") return undefined; // the whole text box counts, so you don't have to hit a glyph
    const r = rasters.current.get(l.id); if (!r) return undefined;
    const x = Math.floor(p.x * r.scale - r.x), y = Math.floor(p.y * r.scale - r.y);
    if (x < 0 || y < 0 || x >= r.canvas.width || y >= r.canvas.height) return false;
    try { return r.canvas.getContext("2d")!.getImageData(x, y, 1, 1).data[3] > 8; } catch { return undefined; }
  };
  const drag = useRef<Drag | null>(null);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [guides, setGuides] = useState<{ axis: "x" | "y"; pos: number }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [space, setSpace] = useState(false);
  const [cursor, setCursor] = useState("default");
  const [assetTick, setAssetTick] = useState(0);
  const fittedFor = useRef<string | null>(null);

  const viewRotation = useStore((s) => s.viewRotation);
  const showExtras = useStore((s) => s.showExtras);
  // View rotation (R tool) spins the whole view about the viewport centre; both mappings account for it.
  const rot = useCallback((x: number, y: number, deg: number) => { if (!deg) return { x, y }; const cx = size.w / 2, cy = size.h / 2, a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a), dx = x - cx, dy = y - cy; return { x: cx + dx * c - dy * sn, y: cy + dx * sn + dy * c }; }, [size]);
  const toDoc = useCallback((sx: number, sy: number) => { const u = rot(sx, sy, -viewRotation); return { x: (u.x - pan.x) / zoom, y: (u.y - pan.y) / zoom }; }, [pan, zoom, rot, viewRotation]);
  const toScreen = useCallback((p: { x: number; y: number }) => rot(p.x * zoom + pan.x, p.y * zoom + pan.y, viewRotation), [pan, zoom, rot, viewRotation]);

  // ---- Resize & fit ------------------------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!doc || !size.w) return;
    const z = Math.min((size.w - 80) / doc.width, (size.h - 80) / doc.height, 4);
    useStore.getState().setView(z, { x: (size.w - doc.width * z) / 2, y: (size.h - doc.height * z) / 2 });
  }, [doc, size]);

  useEffect(() => { if (doc && size.w && fittedFor.current !== doc.id) { fittedFor.current = doc.id; fit(); } }, [doc, size, fit]);
  useEffect(() => { (window as unknown as { __fit: () => void }).__fit = fit; }, [fit]);
  useEffect(() => { const off = onAssetsChanged(() => setAssetTick((t) => t + 1)); return () => { off(); }; }, []);

  // ---- Render document to an offscreen canvas at the current zoom ---------------------
  useEffect(() => {
    if (!doc) { rendered.current = null; return; }
    const dpr = window.devicePixelRatio || 1;
    // Cap the working raster (~48 MP, 16384 px per side) so zooming into a huge pasteboard can't exhaust memory.
    const scale = Math.max(0.02, Math.min(zoom * dpr, 3, 16384 / Math.max(doc.width, doc.height), Math.sqrt(48e6 / (doc.width * doc.height))));
    let raf = requestAnimationFrame(() => {
      const next = new Map<string, { canvas: HTMLCanvasElement; x: number; y: number; scale: number }>();
      const viewDoc = animating ? documentAtTime(doc, animTime) : doc;
      const c = renderDocument(viewDoc, browserEnv, { scale, hideLayerIds: editingTextId ? [editingTextId] : undefined, cache: renderCache, onLayer: (l, e) => next.set(l.id, { canvas: e.canvas as unknown as HTMLCanvasElement, x: e.x, y: e.y, scale }) }) as unknown as HTMLCanvasElement;
      rasters.current = next;
      (window as unknown as { __layerAlpha?: (id: string) => unknown }).__layerAlpha = (id: string) => next.get(id);
      rendered.current = { canvas: c, scale };
      paint();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, zoom, editingTextId, animTime, animating, assetTick]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current, el = wrapRef.current;
    if (!canvas || !el) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth, h = el.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1f1f1f"; ctx.fillRect(0, 0, w, h);
    const d = useStore.getState().doc;
    if (!d) return;
    const { zoom: z, pan: p, viewRotation: vr } = useStore.getState();
    const dw = d.width * z, dh = d.height * z;
    ctx.save();
    if (vr) { ctx.translate(w / 2, h / 2); ctx.rotate((vr * Math.PI) / 180); ctx.translate(-w / 2, -h / 2); }
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 24; ctx.shadowOffsetY = 6;
    ctx.fillStyle = "#333"; ctx.fillRect(p.x, p.y, dw, dh);
    ctx.restore();
    // transparency checkerboard
    ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, dw, dh); ctx.clip();
    ctx.fillStyle = "#bdbdbd"; ctx.fillRect(p.x, p.y, dw, dh);
    ctx.fillStyle = "#e6e6e6";
    const cell = 12;
    for (let y = 0; y < dh; y += cell) for (let x = (y / cell) % 2 ? cell : 0; x < dw; x += cell * 2) ctx.fillRect(p.x + x, p.y + y, cell, cell);
    ctx.restore();
    const r = rendered.current;
    if (r) { ctx.imageSmoothingEnabled = z * dpr < r.scale; ctx.drawImage(r.canvas, p.x, p.y, dw, dh); }
    if (useStore.getState().showGrid) {
      const g = useStore.getState().gridSize * z;
      if (g >= 6) {
        ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, dw, dh); ctx.clip();
        ctx.strokeStyle = "rgba(0,150,255,0.35)"; ctx.lineWidth = 1; ctx.beginPath();
        for (let x = p.x; x <= p.x + dw; x += g) { ctx.moveTo(Math.round(x) + 0.5, p.y); ctx.lineTo(Math.round(x) + 0.5, p.y + dh); }
        for (let y = p.y; y <= p.y + dh; y += g) { ctx.moveTo(p.x, Math.round(y) + 0.5); ctx.lineTo(p.x + dw, Math.round(y) + 0.5); }
        ctx.stroke(); ctx.restore();
      }
    }
    ctx.restore();
    if (useStore.getState().showRulers && !vr) drawRulers(ctx, w, h, z, p);
  }, []);

  useEffect(() => { paint(); }, [pan, size, paint, showRulers, showGrid, gridSize, viewRotation]);

  // ---- Keyboard: space for hand ------------------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { setSpace(true); e.preventDefault(); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setSpace(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // ---- Pen tool commands from the keyboard (Enter finish, Esc cancel, Backspace undo point) ----
  useEffect(() => {
    const onPen = (e: Event) => {
      const cmd = (e as CustomEvent).detail as string;
      if (cmd === "cancel") setPen([]);
      else if (cmd === "undo") setPen((p) => p.slice(0, -1));
      else if (cmd === "finish") finishPen();
    };
    window.addEventListener("pictocity:pen", onPen);
    return () => window.removeEventListener("pictocity:pen", onPen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (tool !== "pen" && pen.length) setPen([]); }, [tool, pen.length]);

  const finishPen = () => {
    const anchors = penRef.current;
    setPen([]);
    const st = useStore.getState();
    if (!st.doc || anchors.length < 2) return;
    // Bounding box over anchors and handles, then a normalised cubic path.
    const xs: number[] = [], ys: number[] = [];
    for (const a of anchors) { xs.push(a.x, a.x + a.ox, a.x - a.ox); ys.push(a.y, a.y + a.oy, a.y - a.oy); }
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(1, Math.max(...xs) - x0), h = Math.max(1, Math.max(...ys) - y0);
    const n = (v: number, o: number, d: number) => ((v - o) / d).toFixed(4);
    const seg = (from: typeof anchors[0], to: typeof anchors[0]) => `C${n(from.x + from.ox, x0, w)} ${n(from.y + from.oy, y0, h)} ${n(to.x - to.ox, x0, w)} ${n(to.y - to.oy, y0, h)} ${n(to.x, x0, w)} ${n(to.y, y0, h)}`;
    let d = `M${n(anchors[0].x, x0, w)} ${n(anchors[0].y, y0, h)}`;
    for (let i = 1; i < anchors.length; i++) d += " " + seg(anchors[i - 1], anchors[i]);
    d += " " + seg(anchors[anchors.length - 1], anchors[0]) + " Z";
    const layer = makeShape({ name: "Path", shape: "path", path: d, x: Math.round(x0), y: Math.round(y0), width: Math.round(w), height: Math.round(h), fill: st.fgColor, strokeColor: null, strokeWidth: 0 });
    st.dispatch([{ type: "layer.add", layer, parentId: null, index: st.doc.layers.length }], "Pen path");
    st.select([layer.id]); st.setTool("move");
  };

  // ---- Wheel: pan, ctrl/cmd/alt = zoom -------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = useStore.getState();
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const rect = el.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const z = Math.min(32, Math.max(0.02, st.zoom * factor));
        st.setView(z, { x: sx - ((sx - st.pan.x) / st.zoom) * z, y: sy - ((sy - st.pan.y) / st.zoom) * z });
      } else st.setView(st.zoom, { x: st.pan.x - e.deltaX, y: st.pan.y - e.deltaY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---- Hit testing helpers ------------------------------------------------------------
  /** Screen-space corners of the transform box: the rotated box for one layer, the union box for several or a group. */
  const selectionCorners = (): { x: number; y: number }[] | null => {
    const st = useStore.getState();
    if (!st.doc || !st.selection.length) return null;
    const layers = topLevelOnly(st.doc, st.selection).map((id) => findLayer(st.doc!, id)).filter((l): l is Layer => !!l);
    if (!layers.length || layers.some((l) => l.locked)) return null;
    if (layers.length === 1 && !isGroup(layers[0])) return layerCorners(layers[0]).map(toScreen);
    return rectCorners(unionBounds(layers.map((l) => (isGroup(l) ? virtualLayer(displayBounds(l)) : l)))).map(toScreen);
  };

  const handleAt = (sx: number, sy: number): Handle | "rotate" | null => {
    if (useStore.getState().distortMode) return null;
    const c = selectionCorners();
    if (!c) return null;
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const pts: Record<Handle, { x: number; y: number }> = { nw: c[0], ne: c[1], se: c[2], sw: c[3], n: mid(c[0], c[1]), e: mid(c[1], c[2]), s: mid(c[2], c[3]), w: mid(c[3], c[0]) };
    for (const [k, p] of Object.entries(pts) as [Handle, { x: number; y: number }][]) if (Math.hypot(p.x - sx, p.y - sy) <= 6) return k;
    for (const k of ["nw", "ne", "se", "sw"] as Handle[]) { const d = Math.hypot(pts[k].x - sx, pts[k].y - sy); if (d > 6 && d <= 22) return "rotate"; }
    return null;
  };

  const layerAt = (p: { x: number; y: number }) => {
    const st = useStore.getState();
    if (!st.doc) return undefined;
    return pickLayer(st.doc, p, { enterGroups: !st.autoSelectGroup, pixelTest });
  };

  // ---- Pointer events -------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    const el = wrapRef.current!;
    if (e.button === 1 || space || tool === "hand" || (e.button === 0 && e.altKey && tool === "zoom")) {
      if (tool === "zoom" && e.button === 0) { zoomAt(e, e.altKey ? 1 / 1.5 : 1.5); return; }
      drag.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, startScreen: { x: pan.x, y: pan.y }, layers: [], moved: false };
      el.setPointerCapture(e.pointerId); setCursor("grabbing"); return;
    }
    if (e.button !== 0 || !doc) return;
    if (tool === "zoom") { zoomAt(e, 1.5); return; }
    const rect = el.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const p = toDoc(sx, sy);
    const st = useStore.getState();
    if (st.editingTextId) { commitTextEdit(); }

    // Rulers: drag out a new guide. Existing guides: drag to move (back onto a ruler deletes).
    if (st.showRulers && (sx < RULER || sy < RULER)) {
      const axis: "x" | "y" = sx < RULER && sy >= RULER ? "x" : "y";
      drag.current = { kind: "guide", axis, guideIndex: -1, start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false };
      el.setPointerCapture(e.pointerId); return;
    }
    if (st.showGuides && tool === "move" && !st.guidesLocked) {
      const gi = doc.guides.findIndex((g) => Math.abs((g.axis === "x" ? toScreen({ x: g.position, y: 0 }).x : toScreen({ x: 0, y: g.position }).y) - (g.axis === "x" ? sx : sy)) <= 4);
      if (gi >= 0) {
        drag.current = { kind: "guide", axis: doc.guides[gi].axis, guideIndex: gi, start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false };
        el.setPointerCapture(e.pointerId); return;
      }
    }

    if (tool === "text") {
      // Like Photoshop: clicking existing text with the type tool edits it instead of creating a new layer.
      const hit = pickLayer(doc, p, { enterGroups: true, pixelTest });
      if (hit?.type === "text" && !hit.locked) { e.preventDefault(); st.select([hit.id]); useStore.setState({ editingTextId: hit.id }); return; }
    }
    if (tool === "shape" || tool === "text") {
      drag.current = { kind: "draw", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false };
      el.setPointerCapture(e.pointerId); return;
    }
    if (tool === "crop") {
      drag.current = { kind: "crop", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false };
      el.setPointerCapture(e.pointerId); return;
    }
    if (tool === "rotate") {
      drag.current = { kind: "pan", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false, angle0: Math.atan2(sy - size.h / 2, sx - size.w / 2) - (st.viewRotation * Math.PI) / 180, rotateView: true };
      el.setPointerCapture(e.pointerId); return;
    }
    if (tool === "wand") {
      // Flood at document resolution (capped at 4096 px) so the selection isn't limited to the screen's zoom level.
      let r = rendered.current; if (!r) return;
      if (r.scale < 1) { const s1 = Math.min(1, 4096 / Math.max(doc.width, doc.height)); const full = renderDocument(doc, browserEnv, { scale: s1, cache: renderCache }) as unknown as HTMLCanvasElement; r = { canvas: full, scale: s1 }; }
      const rc = r.canvas.getContext("2d")!, W = r.canvas.width, H = r.canvas.height;
      const px0 = Math.floor(p.x * r.scale), py0 = Math.floor(p.y * r.scale);
      if (px0 < 0 || py0 < 0 || px0 >= W || py0 >= H) return;
      const img = rc.getImageData(0, 0, W, H).data;
      const seed = py0 * W + px0, sr = img[seed * 4], sg = img[seed * 4 + 1], sb = img[seed * 4 + 2], sa = img[seed * 4 + 3];
      const tol = st.wandTolerance, tol2 = tol * tol * 3;
      const mask = new Uint8Array(W * H); const stack = [seed]; mask[seed] = 1;
      const ok = (i: number) => { const a = img[i * 4 + 3]; if ((a < 8) !== (sa < 8)) return false; const dr = img[i * 4] - sr, dg = img[i * 4 + 1] - sg, db = img[i * 4 + 2] - sb; return dr * dr + dg * dg + db * db <= tol2; };
      while (stack.length) {
        const i = stack.pop()!; const x = i % W, y = (i - x) / W;
        if (x > 0 && !mask[i - 1] && ok(i - 1)) { mask[i - 1] = 1; stack.push(i - 1); }
        if (x < W - 1 && !mask[i + 1] && ok(i + 1)) { mask[i + 1] = 1; stack.push(i + 1); }
        if (y > 0 && !mask[i - W] && ok(i - W)) { mask[i - W] = 1; stack.push(i - W); }
        if (y < H - 1 && !mask[i + W] && ok(i + W)) { mask[i + W] = 1; stack.push(i + W); }
      }
      const poly = traceRegion(mask, W, H, 1.2).map((v) => Math.round((v / r.scale) * 10) / 10);
      st.setPixelSelection(poly.length >= 6 ? [poly] : null, e.shiftKey ? "add" : e.altKey ? "subtract" : "replace");
      return;
    }
    if (tool === "clone" || tool === "heal") {
      if (e.altKey) { setCloneSource(p); cloneOffset.current = null; return; }
      if (!cloneSource) { st.showToast("Alt-click to set the clone source first"); return; }
      let target = selection.map((id) => findLayer(doc, id)).find((l) => l?.type === "brush" && !l.locked);
      if (!target) {
        const layer = makeBrush({ name: tool === "heal" ? "Heal" : "Clone", x: 0, y: 0, width: doc.width, height: doc.height });
        st.dispatch([{ type: "layer.add", layer, parentId: null, index: doc.layers.length }], "New paint layer");
        st.select([layer.id]); target = layer;
      }
      if (!cloneOffset.current) cloneOffset.current = { dx: cloneSource.x - p.x, dy: cloneSource.y - p.y }; // aligned: offset fixed after the first stroke
      const q = toLocal(target, p);
      drag.current = { kind: "brush", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false, brushId: target.id, points: [q.x, q.y] };
      el.setPointerCapture(e.pointerId); return;
    }
    if (tool === "direct") {
      const hit = anchorHit(sx, sy);
      if (hit) { activeAnchor.current = hit.index; drag.current = { kind: "anchor", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false, anchor: hit }; el.setPointerCapture(e.pointerId); return; }
      if (e.altKey) {
        // Alt-click on the outline: insert an anchor there.
        const pa = pathAnchors();
        if (pa) { const q = toLocal(pa.layer, p); const next = insertAnchorNear(pa.anchors, { x: q.x / pa.layer.width, y: q.y / pa.layer.height }); if (next) st.dispatch([{ type: "layer.set", id: pa.layer.id, props: { path: anchorsToPath(next) } }], "Add anchor"); return; }
      }
      const l = layerAt(p); if (l) st.select([l.id]); else if (!e.shiftKey) st.select([]);
      return;
    }
    if (tool === "marquee") { drag.current = { kind: "pixelsel", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false, mode: e.altKey ? "subtract" : e.shiftKey && st.pixelSelection ? "add" : "replace", square: e.shiftKey && !st.pixelSelection }; el.setPointerCapture(e.pointerId); return; }
    if (tool === "lasso" && st.lassoKind === "polygon") {
      // Polygonal lasso: click adds a corner; clicking the first point or Enter closes.
      const first = lassoPts && lassoPts.length >= 4 ? toScreen({ x: lassoPts[0], y: lassoPts[1] }) : null;
      if (first && Math.hypot(first.x - sx, first.y - sy) <= 8 && lassoPts!.length >= 6) { finishPolyLasso(e.shiftKey ? "add" : e.altKey ? "subtract" : "replace"); return; }
      setLassoPts([...(lassoPts ?? []), p.x, p.y]); return;
    }
    if (tool === "lasso") { drag.current = { kind: "lasso", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false, points: [p.x, p.y], mode: e.altKey ? "subtract" : e.shiftKey ? "add" : "replace" }; setLassoPts([p.x, p.y]); el.setPointerCapture(e.pointerId); return; }
    if (tool === "gradient") { drag.current = { kind: "gradient", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false }; el.setPointerCapture(e.pointerId); return; }
    if (tool === "pen") {
      const first = penRef.current[0];
      if (first && penRef.current.length >= 2) { const fs = toScreen(first); if (Math.hypot(fs.x - sx, fs.y - sy) <= 8) { finishPen(); return; } }
      setPen((a) => [...a, { x: p.x, y: p.y, ox: 0, oy: 0 }]);
      drag.current = { kind: "pen", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false };
      el.setPointerCapture(e.pointerId); return;
    }
    if (tool === "eyedropper") {
      const r = rendered.current;
      if (r) {
        const px = r.canvas.getContext("2d")!.getImageData(Math.floor(p.x * r.scale), Math.floor(p.y * r.scale), 1, 1).data;
        if (px[3] > 0) useStore.getState().setFgColor("#" + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join(""));
      }
      return;
    }
    if ((tool === "brush" || tool === "eraser") && st.editMask && selection.length === 1) {
      // Painting the selected layer's mask: create a paint mask on first use (fully visible, then erase to hide).
      const target = findLayer(doc, selection[0]);
      if (target && !isGroup(target) && !target.locked) {
        if (target.mask?.kind !== "paint") st.dispatch([{ type: "layer.set", id: target.id, props: { mask: { kind: "paint", base: "show", strokes: [] } } }], "Add layer mask");
        const q = toLocal(target, p);
        drag.current = { kind: "brush", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false, brushId: target.id, points: [q.x, q.y], toMask: true };
        el.setPointerCapture(e.pointerId); return;
      }
    }
    if (tool === "brush" || tool === "eraser") {
      // Paint into the selected brush layer, or start a new one on top of the stack.
      let target = selection.map((id) => findLayer(doc, id)).find((l) => l?.type === "brush" && !l.locked);
      if (!target) {
        const layer = makeBrush({ name: "Paint", x: 0, y: 0, width: doc.width, height: doc.height });
        st.dispatch([{ type: "layer.add", layer, parentId: null, index: doc.layers.length }], "New paint layer");
        st.select([layer.id]);
        target = layer;
      }
      const q = toLocal(target, p);
      drag.current = { kind: "brush", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false, brushId: target.id, points: [q.x, q.y], pressures: e.pointerType === "pen" ? [e.pressure || 0.5] : undefined };
      el.setPointerCapture(e.pointerId); return;
    }

    // Distort / perspective / skew: drag the four corners of the selected layer
    if (st.distortMode && selection.length === 1) {
      const l = findLayer(doc, selection[0]);
      if (l && !isGroup(l) && !l.locked) {
        const cs = layerCorners(l).map(toScreen);
        const ci = cs.findIndex((c) => Math.hypot(c.x - sx, c.y - sy) <= 8);
        if (ci >= 0) { drag.current = { kind: "quad", start: p, startScreen: { x: sx, y: sy }, layers: [deepClone(l)], corner: ci, moved: false }; el.setPointerCapture(e.pointerId); return; }
      }
      useStore.setState({ distortMode: null });
    }

    // Transform selection: handles on the marching ants instead of layers
    if (st.selectionTransform && st.pixelSelection) {
      const pts = st.pixelSelection.flat(); const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
      const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      const v = virtualLayer(box);
      const c = layerCorners(v).map(toScreen);
      const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const hs: Record<Handle, { x: number; y: number }> = { nw: c[0], ne: c[1], se: c[2], sw: c[3], n: mid(c[0], c[1]), e: mid(c[1], c[2]), s: mid(c[2], c[3]), w: mid(c[3], c[0]) };
      let handle: Handle | "rotate" | null = null;
      for (const [k, q] of Object.entries(hs) as [Handle, { x: number; y: number }][]) if (Math.hypot(q.x - sx, q.y - sy) <= 6) handle = k;
      if (!handle) for (const k of ["nw", "ne", "se", "sw"] as Handle[]) { const dd = Math.hypot(hs[k].x - sx, hs[k].y - sy); if (dd > 6 && dd <= 22) handle = "rotate"; }
      const inside = p.x >= box.x && p.y >= box.y && p.x <= box.x + box.width && p.y <= box.y + box.height;
      if (handle === "rotate") { const cc = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; drag.current = { kind: "rotate", start: p, startScreen: { x: sx, y: sy }, layers: [v], box, angle0: Math.atan2(p.y - cc.y, p.x - cc.x), moved: false, onSelection: { rings: st.pixelSelection } }; }
      else if (handle) drag.current = { kind: "scale", start: p, startScreen: { x: sx, y: sy }, layers: [v], box, handle, moved: false, onSelection: { rings: st.pixelSelection } };
      else if (inside) drag.current = { kind: "move", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false, onSelection: { rings: st.pixelSelection } };
      else { useStore.setState({ selectionTransform: false }); return; }
      el.setPointerCapture(e.pointerId); return;
    }

    // Move tool
    const h = handleAt(sx, sy);
    if (h) {
      const tops = topLevelOnly(doc, selection).map((id) => findLayer(doc, id)!).filter(Boolean);
      const single = tops.length === 1 && !isGroup(tops[0]) ? tops[0] : null;
      const box = single ? undefined : unionBounds(tops.map((l) => (isGroup(l) ? virtualLayer(displayBounds(l)) : l)));
      const b = single ? layerBounds(single) : box!;
      const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      if (h === "rotate") drag.current = { kind: "rotate", start: p, startScreen: { x: sx, y: sy }, layers: tops.map(deepClone), box, angle0: Math.atan2(p.y - c.y, p.x - c.x), moved: false };
      else drag.current = { kind: "scale", start: p, startScreen: { x: sx, y: sy }, layers: tops.map(deepClone), box, handle: h, moved: false };
      el.setPointerCapture(e.pointerId); return;
    }
    // A selected layer can be grabbed anywhere inside its box (handy for groups), but not on its transparent pixels.
    let hit = layerAt(p) ?? (selection.map((id) => findLayer(doc, id)).find((l) => l && !l.locked && insideDisplay(l, p) && pixelTest(l, p) !== false) ?? undefined);
    // Photoshop: Alt-drag with the Move tool duplicates the layer(s) and moves the copies.
    if (hit && e.altKey && !e.shiftKey && tool === "move" && st.selection.includes(hit.id)) { st.duplicateSelection(); const s2 = useStore.getState(); hit = findLayer(s2.doc!, s2.selection[0]) ?? hit; }
    if (hit) {
      let sel = selection;
      if (e.shiftKey) { st.select([hit.id], { toggle: true }); sel = useStore.getState().selection; }
      else if (!selection.includes(hit.id)) { st.select([hit.id]); sel = [hit.id]; }
      const movable = topLevelOnly(doc, sel).map((id) => findLayer(doc, id)!).filter((l) => l && !l.locked);
      drag.current = { kind: "move", start: p, startScreen: { x: sx, y: sy }, layers: movable.map(deepClone), moved: false };
      el.setPointerCapture(e.pointerId);
    } else {
      if (!e.shiftKey) st.select([]);
      drag.current = { kind: "marquee", start: p, startScreen: { x: sx, y: sy }, layers: [], moved: false };
      el.setPointerCapture(e.pointerId);
    }
  };

  const insideDisplay = (l: Layer, p: { x: number; y: number }) => { const b = displayBounds(l); return p.x >= b.x && p.y >= b.y && p.x <= b.x + b.width && p.y <= b.y + b.height; };

  const zoomAt = (e: React.PointerEvent, factor: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const st = useStore.getState();
    const z = Math.min(32, Math.max(0.02, st.zoom * factor));
    st.setView(z, { x: sx - ((sx - st.pan.x) / st.zoom) * z, y: sy - ((sy - st.pan.y) / st.zoom) * z });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const el = wrapRef.current!;
    const rect = el.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const d = drag.current;
    const st = useStore.getState();
    const doc = st.doc; // always the live document: React's closure can lag behind a dispatch made in pointerdown
    if (doc) st.sendCursor(Math.round((sx - st.pan.x) / st.zoom), Math.round((sy - st.pan.y) / st.zoom));
    if (!d) {
      if (!doc) return;
      if (space || tool === "hand") setCursor("grab");
      else if (tool === "zoom") setCursor(e.altKey ? "zoom-out" : "zoom-in");
      else if (tool === "text") setCursor("text");
      else if (tool === "shape") setCursor("crosshair");
      else if (tool === "brush" || tool === "eraser") { setCursor("none"); setBrushPos({ x: sx, y: sy }); }
      else if (tool === "clone" || tool === "heal") { setCursor("none"); setBrushPos({ x: sx, y: sy }); }
      else if (tool === "crop" || tool === "eyedropper" || tool === "marquee" || tool === "lasso" || tool === "wand" || tool === "gradient" || tool === "pen") setCursor("crosshair");
      else if (tool === "direct") setCursor(anchorHit(sx, sy) ? "pointer" : "default");
      if (st.distortMode && selection.length === 1) { const l = findLayer(doc, selection[0]); if (l && layerCorners(l).map(toScreen).some((c) => Math.hypot(c.x - sx, c.y - sy) <= 8)) setCursor("move"); }
      else if (st.showRulers && (sx < RULER || sy < RULER)) setCursor(sx < RULER && sy >= RULER ? "col-resize" : "row-resize");
      else if (st.showGuides && doc.guides.some((g) => Math.abs((g.axis === "x" ? toScreen({ x: g.position, y: 0 }).x : toScreen({ x: 0, y: g.position }).y) - (g.axis === "x" ? sx : sy)) <= 4)) setCursor(doc.guides.find((g) => Math.abs((g.axis === "x" ? toScreen({ x: g.position, y: 0 }).x : toScreen({ x: 0, y: g.position }).y) - (g.axis === "x" ? sx : sy)) <= 4)!.axis === "x" ? "col-resize" : "row-resize");
      else {
        const h = handleAt(sx, sy);
        const l = h ? findLayer(doc, selection[0]) : undefined;
        setCursor(h === "rotate" ? "alias" : h ? handleCursor(h, l?.rotation ?? 0) : "default");
        const hit = h ? null : layerAt(toDoc(sx, sy));
        if ((hit?.id ?? null) !== st.hoverId) st.set("hoverId", hit?.id ?? null);
      }
      return;
    }
    const p = toDoc(sx, sy);
    if (d.kind === "brush") setBrushPos({ x: sx, y: sy });
    if (d.kind !== "brush" && Math.hypot(sx - d.startScreen.x, sy - d.startScreen.y) > 2) d.moved = true;
    d.current = p;
    if (d.kind === "pan" && d.rotateView) {
      let deg = ((Math.atan2(sy - size.h / 2, sx - size.w / 2) - d.angle0!) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      useStore.setState({ viewRotation: ((deg % 360) + 360) % 360 });
      return;
    }
    if (d.kind === "pan") { st.setView(st.zoom, { x: d.startScreen.x + (e.clientX - d.start.x), y: d.startScreen.y + (e.clientY - d.start.y) }); return; }
    if (d.kind === "guide") { setGuideDrag({ axis: d.axis!, pos: Math.round(d.axis === "x" ? p.x : p.y) }); setCursor(d.axis === "x" ? "col-resize" : "row-resize"); return; }
    if (d.kind === "pixelsel") {
      let w = p.x - d.start.x, h = p.y - d.start.y;
      if (d.square) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      setDrawRect({ x: Math.min(d.start.x, d.start.x + w), y: Math.min(d.start.y, d.start.y + h), w: Math.abs(w), h: Math.abs(h) });
      return;
    }
    if (d.kind === "lasso") { d.points!.push(p.x, p.y); setLassoPts([...d.points!]); return; }
    if (d.kind === "gradient") { setGradLine({ a: d.start, b: e.shiftKey ? snapAngle(d.start, p) : p }); return; }
    if (d.kind === "quad") {
      const l0 = d.layers[0]; const q = [...(l0.quad ?? [0, 0, 0, 0, 0, 0, 0, 0])] as number[];
      // Drag delta in layer-local units (rotation/scale removed).
      const a = toLocal({ ...l0, quad: undefined }, d.start), b = toLocal({ ...l0, quad: undefined }, p);
      let dx = b.x - a.x, dy = b.y - a.y; const k = d.corner!;
      const mode = st.distortMode;
      if (mode === "skew") {
        const horiz = Math.abs(dx) >= Math.abs(dy);
        const partner = horiz ? (k === 0 ? 1 : k === 1 ? 0 : k === 2 ? 3 : 2) : (k === 0 ? 3 : k === 3 ? 0 : k === 1 ? 2 : 1);
        if (horiz) { q[k * 2] += dx; q[partner * 2] += dx; } else { q[k * 2 + 1] += dy; q[partner * 2 + 1] += dy; }
      } else if (mode === "perspective") {
        const horiz = Math.abs(dx) >= Math.abs(dy);
        const partner = horiz ? (k === 0 ? 1 : k === 1 ? 0 : k === 2 ? 3 : 2) : (k === 0 ? 3 : k === 3 ? 0 : k === 1 ? 2 : 1);
        if (horiz) { q[k * 2] += dx; q[partner * 2] -= dx; } else { q[k * 2 + 1] += dy; q[partner * 2 + 1] -= dy; }
      } else { q[k * 2] += dx; q[k * 2 + 1] += dy; }
      st.setLocal([{ type: "layer.set", id: l0.id, props: { quad: q.map((v) => Math.round(v * 10) / 10) } }]);
      return;
    }
    if (d.kind === "anchor") {
      if (!doc) return;
      const l = findLayer(doc, st.selection[0]) as ShapeLayer | undefined; if (!l) return;
      const q = toLocal(l, p); const nx = q.x / l.width, ny = q.y / l.height;
      const a = d.anchor!.anchors.map((x) => ({ ...x })); const cur = a[d.anchor!.index];
      if (d.anchor!.part === "point") { cur.x = nx; cur.y = ny; }
      else if (d.anchor!.part === "out") { cur.ox = nx - cur.x; cur.oy = ny - cur.y; }
      else { cur.ox = cur.x - nx; cur.oy = cur.y - ny; }
      st.setLocal([{ type: "layer.set", id: l.id, props: { path: anchorsToPath(a) } }]);
      d.anchor!.anchors = a;
      return;
    }
    if (d.kind === "pen") {
      setPen((a) => { if (!a.length) return a; const last = { ...a[a.length - 1], ox: p.x - d.start.x, oy: p.y - d.start.y }; return [...a.slice(0, -1), last]; });
      return;
    }
    if (d.kind === "crop") {
      const x = Math.min(d.start.x, p.x), y = Math.min(d.start.y, p.y);
      useStore.setState({ cropRect: { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(Math.abs(p.x - d.start.x))), height: Math.max(1, Math.round(Math.abs(p.y - d.start.y))) } });
      return;
    }
    if (d.kind === "marquee" || d.kind === "draw") {
      let w = p.x - d.start.x, h = p.y - d.start.y;
      if (d.kind === "draw" && e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      setDrawRect({ x: Math.min(d.start.x, d.start.x + w), y: Math.min(d.start.y, d.start.y + h), w: Math.abs(w), h: Math.abs(h) });
      return;
    }
    if (!doc) return;
    if (d.kind === "brush") {
      const target = findLayer(doc, d.brushId!);
      if (!target) return;
      const q = toLocal(target, p);
      const pts = d.points!;
      if (Math.hypot(q.x - pts[pts.length - 2], q.y - pts[pts.length - 1]) < 1.5 / st.zoom) return;
      pts.push(q.x, q.y);
      if (d.pressures) d.pressures.push(e.pointerType === "pen" ? (e.pressure || 0.5) : 1);
      if (d.toMask) {
        if (target.mask?.kind !== "paint") return;
        const strokes = [...target.mask.strokes.slice(0, d.moved ? -1 : undefined), currentStroke(d)];
        st.setLocal([{ type: "layer.set", id: target.id, props: { mask: { ...target.mask, strokes } } }]);
      } else {
        if (target.type !== "brush") return;
        st.setLocal([{ type: "layer.set", id: target.id, props: { strokes: [...target.strokes.slice(0, d.moved ? -1 : undefined), currentStroke(d)] } }]);
      }
      d.moved = true;
      return;
    }
    if (!d.moved) return;
    if (d.onSelection) {
      const map = (pts0: number[]): number[] => {
        if (d.kind === "move") { const dx = p.x - d.start.x, dy = p.y - d.start.y; return pts0.map((v, i) => (i % 2 ? v + dy : v + dx)); }
        if (d.kind === "scale") {
          const nb = scaleProps(virtualLayer(d.box!), d.handle!, p, e.shiftKey, e.altKey) as unknown as Box;
          const sx2 = nb.width / Math.max(1e-6, d.box!.width), sy2 = nb.height / Math.max(1e-6, d.box!.height);
          return pts0.map((v, i) => (i % 2 ? nb.y + (v - d.box!.y) * sy2 : nb.x + (v - d.box!.x) * sx2));
        }
        const cc = { x: d.box!.x + d.box!.width / 2, y: d.box!.y + d.box!.height / 2 };
        let delta = Math.atan2(p.y - cc.y, p.x - cc.x) - d.angle0!;
        if (e.shiftKey) delta = Math.round(delta / (Math.PI / 12)) * (Math.PI / 12);
        const cos = Math.cos(delta), sin = Math.sin(delta); const out: number[] = [];
        for (let i = 0; i < pts0.length; i += 2) { const dx = pts0[i] - cc.x, dy = pts0[i + 1] - cc.y; out.push(cc.x + dx * cos - dy * sin, cc.y + dx * sin + dy * cos); }
        return out;
      };
      useStore.setState({ pixelSelection: d.onSelection.rings.map((ring) => map(ring).map((v) => Math.round(v * 10) / 10)) });
      return;
    }
    if (d.kind === "move") {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const snapped = snap(d.layers, dx, dy);
      dx = snapped.dx; dy = snapped.dy; setGuides(snapped.guides);
      const ops: Op[] = [];
      for (const l0 of d.layers) {
        ops.push({ type: "layer.set", id: l0.id, props: { x: l0.x + dx, y: l0.y + dy } });
        for (const c of descendants(l0)) ops.push({ type: "layer.set", id: c.id, props: { x: c.x + dx, y: c.y + dy } });
      }
      st.setLocal(ops);
    } else if (d.kind === "scale") {
      if (!d.box) {
        const l0 = d.layers[0];
        st.setLocal([{ type: "layer.set", id: l0.id, props: scaleProps(l0, d.handle!, p, e.shiftKey, e.altKey) }]);
      } else {
        const nb = scaleProps(virtualLayer(d.box), d.handle!, p, e.shiftKey, e.altKey) as unknown as Box;
        const members = d.layers.flatMap((l0) => [l0, ...descendants(l0)]);
        const corner = /[ns]/.test(d.handle!) && /[ew]/.test(d.handle!);
        st.setLocal(mapMembersToBox(members, d.box, nb, corner && !e.shiftKey).map((m) => ({ type: "layer.set" as const, id: m.id, props: m.props })));
      }
    } else if (d.kind === "rotate") {
      const b = d.box ?? layerBounds(d.layers[0]); const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      let delta = ((Math.atan2(p.y - c.y, p.x - c.x) - d.angle0!) * 180) / Math.PI;
      if (e.shiftKey) delta = Math.round((d.layers[0].rotation + delta) / 15) * 15 - d.layers[0].rotation;
      if (!d.box) {
        const l0 = d.layers[0];
        let rot = ((l0.rotation + delta + 180) % 360 + 360) % 360 - 180;
        st.setLocal([{ type: "layer.set", id: l0.id, props: { rotation: Math.round(rot * 10) / 10 } }]);
      } else {
        const members = d.layers.flatMap((l0) => [l0, ...descendants(l0)]);
        st.setLocal(rotateMembers(members, c, delta).map((m) => ({ type: "layer.set" as const, id: m.id, props: m.props })));
      }
    }
  };

  const currentStroke = (d: Drag) => {
    const st = useStore.getState();
    const stroke: import("@pictocity/core").BrushStroke = { points: d.points!.map((v) => Math.round(v * 10) / 10), size: st.brush.size, color: st.fgColor, opacity: st.brush.opacity, hardness: st.brush.hardness, erase: st.tool === "eraser" };
    if (d.pressures && d.pressures.length * 2 === d.points!.length && d.pressures.some((v) => Math.abs(v - 1) > 0.01)) stroke.pressures = d.pressures.map((v) => Math.round(v * 100) / 100);
    const target = st.doc && d.brushId ? findLayer(st.doc, d.brushId) : undefined;
    if ((st.tool === "clone" || st.tool === "heal") && cloneOffset.current && target) {
      const o = toLocal(target, { x: cloneOffset.current.dx + target.x, y: cloneOffset.current.dy + target.y });
      stroke.clone = { dx: Math.round(o.x * 10) / 10, dy: Math.round(o.y * 10) / 10 }; stroke.erase = false;
      if (st.tool === "heal") stroke.heal = true;
    }
    if (st.pixelSelection && target) {
      stroke.clipRings = st.pixelSelection.map((ring) => { const clip: number[] = []; for (let i = 0; i < ring.length; i += 2) { const q = toLocal(target, { x: ring[i], y: ring[i + 1] }); clip.push(Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10); } return clip; });
    }
    return stroke;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null; setGuides([]); setDrawRect(null);
    const el = wrapRef.current!; try { el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    setCursor(space ? "grab" : "default");
    const st = useStore.getState();
    if (!d || !st.doc) return;
    const doc = st.doc;
    if (d.kind === "pan") return;
    if (d.kind === "guide") {
      setGuideDrag(null);
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const onRuler = d.axis === "x" ? sx < RULER : sy < RULER;
      const pos = Math.round(d.axis === "x" ? d.current?.x ?? d.start.x : d.current?.y ?? d.start.y);
      const guides = [...doc.guides];
      if (d.guideIndex! >= 0) guides.splice(d.guideIndex!, 1);
      if (!onRuler && d.moved) guides.push({ axis: d.axis!, position: pos });
      if (d.guideIndex! < 0 && (onRuler || !d.moved)) return;
      st.dispatch([{ type: "doc.set", props: { guides } }], d.guideIndex! >= 0 ? (onRuler ? "Delete guide" : "Move guide") : "New guide");
      return;
    }
    if (d.kind === "marquee") {
      if (!d.moved || !d.current) return;
      const r = { x: Math.min(d.start.x, d.current.x), y: Math.min(d.start.y, d.current.y), w: Math.abs(d.current.x - d.start.x), h: Math.abs(d.current.y - d.start.y) };
      const hits = doc.layers.filter((l) => { if (!l.visible || l.type === "adjustment") return false; const b = displayBounds(l); return b.x < r.x + r.w && b.x + b.width > r.x && b.y < r.y + r.h && b.y + b.height > r.y; }).map((l) => l.id);
      st.select(hits, e.shiftKey ? { toggle: true } : undefined);
      return;
    }
    if (d.kind === "draw") {
      const cur = d.current ?? d.start;
      let w = cur.x - d.start.x, h = cur.y - d.start.y;
      if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      const x = Math.round(Math.min(d.start.x, d.start.x + w)), y = Math.round(Math.min(d.start.y, d.start.y + h));
      w = Math.round(Math.abs(w)); h = Math.round(Math.abs(h));
      if (tool === "shape") {
        const layer = makeShape({ shape: shapeKind, x, y, width: d.moved ? w : 200, height: d.moved ? h : (shapeKind === "line" ? 4 : 200), fill: shapeKind === "line" ? null : fgColor, strokeColor: shapeKind === "line" ? fgColor : null, strokeWidth: shapeKind === "line" ? 4 : 0, name: shapeKind[0].toUpperCase() + shapeKind.slice(1), radius: 0, sides: shapeKind === "polygon" ? 6 : 5, innerRadius: 0.5 });
        st.dispatch([{ type: "layer.add", layer, parentId: null, index: doc.layers.length }], `New ${layer.name}`);
        st.select([layer.id]); st.setTool("move");
      } else {
        const layer = makeText({ text: "", name: "Text", x: d.moved ? x : Math.round(d.start.x), y: d.moved ? y : Math.round(d.start.y - 30), width: d.moved ? w : 400, height: d.moved ? h : 72, wrap: d.moved, color: fgColor, fontSize: 60 });
        st.dispatch([{ type: "layer.add", layer, parentId: null, index: doc.layers.length }], "New text");
        st.select([layer.id]); st.setTool("move");
        useStore.setState({ editingTextId: layer.id });
      }
      return;
    }
    if (d.kind === "quad") {
      if (!d.moved) return;
      const l0 = d.layers[0]; const now = findLayer(doc, l0.id); if (!now) return;
      const q = now.quad;
      st.setLocal([{ type: "layer.set", id: l0.id, props: { quad: l0.quad ?? null } }]);
      st.dispatch([{ type: "layer.set", id: l0.id, props: { quad: q && q.some((v) => v !== 0) ? q : null } }], st.distortMode === "skew" ? "Skew" : st.distortMode === "perspective" ? "Perspective" : "Distort");
      return;
    }
    if (d.kind === "crop" || d.kind === "pen" || d.onSelection) return;
    if (d.kind === "anchor") {
      if (!d.moved) return;
      const l = findLayer(doc, st.selection[0]) as ShapeLayer | undefined; if (!l) return;
      st.setLocal([{ type: "layer.set", id: l.id, props: { path: originalPath.current ?? l.path } }]);
      st.dispatch([{ type: "layer.set", id: l.id, props: { path: anchorsToPath(d.anchor!.anchors) } }], "Edit path");
      return;
    }
    if (d.kind === "pixelsel") {
      const mode = d.mode ?? "replace";
      if (!d.moved || !d.current) { if (mode === "replace") st.setPixelSelection(null); return; }
      let w = d.current.x - d.start.x, h = d.current.y - d.start.y;
      if (d.square) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      const x = Math.min(d.start.x, d.start.x + w), y = Math.min(d.start.y, d.start.y + h); w = Math.abs(w); h = Math.abs(h);
      const pts = st.marqueeKind === "ellipse" ? ellipsePolygon(x, y, w, h) : [x, y, x + w, y, x + w, y + h, x, y + h];
      st.setPixelSelection([pts.map((v) => Math.round(v * 10) / 10)], mode);
      return;
    }
    if (d.kind === "lasso") {
      setLassoPts(null);
      st.setPixelSelection(d.points && d.points.length >= 6 ? [d.points.map((v) => Math.round(v * 10) / 10)] : null, d.mode ?? "replace");
      return;
    }
    if (d.kind === "gradient") {
      setGradLine(null);
      if (!d.moved || !d.current) return;
      const b = e.shiftKey ? snapAngle(d.start, d.current) : d.current;
      // Fill the artboard under the start point, or the whole canvas.
      const host = doc.layers.find((l) => isGroup(l) && l.artboard && d.start.x >= l.x && d.start.y >= l.y && d.start.x < l.x + l.width && d.start.y < l.y + l.height);
      const box = host ? { x: host.x, y: host.y, width: host.width, height: host.height } : { x: 0, y: 0, width: doc.width, height: doc.height };
      const dx = b.x - d.start.x, dy = b.y - d.start.y, len = Math.hypot(dx, dy) || 1;
      const vx = dx / len, vy = dy / len;
      const angle = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90) * 10) / 10;
      const half = (Math.abs(box.width * vx) + Math.abs(box.height * vy)) / 2;
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2, sx0 = cx - vx * half, sy0 = cy - vy * half;
      const t = (q: { x: number; y: number }) => Math.max(0, Math.min(1, ((q.x - sx0) * vx + (q.y - sy0) * vy) / (2 * half)));
      const gt = st.gradientType;
      const layer = makeFill({ name: "Gradient", x: box.x, y: box.y, width: box.width, height: box.height, fill: { kind: "gradient", type: gt, angle, scale: gt === "linear" ? 1 : Math.max(0.05, Math.min(5, (len / (Math.hypot(box.width, box.height) / 2)))), stops: [{ pos: gt === "linear" ? Math.round(t(d.start) * 1000) / 1000 : 0, color: st.fgColor, opacity: 1 }, { pos: gt === "linear" ? Math.round(t(b) * 1000) / 1000 : 1, color: st.bgColor, opacity: st.gradientToTransparent ? 0 : 1 }] } });
      st.dispatch([{ type: "layer.add", layer, parentId: host ? host.id : null, index: host && isGroup(host) ? host.children.length : doc.layers.length }], "Gradient fill");
      st.select([layer.id]);
      return;
    }
    if (d.kind === "brush" && d.toMask) {
      const target = findLayer(doc, d.brushId!);
      if (!target || target.mask?.kind !== "paint") return;
      const stroke = currentStroke(d);
      const before = d.moved ? target.mask.strokes.slice(0, -1) : target.mask.strokes;
      st.setLocal([{ type: "layer.set", id: target.id, props: { mask: { ...target.mask, strokes: before } } }]);
      st.dispatch([{ type: "layer.set", id: target.id, props: { mask: { ...target.mask, strokes: [...before, stroke] } } }], stroke.erase ? "Hide on mask" : "Reveal on mask");
      return;
    }
    if (d.kind === "brush") {
      const target = findLayer(doc, d.brushId!);
      if (!target || target.type !== "brush") return;
      const stroke = currentStroke(d);
      if (stroke.points.length < 2) return;
      // Put the layer back to its pre-stroke state locally, then append the stroke as one undoable op.
      const before = d.moved ? target.strokes.slice(0, -1) : target.strokes;
      st.setLocal([{ type: "layer.set", id: target.id, props: { strokes: before } }]);
      st.dispatch([{ type: "layer.push", id: target.id, key: "strokes", items: [stroke] }], stroke.erase ? "Eraser" : "Brush stroke");
      return;
    }
    if (!d.moved) return;
    // Commit the transient drag as one undoable op: restore start state locally, then dispatch the final props.
    const finals: Op[] = [];
    const restores: Op[] = [];
    const keys = ["x", "y", "width", "height", "rotation", "fontSize", "letterSpacing", "radius", "strokeWidth", "strokes", "quad"];
    for (const l0 of d.layers.flatMap((l) => [l, ...descendants(l)])) {
      const now = findLayer(doc, l0.id); if (!now) continue;
      const props: Record<string, unknown> = {}, prev: Record<string, unknown> = {};
      for (const k of keys) if (JSON.stringify((now as any)[k]) !== JSON.stringify((l0 as any)[k])) { props[k] = (now as any)[k]; prev[k] = (l0 as any)[k]; }
      if (Object.keys(props).length) { finals.push({ type: "layer.set", id: l0.id, props }); restores.push({ type: "layer.set", id: l0.id, props: prev }); }
    }
    if (!finals.length) return;
    st.setLocal(restores);
    st.dispatch(finals, d.kind === "move" ? "Move" : d.kind === "rotate" ? "Rotate" : "Scale");
  };

  const activeAnchor = useRef<number | null>(null);
  useEffect(() => {
    const onDel = () => { const pa = pathAnchors(); const i = activeAnchor.current; if (!pa || i === null || pa.anchors.length <= 3) return; useStore.getState().dispatch([{ type: "layer.set", id: pa.layer.id, props: { path: anchorsToPath(pa.anchors.filter((_, k) => k !== i)) } }], "Delete anchor"); activeAnchor.current = null; };
    window.addEventListener("pictocity:anchor-delete", onDel); return () => window.removeEventListener("pictocity:anchor-delete", onDel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!doc) return;
    if (tool === "rotate") { useStore.setState({ viewRotation: 0 }); return; }
    if (tool === "direct") {
      const rect = wrapRef.current!.getBoundingClientRect();
      const hit = anchorHit(e.clientX - rect.left, e.clientY - rect.top);
      const pa = pathAnchors();
      if (hit && pa && hit.part === "point") useStore.getState().dispatch([{ type: "layer.set", id: pa.layer.id, props: { path: anchorsToPath(toggleAnchorSmooth(pa.anchors, hit.index)) } }], "Toggle anchor");
      return;
    }
    if (tool !== "move") return;
    const rect = wrapRef.current!.getBoundingClientRect();
    const p = toDoc(e.clientX - rect.left, e.clientY - rect.top);
    const hit = pickLayer(doc, p, { enterGroups: true, pixelTest });
    if (hit?.type === "text" && !hit.locked) { useStore.getState().select([hit.id]); useStore.setState({ editingTextId: hit.id }); }
  };

  // ---- Direct selection (path anchors) --------------------------------------------------
  const originalPath = useRef<string | null>(null);
  const pathAnchors = (): { layer: ShapeLayer; anchors: PathAnchor[] } | null => {
    const st = useStore.getState();
    if (!st.doc || st.selection.length !== 1) return null;
    const l = findLayer(st.doc, st.selection[0]);
    if (!l || l.type !== "shape" || l.shape !== "path" || !l.path) return null;
    const anchors = parsePenPath(l.path); if (!anchors) return null;
    return { layer: l, anchors };
  };
  const anchorScreen = (l: ShapeLayer, nx: number, ny: number) => toScreen(localToDoc(l, { x: nx * l.width, y: ny * l.height }));
  const anchorHit = (sx: number, sy: number) => {
    const pa = pathAnchors(); if (!pa) return null;
    originalPath.current = pa.layer.path ?? null;
    for (let i = 0; i < pa.anchors.length; i++) {
      const a = pa.anchors[i];
      const parts: ["in" | "out" | "point", number, number][] = [["out", a.x + a.ox, a.y + a.oy], ["in", a.x - a.ox, a.y - a.oy], ["point", a.x, a.y]];
      for (const [part, nx, ny] of parts) { if (part !== "point" && !a.ox && !a.oy) continue; const q = anchorScreen(pa.layer, nx, ny); if (Math.hypot(q.x - sx, q.y - sy) <= 6) return { index: i, part, anchors: pa.anchors }; }
    }
    return null;
  };

  // ---- Snapping -----------------------------------------------------------------------
  const snap = (moving: Layer[], dx: number, dy: number) => {
    const st = useStore.getState(); const d = st.doc!;
    const tol = 6 / st.zoom;
    const movingIds = new Set(moving.flatMap((l) => [l.id, ...descendants(l).map((c) => c.id)]));
    const xs = [0, d.width / 2, d.width], ys = [0, d.height / 2, d.height];
    if (st.showGuides) for (const g of d.guides) (g.axis === "x" ? xs : ys).push(g.position);
    for (const { layer } of walk(d.layers)) {
      if (movingIds.has(layer.id) || !layer.visible || (isGroup(layer) && !layer.artboard) || layer.type === "adjustment") continue;
      const b = layerBounds(layer); xs.push(b.x, b.x + b.width / 2, b.x + b.width); ys.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
    const b = unionBounds(moving);
    if (st.showGrid) {
      const g = st.gridSize;
      for (const e of [b.x, b.x + b.width]) xs.push(Math.round((e + dx) / g) * g);
      for (const e of [b.y, b.y + b.height]) ys.push(Math.round((e + dy) / g) * g);
    }
    const cand = (edges: number[], targets: number[], delta: number) => {
      let best: { dist: number; adj: number; pos: number } | null = null;
      for (const e of edges) for (const t of targets) { const dist = Math.abs(e + delta - t); if (dist <= tol && (!best || dist < best.dist)) best = { dist, adj: t - (e + delta), pos: t }; }
      return best;
    };
    const sx = cand([b.x, b.x + b.width / 2, b.x + b.width], xs, dx), sy = cand([b.y, b.y + b.height / 2, b.y + b.height], ys, dy);
    const guides: { axis: "x" | "y"; pos: number }[] = [];
    if (sx) { dx += sx.adj; guides.push({ axis: "x", pos: sx.pos }); }
    if (sy) { dy += sy.adj; guides.push({ axis: "y", pos: sy.pos }); }
    return { dx: Math.round(dx), dy: Math.round(dy), guides };
  };

  // ---- Inline text editing ----------------------------------------------------------------
  const textRef = useRef<HTMLTextAreaElement>(null);
  const editing = editingTextId && doc ? (findLayer(doc, editingTextId) as TextLayer | undefined) : undefined;
  const editStart = useRef<string>("");
  useEffect(() => {
    if (editing && textRef.current) { editStart.current = editing.text; textRef.current.value = editing.text; autosize(textRef.current); textRef.current.focus(); textRef.current.select(); textRef.current.scrollTop = 0; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTextId]);

  const commitTextEdit = (cancel = false) => {
    const st = useStore.getState();
    const id = st.editingTextId; if (!id || !st.doc) return;
    const l = findLayer(st.doc, id) as TextLayer | undefined;
    const start = editStart.current;
    const value = cancel ? start : (textRef.current?.value ?? start);
    useStore.setState({ editingTextId: null });
    if (!l) return;
    // Typing updated the local document live; put the original back so the committed op has a correct inverse.
    st.setLocal([{ type: "layer.set", id, props: { text: start } }]);
    if (value.trim() === "" && start === "") { st.dispatch([{ type: "layer.remove", id }], "Delete empty text"); st.select([]); return; }
    if (value !== start) {
      const props: Record<string, unknown> = { text: value };
      if (l.name === "Text" || l.name === start.split("\n")[0].slice(0, 24)) props.name = value.split("\n")[0].slice(0, 24) || "Text";
      if (!l.wrap) { const m = measureText({ ...l, text: value }); props.width = Math.ceil(m.width) + 2; props.height = Math.ceil(m.height); }
      st.dispatch([{ type: "layer.set", id, props }], "Edit text");
    }
  };

  // ---- Overlay geometry -------------------------------------------------------------------
  const selLayers = doc ? selection.map((id) => findLayer(doc, id)).filter((l): l is Layer => !!l) : [];
  const hoverLayer = doc && hoverId && !selection.includes(hoverId) ? findLayer(doc, hoverId) : undefined;
  const poly = (l: Layer) => (isGroup(l) ? rectCorners(displayBounds(l)) : layerCorners(l)).map(toScreen).map((p) => `${p.x},${p.y}`).join(" ");
  const boxCorners = tool === "move" && !editingTextId ? selectionCorners() : null;
  const handles = boxCorners ? (() => { const c = boxCorners; const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); return [c[0], c[1], c[2], c[3], mid(c[0], c[1]), mid(c[1], c[2]), mid(c[2], c[3]), mid(c[3], c[0])]; })() : [];
  const agentSel = Object.entries(presence).filter(([a]) => a.startsWith("agent:")).flatMap(([a, p]) => p.selection.map((id) => ({ actor: a, layer: doc ? findLayer(doc, id) : undefined })).filter((x) => x.layer));
  const peerSel = Object.entries(presence).filter(([a]) => !a.startsWith("agent:") && Date.now() - presence[a].seen < 60_000).flatMap(([a, p]) => p.selection.map((id) => ({ actor: a, layer: doc ? findLayer(doc, id) : undefined })).filter((x) => x.layer && !selection.includes(x.layer.id)));

  if (!doc) return (
    <div className="canvas-area" ref={wrapRef}>
      <div className="empty">
        <div>
          <b>No document open</b>
          Create a new ad or open one the agent made.<br />
          <button className="btn primary" onClick={() => useStore.setState({ modal: "new" })}>New document</button>
          <button className="btn" onClick={() => { useStore.getState().refreshDocs(); useStore.setState({ modal: "open" }); }}>Open</button>
        </div>
      </div>
    </div>
  );

  const editPos = editing ? toScreen(layerCorners(editing)[0]) : null;

  return (
    <div className="canvas-area" ref={wrapRef} style={{ cursor }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={onDoubleClick} onPointerLeave={() => { useStore.getState().set("hoverId", null); setBrushPos(null); }}>
      <canvas className="stage" ref={canvasRef} />
      <svg className="overlay">
        {doc.layers.filter((l): l is GroupLayer => isGroup(l) && !!l.artboard).map((a) => { const p = toScreen(a), q = toScreen({ x: a.x + a.width, y: a.y + a.height }); return <rect key={a.id} className="artboard-frame" x={p.x} y={p.y} width={q.x - p.x} height={q.y - p.y} />; })}
        {showGuides && doc.guides.map((g, i) => g.axis === "x" ? <line key={i} className="doc-guide" x1={toScreen({ x: g.position, y: 0 }).x} x2={toScreen({ x: g.position, y: 0 }).x} y1={0} y2={size.h} /> : <line key={i} className="doc-guide" y1={toScreen({ x: 0, y: g.position }).y} y2={toScreen({ x: 0, y: g.position }).y} x1={0} x2={size.w} />)}
        {guideDrag && (guideDrag.axis === "x" ? <line className="doc-guide dragging" x1={toScreen({ x: guideDrag.pos, y: 0 }).x} x2={toScreen({ x: guideDrag.pos, y: 0 }).x} y1={0} y2={size.h} /> : <line className="doc-guide dragging" y1={toScreen({ x: 0, y: guideDrag.pos }).y} y2={toScreen({ x: 0, y: guideDrag.pos }).y} x1={0} x2={size.w} />)}
        {hoverLayer && tool === "move" && <polygon className="hover" points={poly(hoverLayer)} />}
        {agentSel.map(({ actor, layer }, i) => <g key={i}><polygon className="agent-sel" points={poly(layer!)} /></g>)}
        {peerSel.map(({ layer }, i) => <polygon key={`p${i}`} className="peer-sel" points={poly(layer!)} />)}
        {showExtras && !animating && selLayers.map((l) => <polygon key={l.id} className="bbox" points={poly(l)} />)}
        {!animating && boxCorners && selLayers.length > 1 && <polygon className="bbox" points={boxCorners.map((p) => `${p.x},${p.y}`).join(" ")} />}
        {(tool === "brush" || tool === "eraser" || tool === "clone" || tool === "heal") && brushPos && <circle className="brush-cursor" cx={brushPos.x} cy={brushPos.y} r={Math.max(2, (brush.size * zoom) / 2)} />}
        {(tool === "clone" || tool === "heal") && cloneSource && (() => { const q = toScreen(cloneSource); return <g className="clone-src"><line x1={q.x - 8} y1={q.y} x2={q.x + 8} y2={q.y} /><line x1={q.x} y1={q.y - 8} x2={q.x} y2={q.y + 8} /></g>; })()}
        {tool === "direct" && (() => { const pa = pathAnchors(); if (!pa) return null; return <g>{pa.anchors.map((a, i) => { const q = anchorScreen(pa.layer, a.x, a.y); const h1 = anchorScreen(pa.layer, a.x - a.ox, a.y - a.oy), h2 = anchorScreen(pa.layer, a.x + a.ox, a.y + a.oy); return <g key={i}>{(a.ox || a.oy) ? <><line className="pen-handle" x1={h1.x} y1={h1.y} x2={h2.x} y2={h2.y} /><circle className="handle" cx={h1.x} cy={h1.y} r={3} /><circle className="handle" cx={h2.x} cy={h2.y} r={3} /></> : null}<rect className="handle" x={q.x - 3.5} y={q.y - 3.5} width={7} height={7} /></g>; })}</g>; })()}
        {!animating && handles.map((p, i) => <rect key={i} className="handle" x={p.x - 3.5} y={p.y - 3.5} width={7} height={7} />)}
        {showExtras && guides.map((g, i) => g.axis === "x" ? <line key={i} className="guide" x1={toScreen({ x: g.pos, y: 0 }).x} x2={toScreen({ x: g.pos, y: 0 }).x} y1={0} y2={size.h} /> : <line key={i} className="guide" y1={toScreen({ x: 0, y: g.pos }).y} y2={toScreen({ x: 0, y: g.pos }).y} x1={0} x2={size.w} />)}
        {drawRect && (() => { const a = toScreen(drawRect), b = toScreen({ x: drawRect.x + drawRect.w, y: drawRect.y + drawRect.h }); return <rect className="marquee" x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} />; })()}
        {cropRect && (() => { const a = toScreen(cropRect), b = toScreen({ x: cropRect.x + cropRect.width, y: cropRect.y + cropRect.height }); return <g><path className="crop-shade" fillRule="evenodd" d={`M0 0H${size.w}V${size.h}H0Z M${a.x} ${a.y}H${b.x}V${b.y}H${a.x}Z`} /><rect className="crop-rect" x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} /><text className="crop-label" x={a.x + 4} y={a.y - 6}>{cropRect.width} × {cropRect.height} — Enter to crop, Esc to cancel</text></g>; })()}
        {animating && <text x={showRulers ? 30 : 12} y={showRulers ? 38 : 20} className="anim-note" fill="#f0a534" fontSize={12}>Previewing the timeline at {Math.round(animTime)} ms — handles are hidden; scrub to 0 to edit layout</text>}
        {editMask && selLayers.length === 1 && <polygon className="mask-mode" points={poly(selLayers[0])} />}
        {distortMode && selLayers.length === 1 && !isGroup(selLayers[0]) && layerCorners(selLayers[0]).map(toScreen).map((c, i) => <rect key={"q" + i} className="handle quad" x={c.x - 4.5} y={c.y - 4.5} width={9} height={9} />)}
        {showExtras && pixelSelection && pixelSelection.map((ring, ri) => { const pts = []; for (let i = 0; i < ring.length; i += 2) { const q = toScreen({ x: ring[i], y: ring[i + 1] }); pts.push(`${q.x},${q.y}`); } return <g key={ri}><polygon className="ants-bg" points={pts.join(" ")} /><polygon className="ants" points={pts.join(" ")} /></g>; })}
        {selectionTransform && pixelSelection && (() => { const flat = pixelSelection.flat(); const xs = flat.filter((_, i) => i % 2 === 0), ys = flat.filter((_, i) => i % 2 === 1); const a = toScreen({ x: Math.min(...xs), y: Math.min(...ys) }), b = toScreen({ x: Math.max(...xs), y: Math.max(...ys) }); const hs = [[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y], [(a.x + b.x) / 2, a.y], [b.x, (a.y + b.y) / 2], [(a.x + b.x) / 2, b.y], [a.x, (a.y + b.y) / 2]]; return <g><rect className="bbox" x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} />{hs.map((h, i) => <rect key={i} className="handle" x={h[0] - 3.5} y={h[1] - 3.5} width={7} height={7} />)}</g>; })()}
        {lassoPts && lassoPts.length >= 2 && (() => { const pts = []; for (let i = 0; i < lassoPts.length; i += 2) { const q = toScreen({ x: lassoPts[i], y: lassoPts[i + 1] }); pts.push(`${q.x},${q.y}`); } return <g><polyline className="marquee" points={pts.join(" ")} />{tool === "lasso" && lassoKind === "polygon" && lassoPts.length >= 2 && <rect className="handle" x={toScreen({ x: lassoPts[0], y: lassoPts[1] }).x - 3} y={toScreen({ x: lassoPts[0], y: lassoPts[1] }).y - 3} width={6} height={6} />}</g>; })()}
        {gradLine && (() => { const a = toScreen(gradLine.a), b = toScreen(gradLine.b); return <g><line className="grad-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} /><circle className="handle" cx={a.x} cy={a.y} r={4} /><circle className="handle" cx={b.x} cy={b.y} r={4} /></g>; })()}
        {pen.length > 0 && (() => {
          const S = (q: { x: number; y: number }) => toScreen(q);
          let d = ""; pen.forEach((a, i) => { const q = S(a); if (i === 0) d += `M${q.x} ${q.y}`; else { const pr = pen[i - 1], c1 = S({ x: pr.x + pr.ox, y: pr.y + pr.oy }), c2 = S({ x: a.x - a.ox, y: a.y - a.oy }); d += ` C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${q.x} ${q.y}`; } });
          return <g>
            <path className="pen-path" d={d} />
            {pen.map((a, i) => { const q = S(a); const h1 = S({ x: a.x - a.ox, y: a.y - a.oy }), h2 = S({ x: a.x + a.ox, y: a.y + a.oy }); return <g key={i}>{(a.ox || a.oy) ? <line className="pen-handle" x1={h1.x} y1={h1.y} x2={h2.x} y2={h2.y} /> : null}<rect className="handle" x={q.x - 3} y={q.y - 3} width={6} height={6} />{(a.ox || a.oy) ? <><circle className="handle" cx={h1.x} cy={h1.y} r={2.5} /><circle className="handle" cx={h2.x} cy={h2.y} r={2.5} /></> : null}</g>; })}
          </g>;
        })()}
      </svg>
      {doc.layers.filter((l): l is GroupLayer => isGroup(l) && !!l.artboard).map((a) => { const p = toScreen(a); return (
        <div key={a.id} className={`artboard-label${selection.includes(a.id) ? " selected" : ""}`} style={{ left: p.x, top: p.y - 18 }}
          onPointerDown={(e) => { e.stopPropagation(); useStore.getState().select([a.id], e.shiftKey ? { toggle: true } : undefined); }}
          onDoubleClick={(e) => { e.stopPropagation(); const name = prompt("Artboard name", a.name); if (name && name !== a.name) useStore.getState().setLayerProps(a.id, { name }, "Rename artboard"); }}>
          {a.name} <span>{a.width}×{a.height}</span>
        </div>); })}
      {Object.entries(presence).filter(([a, p]) => !a.startsWith("agent:") && p.cursor && Date.now() - p.seen < 8000).map(([a, p]) => { const q = toScreen(p.cursor!); return <div key={a} className="peer-cursor" style={{ left: q.x, top: q.y }}><svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1l12 9-5 1-3 6z" fill="#3ddc84" stroke="#fff" strokeWidth="1" /></svg><span>editor</span></div>; })}
      {peerSel.slice(0, 1).map(({ layer }) => { const b = toScreen(displayBounds(layer!)); return <div key="peer" className="agent-badge peer" style={{ left: b.x, top: b.y - 18 }}>another editor</div>; })}
      {agentSel.slice(0, 1).map(({ actor, layer }) => { const b = toScreen(displayBounds(layer!)); return <div key={actor} className="agent-badge" style={{ left: b.x, top: b.y - 18 }}>{actor.replace("agent:", "")}</div>; })}
      {editing && editPos && (
        <textarea
          ref={textRef}
          className="text-editor"
          spellCheck={false}
          style={{
            left: editPos.x, top: editPos.y, width: editing.width, minHeight: editing.height,
            transform: `rotate(${editing.rotation}deg) scale(${zoom * editing.scaleX}, ${zoom * editing.scaleY})`,
            font: fontString(editing), color: editing.color, lineHeight: editing.lineHeight, letterSpacing: editing.letterSpacing,
            textAlign: editing.align, whiteSpace: editing.wrap ? "pre-wrap" : "pre", textTransform: editing.textTransform ?? "none",
          }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") commitTextEdit(true); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitTextEdit(); }}
          onSelect={(e) => { const t = e.target as HTMLTextAreaElement; useStore.setState({ textSelection: { id: editing.id, start: t.selectionStart, end: t.selectionEnd } }); }}
          onBlur={(e) => { const rt = e.relatedTarget as HTMLElement | null; if (rt && rt.closest(".panels")) { setTimeout(() => textRef.current?.focus(), 0); return; } commitTextEdit(); }}
          onInput={(e) => { const el = e.target as HTMLTextAreaElement; autosize(el); useStore.getState().setLocal([{ type: "layer.set", id: editing.id, props: { text: el.value } }]); }}
        />
      )}
    </div>
  );
}

/** Photoshop-style rulers along the top and left edges, in document pixels. */
function drawRulers(ctx: CanvasRenderingContext2D, w: number, h: number, zoom: number, pan: { x: number; y: number }) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const major = steps.find((s) => s * zoom >= 60) ?? 5000;
  const minor = major / 5;
  ctx.save();
  ctx.fillStyle = "#2b2b2b"; ctx.fillRect(0, 0, w, RULER); ctx.fillRect(0, 0, RULER, h);
  ctx.strokeStyle = "#171717"; ctx.beginPath(); ctx.moveTo(0, RULER - 0.5); ctx.lineTo(w, RULER - 0.5); ctx.moveTo(RULER - 0.5, 0); ctx.lineTo(RULER - 0.5, h); ctx.stroke();
  ctx.fillStyle = "#9a9a9a"; ctx.strokeStyle = "#6f6f6f"; ctx.font = "9px -apple-system, Segoe UI, Helvetica, Arial, sans-serif"; ctx.textBaseline = "top"; ctx.lineWidth = 1;
  const first = Math.floor(-pan.x / zoom / minor) * minor, last = (w - pan.x) / zoom;
  ctx.beginPath();
  for (let v = first; v <= last; v += minor) { const x = Math.round(pan.x + v * zoom) + 0.5; const big = Math.abs(v / major - Math.round(v / major)) < 1e-6; ctx.moveTo(x, big ? 8 : 14); ctx.lineTo(x, RULER); if (big) ctx.fillText(String(v), x + 3, 3); }
  const firstY = Math.floor(-pan.y / zoom / minor) * minor, lastY = (h - pan.y) / zoom;
  for (let v = firstY; v <= lastY; v += minor) { const y = Math.round(pan.y + v * zoom) + 0.5; const big = Math.abs(v / major - Math.round(v / major)) < 1e-6; ctx.moveTo(big ? 8 : 14, y); ctx.lineTo(RULER, y); }
  ctx.stroke();
  ctx.save(); ctx.translate(3, 0); ctx.rotate(-Math.PI / 2); ctx.textBaseline = "top";
  for (let v = firstY; v <= lastY; v += minor) { if (Math.abs(v / major - Math.round(v / major)) < 1e-6) { const y = Math.round(pan.y + v * zoom); ctx.fillText(String(v), -y - 3 - ctx.measureText(String(v)).width, 0); } }
  ctx.restore();
  ctx.fillStyle = "#323232"; ctx.fillRect(0, 0, RULER, RULER);
  ctx.restore();
}

/** Grow the inline editor with its content so nothing scrolls out of view. */
function autosize(el: HTMLTextAreaElement) { el.style.height = "0px"; el.style.height = `${el.scrollHeight}px`; }

function snapAngle(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

function rectCorners(b: { x: number; y: number; width: number; height: number }) {
  return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
}

function handleCursor(h: Handle, rotation: number): string {
  const order = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  const cursors = ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "nwse-resize"];
  const i = (order.indexOf(h) + Math.round(rotation / 45) + 8) % 8;
  return cursors[i];
}

export type { GroupLayer };
