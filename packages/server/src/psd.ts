// PSD in / PSD out via ag-psd. Groups, visibility, opacity and blend modes map
// directly; content is rasterised per layer; text layers carry editable text
// data; layer effects and masks are written as real Photoshop styles/masks.
import { readPsd, writePsd, initializeCanvas, type Psd, type Layer as PsdLayer, type BlendMode as PsdBlend, type LayerEffectsInfo } from "ag-psd";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdDocument, Layer, LayerStyles, BlendMode, Asset, TextLayer } from "@pictocity/core";
import { renderDocument, renderLayer, layerBounds, isGroup, makeGroup, makeText, makeImage, makeFill, makeAdjustment, createDocument, uid, hasStyles, charStyle } from "@pictocity/core";
import { loadAssets, nodeEnv } from "./node-env.js";

initializeCanvas((w, h) => createCanvas(Math.max(1, w), Math.max(1, h)) as unknown as HTMLCanvasElement);

const px = (value: number) => ({ units: "Pixels" as const, value });
const rgb = (hex: string) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex) ?? /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const v = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
  return { r: v(m[1]), g: v(m[2]), b: v(m[3]) };
};
/** ag-psd colours can be rgb, hsb, cmyk, lab or grayscale; we only keep rgb (the others fall back to black). */
const hex = (c?: unknown) => {
  const o = c as { r?: number; g?: number; b?: number; k?: number } | undefined;
  if (!o || typeof o.r !== "number") return "#000000";
  return "#" + [o.r ?? 0, o.g ?? 0, o.b ?? 0].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
};

const toPsdBlend = (b: BlendMode): PsdBlend => (b.replace("-", " ") as PsdBlend);
const fromPsdBlend = (b?: PsdBlend): BlendMode => {
  if (!b || b === "pass through" || b === "dissolve") return "normal";
  const m = b.replace(" ", "-") as BlendMode;
  const known: BlendMode[] = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];
  return known.includes(m) ? m : "normal";
};

/** PostScript-ish font name Photoshop expects, e.g. Poppins-BoldItalic. */
function psFontName(l: TextLayer): string {
  const w = typeof l.fontWeight === "number" ? l.fontWeight : l.fontWeight === "bold" ? 700 : 400;
  const weight = w >= 900 ? "Black" : w >= 800 ? "ExtraBold" : w >= 700 ? "Bold" : w >= 600 ? "SemiBold" : w >= 500 ? "Medium" : w <= 200 ? "ExtraLight" : w <= 300 ? "Light" : "";
  const style = l.fontStyle === "italic" ? "Italic" : "";
  const suffix = (weight + style) || "Regular";
  return `${l.fontFamily.replace(/\s+/g, "")}-${suffix}`;
}

function parseFontName(name: string): { family: string; weight: number; italic: boolean } {
  const [fam, suffix = ""] = name.split("-");
  const family = fam.replace(/([a-z])([A-Z])/g, "$1 $2");
  const s = suffix.toLowerCase();
  const weight = /black|heavy/.test(s) ? 900 : /extrabold|ultrabold/.test(s) ? 800 : /semibold|demibold/.test(s) ? 600 : /bold/.test(s) ? 700 : /medium/.test(s) ? 500 : /extralight|ultralight/.test(s) ? 200 : /light/.test(s) ? 300 : /thin/.test(s) ? 100 : 400;
  return { family, weight, italic: /italic|oblique/.test(s) };
}

