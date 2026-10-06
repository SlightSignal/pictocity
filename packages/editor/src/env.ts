import type { AdDocument, RenderEnv, CanvasLike, TextLayer, CachedLayer } from "@pictocity/core";
import { layoutText } from "@pictocity/core";
import { AssetRefresh, type AssetCheck } from "./asset-refresh";

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

const listeners = new Set<() => void>();

export function onAssetsChanged(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }

/** Synchronise references only. Preflight and changed-byte loads occur at refresh boundaries. */
export function ensureAssets(doc: AdDocument | null) { assetRefresh.syncDocument(doc); }

/** LRU-ish cache of rasterised layers so only what changed re-renders (see RenderCache in core). */
const cacheMap = new Map<string, CachedLayer>();
const CACHE_BUDGET_BYTES = 256 * 1024 * 1024; // bound by memory, not by count: one 8k layer is worth hundreds of small ones
let cacheBytes = 0;
const bytesOf = (e: CachedLayer) => e.canvas.width * e.canvas.height * 4 * (e.alpha ? 2 : 1);
export const renderCache = {
  get(key: string) { const v = cacheMap.get(key); if (v) { cacheMap.delete(key); cacheMap.set(key, v); } return v; },
  set(key: string, entry: CachedLayer) {
    const prev = cacheMap.get(key); if (prev) cacheBytes -= bytesOf(prev);
    cacheMap.delete(key);
    const bytes = bytesOf(entry);
    // Rendering may need a large temporary surface. Keeping that surface in the
    // cache is optional; one entry must not bypass the entire cache budget.
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CACHE_BUDGET_BYTES) return;
    cacheMap.set(key, entry); cacheBytes += bytes;
    while (cacheBytes > CACHE_BUDGET_BYTES || cacheMap.size > 400) { const first = cacheMap.keys().next().value as string; cacheBytes -= bytesOf(cacheMap.get(first)!); cacheMap.delete(first); }
  },
  clear() { cacheMap.clear(); cacheBytes = 0; },
};

