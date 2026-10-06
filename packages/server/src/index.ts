import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, createReadStream, readdirSync, unlinkSync } from "node:fs";
import { join, extname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { loadImage } from "@napi-rs/canvas";
import type { AdDocument, Asset, ClientMessage, OpEnvelope, ServerMessage } from "@pictocity/core";
import { AD_PRESETS, DEFAULT_STYLE_PRESETS, OpError, uid, nowIso, applyOps, deepClone, normalizeLayer, checkSpec, resizeLayoutOps, clampDimension, cloneWithNewIds, artboards, findLayer, isGroup, walk, layerBounds, applyCompOps, documentToSvg, rasterizeLayerForSvg, svgToLayers, createDocument, makeGroup } from "@pictocity/core";
import { loadAssets, nodeEnv } from "./node-env.js";
import type { Canvas } from "@napi-rs/canvas";
import { DocStore, RevisionConflict } from "./store.js";
import { atomicWrite } from "./atomic-file.js";
import { acquireDataOwnership, DataOwnershipError } from "./data-ownership.js";
import { registerFonts, registerFontBytes, fontDiagnostics, listFontFamilies, listSystemFontFamilies, type ExportFormat } from "./node-env.js";
import { renderToBuffer, renderGif, renderHtmlBanner, renderVideo, docToPsd, renderSvg, preflightDocument, configureRenderService, renderContext } from "./render-service.js";
import { psdToDoc } from "./psd.js";
import { assetFile } from "./assets.js";
import { resourceSnapshotContext } from "./resource-snapshot.js";
import { afterExportCleanup, exportResponse } from "./export-response.js";
import { ExportSetService, EXPORT_SET_LIMITS } from "./export-set.js";
import { loadImageTools, listImageTools, runImageTool } from "./image-tools.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const ROOT = resolve(here, "../../..");
export const PORT = Number(process.env.PICTOCITY_PORT ?? 4100);
const DATA = process.env.PICTOCITY_DATA ?? join(ROOT, "data");
const dataOwnership = await acquireDataOwnership(DATA).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof DataOwnershipError ? error.exitCode : 74);
});
// A docs subdirectory may itself be a junction/shared directory. Owning only
// the parent spelling would admit two stores over the same physical journals.
const documentOwnership = await acquireDataOwnership(join(DATA, "docs")).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof DataOwnershipError ? error.exitCode : 74);
});
const ASSETS = join(DATA, "assets");
const EXPORTS = join(DATA, "exports");
const FONTS = process.env.PICTOCITY_FONTS ?? join(DATA, "fonts");
const EDITOR_DIST = join(ROOT, "packages/editor/dist");
for (const d of [ASSETS, EXPORTS, join(DATA, "docs")]) mkdirSync(d, { recursive: true });

mkdirSync(FONTS, { recursive: true });
const bundledFonts = process.env.PICTOCITY_BUNDLED_FONTS ?? join(ROOT, "fonts");
if (existsSync(bundledFonts) && resolve(bundledFonts) !== resolve(FONTS)) for (const f of readdirSync(bundledFonts)) {
  if (![".ttf", ".otf", ".woff", ".woff2"].includes(extname(f).toLowerCase())) continue;
  const target = join(FONTS, f); if (!existsSync(target)) atomicWrite(target, readFileSync(join(bundledFonts, f)));
}
let served = registerFonts(FONTS);
console.log(`fonts: ${served.map((f) => f.family).join(", ") || "none"} served from ${FONTS}; ${listFontFamilies().length} families available to the renderer`);

const TOKEN = process.env.PICTOCITY_TOKEN ?? "";
if (TOKEN) console.log("auth: bearer token required for /api and /ws");

const store = new DocStore(join(DATA, "docs"));
const renderer = configureRenderService(FONTS);
const exportSets = new ExportSetService();
const imageTools = loadImageTools(process.env.PICTOCITY_IMAGE_TOOLS ?? join(ROOT, "image-tools.json"));
console.log(`image tools: ${imageTools.map((t) => t.name).join(", ")}`);

// ---- Helpers ----------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".gif": "image/gif", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon", ".psd": "image/vnd.adobe.photoshop",
};

function json(res: ServerResponse, status: number, body: unknown) {
  const resources = resourceSnapshotContext.getStore()?.report;
  if (resources && body && typeof body === "object" && !Array.isArray(body)) body = { ...body, resourceSnapshot: resources };
  exportResponse(res).writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  exportResponse(res).end(JSON.stringify(body));
}

const MAX_BODY = Number(process.env.PICTOCITY_MAX_BODY_MB ?? 200) * 1024 * 1024;
/** Largest raster we'll produce: caps memory for renders and exports (a side of 16384 px or ~64 MP, whichever first). */
const MAX_RENDER_SIDE = 16384, MAX_RENDER_PIXELS = 64e6;
let assetContentActive = 0;
function clampScale(doc: { width: number; height: number }, requested: unknown, region?: { width: number; height: number } | null): number {
  const s = Number(requested);
  if (!Number.isFinite(s) || s <= 0) throw Object.assign(new Error("Scale must be positive and finite"), { status: 400 });
  const w = region?.width ?? doc.width, h = region?.height ?? doc.height;
  if (Math.ceil(w * s) > MAX_RENDER_SIDE || Math.ceil(h * s) > MAX_RENDER_SIDE || Math.ceil(w * s) * Math.ceil(h * s) > MAX_RENDER_PIXELS) throw Object.assign(new Error("Requested export exceeds the 16384-side / 64 MP limit. Reduce scale."), { status: 400 });
  return s;
}
const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt; };
const EXPORT_FORMATS = new Set(["png", "png8", "jpg", "jpeg", "webp", "avif", "gif", "tif", "tiff", "bmp", "pdf", "svg", "psd", "html", "mp4", "webm"]);

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const pre = (req as unknown as { _body?: string })._body; if (pre !== undefined) return Buffer.from(pre);
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw Object.assign(new Error(`request body over ${MAX_BODY / 1048576} MB`), { status: 413 }); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}

