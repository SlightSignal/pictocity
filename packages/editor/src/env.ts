import type { AdDocument, RenderEnv, CanvasLike, TextLayer, CachedLayer } from "@pictocity/core";
import { layoutText } from "@pictocity/core";

/** Optional API token (PICTOCITY_TOKEN on the server): taken from ?token= once, then kept for the session. */
export const TOKEN = (() => {
  const u = new URL(location.href); const t = u.searchParams.get("token");
  if (t) { sessionStorage.setItem("pictocity.token", t); u.searchParams.delete("token"); history.replaceState(null, "", u); }
  return sessionStorage.getItem("pictocity.token") ?? "";
})();
const _fetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (TOKEN && url.startsWith("/api/")) return _fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${TOKEN}` } });
  return _fetch(input, init);
};
/** Add the token to a URL used outside fetch (downloads, image src). */
export const withToken = (url: string) => (TOKEN ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : url);

const images = new Map<string, { src: string; img: HTMLImageElement; ready: boolean }>();
const listeners = new Set<() => void>();

export function onAssetsChanged(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }

/** Make sure every asset in the document has an <img> loading; callers re-render when one finishes. */
export function ensureAssets(doc: AdDocument) {
  for (const a of Object.values(doc.assets)) {
    const cur = images.get(a.id);
    if (cur && cur.src === a.src) continue;
    const img = new Image();
    img.crossOrigin = "anonymous";
    const entry = { src: a.src, img, ready: false };
    images.set(a.id, entry);
    img.onload = () => { entry.ready = true; listeners.forEach((f) => f()); };
    img.src = a.src;
  }
}

/** LRU-ish cache of rasterised layers so only what changed re-renders (see RenderCache in core). */
const cacheMap = new Map<string, CachedLayer>();
const CACHE_BUDGET_BYTES = 256 * 1024 * 1024; // bound by memory, not by count: one 8k layer is worth hundreds of small ones
let cacheBytes = 0;
const bytesOf = (e: CachedLayer) => e.canvas.width * e.canvas.height * 4 * (e.alpha ? 2 : 1);
export const renderCache = {
  get(key: string) { const v = cacheMap.get(key); if (v) { cacheMap.delete(key); cacheMap.set(key, v); } return v; },
  set(key: string, entry: CachedLayer) {
    const prev = cacheMap.get(key); if (prev) cacheBytes -= bytesOf(prev);
    cacheMap.set(key, entry); cacheBytes += bytesOf(entry);
    while ((cacheBytes > CACHE_BUDGET_BYTES || cacheMap.size > 400) && cacheMap.size > 1) { const first = cacheMap.keys().next().value as string; cacheBytes -= bytesOf(cacheMap.get(first)!); cacheMap.delete(first); }
  },
  clear() { cacheMap.clear(); cacheBytes = 0; },
};

export const browserEnv: RenderEnv = {
  createCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c as unknown as CanvasLike;
  },
  getImage(id) { const e = images.get(id); return e?.ready ? e.img : null; },
  createPath(d) { return new Path2D(d || undefined); },
};

const measureCanvas = document.createElement("canvas");
export const measureCtx = measureCanvas.getContext("2d")!;

/** Size a point-text layer to its content. */
export function measureText(l: TextLayer) { return layoutText(measureCtx, l); }

// ---- Fonts -------------------------------------------------------------------------

export interface FontInfo { family: string; files: string[] }

const weightOf = (file: string) => /black|heavy/i.test(file) ? 900 : /extrabold/i.test(file) ? 800 : /bold/i.test(file) ? 700 : /semibold/i.test(file) ? 600 : /medium/i.test(file) ? 500 : /light/i.test(file) ? 300 : /thin/i.test(file) ? 100 : 400;

/** Register server-hosted fonts with @font-face so the browser draws the same glyphs the exporter does. */
export let servedFamilies: string[] = [];
/** Weights available per served family, from the font file names. */
export let servedWeights: Record<string, number[]> = {};

export async function loadFonts(): Promise<string[]> {
  const list = (await fetch("/api/fonts").then((r) => r.json()).catch(() => [])) as (string | FontInfo)[];
  const families: string[] = [];
  servedFamilies = list.filter((f): f is FontInfo => typeof f !== "string").map((f) => f.family);
  servedWeights = Object.fromEntries(list.filter((f): f is FontInfo => typeof f !== "string").map((f) => [f.family, [...new Set(f.files.map(weightOf))].sort((a, b) => a - b)]));
  const loads: Promise<unknown>[] = [];
  for (const f of list) {
    if (typeof f === "string") { families.push(f); continue; }
    families.push(f.family);
    for (const file of f.files) {
      const face = new FontFace(f.family, `url(/fonts/${encodeURIComponent(file)})`, { weight: String(weightOf(file)), style: /italic|oblique/i.test(file) ? "italic" : "normal" });
      loads.push(face.load().then((ff) => document.fonts.add(ff)).catch(() => undefined));
    }
  }
  await Promise.all(loads);
  renderCache.clear(); // text may now shape differently
  return [...new Set(families)].sort();
}