let assetVersion = 0, mounted = 0, connected = false;
const assetRefresh = new AssetRefresh<HTMLImageElement>({
  async check(doc, signal) {
    const response = await fetch(`/api/docs/${encodeURIComponent(doc.id)}/preflight`, { signal, cache: "no-store" });
    const report = await response.json();
    if (!response.ok) throw new Error(report.error ?? "Could not check project images");
    return report as AssetCheck;
  },
  async load(doc, id, sha256, signal) {
    // The server returns only bytes matching this preflight digest, including basename aliases.
    const query = new URLSearchParams({ assetId: id, sha256, expectedRev: String(doc.rev) });
    const response = await fetch(`/api/docs/${encodeURIComponent(doc.id)}/asset-content?${query}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error ?? "Image unavailable");
    const blob = await response.blob();
    if (signal.aborted) throw new DOMException("Image refresh cancelled", "AbortError");
    const url = URL.createObjectURL(blob), img = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { signal.removeEventListener("abort", cancel); img.onload = img.onerror = null; error ? reject(error) : resolve(); };
        const cancel = () => { finish(new DOMException("Image refresh cancelled", "AbortError")); img.src = ""; };
        img.onload = () => finish(); img.onerror = () => finish(new Error("Image could not be decoded"));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel(); else img.src = url;
      });
      return img;
    } finally { URL.revokeObjectURL(url); }
  },
  dispose(img) { img.onload = img.onerror = null; img.src = ""; },
  changed(pixelsChanged) {
    // Core keys track readiness, not content. Clearing also covers masks, patterns and composites.
    if (pixelsChanged) { renderCache.clear(); assetVersion++; }
    listeners.forEach((fn) => fn());
  },
});
export const getAssetVersion = () => assetVersion;
export const assetStatus = () => assetRefresh.status();
export const refreshAssets = () => assetRefresh.refresh();
const updateAssetActivity = () => assetRefresh.setActive(mounted > 0 && connected && document.visibilityState === "visible");
export function setAssetConnection(online: boolean) { connected = online; updateAssetActivity(); }
/** Canvas ownership bounds the work; hidden/disconnected/unmounted canvases cancel it. No polling. */
export function mountAssetRefresh() {
  mounted++; updateAssetActivity();
  const visibility = () => updateAssetActivity();
  const focus = () => assetRefresh.schedule();
  document.addEventListener("visibilitychange", visibility); window.addEventListener("focus", focus);
  return () => {
    document.removeEventListener("visibilitychange", visibility); window.removeEventListener("focus", focus);
    mounted--; updateAssetActivity();
  };
}

export const browserEnv: RenderEnv = {
  createCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c as unknown as CanvasLike;
  },
  getImage(id) { return assetRefresh.getImage(id); },
  createPath(d) { return new Path2D(d || undefined); },
};

const measureCanvas = document.createElement("canvas");
export const measureCtx = measureCanvas.getContext("2d")!;

/** Size a point-text layer to its content. */
export function measureText(l: TextLayer) { return layoutText(measureCtx, l); }

// ---- Fonts -------------------------------------------------------------------------

export interface FontDescriptor { file: string; weight: number; style: "normal" | "italic" | "oblique"; stretch: string; sha256?: string; diagnostics?: string[] }
export interface FontInfo { family: string; files: string[]; faces?: FontDescriptor[] }
export let fontLoadIssues: { family: string; file: string; message: string }[] = [];
const loadedFontFaces = new Map<string, FontFace>();
let fontLoadGeneration = 0;
let lastFontFamilies: string[] = [];

/** Register server-hosted fonts with @font-face so the browser draws the same glyphs the exporter does. */
export let servedFamilies: string[] = [];
/** Weights of successfully loaded faces, from the server's embedded metadata. */
export let servedWeights: Record<string, number[]> = {};

export async function loadFonts(): Promise<string[]> {
  const generation = ++fontLoadGeneration;
  const issues: typeof fontLoadIssues = [];
  let list: (string | FontInfo)[];
  try {
    const response = await fetch("/api/fonts", { cache: "no-store" });
    if (!response.ok) throw new Error(`Font API: ${response.status}`);
    list = await response.json(); if (!Array.isArray(list)) throw new Error("Invalid font API response");
  } catch (error) {
    if (generation === fontLoadGeneration) fontLoadIssues = [{ family: "", file: "", message: (error as Error).message }];
    return [...lastFontFamilies];
  }
  const families = new Set<string>(), weights = new Map<string, Set<number>>(), nextFaces = new Map<string, FontFace>();
  const scheduled = new Set<string>();
  const loads: Promise<void>[] = [];
  for (const f of list) {
    if (typeof f === "string") { families.add(f); continue; }
    for (const file of f.files) {
      const descriptor = f.faces?.find(face => face.file === file);
      if (!descriptor || !Number.isInteger(descriptor.weight) || descriptor.weight < 1 || descriptor.weight > 1000 || !["normal", "italic", "oblique"].includes(descriptor.style) || !descriptor.stretch) {
        issues.push({ family: f.family, file, message: "Font has no valid metadata descriptor" }); continue;
      }
      const key = JSON.stringify([f.family, descriptor.sha256 ?? file, descriptor.weight, descriptor.style, descriptor.stretch]);
      // Identical bytes with different names need only one browser face.
      if (scheduled.has(key)) continue;
      scheduled.add(key);
      loads.push((async () => {
        try {
          const face = loadedFontFaces.get(key) ?? await new FontFace(JSON.stringify(f.family), `url(${JSON.stringify(withToken(`/fonts/${encodeURIComponent(file)}`))})`, { weight: String(descriptor.weight), style: descriptor.style, stretch: descriptor.stretch }).load();
          nextFaces.set(key, face); families.add(f.family);
          const available = weights.get(f.family) ?? new Set<number>(); available.add(descriptor.weight); weights.set(f.family, available);
        } catch (error) { issues.push({ family: f.family, file, message: (error as Error).message }); }
      })());
    }
  }
  await Promise.all(loads);
  if (generation !== fontLoadGeneration) return [...lastFontFamilies];
  for (const [key, face] of loadedFontFaces) if (!nextFaces.has(key)) document.fonts.delete(face);
  for (const [key, face] of nextFaces) if (!loadedFontFaces.has(key)) document.fonts.add(face);
  loadedFontFaces.clear(); for (const [key, face] of nextFaces) loadedFontFaces.set(key, face);
  servedFamilies = [...weights.keys()].sort();
  servedWeights = Object.fromEntries([...weights].map(([family, available]) => [family, [...available].sort((a, b) => a - b)]));
  fontLoadIssues = issues;
  if (issues.length) console.warn("Font loading issues", issues);
  renderCache.clear(); // text may now shape differently
  lastFontFamilies = [...families].sort();
  return [...lastFontFamilies];
}
