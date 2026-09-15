#!/usr/bin/env node
// MCP server for pictocity. Talks to the document server over HTTP, so the agent
// edits the same live document the human has open in the editor.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  makeText, makeShape, makeImage, makeFill, makeGroup, makeAdjustment, makeBrush, cloneWithNewIds, findLayer, findParent, walk, layerBounds, addArtboardOps, artboards, copyToArtboardOps, textPathPreset, captureComp, applyCompOps, combineShapes, shapeToAnchors, anchorsToPath, CUSTOM_SHAPES, PLATFORM_SPECS,
  BLEND_MODES, type AdDocument, type Layer, type Op,
} from "@pictocity/core";

const BASE = process.env.PICTOCITY_URL ?? "http://localhost:4100";
const ACTOR = `agent:${process.env.PICTOCITY_AGENT ?? "claude"}`;
const TOKEN = process.env.PICTOCITY_TOKEN ?? "";
const AUTH: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", ...AUTH, ...(init?.headers as Record<string, string> | undefined) } }); }
  catch (e) { throw new Error(`Cannot reach the pictocity server at ${BASE} (${(e as Error).message}). Start it with: npm run server`); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `${r.status} ${r.statusText}`);
  return body as T;
}

const getDoc = (id: string) => api<AdDocument>(`/api/docs/${id}`);
const sendOps = (docId: string, ops: Op[], label: string) => api<{ rev: number }>(`/api/docs/${docId}/ops`, { method: "POST", body: JSON.stringify({ ops, actor: ACTOR, label }) });

/** Accept a layer id or a (case-insensitive) layer name. */
/**
 * Resolve a layer reference: an id, a unique name, or "Artboard name/Layer name" when the same name exists in several
 * artboards (the normal case in an ad set). Ambiguous names fail loudly with the candidates instead of picking one.
 */
function resolveLayer(doc: AdDocument, ref: string): Layer {
  const byId = findLayer(doc, ref);
  if (byId) return byId;
  const abOf = (id: string) => artboards(doc).find((a) => [...walk(a.children)].some((w) => w.layer.id === id));
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const abName = ref.slice(0, slash).trim().toLowerCase(), name = ref.slice(slash + 1).trim().toLowerCase();
    const ab = artboards(doc).find((a) => a.name.toLowerCase() === abName || a.id === ref.slice(0, slash).trim());
    if (!ab) throw new Error(`No artboard "${ref.slice(0, slash)}". Artboards: ${artboards(doc).map((a) => a.name).join(", ") || "none"}`);
    const hits = [...walk(ab.children)].map((w) => w.layer).filter((l) => l.name.toLowerCase() === name);
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`No layer "${ref.slice(slash + 1)}" in artboard "${ab.name}"`);
    throw new Error(`"${ref}" matches ${hits.length} layers: ${hits.map((l) => l.id).join(", ")} - use an id`);
  }
  const lower = ref.toLowerCase();
  const hits = [...walk(doc.layers)].map((w) => w.layer).filter((l) => l.name.toLowerCase() === lower);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`"${ref}" is ambiguous (${hits.length} layers): ${hits.map((l) => { const ab = abOf(l.id); return `${ab ? `${ab.name}/${l.name}` : l.name} (id ${l.id})`; }).join("; ")}. Use "Artboard/Name" or the id. Linked layers can be edited together by editing any one of them.`);
  throw new Error(`No layer with id or name "${ref}". Use get_document or search_layers to list layers.`);
}

