// Platform spec checks for finished ads: the things that get creatives rejected or make them unreadable in the feed.
import type { AdDocument, Layer, TextLayer, GroupLayer } from "./types.js";
import { walk, layerBounds, isGroup, artboards } from "./document.js";

export interface PlatformSpec {
  name: string;
  /** Accepted sizes (w×h) or aspect ratios; empty = any. */
  sizes?: { width: number; height: number }[];
  aspects?: { w: number; h: number; tolerance?: number }[];
  /** Areas the platform's UI covers, as fractions of the frame (top/bottom bars, right-hand icon rail). */
  safe: { top: number; bottom: number; left: number; right: number };
  maxTextCoverage: number;       // fraction of the frame covered by text boxes before it's "too much text"
  minFontPx: number;             // at export size, below this body text is illegible on phones
  maxBytes?: Record<string, number>; // per format
  notes?: string;
}

export const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  "meta-feed": { name: "Meta feed (Instagram / Facebook)", aspects: [{ w: 1, h: 1 }, { w: 4, h: 5 }, { w: 1.91, h: 1 }], safe: { top: 0.06, bottom: 0.08, left: 0.04, right: 0.04 }, maxTextCoverage: 0.2, minFontPx: 24, maxBytes: { jpg: 30 * 1024 * 1024, png: 30 * 1024 * 1024 }, notes: "Keep text under ~20 % of the image; 4:5 gets the most feed space." },
  "meta-story": { name: "Meta / TikTok / Snapchat stories & reels (9:16)", aspects: [{ w: 9, h: 16 }], safe: { top: 0.14, bottom: 0.20, left: 0.05, right: 0.14 }, maxTextCoverage: 0.25, minFontPx: 28, maxBytes: { jpg: 30 * 1024 * 1024, png: 30 * 1024 * 1024 }, notes: "Top 14 % (profile/progress) and bottom 20 % (caption, CTA) are covered by UI; right 14 % holds the icon rail on TikTok/Reels." },
  "google-display": { name: "Google Display (HTML5 / image)", sizes: [{ width: 300, height: 250 }, { width: 336, height: 280 }, { width: 728, height: 90 }, { width: 970, height: 250 }, { width: 970, height: 90 }, { width: 300, height: 600 }, { width: 160, height: 600 }, { width: 120, height: 600 }, { width: 250, height: 250 }, { width: 200, height: 200 }, { width: 320, height: 50 }, { width: 320, height: 100 }, { width: 320, height: 480 }, { width: 480, height: 320 }], safe: { top: 0, bottom: 0, left: 0, right: 0 }, maxTextCoverage: 0.6, minFontPx: 11, maxBytes: { png: 150 * 1024, jpg: 150 * 1024, gif: 150 * 1024, html: 150 * 1024 }, notes: "150 KB per asset; visible border or non-white background recommended; one CTA." },
  "youtube-thumbnail": { name: "YouTube thumbnail", sizes: [{ width: 1280, height: 720 }], aspects: [{ w: 16, h: 9 }], safe: { top: 0, bottom: 0.12, left: 0, right: 0.18 }, maxTextCoverage: 0.35, minFontPx: 40, maxBytes: { jpg: 2 * 1024 * 1024, png: 2 * 1024 * 1024 }, notes: "Bottom-right corner shows the duration badge." },
  "linkedin": { name: "LinkedIn sponsored content", aspects: [{ w: 1.91, h: 1 }, { w: 1, h: 1 }, { w: 4, h: 5 }], safe: { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 }, maxTextCoverage: 0.3, minFontPx: 22, maxBytes: { jpg: 5 * 1024 * 1024, png: 5 * 1024 * 1024 } },
  "x": { name: "X (Twitter) image", aspects: [{ w: 16, h: 9 }, { w: 1, h: 1 }], safe: { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 }, maxTextCoverage: 0.3, minFontPx: 22, maxBytes: { jpg: 5 * 1024 * 1024, png: 5 * 1024 * 1024, gif: 15 * 1024 * 1024 } },
  "pinterest": { name: "Pinterest pin", aspects: [{ w: 2, h: 3 }, { w: 1, h: 1 }], safe: { top: 0.04, bottom: 0.1, left: 0.04, right: 0.04 }, maxTextCoverage: 0.3, minFontPx: 24, maxBytes: { jpg: 20 * 1024 * 1024, png: 20 * 1024 * 1024 } },
  print: { name: "Print (300 dpi)", safe: { top: 0.03, bottom: 0.03, left: 0.03, right: 0.03 }, maxTextCoverage: 1, minFontPx: 25, notes: "3 % safe margin ≈ 3 mm bleed on A4; minFont 25 px ≈ 6 pt at 300 dpi." },
};