function stylesToEffects(s: LayerStyles): LayerEffectsInfo | undefined {
  const fx: LayerEffectsInfo = { scale: 1 };
  let any = false;
  if (s.dropShadow?.enabled) {
    const d = s.dropShadow, dist = Math.hypot(d.x, d.y);
    fx.dropShadow = [{ enabled: true, size: px(d.blur), distance: px(dist), angle: dist ? Math.round((Math.atan2(d.y, -d.x) * 180) / Math.PI) : 120, color: rgb(d.color), opacity: d.opacity, useGlobalLight: false, blendMode: "multiply", layerConceals: true }];
    any = true;
  }
  if (s.innerShadow?.enabled) {
    const d = s.innerShadow, dist = Math.hypot(d.x, d.y);
    fx.innerShadow = [{ enabled: true, size: px(d.blur), distance: px(dist), angle: dist ? Math.round((Math.atan2(d.y, -d.x) * 180) / Math.PI) : 120, color: rgb(d.color), opacity: d.opacity, useGlobalLight: false, blendMode: "multiply" }];
    any = true;
  }
  if (s.outerGlow?.enabled) { fx.outerGlow = { enabled: true, size: px(s.outerGlow.size), color: rgb(s.outerGlow.color), opacity: s.outerGlow.opacity, blendMode: "screen" }; any = true; }
  if (s.innerGlow?.enabled) { fx.innerGlow = { enabled: true, size: px(s.innerGlow.size), color: rgb(s.innerGlow.color), opacity: s.innerGlow.opacity, blendMode: "screen", source: "edge" }; any = true; }
  if (s.stroke?.enabled) { fx.stroke = [{ enabled: true, size: px(s.stroke.size), position: s.stroke.position, fillType: "color", color: rgb(s.stroke.color), opacity: 1, blendMode: "normal" }]; any = true; }
  if (s.colorOverlay?.enabled) { fx.solidFill = [{ enabled: true, color: rgb(s.colorOverlay.color), opacity: s.colorOverlay.opacity, blendMode: toPsdBlend(s.colorOverlay.blend) }]; any = true; }
  if (s.bevel?.enabled) {
    const b = s.bevel;
    fx.bevel = { enabled: true, style: "inner bevel", technique: "smooth", direction: "up", size: px(b.size), angle: b.angle, altitude: 30, useGlobalLight: false, strength: Math.round(b.depth * 100), highlightBlendMode: "screen", highlightColor: rgb(b.highlight), highlightOpacity: b.opacity, shadowBlendMode: "multiply", shadowColor: rgb(b.shadow), shadowOpacity: b.opacity, soften: px(0) } as LayerEffectsInfo["bevel"];
    any = true;
  }
  if (s.gradientOverlay?.enabled) {
    const g = s.gradientOverlay;
    fx.gradientOverlay = [{ enabled: true, opacity: g.opacity, blendMode: toPsdBlend(g.blend), angle: g.angle - 90, type: "linear", align: true, scale: 1,
      gradient: { type: "solid", name: "pictocity", smoothness: 1, colorStops: [{ color: rgb(g.from), location: 0, midpoint: 0.5 }, { color: rgb(g.to), location: 1, midpoint: 0.5 }], opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }] } }];
    any = true;
  }
  return any ? fx : undefined;
}

function effectsToStyles(fx?: LayerEffectsInfo): LayerStyles | undefined {
  if (!fx || fx.disabled) return undefined;
  const s: LayerStyles = {};
  const d = fx.dropShadow?.[0];
  if (d?.enabled) {
    const dist = d.distance?.value ?? 5, a = ((d.angle ?? 120) * Math.PI) / 180;
    s.dropShadow = { enabled: true, color: hex(d.color), blur: d.size?.value ?? 5, x: Math.round(-Math.cos(a) * dist), y: Math.round(Math.sin(a) * dist), opacity: d.opacity ?? 0.75 };
  }
  if (fx.outerGlow?.enabled) s.outerGlow = { enabled: true, color: hex(fx.outerGlow.color), size: fx.outerGlow.size?.value ?? 10, opacity: fx.outerGlow.opacity ?? 0.75 };
  const is = fx.innerShadow?.[0];
  if (is?.enabled) {
    const dist = is.distance?.value ?? 5, a = ((is.angle ?? 120) * Math.PI) / 180;
    s.innerShadow = { enabled: true, color: hex(is.color), blur: is.size?.value ?? 5, x: Math.round(-Math.cos(a) * dist), y: Math.round(Math.sin(a) * dist), opacity: is.opacity ?? 0.75 };
  }
  if (fx.innerGlow?.enabled) s.innerGlow = { enabled: true, color: hex(fx.innerGlow.color), size: fx.innerGlow.size?.value ?? 10, opacity: fx.innerGlow.opacity ?? 0.75 };
  const st = fx.stroke?.[0];
  if (st?.enabled) s.stroke = { enabled: true, color: hex(st.color), size: st.size?.value ?? 3, position: st.position ?? "outside" };
  const sf = fx.solidFill?.[0];
  if (sf?.enabled) s.colorOverlay = { enabled: true, color: hex(sf.color), opacity: sf.opacity ?? 1, blend: fromPsdBlend(sf.blendMode) };
  const bv = fx.bevel;
  if (bv?.enabled) s.bevel = { enabled: true, size: bv.size?.value ?? 5, depth: (bv.strength ?? 100) / 100, angle: bv.angle ?? 120, highlight: hex(bv.highlightColor), shadow: hex(bv.shadowColor), opacity: bv.highlightOpacity ?? 0.75 };
  const go = fx.gradientOverlay?.[0];
  if (go?.enabled && go.gradient && "colorStops" in go.gradient && go.gradient.colorStops.length >= 2) {
    const stops = go.gradient.colorStops;
    s.gradientOverlay = { enabled: true, from: hex(stops[0].color as { r: number; g: number; b: number }), to: hex(stops[stops.length - 1].color as { r: number; g: number; b: number }), angle: (go.angle ?? 90) + 90, opacity: go.opacity ?? 1, blend: fromPsdBlend(go.blendMode as PsdBlend) };
  }
  return Object.keys(s).length ? s : undefined;
}