function summarize(doc: AdDocument, full = false) {
  const abs = artboards(doc);
  const lines: string[] = [`${doc.name}  ${doc.width}x${doc.height}  bg=${doc.background ?? "transparent"}  rev=${doc.rev}  id=${doc.id}${abs.length ? `  artboards=${abs.map((a) => `${a.name}@${a.x},${a.y} ${a.width}x${a.height}`).join("; ")}` : ""}${doc.comps?.length ? `  comps=${doc.comps.map((c) => c.name).join(", ")}` : ""}${doc.animation ? `  animation=${doc.animation.duration}ms@${doc.animation.fps}fps tracks=${Object.keys(doc.animation.tracks).length}` : ""}`, "layers (bottom to top; indented = inside group):"];
  for (const { layer: l, depth } of walk(doc.layers)) {
    const b = layerBounds(l);
    const bits = [`${l.type}`, `id=${l.id}`, `at ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`];
    if (!l.visible) bits.push("hidden"); if (l.locked) bits.push("locked");
    if (l.opacity !== 1) bits.push(`opacity=${l.opacity}`); if (l.blend !== "normal") bits.push(`blend=${l.blend}`);
    if (l.rotation) bits.push(`rot=${l.rotation}`);
    if (l.type === "text") bits.push(`"${l.text.replace(/\n/g, "\\n").slice(0, 60)}" ${l.fontFamily} ${l.fontSize}px ${l.color}`);
    if (l.type === "shape") bits.push(`${l.shape} fill=${l.fill} stroke=${l.strokeColor ?? "none"}`);
    if (l.type === "image") bits.push(`asset=${l.assetId} fit=${l.fit}`);
    if (l.type === "brush") bits.push(`${l.strokes.length} strokes`);
    if (l.type === "group" && l.artboard) bits.unshift("ARTBOARD");
    if (l.mask) bits.push(`mask=${l.mask.kind}`);
    if (l.styles) bits.push(`fx=${Object.entries(l.styles).filter(([, v]) => v?.enabled).map(([k]) => k).join("+") || "none"}`);
    if (l.tags?.length) bits.push(`tags=${l.tags.join(",")}`);
    if (l.linkId) bits.push(`link=${l.linkId}`);
    if (l.clipToBelow) bits.push("clipped-to-below");
    lines.push(`${"  ".repeat(depth)}- ${l.name}  [${bits.join("  ")}]`);
  }
  const assets = Object.values(doc.assets);
  if (assets.length) lines.push("assets:", ...assets.map((a) => `- ${a.id}  ${a.name}  ${a.width}x${a.height}`));
  return full ? lines.join("\n") + "\n\nfull json:\n" + JSON.stringify(doc) : lines.join("\n");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// ---- Schemas -----------------------------------------------------------------------

const blend = z.enum(BLEND_MODES as [string, ...string[]]);
const common = {
  name: z.string().optional(),
  x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
  rotation: z.number().optional().describe("degrees"), scaleX: z.number().optional(), scaleY: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(), blend: blend.optional(), visible: z.boolean().optional(), locked: z.boolean().optional(),
  tags: z.array(z.string()).optional().describe('semantic tags like "headline", "cta", "logo", "product"'),
  styles: z.object({
    dropShadow: z.object({ enabled: z.boolean(), color: z.string(), blur: z.number(), x: z.number(), y: z.number(), opacity: z.number() }).optional(),
    stroke: z.object({ enabled: z.boolean(), color: z.string(), size: z.number(), position: z.enum(["outside", "inside", "center"]) }).optional(),
    innerShadow: z.object({ enabled: z.boolean(), color: z.string(), blur: z.number(), x: z.number(), y: z.number(), opacity: z.number() }).optional(),
    outerGlow: z.object({ enabled: z.boolean(), color: z.string(), size: z.number(), opacity: z.number() }).optional(),
    innerGlow: z.object({ enabled: z.boolean(), color: z.string(), size: z.number(), opacity: z.number() }).optional(),
    colorOverlay: z.object({ enabled: z.boolean(), color: z.string(), opacity: z.number(), blend }).optional(),
    gradientOverlay: z.object({ enabled: z.boolean(), from: z.string(), to: z.string(), angle: z.number(), opacity: z.number(), blend }).optional(),
    bevel: z.object({ enabled: z.boolean(), size: z.number(), depth: z.number(), angle: z.number(), highlight: z.string(), shadow: z.string(), opacity: z.number() }).optional(),
    patternOverlay: z.object({ enabled: z.boolean(), assetId: z.string(), scale: z.number(), opacity: z.number(), blend }).optional().describe("tile an imported image over the layer's pixels"),
  }).optional().describe("Photoshop-style layer effects (fx)"),
  fillOpacity: z.number().min(0).max(1).optional().describe("opacity of the layer's own pixels, effects unaffected (Photoshop Fill)"),
  clipToBelow: z.boolean().optional().describe("clipping mask: show only where the nearest non-clipped layer below has pixels (photo clipped into a shape or text)"),
  quad: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]).optional().describe("distort/perspective/skew: offsets of the corners TL,TR,BR,BL in layer pixels, e.g. [0,0, 0,40, 0,-40, 0,0] tilts the right edge"),
  filters: z.object({ blur: z.number().optional(), brightness: z.number().optional(), contrast: z.number().optional(), saturate: z.number().optional(), hueRotate: z.number().optional(), grayscale: z.number().optional(), sepia: z.number().optional(), invert: z.number().optional(), noise: z.number().optional().describe("film grain 0..1"),
    vibrance: z.number().optional().describe("-1..1"), exposure: z.object({ exposure: z.number(), offset: z.number(), gamma: z.number() }).optional(),
    colorBalance: z.object({ shadows: z.tuple([z.number(), z.number(), z.number()]), midtones: z.tuple([z.number(), z.number(), z.number()]), highlights: z.tuple([z.number(), z.number(), z.number()]), preserveLuminosity: z.boolean().optional() }).optional().describe("cyan-red, magenta-green, yellow-blue -100..100 per tone range"),
    blackWhite: z.object({ reds: z.number(), yellows: z.number(), greens: z.number(), cyans: z.number(), blues: z.number(), magentas: z.number(), tint: z.string().optional() }).optional().describe("Photoshop Black & White; 50 = neutral"),
    photoFilter: z.object({ color: z.string(), density: z.number(), preserveLuminosity: z.boolean().optional() }).optional(),
    gradientMap: z.object({ stops: z.array(z.object({ pos: z.number(), color: z.string() })), reverse: z.boolean().optional() }).optional(),
    channelMixer: z.object({ r: z.tuple([z.number(), z.number(), z.number(), z.number()]), g: z.tuple([z.number(), z.number(), z.number(), z.number()]), b: z.tuple([z.number(), z.number(), z.number(), z.number()]), monochrome: z.boolean().optional() }).optional().describe("each output = r,g,b weights + constant, 1 = 100%"),
    threshold: z.number().optional(), posterize: z.number().optional(), shadowsHighlights: z.object({ shadows: z.number(), highlights: z.number() }).optional(), colorize: z.object({ hue: z.number(), saturation: z.number(), lightness: z.number() }).optional(),
    unsharp: z.object({ amount: z.number(), radius: z.number() }).optional(), motionBlur: z.object({ angle: z.number(), distance: z.number() }).optional(), pixelate: z.number().optional(), emboss: z.number().optional(), findEdges: z.number().optional(),
    levels: z.object({ inBlack: z.number(), inWhite: z.number(), gamma: z.number(), outBlack: z.number(), outWhite: z.number() }).optional(),
    curves: z.object({ rgb: z.array(z.tuple([z.number(), z.number()])).optional(), r: z.array(z.tuple([z.number(), z.number()])).optional(), g: z.array(z.tuple([z.number(), z.number()])).optional(), b: z.array(z.tuple([z.number(), z.number()])).optional() }).optional().describe("control points [input, output] 0-255") }).optional(),
  mask: z.union([
    z.object({ kind: z.literal("shape"), shape: z.enum(["rect", "ellipse"]), x: z.number(), y: z.number(), width: z.number(), height: z.number(), radius: z.number().optional(), feather: z.number().optional(), inverted: z.boolean().optional() }),
    z.object({ kind: z.literal("raster"), assetId: z.string(), inverted: z.boolean().optional() }),
    z.object({ kind: z.literal("paint"), base: z.enum(["show", "hide"]), strokes: z.array(z.object({ points: z.array(z.number()), size: z.number(), color: z.string().optional(), opacity: z.number().optional(), hardness: z.number().optional(), erase: z.boolean().optional() })), inverted: z.boolean().optional() }),
  ]).optional().describe("layer mask in layer-local coordinates (0,0 = layer top-left). paint masks: strokes reveal, erase strokes hide"),
};

const layerSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), fontFamily: z.string().optional(), fontSize: z.number().optional(), fontWeight: z.union([z.number(), z.enum(["normal", "bold"])]).optional(), fontStyle: z.enum(["normal", "italic"]).optional(), color: z.string().optional(), align: z.enum(["left", "center", "right", "justify"]).optional(), verticalAlign: z.enum(["top", "middle", "bottom"]).optional(), lineHeight: z.number().optional(), letterSpacing: z.number().optional(), textTransform: z.enum(["none", "uppercase", "lowercase"]).optional(), underline: z.boolean().optional(), strikethrough: z.boolean().optional(), vertical: z.boolean().optional().describe("vertical type, characters stacked"), wrap: z.boolean().optional(), kerning: z.boolean().optional(), baselineShift: z.number().optional(), textScaleX: z.number().optional().describe("horizontal glyph scale, 1 = 100%"), textScaleY: z.number().optional(),
    runs: z.array(z.object({ start: z.number().int(), end: z.number().int(), color: z.string().optional(), fontWeight: z.union([z.number(), z.enum(["normal", "bold"])]).optional(), fontStyle: z.enum(["normal", "italic"]).optional(), underline: z.boolean().optional(), fontFamily: z.string().optional() })).optional().describe("style character ranges [start,end) - e.g. colour one word of the headline"),
    onPath: z.object({ preset: z.enum(["arc-up", "arc-down", "circle"]).optional().describe("arc over the top of the box, along the bottom, or a full circle"), path: z.string().optional().describe("custom SVG path in a 0..1 box"), align: z.enum(["start", "center", "end"]).optional(), offset: z.number().optional().describe("0..1 start position along the path"), flip: z.boolean().optional() }).optional().describe("set text on a path; the layer box is the path's bounding box"), ...common }),
  z.object({ type: z.literal("shape"), shape: z.enum(["rect", "ellipse", "line", "polygon", "star", "path"]).optional(), preset: z.enum(["arrow", "double-arrow", "heart", "speech-bubble", "check", "cross", "bolt", "seal", "triangle", "diamond", "hexagon", "ribbon"]).optional().describe("built-in custom shape (sets shape=path with its outline)"), fill: z.string().nullable().optional(), strokeColor: z.string().nullable().optional(), strokeWidth: z.number().optional(), radius: z.number().optional(), radii: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("per-corner radii tl,tr,br,bl"), sides: z.number().optional(), innerRadius: z.number().optional(), path: z.string().optional().describe("SVG path in a 0..1 box"), dash: z.array(z.number()).optional().describe("dash pattern e.g. [8,4]"), arrows: z.enum(["none", "start", "end", "both"]).optional().describe("arrowheads on line shapes"), ...common }),
  z.object({ type: z.literal("image"), assetId: z.string(), fit: z.enum(["fill", "contain", "cover"]).optional(), crop: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(), ...common }),
  z.object({ type: z.literal("fill"), fill: z.union([z.object({ kind: z.literal("solid"), color: z.string() }), z.object({ kind: z.literal("linear"), from: z.string(), to: z.string(), angle: z.number(), stops: z.tuple([z.number(), z.number()]).optional().describe("0..1 positions of from/to along the gradient") }), z.object({ kind: z.literal("radial"), from: z.string(), to: z.string() }), z.object({ kind: z.literal("pattern"), assetId: z.string(), scale: z.number() }), z.object({ kind: z.literal("gradient"), type: z.enum(["linear", "radial", "angle", "reflected", "diamond"]), angle: z.number(), stops: z.array(z.object({ pos: z.number(), color: z.string(), opacity: z.number().optional() })), scale: z.number().optional(), reverse: z.boolean().optional() }).describe("multi-stop gradient with transparency in any Photoshop style")]).optional(), ...common }),
  z.object({ type: z.literal("adjustment"), adjustment: z.object({ blur: z.number().optional(), brightness: z.number().optional(), contrast: z.number().optional(), saturate: z.number().optional(), hueRotate: z.number().optional(), grayscale: z.number().optional(), sepia: z.number().optional(), invert: z.number().optional(), noise: z.number().optional(),
    vibrance: z.number().optional().describe("-1..1"), exposure: z.object({ exposure: z.number(), offset: z.number(), gamma: z.number() }).optional(),
    colorBalance: z.object({ shadows: z.tuple([z.number(), z.number(), z.number()]), midtones: z.tuple([z.number(), z.number(), z.number()]), highlights: z.tuple([z.number(), z.number(), z.number()]), preserveLuminosity: z.boolean().optional() }).optional().describe("cyan-red, magenta-green, yellow-blue -100..100 per tone range"),
    blackWhite: z.object({ reds: z.number(), yellows: z.number(), greens: z.number(), cyans: z.number(), blues: z.number(), magentas: z.number(), tint: z.string().optional() }).optional().describe("Photoshop Black & White; 50 = neutral"),
    photoFilter: z.object({ color: z.string(), density: z.number(), preserveLuminosity: z.boolean().optional() }).optional(),
    gradientMap: z.object({ stops: z.array(z.object({ pos: z.number(), color: z.string() })), reverse: z.boolean().optional() }).optional(),
    channelMixer: z.object({ r: z.tuple([z.number(), z.number(), z.number(), z.number()]), g: z.tuple([z.number(), z.number(), z.number(), z.number()]), b: z.tuple([z.number(), z.number(), z.number(), z.number()]), monochrome: z.boolean().optional() }).optional().describe("each output = r,g,b weights + constant, 1 = 100%"),
    threshold: z.number().optional(), posterize: z.number().optional(), shadowsHighlights: z.object({ shadows: z.number(), highlights: z.number() }).optional(), colorize: z.object({ hue: z.number(), saturation: z.number(), lightness: z.number() }).optional(),
    unsharp: z.object({ amount: z.number(), radius: z.number() }).optional(), motionBlur: z.object({ angle: z.number(), distance: z.number() }).optional(), pixelate: z.number().optional(), emboss: z.number().optional(), findEdges: z.number().optional(),
    levels: z.object({ inBlack: z.number(), inWhite: z.number(), gamma: z.number(), outBlack: z.number(), outWhite: z.number() }).optional(),
    curves: z.object({ rgb: z.array(z.tuple([z.number(), z.number()])).optional(), r: z.array(z.tuple([z.number(), z.number()])).optional(), g: z.array(z.tuple([z.number(), z.number()])).optional(), b: z.array(z.tuple([z.number(), z.number()])).optional() }).optional() }), ...common }),
  z.object({ type: z.literal("brush"), strokes: z.array(z.object({ points: z.array(z.number()).describe("flat [x0,y0,x1,y1,...] in layer-local px"), size: z.number(), color: z.string(), opacity: z.number().optional(), hardness: z.number().optional(), erase: z.boolean().optional(), fill: z.boolean().optional().describe("treat points as a closed polygon and fill it"), rings: z.array(z.array(z.number())).optional().describe("with fill: several polygons / holes (even-odd)"), clipRings: z.array(z.array(z.number())).optional() })).optional().describe("freehand strokes; the layer defaults to the full canvas so points are document pixels"), ...common }),
  z.object({ type: z.literal("group"), ...common }),
]);

function resolveOnPath(props: Record<string, unknown>) {
  const op = props.onPath as { preset?: "arc-up" | "arc-down" | "circle"; path?: string } | null | undefined;
  if (op && !op.path && op.preset) props.onPath = { ...op, path: textPathPreset(op.preset) };
  if (op && !op.path && !op.preset) props.onPath = null;
}

function buildLayer(doc: AdDocument, spec: z.infer<typeof layerSpec>): Layer {
  const { type, ...rest } = spec as Record<string, unknown> & { type: string };
  resolveOnPath(rest);
  switch (type) {
    case "text": return makeText(rest as never);
    case "shape": { const r = rest as { preset?: string; path?: string; shape?: string }; if (r.preset && CUSTOM_SHAPES[r.preset]) { r.path = CUSTOM_SHAPES[r.preset]; r.shape = "path"; delete r.preset; } return makeShape(rest as never); }
    case "image": {
      const a = doc.assets[(rest as { assetId: string }).assetId];
      if (!a) throw new Error(`Unknown assetId ${(rest as { assetId: string }).assetId}; import_asset first`);
      return makeImage({ width: a.width, height: a.height, ...(rest as object) } as never);
    }
    case "fill": return makeFill({ width: doc.width, height: doc.height, ...(rest as object) } as never);
    case "adjustment": return makeAdjustment({ width: doc.width, height: doc.height, ...(rest as object) } as never);
    case "group": return makeGroup(rest as never);
    case "brush": {
      const r = rest as { strokes?: Partial<import("@pictocity/core").BrushStroke>[] };
      return makeBrush({ width: doc.width, height: doc.height, ...(rest as object), strokes: (r.strokes ?? []).map((st) => ({ opacity: 1, hardness: 1, ...st })) } as never);
    }
  }
  throw new Error(`unknown layer type ${type}`);
}