function serveFile(res: ServerResponse, file: string, cache = "no-cache") {
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "access-control-allow-origin": "*", "cache-control": cache });
  createReadStream(file).pipe(res);
}

async function storeAsset(doc: AdDocument, name: string, bytes: Buffer, mime: string): Promise<Asset> {
  if (bytes.length > 64 * 1024 * 1024) throw Object.assign(new Error("Image exceeds the 64 MiB compressed limit"), { status: 413 });
  const img = await loadImage(bytes);
  if (img.width > 16384 || img.height > 16384 || img.width * img.height > 64e6) throw Object.assign(new Error("Image exceeds the 16384-side / 64 MP decoded limit"), { status: 413 });
  const ext = extname(name) || (mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : ".jpg");
  const id = uid("a");
  const file = `${id}${ext}`;
  atomicWrite(join(ASSETS, file), bytes);
  const asset: Asset = { id, name: basename(name), src: `/assets/${file}`, width: img.width, height: img.height, mime };
  store.apply({ docId: doc.id, ops: [{ type: "asset.add", asset }], actor: "server", label: `Import ${asset.name}` });
  return asset;
}

/** Region/root options for rendering one artboard; null = whole document; false = unknown artboard id. */
function artboardOpts(doc: AdDocument, ref: string | null | undefined): { region: { x: number; y: number; width: number; height: number }; rootLayerIds: string[] } | null | false {
  if (!ref) return null;
  const a = findLayer(doc, ref) ?? artboards(doc).find((b) => b.name.toLowerCase() === ref.toLowerCase());
  if (!a || !isGroup(a) || !a.artboard) return false;
  return { region: { x: a.x, y: a.y, width: a.width, height: a.height }, rootLayerIds: [a.id] };
}