/** Adjustment layers map to Photoshop's brightness/contrast, hue/saturation and invert where the filters allow it. */
function adjustmentToPsd(l: Layer & { type: "adjustment" }, base: PsdLayer): PsdLayer | null {
  const a = l.adjustment;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  let adjustment: PsdLayer["adjustment"] | undefined;
  const cbv = (v: [number, number, number]) => ({ cyanRed: clamp(v[0], -100, 100), magentaGreen: clamp(v[1], -100, 100), yellowBlue: clamp(v[2], -100, 100) });
  if (a.levels) adjustment = { type: "levels", rgb: { shadowInput: a.levels.inBlack, highlightInput: a.levels.inWhite, shadowOutput: a.levels.outBlack, highlightOutput: a.levels.outWhite, midtoneInput: a.levels.gamma } };
  else if (a.curves) adjustment = { type: "curves", ...Object.fromEntries((["rgb", "r", "g", "b"] as const).filter((k) => a.curves![k]).map((k) => [k === "r" ? "red" : k === "g" ? "green" : k === "b" ? "blue" : "rgb", a.curves![k]!.map(([i, o]) => ({ input: i, output: o }))])) } as PsdLayer["adjustment"];
  else if (a.exposure) adjustment = { type: "exposure", exposure: a.exposure.exposure, offset: a.exposure.offset, gamma: a.exposure.gamma };
  else if (a.vibrance !== undefined) adjustment = { type: "vibrance", vibrance: clamp(a.vibrance * 100, -100, 100), saturation: 0 };
  else if (a.colorBalance) adjustment = { type: "color balance", shadows: cbv(a.colorBalance.shadows), midtones: cbv(a.colorBalance.midtones), highlights: cbv(a.colorBalance.highlights), preserveLuminosity: a.colorBalance.preserveLuminosity !== false };
  else if (a.blackWhite) adjustment = { type: "black & white", reds: a.blackWhite.reds, yellows: a.blackWhite.yellows, greens: a.blackWhite.greens, cyans: a.blackWhite.cyans, blues: a.blackWhite.blues, magentas: a.blackWhite.magentas, useTint: !!a.blackWhite.tint, tintColor: a.blackWhite.tint ? rgb(a.blackWhite.tint) : undefined };
  else if (a.photoFilter) adjustment = { type: "photo filter", color: rgb(a.photoFilter.color), density: clamp(a.photoFilter.density * 100, 0, 100), preserveLuminosity: a.photoFilter.preserveLuminosity !== false };
  else if (a.gradientMap) adjustment = { type: "gradient map", gradientType: "solid", reverse: !!a.gradientMap.reverse, colorStops: a.gradientMap.stops.map((st) => ({ color: rgb(st.color), location: Math.round(st.pos * 4096), midpoint: 50 })), opacityStops: [{ opacity: 1, location: 0, midpoint: 50 }, { opacity: 1, location: 4096, midpoint: 50 }] } as PsdLayer["adjustment"];
  else if (a.channelMixer) { const ch = (c: [number, number, number, number]) => ({ red: c[0] * 100, green: c[1] * 100, blue: c[2] * 100, constant: c[3] * 100 }); adjustment = { type: "channel mixer", monochrome: !!a.channelMixer.monochrome, red: ch(a.channelMixer.r), green: ch(a.channelMixer.g), blue: ch(a.channelMixer.b) }; }
  else if (a.threshold !== undefined) adjustment = { type: "threshold", level: clamp(a.threshold, 1, 255) };
  else if (a.posterize !== undefined) adjustment = { type: "posterize", levels: clamp(a.posterize, 2, 255) };
  else if ((a.brightness !== undefined && a.brightness !== 1) || (a.contrast !== undefined && a.contrast !== 1)) {
    adjustment = { type: "brightness/contrast", brightness: clamp(((a.brightness ?? 1) - 1) * 150, -150, 150), contrast: clamp(((a.contrast ?? 1) - 1) * 100, -50, 100) };
  } else if (a.hueRotate || (a.saturate !== undefined && a.saturate !== 1) || a.grayscale) {
    const sat = a.grayscale && a.grayscale >= 0.5 ? -100 : clamp(((a.saturate ?? 1) - 1) * 100, -100, 100);
    adjustment = { type: "hue/saturation", master: { a: 0, b: 0, c: 0, d: 0, hue: clamp(((a.hueRotate ?? 0) + 180) % 360 - 180, -180, 180), saturation: sat, lightness: 0 } };
  } else if (a.invert && a.invert >= 0.5) {
    adjustment = { type: "invert" };
  }
  if (!adjustment) return null; // blur / sepia have no adjustment-layer equivalent
  return { ...base, adjustment };
}