// ---- Server --------------------------------------------------------------------------

const server = new McpServer({ name: "pictocity", version: "0.1.0" });

server.registerTool("list_documents", { description: "List ad documents on the pictocity server." }, async () => {
  const docs = await api<{ id: string; name: string; width: number; height: number; rev: number; updatedAt: string }[]>("/api/docs");
  return text(docs.length ? docs.map((d) => `${d.id}  ${d.name}  ${d.width}x${d.height}  rev ${d.rev}  ${d.updatedAt}`).join("\n") : "No documents yet. Use create_document.");
});

server.registerTool("list_presets", { description: "Common ad sizes (Instagram, story, banner sizes...) to pass to create_document." }, async () => {
  const p = await api<{ name: string; width: number; height: number }[]>("/api/presets");
  return text(p.map((x) => `${x.name}: ${x.width}x${x.height}`).join("\n"));
});

server.registerTool("install_font", {
  description: "Install a .ttf/.otf font on the server from a file path or URL so both the editor and the exporter can use it. Returns the family name to use in fontFamily.",
  inputSchema: { path: z.string().optional(), url: z.string().optional(), name: z.string().optional() },
}, async (a) => {
  const r = await api<{ family: string; file: string }>("/api/fonts", { method: "POST", body: JSON.stringify(a) });
  return text(`Installed ${r.file} as family "${r.family}"`);
});

server.registerTool("list_fonts", { description: "Font families available to the renderer. Drop .ttf/.otf files in the server's fonts/ folder to add more." }, async () => text((await api<string[]>("/api/fonts")).join(", ")));

server.registerTool("create_document", {
  description: "Create a new ad document. Coordinates are document pixels with (0,0) top-left.",
  inputSchema: { name: z.string(), width: z.number().int().positive(), height: z.number().int().positive(), background: z.string().nullable().optional().describe("CSS color or null for transparent; default #ffffff"), linearBlending: z.boolean().optional().describe("blend gradients and blurs in linear light (cleaner gradient midpoints, no dark blur halos); default off like Photoshop") },
}, async ({ linearBlending, ...a }) => {
  const d = await api<AdDocument>("/api/docs", { method: "POST", body: JSON.stringify(a) });
  if (linearBlending) await sendOps(d.id, [{ type: "doc.set", props: { linearBlending: true } }], "Linear blending");
  return text(`Created ${d.id} (${d.width}x${d.height})${linearBlending ? ", linear-light blending" : ""}. Open in the editor: ${BASE}/?doc=${d.id}`);
});

server.registerTool("get_document", {
  description: "Layer tree with ids, positions and key properties. Call this before editing so you use real layer ids. full=true returns the raw JSON.",
  inputSchema: { docId: z.string(), full: z.boolean().optional() },
}, async ({ docId, full }) => text(summarize(await getDoc(docId), full)));

server.registerTool("search_layers", {
  description: "Find layers by name, tag, type or text content (case-insensitive substring). Returns id, name, type, artboard and position for each match.",
  inputSchema: { docId: z.string(), query: z.string(), type: z.string().optional() },
}, async ({ docId, query, type }) => {
  const doc = await getDoc(docId);
  const q = query.toLowerCase();
  const hits: string[] = [];
  for (const { layer: l } of walk(doc.layers)) {
    if (type && l.type !== type) continue;
    const hay = [l.name, l.type, ...(l.tags ?? []), l.type === "text" ? l.text : ""].join(" ").toLowerCase();
    if (!hay.includes(q)) continue;
    const b = layerBounds(l);
    const ab = artboards(doc).find((a) => [...walk(a.children)].some((w) => w.layer.id === l.id));
    hits.push(`${l.name}  [${l.type}  id=${l.id}${ab ? `  artboard=${ab.name}` : ""}  at ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}${l.type === "text" ? `  "${l.text.replace(/\n/g, "\\n").slice(0, 50)}"` : ""}]`);
  }
  return text(hits.length ? hits.join("\n") : "No layers match.");
});

server.registerTool("replace_text", {
  description: "Find and replace inside every text layer (or only those matching layerFilter by name/tag). Case-sensitive unless ignoreCase. Returns how many layers changed. Linked layers update through their links.",
  inputSchema: { docId: z.string(), find: z.string(), replace: z.string(), ignoreCase: z.boolean().optional(), layerFilter: z.string().optional() },
}, async ({ docId, find, replace, ignoreCase, layerFilter }) => {
  const doc = await getDoc(docId);
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "gi" : "g");
  const f = layerFilter?.toLowerCase();
  const ops: Op[] = [];
  for (const { layer: l } of walk(doc.layers)) {
    if (l.type !== "text" || l.locked) continue;
    if (f && !(l.name.toLowerCase().includes(f) || (l.tags ?? []).some((t) => t.toLowerCase().includes(f)))) continue;
    const next = l.text.replace(re, replace);
    if (next !== l.text) ops.push({ type: "layer.set", id: l.id, props: { text: next } });
  }
  if (!ops.length) return text("No text layers contained that.");
  const r = await sendOps(docId, ops, `Replace "${find}"`);
  return text(`Changed ${ops.length} text layer(s), rev ${r.rev}`);
});

server.registerTool("combine_shapes", {
  description: "Combine two or more shape layers into one path shape: union (unite), subtract (front shapes cut from the bottom one), intersect, or exclude (xor). The originals are replaced unless keepOriginals is true. Layers are combined bottom to top in stack order.",
  inputSchema: { docId: z.string(), layerIds: z.array(z.string()).min(2), op: z.enum(["union", "subtract", "intersect", "exclude"]), keepOriginals: z.boolean().optional() },
}, async ({ docId, layerIds, op, keepOriginals }) => {
  const doc = await getDoc(docId);
  const layers = layerIds.map((ref) => resolveLayer(doc, ref));
  if (layers.some((l) => l.type !== "shape")) throw new Error("All layers must be shape layers");
  // Stack order: bottom first.
  const order = [...walk(doc.layers)].map((w) => w.layer.id);
  const sorted = [...layers].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) as import("@pictocity/core").ShapeLayer[];
  const result = combineShapes(sorted, op);
  if (!result) throw new Error("The result is empty");
  const top = findParent(doc, sorted[sorted.length - 1].id)!;
  const ops: Op[] = [{ type: "layer.add", layer: result, parentId: top.parent?.id ?? null, index: top.index + 1 }];
  if (!keepOriginals) for (const l of sorted) ops.push({ type: "layer.remove", id: l.id });
  const r = await sendOps(docId, ops, `Combine shapes (${op})`);
  return text(`Created "${result.name}" id=${result.id} (${result.width}x${result.height} at ${result.x},${result.y}), rev ${r.rev}`);
});