// ---- REST -------------------------------------------------------------------------

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const method = req.method ?? "GET";
  const p1 = parts[1], id = parts[2], sub = parts[3];

  if (p1 === "health") { const persistence = store.persistence(); return json(res, persistence.ok ? 200 : 503, { ok: persistence.ok, app: "Pictocity", version: VERSION, persistence, dataOwnership: { ...dataOwnership, documentsOwned: documentOwnership.acquired }, renderer: renderer.status(), exportSets: exportSets.status(), docs: store.list().length, rev: 0, paths: { data: DATA, exports: EXPORTS, assets: ASSETS, fonts: FONTS } }); }
  if (p1 === "render-status" && method === "GET") return json(res, 200, { ...renderer.status(), exportSets: exportSets.status() });
  if (p1 === "presets") return json(res, 200, AD_PRESETS);
  if (p1 === "image-tools") return json(res, 200, listImageTools());
  if (p1 === "assets" && method === "GET") {
    // Every asset file with the documents that use it.
    const used = new Map<string, string[]>();
    for (const d of store.all()) for (const a of Object.values(d.assets)) used.set(basename(a.src), [...(used.get(basename(a.src)) ?? []), d.id]);
    const files = readdirSync(ASSETS).map((f) => ({ file: f, bytes: statSync(join(ASSETS, f)).size, usedBy: used.get(f) ?? [] }));
    return json(res, 200, files);
  }
  if (p1 === "assets" && method === "POST" && url.searchParams.get("gc") !== null) {
    const used = new Set<string>();
    for (const d of store.all()) for (const a of Object.values(d.assets)) used.add(basename(a.src));
    let removed = 0, bytes = 0;
    for (const f of readdirSync(ASSETS)) if (!used.has(f)) { bytes += statSync(join(ASSETS, f)).size; unlinkSync(join(ASSETS, f)); removed++; }
    return json(res, 200, { removed, bytes });
  }
  if (p1 === "exports" && method === "GET") {
    const files = readdirSync(EXPORTS).filter((f) => !f.startsWith(".pictocity-export-set") && statSync(join(EXPORTS, f)).isFile()).map((f) => { const st = statSync(join(EXPORTS, f)); return { file: f, bytes: st.size, mtime: st.mtimeMs, url: `/exports/${encodeURIComponent(f)}` }; }).sort((a, b) => b.mtime - a.mtime);
    return json(res, 200, files);
  }
  if (p1 === "docs" && id === "import-package" && method === "POST") {
    // A portable .pictocity file: {doc, assets: {id: base64}} — restores the document with its images on this server.
    const body = JSON.parse((await readBody(req)).toString()) as { doc: AdDocument; assets: Record<string, string> };
    if (!body.doc || !Array.isArray(body.doc.layers)) return json(res, 400, { error: "Package must contain a document with layers" });
    const doc = deepClone(body.doc); doc.id = uid("doc"); doc.rev = 0; doc.updatedAt = nowIso();
    doc.assets ??= {};
    // A package never overwrites another document's image, even if its original filenames collide.
    for (const [aid, b64] of Object.entries(body.assets ?? {})) { const a = doc.assets[aid]; if (!a) continue; const file = `${uid("a")}${extname(basename(a.src)) || ".png"}`; atomicWrite(join(ASSETS, file), Buffer.from(b64, "base64")); a.src = `/assets/${file}`; }
    store.put(doc);
    return json(res, 201, { id: doc.id, name: doc.name });
  }
  if (p1 === "brand") {
    // Brand kit shared by every document and the agent: colours, fonts, logo, voice rules, audio identity.
    const file = join(DATA, "brand.json");
    if (method === "GET") return json(res, 200, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { name: "", colors: [], fonts: [], logoAssetSrc: null, voice: "", rules: [], audio: { targetLufs: -14, sonicLogoAssetSrc: null } });
    const body = JSON.parse((await readBody(req)).toString() || "{}"); atomicWrite(file, JSON.stringify(body, null, 1)); return json(res, 200, body);
  }
  if (p1 === "style-presets") {
    const file = join(DATA, "style-presets.json");
    if (method === "GET") return json(res, 200, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : DEFAULT_STYLE_PRESETS);
    const body = JSON.parse((await readBody(req)).toString() || "[]");
    atomicWrite(file, JSON.stringify(body, null, 1));
    return json(res, 200, body);
  }
  if (p1 === "fonts" && method === "POST") {
    // Install a font: raw .ttf/.otf body with x-filename, or JSON {path} / {url}. Registered immediately for both renderers.
    const ct = req.headers["content-type"] ?? "";
    let bytes: Buffer, name: string;
    if (ct.startsWith("application/json")) {
      const body = JSON.parse((await readBody(req)).toString());
      if (body.path) { bytes = readFileSync(body.path); name = basename(body.path); }
      else if (body.url) { const r = await fetch(body.url); if (!r.ok) return json(res, 400, { error: `fetch ${body.url}: ${r.status}` }); bytes = Buffer.from(await r.arrayBuffer()); name = body.name ?? basename(new URL(body.url).pathname); }
      else return json(res, 400, { error: "provide path or url" });
    } else { bytes = await readBody(req); name = decodeURIComponent(String(req.headers["x-filename"] ?? "font.ttf")); }
    name = basename(name).replace(/[^\w.-]+/g, "_");
    if (![".ttf", ".otf", ".woff", ".woff2"].includes(extname(name).toLowerCase())) return json(res, 400, { error: "font must be .ttf, .otf, .woff or .woff2" });
    if (existsSync(join(FONTS, name)) && !readFileSync(join(FONTS, name)).equals(bytes)) return json(res, 409, { error: "A different font already uses this filename. Choose a new filename to preserve existing projects." });
    const registration = registerFontBytes(bytes);
    if (!registration.registered) return json(res, 400, { error: "could not register that font file", diagnostics: registration.diagnostics });
    atomicWrite(join(FONTS, name), bytes);
    served = registerFonts(FONTS);
    return json(res, registration.family ? 201 : 422, { family: registration.family, file: name, face: registration.face, diagnostics: registration.diagnostics, ...(!registration.family ? { error: "Font bytes retained, but embedded family/style is unavailable or ambiguous" } : {}) });
  }
  if (p1 === "fonts") {
    if (url.searchParams.has("diagnostics")) return json(res, 200, fontDiagnostics());
    // Served fonts come with their files (the editor registers them via @font-face); system fonts are names only.
    const servedNames = new Set(served.map((f) => f.family));
    return json(res, 200, [...served, ...listSystemFontFamilies().filter((f) => !servedNames.has(f))]);
  }

  if (p1 === "docs" && !id) {
    if (method === "GET") return json(res, 200, store.list());
    if (method === "POST") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const dims = body.document ?? body;
      for (const k of ["width", "height"]) { const v = dims[k]; if (v !== undefined && (!Number.isFinite(Number(v)) || Number(v) < 1 || Number(v) > 8192)) return json(res, 400, { error: `${k} must be between 1 and 8192` }); }
      if (body.document) {
        const d = body.document as AdDocument;
        if (!Array.isArray(d.layers)) return json(res, 400, { error: "document.layers must be an array" });
        if (store.get(d.id)) { d.id = uid("doc"); d.rev = 0; d.updatedAt = nowIso(); }
        d.layers = d.layers.map((l) => normalizeLayer(l)); d.assets = d.assets ?? {}; d.guides = Array.isArray(d.guides) ? d.guides : [];
        store.put(d); return json(res, 201, d);
      }
      return json(res, 201, store.create(body));
    }
  }

  if (p1 === "docs" && id === "import-svg" && method === "POST") {
    // SVG bytes with x-filename, or JSON {path|url|svg, name, docId}. With docId the layers are placed into that document as a group.
    const ct = req.headers["content-type"] ?? "";
    const raw = await readBody(req);
    let text = raw.toString("utf8"), name = decodeURIComponent(String(req.headers["x-filename"] ?? "Imported.svg")), targetId: string | undefined;
    if (ct.startsWith("application/json")) {
      const body = JSON.parse(raw.toString());
      if (body.svg) text = body.svg; else if (body.path) { text = readFileSync(body.path, "utf8"); name = basename(body.path); } else if (body.url) { const r = await fetch(body.url); if (!r.ok) return json(res, 400, { error: `fetch ${body.url}: ${r.status}` }); text = await r.text(); name = body.name ?? basename(new URL(body.url).pathname); }
      else return json(res, 400, { error: "provide svg, path or url" });
      if (body.name) name = body.name; targetId = body.docId;
    }
    try {
      const parsed = svgToLayers(text);
      if (targetId) {
        const target = store.get(targetId); if (!target) return json(res, 404, { error: "document not found" });
        const group = makeGroup({ name: name.replace(/\.svg$/i, ""), children: parsed.layers, x: 0, y: 0, width: parsed.width, height: parsed.height });
        const applied = store.apply({ docId: target.id, ops: [{ type: "layer.add", layer: group, parentId: null, index: target.layers.length }], actor: "server", label: `Place ${name}` });
        return json(res, 201, { id: target.id, groupId: group.id, layers: parsed.layers.length, rev: applied.rev });
      }
      const doc = createDocument({ name: name.replace(/\.svg$/i, ""), width: clampDimension(parsed.width, 1000), height: clampDimension(parsed.height, 1000), background: null });
      doc.layers = parsed.layers; store.put(doc);
      return json(res, 201, { id: doc.id, name: doc.name, width: doc.width, height: doc.height, layers: doc.layers.length });
    } catch (e) { return json(res, 400, { error: `SVG import failed: ${(e as Error).message}` }); }
  }

  if (p1 === "docs" && id === "import-psd" && method === "POST") {
    // Body is either the PSD bytes (name in x-filename) or JSON {path, name}.
    const ct = req.headers["content-type"] ?? "";
    const raw = await readBody(req);
    let bytes = raw, name = decodeURIComponent(String(req.headers["x-filename"] ?? "Imported.psd"));
    if (ct.startsWith("application/json")) {
      const body = JSON.parse(raw.toString());
      if (!body.path) return json(res, 400, { error: "provide path" });
      bytes = readFileSync(body.path); name = body.name ?? basename(body.path);
    }
    try { const doc = psdToDoc(bytes, name, ASSETS); store.put(doc); return json(res, 201, { id: doc.id, name: doc.name, width: doc.width, height: doc.height, layers: doc.layers.length }); }
    catch (e) { return json(res, 400, { error: `PSD import failed: ${(e as Error).message}` }); }
  }

  if (p1 === "docs" && id) {
    const stored = store.get(id);
    if (!stored) return json(res, 404, { error: `document ${id} not found` });
    let doc: AdDocument = stored;

    if (sub === "preflight" && method === "GET") return json(res, 200, await preflightDocument(doc, ASSETS));

    // Editor refresh boundary: serve exactly the content checked by preflight, without a snapshot.
    if (sub === "asset-content" && method === "GET") {
      const asset = doc.assets[url.searchParams.get("assetId") ?? ""], digest = url.searchParams.get("sha256") ?? "";
      if (!/^[a-f0-9]{64}$/.test(digest)) return json(res, 400, { error: "A checked image SHA-256 is required" });
      if (Number(url.searchParams.get("expectedRev")) !== doc.rev || !url.searchParams.has("expectedRev")) return json(res, 409, { error: "Project changed. Refresh images again." });
      if (!asset) return json(res, 422, { error: "Image has no asset record. Refresh images again." });
      if (assetContentActive >= 2) return json(res, 429, { error: "Image refresh is busy. Try again shortly." });
      assetContentActive++;
      const controller = new AbortController(), signal = controller.signal;
      const requestSignal = renderContext.getStore();
      const cancel = () => controller.abort();
      requestSignal?.addEventListener("abort", cancel, { once: true });
      if (requestSignal?.aborted) cancel();
      let released = false, expired = false, responseClosed = false, readSettled = false;
      // Cover the whole response lifetime, including a stalled file read or socket write.
      const deadline = setTimeout(() => {
        if (released) return;
        expired = true; controller.abort();
        if (!res.destroyed) {
          if (res.headersSent) res.destroy();
          else json(res, 408, { error: "Image refresh timed out. Refresh images to retry." });
        }
      }, 30_000);
      const retire = () => {
        if (released || !responseClosed || !readSettled) return;
        released = true; assetContentActive--;
        clearTimeout(deadline); requestSignal?.removeEventListener("abort", cancel);
      };
      const release = () => { responseClosed = true; retire(); };
      res.once("finish", release); res.once("close", release);
      let file: string, bytes: Buffer;
      try {
        file = assetFile(ASSETS, asset.src);
        if (statSync(file).size > 64 * 1024 * 1024) throw new Error("Image exceeds the 64 MiB compressed limit");
        const chunks: Buffer[] = []; let size = 0;
        // Bounded reads also handle files that grow after stat. Aborting destroys the stream.
        const stream = createReadStream(file, { highWaterMark: 64 * 1024, signal });
        for await (const chunk of stream) {
          size += (chunk as Buffer).length;
          if (size > 64 * 1024 * 1024) throw new Error("Image exceeds the 64 MiB compressed limit");
          chunks.push(chunk as Buffer);
        }
        bytes = Buffer.concat(chunks, size);
      } catch (error) {
        if (expired || res.destroyed) return;
        if (signal?.aborted) throw Object.assign(new Error("Image refresh cancelled"), { status: 499 });
        return json(res, 422, { error: `Image cannot be refreshed: ${(error as Error).message}` });
      } finally { readSettled = true; retire(); }
      if (expired || res.destroyed) return;
      if (signal.aborted) throw Object.assign(new Error("Image refresh cancelled"), { status: 499 });
      if (createHash("sha256").update(bytes).digest("hex") !== digest) return json(res, 409, { error: "Image changed after it was checked. Refresh images again." });
      res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store", "X-Pictocity-Asset-SHA256": digest });
      res.end(bytes); return;
    }

    if (!sub) {
      if (method === "GET") return json(res, 200, doc);
      if (method === "DELETE") { store.delete(id); return json(res, 200, { deleted: id }); }
    }
    if (sub === "ops" && method === "POST") {
      const body = JSON.parse((await readBody(req)).toString()) as Partial<OpEnvelope>;
      if (!Array.isArray(body.ops) || !body.ops.length) return json(res, 400, { error: "ops must be a non-empty array" });
      try {
        const applied = store.apply({ docId: id, ops: body.ops ?? [], actor: body.actor ?? "api", label: body.label, expectedRev: body.expectedRev });
        return json(res, 200, { rev: applied.rev, inverse: applied.inverse });
      } catch (e) {
        return json(res, e instanceof RevisionConflict ? 409 : e instanceof OpError ? 400 : 500, { error: (e as Error).message, rev: store.get(id)?.rev });
      }
    }
    if (sub === "package" && method === "GET") {
      doc = deepClone(doc);
      return afterExportCleanup(res, () => renderer.withSnapshot(doc, ASSETS, { allAssets: true }, async (resources) => {
      const report = await preflightDocument(doc, ASSETS);
      if (!report.ok) return json(res, 422, { error: "Resolve missing resources before packaging this project", report });
      const assets: Record<string, string> = {};
      for (const a of Object.values(doc.assets)) { try { assets[a.id] = readFileSync(assetFile(resourceSnapshotContext.getStore()!.assetsDir, a.src)).toString("base64"); } catch { return json(res, 422, { error: `Image “${a.name}” is missing or outside the library; this project package would be incomplete.` }); } }
      exportResponse(res).writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.pictocity"`, "access-control-allow-origin": "*" });
      exportResponse(res).end(JSON.stringify({ format: "pictocity-package", version: 1, doc, assets, resourceSnapshot: resources })); return;
      }));
    }
    if (sub === "spec" && method === "GET") {
      const platform = url.searchParams.get("platform") ?? "meta-feed"; const artboardId = url.searchParams.get("artboard") ?? undefined;
      let exportBytes: Record<string, number> | undefined;
      if (url.searchParams.get("weigh") === "true") { const ab = artboardOpts(doc, artboardId ?? null); const [png, jpg] = await Promise.all([renderToBuffer(doc, ASSETS, { format: "png", scale: 1, ...(ab || {}) }), renderToBuffer(doc, ASSETS, { format: "jpeg", quality: 85, scale: 1, ...(ab || {}) })]); exportBytes = { png: png.length, jpg: jpg.length }; }
      try { return json(res, 200, checkSpec(doc, platform, { artboardId, exportBytes })); } catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }
    if (sub === "rasterize" && method === "POST") {
      // Render the given layers alone (with their effects) into one image asset - merge / rasterize.
      const body = JSON.parse((await readBody(req)).toString() || "{}") as { layerIds: string[]; padding?: number };
      const ids = new Set<string>();
      const boxes: { x: number; y: number; width: number; height: number }[] = [];
      for (const id of body.layerIds ?? []) {
        const l = findLayer(doc, id); if (!l) continue;
        ids.add(l.id);
        if (isGroup(l)) for (const c of [...walk(l.children)].map((w) => w.layer)) { ids.add(c.id); if (!isGroup(c)) boxes.push(layerBounds(c)); }
        else boxes.push(layerBounds(l));
      }
      if (!boxes.length) return json(res, 400, { error: "no layers" });
      const pad = body.padding ?? 64;
      const x = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)) - pad)), y = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y)) - pad));
      const x2 = Math.min(doc.width, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)) + pad)), y2 = Math.min(doc.height, Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)) + pad));
      if (x2 <= x || y2 <= y) return json(res, 400, { error: "layers are outside the canvas" });
      const buf = await renderToBuffer(doc, ASSETS, { transparent: true, onlyLayerIds: [...ids], region: { x, y, width: x2 - x, height: y2 - y } });
      const asset = await storeAsset(doc, "merged.png", buf, "image/png");
      return json(res, 201, { asset, x, y, width: x2 - x, height: y2 - y });
    }
    if (sub === "process" && method === "POST") {
      // Run an image tool on an asset and store the result as a new asset.
      const body = JSON.parse((await readBody(req)).toString() || "{}") as { tool: string; assetId: string; params?: Record<string, unknown> };
      const src = doc.assets[body.assetId];
      if (!src) return json(res, 404, { error: `asset ${body.assetId} not found` });
      try {
        const input = readFileSync(join(ASSETS, basename(src.src)));
        const out = await runImageTool(body.tool, input, body.params ?? {});
        const asset = await storeAsset(doc, `${src.name.replace(/\.[^.]+$/, "")}-${body.tool}.png`, out, "image/png");
        return json(res, 201, asset);
      } catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }
    if (sub === "variant" && method === "POST") {
      // Copy the document at another size with the layout scaled to fit - one ad, many formats.
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const width = clampDimension(body.width, doc.width), height = clampDimension(body.height, doc.height);
      const copy = deepClone(doc);
      copy.id = uid("doc"); copy.name = body.name ?? `${doc.name} ${width}x${height}`; copy.rev = 0; copy.createdAt = copy.updatedAt = new Date().toISOString();
      copy.layers = copy.layers.map(cloneWithNewIds).map((l) => ({ ...l, name: l.name.replace(/ copy$/, "") }));
      copy.guides = [];
      applyOps(copy, resizeLayoutOps(copy, width, height, { scaleContent: body.scaleContent !== false }));
      store.put(copy);
      return json(res, 201, { id: copy.id, name: copy.name, width: copy.width, height: copy.height });
    }
    if (sub === "history" && method === "GET") return json(res, 200, store.historySince(id, Number(url.searchParams.get("since") ?? 0)));

    if (sub === "assets" && method === "POST") {
      const ct = req.headers["content-type"] ?? "application/octet-stream";
      const raw = await readBody(req);
      if (ct.startsWith("application/json")) {
        const body = JSON.parse(raw.toString());
        let bytes: Buffer, mime = body.mime ?? "image/png", name = body.name ?? "image";
        if (body.url) {
          const r = await fetch(body.url);
          if (!r.ok) return json(res, 400, { error: `fetch ${body.url}: ${r.status}` });
          bytes = Buffer.from(await r.arrayBuffer()); mime = r.headers.get("content-type") ?? mime; name = body.name ?? (basename(new URL(body.url).pathname) || "image");
        } else if (body.path) {
          bytes = readFileSync(body.path); name = body.name ?? basename(body.path); mime = MIME[extname(body.path).toLowerCase()] ?? mime;
        } else if (body.base64) {
          bytes = Buffer.from(body.base64, "base64");
        } else return json(res, 400, { error: "provide url, path or base64" });
        try { return json(res, 201, await storeAsset(doc, name, bytes, mime)); }
        catch (e) { return json(res, 400, { error: (e as Error).message }); }
      }
      // Raw upload: body is the file, name in x-filename.
      const name = decodeURIComponent(String(req.headers["x-filename"] ?? "upload"));
      try { return json(res, 201, await storeAsset(doc, name, raw, ct)); }
      catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }

    if ((sub === "render.png" || sub === "render") && method === "GET") {
      const scale = clampScale(doc, url.searchParams.get("scale") ?? 1);
      const layer = url.searchParams.get("layer");
      const ab = artboardOpts(doc, url.searchParams.get("artboard"));
      if (ab === false) return json(res, 404, { error: "artboard not found" });
      const buf = await renderToBuffer(doc, ASSETS, { scale, onlyLayerIds: layer ? [layer] : undefined, transparent: !!layer || !!ab, ...ab });
      res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(buf); return;
    }

    if (sub === "export-set" || (sub === "export" && method === "POST")) {
      if (method !== "POST") return json(res, 405, { error: "Export sets require POST" });
      const q = JSON.parse((await readBody(req)).toString() || "{}");
      if (!q || typeof q !== "object" || Array.isArray(q)) return json(res, 400, { error: "Export options must be an object" });
      const current = store.get(id);
      if (!current) return json(res, 404, { error: "document not found" });
      if (sub === "export-set" && (q.expectedRev === undefined || q.expectedResources === undefined)) return json(res, 400, { error: "Export sets require reviewed expectedRev and expectedResources from preflight" });
      if (q.expectedRev !== undefined && (!["number", "string"].includes(typeof q.expectedRev) || q.expectedRev === "" || !Number.isSafeInteger(Number(q.expectedRev)) || Number(q.expectedRev) < 0)) return json(res, 400, { error: "expectedRev must be a nonnegative integer" });
      if (q.expectedResources !== undefined && (typeof q.expectedResources !== "string" || !/^[0-9a-f]{64}$/.test(q.expectedResources))) return json(res, 400, { error: "expectedResources must be a SHA-256 preflight fingerprint" });
      if (q.expectedRev !== undefined && Number(q.expectedRev) !== current.rev) return json(res, 409, { error: `Revision conflict: expected ${q.expectedRev}, current ${current.rev}. Refresh before exporting.` });
      // Retain the legacy POST API's forgiving numeric controls, while validating all set options upfront.
      if (sub === "export") for (const [key, lo, hi, fallback] of [["quality", 1, 100, 90], ["colors", 2, 256, 256], ["dpi", 36, 2400, 72]] as const) if (q[key] !== undefined) q[key] = clampInt(q[key], lo, hi, fallback);
      const result = await exportSets.execute(deepClone(current), q, EXPORTS, ASSETS, renderer);
      const headers = { "X-Pictocity-Resource-Snapshot": result.resourceSnapshot.sha256, "X-Pictocity-Revision": String(result.resourceSnapshot.revision), "Access-Control-Expose-Headers": "X-Pictocity-Resource-Snapshot, X-Pictocity-Revision", "access-control-allow-origin": "*", "cache-control": "no-store" };
      if (result.body) {
        // Quota covers the response bytes until FINISH/CLOSE; a stalled reader is explicitly retired.
        try {
          await new Promise<void>((resolveResponse, reject) => {
            const done = () => { clearTimeout(timer); res.removeListener("finish", done); res.removeListener("close", done); res.removeListener("error", failed); resolveResponse(); };
            const failed = (error: Error) => { done(); reject(error); };
            const timer = setTimeout(() => { res.destroy(new Error("Export-set download response timed out")); }, EXPORT_SET_LIMITS.responseMs);
            res.once("finish", done); res.once("close", done); res.once("error", failed);
            if (res.destroyed) { done(); return; }
            res.writeHead(200, { ...headers, "content-type": "application/vnd.pictocity.export-set", "content-length": result.body!.length }); res.end(result.body);
          });
        } finally { result.retire!(); }
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      const single = sub === "export" && result.files.length === 1 && ((q.comps !== true && q.artboards !== true) || (q.format === "pdf" && q.artboards === true && q.comps !== true));
      const files = sub === "export" ? result.files.map((f) => ({ ...f, filename: f.name, name: q.comps === true || q.artboards === true ? f.label : f.name, url: f.url ? `http://localhost:${PORT}${f.url}` : undefined })) : result.files;
      res.end(JSON.stringify(single ? { ...files[0], resourceSnapshot: result.resourceSnapshot } : { files, resourceSnapshot: result.resourceSnapshot }));
      return;
    }

    if (sub === "export") {
      if (method !== "GET") return json(res, 405, { error: "Use GET for direct downloads or POST for saved exports" });
      const q = Object.fromEntries(url.searchParams);
      // An export is bound to the revision the user reviewed, even if edits arrive while it is queued.
      if (q.expectedRev !== undefined && Number(q.expectedRev) !== doc.rev) throw Object.assign(new Error(`Revision conflict: expected ${q.expectedRev}, current ${doc.rev}. Refresh before exporting.`), { status: 409 });
      doc = deepClone(doc);
      return afterExportCleanup(res, () => renderer.withSnapshot(doc, ASSETS, { audioSource: (q.format === "mp4" || q.format === "webm") && q.audio ? String(q.audio) : undefined }, async (resources) => {
      if (q.expectedResources !== undefined && q.expectedResources !== resources.sha256) return json(res, 409, { error: "Images or added fonts changed between export files. Export the set again to use one consistent version." });
      res.setHeader("X-Pictocity-Resource-Snapshot", resources.sha256);
      res.setHeader("X-Pictocity-Revision", String(resources.revision));
      res.setHeader("Access-Control-Expose-Headers", "X-Pictocity-Resource-Snapshot, X-Pictocity-Revision");
      // A layer comp can be applied to a copy of the document before rendering; comps:true exports every comp.
      const withComp = (name: string) => { const c = (doc.comps ?? []).find((x) => x.id === name || x.name.toLowerCase() === String(name).toLowerCase()); if (!c) return null; const d = deepClone(doc); applyOps(d, applyCompOps(d, c)); return { doc: d, comp: c }; };
      if (q.comp) { const v = withComp(q.comp); if (!v) return json(res, 404, { error: "comp not found" }); doc = v.doc; }
      if (q.format === "mp4" || q.format === "webm") {
        if (q.artboard || q.artboards) return json(res, 400, { error: "Video export currently uses the whole canvas. Choose Whole canvas." });
        if (q.transparent === "true") return json(res, 400, { error: "MP4 and WebM currently export opaque video. Choose an image format for transparency." });
        // Timeline → video; `audio` may be a path on the server or an http(s) URL (a soundstudio render, for instance).
        const audioPath = resourceSnapshotContext.getStore()?.audioPath;
        let out: Buffer;
        const options = { format: q.format as "mp4" | "webm", fps: q.fps !== undefined ? Number(q.fps) : undefined, scale: clampScale(doc, q.scale ?? 1), audioPath, duration: q.duration !== undefined ? Number(q.duration) : undefined, crf: q.crf !== undefined ? Number(q.crf) : undefined };
        const cancelled = new AbortController(); const onClose = () => { if (!res.writableEnded) cancelled.abort(); }; res.once("close", onClose);
        try { out = await renderVideo(deepClone(doc), ASSETS, { ...options, signal: cancelled.signal }); }
        catch (e) { throw e; }
        finally { res.removeListener("close", onClose); }
        const mime = q.format === "webm" ? "video/webm" : "video/mp4";
        exportResponse(res).writeHead(200, { "content-type": mime, "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.${q.format}"`, "access-control-allow-origin": "*" }); exportResponse(res).end(out); return;

      }
      if (q.format === "gif" || q.format === "html") {
        const isGif = q.format === "gif";
        const controller = new AbortController(), cancel = () => controller.abort(); res.once("close", cancel);
        let out: Buffer | string;
        try { out = isGif ? await renderGif(deepClone(doc), ASSETS, { scale: clampScale(doc, q.scale ?? 1), fps: q.fps !== undefined ? Number(q.fps) : undefined, maxColors: q.colors !== undefined ? Number(q.colors) : undefined, signal: controller.signal }) : await renderHtmlBanner(deepClone(doc), ASSETS); }
        finally { res.removeListener("close", cancel); }
        const ext = isGif ? "gif" : "html", mime = isGif ? "image/gif" : "text/html";
        exportResponse(res).writeHead(200, { "content-type": mime, "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.${ext}"`, "access-control-allow-origin": "*" }); exportResponse(res).end(out); return;

      }
      if (q.format === "svg") {
        const svg = await renderSvg(doc, ASSETS);
        exportResponse(res).writeHead(200, { "content-type": "image/svg+xml", "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.svg"`, "access-control-allow-origin": "*" }); exportResponse(res).end(svg); return;

      }
      const format = (q.format === "jpg" ? "jpeg" : q.format === "tif" ? "tiff" : q.format ?? "png") as ExportFormat | "psd";
      const transparentBg = q.transparent === "true";
      if (transparentBg) doc = { ...doc, background: null };
      if (format === "pdf" && q.artboards === "true" && artboards(doc).length) {
        // One PDF page per artboard.
        const pages = [];
        for (const ab of artboards(doc)) { const region = artboardOpts(doc, ab.id)!; const pngBuf = await renderToBuffer(doc, ASSETS, { format: "jpeg", quality: Number(q.quality ?? 92), scale: Number(q.scale ?? 1), ...region }); pages.push({ width: Math.round(ab.width * Number(q.scale ?? 1)), height: Math.round(ab.height * Number(q.scale ?? 1)), jpeg: pngBuf, title: ab.name }); }
        const f = await import("./formats.js"); const pdf = f.encodePdf(pages, Number(q.dpi ?? 72));
        exportResponse(res).writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.pdf"`, "access-control-allow-origin": "*" }); exportResponse(res).end(pdf); return;

      }
      if (!EXPORT_FORMATS.has(String(q.format ?? "png"))) return json(res, 400, { error: `unknown format ${String(q.format)}; use one of ${[...EXPORT_FORMATS].join(", ")}` });
      const scale = format === "psd" ? 1 : clampScale(doc, q.scale ?? 1); // per-artboard regions are smaller than the canvas, so this is conservative
      if (q.quality !== undefined) q.quality = String(clampInt(q.quality, 1, 100, 90));
      if (q.colors !== undefined) q.colors = String(clampInt(q.colors, 2, 256, 256));
      if (q.dpi !== undefined) q.dpi = String(clampInt(q.dpi, 36, 2400, 72));
      const safe = (n: string) => n.replace(/[^\w.-]+/g, "_");
      const ext = format === "jpeg" ? "jpg" : format === "png8" ? "png" : format;
      const ab = artboardOpts(doc, q.artboard);
      if (ab === false) return json(res, 404, { error: "artboard not found" });
      const trim = q.trim === "true";
      const buf = format === "psd" ? await docToPsd(doc, ASSETS) : await renderToBuffer(doc, ASSETS, { format, scale, quality: q.quality ? Number(q.quality) : undefined, colors: q.colors ? Number(q.colors) : undefined, dpi: q.dpi ? Number(q.dpi) : undefined, lossless: q.lossless === "true", transparent: !!ab || trim || transparentBg, trim, ...ab });
      const abName = ab ? `-${safe((findLayer(doc, ab.rootLayerIds[0]) as { name: string }).name)}` : "";
      const mime = format === "psd" ? "image/vnd.adobe.photoshop" : format === "pdf" ? "application/pdf" : format === "png8" ? "image/png" : `image/${format}`;
      exportResponse(res).writeHead(200, { "content-type": mime, "content-disposition": `attachment; filename="${safe(doc.name)}${abName}.${ext}"`, "access-control-allow-origin": "*" });
      exportResponse(res).end(buf); return;
      }));
    }

  }
  json(res, 404, { error: `no route for ${method} ${url.pathname}` });
}