// ---- Export --------------------------------------------------------------------------

export async function docToPsd(doc: AdDocument, assetsDir: string): Promise<Buffer> {
  const images = await loadAssets(doc, assetsDir);
  const env = nodeEnv(images);
  const W = doc.width, H = doc.height;

  const rasterOf = (layer: Layer, pad: number) => {
    const b = layerBounds(layer);
    const left = Math.max(0, Math.floor(b.x - pad)), top = Math.max(0, Math.floor(b.y - pad));
    const right = Math.min(W, Math.ceil(b.x + b.width + pad)), bottom = Math.min(H, Math.ceil(b.y + b.height + pad));
    if (right <= left || bottom <= top) return null;
    const canvas = renderLayer(doc, layer, env, 1) as unknown as Canvas;
    const imageData = canvas.getContext("2d").getImageData(left, top, right - left, bottom - top);
    return { left, top, right, bottom, imageData };
  };

  const convert = (l: Layer): PsdLayer | null => {
    const base: PsdLayer = { name: l.name, hidden: !l.visible, opacity: l.opacity, blendMode: toPsdBlend(l.blend), clipping: l.clipToBelow || undefined, protected: l.locked ? { transparency: true, composite: true, position: true } : undefined };
    if (l.type === "adjustment") return adjustmentToPsd(l, base);
    if (l.type === "text" && !l.text.trim()) return null; // empty text layers have nothing to carry over
    if (isGroup(l)) {
      const children = l.children.map(convert).filter((c): c is PsdLayer => !!c);
      const group: PsdLayer = { ...base, opened: true, blendMode: l.blend === "normal" ? "pass through" : toPsdBlend(l.blend), children, effects: l.styles && hasStyles(l.styles) ? stylesToEffects(l.styles) : undefined };
      if (l.artboard) group.artboard = { rect: { top: l.y, left: l.x, bottom: l.y + l.height, right: l.x + l.width } };
      return group;
    }
    // Content without effects/mask/opacity/blend - those become real PSD properties.
    const plain: Layer = { ...l, styles: undefined, mask: undefined, opacity: 1, blend: "normal" };
    const pad = (l.filters?.blur ?? 0) * 3 + 2;
    const r = rasterOf(plain, pad);
    if (!r) return null;
    const out: PsdLayer = { ...base, left: r.left, top: r.top, right: r.right, bottom: r.bottom, imageData: r.imageData, effects: l.styles && hasStyles(l.styles) ? stylesToEffects(l.styles) : undefined };
    if (l.mask) {
      // Render the mask as coverage of a white fill with the same transform -> grayscale mask image.
      const maskLayer = makeFill({ x: l.x, y: l.y, width: l.width, height: l.height, rotation: l.rotation, scaleX: l.scaleX, scaleY: l.scaleY, fill: { kind: "solid", color: "#ffffff" }, mask: l.mask });
      const mc = renderLayer(doc, maskLayer, env, 1) as unknown as Canvas;
      const md = mc.getContext("2d").getImageData(r.left, r.top, r.right - r.left, r.bottom - r.top);
      for (let i = 0; i < md.data.length; i += 4) { const a = md.data[i + 3]; md.data[i] = md.data[i + 1] = md.data[i + 2] = a; md.data[i + 3] = 255; }
      out.mask = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, imageData: md, defaultColor: 0 };
    }
    if (l.type === "text" && !l.onPath) {
      const rad = (l.rotation * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
      // Photoshop's transform maps text-space to document-space; put the origin at the box's rotated top-left corner.
      const ox = cx + (-l.width / 2) * cos - (-l.height / 2) * sin, oy = cy + (-l.width / 2) * sin + (-l.height / 2) * cos;
      const firstBaseline = l.fontSize * l.lineHeight * 0.5 + l.fontSize * 0.3;
      out.text = {
        text: l.textTransform === "uppercase" ? l.text.toUpperCase() : l.textTransform === "lowercase" ? l.text.toLowerCase() : l.text,
        transform: [cos, sin, -sin, cos, ox + (l.wrap ? 0 : 0), oy + (l.wrap ? 0 : firstBaseline)],
        shapeType: l.wrap ? "box" : "point",
        boxBounds: l.wrap ? [0, 0, l.width, l.height] : undefined,
        style: { font: { name: psFontName(l) }, fontSize: l.fontSize, fillColor: rgb(l.color), tracking: Math.round((l.letterSpacing / l.fontSize) * 1000), autoLeading: false, leading: l.fontSize * l.lineHeight },
        paragraphStyle: { justification: l.align === "justify" ? "justify-all" : l.align },
      };
      if (l.runs?.length) {
        // Character runs: group consecutive characters with the same style.
        const chars = [...l.text]; const runs: { length: number; style: Record<string, unknown> }[] = [];
        for (let i = 0; i < chars.length; i++) {
          const st = charStyle(l, i);
          const style = { fillColor: rgb(st.color), underline: st.underline || undefined, fauxBold: (typeof st.fontWeight === "number" ? st.fontWeight >= 600 : st.fontWeight === "bold") && !(typeof l.fontWeight === "number" ? l.fontWeight >= 600 : l.fontWeight === "bold") ? true : undefined, fauxItalic: st.fontStyle === "italic" && l.fontStyle !== "italic" ? true : undefined };
          const last = runs[runs.length - 1];
          if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.length++; else runs.push({ length: 1, style });
        }
        out.text.styleRuns = runs as unknown as NonNullable<PsdLayer["text"]>["styleRuns"];
      }
    }
    return out;
  };

  const composite = renderDocument(doc, env) as unknown as Canvas;
  const psd: Psd = {
    width: W, height: H,
    children: doc.layers.map(convert).filter((c): c is PsdLayer => !!c),
    imageData: composite.getContext("2d").getImageData(0, 0, W, H),
  };
  return Buffer.from(writePsd(psd, { generateThumbnail: false, trimImageData: true }));
}