server.registerTool("convert_to_path", {
  description: "Turn a rect / ellipse / polygon / star shape into an editable path shape (anchors with handles) so its outline can be reshaped.",
  inputSchema: { docId: z.string(), layerId: z.string() },
}, async ({ docId, layerId }) => {
  const doc = await getDoc(docId);
  const l = resolveLayer(doc, layerId);
  if (l.type !== "shape") throw new Error("Not a shape layer");
  const anchors = shapeToAnchors(l);
  if (!anchors) throw new Error("This shape can't be converted");
  const r = await sendOps(docId, [{ type: "layer.set", id: l.id, props: { shape: "path", path: anchorsToPath(anchors) } }], `Convert ${l.name} to path`);
  return text(`"${l.name}" is now a path with ${anchors.length} anchors (rev ${r.rev})`);
});

server.registerTool("set_keyframes", {
  description: "Animate a layer for banner export: replace its keyframes (time in ms; x, y, opacity, rotation, scaleX, scaleY, visible; ease per keyframe). Also sets the timeline's fps/duration/loop when given. Export with export_document {format: 'gif'} or {format: 'html'}.",
  inputSchema: { docId: z.string(), layerId: z.string().describe("layer id, unique layer name, or \"Artboard name/Layer name\""), keyframes: z.array(z.object({ t: z.number(), x: z.number().optional(), y: z.number().optional(), opacity: z.number().optional(), rotation: z.number().optional(), scaleX: z.number().optional(), scaleY: z.number().optional(), visible: z.boolean().optional(), ease: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).optional() })), fps: z.number().optional(), duration: z.number().optional().describe("ms"), loop: z.boolean().optional() },
}, async ({ docId, layerId, keyframes, fps, duration, loop }) => {
  const doc = await getDoc(docId);
  const l = resolveLayer(doc, layerId);
  const anim = { fps: fps ?? doc.animation?.fps ?? 12, duration: duration ?? doc.animation?.duration ?? Math.max(1000, ...keyframes.map((k) => k.t)), loop: loop ?? doc.animation?.loop ?? true, tracks: { ...(doc.animation?.tracks ?? {}), [l.id]: keyframes } };
  const r = await sendOps(docId, [{ type: "doc.set", props: { animation: anim } }], `Keyframes for ${l.name}`);
  return text(`${keyframes.length} keyframe(s) on "${l.name}"; timeline ${anim.duration} ms @ ${anim.fps} fps (rev ${r.rev})`);
});

server.registerTool("save_comp", {
  description: "Save the current visibility, positions, opacities and text of all layers as a named layer comp (A/B headline, language variant...). Saving with an existing name updates that comp.",
  inputSchema: { docId: z.string(), name: z.string() },
}, async ({ docId, name }) => {
  const doc = await getDoc(docId);
  const existing = (doc.comps ?? []).find((c) => c.name.toLowerCase() === name.toLowerCase());
  const comp = captureComp(doc, name, existing?.id);
  const comps = existing ? (doc.comps ?? []).map((c) => (c.id === existing.id ? comp : c)) : [...(doc.comps ?? []), comp];
  const r = await sendOps(docId, [{ type: "doc.set", props: { comps } }], `Save comp ${name}`);
  return text(`${existing ? "Updated" : "Saved"} comp "${name}" id=${comp.id} (${Object.keys(comp.states).length} layers, rev ${r.rev}). Export it with export_document {comp: "${name}"} or all comps with {allComps: true}.`);
});

server.registerTool("apply_comp", {
  description: "Restore a saved layer comp (by name or id) - visibility, positions, opacities, text.",
  inputSchema: { docId: z.string(), comp: z.string() },
}, async ({ docId, comp }) => {
  const doc = await getDoc(docId);
  const c = (doc.comps ?? []).find((x) => x.id === comp || x.name.toLowerCase() === comp.toLowerCase());
  if (!c) throw new Error(`No comp "${comp}". Comps: ${(doc.comps ?? []).map((x) => x.name).join(", ") || "none"}`);
  const ops = applyCompOps(doc, c);
  if (!ops.length) return text(`Comp "${c.name}" already applied.`);
  const r = await sendOps(docId, ops, `Apply comp ${c.name}`);
  return text(`Applied "${c.name}": ${ops.length} layer(s) changed, rev ${r.rev}`);
});

server.registerTool("check_spec", {
  description: "Check a document or artboard against a platform's rules before exporting: accepted sizes/aspects, UI safe zones (text/CTA/logo inside), text coverage, minimum legible font size, text/background contrast, CTA present, export weight. Platforms: " + Object.entries(PLATFORM_SPECS).map(([k, v]) => `${k} (${v.name})`).join(", ") + ". Returns issues with severities and a 0-100 score. Fix errors before export; warnings are judgement calls.",
  inputSchema: { docId: z.string(), platform: z.enum(Object.keys(PLATFORM_SPECS) as [string, ...string[]]), artboard: z.string().optional().describe("artboard id or name; omit for the whole canvas"), weigh: z.boolean().optional().describe("also render png/jpg to check file weight (slower)") },
}, async ({ docId, platform, artboard, weigh }) => {
  const doc = await getDoc(docId); const ab = artboard ? resolveLayer(doc, artboard) : undefined;
  const q = new URLSearchParams({ platform }); if (ab) q.set("artboard", ab.id); if (weigh) q.set("weigh", "true");
  const r = await api<{ platform: { name: string; notes?: string }; issues: { severity: string; code: string; message: string }[]; score: number }>(`/api/docs/${docId}/spec?${q}`);
  const lines = [`${r.platform.name}${ab ? ` · ${ab.name}` : ""}: score ${r.score}/100${r.platform.notes ? `  (${r.platform.notes})` : ""}`, ...r.issues.map((i) => `${i.severity.toUpperCase().padEnd(7)} ${i.code}: ${i.message}`)];
  if (!r.issues.length) lines.push("No issues.");
  return text(lines.join("\n"));
});

server.registerTool("get_brand", { description: "The brand kit shared by all documents: colours, fonts, logo, voice rules, do/don'ts, audio identity. Read it before designing; use its colours and fonts." }, async () => {
  const b = await api<Record<string, unknown>>("/api/brand"); return text(JSON.stringify(b, null, 1));
});
server.registerTool("set_brand", { description: "Create or update the brand kit: {name, colors:[{name,hex,role}], fonts:[{family,role,weight}], logoAssetSrc, voice, rules:[...], audio:{targetLufs, sonicLogoAssetSrc}}. Fields you pass replace the existing ones.", inputSchema: { brand: z.record(z.any()) } }, async ({ brand }) => {
  const cur = await api<Record<string, unknown>>("/api/brand"); const next = { ...cur, ...brand }; await api("/api/brand", { method: "POST", body: JSON.stringify(next) }); return text(`Brand kit saved (${Object.keys(next).join(", ")}). Swatches in the editor now show its colours.`);
});

server.registerTool("get_layer", {
  description: "Full JSON of one layer (by id or name), including strokes, mask, styles and filters.",
  inputSchema: { docId: z.string(), layerId: z.string() },
}, async ({ docId, layerId }) => text(JSON.stringify(resolveLayer(await getDoc(docId), layerId), null, 1)));

