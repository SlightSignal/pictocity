import { createCanvas, loadImage, Path2D, GlobalFonts, type Image, type Canvas } from "@napi-rs/canvas";
import { readdirSync } from "node:fs";
import { join, extname } from "node:path";
import type { AdDocument, RenderEnv, CanvasLike } from "@pictocity/core";
import { renderDocument, documentAtTime, findLayer, layerBounds, isGroup, walk, deepClone } from "@pictocity/core";
import { videoPlan, encodeFrames, yieldFrame, ExportValidationError, type VideoOptions } from "./video-export.js";

import { loadAssets } from "./assets.js";
import { inspectFontFile, inspectFontBytes, type FontInspection, type FontStyle } from "./font-metadata.js";
export { loadAssets } from "./assets.js";

export interface FontFaceInfo { file: string; weight: number; style: FontStyle; stretch: string; sha256: string; source: string; diagnostics: string[] }
export interface FontInfo { family: string; files: string[]; faces: FontFaceInfo[] }
export interface FontRegistration { registered: boolean; family: string | null; face: Omit<FontFaceInfo, "file"> | null; diagnostics: string[] }
// Cache only successful registrations of identical bytes, never filename guesses.
// Return copies so callers cannot mutate a future registration's identity.
const registeredFonts = new Map<string, FontRegistration>();
const systemFontFamilies = [...new Set(GlobalFonts.families.map(f => f.family))].sort();
const fontIssues = new Map<string, { file: string; registered: boolean; diagnostics: string[] }>();
const copyRegistration = (value: FontRegistration): FontRegistration => structuredClone(value);

function registerInspected(inspection: FontInspection, register: (family?: string) => unknown): FontRegistration {
  const cached = registeredFonts.get(inspection.sha256);
  if (cached && (!cached.family || GlobalFonts.has(cached.family))) return copyRegistration(cached);
  const before = GlobalFonts.families;
  let key: unknown;
  try { key = register(inspection.metadata?.family); }
  catch (error) { return { registered: false, family: null, face: null, diagnostics: [...inspection.diagnostics, `Native font registration failed: ${(error as Error).message}`] }; }
  if (!key) return { registered: false, family: null, face: null, diagnostics: [...inspection.diagnostics, "Native font registration failed"] };
  const metadata = inspection.metadata;
  let family = metadata?.family ?? null;
  let face: FontRegistration["face"] = metadata ? { weight: metadata.weight, style: metadata.style, stretch: metadata.stretch, sha256: inspection.sha256, source: metadata.source, diagnostics: [...metadata.diagnostics] } : null;
  const after = GlobalFonts.families;
  if (!face) {
    // Filename-independent native fallback, only when the final registration
    // adds exactly one unambiguous family/style. No temporary aliases or probes.
    const additions = after.flatMap(f => {
      const prior = before.find(b => b.family === f.family);
      return f.styles.filter(s => !prior?.styles.some(p => p.weight === s.weight && p.style === s.style && p.width === s.width)).map(s => ({ family: f.family, ...s }));
    });
    if (additions.length === 1) {
      const actual = additions[0];
      if (Number.isInteger(actual.weight) && actual.weight >= 1 && actual.weight <= 1000 && ["normal", "italic", "oblique"].includes(actual.style)) {
        family = actual.family;
        face = { weight: actual.weight, style: actual.style as FontStyle, stretch: actual.width, sha256: inspection.sha256, source: "native", diagnostics: [...inspection.diagnostics, "Descriptors recovered from unambiguous native registration"] };
      }
    }
  } else if (!after.some(f => f.family === family && f.styles.some(s => s.weight === face!.weight && s.style === face!.style && s.width === face!.stretch))) {
    // Do not advertise metadata the exporter did not actually register.
    face = null;
  }
  const result: FontRegistration = { registered: true, family: face ? family : null, face, diagnostics: face?.diagnostics ?? [...inspection.diagnostics, "Native registration succeeded, but family/style metadata is unavailable or ambiguous; no browser descriptor advertised"] };
  if (registeredFonts.size < 1024) registeredFonts.set(inspection.sha256, copyRegistration(result));
  return result;
}