export interface SpecIssue { severity: "error" | "warning" | "info"; code: string; message: string; layerId?: string; layerName?: string }

const rel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const luminance = (hex: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return null; const n = parseInt(m[1], 16); return 0.2126 * rel((n >> 16) & 255) + 0.7152 * rel((n >> 8) & 255) + 0.0722 * rel(n & 255); };
export const contrastRatio = (a: string, b: string) => { const la = luminance(a), lb = luminance(b); if (la === null || lb === null) return null; const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };

/**
 * Check a document (or one artboard) against a platform. `frameBg` may be supplied by the caller (sampled from a render)
 * for contrast checks; otherwise the document background and any full-frame solid fill are used.
 */
export function checkSpec(doc: AdDocument, platform: string, opts: { artboardId?: string; exportBytes?: Record<string, number>; frameBg?: string } = {}): { platform: PlatformSpec; issues: SpecIssue[]; score: number } {
  const spec = PLATFORM_SPECS[platform];
  if (!spec) throw new Error(`unknown platform ${platform}; one of ${Object.keys(PLATFORM_SPECS).join(", ")}`);
  const issues: SpecIssue[] = [];
  const ab = opts.artboardId ? (artboards(doc).find((a) => a.id === opts.artboardId) as GroupLayer | undefined) : undefined;
  const frame = ab ? { x: ab.x, y: ab.y, width: ab.width, height: ab.height } : { x: 0, y: 0, width: doc.width, height: doc.height };
  const layers: Layer[] = ab ? [...walk(ab.children)].map((w) => w.layer) : [...walk(doc.layers)].map((w) => w.layer).filter((l) => !isGroup(l) || !l.artboard);
  // size / aspect
  if (spec.sizes && !spec.sizes.some((s) => s.width === frame.width && s.height === frame.height)) issues.push({ severity: "error", code: "size", message: `${frame.width}×${frame.height} isn't an accepted size (${spec.sizes.map((s) => `${s.width}×${s.height}`).join(", ")})` });
  if (spec.aspects && !spec.aspects.some((a) => Math.abs(frame.width / frame.height - a.w / a.h) <= (a.tolerance ?? 0.02))) issues.push({ severity: "error", code: "aspect", message: `aspect ${(frame.width / frame.height).toFixed(3)} isn't one of ${spec.aspects.map((a) => `${a.w}:${a.h}`).join(", ")}` });
  // safe zones: text and CTA-like layers must sit inside
  const safeBox = { x: frame.x + frame.width * spec.safe.left, y: frame.y + frame.height * spec.safe.top, x2: frame.x + frame.width * (1 - spec.safe.right), y2: frame.y + frame.height * (1 - spec.safe.bottom) };
  let textArea = 0;
  for (const l of layers) {
    if (!l.visible || isGroup(l)) continue;
    const b = layerBounds(l); const inFrame = b.x < frame.x + frame.width && b.x + b.width > frame.x && b.y < frame.y + frame.height && b.y + b.height > frame.y;
    if (!inFrame) continue;
    const important = l.type === "text" || (l.tags ?? []).some((t) => /cta|logo|button|headline|price|legal/i.test(t)) || /cta|logo|button/i.test(l.name);
    if (important && (b.x < safeBox.x - 1 || b.y < safeBox.y - 1 || b.x + b.width > safeBox.x2 + 1 || b.y + b.height > safeBox.y2 + 1)) issues.push({ severity: "warning", code: "safe-zone", message: `"${l.name}" extends into the platform UI area (safe zone: ${Math.round(spec.safe.top * 100)}% top, ${Math.round(spec.safe.bottom * 100)}% bottom, ${Math.round(spec.safe.left * 100)}%/${Math.round(spec.safe.right * 100)}% sides)`, layerId: l.id, layerName: l.name });
    if (l.type === "text") {
      const t = l as TextLayer; const ex = Math.max(0, Math.min(b.x + b.width, frame.x + frame.width) - Math.max(b.x, frame.x)), ey = Math.max(0, Math.min(b.y + b.height, frame.y + frame.height) - Math.max(b.y, frame.y)); textArea += ex * ey;
      const effectivePx = t.fontSize * Math.abs(t.scaleY) * (t.textScaleY ?? 1);
      if (effectivePx < spec.minFontPx && !/legal|disclaimer|footnote/i.test(t.name + (t.tags ?? []).join())) issues.push({ severity: effectivePx < spec.minFontPx * 0.7 ? "error" : "warning", code: "font-size", message: `"${t.name}" is ${Math.round(effectivePx)} px; ${spec.minFontPx} px is the floor for legibility on ${spec.name}`, layerId: t.id, layerName: t.name });
      const bg = opts.frameBg ?? backgroundBehind(doc, layers, t, frame);
      if (bg) { const cr = contrastRatio(t.color, bg); if (cr !== null && cr < 3) issues.push({ severity: cr < 2 ? "error" : "warning", code: "contrast", message: `"${t.name}" ${t.color} on ${bg}: contrast ${cr.toFixed(1)}:1 (aim ≥ 4.5:1 for body, ≥ 3:1 for large headlines)`, layerId: t.id, layerName: t.name }); }
      if (t.text.trim().length > 140 && spec.maxTextCoverage < 0.5) issues.push({ severity: "info", code: "copy-length", message: `"${t.name}" has ${t.text.trim().length} characters; feed ads read better under ~90`, layerId: t.id, layerName: t.name });
    }
  }
  const coverage = textArea / (frame.width * frame.height);
  if (coverage > spec.maxTextCoverage) issues.push({ severity: "warning", code: "text-coverage", message: `text covers ${Math.round(coverage * 100)} % of the frame; ${spec.name} performs best under ${Math.round(spec.maxTextCoverage * 100)} %` });
  const hasCta = layers.some((l) => /cta|button|shop|order|learn|sign|buy/i.test(l.name + (l.tags ?? []).join() + (l.type === "text" ? " " + (l as TextLayer).text : "")));
  if (!hasCta && platform !== "print") issues.push({ severity: "info", code: "cta", message: "no layer looks like a call to action (name or tag it 'cta')" });
  if (opts.exportBytes && spec.maxBytes) for (const [fmt, bytes] of Object.entries(opts.exportBytes)) { const max = spec.maxBytes[fmt]; if (max && bytes > max) issues.push({ severity: "error", code: "weight", message: `${fmt} export is ${(bytes / 1024).toFixed(0)} KB; ${spec.name} allows ${(max / 1024).toFixed(0)} KB` }); }
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + (i.severity === "error" ? 25 : i.severity === "warning" ? 10 : 3), 0));
  return { platform: spec, issues, score };
}

/** Best guess of the colour behind a text layer: the nearest full-frame solid fill/shape below it, else the document background. */
function backgroundBehind(doc: AdDocument, layers: Layer[], t: TextLayer, frame: { x: number; y: number; width: number; height: number }): string | null {
  const idx = layers.indexOf(t);
  for (let i = idx - 1; i >= 0; i--) {
    const l = layers[i]; if (!l.visible) continue;
    const b = layerBounds(l); const covers = b.x <= t.x && b.y <= t.y && b.x + b.width >= t.x + t.width && b.y + b.height >= t.y + t.height;
    if (!covers) continue;
    if (l.type === "fill" && l.fill.kind === "solid") return l.fill.color;
    if (l.type === "shape" && l.fill && /^#[0-9a-f]{6}$/i.test(l.fill) && l.opacity >= 0.9) return l.fill;
    if (l.type === "image" || (l.type === "fill" && l.fill.kind !== "solid")) return null; // photo or gradient: can't judge from data
  }
  void frame;
  return doc.background && /^#[0-9a-f]{6}$/i.test(doc.background) ? doc.background : null;
}