server.registerTool("apply_ops", {
  description: "Advanced: apply raw document operations in one undoable batch. Op types: layer.add {layer,parentId,index}, layer.set {id,props}, layer.remove {id}, layer.move {id,parentId,index}, layer.push {id,key,items} (append to a list such as strokes), layer.splice {id,key,index,count,items}, doc.set {props}, asset.add {asset}. Prefer the specific tools when they fit.",
  inputSchema: { docId: z.string(), ops: z.array(z.record(z.any())), label: z.string().optional() },
}, async ({ docId, ops, label }) => {
  const r = await sendOps(docId, ops as unknown as Op[], label ?? `Apply ${ops.length} ops`);
  return text(`Applied ${ops.length} op(s), rev ${r.rev}`);
});

server.registerTool("add_layer", {
  description: `Add a layer. Types: text, shape, image (needs an assetId from import_asset), fill (solid/gradient, defaults to full document), adjustment (filters everything below it), group. Layers stack bottom-to-top; index -1 (default) = on top. Set parentId to add inside a group. Text layers wrap inside width unless wrap=false. Effects go in styles; masks in mask.`,
  inputSchema: { docId: z.string(), layer: layerSpec, parentId: z.string().nullable().optional(), index: z.number().int().optional() },
}, async ({ docId, layer, parentId, index }) => {
  const doc = await getDoc(docId);
  const built = buildLayer(doc, layer);
  const container = parentId ? (resolveLayer(doc, parentId) as { children?: Layer[] }).children : doc.layers;
  if (parentId && !container) throw new Error(`${parentId} is not a group`);
  const idx = index === undefined || index < 0 ? (container?.length ?? 0) : index;
  const r = await sendOps(docId, [{ type: "layer.add", layer: built, parentId: parentId ? resolveLayer(doc, parentId).id : null, index: idx }], `Add ${built.name}`);
  return text(`Added ${built.type} layer "${built.name}" id=${built.id} (rev ${r.rev})`);
});

server.registerTool("update_layer", {
  description: "Change properties on a layer (by id or name). Any field accepted by add_layer can be set: text, color, fontSize, x, y, width, height, rotation, opacity, blend, visible, locked, styles, filters, mask, fill, tags... Pass only the fields you want to change. To clear a mask or styles pass null.",
  inputSchema: { docId: z.string(), layerId: z.string().describe("layer id, unique layer name, or \"Artboard name/Layer name\""), props: z.record(z.any()) },
}, async ({ docId, layerId, props }) => {
  const doc = await getDoc(docId);
  const l = resolveLayer(doc, layerId);
  resolveOnPath(props);
  const r = await sendOps(docId, [{ type: "layer.set", id: l.id, props }], `Edit ${l.name}`);
  return text(`Updated "${l.name}" (${Object.keys(props).join(", ")}) rev ${r.rev}`);
});

server.registerTool("remove_layer", { description: "Delete a layer (by id or name).", inputSchema: { docId: z.string(), layerId: z.string() } }, async ({ docId, layerId }) => {
  const doc = await getDoc(docId); const l = resolveLayer(doc, layerId);
  const r = await sendOps(docId, [{ type: "layer.remove", id: l.id }], `Delete ${l.name}`);
  return text(`Removed "${l.name}" rev ${r.rev}`);
});

server.registerTool("move_layer", {
  description: "Reorder a layer or move it into/out of a group. index is the position in the target list (0 = bottom, -1 = top). parentId null = document root.",
  inputSchema: { docId: z.string(), layerId: z.string().describe("layer id, unique layer name, or \"Artboard name/Layer name\""), parentId: z.string().nullable().optional(), index: z.number().int() },
}, async ({ docId, layerId, parentId, index }) => {
  const doc = await getDoc(docId); const l = resolveLayer(doc, layerId);
  const pid = parentId ? resolveLayer(doc, parentId).id : (parentId === null ? null : findParent(doc, l.id)!.parent?.id ?? null);
  const container = pid ? (findLayer(doc, pid) as { children: Layer[] }).children : doc.layers;
  const idx = index < 0 ? container.length : index;
  const r = await sendOps(docId, [{ type: "layer.move", id: l.id, parentId: pid, index: idx }], `Reorder ${l.name}`);
  return text(`Moved "${l.name}" to index ${idx} rev ${r.rev}`);
});

server.registerTool("duplicate_layer", { description: "Duplicate a layer (and its children) directly above the original.", inputSchema: { docId: z.string(), layerId: z.string().describe("layer id, unique layer name, or \"Artboard name/Layer name\""), offset: z.number().optional().describe("shift the copy by this many px in x and y") } }, async ({ docId, layerId, offset }) => {
  const doc = await getDoc(docId); const l = resolveLayer(doc, layerId);
  const loc = findParent(doc, l.id)!;
  const copy = cloneWithNewIds(l);
  if (offset) { copy.x += offset; copy.y += offset; }
  const r = await sendOps(docId, [{ type: "layer.add", layer: copy, parentId: loc.parent?.id ?? null, index: loc.index + 1 }], `Duplicate ${l.name}`);
  return text(`Duplicated as "${copy.name}" id=${copy.id} rev ${r.rev}`);
});

server.registerTool("import_asset", {
  description: "Import an image (PNG/JPG/WebP) into the document from a URL, a local file path on the server machine, or base64 data. Returns an assetId for add_layer type=image or for raster masks.",
  inputSchema: { docId: z.string(), url: z.string().optional(), path: z.string().optional(), base64: z.string().optional(), name: z.string().optional(), mime: z.string().optional() },
}, async ({ docId, ...rest }) => {
  const a = await api<{ id: string; name: string; width: number; height: number }>(`/api/docs/${docId}/assets`, { method: "POST", body: JSON.stringify(rest) });
  return text(`Imported ${a.name} as assetId=${a.id} (${a.width}x${a.height})`);
});

server.registerTool("render_preview", {
  description: "Render the document (or one layer on transparent, or one artboard) to a PNG you can look at. Use scale < 1 for a quick check (0.5 recommended) and to keep the image small.",
  inputSchema: { docId: z.string(), scale: z.number().positive().optional(), layerId: z.string().optional(), artboard: z.string().optional().describe("artboard id or name") },
}, async ({ docId, scale, layerId, artboard }) => {
  const doc = await getDoc(docId);
  const q = new URLSearchParams({ scale: String(scale ?? 0.5) });
  if (layerId) q.set("layer", resolveLayer(doc, layerId).id);
  if (artboard) q.set("artboard", resolveLayer(doc, artboard).id);
  const r = await fetch(`${BASE}/api/docs/${docId}/render.png?${q}`, { headers: AUTH });
  if (!r.ok) throw new Error(`render failed: ${r.status}`);
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return { content: [{ type: "image" as const, data: b64, mimeType: "image/png" }, { type: "text" as const, text: `rendered ${doc.name} at scale ${scale ?? 0.5} (rev ${doc.rev})` }] };
});

