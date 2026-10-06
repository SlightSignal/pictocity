import { loadImage, GlobalFonts, type Image } from "@napi-rs/canvas";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { AdDocument } from "@pictocity/core";
import { walk } from "@pictocity/core";

export interface ResourceIssue { code: string; message: string; assetId?: string; layerId?: string; font?: string }
export interface ResourceReport { ok: boolean; docId: string; revision: number; issues: ResourceIssue[]; assets: { id: string; sha256: string; width: number; height: number }[]; fonts: string[] }
export class ResourceError extends Error {
  readonly status = 422;
  constructor(readonly report: ResourceReport) { super(report.issues.map((i) => i.message).join("; ")); }
}

/** Decoded images are retained by content digest, with an actual byte budget and LRU eviction. */
export class ImageCache {
  private entries = new Map<string, { image: Image; bytes: number }>();
  private bytes = 0;
  constructor(readonly budget = 128 * 1024 * 1024) {}
  get(key: string) { const item = this.entries.get(key); if (!item) return; this.entries.delete(key); this.entries.set(key, item); return item.image; }
  set(key: string, image: Image) {
    const old = this.entries.get(key); if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    const bytes = image.width * image.height * 4;
    if (bytes > this.budget) return;
    while (this.bytes + bytes > this.budget && this.entries.size) {
      const first = this.entries.keys().next().value!; this.bytes -= this.entries.get(first)!.bytes; this.entries.delete(first);
    }
    this.entries.set(key, { image, bytes }); this.bytes += bytes;
  }
  stats() { return { entries: this.entries.size, bytes: this.bytes, budget: this.budget }; }
}
const cache = new ImageCache();
const genericFonts = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

export function assetFile(assetsDir: string, src: string): string {
  // Imported projects must use the same local assets namespace as the editor.
  const name = src.replace(/^\/?assets\//, "");
  if (!name || name === "." || name === ".." || /[\\/:\0]/.test(name)) throw new Error("Asset source must be a local /assets/filename");
  const root = realpathSync(assetsDir), file = realpathSync(resolve(root, name));
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Asset resolves outside the project library");
  return file;
}

/** Includes hidden layers, raster masks, enabled patterns and character font runs. */
export function resourceReferences(doc: AdDocument) {
  const refs = new Map<string, string[]>(), fontRefs = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, layer: string) => map.set(key, [...(map.get(key) ?? []), layer]);
  for (const { layer } of walk(doc.layers)) {
    if (layer.type === "image") add(refs, layer.assetId, layer.id);
    if (layer.type === "fill" && layer.fill.kind === "pattern") add(refs, layer.fill.assetId, layer.id);
    if (layer.mask?.kind === "raster") add(refs, layer.mask.assetId, layer.id);
    if (layer.styles?.patternOverlay?.enabled) add(refs, layer.styles.patternOverlay.assetId, layer.id);
    if (layer.type === "text" && layer.text) {
      add(fontRefs, layer.fontFamily, layer.id);
      for (const run of layer.runs ?? []) if (run.fontFamily) add(fontRefs, run.fontFamily, layer.id);
    }
  }
  return { refs, fontRefs };
}

/** Check ALL layer dependencies, including masks, effects, hidden layers and character font runs. */
export async function inspectResources(doc: AdDocument, assetsDir: string) {
  const report: ResourceReport = { ok: true, docId: doc.id, revision: doc.rev, issues: [], assets: [], fonts: [] };
  const { refs, fontRefs } = resourceReferences(doc);
  const families = new Set(GlobalFonts.families.map((f) => f.family.toLowerCase()));
  for (const [font, layers] of fontRefs) {
    report.fonts.push(font);
    // A fallback stack is valid if at least one requested family exists; report exact missing single families.
    const available = font.split(",").map((f) => f.trim().replace(/^['"]|['"]$/g, "").toLowerCase()).some((f) => families.has(f) || genericFonts.has(f));
    if (!available) report.issues.push({ code: "missing_font", font, layerId: layers[0], message: `Font “${font}” is unavailable (layer ${layers[0]}). Add that font or choose an available family.` });
  }
  const images = new Map<string, Image>(); let workingBytes = 0;
  // Sequential decode prevents a document from creating hundreds of concurrent native image allocations.
  for (const [id, layers] of refs) {
    const asset = doc.assets[id];
    if (!asset) { report.issues.push({ code: "missing_asset_record", assetId: id, layerId: layers[0], message: `Image ${id} has no asset record (layer ${layers[0]}).` }); continue; }
    try {
      const file = assetFile(assetsDir, asset.src);
      const size = statSync(file).size;
      if (size > 64 * 1024 * 1024) throw new Error("Compressed image exceeds 64 MiB");
      const bytes = readFileSync(file);
      const digest = createHash("sha256").update(bytes).digest("hex");
      let image = cache.get(digest);
      if (!image) { image = await loadImage(bytes); if (image.width > 16384 || image.height > 16384 || image.width * image.height > 64e6) throw new Error("Decoded image exceeds the 16384-side / 64 MP limit"); cache.set(digest, image); }
      workingBytes += image.width * image.height * 4;
      if (workingBytes > 256 * 1024 * 1024) throw new Error("Project images exceed the 256 MiB decoded working budget");
      images.set(id, image); report.assets.push({ id, sha256: digest, width: image.width, height: image.height });
    } catch (error) { report.issues.push({ code: "unreadable_asset", assetId: id, layerId: layers[0], message: `Image “${asset.name ?? id}” cannot be used: ${(error as Error).message}` }); }
  }
  report.ok = !report.issues.length;
  return { report, images };
}

export async function loadAssets(doc: AdDocument, assetsDir: string): Promise<Map<string, Image>> {
  const { report, images } = await inspectResources(doc, assetsDir);
  if (!report.ok) throw new ResourceError(report);
  return images;
}
