import type {
  AdDocument, Layer, GroupLayer, TextLayer, ShapeLayer, ImageLayer, FillLayer, AdjustmentLayer, BrushLayer,
  LayerFilters, LayerMask, LayerStyles,
} from "./types.js";
import { isGroup, walk as walkLayers, layerBounds, layerCorners, flattenPath, localToDocument, homography, applyHomography } from "./document.js";

// The renderer is written against the Canvas 2D API only. The environment
// supplies canvases and images, so the same code runs in the browser and in
// Node with @napi-rs/canvas. Pixels never come from anywhere else.

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): CanvasRenderingContext2D;
}

export interface RenderEnv {
  createCanvas(width: number, height: number): CanvasLike;
  /** Return a drawable for an asset id, or null if it has not loaded yet. */
  getImage(assetId: string): CanvasImageSource | null;
  createPath(d: string): Path2D;
}

/** A rasterised layer: its canvas plus where it sits in device pixels; `alpha` is the content silhouette (before effects) for clipping. */
export interface CachedLayer { canvas: CanvasLike; x: number; y: number; alpha?: CanvasLike }
/** Optional per-layer cache of rasterised layers (the editor uses one so only changed layers re-render). */
export interface RenderCache { get(key: string): CachedLayer | undefined; set(key: string, entry: CachedLayer): void }

interface Frame { x: number; y: number; w: number; h: number }

export interface RenderOptions {
  cache?: RenderCache;
  /** Called for every rasterised layer with its canvas and device position (e.g. for pixel-accurate hit testing). */
  onLayer?: (layer: Layer, entry: CachedLayer) => void;
  /** Output scale, 1 = document pixels. The editor renders at its zoom level. */
  scale?: number;
  /** Render only these layer ids (and their ancestors' effects). Used for layer thumbnails. */
  onlyLayerIds?: string[];
  /** Skip the document background (transparent). */
  transparent?: boolean;
  /** Layers to leave out, e.g. the text layer currently being edited inline. */
  hideLayerIds?: string[];
  /** Render only these top-level subtrees (e.g. one artboard). */
  rootLayerIds?: string[];
  /** Render this document-space rectangle instead of the whole canvas (e.g. an artboard's frame). */
  region?: { x: number; y: number; width: number; height: number };
}

type Ctx = CanvasRenderingContext2D;

export function renderDocument(doc: AdDocument, env: RenderEnv, opts: RenderOptions = {}): CanvasLike {
  const scale = opts.scale ?? 1;
  const region = opts.region ?? { x: 0, y: 0, width: doc.width, height: doc.height };
  const W = Math.max(1, Math.ceil(region.width * scale)), H = Math.max(1, Math.ceil(region.height * scale));
  const r = new Renderer(doc, env, scale, W, H, opts, region.x, region.y);
  const target = env.createCanvas(W, H);
  const ctx = target.getContext("2d");
  if (doc.background && !opts.transparent) { ctx.fillStyle = doc.background; ctx.fillRect(0, 0, W, H); }
  const roots = opts.rootLayerIds ? doc.layers.filter((l) => opts.rootLayerIds!.includes(l.id)) : doc.layers;
  r.renderList(roots, ctx);
  return target;
}

/** Render a single layer (with its styles) on a transparent canvas, e.g. for a thumbnail. */
export function renderLayer(doc: AdDocument, layer: Layer, env: RenderEnv, scale = 1): CanvasLike {
  const W = Math.max(1, Math.ceil(doc.width * scale)), H = Math.max(1, Math.ceil(doc.height * scale));
  const r = new Renderer(doc, env, scale, W, H, {});
  const target = env.createCanvas(W, H);
  r.renderList([layer], target.getContext("2d"));
  return target;
}

class Renderer {
  private maskCache = new Map<string, CanvasLike>();
  /** Snapshot of everything composited so far, available to clone-stamp strokes of the layer being rendered. */
  private below: CanvasLike | null = null;
  constructor(
    private doc: AdDocument, private env: RenderEnv, private scale: number,
    private W: number, private H: number, private opts: RenderOptions,
    private ox = 0, private oy = 0,
  ) { this.frame = { x: 0, y: 0, w: W, h: H }; }

  /** The device-pixel rectangle the canvases currently being drawn into represent (full canvas, or one layer's padded bounds). */
  private frame: Frame = { x: 0, y: 0, w: 0, h: 0 };

  private blank(): CanvasLike { return this.env.createCanvas(this.frame.w, this.frame.h); }