/** Upload admission uses the same metadata/native path as startup, before writing. */
export function registerFontBytes(bytes: Buffer): FontRegistration {
  try { return registerInspected(inspectFontBytes(bytes), family => GlobalFonts.register(bytes, family)); }
  catch (error) { return { registered: false, family: null, face: null, diagnostics: [(error as Error).message] }; }
}
export function fontDiagnostics() { return [...fontIssues.values()].map(value => structuredClone(value)); }

/** Animated GIF of the document's timeline (or a single frame when there is no animation). */
export async function renderGif(doc: AdDocument, assetsDir: string, opts: { scale?: number; fps?: number; maxColors?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
  const fps = opts.fps ?? doc.animation?.fps ?? 12, scale = opts.scale ?? 1;
  const plan = videoPlan(doc, { fps, scale, ...(doc.animation ? {} : { duration: 1 / fps }) });
  if (fps > 50 || plan.rasterWidth > 4096 || plan.rasterHeight > 4096 || plan.frames * plan.rasterWidth * plan.rasterHeight > 500e6) throw new ExportValidationError("GIF exceeds the 50 fps, 4096-pixel side or 500-million-pixel work budget");
  const colors = opts.maxColors ?? 256;
  if (!Number.isInteger(colors) || colors < 2 || colors > 256) throw new ExportValidationError("GIF colors must be an integer from 2 to 256");
  const check = () => { if (opts.signal?.aborted) throw new Error("GIF export cancelled"); }; check();
  const { GIFEncoder, quantize, applyPalette } = await gifenc();
  const images = await loadAssets(doc, assetsDir); const env = nodeEnv(images);
  const anim = doc.animation, frames = anim ? plan.frames : 1;
  const gif = GIFEncoder();
  // One global palette from a spread of frames: per-frame palettes make flat colours flicker between frames.
  const sampleIdx = [...new Set([0, Math.floor(frames / 3), Math.floor((2 * frames) / 3), frames - 1])].filter((i) => i >= 0 && i < frames);
  // Bound palette sampling to ~1 MP total, independently of duration and output resolution.
  const sampleScale = Math.min(scale, Math.sqrt(262144 / (doc.width * doc.height)));
  const samples: Buffer[] = [];
  for (const i of sampleIdx) { check(); const c = renderDocument(documentAtTime(doc, anim ? (i / fps) * 1000 : 0), env, { scale: sampleScale }) as unknown as Canvas;
    const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; samples.push(Buffer.from(px)); await yieldFrame(); }
  const sample = Buffer.concat(samples);
  const palette = quantize(new Uint8ClampedArray(sample.buffer, sample.byteOffset, sample.byteLength), colors, { format: "rgba4444" });
  for (let i = 0; i < frames; i++) {
    check(); const c = renderDocument(documentAtTime(doc, anim ? (i / fps) * 1000 : 0), env, { scale }) as unknown as Canvas;
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    const index = applyPalette(data, palette, "rgba4444");
    // GIF stores centiseconds: distribute rounding rather than accumulating duration drift.
    const delay = (Math.round((i + 1) * 100 / fps) - Math.round(i * 100 / fps)) * 10;
    gif.writeFrame(index, c.width, c.height, { palette, delay, transparent: !doc.background, repeat: anim?.loop === false ? -1 : 0 });
    if (i % 4 === 0) await yieldFrame();
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** Video of the timeline (MP4 H.264 or WebM VP9) via ffmpeg, optionally muxed with an audio file (e.g. a soundstudio render). */
export async function renderVideo(doc: AdDocument, assetsDir: string, opts: VideoOptions = {}): Promise<Buffer> {
  const plan = videoPlan(doc, opts);
  if (opts.signal?.aborted) throw new Error("Video export cancelled");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os");
  const images = await loadAssets(doc, assetsDir); const env = nodeEnv(images);
  const { fps, frames, width: w, height: h, duration, format, crf } = plan; const scale = opts.scale ?? 1;
  const dir = mkdtempSync(join(tmpdir(), "pictocity-video-"));
  try {
    // Even dimensions are required by yuv420p. Frames are streamed to ffmpeg as raw RGBA - no PNG encode, no temp files -
    // and a layer cache means only the animated layers re-rasterise per frame, which keeps memory flat.
    const cacheMap = new Map<string, import("@pictocity/core").CachedLayer>(); let bytes = 0;
    const cache = { get: (k: string) => cacheMap.get(k), set: (k: string, e: import("@pictocity/core").CachedLayer) => { const prior = cacheMap.get(k); if (prior) bytes -= prior.canvas.width * prior.canvas.height * 4; cacheMap.set(k, e); bytes += e.canvas.width * e.canvas.height * 4; while (bytes > 256 * 1024 * 1024 && cacheMap.size > 1) { const first = cacheMap.keys().next().value as string; const old = cacheMap.get(first)!; bytes -= old.canvas.width * old.canvas.height * 4; cacheMap.delete(first); } } };
    const out = join(dir, `out.${opts.format ?? "mp4"}`);
    const args = ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-framerate", String(fps), "-i", "pipe:0"];
    if (opts.audioPath) args.push("-i", opts.audioPath);
    args.push("-map", "0:v:0");
    if (format === "webm") args.push("-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf), "-pix_fmt", "yuv420p"); else args.push("-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (opts.audioPath) args.push("-map", "1:a:0", "-af", "apad", "-c:a", format === "webm" ? "libopus" : "aac", "-b:a", "192k");
    args.push("-t", String(duration), out);
    const even = createCanvas(w, h); const ec = even.getContext("2d");
    async function* rawFrames() { for (let i = 0; i < frames; i++) {
      const c = renderDocument(documentAtTime(doc, (i / fps) * 1000), env, { scale, cache }) as unknown as Canvas;
      ec.fillStyle = doc.background ?? "#000000"; ec.fillRect(0, 0, w, h); ec.drawImage(c, 0, 0);
      const px = ec.getImageData(0, 0, w, h).data;
      yield Buffer.from(px.buffer, px.byteOffset, px.byteLength);
      opts.onProgress?.(i + 1, frames);
      if (i % 4 === 0) await yieldFrame();
    } }
    await encodeFrames(args, rawFrames(), { ...opts, timeoutMs: plan.timeoutMs });
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

function registerFontDetails(fontsDir: string, f: string): FontRegistration {
  const path = join(fontsDir, f);
  let result: FontRegistration;
  try { result = registerInspected(inspectFontFile(path), family => GlobalFonts.registerFromPath(path, family)); }
  catch (error) { result = { registered: false, family: null, face: null, diagnostics: [(error as Error).message] }; }
  if (result.diagnostics.length) fontIssues.set(path, { file: f, registered: result.registered, diagnostics: [...result.diagnostics] });
  else fontIssues.delete(path);
  return result;
}
/** Preserve the public string/null call shape; no fabricated filename families. */
export function registerFontFile(fontsDir: string, f: string): string | null {
  if (![".ttf", ".otf", ".woff", ".woff2"].includes(extname(f).toLowerCase())) return null;
  return registerFontDetails(fontsDir, f).family;
}

/** Register every font file in the folder and remember which family each file provides. */
export function registerFonts(fontsDir: string): FontInfo[] {
  const byFamily = new Map<string, FontInfo>();
  try {
    const known: string[] = [], unknown: string[] = [];
    for (const f of readdirSync(fontsDir).sort()) {
      if (![".ttf", ".otf", ".woff", ".woff2"].includes(extname(f).toLowerCase())) continue;
      try { (inspectFontFile(join(fontsDir, f)).metadata ? known : unknown).push(f); }
      catch { unknown.push(f); }
    }
    // Admit known faces first. Otherwise an unknown face sorted before its
    // known family can acquire a fallback descriptor only on a fresh process,
    // making the upload and restart catalogs disagree.
    for (const f of [...known, ...unknown]) {
      const result = registerFontDetails(fontsDir, f);
      if (!result.family || !result.face) continue;
      const info = byFamily.get(result.family) ?? { family: result.family, files: [], faces: [] };
      info.files.push(f); info.faces.push({ file: f, ...result.face }); byFamily.set(info.family, info);
    }
  } catch { /* no fonts dir yet */ }
  return [...byFamily.values()];
}

export function listFontFamilies(): string[] {
  return [...new Set(GlobalFonts.families.map((f) => f.family))].sort();
}

/** Only preexisting native families are system choices; unknown uploads aren't. */
export function listSystemFontFamilies(): string[] { return [...systemFontFamilies]; }

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
  const scale = opts.scale ?? 1, format = opts.format ?? "png";
  const width = Math.ceil((opts.region?.width ?? doc.width) * scale), height = Math.ceil((opts.region?.height ?? doc.height) * scale);
  if (!Number.isFinite(scale) || scale <= 0 || ![width, height].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 16384) || width * height > 64e6) throw new ExportValidationError("Requested raster exceeds the positive scale / 16384-side / 64 MP limit");
  if (!["png", "jpeg", "webp", "avif", "tiff", "bmp", "pdf", "png8"].includes(format)) throw new ExportValidationError("Unsupported raster format");
  if (opts.quality !== undefined && (!Number.isFinite(opts.quality) || opts.quality < 1 || opts.quality > 100)) throw new ExportValidationError("Quality must be between 1 and 100");
  if (opts.colors !== undefined && (!Number.isInteger(opts.colors) || opts.colors < 2 || opts.colors > 256)) throw new ExportValidationError("Palette colors must be an integer from 2 to 256");
  if (opts.dpi !== undefined && (!Number.isFinite(opts.dpi) || opts.dpi < 36 || opts.dpi > 2400)) throw new ExportValidationError("DPI must be between 36 and 2400");
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
  if (format === "png") return canvas.toBuffer("image/png");
  if (format === "jpeg") return canvas.toBuffer("image/jpeg", opts.quality ?? 90);
  if (format === "webp") return canvas.toBuffer("image/webp", opts.quality ?? 90);
  if (format === "avif") return canvas.toBuffer("image/avif", { quality: opts.quality ?? 70 });
  const { width: outputWidth, height: outputHeight } = canvas; const { data } = canvas.getContext("2d").getImageData(0, 0, outputWidth, outputHeight);
  const f = await import("./formats.js");
  if (format === "tiff") return f.encodeTiff(outputWidth, outputHeight, data);
  if (format === "bmp") return f.encodeBmp(outputWidth, outputHeight, data);
  if (format === "png8") {
    const { quantize, applyPalette } = await gifenc();
    const palette = quantize(data, opts.colors ?? 256, { format: "rgba4444" }); const index = applyPalette(data, palette, "rgba4444");
    return f.encodePng8(outputWidth, outputHeight, index, palette);
  }
  // PDF: flatten on the document background (or white); JPEG page unless lossless is requested.
  const flat = createCanvas(outputWidth, outputHeight); const fc = flat.getContext("2d"); fc.fillStyle = doc.background ?? "#ffffff"; fc.fillRect(0, 0, outputWidth, outputHeight); fc.drawImage(canvas, 0, 0);
  if (opts.lossless) { const rgb = Buffer.alloc(outputWidth * outputHeight * 3); const px = fc.getImageData(0, 0, outputWidth, outputHeight).data; for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2]; } return f.encodePdf([{ width: outputWidth, height: outputHeight, rgb }], opts.dpi ?? 72); }
  return f.encodePdf([{ width: outputWidth, height: outputHeight, jpeg: flat.toBuffer("image/jpeg", opts.quality ?? 92) }], opts.dpi ?? 72);
}
