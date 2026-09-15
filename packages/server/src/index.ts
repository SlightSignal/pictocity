import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, createReadStream, readdirSync, unlinkSync } from "node:fs";
import { join, extname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadImage } from "@napi-rs/canvas";
import type { AdDocument, Asset, ClientMessage, OpEnvelope, ServerMessage } from "@pictocity/core";
import { AD_PRESETS, DEFAULT_STYLE_PRESETS, OpError, uid, nowIso, applyOps, deepClone, normalizeLayer, checkSpec, resizeLayoutOps, clampDimension, cloneWithNewIds, artboards, findLayer, isGroup, walk, layerBounds, applyCompOps, documentToSvg, rasterizeLayerForSvg, svgToLayers, createDocument, makeGroup } from "@pictocity/core";
import { loadAssets, nodeEnv } from "./node-env.js";
import type { Canvas } from "@napi-rs/canvas";
import { DocStore } from "./store.js";
import { registerFonts, registerFontFile, listFontFamilies, renderToBuffer, renderGif, renderHtmlBanner, renderVideo, type ExportFormat } from "./node-env.js";
import { docToPsd, psdToDoc } from "./psd.js";
import { loadImageTools, listImageTools, runImageTool } from "./image-tools.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(here, "../../..");
export const PORT = Number(process.env.PICTOCITY_PORT ?? 4100);
const DATA = process.env.PICTOCITY_DATA ?? join(ROOT, "data");
const ASSETS = join(DATA, "assets");
const EXPORTS = join(DATA, "exports");
const FONTS = process.env.PICTOCITY_FONTS ?? join(ROOT, "fonts");
const EDITOR_DIST = join(ROOT, "packages/editor/dist");
for (const d of [ASSETS, EXPORTS, join(DATA, "docs")]) mkdirSync(d, { recursive: true });

mkdirSync(FONTS, { recursive: true });
const served = registerFonts(FONTS);
console.log(`fonts: ${served.map((f) => f.family).join(", ") || "none"} served from ${FONTS}; ${listFontFamilies().length} families available to the renderer`);

const TOKEN = process.env.PICTOCITY_TOKEN ?? "";
if (TOKEN) console.log("auth: bearer token required for /api and /ws");

const store = new DocStore(join(DATA, "docs"));
const imageTools = loadImageTools(process.env.PICTOCITY_IMAGE_TOOLS ?? join(ROOT, "image-tools.json"));
console.log(`image tools: ${imageTools.map((t) => t.name).join(", ")}`);

// ---- Helpers ----------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".gif": "image/gif", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon", ".psd": "image/vnd.adobe.photoshop",
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

