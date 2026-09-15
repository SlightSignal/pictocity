// SVG in / SVG out. Import parses a useful subset (paths, basic shapes, text, groups, transforms, fills/strokes)
// into editable layers. Export writes vector layers as SVG elements and rasterises anything it can't express.
import type { AdDocument, Layer, ShapeLayer, TextLayer, GroupLayer } from "./types.js";
import { makeShape, makeText, makeGroup, uid, anchorsToPath, shapeToAnchors, flattenPath, polygonBounds, localToDocument } from "./document.js";
import { layoutText, fontString, renderLayer, type RenderEnv, type CanvasLike } from "./render.js";

// ---- Minimal XML tokenizer ---------------------------------------------------------

interface XNode { tag: string; attrs: Record<string, string>; children: XNode[]; text: string }

function parseXml(src: string): XNode {
  const root: XNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) { stack[stack.length - 1].text += m[1]; continue; }
    if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[3]) {
      const attrs: Record<string, string> = {};
      const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let am: RegExpExecArray | null;
      while ((am = ar.exec(m[4] ?? ""))) attrs[am[1]] = decode(am[2] ?? am[3] ?? "");
      const node: XNode = { tag: m[3], attrs, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!m[5]) stack.push(node);
      continue;
    }
    if (m[6] !== undefined) stack[stack.length - 1].text += decode(m[6]);
  }
  return root;
}
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
const encode = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- Transforms (2x3 affine) --------------------------------------------------------

type Mat = [number, number, number, number, number, number];
const I: Mat = [1, 0, 0, 1, 0, 0];
const mul = (a: Mat, b: Mat): Mat => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m: Mat, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

function parseTransform(t?: string): Mat {
  let m: Mat = I;
  if (!t) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g; let r: RegExpExecArray | null;
  while ((r = re.exec(t))) {
    const a = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let n: Mat = I;
    if (r[1] === "matrix" && a.length === 6) n = a as Mat;
    else if (r[1] === "translate") n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (r[1] === "scale") n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (r[1] === "rotate") { const rad = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad); n = [c, s, -s, c, 0, 0]; if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]); }
    else if (r[1] === "skewX") n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (r[1] === "skewY") n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = mul(m, n);
  }
  return m;
}

// ---- Path data → absolute M/L/C/Z ----------------------------------------------------

/** Normalise SVG path data (all commands incl. relative, arcs, smooth curves) to absolute M/L/C/Z in the given transform. */
export function normalisePathData(d: string, m: Mat = I): string {
  const tok = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  let i = 0, cmd = "", cx = 0, cy = 0, sx = 0, sy = 0, px = 0, py = 0; // current point, subpath start, last control
  const out: string[] = [];
  const num = () => Number(tok[i++]);
  const T = (x: number, y: number) => { const p = apply(m, x, y); return `${p.x.toFixed(3)} ${p.y.toFixed(3)}`; };
  const M = (x: number, y: number) => { out.push(`M${T(x, y)}`); cx = sx = x; cy = sy = y; px = x; py = y; };
  const L = (x: number, y: number) => { out.push(`L${T(x, y)}`); cx = x; cy = y; px = x; py = y; };
  const C = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => { out.push(`C${T(x1, y1)} ${T(x2, y2)} ${T(x, y)}`); px = x2; py = y2; cx = x; cy = y; };
  const Q = (x1: number, y1: number, x: number, y: number) => { C(cx + (2 / 3) * (x1 - cx), cy + (2 / 3) * (y1 - cy), x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x, y); px = x1; py = y1; };
  const arc = (rx: number, ry: number, phi: number, large: number, sweep: number, x: number, y: number) => {
    // Flatten the elliptical arc into line segments (endpoint parameterisation → centre).
    if (rx === 0 || ry === 0) { L(x, y); return; }
    const rad = (phi * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = (cx - x) / 2, dy = (cy - y) / 2, x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
    let rxs = rx * rx, rys = ry * ry; const lam = (x1 * x1) / rxs + (y1 * y1) / rys; if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); rxs = rx * rx; rys = ry * ry; }
    const sign = large === sweep ? -1 : 1, num2 = Math.max(0, rxs * rys - rxs * y1 * y1 - rys * x1 * x1), coef = sign * Math.sqrt(num2 / (rxs * y1 * y1 + rys * x1 * x1 || 1e-9));
    const cxp = (coef * rx * y1) / ry, cyp = (-coef * ry * x1) / rx;
    const ccx = cos * cxp - sin * cyp + (cx + x) / 2, ccy = sin * cxp + cos * cyp + (cy + y) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => { const d = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return d; };
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry); let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 36)));
    for (let k = 1; k <= n; k++) { const t = t1 + (dt * k) / n; const ex = rx * Math.cos(t), ey = ry * Math.sin(t); L(cos * ex - sin * ey + ccx, sin * ex + cos * ey + ccy); }
  };
  while (i < tok.length) {
    const t = tok[i];
    if (/^[a-zA-Z]$/.test(t)) { cmd = t; i++; if (cmd === "z" || cmd === "Z") { out.push("Z"); cx = sx; cy = sy; continue; } }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case "M": { const x = num() + ox, y = num() + oy; M(x, y); cmd = rel ? "l" : "L"; break; }
      case "L": L(num() + ox, num() + oy); break;
      case "H": L(num() + ox, cy); break;
      case "V": L(cx, num() + oy); break;
      case "C": C(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy); break;
      case "S": { const x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy; C(2 * cx - px, 2 * cy - py, x2, y2, x, y); break; }
      case "Q": Q(num() + ox, num() + oy, num() + ox, num() + oy); break;
      case "T": { const x = num() + ox, y = num() + oy; Q(2 * cx - px, 2 * cy - py, x, y); break; }
      case "A": { const rx = num(), ry = num(), phi = num(), large = num(), sweep = num(), x = num() + ox, y = num() + oy; arc(rx, ry, phi, large, sweep, x, y); break; }
      default: i++;
    }
  }
  return out.join(" ");
}