  /** Padded document-space bounds of a layer: its box plus room for effects, filters, feather and glyph overhang. */
  private paddedBounds(l: Layer): { x: number; y: number; w: number; h: number } | null {
    let box: { x: number; y: number; width: number; height: number };
    if (isGroup(l)) {
      if (l.artboard) box = layerBounds(l);
      else {
        const kids = l.children.filter((c) => c.visible).map((c) => this.paddedBounds(c)).filter((b): b is { x: number; y: number; w: number; h: number } => !!b);
        if (!kids.length) return null;
        const x0 = Math.min(...kids.map((b) => b.x)), y0 = Math.min(...kids.map((b) => b.y));
        box = { x: x0, y: y0, width: Math.max(...kids.map((b) => b.x + b.w)) - x0, height: Math.max(...kids.map((b) => b.y + b.h)) - y0 };
      }
    } else if (l.type === "brush") {
      // Strokes may reach outside the layer box: enclose every point (plus brush radius) then map through the transform.
      let x0 = 0, y0 = 0, x1 = l.width, y1 = l.height;
      for (const st of l.strokes) { const r = st.size / 2 + (1 - Math.min(1, Math.max(0, st.hardness))) * st.size; for (let i = 0; i < st.points.length; i += 2) { x0 = Math.min(x0, st.points[i] - r); y0 = Math.min(y0, st.points[i + 1] - r); x1 = Math.max(x1, st.points[i] + r); y1 = Math.max(y1, st.points[i + 1] + r); } }
      box = layerBounds({ ...l, x: l.x + x0, y: l.y + y0, width: x1 - x0, height: y1 - y0 } as Layer);
    } else box = layerBounds(l);
    if (l.quad) { const cs = layerCorners(l); const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y); const x0 = Math.min(...xs, box.x), y0 = Math.min(...ys, box.y); box = { x: x0, y: y0, width: Math.max(...xs, box.x + box.width) - x0, height: Math.max(...ys, box.y + box.height) - y0 }; }
    let pad = 2;
    const st = l.styles;
    if (st?.dropShadow?.enabled) pad = Math.max(pad, st.dropShadow.blur * 2 + Math.max(Math.abs(st.dropShadow.x), Math.abs(st.dropShadow.y)) + 2);
    if (st?.outerGlow?.enabled) pad = Math.max(pad, st.outerGlow.size * 2 + 2);
    if (st?.stroke?.enabled) pad = Math.max(pad, st.stroke.size + 2);
    if (l.filters?.blur) pad = Math.max(pad, l.filters.blur * 3 + 2);
    if (l.mask?.kind === "shape" && l.mask.feather) pad = Math.max(pad, l.mask.feather * 2 + 2);
    if (l.type === "text") pad = Math.max(pad, l.fontSize * 0.6 + Math.abs(l.letterSpacing));
    if (l.type === "shape") pad = Math.max(pad, l.strokeWidth * (l.shape === "line" ? 3 : 1) + 2);
    return { x: box.x - pad, y: box.y - pad, w: box.width + pad * 2, h: box.height + pad * 2 };
  }

  /** Device-pixel frame for a layer, clipped to the current frame; null when nothing of it is visible. */
  private frameFor(l: Layer): Frame | null {
    const b = this.paddedBounds(l);
    if (!b) return null;
    const s = this.scale, cur = this.frame;
    const x0 = Math.max(cur.x, Math.floor((b.x - this.ox) * s)), y0 = Math.max(cur.y, Math.floor((b.y - this.oy) * s));
    const x1 = Math.min(cur.x + cur.w, Math.ceil((b.x + b.w - this.ox) * s)), y1 = Math.min(cur.y + cur.h, Math.ceil((b.y + b.h - this.oy) * s));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Everything the rasterised layer depends on: its JSON, the view (scale/region), and whether its images have loaded. */
  private cacheKey(l: Layer): string {
    const imgs: string[] = [];
    for (const { layer } of isGroup(l) ? [...walkLayers(l.children), { layer: l }] : [{ layer: l }]) {
      if (layer.type === "image") imgs.push(`${layer.assetId}:${this.env.getImage(layer.assetId) ? 1 : 0}`);
      if (layer.mask?.kind === "raster") imgs.push(`${layer.mask.assetId}:${this.env.getImage(layer.mask.assetId) ? 1 : 0}`);
      if (layer.styles?.patternOverlay?.assetId) imgs.push(`${layer.styles.patternOverlay.assetId}:${this.env.getImage(layer.styles.patternOverlay.assetId) ? 1 : 0}`);
      if (layer.type === "fill" && layer.fill.kind === "pattern") imgs.push(`${layer.fill.assetId}:${this.env.getImage(layer.fill.assetId) ? 1 : 0}`);
    }
    const f = this.frame;
    return `${l.id}|${this.scale}|${this.ox},${this.oy}|${f.x},${f.y},${f.w},${f.h}|${imgs.join(",")}|${JSON.stringify(l)}`;
  }

  /** Set the document→device transform then the layer's own transform. */
  private applyLayerTransform(ctx: Ctx, l: Layer) {
    const s = this.scale;
    ctx.setTransform(s, 0, 0, s, -this.ox * s - this.frame.x, -this.oy * s - this.frame.y);
    const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((l.rotation * Math.PI) / 180);
    ctx.scale(l.scaleX, l.scaleY);
    ctx.translate(-l.width / 2, -l.height / 2);
  }

  renderList(layers: Layer[], target: Ctx) {
    const parent = this.frame; // the frame `target` represents
    // Clipping masks: the nearest non-clipped layer below is the base; hidden base hides its clipped layers.
    let base: { layer: Layer; entry: CachedLayer } | null = null;
    let baseHidden = false;
    for (const l of layers) {
      if (l.type !== "adjustment" && !l.clipToBelow) { base = null; baseHidden = !l.visible; }
      if (!l.visible) continue;
      if (l.clipToBelow && baseHidden) continue;
      if (this.opts.hideLayerIds?.includes(l.id)) continue;
      if (this.opts.onlyLayerIds && !this.opts.onlyLayerIds.includes(l.id) && !isGroup(l)) continue;
      if (l.type === "adjustment") { this.applyAdjustment(l, target); continue; }
      const passThrough = isGroup(l) && !l.artboard && !l.clipToBelow && l.blend === "normal" && l.opacity === 1 && !l.mask && !hasStyles(l.styles) && !hasFilters(l.filters);
      if (passThrough) { this.renderList((l as GroupLayer).children, target); continue; }

      const usesBelow = l.type === "brush" && l.strokes.some((st) => st.clone);
      const cache = this.opts.cache && !usesBelow ? this.opts.cache : null;
      const clipBase: { layer: Layer; entry: CachedLayer } | null = l.clipToBelow ? base : null;
      const key: string = cache ? this.cacheKey(l) + (clipBase ? `|clip:${JSON.stringify(clipBase.layer)}` : "") : "";
      let entry: CachedLayer | undefined = cache?.get(key);
      if (!entry) {
        const lf = usesBelow ? parent : this.frameFor(l);
        if (!lf) continue; // entirely outside the visible area
        this.frame = lf;
        if (usesBelow) { this.below = this.blank(); this.below.getContext("2d").drawImage(target.canvas as unknown as CanvasImageSource, parent.x - lf.x, parent.y - lf.y); }
        this.filtersConsumed = false;
        let content = this.renderContent(l);
        this.below = null;
        if (l.quad && !isGroup(l)) content = this.warpQuad(content, l);
        if (hasFilters(l.filters) && !this.filtersConsumed) content = this.applyFilters(content, l.filters!);
        this.filtersConsumed = false;
        if (isGroup(l) && l.artboard) content = this.applyMask(content, l, { kind: "shape", shape: "rect", x: 0, y: 0, width: l.width, height: l.height });
        if (l.mask) content = this.applyMask(content, l, l.mask);
        const fillOpacity = l.fillOpacity ?? 1;
        let styled = hasStyles(l.styles) ? this.applyStyles(content, l.styles!, fillOpacity, l) : fillOpacity < 1 ? this.fade(content, fillOpacity) : content;
        if (clipBase) styled = this.clipTo(styled, clipBase.entry, lf);
        this.frame = parent;
        entry = { canvas: styled, x: lf.x, y: lf.y, alpha: styled === content ? undefined : content };
        cache?.set(key, entry);
      }
      if (!l.clipToBelow) base = { layer: l, entry };

      this.opts.onLayer?.(l, entry);
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalAlpha = l.opacity;
      target.globalCompositeOperation = (l.blend === "normal" ? "source-over" : l.blend) as GlobalCompositeOperation;
      target.drawImage(entry.canvas as unknown as CanvasImageSource, entry.x - parent.x, entry.y - parent.y);
      target.restore();
    }
  }

  private renderContent(l: Layer): CanvasLike {
    const c = this.blank();
    const ctx = c.getContext("2d");
    if (isGroup(l)) { this.renderList(l.children, ctx); return c; }
    ctx.save();
    this.applyLayerTransform(ctx, l);
    switch (l.type) {
      case "text": this.drawText(ctx, l); break;
      case "shape": this.drawShape(ctx, l); break;
      case "image": this.drawImage(ctx, l); break;
      case "fill": this.drawFill(ctx, l); break;
      case "brush": this.drawBrush(ctx, l); break;
    }
    ctx.restore();
    return c;
  }

  // ---- Content ---------------------------------------------------------------

  private drawTextOnPath(ctx: Ctx, l: TextLayer) {
    const poly = flattenPath(l.onPath!.path, l.width, l.height);
    if (poly.length < 4) return;
    // Cumulative lengths along the polyline.
    const lens = [0];
    for (let i = 2; i < poly.length; i += 2) lens.push(lens[lens.length - 1] + Math.hypot(poly[i] - poly[i - 2], poly[i + 1] - poly[i - 1]));
    const total = lens[lens.length - 1];
    if (total <= 0) return;
    const at = (d: number) => {
      d = Math.max(0, Math.min(total, d));
      let k = 1; while (k < lens.length - 1 && lens[k] < d) k++;
      const t = lens[k] === lens[k - 1] ? 0 : (d - lens[k - 1]) / (lens[k] - lens[k - 1]);
      const x0 = poly[(k - 1) * 2], y0 = poly[(k - 1) * 2 + 1], x1 = poly[k * 2], y1 = poly[k * 2 + 1];
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, angle: Math.atan2(y1 - y0, x1 - x0) };
    };
    let text = l.text.replace(/\n+/g, " ");
    if (l.textTransform === "uppercase") text = text.toUpperCase(); else if (l.textTransform === "lowercase") text = text.toLowerCase();
    ctx.font = fontString(l); ctx.fillStyle = l.color; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    const chars = [...text].map((ch) => ({ ch, w: ctx.measureText(ch).width }));
    const textLen = chars.reduce((a, c) => a + c.w + l.letterSpacing, -l.letterSpacing);
    const align = l.onPath!.align ?? "center";
    let d = (l.onPath!.offset ?? 0) * total + (align === "center" ? (total - textLen) / 2 : align === "end" ? total - textLen : 0);
    const flip = !!l.onPath!.flip;
    for (const c of chars) {
      const mid = d + c.w / 2;
      if (mid >= 0 && mid <= total) {
        const p = at(mid);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle + (flip ? Math.PI : 0));
        ctx.fillText(c.ch, -c.w / 2, flip ? l.fontSize * 0.75 : 0);
        ctx.restore();
      }
      d += c.w + l.letterSpacing;
    }
  }

  private drawText(ctx: Ctx, l: TextLayer) {
    const c = ctx as Ctx & { fontKerning?: string };
    if ("fontKerning" in c) c.fontKerning = l.kerning === false ? "none" : "normal";
    const hs = l.textScaleX ?? 1, vs = l.textScaleY ?? 1;
    if ((hs !== 1 || vs !== 1 || l.baselineShift) && !l.onPath && !l.vertical) {
      // Scale the glyphs (not the box): lay out at width/hs, then draw scaled about the box's top-left.
      ctx.save(); ctx.translate(0, -(l.baselineShift ?? 0)); ctx.scale(hs, vs);
      this.drawTextPlain(ctx, { ...l, width: l.width / hs, height: l.height / vs, textScaleX: 1, textScaleY: 1, baselineShift: 0 });
      ctx.restore(); return;
    }
    this.drawTextPlain(ctx, l);
  }

  private drawTextPlain(ctx: Ctx, l: TextLayer) {
    if (l.onPath?.path) { this.drawTextOnPath(ctx, l); return; }
    if (l.vertical) {
      // Vertical type: one column per line, characters stacked; columns run right to left like CJK layout.
      ctx.font = fontString(l); ctx.fillStyle = l.color; ctx.textBaseline = "alphabetic"; ctx.textAlign = "center";
      let text = l.text; if (l.textTransform === "uppercase") text = text.toUpperCase(); else if (l.textTransform === "lowercase") text = text.toLowerCase();
      const cols = text.split("\n"), colW = l.fontSize * l.lineHeight, step = l.fontSize + l.letterSpacing;
      const totalW = cols.length * colW;
      let x0 = l.align === "left" ? colW / 2 : l.align === "right" ? l.width - totalW + colW / 2 : (l.width - totalW) / 2 + colW / 2;
      cols.forEach((col, ci) => {
        const x = x0 + (cols.length - 1 - ci) * colW;
        const colH = [...col].length * step;
        let y = (l.verticalAlign === "middle" ? (l.height - colH) / 2 : l.verticalAlign === "bottom" ? l.height - colH : 0) + l.fontSize * 0.8;
        for (const ch of col) { ctx.fillText(ch, x, y); y += step; }
      });
      return;
    }
    const layout = layoutText(ctx, l);
    ctx.fillStyle = l.color;
    ctx.font = fontString(l);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    const lineH = l.fontSize * l.lineHeight;
    const blockH = layout.lines.length * lineH;
    let top = 0;
    if (l.verticalAlign === "middle") top = (l.height - blockH) / 2;
    else if (l.verticalAlign === "bottom") top = l.height - blockH;
    // Baseline sits so that the em box is vertically centred in the line box.
    const baselineOffset = (lineH - l.fontSize) / 2 + l.fontSize * 0.8;
    layout.lines.forEach((line, i) => {
      let x = 0;
      if (l.align === "center") x = (l.width - line.width) / 2;
      else if (l.align === "right") x = l.width - line.width;
      else x = 0;
      const y = top + i * lineH + baselineOffset;
      if (l.runs?.length) {
        // Rich text: draw character by character with each character's own font, colour and underline.
        let cx = x; const chars = [...line.text];
        const extra = l.align === "justify" && !line.last ? (l.width - line.width) / Math.max(1, chars.filter((c) => c === " ").length) : 0;
        let ul: { x: number; color: string } | null = null; // underline span in progress
        const endUl = (to: number) => { if (ul) { ctx.fillStyle = ul.color; ctx.fillRect(ul.x, y + l.fontSize * 0.1, to - ul.x, Math.max(1, l.fontSize * 0.06)); ul = null; } };
        for (let k = 0; k < chars.length; k++) {
          const st = charStyle(l, line.start + k);
          ctx.font = fontString({ ...l, ...st }); ctx.fillStyle = st.color;
          const w = line.charWidths?.[k] ?? ctx.measureText(chars[k]).width + l.letterSpacing;
          ctx.fillText(chars[k], cx, y);
          if (st.underline) { if (!ul) ul = { x: cx, color: st.color }; else if (ul.color !== st.color) { endUl(cx); ul = { x: cx, color: st.color }; } }
          else endUl(cx);
          cx += w + (chars[k] === " " ? extra : 0);
        }
        endUl(cx - (l.letterSpacing || 0));
        return;
      }
      const words = line.text.split(" ");
      if (l.align === "justify" && !line.last && words.length > 1) {
        // Spread the slack across the gaps; the last line of a paragraph stays left-aligned.
        const gap = (l.width - line.width + (l.letterSpacing ? 0 : 0)) / (words.length - 1) + ctx.measureText(" ").width;
        let cx = 0;
        for (const w of words) { ctx.fillText(w, cx, y); cx += ctx.measureText(w).width + gap; }
      } else if (l.letterSpacing) {
        let cx = x;
        for (const ch of line.text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + l.letterSpacing; }
      } else ctx.fillText(line.text, x, y);
      if ((l.underline || l.strikethrough) && line.width > 0) {
        const th = Math.max(1, l.fontSize * 0.06);
        if (l.underline) ctx.fillRect(x, y + l.fontSize * 0.1, line.width, th);
        if (l.strikethrough) ctx.fillRect(x, y - l.fontSize * 0.28, line.width, th);
      }
    });
  }

  private drawShape(ctx: Ctx, l: ShapeLayer) {
    const w = l.width, h = l.height;
    const path = shapePath(this.env, l);
    if (l.dash?.length) ctx.setLineDash(l.dash);
    if (l.shape === "line") {
      const color = l.strokeColor ?? l.fill ?? "#000", sw = l.strokeWidth || 2, head = sw * 3;
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.lineWidth = sw; ctx.lineCap = "round";
      const a = l.arrows ?? "none", x0 = a === "start" || a === "both" ? head : 0, x1 = a === "end" || a === "both" ? w - head : w;
      ctx.beginPath(); ctx.moveTo(x0, h / 2); ctx.lineTo(x1, h / 2); ctx.stroke();
      ctx.setLineDash([]);
      if (a === "start" || a === "both") { ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(head, h / 2 - head / 2); ctx.lineTo(head, h / 2 + head / 2); ctx.closePath(); ctx.fill(); }
      if (a === "end" || a === "both") { ctx.beginPath(); ctx.moveTo(w, h / 2); ctx.lineTo(w - head, h / 2 - head / 2); ctx.lineTo(w - head, h / 2 + head / 2); ctx.closePath(); ctx.fill(); }
      return;
    }
    if (l.fill) { ctx.fillStyle = l.fill; ctx.fill(path); }
    if (l.strokeColor && l.strokeWidth > 0) { ctx.strokeStyle = l.strokeColor; ctx.lineWidth = l.strokeWidth; ctx.lineJoin = "round"; ctx.stroke(path); }
    ctx.setLineDash([]);
  }

  private drawImage(ctx: Ctx, l: ImageLayer) {
    const img = this.env.getImage(l.assetId);
    if (!img) {
      // Placeholder while the asset loads (or if missing): hatched box.
      ctx.fillStyle = "rgba(128,128,128,0.25)"; ctx.fillRect(0, 0, l.width, l.height);
      ctx.strokeStyle = "rgba(128,128,128,0.6)"; ctx.lineWidth = 2; ctx.strokeRect(1, 1, l.width - 2, l.height - 2);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(l.width, l.height); ctx.moveTo(l.width, 0); ctx.lineTo(0, l.height); ctx.stroke();
      return;
    }
    const a = this.doc.assets[l.assetId];
    const sw0 = a?.width ?? (img as any).width, sh0 = a?.height ?? (img as any).height;
    const crop = l.crop ?? { x: 0, y: 0, width: sw0, height: sh0 };
    let sx = crop.x, sy = crop.y, sw = crop.width, sh = crop.height;
    let dx = 0, dy = 0, dw = l.width, dh = l.height;
    if (l.fit === "cover") {
      const r = Math.max(dw / sw, dh / sh);
      const vw = dw / r, vh = dh / r;
      sx += (sw - vw) / 2; sy += (sh - vh) / 2; sw = vw; sh = vh;
    } else if (l.fit === "contain") {
      const r = Math.min(dw / sw, dh / sh);
      const vw = sw * r, vh = sh * r;
      dx = (dw - vw) / 2; dy = (dh - vh) / 2; dw = vw; dh = vh;
    }
    ctx.imageSmoothingEnabled = true;
    (ctx as any).imageSmoothingQuality = "high";
    // Downsampling more than ~25 %: prefilter with Lanczos-3 instead of trusting the engine's bilinear (which aliases).
    const devW = dw * this.scale * Math.abs(l.scaleX), devH = dh * this.scale * Math.abs(l.scaleY);
    if (sw > devW * 1.25 && sh > devH * 1.25 && devW >= 1 && devH >= 1) {
      const key = `${l.assetId}|${Math.round(sx)},${Math.round(sy)},${Math.round(sw)},${Math.round(sh)}|${Math.round(devW)}x${Math.round(devH)}`;
      let small = resampleCache.get(key);
      if (!small) {
        const tw = Math.max(1, Math.round(devW)), th = Math.max(1, Math.round(devH));
        const srcCanvas = this.env.createCanvas(Math.round(sw), Math.round(sh)); srcCanvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, Math.round(sw), Math.round(sh));
        const srcData = srcCanvas.getContext("2d").getImageData(0, 0, Math.round(sw), Math.round(sh));
        small = this.env.createCanvas(tw, th); small.getContext("2d").putImageData(resampleLanczos(srcData.data, Math.round(sw), Math.round(sh), tw, th, small.getContext("2d").createImageData(tw, th)), 0, 0);
        resampleCache.set(key, small); if (resampleCache.size > 64) resampleCache.delete(resampleCache.keys().next().value as string);
      }
      ctx.drawImage(small as unknown as CanvasImageSource, 0, 0, small.width, small.height, dx, dy, dw, dh);
      return;
    }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  private drawFill(ctx: Ctx, l: FillLayer) {
    const f = l.fill;
    if (f.kind === "solid") ctx.fillStyle = f.color;
    else if (f.kind === "linear") { this.drawGradient(ctx, l.width, l.height, { kind: "gradient", type: "linear", angle: f.angle, stops: [{ pos: f.stops?.[0] ?? 0, color: f.from }, { pos: f.stops?.[1] ?? 1, color: f.to }] }, l.filters); return; }
    else if (f.kind === "radial") { this.drawGradient(ctx, l.width, l.height, { kind: "gradient", type: "radial", angle: 0, stops: [{ pos: 0, color: f.from }, { pos: 1, color: f.to }] }, l.filters); return; }
    else if (f.kind === "gradient") { this.drawGradient(ctx, l.width, l.height, f, l.filters); return; }
    else if (f.kind === "pattern") {
      const img = this.env.getImage(f.assetId); const a = this.doc.assets[f.assetId];
      if (!img) { ctx.fillStyle = "rgba(128,128,128,0.25)"; ctx.fillRect(0, 0, l.width, l.height); return; }
      const tw = Math.max(1, (a?.width ?? (img as { width: number }).width) * f.scale), th = Math.max(1, (a?.height ?? (img as { height: number }).height) * f.scale);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, l.width, l.height); ctx.clip();
      for (let y = 0; y < l.height; y += th) for (let x = 0; x < l.width; x += tw) ctx.drawImage(img, x, y, tw, th);
      ctx.restore(); return;
    } else return;
    ctx.fillRect(0, 0, l.width, l.height);
  }

  /** Multi-stop gradient in any Photoshop style; angle/reflected/diamond are computed per pixel. */
  /** Set by drawGradient when it applied the layer's per-pixel filters itself, so the 8-bit filter pass is skipped. */
  private filtersConsumed = false;

  private drawGradient(ctx: Ctx, w: number, h: number, g: import("./types.js").GradientFill, filters?: LayerFilters) {
    const perPixelOnly = filters && !filters.blur && !CONV_KEYS.some((k) => filters[k] !== undefined && filters[k] !== null);
    const colorOps = perPixelOnly && hasColorOps(filters!), lutFns = perPixelOnly ? buildLutFns(filters!) : null, adj = perPixelOnly && hasPixelAdjustments(filters!) ? pixelAdjuster(filters!) : null;
    const fpx = new Float32Array(4);
    if (perPixelOnly) this.filtersConsumed = true;
    // Every gradient is computed per pixel in float (linear light when the document asks for it) and dithered once:
    // the engine's own gradients are 8-bit and band on subtle ramps.
    const stops0 = [...g.stops].sort((a, b) => a.pos - b.pos);
    const list = g.reverse ? stops0.map((st) => ({ ...st, pos: 1 - st.pos })).reverse() : stops0;
    const lin = !!this.doc.linearBlending;
    const col = (st: import("./types.js").GradientStop) => { const m = /^#?([0-9a-f]{6})$/i.exec(st.color); const n = m ? parseInt(m[1], 16) : 0; const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (lin ? LIN[v] : v)); return [c[0], c[1], c[2], (st.opacity ?? 1) * 255] as [number, number, number, number]; };
    const cols = list.map(col);
    const at = (t: number): [number, number, number, number] => { if (t <= list[0].pos) return cols[0]; for (let k = 1; k < list.length; k++) { if (t <= list[k].pos) { const A = list[k - 1], B = list[k], u = B.pos === A.pos ? 0 : (t - A.pos) / (B.pos - A.pos); const ca = cols[k - 1], cb = cols[k]; return [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u, ca[3] + (cb[3] - ca[3]) * u]; } } return cols[cols.length - 1]; };
    const sc = g.scale ?? 1, a = ((g.angle - 90) * Math.PI) / 180, cx = w / 2, cy = h / 2;
    const t0 = ctx.getTransform(); const s = Math.hypot(t0.a, t0.b) || 1;
    const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
    const tmp = this.env.createCanvas(W, H); const tc = tmp.getContext("2d"); const id = tc.createImageData(W, H); const px = id.data;
    const half = (Math.hypot(w, h) / 2) * sc, len = ((Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2) * sc;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x / s - cx, dy = y / s - cy; let t = 0;
      if (g.type === "linear") t = Math.max(0, Math.min(1, ((dx * Math.cos(a) + dy * Math.sin(a)) / (2 * len)) + 0.5));
      else if (g.type === "radial") t = Math.min(1, Math.hypot(dx, dy) / half);
      else if (g.type === "angle") t = ((Math.atan2(dy, dx) - a + Math.PI * 4) % (Math.PI * 2)) / (Math.PI * 2);
      else if (g.type === "reflected") t = Math.min(1, Math.abs((dx * Math.cos(a) + dy * Math.sin(a)) / half));
      else { const u = Math.abs(dx * Math.cos(a) + dy * Math.sin(a)), v = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a)); t = Math.min(1, (u + v) / half); }
      const c = at(t); const i = (y * W + x) * 4;
      fpx[0] = lin ? toSrgbScalar(c[0]) : c[0]; fpx[1] = lin ? toSrgbScalar(c[1]) : c[1]; fpx[2] = lin ? toSrgbScalar(c[2]) : c[2]; fpx[3] = c[3];
      if (colorOps) applyColorOps(filters!, fpx); if (lutFns) { fpx[0] = lutFns[0](fpx[0]); fpx[1] = lutFns[1](fpx[1]); fpx[2] = lutFns[2](fpx[2]); } if (adj) adj(fpx as unknown as Uint8ClampedArray, 0);
      let h1 = ((x + y * 65537) * 2654435761) >>> 0; h1 ^= h1 >>> 15; h1 = Math.imul(h1, 2246822519) >>> 0; h1 ^= h1 >>> 13;
      const d = ((h1 & 0xffff) / 0xffff + ((h1 >>> 16) & 0xffff) / 0xffff - 1) * 0.5;
      px[i] = clampByte(fpx[0] + d); px[i + 1] = clampByte(fpx[1] + d); px[i + 2] = clampByte(fpx[2] + d); px[i + 3] = clampByte(fpx[3]);
    }
    tc.putImageData(id, 0, 0);
    ctx.drawImage(tmp as unknown as CanvasImageSource, 0, 0, w, h);
  }

  private drawBrush(ctx: Ctx, l: BrushLayer) { this.drawStrokes(ctx, l.strokes); }

  private drawStrokes(ctx: Ctx, strokes: BrushLayer["strokes"], forceColor?: string) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const s of strokes) {
      const pts = s.points;
      if (pts.length < 2) continue;
      ctx.save();
      const clipRings = s.clipRings ?? (s.clip && s.clip.length >= 6 ? [s.clip] : null);
      if (clipRings?.length) { ctx.beginPath(); for (const r of clipRings) { if (r.length < 6) continue; ctx.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1]); ctx.closePath(); } ctx.clip("evenodd"); }
      ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
      if (s.clone && this.below) {
        // Clone stamp: the stroke is a mask over the composite below, shifted by the sample offset.
        const t = (ctx as unknown as { getTransform?: () => DOMMatrix }).getTransform?.();
        const mask = this.blank(); const mc = mask.getContext("2d");
        if (t) mc.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
        mc.lineCap = "round"; mc.lineJoin = "round"; mc.strokeStyle = "#fff"; mc.fillStyle = "#fff"; mc.lineWidth = s.size;
        const soft = (1 - Math.min(1, Math.max(0, s.hardness))) * s.size * 0.5 * this.scale;
        if (soft > 0.5) mc.filter = `blur(${soft}px)`;
        mc.beginPath();
        if (pts.length === 2) { mc.arc(pts[0], pts[1], s.size / 2, 0, Math.PI * 2); mc.fill(); }
        else { mc.moveTo(pts[0], pts[1]); for (let i = 2; i + 3 < pts.length; i += 2) mc.quadraticCurveTo(pts[i], pts[i + 1], (pts[i] + pts[i + 2]) / 2, (pts[i + 1] + pts[i + 3]) / 2); mc.lineTo(pts[pts.length - 2], pts[pts.length - 1]); mc.stroke(); }
        const tmp = this.blank(); const tc = tmp.getContext("2d");
        if (s.heal) {
          // Healing: texture (high frequencies) from the shifted source, tone (low frequencies) from the destination:
          // result = source - blur(source) + blur(destination).
          const r = Math.max(2, s.size * 0.5 * this.scale);
          const shifted = this.blank(); shifted.getContext("2d").drawImage(this.below as unknown as CanvasImageSource, -s.clone.dx * this.scale, -s.clone.dy * this.scale);
          const srcBlur = this.blank(); { const c = srcBlur.getContext("2d"); c.filter = `blur(${r}px)`; c.drawImage(shifted as unknown as CanvasImageSource, 0, 0); }
          const dstBlur = this.blank(); { const c = dstBlur.getContext("2d"); c.filter = `blur(${r}px)`; c.drawImage(this.below as unknown as CanvasImageSource, 0, 0); }
          const a = shifted.getContext("2d").getImageData(0, 0, this.frame.w, this.frame.h), b = srcBlur.getContext("2d").getImageData(0, 0, this.frame.w, this.frame.h), d = dstBlur.getContext("2d").getImageData(0, 0, this.frame.w, this.frame.h);
          const pa = a.data, pb = b.data, pd = d.data;
          for (let i = 0; i < pa.length; i += 4) { for (let k = 0; k < 3; k++) pa[i + k] = Math.max(0, Math.min(255, pa[i + k] - pb[i + k] + pd[i + k])); pa[i + 3] = Math.min(pa[i + 3], pd[i + 3]); }
          tc.putImageData(a, 0, 0);
          tc.globalCompositeOperation = "destination-in";
        } else {
          // source = destination + offset, so the composite is shifted by -offset under the stroke mask
          tc.drawImage(this.below as unknown as CanvasImageSource, -s.clone.dx * this.scale, -s.clone.dy * this.scale);
          tc.globalCompositeOperation = "destination-in";
        }
        tc.drawImage(mask as unknown as CanvasImageSource, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = s.opacity; ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(tmp as unknown as CanvasImageSource, 0, 0);
        ctx.restore(); continue;
      }
      if (s.fill && (s.rings?.length || pts.length >= 6)) {
        ctx.globalAlpha = s.opacity; ctx.fillStyle = forceColor ?? s.color;
        ctx.beginPath();
        for (const r of s.rings ?? [pts]) { if (r.length < 6) continue; ctx.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1]); ctx.closePath(); }
        ctx.fill("evenodd");
        ctx.restore(); continue;
      }
      ctx.globalAlpha = s.opacity;
      ctx.strokeStyle = forceColor ?? s.color; ctx.fillStyle = forceColor ?? s.color;
      ctx.lineWidth = s.size;
      const soft = (1 - Math.min(1, Math.max(0, s.hardness))) * s.size * 0.5 * this.scale;
      if (soft > 0.5) ctx.filter = `blur(${soft}px)`;
      ctx.beginPath();
      if (pts.length === 2) { ctx.arc(pts[0], pts[1], s.size / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore(); continue; }
      if (s.pressures && s.pressures.length * 2 === pts.length) {
        // Variable width: one round-capped segment per pair of points.
        for (let i = 0; i + 3 < pts.length; i += 2) {
          const w = s.size * Math.max(0.05, (s.pressures[i / 2] + s.pressures[i / 2 + 1]) / 2);
          ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(pts[i], pts[i + 1]); ctx.lineTo(pts[i + 2], pts[i + 3]); ctx.stroke();
        }
        ctx.restore(); continue;
      }
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i + 3 < pts.length; i += 2) {
        // Smooth through midpoints so fast strokes don't look like polylines.
        const mx = (pts[i] + pts[i + 2]) / 2, my = (pts[i + 1] + pts[i + 3]) / 2;
        ctx.quadraticCurveTo(pts[i], pts[i + 1], mx, my);
      }
      ctx.lineTo(pts[pts.length - 2], pts[pts.length - 1]);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- Filters, masks, styles ---------------------------------------------------

  private applyFilters(src: CanvasLike, f: LayerFilters): CanvasLike {
    const out = this.blank();
    const ctx = out.getContext("2d");
    if (f.blur && f.blur > 0) {
      if (this.doc.linearBlending) {
        // Blur in linear light: soft edges keep their brightness instead of darkening in gamma space.
        const lin = this.blank(); const lc = lin.getContext("2d"); lc.drawImage(src as unknown as CanvasImageSource, 0, 0);
        const id = lc.getImageData(0, 0, this.frame.w, this.frame.h); toLinear(id.data); lc.putImageData(id, 0, 0);
        ctx.filter = `blur(${f.blur * this.scale}px)`; ctx.drawImage(lin as unknown as CanvasImageSource, 0, 0); ctx.filter = "none";
        const id2 = ctx.getImageData(0, 0, this.frame.w, this.frame.h); toSrgb(id2.data); ctx.putImageData(id2, 0, 0);
      } else { ctx.filter = `blur(${f.blur * this.scale}px)`; ctx.drawImage(src as unknown as CanvasImageSource, 0, 0); ctx.filter = "none"; }
    } else ctx.drawImage(src as unknown as CanvasImageSource, 0, 0);
    // Convolution-style filters first (they need neighbours), then per-pixel adjustments.
    let cur: CanvasLike = out;
    if (f.pixelate && f.pixelate > 1) {
      const cell = Math.max(1, f.pixelate * this.scale);
      const small = this.env.createCanvas(Math.max(1, Math.round(this.frame.w / cell)), Math.max(1, Math.round(this.frame.h / cell)));
      const sc = small.getContext("2d"); sc.imageSmoothingEnabled = true; sc.drawImage(cur as unknown as CanvasImageSource, 0, 0, small.width, small.height);
      const big = this.blank(); const bc = big.getContext("2d"); bc.imageSmoothingEnabled = false; bc.drawImage(small as unknown as CanvasImageSource, 0, 0, this.frame.w, this.frame.h);
      cur = big;
    }
    if (f.motionBlur && f.motionBlur.distance > 0) {
      const dist = f.motionBlur.distance * this.scale, a = (f.motionBlur.angle * Math.PI) / 180, n = Math.max(2, Math.min(64, Math.round(dist)));
      const mb = this.blank(); const mc = mb.getContext("2d"); mc.globalAlpha = 1 / n;
      for (let i = 0; i < n; i++) { const t = (i / (n - 1) - 0.5) * dist; mc.drawImage(cur as unknown as CanvasImageSource, Math.cos(a) * t, Math.sin(a) * t); }
      cur = mb;
    }
    if (f.unsharp && f.unsharp.amount > 0) {
      const blur = this.blank(); const bc = blur.getContext("2d"); bc.filter = `blur(${Math.max(0.5, f.unsharp.radius * this.scale)}px)`; bc.drawImage(cur as unknown as CanvasImageSource, 0, 0);
      const a = cur.getContext("2d").getImageData(0, 0, this.frame.w, this.frame.h), b = bc.getImageData(0, 0, this.frame.w, this.frame.h);
      const pa = a.data, pb = b.data, amt = f.unsharp.amount;
      for (let i = 0; i < pa.length; i += 4) { if (pa[i + 3] === 0) continue; for (let k = 0; k < 3; k++) pa[i + k] = Math.max(0, Math.min(255, pa[i + k] + (pa[i + k] - pb[i + k]) * amt)); }
      const o = this.blank(); o.getContext("2d").putImageData(a, 0, 0); cur = o;
    }
    if ((f.emboss && f.emboss > 0) || (f.findEdges && f.findEdges > 0)) {
      const id = cur.getContext("2d").getImageData(0, 0, this.frame.w, this.frame.h); const src = new Uint8ClampedArray(id.data); const px = id.data; const W = this.frame.w, H = this.frame.h;
      const at = (x: number, y: number, k: number) => src[((Math.max(0, Math.min(H - 1, y)) * W) + Math.max(0, Math.min(W - 1, x))) * 4 + k];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4; if (src[i + 3] === 0) continue;
        for (let k = 0; k < 3; k++) {
          let v = src[i + k];
          if (f.emboss) { const e = -2 * at(x - 1, y - 1, k) - at(x, y - 1, k) - at(x - 1, y, k) + at(x + 1, y, k) + at(x, y + 1, k) + 2 * at(x + 1, y + 1, k); v = v + (e / 2 + 128 - v) * f.emboss; }
          if (f.findEdges) { const gx = -at(x - 1, y - 1, k) - 2 * at(x - 1, y, k) - at(x - 1, y + 1, k) + at(x + 1, y - 1, k) + 2 * at(x + 1, y, k) + at(x + 1, y + 1, k); const gy = -at(x - 1, y - 1, k) - 2 * at(x, y - 1, k) - at(x + 1, y - 1, k) + at(x - 1, y + 1, k) + 2 * at(x, y + 1, k) + at(x + 1, y + 1, k); const m = 255 - Math.min(255, Math.hypot(gx, gy)); v = v + (m - v) * f.findEdges; }
          px[i + k] = Math.max(0, Math.min(255, v));
        }
      }
      const o = this.blank(); o.getContext("2d").putImageData(id, 0, 0); cur = o;
    }
    if (cur !== out) { const o = this.blank(); o.getContext("2d").drawImage(cur as unknown as CanvasImageSource, 0, 0); out.getContext("2d").clearRect(0, 0, this.frame.w, this.frame.h); out.getContext("2d").drawImage(o as unknown as CanvasImageSource, 0, 0); }
    // One float pass for everything per-pixel: colour ops, levels/curves (continuous, not 8-bit LUTs), adjustments, grain -
    // then a single quantisation with TPDF dither. No intermediate 8-bit rounding, so stacked adjustments don't band.
    const colorOps = hasColorOps(f), lutFns = buildLutFns(f);
    const noise = f.noise ? Math.min(1, Math.max(0, f.noise)) : 0;
    const adj = hasPixelAdjustments(f) ? pixelAdjuster(f) : null;
    if (colorOps || lutFns || noise || adj) {
      const id = ctx.getImageData(0, 0, this.frame.w, this.frame.h); const px = id.data;
      const fpx = new Float32Array(4);
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        fpx[0] = px[i]; fpx[1] = px[i + 1]; fpx[2] = px[i + 2]; fpx[3] = px[i + 3];
        if (colorOps) applyColorOps(f, fpx);
        if (lutFns) { fpx[0] = lutFns[0](fpx[0]); fpx[1] = lutFns[1](fpx[1]); fpx[2] = lutFns[2](fpx[2]); }
        if (adj) adj(fpx as unknown as Uint8ClampedArray, 0);
        // TPDF dither (two uniform hashes) at ±0.5 LSB, then round once.
        const pi = i >> 2, ax = (pi % this.frame.w) + this.frame.x, ay = Math.floor(pi / this.frame.w) + this.frame.y;
        let h1 = ((ax + ay * 65537) * 2654435761) >>> 0; h1 ^= h1 >>> 15; h1 = Math.imul(h1, 2246822519) >>> 0; h1 ^= h1 >>> 13;
        const d = ((h1 & 0xffff) / 0xffff + ((h1 >>> 16) & 0xffff) / 0xffff - 1) * 0.5;
        px[i] = clampByte(fpx[0] + d); px[i + 1] = clampByte(fpx[1] + d); px[i + 2] = clampByte(fpx[2] + d);
        if (noise) {
          // Deterministic hash of the absolute canvas position, so previews, exports and cached frames share the grain.
          const pi = i >> 2, ax = (pi % this.frame.w) + this.frame.x, ay = Math.floor(pi / this.frame.w) + this.frame.y;
          let h = ((ax + ay * 65537) * 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
          const n = ((h & 0xffff) / 0xffff - 0.5) * noise * 140;
          px[i] = Math.max(0, Math.min(255, px[i] + n)); px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + n)); px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + n));
        }
      }
      ctx.putImageData(id, 0, 0);
    }
    return out;
  }

  private applyAdjustment(l: AdjustmentLayer, target: Ctx) {
    if (!hasFilters(l.adjustment)) return;
    const snapshot = this.blank();
    snapshot.getContext("2d").drawImage(target.canvas as unknown as CanvasImageSource, 0, 0);
    let filtered = this.applyFilters(snapshot, l.adjustment);
    // Masked adjustment: only affect where the mask shows; elsewhere keep the original.
    if (l.mask) filtered = this.applyMask(filtered, l, l.mask);
    if (l.mask) { const merged = this.blank(); const mc = merged.getContext("2d"); mc.drawImage(snapshot as unknown as CanvasImageSource, 0, 0); mc.drawImage(filtered as unknown as CanvasImageSource, 0, 0); filtered = merged; }
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalCompositeOperation = "source-over";
    target.globalAlpha = 1;
    target.clearRect(0, 0, this.frame.w, this.frame.h);
    if (l.opacity < 1) { target.drawImage(snapshot as unknown as CanvasImageSource, 0, 0); target.globalAlpha = l.opacity; }
    target.drawImage(filtered as unknown as CanvasImageSource, 0, 0);
    target.restore();
  }

  private applyMask(src: CanvasLike, l: Layer, m: LayerMask): CanvasLike {
    const mask = this.blank();
    const mctx = mask.getContext("2d");
    if (m.kind === "shape") {
      mctx.save();
      this.applyLayerTransform(mctx, l);
      if (m.feather) mctx.filter = `blur(${m.feather * this.scale}px)`;
      mctx.fillStyle = "#fff";
      if (m.shape === "ellipse") { mctx.beginPath(); mctx.ellipse(m.x + m.width / 2, m.y + m.height / 2, m.width / 2, m.height / 2, 0, 0, Math.PI * 2); mctx.fill(); }
      else roundRect(mctx, m.x, m.y, m.width, m.height, m.radius ?? 0), mctx.fill();
      mctx.restore();
    } else if (m.kind === "paint") {
      mctx.save();
      this.applyLayerTransform(mctx, l);
      if (m.base !== "hide") { mctx.fillStyle = "#fff"; mctx.fillRect(-1e5, -1e5, 2e5, 2e5); }
      this.drawStrokes(mctx, m.strokes, "#ffffff");
      mctx.restore();
    } else {
      const img = this.env.getImage(m.assetId);
      if (!img) return src;
      const key = `${m.assetId}`;
      let alphaMask = this.maskCache.get(key);
      if (!alphaMask) { alphaMask = luminanceToAlpha(this.env, img, this.doc.assets[m.assetId]); this.maskCache.set(key, alphaMask); }
      mctx.save();
      this.applyLayerTransform(mctx, l);
      mctx.drawImage(alphaMask as unknown as CanvasImageSource, 0, 0, l.width, l.height);
      mctx.restore();
    }
    if (m.inverted) {
      const inv = this.blank();
      const ictx = inv.getContext("2d");
      ictx.fillStyle = "#fff"; ictx.fillRect(0, 0, this.frame.w, this.frame.h);
      ictx.globalCompositeOperation = "destination-out";
      ictx.drawImage(mask as unknown as CanvasImageSource, 0, 0);
      return this.intersect(src, inv);
    }
    return this.intersect(src, mask);
  }

  private intersect(src: CanvasLike, mask: CanvasLike): CanvasLike {
    const out = this.blank();
    const ctx = out.getContext("2d");
    ctx.drawImage(src as unknown as CanvasImageSource, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask as unknown as CanvasImageSource, 0, 0);
    return out;
  }

  /** Perspective-warp a rendered layer onto its corner quad: a homography sampled on a grid of affine triangles. */
  private warpQuad(content: CanvasLike, l: Layer): CanvasLike {
    const q = l.quad!;
    const w = l.width, h = l.height;
    const srcLocal = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    const dstLocal = [{ x: q[0], y: q[1] }, { x: w + q[2], y: q[3] }, { x: w + q[4], y: h + q[5] }, { x: q[6], y: h + q[7] }];
    const H = homography(srcLocal, dstLocal);
    const s = this.scale, f = this.frame;
    const dev = (p: { x: number; y: number }) => { const d = localToDocument(l, p); return { x: (d.x - this.ox) * s - f.x, y: (d.y - this.oy) * s - f.y }; };
    const out = this.blank(); const ctx = out.getContext("2d");
    const N = Math.max(4, Math.min(24, Math.round(Math.max(w, h) * s / 40)));
    const img = content as unknown as CanvasImageSource;
    const tri = (sa: { x: number; y: number }, sb: { x: number; y: number }, sc: { x: number; y: number }, da: { x: number; y: number }, db: { x: number; y: number }, dc: { x: number; y: number }) => {
      // Affine mapping source triangle -> destination triangle.
      const det = (sb.x - sa.x) * (sc.y - sa.y) - (sc.x - sa.x) * (sb.y - sa.y); if (Math.abs(det) < 1e-9) return;
      const a = ((db.x - da.x) * (sc.y - sa.y) - (dc.x - da.x) * (sb.y - sa.y)) / det, b = ((db.y - da.y) * (sc.y - sa.y) - (dc.y - da.y) * (sb.y - sa.y)) / det;
      const c = ((dc.x - da.x) * (sb.x - sa.x) - (db.x - da.x) * (sc.x - sa.x)) / det, d = ((dc.y - da.y) * (sb.x - sa.x) - (db.y - da.y) * (sc.x - sa.x)) / det;
      const e = da.x - a * sa.x - c * sa.y, ff = da.y - b * sa.x - d * sa.y;
      // Expand the clip triangle slightly from its centroid to hide seams.
      const cx = (da.x + db.x + dc.x) / 3, cy = (da.y + db.y + dc.y) / 3, grow = (p: { x: number; y: number }) => { const vx = p.x - cx, vy = p.y - cy, len = Math.hypot(vx, vy) || 1; return { x: p.x + (vx / len) * 1.2, y: p.y + (vy / len) * 1.2 }; };
      const ga = grow(da), gb = grow(db), gc = grow(dc);
      ctx.save(); ctx.beginPath(); ctx.moveTo(ga.x, ga.y); ctx.lineTo(gb.x, gb.y); ctx.lineTo(gc.x, gc.y); ctx.closePath(); ctx.clip();
      ctx.setTransform(a, b, c, d, e, ff); ctx.drawImage(img, 0, 0); ctx.restore();
    };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const p00 = { x: (i / N) * w, y: (j / N) * h }, p10 = { x: ((i + 1) / N) * w, y: (j / N) * h }, p11 = { x: ((i + 1) / N) * w, y: ((j + 1) / N) * h }, p01 = { x: (i / N) * w, y: ((j + 1) / N) * h };
      const s00 = dev(p00), s10 = dev(p10), s11 = dev(p11), s01 = dev(p01);
      const d00 = dev(applyHomography(H, p00)), d10 = dev(applyHomography(H, p10)), d11 = dev(applyHomography(H, p11)), d01 = dev(applyHomography(H, p01));
      tri(s00, s10, s11, d00, d10, d11); tri(s00, s11, s01, d00, d11, d01);
    }
    return out;
  }

  /** Keep only the pixels of `src` (in frame `lf`) where the base layer's content has alpha. */
  private clipTo(src: CanvasLike, base: CachedLayer, lf: Frame): CanvasLike {
    const out = this.blank(); const ctx = out.getContext("2d");
    ctx.drawImage(src as unknown as CanvasImageSource, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage((base.alpha ?? base.canvas) as unknown as CanvasImageSource, base.x - lf.x, base.y - lf.y);
    return out;
  }

  private fade(src: CanvasLike, alpha: number): CanvasLike {
    const out = this.blank(); const ctx = out.getContext("2d");
    ctx.globalAlpha = alpha; ctx.drawImage(src as unknown as CanvasImageSource, 0, 0);
    return out;
  }

  private tint(src: CanvasLike, color: string, alpha = 1): CanvasLike {
    const out = this.blank();
    const ctx = out.getContext("2d");
    ctx.drawImage(src as unknown as CanvasImageSource, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, this.frame.w, this.frame.h);
    return out;
  }

  private applyStyles(content: CanvasLike, st: LayerStyles, fillOpacity = 1, layer: Layer): CanvasLike {
    const s = this.scale;
    const out = this.blank();
    const ctx = out.getContext("2d");
    const img = content as unknown as CanvasImageSource;

    // Effects beneath the content: drop shadow, outer glow, outside stroke.
    if (st.dropShadow?.enabled) {
      const d = st.dropShadow;
      const sh = this.blank(); const sc = sh.getContext("2d");
      sc.shadowColor = d.color; sc.shadowBlur = d.blur * s; sc.shadowOffsetX = d.x * s; sc.shadowOffsetY = d.y * s;
      sc.drawImage(img, 0, 0);
      sc.shadowColor = "transparent";
      sc.globalCompositeOperation = "destination-out"; sc.drawImage(img, 0, 0); // knock out the layer silhouette
      ctx.globalAlpha = d.opacity; ctx.drawImage(sh as unknown as CanvasImageSource, 0, 0); ctx.globalAlpha = 1;
    }
    if (st.outerGlow?.enabled) {
      const g = st.outerGlow;
      const gl = this.blank(); const gc = gl.getContext("2d");
      gc.shadowColor = g.color; gc.shadowBlur = g.size * s;
      const tinted = this.tint(content, g.color);
      for (let i = 0; i < 3; i++) gc.drawImage(tinted as unknown as CanvasImageSource, 0, 0); // stacked passes strengthen the glow
      gc.shadowColor = "transparent";
      gc.globalCompositeOperation = "destination-out"; gc.drawImage(img, 0, 0);
      ctx.globalAlpha = g.opacity; ctx.drawImage(gl as unknown as CanvasImageSource, 0, 0); ctx.globalAlpha = 1;
    }
    if (st.stroke?.enabled && st.stroke.size > 0) {
      const k = st.stroke;
      const size = k.size * s;
      const dil = this.dilate(this.tint(content, k.color), k.position === "center" ? size / 2 : size);
      if (k.position === "inside") {
        // Draw later, over the content, clipped to the content.
        (st as any).__inside = this.intersect(dil, content);
      } else {
        // Outside / centre: only the ring outside the silhouette goes underneath, so a reduced Fill opacity shows through correctly.
        const ring = this.blank(); const rc = ring.getContext("2d");
        rc.drawImage(dil as unknown as CanvasImageSource, 0, 0); rc.globalCompositeOperation = "destination-out"; rc.drawImage(content as unknown as CanvasImageSource, 0, 0);
        ctx.drawImage(ring as unknown as CanvasImageSource, 0, 0);
      }
      if (k.position === "center") (st as any).__inside = this.intersect(this.dilate(this.tint(content, k.color), size / 2), content);
    }

    // Content with overlays.
    let body = content;
    const patternImg = st.patternOverlay?.enabled ? this.env.getImage(st.patternOverlay.assetId) : null;
    if (st.colorOverlay?.enabled || st.gradientOverlay?.enabled || patternImg) {
      const b = this.blank(); const bc = b.getContext("2d");
      bc.drawImage(img, 0, 0);
      bc.globalCompositeOperation = "source-atop";
      if (patternImg && st.patternOverlay) {
        const po = st.patternOverlay, a = this.doc.assets[po.assetId];
        const tw = Math.max(1, (a?.width ?? (patternImg as { width: number }).width) * po.scale * this.scale), th = Math.max(1, (a?.height ?? (patternImg as { height: number }).height) * po.scale * this.scale);
        bc.globalAlpha = po.opacity;
        for (let y = 0; y < this.frame.h; y += th) for (let x = 0; x < this.frame.w; x += tw) bc.drawImage(patternImg, x, y, tw, th);
      }
      if (st.colorOverlay?.enabled) {
        const co = st.colorOverlay;
        bc.globalAlpha = co.opacity; bc.fillStyle = co.color; bc.fillRect(0, 0, this.frame.w, this.frame.h);
      }
      if (st.gradientOverlay?.enabled) {
        const go = st.gradientOverlay;
        // Gradient spans the layer's own box (like Photoshop), not the padded frame.
        const lb = layerBounds(layer); const gx = (lb.x - this.ox) * s - this.frame.x, gy = (lb.y - this.oy) * s - this.frame.y, gw = lb.width * s, gh = lb.height * s;
        bc.save(); bc.translate(gx, gy);
        bc.globalAlpha = go.opacity; bc.fillStyle = linearGradient(bc, gw, gh, go.angle, go.from, go.to, undefined, !!this.doc.linearBlending); bc.fillRect(-gx, -gy, this.frame.w, this.frame.h);
        bc.restore();
      }
      body = b;
    }
    ctx.globalAlpha = fillOpacity; ctx.drawImage(body as unknown as CanvasImageSource, 0, 0); ctx.globalAlpha = 1;
    if (st.bevel?.enabled && st.bevel.size > 0) {
      const b = st.bevel, d = (b.size * s) / 2, a = (b.angle * Math.PI) / 180;
      const hx = -Math.cos(a) * d, hy = Math.sin(a) * d; // highlight on the edges facing the light
      ctx.globalAlpha = Math.min(1, b.opacity * b.depth);
      ctx.drawImage(this.innerEffect(content, b.highlight, b.size * s * 0.6, hx, hy, 2) as unknown as CanvasImageSource, 0, 0);
      ctx.drawImage(this.innerEffect(content, b.shadow, b.size * s * 0.6, -hx, -hy, 2) as unknown as CanvasImageSource, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (st.innerShadow?.enabled) { ctx.globalAlpha = st.innerShadow.opacity; ctx.drawImage(this.innerEffect(content, st.innerShadow.color, st.innerShadow.blur * s, st.innerShadow.x * s, st.innerShadow.y * s, 1) as unknown as CanvasImageSource, 0, 0); ctx.globalAlpha = 1; }
    if (st.innerGlow?.enabled) { ctx.globalAlpha = st.innerGlow.opacity; ctx.drawImage(this.innerEffect(content, st.innerGlow.color, st.innerGlow.size * s, 0, 0, 3) as unknown as CanvasImageSource, 0, 0); ctx.globalAlpha = 1; }
    if ((st as any).__inside) { ctx.drawImage((st as any).__inside as CanvasImageSource, 0, 0); delete (st as any).__inside; }
    return out;
  }

  /** Shadow/glow cast from outside the silhouette inwards, clipped to the content (inner shadow, inner glow). */
  private innerEffect(content: CanvasLike, color: string, blur: number, dx: number, dy: number, passes: number): CanvasLike {
    const img = content as unknown as CanvasImageSource;
    const inv = this.blank(); const ic = inv.getContext("2d");
    ic.fillStyle = color; ic.fillRect(0, 0, this.frame.w, this.frame.h);
    ic.globalCompositeOperation = "destination-out"; ic.drawImage(img, 0, 0);
    const out = this.blank(); const oc = out.getContext("2d");
    oc.shadowColor = color; oc.shadowBlur = blur; oc.shadowOffsetX = dx; oc.shadowOffsetY = dy;
    for (let i = 0; i < passes; i++) oc.drawImage(inv as unknown as CanvasImageSource, 0, 0);
    oc.shadowColor = "transparent";
    oc.globalCompositeOperation = "destination-out"; oc.drawImage(inv as unknown as CanvasImageSource, 0, 0);
    oc.globalCompositeOperation = "destination-in"; oc.drawImage(img, 0, 0);
    return out;
  }

  /** Grow an alpha silhouette by `r` device pixels by stamping it around a circle. */
  private dilate(src: CanvasLike, r: number): CanvasLike {
    const out = this.blank();
    const ctx = out.getContext("2d");
    const steps = Math.max(8, Math.min(48, Math.round(r * 2)));
    for (let ring = r; ring > 0; ring -= Math.max(1, r / 3)) {
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        ctx.drawImage(src as unknown as CanvasImageSource, Math.cos(a) * ring, Math.sin(a) * ring);
      }
    }
    ctx.drawImage(src as unknown as CanvasImageSource, 0, 0);
    return out;
  }
}

// ---- Helpers shared with the editor ---------------------------------------------

export function fontString(l: Pick<TextLayer, "fontStyle" | "fontWeight" | "fontSize" | "fontFamily">): string {
  return `${l.fontStyle} ${l.fontWeight} ${l.fontSize}px "${l.fontFamily}"`;
}

export interface TextLayout { lines: { text: string; width: number; last?: boolean; start: number; charWidths?: number[] }[]; width: number; height: number }

/** Style of character `i` after applying the layer's runs. */
export function charStyle(l: TextLayer, i: number) {
  let st = { fontFamily: l.fontFamily, fontWeight: l.fontWeight, fontStyle: l.fontStyle, color: l.color, underline: !!l.underline };
  if (l.runs) for (const r of l.runs) if (i >= r.start && i < r.end) st = { ...st, ...(r.fontFamily ? { fontFamily: r.fontFamily } : {}), ...(r.fontWeight !== undefined ? { fontWeight: r.fontWeight } : {}), ...(r.fontStyle ? { fontStyle: r.fontStyle } : {}), ...(r.color ? { color: r.color } : {}), ...(r.underline !== undefined ? { underline: r.underline } : {}) };
  return st;
}

/** Word-wrap a text layer inside its width (or measure it unwrapped) using a 2D context for metrics. */
export function layoutText(ctx: Ctx, l: TextLayer): TextLayout {
  ctx.font = fontString(l);
  let text = l.text;
  if (l.textTransform === "uppercase") text = text.toUpperCase();
  else if (l.textTransform === "lowercase") text = text.toLowerCase();
  const rich = !!l.runs?.length;
  // Per-character widths (font can change per character when runs are present).
  const chars = [...text];
  const widths: number[] = new Array(chars.length);
  let lastFont = "";
  for (let i = 0; i < chars.length; i++) {
    if (rich) { const st = charStyle(l, i); const f = fontString({ ...l, ...st }); if (f !== lastFont) { ctx.font = f; lastFont = f; } }
    widths[i] = chars[i] === "\n" ? 0 : ctx.measureText(chars[i]).width + (l.letterSpacing || 0);
  }
  ctx.font = fontString(l);
  const spanWidth = (a: number, b: number) => { let w = 0; for (let i = a; i < b; i++) w += widths[i]; return w - (b > a && l.letterSpacing ? l.letterSpacing : 0); };
  const lines: TextLayout["lines"] = [];
  let pos = 0;
  for (const para of text.split("\n")) {
    const pStart = pos; const pEnd = pos + [...para].length;
    if (!l.wrap) { lines.push({ text: para, width: spanWidth(pStart, pEnd), last: true, start: pStart, charWidths: widths.slice(pStart, pEnd) }); pos = pEnd + 1; continue; }
    // Break into words (keeping the spaces attached to the preceding word).
    const words: { start: number; end: number }[] = [];
    let i = pStart;
    while (i < pEnd) { let j = i; while (j < pEnd && chars[j] !== " ") j++; while (j < pEnd && chars[j] === " ") j++; words.push({ start: i, end: j }); i = j; }
    let lineStart = pStart, lineEnd = pStart;
    for (const w of words) {
      const trial = spanWidth(lineStart, w.end);
      const trimmedEnd = (e: number) => { let k = e; while (k > lineStart && chars[k - 1] === " ") k--; return k; };
      if (trial > l.width && lineEnd > lineStart) { const te = trimmedEnd(lineEnd); lines.push({ text: chars.slice(lineStart, te).join(""), width: spanWidth(lineStart, te), start: lineStart, charWidths: widths.slice(lineStart, te) }); lineStart = w.start; }
      lineEnd = w.end;
    }
    const te = (() => { let k = lineEnd; while (k > lineStart && chars[k - 1] === " ") k--; return k; })();
    lines.push({ text: chars.slice(lineStart, te).join(""), width: spanWidth(lineStart, te), last: true, start: lineStart, charWidths: widths.slice(lineStart, te) });
    pos = pEnd + 1;
  }
  const width = Math.max(0, ...lines.map((x) => x.width));
  return { lines, width, height: lines.length * l.fontSize * l.lineHeight };
}

export function filterString(f: LayerFilters, scale = 1): string {
  const parts: string[] = [];
  if (f.blur) parts.push(`blur(${f.blur * scale}px)`);
  if (f.brightness !== undefined && f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
  if (f.contrast !== undefined && f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturate !== undefined && f.saturate !== 1) parts.push(`saturate(${f.saturate})`);
  if (f.hueRotate) parts.push(`hue-rotate(${f.hueRotate}deg)`);
  if (f.grayscale) parts.push(`grayscale(${f.grayscale})`);
  if (f.sepia) parts.push(`sepia(${f.sepia})`);
  if (f.invert) parts.push(`invert(${f.invert})`);
  return parts.length ? parts.join(" ") : "none";
}

const PIXEL_KEYS: (keyof LayerFilters)[] = ["vibrance", "exposure", "colorBalance", "blackWhite", "photoFilter", "gradientMap", "channelMixer", "threshold", "posterize", "shadowsHighlights", "colorize"];
const CONV_KEYS: (keyof LayerFilters)[] = ["unsharp", "motionBlur", "pixelate", "emboss", "findEdges"];
export function hasPixelAdjustments(f: LayerFilters): boolean { return PIXEL_KEYS.some((k) => f[k] !== undefined && f[k] !== null); }
export function hasFilters(f?: LayerFilters): boolean { return !!f && (!!f.blur || hasColorOps(f) || !!f.levels || !!f.curves || !!f.noise || hasPixelAdjustments(f) || CONV_KEYS.some((k) => f[k] !== undefined && f[k] !== null)); }
const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** The CSS-filter-style colour ops (brightness, contrast, saturate, hue-rotate, grayscale, sepia, invert), as the spec's colour matrices, in float. */
export function hasColorOps(f: LayerFilters): boolean { return (f.brightness !== undefined && f.brightness !== 1) || (f.contrast !== undefined && f.contrast !== 1) || (f.saturate !== undefined && f.saturate !== 1) || !!f.hueRotate || !!f.grayscale || !!f.sepia || !!f.invert; }
export function applyColorOps(f: LayerFilters, p: Float32Array): void {
  let r = p[0], g = p[1], b = p[2];
  if (f.brightness !== undefined && f.brightness !== 1) { r *= f.brightness; g *= f.brightness; b *= f.brightness; }
  if (f.contrast !== undefined && f.contrast !== 1) { const c = f.contrast, o = 127.5 * (1 - c); r = r * c + o; g = g * c + o; b = b * c + o; }
  if (f.saturate !== undefined && f.saturate !== 1) { const sv = f.saturate; const rr = 0.213 + 0.787 * sv, rg = 0.715 - 0.715 * sv, rb = 0.072 - 0.072 * sv, gr = 0.213 - 0.213 * sv, gg = 0.715 + 0.285 * sv, gb = 0.072 - 0.072 * sv, br = 0.213 - 0.213 * sv, bg = 0.715 - 0.715 * sv, bb = 0.072 + 0.928 * sv; const r2 = rr * r + rg * g + rb * b, g2 = gr * r + gg * g + gb * b, b2 = br * r + bg * g + bb * b; r = r2; g = g2; b = b2; }
  if (f.hueRotate) { const a = (f.hueRotate * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a); const m = [0.213 + c * 0.787 - sn * 0.213, 0.715 - c * 0.715 - sn * 0.715, 0.072 - c * 0.072 + sn * 0.928, 0.213 - c * 0.213 + sn * 0.143, 0.715 + c * 0.285 + sn * 0.14, 0.072 - c * 0.072 - sn * 0.283, 0.213 - c * 0.213 - sn * 0.787, 0.715 - c * 0.715 + sn * 0.715, 0.072 + c * 0.928 + sn * 0.072]; const r2 = m[0] * r + m[1] * g + m[2] * b, g2 = m[3] * r + m[4] * g + m[5] * b, b2 = m[6] * r + m[7] * g + m[8] * b; r = r2; g = g2; b = b2; }
  if (f.grayscale) { const k = Math.min(1, f.grayscale), l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r += (l - r) * k; g += (l - g) * k; b += (l - b) * k; }
  if (f.sepia) { const k = Math.min(1, f.sepia); const r2 = (0.393 + 0.607 * (1 - k)) * r + 0.769 * k * g + 0.189 * k * b, g2 = 0.349 * k * r + (0.686 + 0.314 * (1 - k)) * g + 0.168 * k * b, b2 = 0.272 * k * r + 0.534 * k * g + (0.131 + 0.869 * (1 - k)) * b; r = r2; g = g2; b = b2; }
  if (f.invert) { const k = Math.min(1, f.invert); r = r * (1 - k) + (255 - r) * k; g = g * (1 - k) + (255 - g) * k; b = b * (1 - k) + (255 - b) * k; }
  p[0] = r; p[1] = g; p[2] = b;
}

/** Continuous per-channel transfer functions for levels + curves (float in, float out; no 8-bit table). */
export function buildLutFns(f: LayerFilters): [(v: number) => number, (v: number) => number, (v: number) => number] | null {
  if (!f.levels && !f.curves) return null;
  const lv = f.levels ? (v: number) => { const l = f.levels!; const inW = Math.max(l.inBlack + 1, l.inWhite), g = Math.max(0.01, l.gamma); const t = Math.max(0, Math.min(1, (v - l.inBlack) / (inW - l.inBlack))); return l.outBlack + Math.pow(t, 1 / g) * (l.outWhite - l.outBlack); } : null;
  const curve = (pts?: [number, number][]) => { if (!pts || pts.length < 2) return null; const p = [...pts].sort((a, b) => a[0] - b[0]); return (v: number) => { if (v <= p[0][0]) return p[0][1]; for (let i = 1; i < p.length; i++) if (v <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return x1 === x0 ? y1 : y0 + ((v - x0) / (x1 - x0)) * (y1 - y0); } return p[p.length - 1][1]; }; };
  const rgb = curve(f.curves?.rgb);
  return (["r", "g", "b"] as const).map((ch) => { const own = curve(f.curves?.[ch]); return (v: number) => { let x = v; if (lv) x = lv(x); if (rgb) x = rgb(x); if (own) x = own(x); return x; }; }) as [(v: number) => number, (v: number) => number, (v: number) => number];
}

// sRGB <-> linear helpers on 8-bit RGBA buffers (alpha untouched).
const LIN = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)) * 255; }
const toSrgbScalar = (v: number) => { const c = Math.max(0, Math.min(1, v / 255)); return (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255; };
export function toLinear(px: Uint8ClampedArray) { for (let i = 0; i < px.length; i += 4) { px[i] = Math.round(LIN[px[i]]); px[i + 1] = Math.round(LIN[px[i + 1]]); px[i + 2] = Math.round(LIN[px[i + 2]]); } }
export function toSrgb(px: Uint8ClampedArray) { for (let i = 0; i < px.length; i += 4) { px[i] = Math.round(toSrgbScalar(px[i])); px[i + 1] = Math.round(toSrgbScalar(px[i + 1])); px[i + 2] = Math.round(toSrgbScalar(px[i + 2])); } }

/** Separable Lanczos-3 resampling of an RGBA buffer (premultiplied during filtering so edges don't fringe). */
const resampleCache = new Map<string, CanvasLike>();
export function resampleLanczos(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, out: ImageData): ImageData {
  const a = 3, lanczos = (x: number) => { if (x === 0) return 1; if (Math.abs(x) >= a) return 0; const px = Math.PI * x; return (a * Math.sin(px) * Math.sin(px / a)) / (px * px); };
  const pass = (input: Float32Array, inW: number, inH: number, outW: number, horizontal: boolean): Float32Array => {
    const outH = horizontal ? inH : outW, ow = horizontal ? outW : inW; const out2 = new Float32Array(ow * outH * 4);
    const inLen = horizontal ? inW : inH, outLen = horizontal ? outW : outH, scale = inLen / outLen, support = Math.max(1, scale) * a;
    const weights: { start: number; w: number[] }[] = [];
    for (let o = 0; o < outLen; o++) { const center = (o + 0.5) * scale - 0.5, start = Math.max(0, Math.ceil(center - support)), end = Math.min(inLen - 1, Math.floor(center + support)); const w: number[] = []; let sum = 0; for (let k = start; k <= end; k++) { const v = lanczos((k - center) / Math.max(1, scale)); w.push(v); sum += v; } weights.push({ start, w: w.map((v) => v / (sum || 1)) }); }
    const lines = horizontal ? inH : inW;
    for (let line = 0; line < lines; line++) for (let o = 0; o < outLen; o++) {
      const { start, w } = weights[o]; let r = 0, g = 0, b = 0, al = 0;
      for (let k = 0; k < w.length; k++) { const idx = horizontal ? (line * inW + start + k) * 4 : ((start + k) * inW + line) * 4; const wt = w[k]; r += input[idx] * wt; g += input[idx + 1] * wt; b += input[idx + 2] * wt; al += input[idx + 3] * wt; }
      const oi = horizontal ? (line * outW + o) * 4 : (o * inW + line) * 4; out2[oi] = r; out2[oi + 1] = g; out2[oi + 2] = b; out2[oi + 3] = al;
    }
    return out2;
  };
  const pre = new Float32Array(src.length); for (let i = 0; i < src.length; i += 4) { const al = src[i + 3] / 255; pre[i] = src[i] * al; pre[i + 1] = src[i + 1] * al; pre[i + 2] = src[i + 2] * al; pre[i + 3] = src[i + 3]; }
  const h = pass(pre, sw, sh, dw, true), v = pass(h, dw, sh, dh, false);
  const o = out.data; for (let i = 0; i < o.length; i += 4) { const al = v[i + 3]; const inv = al > 0.001 ? 255 / al : 0; o[i] = clampByte(v[i] * inv); o[i + 1] = clampByte(v[i + 1] * inv); o[i + 2] = clampByte(v[i + 2] * inv); o[i + 3] = clampByte(al); }
  return out;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const hexRgb = (h: string): [number, number, number] => { const m = /^#?([0-9a-f]{6})$/i.exec(h); const n = m ? parseInt(m[1], 16) : 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function hslToRgb(h: number, sat: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * sat, hp = ((h % 360) + 360) % 360 / 60, x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** A per-pixel function applying every Photoshop-style adjustment present in `f`, in a fixed order. */
export function pixelAdjuster(f: LayerFilters): (px: Uint8ClampedArray, i: number) => void {
  const pf = f.photoFilter ? hexRgb(f.photoFilter.color) : null;
  const gm = f.gradientMap ? [...f.gradientMap.stops].sort((a, b) => a.pos - b.pos).map((st) => ({ pos: st.pos, c: hexRgb(st.color) })) : null;
  const cm = f.channelMixer;
  const bw = f.blackWhite;
  const bwWeights = bw ? [bw.reds, bw.yellows, bw.greens, bw.cyans, bw.blues, bw.magentas].map((v) => v / 50) : null;
  const tint = bw?.tint ? hexRgb(bw.tint) : null;
  return (px, i) => {
    let r = px[i], g = px[i + 1], b = px[i + 2];
    if (f.exposure) { const e = Math.pow(2, f.exposure.exposure), o = f.exposure.offset * 255, ig = 1 / Math.max(0.01, f.exposure.gamma); r = 255 * Math.pow(Math.max(0, (r * e + o) / 255), ig); g = 255 * Math.pow(Math.max(0, (g * e + o) / 255), ig); b = 255 * Math.pow(Math.max(0, (b * e + o) / 255), ig); }
    if (f.vibrance) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx - mn; const avg = (r + g + b) / 3; const k = 1 + f.vibrance * (1 - sat / 255) * 1.5; r = avg + (r - avg) * k; g = avg + (g - avg) * k; b = avg + (b - avg) * k; }
    if (f.colorBalance) {
      const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255, ws = 1 - smooth(0, 0.5, L), wh = smooth(0.5, 1, L), wm = Math.max(0, 1 - ws - wh);
      const cb = f.colorBalance, lum0 = 0.299 * r + 0.587 * g + 0.114 * b;
      r += (cb.shadows[0] * ws + cb.midtones[0] * wm + cb.highlights[0] * wh) * 0.6; g += (cb.shadows[1] * ws + cb.midtones[1] * wm + cb.highlights[1] * wh) * 0.6; b += (cb.shadows[2] * ws + cb.midtones[2] * wm + cb.highlights[2] * wh) * 0.6;
      if (cb.preserveLuminosity !== false) { const lum1 = 0.299 * r + 0.587 * g + 0.114 * b || 1; const k = lum0 / lum1; r *= k; g *= k; b *= k; }
    }
    if (f.colorize) { const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255; const l = Math.max(0, Math.min(1, lum + f.colorize.lightness * 0.5)); [r, g, b] = hslToRgb(f.colorize.hue, Math.max(0, Math.min(1, f.colorize.saturation)), l); }
    if (bwWeights) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx === 0 ? 0 : (mx - mn) / mx, lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let h = 0; if (mx !== mn) { if (mx === r) h = ((g - b) / (mx - mn)) % 6; else if (mx === g) h = (b - r) / (mx - mn) + 2; else h = (r - g) / (mx - mn) + 4; h = ((h * 60) + 360) % 360; }
      const sector = h / 60, i0 = Math.floor(sector) % 6, t = sector - Math.floor(sector), w = bwWeights[i0] * (1 - t) + bwWeights[(i0 + 1) % 6] * t;
      const gray = clamp255(lum + lum * (w - 1) * sat);
      if (tint) { r = gray * tint[0] / 255 * 1.4 + gray * 0.1; g = gray * tint[1] / 255 * 1.4 + gray * 0.1; b = gray * tint[2] / 255 * 1.4 + gray * 0.1; } else r = g = b = gray;
    }
    if (pf) { const d = f.photoFilter!.density, lum0 = 0.299 * r + 0.587 * g + 0.114 * b; r = r * (1 - d) + r * (pf[0] / 255) * d; g = g * (1 - d) + g * (pf[1] / 255) * d; b = b * (1 - d) + b * (pf[2] / 255) * d; if (f.photoFilter!.preserveLuminosity !== false) { const lum1 = 0.299 * r + 0.587 * g + 0.114 * b || 1; const k = lum0 / lum1; r *= k; g *= k; b *= k; } }
    if (cm) { const [r0, g0, b0] = [r, g, b]; const mix = (c: [number, number, number, number]) => r0 * c[0] + g0 * c[1] + b0 * c[2] + c[3] * 255; if (cm.monochrome) { r = g = b = mix(cm.r); } else { r = mix(cm.r); g = mix(cm.g); b = mix(cm.b); } }
    if (f.shadowsHighlights) { const sh = f.shadowsHighlights; const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255; const lift = sh.shadows * (1 - L) * (1 - L), cut = sh.highlights * L * L; const k = 1 + lift * 0.9 - cut * 0.6; r = r * k + lift * 40; g = g * k + lift * 40; b = b * k + lift * 40; }
    if (gm) { let t = (0.299 * r + 0.587 * g + 0.114 * b) / 255; if (f.gradientMap!.reverse) t = 1 - t; let c: [number, number, number] = gm[0].c; for (let k = 1; k < gm.length; k++) { if (t <= gm[k].pos) { const a = gm[k - 1], bb = gm[k], u = bb.pos === a.pos ? 0 : (t - a.pos) / (bb.pos - a.pos); c = [a.c[0] + (bb.c[0] - a.c[0]) * u, a.c[1] + (bb.c[1] - a.c[1]) * u, a.c[2] + (bb.c[2] - a.c[2]) * u]; break; } c = gm[k].c; } [r, g, b] = c; }
    if (f.posterize) { const lv = Math.max(2, Math.min(255, f.posterize)), stepN = 255 / (lv - 1); r = Math.round(r / stepN) * stepN; g = Math.round(g / stepN) * stepN; b = Math.round(b / stepN) * stepN; }
    if (f.threshold !== undefined) { const lum = 0.299 * r + 0.587 * g + 0.114 * b; r = g = b = lum >= f.threshold ? 255 : 0; }
    px[i] = clamp255(r); px[i + 1] = clamp255(g); px[i + 2] = clamp255(b);
  };
}
export function hasStyles(s?: LayerStyles): boolean {
  return !!s && Object.values(s).some((v) => v && (v as { enabled: boolean }).enabled);
}

export function shapePath(env: RenderEnv, l: ShapeLayer): Path2D {
  const w = l.width, h = l.height;
  const p = env.createPath("");
  switch (l.shape) {
    case "rect": {
      const lim = (v: number) => Math.max(0, Math.min(v, w / 2, h / 2));
      const [tl, tr, br, bl] = (l.radii ?? [l.radius ?? 0, l.radius ?? 0, l.radius ?? 0, l.radius ?? 0]).map(lim);
      if (tl + tr + br + bl <= 0) p.rect(0, 0, w, h);
      else { p.moveTo(tl, 0); p.arcTo(w, 0, w, h, tr); p.arcTo(w, h, 0, h, br); p.arcTo(0, h, 0, 0, bl); p.arcTo(0, 0, w, 0, tl); p.closePath(); }
      break;
    }
    case "ellipse": p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case "polygon": case "star": {
      const n = Math.max(3, l.sides ?? (l.shape === "star" ? 5 : 6));
      const inner = l.shape === "star" ? (l.innerRadius ?? 0.5) : 1;
      const cx = w / 2, cy = h / 2;
      const count = l.shape === "star" ? n * 2 : n;
      for (let i = 0; i < count; i++) {
        const a = -Math.PI / 2 + (i / count) * Math.PI * 2;
        const k = l.shape === "star" && i % 2 === 1 ? inner : 1;
        const x = cx + Math.cos(a) * (w / 2) * k, y = cy + Math.sin(a) * (h / 2) * k;
        if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
      }
      p.closePath();
      break;
    }
    case "path": {
      const m = new DOMMatrixLike(w, h);
      const src = env.createPath(l.path ?? "M0 0 L1 0 L1 1 L0 1 Z");
      p.addPath(src, m as unknown as DOMMatrix2DInit);
      break;
    }
    default: p.rect(0, 0, w, h);
  }
  return p;
}

/** Minimal DOMMatrix2DInit so normalised paths scale to the layer box in both environments. */
class DOMMatrixLike { a: number; b = 0; c = 0; d: number; e = 0; f = 0; constructor(sx: number, sy: number) { this.a = sx; this.d = sy; } }

/** Expand gradient stops so the engine's sRGB interpolation follows a linear-light path (avoids muddy midpoints between saturated colours). */
export function linearLightStops(stops: { pos: number; color: string; opacity?: number }[]): { pos: number; color: string; opacity?: number }[] {
  const parse = (c: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(c); const n = m ? parseInt(m[1], 16) : 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const sorted = [...stops].sort((a, b) => a.pos - b.pos); const out: typeof stops = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]);
    if (i === sorted.length - 1) break;
    const a = parse(sorted[i].color).map((v) => LIN[v]), b = parse(sorted[i + 1].color).map((v) => LIN[v]);
    const oa = sorted[i].opacity ?? 1, ob = sorted[i + 1].opacity ?? 1;
    for (let k = 1; k < 12; k++) { const t = k / 12; out.push({ pos: sorted[i].pos + (sorted[i + 1].pos - sorted[i].pos) * t, color: hex(toSrgbScalar(a[0] + (b[0] - a[0]) * t), toSrgbScalar(a[1] + (b[1] - a[1]) * t), toSrgbScalar(a[2] + (b[2] - a[2]) * t)), opacity: oa + (ob - oa) * t }); }
  }
  return out;
}