// ---- HTTP + static ----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-filename" });
    return res.end();
  }
  try {
    // Guarded prefixes. /api/ was the only one until 2026-09-07, which left
    // /exports/, /assets/ and /fonts/ readable WITHOUT the token even when one
    // was set -- and those are user data: every rendered ad, every uploaded
    // image, every installed font. The startup line says "token required for
    // /api and /ws", so the gap was invisible from the console too. Asset ids
    // are unguessable, but obscurity is not the control the operator asked
    // for when they set a token.
    // The editor shell stays open on purpose: it is inert without API access,
    // and it is what shows the user they need a token.
    const GUARDED = ["/api/", "/exports/", "/assets/", "/fonts/"];
    if (TOKEN && GUARDED.some((p) => url.pathname.startsWith(p))) {
      const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
      if (given !== TOKEN) return json(res, 401, { error: "unauthorized: set PICTOCITY_TOKEN in the client (Authorization: Bearer ... or ?token=)" });
    }
    if (url.pathname.startsWith("/api/")) {
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", cancel);
      try { return await renderContext.run(controller.signal, () => handleApi(req, res, url)); }
      finally { res.removeListener("close", cancel); }
    }
    if (url.pathname.startsWith("/assets/")) return serveFile(res, join(ASSETS, basename(url.pathname)), "public, max-age=31536000, immutable"); // asset ids are unique, files never change
    if (url.pathname.startsWith("/fonts/")) return serveFile(res, join(FONTS, basename(url.pathname)));
    if (url.pathname.startsWith("/exports/")) { if (basename(url.pathname).startsWith(".pictocity-export-set")) return json(res, 404, { error: "private export transaction" }); return serveFile(res, join(EXPORTS, basename(url.pathname))); }
    // Editor build, with SPA fallback.
    const file = join(EDITOR_DIST, url.pathname === "/" ? "index.html" : url.pathname);
    if (existsSync(file) && !statSync(file).isDirectory()) return serveFile(res, file);
    if (existsSync(join(EDITOR_DIST, "index.html"))) return serveFile(res, join(EDITOR_DIST, "index.html"));
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pictocity server is running. Build the editor (npm run build) to serve it here, or run it with vite for development.");
  } catch (e) {
    const status = (e as { status?: number }).status ?? (e instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(e);
    if (!res.destroyed) json(res, status, { error: (e as Error).message, report: (e as { report?: unknown }).report });
  }
});