server.registerTool("export_document", {
  description: "Export to disk on the server machine and return the file path. png/jpg/webp are flattened images (scale 2 = 2x resolution); psd is a layered Photoshop file with groups, editable text, layer styles, masks and artboards. artboard exports just that artboard; allArtboards exports every artboard to its own file.",
  inputSchema: { docId: z.string(), format: z.enum(["png", "png8", "jpg", "webp", "avif", "gif", "tiff", "bmp", "pdf", "svg", "psd", "html", "mp4", "webm"]).optional().describe("png8 = palette PNG (small); gif = animated GIF of the timeline; pdf = one page (allArtboards → one page per artboard); html = HTML5 banner; mp4/webm = video of the timeline, optionally with `audio` (path or URL of a soundstudio render) muxed in"), fps: z.number().optional(), audio: z.string().optional().describe("for mp4/webm: audio file path or URL to mux (e.g. the soundstudio render URL)"), duration: z.number().optional().describe("for mp4/webm without a timeline: seconds of still video"), crf: z.number().optional(), transparent: z.boolean().optional().describe("ignore the canvas background colour"), colors: z.number().optional().describe("palette size for png8/gif"), dpi: z.number().optional().describe("pdf/tiff"), scale: z.number().positive().optional(), quality: z.number().min(1).max(100).optional(), path: z.string().optional().describe("absolute output path; defaults to data/exports/"), artboard: z.string().optional().describe("artboard id or name"), allArtboards: z.boolean().optional(), trim: z.boolean().optional().describe("crop the export to its non-transparent pixels (png/webp)"), comp: z.string().optional().describe("apply this layer comp before rendering"), allComps: z.boolean().optional().describe("export every layer comp to its own file") },
}, async ({ docId, allArtboards, allComps, ...rest }) => {
  if (rest.format === "pdf" && allArtboards) { const r = await api<{ path: string; url?: string; bytes: number; pages: number }>(`/api/docs/${docId}/export`, { method: "POST", body: JSON.stringify({ ...rest, artboards: true }) }); return text(`Exported ${r.pages}-page PDF to ${r.path} (${(r.bytes / 1024).toFixed(0)} KB)${r.url ? `\nURL: ${r.url.replace("http://localhost:4100", BASE)}` : ""}`); }
  if (allComps) {
    const r = await api<{ files: { name: string; path: string }[] }>(`/api/docs/${docId}/export`, { method: "POST", body: JSON.stringify({ ...rest, comps: true }) });
    return text(r.files.length ? r.files.map((f) => `${f.name}: ${f.path}`).join("\n") : "This document has no layer comps.");
  }
  if (allArtboards) {
    const r = await api<{ files: { name: string; path: string; width: number; height: number }[] }>(`/api/docs/${docId}/export`, { method: "POST", body: JSON.stringify({ ...rest, artboards: true }) });
    return text(r.files.length ? r.files.map((f) => `${f.name}: ${f.path} (${f.width}x${f.height})`).join("\n") : "This document has no artboards.");
  }
  const r = await api<{ path: string; url?: string; bytes: number; width: number; height: number }>(`/api/docs/${docId}/export`, { method: "POST", body: JSON.stringify(rest) });
  return text(`Exported ${r.width}x${r.height} to ${r.path} (${(r.bytes / 1024).toFixed(0)} KB)${r.url ? `\nURL: ${r.url.replace("http://localhost:4100", BASE)}` : ""}`);
});

server.registerTool("add_artboard", {
  description: "Add an artboard (a format such as 1080x1080 or 1080x1920) next to the existing ones. Layers added with parentId = the artboard id are clipped to it; positions stay in document pixels, so offset them by the artboard's x/y (see get_document). For the first artboard, adoptExisting: true moves the document's current layers into it (\"artboard from layers\"). Then copy_to_artboard builds the other formats. Export one with export_document {artboard} or all with {allArtboards: true}.",
  inputSchema: { docId: z.string(), width: z.number().int().positive(), height: z.number().int().positive(), name: z.string().optional(), background: z.string().nullable().optional(), adoptExisting: z.boolean().optional() },
}, async ({ docId, ...init }) => {
  const doc = await getDoc(docId);
  const { ops, artboard } = addArtboardOps(doc, init);
  const r = await sendOps(docId, ops, `New artboard ${artboard.name}`);
  return text(`Added artboard "${artboard.name}" id=${artboard.id} at ${artboard.x},${artboard.y} ${artboard.width}x${artboard.height} (rev ${r.rev}). Document is now ${Math.max(doc.width, artboard.x + artboard.width)}x${Math.max(doc.height, artboard.height)}.`);
});

server.registerTool("copy_to_artboard", {
  description: "Copy layers (by id or name) into another artboard, keeping their position relative to the source frame. fit=true scales them uniformly to the target size and centres them - the quick way to build every format from one design, then adjust per artboard.",
  inputSchema: { docId: z.string(), layerIds: z.array(z.string()).describe("layer ids, unique names, or \"Artboard/Name\" references"), artboard: z.string().describe("target artboard id or name"), fit: z.boolean().optional(), link: z.boolean().optional().describe("link copies to their originals so text, colours and effects stay in sync across formats") },
}, async ({ docId, layerIds, artboard, fit, link }) => {
  const doc = await getDoc(docId);
  const target = resolveLayer(doc, artboard);
  const ids = layerIds.map((ref) => resolveLayer(doc, ref).id);
  const { ops, newIds } = copyToArtboardOps(doc, ids, target.id, { fit, link });
  if (!ops.length) return text("Nothing to copy.");
  const r = await sendOps(docId, ops, `Copy to ${target.name}`);
  return text(`Copied ${newIds.length} layer(s) into "${target.name}"${fit ? " (scaled to fit)" : ""}: ${newIds.join(", ")} (rev ${r.rev})`);
});

server.registerTool("link_layers", {
  description: "Link layers so content edits (text, colours, fonts, effects, image) apply to all of them while position and size stay independent - like linked smart objects across artboards. unlink=true removes the link.",
  inputSchema: { docId: z.string(), layerIds: z.array(z.string()).describe("layer ids, unique names, or \"Artboard/Name\" references"), unlink: z.boolean().optional() },
}, async ({ docId, layerIds, unlink }) => {
  const doc = await getDoc(docId);
  const layers = layerIds.map((ref) => resolveLayer(doc, ref));
  const linkId = unlink ? null : (layers.find((l) => l.linkId)?.linkId ?? `link_${Date.now().toString(36)}`);
  const r = await sendOps(docId, layers.map((l) => ({ type: "layer.set" as const, id: l.id, props: { linkId } })), unlink ? "Unlink layers" : "Link layers");
  return text(`${unlink ? "Unlinked" : "Linked"} ${layers.map((l) => l.name).join(", ")} (rev ${r.rev})`);
});

