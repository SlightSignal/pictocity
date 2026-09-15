import { createCanvas, loadImage, Path2D, GlobalFonts, type Image, type Canvas } from "@napi-rs/canvas";
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { AdDocument, RenderEnv, CanvasLike } from "@pictocity/core";
import { renderDocument, documentAtTime, findLayer, layerBounds, isGroup, walk, deepClone } from "@pictocity/core";

const imageCache = new Map<string, { image: Image; mtime: number }>();

export interface FontInfo { family: string; files: string[] }

/** Animated GIF of the document's timeline (or a single frame when there is no animation). */
export async function renderGif(doc: AdDocument, assetsDir: string, opts: { scale?: number; fps?: number; maxColors?: number } = {}): Promise<Buffer> {
  const { GIFEncoder, quantize, applyPalette } = await gifenc();
  const images = await loadAssets(doc, assetsDir); const env = nodeEnv(images);
  const anim = doc.animation; const fps = opts.fps ?? anim?.fps ?? 12, scale = opts.scale ?? 1;
  const frames = anim ? Math.max(1, Math.round((anim.duration / 1000) * fps)) : 1;
  const gif = GIFEncoder();
  // One global palette from a spread of frames: per-frame palettes make flat colours flicker between frames.
  const rendered: Canvas[] = [];
  for (let i = 0; i < frames; i++) rendered.push(renderDocument(documentAtTime(doc, anim ? (i / fps) * 1000 : 0), env, { scale }) as unknown as Canvas);
  const sampleIdx = [...new Set([0, Math.floor(frames / 3), Math.floor((2 * frames) / 3), frames - 1])].filter((i) => i >= 0 && i < frames);
  const sample = Buffer.concat(sampleIdx.map((i) => { const c = rendered[i]; return Buffer.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data.buffer); }));
  const palette = quantize(new Uint8ClampedArray(sample.buffer, sample.byteOffset, sample.byteLength), opts.maxColors ?? 256, { format: "rgba4444" });
  for (const c of rendered) {
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    const index = applyPalette(data, palette, "rgba4444");
    gif.writeFrame(index, c.width, c.height, { palette, delay: Math.round(1000 / fps), transparent: !doc.background, repeat: anim?.loop === false ? -1 : 0 });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** Video of the timeline (MP4 H.264 or WebM VP9) via ffmpeg, optionally muxed with an audio file (e.g. a soundstudio render). */
export async function renderVideo(doc: AdDocument, assetsDir: string, opts: { format?: "mp4" | "webm"; fps?: number; scale?: number; audioPath?: string; duration?: number; crf?: number }): Promise<Buffer> {
  const { execFileSync } = await import("node:child_process"); const { mkdtempSync, readFileSync, rmSync } = await import("node:fs"); const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { throw new Error("ffmpeg is required for video export (install it and make sure it's on PATH)"); }
  const images = await loadAssets(doc, assetsDir); const env = nodeEnv(images);
  const anim = doc.animation; const fps = opts.fps ?? anim?.fps ?? 24, scale = opts.scale ?? 1;
  const duration = opts.duration ?? (anim ? anim.duration / 1000 : 5);
  const frames = Math.max(1, Math.round(duration * fps));
  const dir = mkdtempSync(join(tmpdir(), "pictocity-video-"));
  try {
    // Even dimensions are required by yuv420p. Frames are streamed to ffmpeg as raw RGBA - no PNG encode, no temp files -
    // and a layer cache means only the animated layers re-rasterise per frame, which keeps memory flat.
    let w = Math.round(doc.width * scale), h = Math.round(doc.height * scale); w -= w % 2; h -= h % 2;
    const cacheMap = new Map<string, import("@pictocity/core").CachedLayer>(); let bytes = 0;
    const cache = { get: (k: string) => cacheMap.get(k), set: (k: string, e: import("@pictocity/core").CachedLayer) => { cacheMap.set(k, e); bytes += e.canvas.width * e.canvas.height * 4; while (bytes > 256 * 1024 * 1024 && cacheMap.size > 1) { const first = cacheMap.keys().next().value as string; const old = cacheMap.get(first)!; bytes -= old.canvas.width * old.canvas.height * 4; cacheMap.delete(first); } } };
    const out = join(dir, `out.${opts.format ?? "mp4"}`);
    const args = ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-framerate", String(fps), "-i", "pipe:0"];
    if (opts.audioPath) args.push("-i", opts.audioPath);
    if ((opts.format ?? "mp4") === "webm") args.push("-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(opts.crf ?? 32), "-pix_fmt", "yuv420p"); else args.push("-c:v", "libx264", "-preset", "medium", "-crf", String(opts.crf ?? 20), "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (opts.audioPath) args.push("-c:a", (opts.format ?? "mp4") === "webm" ? "libopus" : "aac", "-b:a", "192k", "-shortest");
    args.push(out);
    const { spawn } = await import("node:child_process");
    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] }); let err = ""; ff.stderr.on("data", (d) => { err += d.toString(); });
    const done = new Promise<number>((res) => ff.on("close", res));
    const even = createCanvas(w, h); const ec = even.getContext("2d");
    for (let i = 0; i < frames; i++) {
      const c = renderDocument(documentAtTime(doc, (i / fps) * 1000), env, { scale, cache }) as unknown as Canvas;
      ec.fillStyle = doc.background ?? "#000000"; ec.fillRect(0, 0, w, h); ec.drawImage(c, 0, 0, w, h);
      const px = ec.getImageData(0, 0, w, h).data;
      if (!ff.stdin.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength))) await new Promise<void>((res) => ff.stdin.once("drain", () => res()));
    }
    ff.stdin.end();
    const code = await done;
    if (code !== 0) throw new Error(`ffmpeg failed: ${err.slice(-400)}`);
    return readFileSync(out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Self-contained HTML5 banner: static layers baked to one image, animated layers as images driven by CSS keyframes. */
export async function renderHtmlBanner(doc: AdDocument, assetsDir: string): Promise<string> {
  const images = await loadAssets(doc, assetsDir); const env = nodeEnv(images);
  const anim = doc.animation ?? { fps: 12, duration: 3000, tracks: {} };
  const animatedIds = new Set(Object.keys(anim.tracks).filter((id) => anim.tracks[id].length && findLayer(doc, id)));
  const toDataUrl = (c: Canvas) => `data:image/png;base64,${c.toBuffer("image/png").toString("base64")}`;
  // Background: everything that isn't animated, in place. Opaque canvases ship as JPEG - ad platforms have tight weight limits.
  const bg = renderDocument(doc, env, { scale: 1, hideLayerIds: [...animatedIds] }) as unknown as Canvas;
  const bgUrl = doc.background ? `data:image/jpeg;base64,${bg.toBuffer("image/jpeg", 85).toString("base64")}` : toDataUrl(bg);
  const parts: string[] = [`<div class="bg" style="background-image:url(${bgUrl})"></div>`];
  const css: string[] = [];
  let n = 0;
  for (const id of animatedIds) {
    const l = findLayer(doc, id)!; n++;
    // Draw the layer with neutral animatable props at the origin so CSS transforms can drive it.
    const neutral = deepClone(l); neutral.opacity = 1; neutral.visible = true;
    const b = layerBounds(neutral); const pad = 40;
    const fx = Math.max(0, Math.floor(b.x - pad)), fy = Math.max(0, Math.floor(b.y - pad)), fw = Math.ceil(b.width + pad * 2), fh = Math.ceil(b.height + pad * 2);
    const layerCanvas = renderDocument(doc, env, { scale: 1, onlyLayerIds: [id, ...(isGroup(l) ? [...walk(l.children)].map((w) => w.layer.id) : [])], transparent: true, region: { x: fx, y: fy, width: fw, height: fh } }) as unknown as Canvas;
    const kfs = [...anim.tracks[id]].sort((a, b2) => a.t - b2.t);
    const steps = kfs.map((k) => { const pct = ((k.t / anim.duration) * 100).toFixed(2); const dx = (k.x ?? l.x) - l.x, dy = (k.y ?? l.y) - l.y; return `${pct}% { transform: translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${((k.rotation ?? l.rotation) - l.rotation).toFixed(2)}deg) scale(${((k.scaleX ?? l.scaleX) / l.scaleX).toFixed(3)}, ${((k.scaleY ?? l.scaleY) / l.scaleY).toFixed(3)}); opacity: ${(k.visible === false ? 0 : (k.opacity ?? l.opacity)).toFixed(3)}; }`; });
    if (!kfs.some((k) => k.t === 0)) steps.unshift(steps[0].replace(/^[\d.]+%/, "0%"));
    if (!kfs.some((k) => k.t >= anim.duration)) steps.push(steps[steps.length - 1].replace(/^[\d.]+%/, "100%"));
    css.push(`@keyframes a${n} { ${steps.join(" ")} } .l${n} { left:${fx}px; top:${fy}px; width:${fw}px; height:${fh}px; transform-origin:${(b.x + b.width / 2 - fx).toFixed(1)}px ${(b.y + b.height / 2 - fy).toFixed(1)}px; animation: a${n} ${anim.duration}ms ${kfs[0]?.ease === "ease-in-out" ? "ease-in-out" : kfs[0]?.ease ?? "linear"} ${anim.loop === false ? "1 forwards" : "infinite"}; }`);
    parts.push(`<img class="layer l${n}" alt="${l.name.replace(/"/g, "")}" src="${toDataUrl(layerCanvas)}">`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="ad.size" content="width=${doc.width},height=${doc.height}"><title>${doc.name}</title>
<style>html,body{margin:0;padding:0}#banner{position:relative;width:${doc.width}px;height:${doc.height}px;overflow:hidden;background:${doc.background ?? "transparent"}}.bg{position:absolute;inset:0;background-size:100% 100%}.layer{position:absolute;display:block}
${css.join("\n")}</style></head><body><div id="banner">${parts.join("")}</div></body></html>`;
}

/** Register one font file and work out which family it provides. */
export function registerFontFile(fontsDir: string, f: string): string | null {
  if (![".ttf", ".otf", ".woff", ".woff2"].includes(extname(f).toLowerCase())) return null;
  const before = new Set(GlobalFonts.families.map((x) => x.family));
  const ok = GlobalFonts.registerFromPath(join(fontsDir, f));
  if (!ok) return null;
  const after = GlobalFonts.families.map((x) => x.family);
  // A family that already existed (e.g. Poppins-Bold after Poppins-Regular) is matched by file name prefix.
  const fresh = after.filter((x) => !before.has(x));
  return fresh[0] ?? after.find((x) => f.toLowerCase().replace(/[-_ ]/g, "").startsWith(x.toLowerCase().replace(/[-_ ]/g, ""))) ?? f.replace(/\.[^.]+$/, "");
}

/** Register every font file in the folder and remember which family each file provides. */
export function registerFonts(fontsDir: string): FontInfo[] {
  const byFamily = new Map<string, string[]>();
  try {
    for (const f of readdirSync(fontsDir).sort()) {
      const family = registerFontFile(fontsDir, f);
      if (family) byFamily.set(family, [...(byFamily.get(family) ?? []), f]);
    }
  } catch { /* no fonts dir yet */ }
  return [...byFamily].map(([family, files]) => ({ family, files }));
}

export function listFontFamilies(): string[] {
  return [...new Set(GlobalFonts.families.map((f) => f.family))].sort();
}

/** Load every image asset referenced by the document from disk, honouring file changes. */
export async function loadAssets(doc: AdDocument, assetsDir: string): Promise<Map<string, Image>> {
  const out = new Map<string, Image>();
  await Promise.all(Object.values(doc.assets).map(async (a) => {
    const file = join(assetsDir, a.src.replace(/^\/assets\//, ""));
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch { return; }
    const cached = imageCache.get(file);
    if (cached && cached.mtime === mtime) { out.set(a.id, cached.image); return; }
    try {
      const image = await loadImage(file);
      imageCache.set(file, { image, mtime });
      out.set(a.id, image);
    } catch (e) { console.warn(`asset ${a.id} failed to load: ${(e as Error).message}`); }
  }));
  return out;
}

export function nodeEnv(images: Map<string, Image>): RenderEnv {
  return {
    createCanvas: (w, h) => createCanvas(Math.max(1, w), Math.max(1, h)) as unknown as CanvasLike,
    getImage: (id) => (images.get(id) as unknown as CanvasImageSource) ?? null,
    createPath: (d) => new Path2D(d || undefined) as unknown as globalThis.Path2D,
  };
}

export type ExportFormat = "png" | "jpeg" | "webp" | "avif" | "tiff" | "bmp" | "pdf" | "png8";

type Gif = { GIFEncoder: () => { writeFrame(index: Uint8Array, w: number, h: number, o: Record<string, unknown>): void; finish(): void; bytes(): Uint8Array }; quantize: (d: Uint8ClampedArray, n: number, o: Record<string, unknown>) => number[][]; applyPalette: (d: Uint8ClampedArray, p: number[][], f: string) => Uint8Array };
async function gifenc(): Promise<Gif> { const mod = (await import("gifenc" as string)) as unknown as Gif & { default?: Gif }; return (typeof (mod as Partial<Gif>).GIFEncoder === "function" ? mod : (mod.default as Gif)) as Gif; }

export async function renderToBuffer(doc: AdDocument, assetsDir: string, opts: { scale?: number; format?: ExportFormat; quality?: number; colors?: number; dpi?: number; lossless?: boolean; onlyLayerIds?: string[]; transparent?: boolean; region?: { x: number; y: number; width: number; height: number }; rootLayerIds?: string[]; trim?: boolean } = {}): Promise<Buffer> {
  const images = await loadAssets(doc, assetsDir);
  let canvas = renderDocument(doc, nodeEnv(images), { scale: opts.scale ?? 1, onlyLayerIds: opts.onlyLayerIds, transparent: opts.transparent, region: opts.region, rootLayerIds: opts.rootLayerIds }) as unknown as Canvas;
  if (opts.trim) {
    // Crop to the non-transparent pixels (like Image > Trim).
    const ctx = canvas.getContext("2d"); const { width: w, height: h } = canvas;
    const px = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 >= x0 && y1 >= y0 && (x0 > 0 || y0 > 0 || x1 < w - 1 || y1 < h - 1)) {
      const c = createCanvas(x1 - x0 + 1, y1 - y0 + 1);
      c.getContext("2d").drawImage(canvas, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, x1 - x0 + 1, y1 - y0 + 1);
      canvas = c;
    }
  }
  const format = opts.format ?? "png";
  if (format === "png") return canvas.toBuffer("image/png");
  if (format === "jpeg") return canvas.toBuffer("image/jpeg", opts.quality ?? 90);
  if (format === "webp") return canvas.toBuffer("image/webp", opts.quality ?? 90);
  if (format === "avif") return canvas.toBuffer("image/avif", { quality: opts.quality ?? 70 });
  const { width, height } = canvas; const { data } = canvas.getContext("2d").getImageData(0, 0, width, height);
  const f = await import("./formats.js");
  if (format === "tiff") return f.encodeTiff(width, height, data);
  if (format === "bmp") return f.encodeBmp(width, height, data);
  if (format === "png8") {
    const { quantize, applyPalette } = await gifenc();
    const palette = quantize(data, opts.colors ?? 256, { format: "rgba4444" }); const index = applyPalette(data, palette, "rgba4444");
    return f.encodePng8(width, height, index, palette);
  }
  // PDF: flatten on the document background (or white); JPEG page unless lossless is requested.
  const flat = createCanvas(width, height); const fc = flat.getContext("2d"); fc.fillStyle = doc.background ?? "#ffffff"; fc.fillRect(0, 0, width, height); fc.drawImage(canvas, 0, 0);
  if (opts.lossless) { const rgb = Buffer.alloc(width * height * 3); const px = fc.getImageData(0, 0, width, height).data; for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2]; } return f.encodePdf([{ width, height, rgb }], opts.dpi ?? 72); }
  return f.encodePdf([{ width, height, jpeg: flat.toBuffer("image/jpeg", opts.quality ?? 92) }], opts.dpi ?? 72);
}