// ---- WebSocket live sync ------------------------------------------------------------

interface Client { ws: WebSocket; id: string; docId: string | null; alive: boolean }
const clients = new Set<Client>();
const wss = new WebSocketServer({ server, path: "/ws" });

function send(ws: WebSocket, msg: ServerMessage) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

wss.on("connection", (ws, req) => {
  if (TOKEN) {
    const q = new URL(req.url ?? "/", `http://localhost:${PORT}`).searchParams.get("token") ?? "";
    if (q !== TOKEN) { ws.close(4001, "unauthorized"); return; }
  }
  const client: Client = { ws, id: uid("c"), docId: null, alive: true };
  clients.add(client);
  ws.on("pong", () => { client.alive = true; });
  ws.on("message", (data) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(data.toString()); } catch { return send(ws, { kind: "error", message: "bad json" }); }
    if (msg.kind === "subscribe") {
      const doc = store.get(msg.docId);
      if (!doc) return send(ws, { kind: "error", message: `document ${msg.docId} not found` });
      client.docId = msg.docId;
      send(ws, { kind: "snapshot", doc });
    } else if (msg.kind === "ops") {
      // A socket may only write to the document it subscribed to. Until
      // 2026-09-07 the envelope's docId was never compared with client.docId
      // (set above, on subscribe), so a client subscribed to document A could
      // mutate document B -- and would see no confirmation, because the
      // broadcast below matches on the APPLIED doc's id, so the write landed
      // silently on a document nobody watching had open.
      if (!client.docId) return send(ws, { kind: "rejected", reason: "subscribe to a document before sending ops", rev: 0 });
      if (msg.envelope?.docId !== client.docId) {
        const own = store.get(client.docId);
        return send(ws, { kind: "rejected", reason: `this socket is subscribed to ${client.docId}, not ${msg.envelope?.docId}`, rev: own?.rev ?? 0 });
      }
      try {
        const applied = store.apply(msg.envelope);
        // The store listener broadcasts to every subscriber, including the sender (as confirmation).
        void applied;
      } catch (e) {
        const doc = store.get(msg.envelope.docId);
        send(ws, { kind: "rejected", reason: (e as Error).message, rev: doc?.rev ?? 0 });
      }
    } else if (msg.kind === "presence") {
      for (const c of clients) if (c !== client && c.docId === msg.docId) send(c.ws, { kind: "presence", actor: client.id, selection: msg.selection, cursor: msg.cursor });
    }
  });
  ws.on("close", () => clients.delete(client));
});