server.registerTool("merge_layers", {
  description: "Merge (rasterise) layers into a single image layer with their effects baked in, like Layer > Merge / Rasterize. The originals are removed unless keepOriginals is true. Useful before running image tools on text or shapes.",
  inputSchema: { docId: z.string(), layerIds: z.array(z.string()).describe("layer ids, unique names, or \"Artboard/Name\" references"), name: z.string().optional(), keepOriginals: z.boolean().optional() },
}, async ({ docId, layerIds, name, keepOriginals }) => {
  const doc = await getDoc(docId);
  const ids = layerIds.map((ref) => resolveLayer(doc, ref).id);
  const r = await api<{ asset: { id: string; width: number; height: number }; x: number; y: number; width: number; height: number }>(`/api/docs/${docId}/rasterize`, { method: "POST", body: JSON.stringify({ layerIds: ids }) });
  const top = findParent(doc, ids[ids.length - 1])!;
  const layer = makeImage({ name: name ?? "Merged", assetId: r.asset.id, x: r.x, y: r.y, width: r.width, height: r.height, fit: "fill" });
  const ops: Op[] = [{ type: "layer.add", layer, parentId: top.parent?.id ?? null, index: top.index + 1 }];
  if (!keepOriginals) for (const id of ids) ops.push({ type: "layer.remove", id });
  const rr = await sendOps(docId, ops, "Merge layers");
  return text(`Merged ${ids.length} layer(s) into image layer "${layer.name}" id=${layer.id} (${r.width}x${r.height} at ${r.x},${r.y}), rev ${rr.rev}`);
});

server.registerTool("gc_assets", { description: "Delete image files on the server that no document references any more, and report the space freed." }, async () => {
  const r = await api<{ removed: number; bytes: number }>("/api/assets?gc", { method: "POST", body: "{}" });
  return text(`Removed ${r.removed} unused asset(s), ${(r.bytes / 1024).toFixed(0)} KB freed`);
});

server.registerTool("list_image_tools", { description: "Image tools that can be run on an image layer: built-in knockout_background plus anything configured in image-tools.json on the server (e.g. rembg, a Stable Diffusion script)." }, async () => {
  const tools = await api<{ name: string; description: string; params: Record<string, unknown>; builtin: boolean }[]>("/api/image-tools");
  return text(tools.map((t) => `${t.name}${t.builtin ? " (built-in)" : ""}: ${t.description}${Object.keys(t.params).length ? `  params=${JSON.stringify(t.params)}` : ""}`).join("\n"));
});

server.registerTool("process_image", {
  description: "Run an image tool on an image layer's picture. mode replace (default) swaps the layer's image for the result; mode new_layer adds the result as a new layer above the original. Returns the new assetId.",
  inputSchema: { docId: z.string(), layerId: z.string().describe("layer id, unique layer name, or \"Artboard name/Layer name\""), tool: z.string(), params: z.record(z.any()).optional(), mode: z.enum(["replace", "new_layer"]).optional() },
}, async ({ docId, layerId, tool, params, mode }) => {
  const doc = await getDoc(docId);
  const l = resolveLayer(doc, layerId);
  if (l.type !== "image") throw new Error(`"${l.name}" is not an image layer`);
  const asset = await api<{ id: string; width: number; height: number }>(`/api/docs/${docId}/process`, { method: "POST", body: JSON.stringify({ tool, assetId: l.assetId, params }) });
  if (mode === "new_layer") {
    const loc = findParent(doc, l.id)!;
    const copy = cloneWithNewIds(l); copy.name = `${l.name} (${tool})`; (copy as { assetId: string }).assetId = asset.id;
    const r = await sendOps(docId, [{ type: "layer.add", layer: copy, parentId: loc.parent?.id ?? null, index: loc.index + 1 }], `${tool} on ${l.name}`);
    return text(`Added "${copy.name}" id=${copy.id} with assetId=${asset.id} (rev ${r.rev})`);
  }
  const r = await sendOps(docId, [{ type: "layer.set", id: l.id, props: { assetId: asset.id } }], `${tool} on ${l.name}`);
  return text(`Replaced the image of "${l.name}" with assetId=${asset.id} (${asset.width}x${asset.height}, rev ${r.rev})`);
});

server.registerTool("create_variant", {
  description: "Copy a document at another size with the layout scaled to fit (centred, fonts and effects scaled; full-canvas backgrounds stretched). Use it to turn one ad into a set of formats, then fix up details per variant.",
  inputSchema: { docId: z.string(), width: z.number().int().positive(), height: z.number().int().positive(), name: z.string().optional(), scaleContent: z.boolean().optional().describe("false = only change the canvas size") },
}, async ({ docId, ...rest }) => {
  const d = await api<{ id: string; name: string; width: number; height: number }>(`/api/docs/${docId}/variant`, { method: "POST", body: JSON.stringify(rest) });
  return text(`Created variant "${d.name}" id=${d.id} (${d.width}x${d.height}). Open in the editor: ${BASE}/?doc=${d.id}`);
});

server.registerTool("import_svg", {
  description: "Import an SVG (path or URL, or inline svg text) as editable shape/text layers. With docId the layers are placed into that document as a group; without it a new document is created at the SVG's size. Gradients, images and filters inside the SVG are approximated or skipped.",
  inputSchema: { docId: z.string().optional(), path: z.string().optional(), url: z.string().optional(), svg: z.string().optional(), name: z.string().optional() },
}, async (a) => {
  const r = await api<{ id: string; name?: string; groupId?: string; layers: number; width?: number; height?: number }>("/api/docs/import-svg", { method: "POST", body: JSON.stringify(a) });
  return text(a.docId ? `Placed ${r.layers} layer(s) as group ${r.groupId} in ${r.id}` : `Created "${r.name}" id=${r.id} (${r.width}x${r.height}, ${r.layers} layers)`);
});

server.registerTool("import_psd", {
  description: "Create a new document from a Photoshop .psd file on the server machine. Groups, raster layers, text layers, layer styles, masks, opacity and blend modes are converted; adjustment/smart layers are rasterised or dropped.",
  inputSchema: { path: z.string(), name: z.string().optional() },
}, async ({ path, name }) => {
  const d = await api<{ id: string; name: string; width: number; height: number; layers: number }>("/api/docs/import-psd", { method: "POST", body: JSON.stringify({ path, name }) });
  return text(`Imported "${d.name}" as ${d.id} (${d.width}x${d.height}, ${d.layers} top-level layers). Open in the editor: ${BASE}/?doc=${d.id}`);
});

server.registerTool("get_history", {
  description: "Recent changes to the document with who made them (editor or agent), so you can see what the human changed since you last looked.",
  inputSchema: { docId: z.string(), since: z.number().int().optional().describe("only changes after this rev") },
}, async ({ docId, since }) => {
  const h = await api<{ rev: number; actor: string; label?: string; at: string; ops: Op[] }[]>(`/api/docs/${docId}/history?since=${since ?? 0}`);
  return text(h.length ? h.map((a) => `rev ${a.rev}  ${a.at}  ${a.actor}  ${a.label ?? ""}  ${a.ops.map((o) => o.type).join(",")}`).join("\n") : "No changes since then.");
});

await server.connect(new StdioServerTransport());