// ---- Import ------------------------------------------------------------------------

const colorOf = (v?: string): string | null => {
  if (!v || v === "none" || v === "transparent") return null;
  const t = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) return "#" + [...t.slice(1)].map((c) => c + c).join("").toLowerCase();
  const rgb = /^rgba?\(([^)]+)\)/i.exec(t);
  if (rgb) { const [r, g, b] = rgb[1].split(/[\s,]+/).map((x) => (x.endsWith("%") ? (Number(x.slice(0, -1)) * 255) / 100 : Number(x))); return "#" + [r, g, b].map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0")).join(""); }
  if (t.startsWith("url(")) return null;
  const named: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", gray: "#808080", grey: "#808080", purple: "#800080", pink: "#ffc0cb", cyan: "#00ffff", magenta: "#ff00ff", navy: "#000080", teal: "#008080", lime: "#00ff00", silver: "#c0c0c0", maroon: "#800000", olive: "#808000", brown: "#a52a2a", gold: "#ffd700" };
  return named[t.toLowerCase()] ?? "#000000";
};

function styleOf(node: XNode, inherited: Record<string, string>): Record<string, string> {
  const st = { ...inherited };
  for (const k of ["fill", "stroke", "stroke-width", "opacity", "fill-opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "stroke-dasharray"]) if (node.attrs[k] !== undefined) st[k] = node.attrs[k];
  if (node.attrs.style) for (const part of node.attrs.style.split(";")) { const [k, v] = part.split(":").map((x) => x?.trim()); if (k && v) st[k] = v; }
  return st;
}

/** Convert an SVG document into layers (and its size). */
export function svgToLayers(svg: string): { width: number; height: number; layers: Layer[] } {
  const root = parseXml(svg);
  const svgNode = root.children.find((c) => c.tag === "svg") ?? root;
  const vb = (svgNode.attrs.viewBox ?? "").split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
  const num = (v?: string) => (v ? parseFloat(v) : NaN);
  let width = num(svgNode.attrs.width), height = num(svgNode.attrs.height);
  let base: Mat = I;
  if (vb.length === 4) {
    if (!width || Number.isNaN(width)) width = vb[2];
    if (!height || Number.isNaN(height)) height = vb[3];
    base = [width / vb[2], 0, 0, height / vb[3], (-vb[0] * width) / vb[2], (-vb[1] * height) / vb[3]];
  }
  if (!width || Number.isNaN(width)) width = 1000; if (!height || Number.isNaN(height)) height = 1000;
  const layers: Layer[] = [];
  const isIdentityScaleRot = (m: Mat) => Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && m[0] > 0 && m[3] > 0;

  const pathLayer = (d: string, st: Record<string, string>, name: string): ShapeLayer | null => {
    const pts = flattenPath(d);
    if (pts.length < 4) return null;
    const b = polygonBounds(pts);
    // Re-express the absolute path in a 0..1 box.
    const norm = d.replace(/(-?\d*\.?\d+(?:e-?\d+)?)\s+(-?\d*\.?\d+(?:e-?\d+)?)/g, (_, x, y) => `${((Number(x) - b.x) / b.width).toFixed(4)} ${((Number(y) - b.y) / b.height).toFixed(4)}`);
    const fill = st.fill === undefined ? "#000000" : colorOf(st.fill);
    const strokeColor = colorOf(st.stroke); const strokeWidth = strokeColor ? num(st["stroke-width"]) || 1 : 0;
    const opacity = (num(st.opacity) || 1) * (fill ? (num(st["fill-opacity"]) || 1) : 1);
    return makeShape({ name, shape: "path", path: norm, x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, width: Math.round(b.width * 10) / 10, height: Math.round(b.height * 10) / 10, fill, strokeColor, strokeWidth, opacity: Math.max(0, Math.min(1, opacity)), dash: st["stroke-dasharray"] && st["stroke-dasharray"] !== "none" ? st["stroke-dasharray"].split(/[\s,]+/).map(Number).filter((n) => n > 0) : undefined });
  };

  const visit = (node: XNode, m: Mat, inherited: Record<string, string>, out: Layer[]) => {
    for (const c of node.children) {
      if (["defs", "style", "metadata", "title", "desc", "clipPath", "mask", "linearGradient", "radialGradient", "pattern", "symbol"].includes(c.tag)) continue;
      const st = styleOf(c, inherited);
      const cm = mul(m, parseTransform(c.attrs.transform));
      const name = c.attrs.id ?? c.tag;
      if (c.tag === "g" || c.tag === "svg" || c.tag === "a") {
        const kids: Layer[] = []; visit(c, cm, st, kids);
        if (kids.length) { const g = makeGroup({ name, children: kids }); out.push(g); }
        continue;
      }
      if (c.tag === "path" && c.attrs.d) { const l = pathLayer(normalisePathData(c.attrs.d, cm), st, name); if (l) out.push(l); continue; }
      if (c.tag === "rect") {
        const x = num(c.attrs.x) || 0, y = num(c.attrs.y) || 0, w = num(c.attrs.width) || 0, h = num(c.attrs.height) || 0, rx = num(c.attrs.rx) || num(c.attrs.ry) || 0;
        if (isIdentityScaleRot(cm)) { const p = apply(cm, x, y); const fill = st.fill === undefined ? "#000000" : colorOf(st.fill); const sc = colorOf(st.stroke); out.push(makeShape({ name, shape: "rect", x: p.x, y: p.y, width: w * cm[0], height: h * cm[3], radius: rx * cm[0], fill, strokeColor: sc, strokeWidth: sc ? num(st["stroke-width"]) || 1 : 0, opacity: num(st.opacity) || 1 })); }
        else { const l = pathLayer(normalisePathData(rx ? `M${x + rx} ${y} H${x + w - rx} A${rx} ${rx} 0 0 1 ${x + w} ${y + rx} V${y + h - rx} A${rx} ${rx} 0 0 1 ${x + w - rx} ${y + h} H${x + rx} A${rx} ${rx} 0 0 1 ${x} ${y + h - rx} V${y + rx} A${rx} ${rx} 0 0 1 ${x + rx} ${y} Z` : `M${x} ${y} H${x + w} V${y + h} H${x} Z`, cm), st, name); if (l) out.push(l); }
        continue;
      }
      if (c.tag === "circle" || c.tag === "ellipse") {
        const cx = num(c.attrs.cx) || 0, cy = num(c.attrs.cy) || 0, rx = c.tag === "circle" ? num(c.attrs.r) || 0 : num(c.attrs.rx) || 0, ry = c.tag === "circle" ? rx : num(c.attrs.ry) || 0;
        if (isIdentityScaleRot(cm)) { const p = apply(cm, cx - rx, cy - ry); const fill = st.fill === undefined ? "#000000" : colorOf(st.fill); const sc = colorOf(st.stroke); out.push(makeShape({ name, shape: "ellipse", x: p.x, y: p.y, width: 2 * rx * cm[0], height: 2 * ry * cm[3], fill, strokeColor: sc, strokeWidth: sc ? num(st["stroke-width"]) || 1 : 0, opacity: num(st.opacity) || 1 })); }
        else { const l = pathLayer(normalisePathData(`M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`, cm), st, name); if (l) out.push(l); }
        continue;
      }
      if (c.tag === "line") { const l = pathLayer(normalisePathData(`M${num(c.attrs.x1) || 0} ${num(c.attrs.y1) || 0} L${num(c.attrs.x2) || 0} ${num(c.attrs.y2) || 0}`, cm), { ...st, fill: "none" }, name); if (l) { l.strokeColor = l.strokeColor ?? "#000000"; l.strokeWidth = l.strokeWidth || 1; out.push(l); } continue; }
      if (c.tag === "polygon" || c.tag === "polyline") {
        const nums = (c.attrs.points ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
        if (nums.length >= 4) { let d = `M${nums[0]} ${nums[1]}`; for (let k = 2; k + 1 < nums.length; k += 2) d += ` L${nums[k]} ${nums[k + 1]}`; if (c.tag === "polygon") d += " Z"; const l = pathLayer(normalisePathData(d, cm), c.tag === "polyline" ? { ...st, fill: "none" } : st, name); if (l) out.push(l); }
        continue;
      }
      if (c.tag === "text") {
        const text = (c.text + c.children.map((t) => t.text).join("")).trim();
        if (!text) continue;
        const size = (num(st["font-size"]) || 16) * Math.hypot(cm[0], cm[1]);
        const p = apply(cm, num(c.attrs.x) || 0, num(c.attrs.y) || 0);
        const anchor = st["text-anchor"] ?? "start";
        const weight = st["font-weight"] === "bold" ? 700 : Number(st["font-weight"]) || 400;
        const family = (st["font-family"] ?? "Poppins").split(",")[0].replace(/["']/g, "").trim();
        const approxW = text.length * size * 0.6;
        out.push(makeText({ name, text, fontFamily: family, fontSize: size, fontWeight: weight, fontStyle: st["font-style"] === "italic" ? "italic" : "normal", color: st.fill === undefined ? "#000000" : colorOf(st.fill) ?? "#000000", wrap: false, align: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left", x: anchor === "middle" ? p.x - approxW / 2 : anchor === "end" ? p.x - approxW : p.x, y: p.y - size * 0.8, width: approxW, height: size * 1.2, opacity: num(st.opacity) || 1 }));
        continue;
      }
      if (c.tag === "image") continue; // raster images inside SVGs aren't imported (would need the asset pipeline)
    }
  };
  visit(svgNode, base, {}, layers);
  return { width: Math.round(width), height: Math.round(height), layers };
}

// ---- Export ------------------------------------------------------------------------

export interface SvgExportOptions {
  /** Return a data: URL (or http URL) for an asset id, or null to skip. */
  assetUrl: (assetId: string) => string | null;
  /** Rasterise a layer the export can't express; returns a PNG data URL and its document rect, or null. */
  raster?: (layer: Layer) => { url: string; x: number; y: number; width: number; height: number } | null;
  env: RenderEnv;
}

const matrixOf = (l: Layer) => {
  const a = localToDocument(l, { x: 0, y: 0 }), b = localToDocument(l, { x: 1, y: 0 }), c = localToDocument(l, { x: 0, y: 1 });
  return `matrix(${(b.x - a.x).toFixed(5)} ${(b.y - a.y).toFixed(5)} ${(c.x - a.x).toFixed(5)} ${(c.y - a.y).toFixed(5)} ${a.x.toFixed(3)} ${a.y.toFixed(3)})`;
};

/** Whether a layer can be written as native SVG (vs. rasterised). */
function vectorable(l: Layer): boolean {
  if (l.filters && Object.keys(l.filters).length) return false;
  if (l.quad || (l.mask && l.mask.kind !== "shape")) return false;
  const st = l.styles; const others = st ? Object.entries(st).filter(([k, v]) => k !== "dropShadow" && v && (v as { enabled: boolean }).enabled) : [];
  if (others.length) return false;
  if (l.type === "brush") return !l.strokes.some((s) => s.erase || s.clone);
  if (l.type === "fill") return l.fill.kind !== "pattern";
  if (l.type === "text") return !l.onPath && !l.vertical && !(l.runs && l.runs.length);
  return l.type === "shape" || l.type === "image";
}

export function documentToSvg(doc: AdDocument, opts: SvgExportOptions): string {
  const defs: string[] = []; let defId = 0;
  const measure = opts.env.createCanvas(1, 1).getContext("2d");
  const blend = (l: Layer) => (l.blend !== "normal" ? ` style="mix-blend-mode:${l.blend}"` : "");
  const common = (l: Layer, extra = "") => `${l.opacity < 1 ? ` opacity="${l.opacity}"` : ""}${blend(l)}${extra}`;
  const shadowFilter = (l: Layer) => {
    const d = l.styles?.dropShadow; if (!d?.enabled) return "";
    const id = `sh${++defId}`; defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${d.x}" dy="${d.y}" stdDeviation="${d.blur / 2}" flood-color="${d.color}" flood-opacity="${d.opacity}"/></filter>`);
    return ` filter="url(#${id})"`;
  };
  const clip = (l: Layer) => {
    const m = l.mask; if (!m || m.kind !== "shape") return "";
    const id = `cl${++defId}`;
    defs.push(`<clipPath id="${id}">${m.shape === "ellipse" ? `<ellipse cx="${m.x + m.width / 2}" cy="${m.y + m.height / 2}" rx="${m.width / 2}" ry="${m.height / 2}"/>` : `<rect x="${m.x}" y="${m.y}" width="${m.width}" height="${m.height}" rx="${m.radius ?? 0}"/>`}</clipPath>`);
    return ` clip-path="url(#${id})"`;
  };
  const stroke = (l: ShapeLayer) => (l.strokeColor && l.strokeWidth > 0 ? ` stroke="${l.strokeColor}" stroke-width="${l.strokeWidth}"${l.dash?.length ? ` stroke-dasharray="${l.dash.join(" ")}"` : ""} stroke-linejoin="round"` : "");

  const emit = (l: Layer): string => {
    if (!l.visible) return "";
    if (l.type === "adjustment") return "";
    if (l.type === "group") {
      if (l.artboard) return `<g id="${encode(l.name)}" data-artboard="${l.width}x${l.height}"${common(l)}><clipPath id="ab${++defId}"><rect x="${l.x}" y="${l.y}" width="${l.width}" height="${l.height}"/></clipPath><g clip-path="url(#ab${defId})">${l.children.map(emit).join("")}</g></g>`;
      return `<g id="${encode(l.name)}"${common(l)}>${l.children.map(emit).join("")}</g>`;
    }
    if (!vectorable(l) && opts.raster) {
      const r = opts.raster(l);
      return r ? `<image id="${encode(l.name)}" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" href="${r.url}"${common(l)}/>` : "";
    }
    const tf = ` transform="${matrixOf(l)}"`;
    const fx = shadowFilter(l) + clip(l);
    if (l.type === "shape") {
      if (l.shape === "line") return `<line x1="0" y1="${l.height / 2}" x2="${l.width}" y2="${l.height / 2}" stroke="${l.strokeColor ?? l.fill ?? "#000"}" stroke-width="${l.strokeWidth || 2}" stroke-linecap="round"${l.dash?.length ? ` stroke-dasharray="${l.dash.join(" ")}"` : ""}${tf}${common(l, fx)}/>`;
      const anchors = shapeToAnchors(l);
      const d = l.shape === "path" && l.path ? scalePath(l.path, l.width, l.height) : anchors ? scalePath(anchorsToPath(anchors), l.width, l.height) : `M0 0 H${l.width} V${l.height} H0 Z`;
      return `<path id="${encode(l.name)}" d="${d}" fill="${l.fill ?? "none"}" fill-rule="evenodd"${stroke(l)}${tf}${common(l, fx)}/>`;
    }
    if (l.type === "fill") {
      let fill = "#000";
      if (l.fill.kind === "solid") fill = l.fill.color;
      else if (l.fill.kind === "linear") { const id = `g${++defId}`; const a = ((l.fill.angle - 90) * Math.PI) / 180; const s0 = l.fill.stops?.[0] ?? 0, s1 = l.fill.stops?.[1] ?? 1; defs.push(`<linearGradient id="${id}" x1="${(0.5 - Math.cos(a) / 2).toFixed(4)}" y1="${(0.5 - Math.sin(a) / 2).toFixed(4)}" x2="${(0.5 + Math.cos(a) / 2).toFixed(4)}" y2="${(0.5 + Math.sin(a) / 2).toFixed(4)}"><stop offset="${s0}" stop-color="${l.fill.from}"/><stop offset="${s1}" stop-color="${l.fill.to}"/></linearGradient>`); fill = `url(#${id})`; }
      else if (l.fill.kind === "radial") { const id = `g${++defId}`; defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="${l.fill.from}"/><stop offset="1" stop-color="${l.fill.to}"/></radialGradient>`); fill = `url(#${id})`; }
      return `<rect id="${encode(l.name)}" width="${l.width}" height="${l.height}" fill="${fill}"${tf}${common(l, fx)}/>`;
    }
    if (l.type === "image") {
      const url = opts.assetUrl(l.assetId); if (!url) return "";
      const par = l.fit === "cover" ? "xMidYMid slice" : l.fit === "contain" ? "xMidYMid meet" : "none";
      return `<image id="${encode(l.name)}" width="${l.width}" height="${l.height}" preserveAspectRatio="${par}" href="${url}"${tf}${common(l, fx)}/>`;
    }
    if (l.type === "brush") {
      const paths = l.strokes.map((s) => {
        const p = s.points; if (p.length < 2) return "";
        if (s.fill) { const rings = s.rings ?? [p]; return `<path d="${rings.map((r) => { let d = `M${r[0]} ${r[1]}`; for (let i = 2; i < r.length; i += 2) d += ` L${r[i]} ${r[i + 1]}`; return d + " Z"; }).join(" ")}" fill="${s.color}" fill-rule="evenodd" opacity="${s.opacity}"/>`; }
        let d = `M${p[0]} ${p[1]}`; for (let i = 2; i < p.length; i += 2) d += ` L${p[i]} ${p[i + 1]}`;
        return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round" opacity="${s.opacity}"/>`;
      });
      return `<g id="${encode(l.name)}"${tf}${common(l, fx)}>${paths.join("")}</g>`;
    }
    if (l.type === "text") {
      const t = l as TextLayer; const layout = layoutText(measure, t);
      const lineH = t.fontSize * t.lineHeight, blockH = layout.lines.length * lineH;
      const top = t.verticalAlign === "middle" ? (t.height - blockH) / 2 : t.verticalAlign === "bottom" ? t.height - blockH : 0;
      const baseline = (lineH - t.fontSize) / 2 + t.fontSize * 0.8;
      const anchor = t.align === "center" ? "middle" : t.align === "right" ? "end" : "start";
      const ax = t.align === "center" ? t.width / 2 : t.align === "right" ? t.width : 0;
      let text = t.text; if (t.textTransform === "uppercase") text = text.toUpperCase(); else if (t.textTransform === "lowercase") text = text.toLowerCase();
      void text;
      const spans = layout.lines.map((ln, i) => `<tspan x="${ax}" y="${(top + i * lineH + baseline).toFixed(2)}">${encode(ln.text)}</tspan>`).join("");
      return `<text id="${encode(t.name)}" font-family="${encode(t.fontFamily)}" font-size="${t.fontSize}" font-weight="${t.fontWeight}" font-style="${t.fontStyle}" fill="${t.color}" text-anchor="${anchor}"${t.letterSpacing ? ` letter-spacing="${t.letterSpacing}"` : ""}${t.underline ? ` text-decoration="underline"` : ""}${tf}${common(t, fx)}>${spans}</text>`;
    }
    return "";
  };
  const body = doc.layers.map(emit).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">\n<defs>${defs.join("")}</defs>\n${doc.background ? `<rect width="100%" height="100%" fill="${doc.background}"/>\n` : ""}${body}\n</svg>`;
}

/** A 0..1 normalised path scaled to width/height, as absolute SVG path data. */
function scalePath(d: string, w: number, h: number): string {
  let idx = 0;
  return d.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, (n) => { const v = Number(n) * (idx++ % 2 === 0 ? w : h); return v.toFixed(3); });
}

/** Rasterise one layer for SVG export: PNG data URL plus its document rect. */
export function rasterizeLayerForSvg(doc: AdDocument, layer: Layer, env: RenderEnv, toPng: (c: CanvasLike) => string): { url: string; x: number; y: number; width: number; height: number } | null {
  const c = renderLayer(doc, layer, env, 1);
  return { url: toPng(c), x: 0, y: 0, width: doc.width, height: doc.height };
}

export type { GroupLayer };