// Keepalive: proxies and sleepy laptops drop idle sockets; ping every 25s and drop clients that never pong.
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { /* closing */ }
  }
}, 25_000).unref();

// Docker / systemd stop with SIGTERM: flush debounced saves before exiting so the last edit is never lost.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, async () => { try { store.flush(); await Promise.all([exportSets.close(), renderer.close()]); console.log(`${sig}: documents flushed, shutting down`); process.exit(0); } catch (e) { console.error(e); process.exit(1); } });

store.onApplied((applied) => {
  for (const c of clients) if (c.docId === applied.docId) send(c.ws, { kind: "applied", applied });
});

// BIND LOOPBACK, NOT EVERY INTERFACE. server.listen(PORT) with no host
// is all interfaces in Node, so this was listening on :: and answering on
// the machine's LAN address -- measured 2026-09-07: the health endpoint
// returned 200 from off-box. There is no token by default, and this
// project's own doctor says so: "no PICTOCITY_TOKEN -- fine on localhost;
// set one before exposing the server on a network". It believed it was
// localhost-only and it was not.
//
// It also made Windows raise a firewall prompt on every launch, which is
// the kind of thing a person clicks through once and then owns forever.
//
// PICTOCITY_HOST overrides it, so putting this on a network stays possible
// and stays deliberate -- and that is the moment to set PICTOCITY_TOKEN.
const HOST = process.env.PICTOCITY_HOST ?? "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`pictocity server  http://localhost:${PORT}${HOST === "127.0.0.1" ? "" : `  (bound ${HOST})`}`);
  console.log(`documents: ${store.list().length}   data: ${DATA}`);
});