const MAX_BODY = Number(process.env.PICTOCITY_MAX_BODY_MB ?? 200) * 1024 * 1024;
/** Largest raster we'll produce: caps memory for renders and exports (a side of 16384 px or ~64 MP, whichever first). */
const MAX_RENDER_SIDE = 16384, MAX_RENDER_PIXELS = 64e6;
function clampScale(doc: { width: number; height: number }, requested: unknown, region?: { width: number; height: number } | null): number {
  let s = Number(requested); if (!Number.isFinite(s) || s <= 0) s = 1;
  const w = region?.width ?? doc.width, h = region?.height ?? doc.height;
  const bySide = MAX_RENDER_SIDE / Math.max(w, h), byArea = Math.sqrt(MAX_RENDER_PIXELS / (w * h));
  return Math.max(0.01, Math.min(s, bySide, byArea));
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
  const ext = extname(name) || (mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : ".jpg");
  const id = uid("a");
  const file = `${id}${ext}`;
  writeFileSync(join(ASSETS, file), bytes);
  const img = await loadImage(join(ASSETS, file));
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

  if (p1 === "health") return json(res, 200, { ok: true, docs: store.list().length, rev: 0, paths: { data: DATA, exports: EXPORTS, assets: ASSETS, fonts: FONTS } });
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
    const files = readdirSync(EXPORTS).map((f) => { const st = statSync(join(EXPORTS, f)); return { file: f, bytes: st.size, mtime: st.mtimeMs, url: `/exports/${encodeURIComponent(f)}` }; }).sort((a, b) => b.mtime - a.mtime);
    return json(res, 200, files);
  }
  if (p1 === "docs" && id === "import-package" && method === "POST") {
    // A portable .pictocity file: {doc, assets: {id: base64}} — restores the document with its images on this server.
    const body = JSON.parse((await readBody(req)).toString()) as { doc: AdDocument; assets: Record<string, string> };
    const doc = deepClone(body.doc); doc.id = uid("doc"); doc.rev = 0; doc.updatedAt = nowIso();
    for (const [aid, b64] of Object.entries(body.assets ?? {})) { const a = doc.assets[aid]; if (!a) continue; const file = basename(a.src); writeFileSync(join(ASSETS, file), Buffer.from(b64, "base64")); }
    store.put(doc);
    return json(res, 201, { id: doc.id, name: doc.name });
  }
  if (p1 === "brand") {
    // Brand kit shared by every document and the agent: colours, fonts, logo, voice rules, audio identity.
    const file = join(DATA, "brand.json");
    if (method === "GET") return json(res, 200, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { name: "", colors: [], fonts: [], logoAssetSrc: null, voice: "", rules: [], audio: { targetLufs: -14, sonicLogoAssetSrc: null } });
    const body = JSON.parse((await readBody(req)).toString() || "{}"); writeFileSync(file, JSON.stringify(body, null, 1)); return json(res, 200, body);
  }
  if (p1 === "style-presets") {
    const file = join(DATA, "style-presets.json");
    if (method === "GET") return json(res, 200, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : DEFAULT_STYLE_PRESETS);
    const body = JSON.parse((await readBody(req)).toString() || "[]");
    writeFileSync(file, JSON.stringify(body, null, 1));
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
    writeFileSync(join(FONTS, name), bytes);
    const family = registerFontFile(FONTS, name);
    if (!family) return json(res, 400, { error: "could not register that font file" });
    const existing = served.find((f) => f.family === family);
    if (existing) { if (!existing.files.includes(name)) existing.files.push(name); } else served.push({ family, files: [name] });
    return json(res, 201, { family, file: name });
  }
  if (p1 === "fonts") {
    // Served fonts come with their files (the editor registers them via @font-face); system fonts are names only.
    const servedNames = new Set(served.map((f) => f.family));
    return json(res, 200, [...served, ...listFontFamilies().filter((f) => !servedNames.has(f))]);
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

    if (!sub) {
      if (method === "GET") return json(res, 200, doc);
      if (method === "DELETE") { store.delete(id); return json(res, 200, { deleted: id }); }
    }
    if (sub === "ops" && method === "POST") {
      const body = JSON.parse((await readBody(req)).toString()) as Partial<OpEnvelope>;
      if (!Array.isArray(body.ops) || !body.ops.length) return json(res, 400, { error: "ops must be a non-empty array" });
      try {
        const applied = store.apply({ docId: id, ops: body.ops ?? [], actor: body.actor ?? "api", label: body.label });
        return json(res, 200, { rev: applied.rev, inverse: applied.inverse });
      } catch (e) {
        return json(res, e instanceof OpError ? 400 : 500, { error: (e as Error).message });
      }
    }
    if (sub === "package" && method === "GET") {
      const assets: Record<string, string> = {};
      for (const a of Object.values(doc.assets)) { try { assets[a.id] = readFileSync(join(ASSETS, basename(a.src))).toString("base64"); } catch { /* missing file */ } }
      res.writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.pictocity"`, "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ format: "pictocity-package", version: 1, doc, assets })); return;
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

    if (sub === "export") {
      const q = method === "POST" ? JSON.parse((await readBody(req)).toString() || "{}") : Object.fromEntries(url.searchParams);
      // A layer comp can be applied to a copy of the document before rendering; comps:true exports every comp.
      const withComp = (name: string) => { const c = (doc.comps ?? []).find((x) => x.id === name || x.name.toLowerCase() === String(name).toLowerCase()); if (!c) return null; const d = deepClone(doc); applyOps(d, applyCompOps(d, c)); return { doc: d, comp: c }; };
      if (method === "POST" && q.comps === true) {
        const out: { name: string; path: string }[] = [];
        for (const c of doc.comps ?? []) {
          const v = withComp(c.id)!;
          const ab = artboardOpts(v.doc, q.artboard);
          const buf = await renderToBuffer(v.doc, ASSETS, { format: q.format === "jpg" ? "jpeg" : q.format ?? "png", scale: Number(q.scale ?? 1), transparent: !!ab, ...(ab || {}) });
          const file = join(q.dir ? resolve(q.dir) : EXPORTS, `${doc.name.replace(/[^\w.-]+/g, "_")}-${c.name.replace(/[^\w.-]+/g, "_")}.${q.format === "jpg" ? "jpg" : q.format ?? "png"}`);
          mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, buf); out.push({ name: c.name, path: file });
        }
        return json(res, 200, { files: out });
      }
      if (q.comp) { const v = withComp(q.comp); if (!v) return json(res, 404, { error: "comp not found" }); doc = v.doc; }
      if (q.format === "mp4" || q.format === "webm") {
        // Timeline → video; `audio` may be a path on the server or an http(s) URL (a soundstudio render, for instance).
        let audioPath: string | undefined;
        if (q.audio) { if (/^https?:\/\//.test(String(q.audio))) { const r = await fetch(String(q.audio)); if (!r.ok) return json(res, 400, { error: `audio fetch ${r.status}` }); audioPath = join(EXPORTS, `.audio-${uid("a")}.bin`); writeFileSync(audioPath, Buffer.from(await r.arrayBuffer())); } else audioPath = resolve(String(q.audio)); }
        let out: Buffer;
        try { out = await renderVideo(doc, ASSETS, { format: q.format, fps: q.fps ? clampInt(q.fps, 1, 60, 24) : undefined, scale: clampScale(doc, q.scale ?? 1), audioPath, duration: q.duration ? Number(q.duration) : undefined, crf: q.crf ? clampInt(q.crf, 0, 51, 20) : undefined }); }
        catch (e) { return json(res, 400, { error: (e as Error).message }); }
        finally { if (audioPath && audioPath.startsWith(EXPORTS) && basename(audioPath).startsWith(".audio-")) { try { unlinkSync(audioPath); } catch { /* gone */ } } }
        const mime = q.format === "webm" ? "video/webm" : "video/mp4";
        if (method === "GET") { res.writeHead(200, { "content-type": mime, "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.${q.format}"`, "access-control-allow-origin": "*" }); res.end(out); return; }
        const file = q.path ? resolve(q.path) : join(EXPORTS, `${doc.name.replace(/[^\w.-]+/g, "_")}-${doc.rev}.${q.format}`);
        mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, out);
        return json(res, 200, { path: file, url: file.startsWith(EXPORTS) ? `http://localhost:${PORT}/exports/${encodeURIComponent(basename(file))}` : undefined, bytes: out.length, width: doc.width, height: doc.height });
      }
      if (q.format === "gif" || q.format === "html") {
        const isGif = q.format === "gif";
        const out: Buffer | string = isGif ? await renderGif(doc, ASSETS, { scale: clampScale(doc, q.scale ?? 1), fps: q.fps ? clampInt(q.fps, 1, 60, 12) : undefined }) : await renderHtmlBanner(doc, ASSETS);
        const ext = isGif ? "gif" : "html", mime = isGif ? "image/gif" : "text/html";
        if (method === "GET") { res.writeHead(200, { "content-type": mime, "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.${ext}"`, "access-control-allow-origin": "*" }); res.end(out); return; }
        const file = q.path ? resolve(q.path) : join(EXPORTS, `${doc.name.replace(/[^\w.-]+/g, "_")}-${doc.rev}.${ext}`);
        mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, out);
        return json(res, 200, { path: file, url: file.startsWith(EXPORTS) ? `http://localhost:${PORT}/exports/${encodeURIComponent(basename(file))}` : undefined, bytes: out.length, width: doc.width, height: doc.height, frames: isGif && doc.animation ? Math.round((doc.animation.duration / 1000) * (q.fps ? Number(q.fps) : doc.animation.fps)) : 1 });
      }
      if (q.format === "svg") {
        const images = await loadAssets(doc, ASSETS); const env = nodeEnv(images);
        const svg = documentToSvg(doc, { env, assetUrl: (aid) => { const a = doc!.assets[aid]; if (!a) return null; try { const f = join(ASSETS, basename(a.src)); return `data:${a.mime};base64,${readFileSync(f).toString("base64")}`; } catch { return null; } }, raster: (l) => rasterizeLayerForSvg(doc!, l, env, (c) => `data:image/png;base64,${(c as unknown as Canvas).toBuffer("image/png").toString("base64")}`) });
        if (method === "GET") { res.writeHead(200, { "content-type": "image/svg+xml", "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.svg"`, "access-control-allow-origin": "*" }); res.end(svg); return; }
        const file = q.path ? resolve(q.path) : join(EXPORTS, `${doc.name.replace(/[^\w.-]+/g, "_")}-${doc.rev}.svg`);
        mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, svg);
        return json(res, 200, { path: file, url: file.startsWith(EXPORTS) ? `http://localhost:${PORT}/exports/${encodeURIComponent(basename(file))}` : undefined, bytes: svg.length, width: doc.width, height: doc.height });
      }
      const format = (q.format === "jpg" ? "jpeg" : q.format === "tif" ? "tiff" : q.format ?? "png") as ExportFormat | "psd";
      const transparentBg = q.transparent === true || q.transparent === "true";
      if (transparentBg) doc = { ...doc, background: null };
      if (format === "pdf" && (q.artboards === true || q.artboards === "true") && artboards(doc).length) {
        // One PDF page per artboard.
        const pages = [];
        for (const ab of artboards(doc)) { const region = artboardOpts(doc, ab.id)!; const pngBuf = await renderToBuffer(doc, ASSETS, { format: "jpeg", quality: Number(q.quality ?? 92), scale: Number(q.scale ?? 1), ...region }); pages.push({ width: Math.round(ab.width * Number(q.scale ?? 1)), height: Math.round(ab.height * Number(q.scale ?? 1)), jpeg: pngBuf, title: ab.name }); }
        const f = await import("./formats.js"); const pdf = f.encodePdf(pages, Number(q.dpi ?? 72));
        if (method === "GET") { res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${doc.name.replace(/[^\w.-]+/g, "_")}.pdf"`, "access-control-allow-origin": "*" }); res.end(pdf); return; }
        const file = q.path ? resolve(q.path) : join(EXPORTS, `${doc.name.replace(/[^\w.-]+/g, "_")}-${doc.rev}.pdf`); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, pdf);
        return json(res, 200, { path: file, url: file.startsWith(EXPORTS) ? `http://localhost:${PORT}/exports/${encodeURIComponent(basename(file))}` : undefined, bytes: pdf.length, pages: pages.length });
      }
      if (!EXPORT_FORMATS.has(String(q.format ?? "png"))) return json(res, 400, { error: `unknown format ${String(q.format)}; use one of ${[...EXPORT_FORMATS].join(", ")}` });
      const scale = format === "psd" ? 1 : clampScale(doc, q.scale ?? 1); // per-artboard regions are smaller than the canvas, so this is conservative
      if (q.quality !== undefined) q.quality = clampInt(q.quality, 1, 100, 90);
      if (q.colors !== undefined) q.colors = clampInt(q.colors, 2, 256, 256);
      if (q.dpi !== undefined) q.dpi = clampInt(q.dpi, 36, 2400, 72);
      const safe = (n: string) => n.replace(/[^\w.-]+/g, "_");
      const ext = format === "jpeg" ? "jpg" : format === "png8" ? "png" : format;
      if (method === "POST" && q.artboards === true) {
        // One file per artboard.
        const out: { name: string; path: string; width: number; height: number }[] = [];
        for (const a of artboards(doc)) {
          const buf = await renderToBuffer(doc, ASSETS, { format: format === "psd" ? "png" : format, scale, quality: q.quality ? Number(q.quality) : undefined, transparent: true, region: { x: a.x, y: a.y, width: a.width, height: a.height }, rootLayerIds: [a.id] });
          const file = join(q.dir ? resolve(q.dir) : EXPORTS, `${safe(doc.name)}-${safe(a.name)}.${format === "psd" ? "png" : ext}`);
          mkdirSync(join(file, ".."), { recursive: true });
          writeFileSync(file, buf);
          out.push({ name: a.name, path: file, width: Math.ceil(a.width * scale), height: Math.ceil(a.height * scale) });
        }
        return json(res, 200, { files: out });
      }
      const ab = artboardOpts(doc, q.artboard);
      if (ab === false) return json(res, 404, { error: "artboard not found" });
      const trim = q.trim === true || q.trim === "true";
      const buf = format === "psd" ? await docToPsd(doc, ASSETS) : await renderToBuffer(doc, ASSETS, { format, scale, quality: q.quality ? Number(q.quality) : undefined, colors: q.colors ? Number(q.colors) : undefined, dpi: q.dpi ? Number(q.dpi) : undefined, lossless: q.lossless === true || q.lossless === "true", transparent: !!ab || trim || transparentBg, trim, ...ab });
      if (method === "GET") {
        const abName = ab ? `-${safe((findLayer(doc, q.artboard) as { name: string }).name)}` : "";
        const mime = format === "psd" ? "image/vnd.adobe.photoshop" : format === "pdf" ? "application/pdf" : format === "png8" ? "image/png" : `image/${format}`;
        res.writeHead(200, { "content-type": mime, "content-disposition": `attachment; filename="${safe(doc.name)}${abName}.${ext}"`, "access-control-allow-origin": "*" });
        res.end(buf); return;
      }
      const abName = ab ? `-${safe((findLayer(doc, q.artboard) as { name: string }).name)}` : "";
      const file = q.path ? resolve(q.path) : join(EXPORTS, `${safe(doc.name)}${abName}-${doc.rev}.${ext}`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, buf);
      const urlOut = file.startsWith(EXPORTS) ? `http://localhost:${PORT}/exports/${encodeURIComponent(basename(file))}` : undefined;
      return json(res, 200, { path: file, url: urlOut, bytes: buf.length, width: Math.ceil(doc.width * scale), height: Math.ceil(doc.height * scale) });
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
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname.startsWith("/assets/")) return serveFile(res, join(ASSETS, basename(url.pathname)), "public, max-age=31536000, immutable"); // asset ids are unique, files never change
    if (url.pathname.startsWith("/fonts/")) return serveFile(res, join(FONTS, basename(url.pathname)));
    if (url.pathname.startsWith("/exports/")) return serveFile(res, join(EXPORTS, basename(url.pathname)));
    // Editor build, with SPA fallback.
    const file = join(EDITOR_DIST, url.pathname === "/" ? "index.html" : url.pathname);
    if (existsSync(file) && !statSync(file).isDirectory()) return serveFile(res, file);
    if (existsSync(join(EDITOR_DIST, "index.html"))) return serveFile(res, join(EDITOR_DIST, "index.html"));
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pictocity server is running. Build the editor (npm run build) to serve it here, or run it with vite for development.");
  } catch (e) {
    const status = (e as { status?: number }).status ?? (e instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(e);
    json(res, status, { error: (e as Error).message });
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
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { try { store.flush(); console.log(`${sig}: documents flushed, shutting down`); } finally { process.exit(0); } });

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