// ---- Import --------------------------------------------------------------------------

export function psdToDoc(bytes: Buffer, name: string, assetsDir: string): AdDocument {
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true, skipCompositeImageData: true, skipLinkedFilesData: true });
  const doc = createDocument({ name: name.replace(/\.psd$/i, ""), width: psd.width, height: psd.height, background: null });

  const saveImage = (imageData: { width: number; height: number; data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array }, label: string): Asset => {
    const c = createCanvas(imageData.width, imageData.height);
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(imageData.width, imageData.height);
    id.data.set(imageData.data as Uint8ClampedArray);
    ctx.putImageData(id, 0, 0);
    const asset: Asset = { id: uid("a"), name: label, src: "", width: imageData.width, height: imageData.height, mime: "image/png" };
    asset.src = `/assets/${asset.id}.png`;
    writeFileSync(join(assetsDir, `${asset.id}.png`), c.toBuffer("image/png"));
    doc.assets[asset.id] = asset;
    return asset;
  };

  const convert = (p: PsdLayer): Layer | null => {
    const left = p.left ?? 0, top = p.top ?? 0, width = Math.max(1, (p.right ?? left) - left), height = Math.max(1, (p.bottom ?? top) - top);
    const common = { name: p.name ?? "Layer", visible: !p.hidden, locked: !!(p.protected?.position || p.protected?.composite), opacity: p.opacity ?? 1, blend: fromPsdBlend(p.blendMode), styles: effectsToStyles(p.effects), clipToBelow: p.clipping || undefined };
    let layer: Layer | null = null;
    if (p.children) {
      const ab = p.artboard?.rect;
      layer = makeGroup({ ...common, children: p.children.map(convert).filter((c): c is Layer => !!c), x: ab ? ab.left : left, y: ab ? ab.top : top, width: ab ? ab.right - ab.left : width, height: ab ? ab.bottom - ab.top : height, artboard: !!ab || undefined });
    } else if (p.text?.text) {
      const t = p.text; const st = t.style ?? {};
      const font = parseFontName(st.font?.name ?? "Poppins-Regular");
      const fontSize = st.fontSize ?? 24;
      const tf = t.transform;
      const boxed = t.shapeType === "box" && t.boxBounds;
      const rotation = tf ? Math.round((Math.atan2(tf[1], tf[0]) * 180) / Math.PI) : 0;
      // Photoshop style runs → character runs (colour, faux bold/italic, underline) where they differ from the base style.
      const psdRuns = (t.styleRuns ?? []) as { length: number; style?: { fillColor?: unknown; fauxBold?: boolean; fauxItalic?: boolean; underline?: boolean; font?: { name?: string } } }[];
      const runs: import("@pictocity/core").TextRun[] = []; let pos = 0;
      for (const r of psdRuns) {
        const rs = r.style ?? {}; const run: import("@pictocity/core").TextRun = { start: pos, end: pos + r.length };
        if (rs.fillColor && hex(rs.fillColor as { r: number; g: number; b: number }) !== hex(st.fillColor as { r: number; g: number; b: number })) run.color = hex(rs.fillColor as { r: number; g: number; b: number });
        if (rs.fauxBold) run.fontWeight = 700; if (rs.fauxItalic) run.fontStyle = "italic"; if (rs.underline) run.underline = true;
        if (rs.font?.name && rs.font.name !== st.font?.name) { const f2 = parseFontName(rs.font.name); if (f2.weight !== font.weight) run.fontWeight = f2.weight; if (f2.italic && !font.italic) run.fontStyle = "italic"; }
        if (Object.keys(run).length > 2) runs.push(run);
        pos += r.length;
      }
      layer = makeText({
        ...(runs.length ? { runs } : {}),
        ...common, text: t.text.replace(/\r/g, "\n"), fontFamily: font.family, fontWeight: font.weight, fontStyle: font.italic ? "italic" : "normal",
        fontSize, color: hex(st.fillColor as { r: number; g: number; b: number }), align: (t.paragraphStyle?.justification as "left" | "center" | "right") ?? "left",
        letterSpacing: st.tracking ? (st.tracking / 1000) * fontSize : 0, lineHeight: st.leading && !st.autoLeading ? st.leading / fontSize : 1.2,
        wrap: !!boxed, rotation,
        x: boxed && tf ? tf[4] : left, y: boxed && tf ? tf[5] : top,
        width: boxed ? (t.boxBounds![2] - t.boxBounds![0]) : width + 4, height: boxed ? (t.boxBounds![3] - t.boxBounds![1]) : height + 4,
      });
    } else if (p.adjustment) {
      const adj = p.adjustment;
      const filters: import("@pictocity/core").LayerFilters = {};
      if (adj.type === "brightness/contrast") { filters.brightness = 1 + (adj.brightness ?? 0) / 150; filters.contrast = 1 + (adj.contrast ?? 0) / 100; }
      else if (adj.type === "levels" && adj.rgb) filters.levels = { inBlack: adj.rgb.shadowInput, inWhite: adj.rgb.highlightInput, gamma: adj.rgb.midtoneInput, outBlack: adj.rgb.shadowOutput, outWhite: adj.rgb.highlightOutput };
      else if (adj.type === "curves") { const c: NonNullable<import("@pictocity/core").LayerFilters["curves"]> = {}; if (adj.rgb) c.rgb = adj.rgb.map((p) => [p.input, p.output]); if (adj.red) c.r = adj.red.map((p) => [p.input, p.output]); if (adj.green) c.g = adj.green.map((p) => [p.input, p.output]); if (adj.blue) c.b = adj.blue.map((p) => [p.input, p.output]); filters.curves = c; }
      else if (adj.type === "exposure") filters.exposure = { exposure: adj.exposure ?? 0, offset: adj.offset ?? 0, gamma: adj.gamma ?? 1 };
      else if (adj.type === "vibrance") filters.vibrance = (adj.vibrance ?? 0) / 100;
      else if (adj.type === "color balance") { const v = (x?: { cyanRed: number; magentaGreen: number; yellowBlue: number }): [number, number, number] => [x?.cyanRed ?? 0, x?.magentaGreen ?? 0, x?.yellowBlue ?? 0]; filters.colorBalance = { shadows: v(adj.shadows), midtones: v(adj.midtones), highlights: v(adj.highlights), preserveLuminosity: adj.preserveLuminosity }; }
      else if (adj.type === "black & white") filters.blackWhite = { reds: adj.reds ?? 40, yellows: adj.yellows ?? 60, greens: adj.greens ?? 40, cyans: adj.cyans ?? 60, blues: adj.blues ?? 20, magentas: adj.magentas ?? 80, tint: adj.useTint && adj.tintColor ? hex(adj.tintColor) : undefined };
      else if (adj.type === "photo filter") filters.photoFilter = { color: hex(adj.color), density: (adj.density ?? 25) / 100, preserveLuminosity: adj.preserveLuminosity };
      else if (adj.type === "gradient map") filters.gradientMap = { stops: (adj.colorStops ?? []).map((st) => ({ pos: st.location / 4096, color: hex(st.color) })), reverse: adj.reverse };
      else if (adj.type === "channel mixer") { const ch = (c?: { red: number; green: number; blue: number; constant: number }): [number, number, number, number] => [(c?.red ?? 100) / 100, (c?.green ?? 0) / 100, (c?.blue ?? 0) / 100, (c?.constant ?? 0) / 100]; filters.channelMixer = { r: ch(adj.red), g: adj.green ? [(adj.green.red) / 100, adj.green.green / 100, adj.green.blue / 100, adj.green.constant / 100] : [0, 1, 0, 0], b: adj.blue ? [adj.blue.red / 100, adj.blue.green / 100, adj.blue.blue / 100, adj.blue.constant / 100] : [0, 0, 1, 0], monochrome: adj.monochrome }; }
      else if (adj.type === "threshold") filters.threshold = adj.level ?? 128;
      else if (adj.type === "posterize") filters.posterize = adj.levels ?? 4;
      else if (adj.type === "hue/saturation") { const m = adj.master; if (m) { if (m.hue) filters.hueRotate = m.hue; if (m.saturation === -100) filters.grayscale = 1; else if (m.saturation) filters.saturate = 1 + m.saturation / 100; } }
      else if (adj.type === "invert") filters.invert = 1;
      else return null; // levels, curves, etc. have no equivalent yet
      layer = makeAdjustment({ ...common, adjustment: filters, x: 0, y: 0, width: doc.width, height: doc.height });
    } else if (p.imageData && p.imageData.width > 0 && p.imageData.height > 0) {
      const asset = saveImage(p.imageData, `${p.name ?? "layer"}.png`);
      layer = makeImage({ ...common, assetId: asset.id, x: left, y: top, width, height, fit: "fill" });
    }
    if (!layer) return null;
    if (p.mask?.imageData && !p.mask.disabled && !isGroup(layer)) {
      // Build a layer-sized mask: default colour everywhere, mask pixels where the PSD mask has coverage.
      const mw = width, mh = height;
      const c = createCanvas(mw, mh); const ctx = c.getContext("2d");
      const def = p.mask.defaultColor ?? 255;
      ctx.fillStyle = `rgb(${def},${def},${def})`; ctx.fillRect(0, 0, mw, mh);
      const mi = ctx.createImageData(p.mask.imageData.width, p.mask.imageData.height); mi.data.set(p.mask.imageData.data as Uint8ClampedArray);
      const tmp = createCanvas(p.mask.imageData.width, p.mask.imageData.height); tmp.getContext("2d").putImageData(mi, 0, 0);
      ctx.drawImage(tmp, (p.mask.left ?? left) - left, (p.mask.top ?? top) - top);
      const maskAsset = saveImage(ctx.getImageData(0, 0, mw, mh), `${p.name ?? "layer"}-mask.png`);
      layer.mask = { kind: "raster", assetId: maskAsset.id };
    }
    return layer;
  };

  doc.layers = (psd.children ?? []).map(convert).filter((c): c is Layer => !!c);
  return doc;
}