export function linearGradient(ctx: Ctx, w: number, h: number, angleDeg: number, from: string, to: string, stops?: [number, number], linear = false): CanvasGradient {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  const cx = w / 2, cy = h / 2, len = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
  const g = ctx.createLinearGradient(cx - Math.cos(a) * len, cy - Math.sin(a) * len, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
  const s0 = Math.max(0, Math.min(1, stops?.[0] ?? 0)), s1 = Math.max(s0, Math.min(1, stops?.[1] ?? 1));
  if (linear) for (const st of linearLightStops([{ pos: s0, color: from }, { pos: s1, color: to }])) g.addColorStop(Math.max(0, Math.min(1, st.pos)), st.color);
  else { g.addColorStop(s0, from); g.addColorStop(s1, to); }
  return g;
}

/** Per-channel lookup tables for levels + curves, or null when neither is set. */
export function buildLuts(f: LayerFilters): [Uint8Array, Uint8Array, Uint8Array] | null {
  if (!f.levels && !f.curves) return null;
  const base = new Float32Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  const applyLevels = (arr: Float32Array) => {
    const l = f.levels!; const inB = l.inBlack, inW = Math.max(inB + 1, l.inWhite), g = Math.max(0.01, l.gamma);
    for (let i = 0; i < 256; i++) { const t = Math.max(0, Math.min(1, (arr[i] - inB) / (inW - inB))); arr[i] = l.outBlack + Math.pow(t, 1 / g) * (l.outWhite - l.outBlack); }
  };
  const curveMap = (pts: [number, number][]) => {
    const p = [...pts].sort((a, b) => a[0] - b[0]);
    if (!p.length) return null;
    return (v: number) => {
      if (v <= p[0][0]) return p[0][1];
      for (let i = 1; i < p.length; i++) if (v <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return x1 === x0 ? y1 : y0 + ((v - x0) / (x1 - x0)) * (y1 - y0); }
      return p[p.length - 1][1];
    };
  };
  const channels = ["r", "g", "b"] as const;
  return channels.map((ch) => {
    const arr = new Float32Array(base);
    if (f.levels) applyLevels(arr);
    const rgb = f.curves?.rgb && f.curves.rgb.length >= 2 ? curveMap(f.curves.rgb) : null;
    const own = f.curves?.[ch] && f.curves[ch]!.length >= 2 ? curveMap(f.curves[ch]!) : null;
    const out = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { let v = arr[i]; if (rgb) v = rgb(v); if (own) v = own(v); out[i] = Math.max(0, Math.min(255, Math.round(v))); }
    return out;
  }) as [Uint8Array, Uint8Array, Uint8Array];
}

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (r <= 0) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** Convert a luminance mask image (white = visible) into an alpha mask canvas. */
function luminanceToAlpha(env: RenderEnv, img: CanvasImageSource, asset?: { width: number; height: number }): CanvasLike {
  const w = asset?.width ?? (img as any).width, h = asset?.height ?? (img as any).height;
  const c = env.createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) * (px[i + 3] / 255);
    px[i] = px[i + 1] = px[i + 2] = 255; px[i + 3] = lum;
  }
  ctx.putImageData(data, 0, 0);
  return c;
}
