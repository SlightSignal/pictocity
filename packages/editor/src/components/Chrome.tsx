import { useEffect, useRef, useState } from "react";
import type { Layer, Op } from "@pictocity/core";
import { makeText, makeShape, makeFill, makeAdjustment, makeGroup, makeImage, findLayer, isGroup, artboards, walk as walkLayers, CUSTOM_SHAPES, textPathPreset } from "@pictocity/core";
import { useStore, selectedLayers, type Tool, type ShapeKind } from "../store";
import { ADJ_DEFS } from "./PropertiesPanel";
import { withToken } from "../env";

const isMac = navigator.platform.toUpperCase().includes("MAC");
export const mod = isMac ? "⌘" : "Ctrl+";

// ---- Menu bar -------------------------------------------------------------------------

interface Item { label?: string; kbd?: string; run?: () => void; disabled?: boolean; sep?: boolean }

function Menu({ title, items, openId, setOpenId }: { title: string; items: Item[]; openId: string | null; setOpenId: (id: string | null) => void }) {
  const open = openId === title;
  return (
    <div className={`menu${open ? " open" : ""}`} onMouseEnter={() => openId && setOpenId(title)}>
      <button onClick={() => setOpenId(open ? null : title)}>{title}</button>
      {open && (
        <div className="dropdown" onClick={() => setOpenId(null)}>
          {items.map((it, i) => it.sep ? <div key={i} className="sep" /> : (
            <button key={i} disabled={it.disabled} onClick={it.run}><span>{it.label}</span>{it.kbd && <kbd>{it.kbd}</kbd>}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export async function importImageFile(file: File) {
  const st = useStore.getState();
  if (!st.doc) return;
  const r = await fetch(`/api/docs/${st.doc.id}/assets`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(file.name) }, body: file });
  const asset = await r.json();
  if (!r.ok) { st.showToast(asset.error ?? "Import failed"); return; }
  placeAsset(asset);
}

/** The server already added the asset to the document via an op; wait for it to arrive, then place a layer for it. */
export function placeAsset(asset: { id: string; name: string; width: number; height: number }) {
  const place = (tries = 60) => {
    const d = useStore.getState().doc;
    if (!d) return;
    if (!d.assets[asset.id]) { if (tries > 0) setTimeout(() => place(tries - 1), 60); return; }
    // Fit inside the current artboard (if any is selected) or the canvas, at 80%.
    const sel = useStore.getState().selection[0];
    const ab = sel ? artboards(d).find((a) => a.id === sel || [...walkLayers(a.children)].some((w) => w.layer.id === sel)) : undefined;
    const frame = ab ? { x: ab.x, y: ab.y, width: ab.width, height: ab.height } : { x: 0, y: 0, width: d.width, height: d.height };
    const scale = Math.min(1, (frame.width * 0.8) / asset.width, (frame.height * 0.8) / asset.height);
    const w = Math.round(asset.width * scale), h = Math.round(asset.height * scale);
    const layer = makeImage({ assetId: asset.id, name: asset.name.replace(/\.[^.]+$/, ""), x: Math.round(frame.x + (frame.width - w) / 2), y: Math.round(frame.y + (frame.height - h) / 2), width: w, height: h, fit: "cover" });
    useStore.getState().dispatch([{ type: "layer.add", layer, parentId: ab ? ab.id : null, index: ab ? ab.children.length : d.layers.length }], `Place ${asset.name}`);
    useStore.getState().select([layer.id]);
  };
  place();
}

export async function importPsdFile(file: File) {
  const st = useStore.getState();
  st.showToast(`Importing ${file.name}…`);
  const r = await fetch("/api/docs/import-psd", { method: "POST", headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(file.name) }, body: file });
  const info = await r.json();
  if (!r.ok) { st.showToast(info.error ?? "PSD import failed"); return; }
  st.connect(info.id);
  useStore.setState({ modal: null, zoom: 1, pan: { x: 0, y: 0 } });
}

export async function importSvgFile(file: File, place = true) {
  const st = useStore.getState();
  const text = await file.text();
  if (place && st.doc) {
    const r = await fetch("/api/docs/import-svg", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: text, name: file.name, docId: st.doc.id }) });
    const d = await r.json(); st.showToast(r.ok ? `Placed ${d.layers} layers from ${file.name}` : d.error ?? "SVG import failed");
    if (r.ok) setTimeout(() => useStore.getState().select([d.groupId]), 300);
    return;
  }
  const r = await fetch("/api/docs/import-svg", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: text, name: file.name }) });
  const d = await r.json(); if (!r.ok) { st.showToast(d.error ?? "SVG import failed"); return; }
  st.connect(d.id); useStore.setState({ modal: null, zoom: 1, pan: { x: 0, y: 0 } });
}

export function exportDoc(format: "png" | "jpg" | "webp" | "psd" | "svg" | "gif" | "html", scale = 1, artboardId?: string, trim = false) {
  const st = useStore.getState();
  if (!st.doc) return;
  const a = document.createElement("a");
  a.href = withToken(`/api/docs/${st.doc.id}/export?format=${format}&scale=${scale}${artboardId ? `&artboard=${encodeURIComponent(artboardId)}` : ""}${trim ? "&trim=true" : ""}&t=${Date.now()}`);
  a.download = `${st.doc.name}.${format}`;
  a.click();
  st.showToast(`Exporting ${format.toUpperCase()} at ${scale}×`);
}

export async function exportAllArtboards(format: "png" | "jpg" | "webp" = "png", scale = 1) {
  const st = useStore.getState();
  if (!st.doc) return;
  const r = await fetch(`/api/docs/${st.doc.id}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format, scale, artboards: true }) });
  const d = await r.json();
  st.showToast(r.ok ? `Exported ${d.files.length} artboards to ${d.files[0]?.path.replace(/[^/\\]+$/, "") ?? "data/exports"}` : d.error ?? "Export failed");
}

export function MenuBar() {
  const [openId, setOpenId] = useState<string | null>(null);
  const doc = useStore((s) => s.doc);
  const sel = useStore(selectedLayers);
  const undoStack = useStore((s) => s.undoStack);
  const redoStack = useStore((s) => s.redoStack);
  const connection = useStore((s) => s.connection);
  const presence = useStore((s) => s.presence);
  const pixelSelection = useStore((s) => s.pixelSelection);
  const styleClipboard = useStore((s) => s.styleClipboard);
  const fileInput = useRef<HTMLInputElement>(null);
  const psdInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const svgInput = useRef<HTMLInputElement>(null);
  const svgPlaceInput = useRef<HTMLInputElement>(null);
  const st = useStore.getState();
  const setText = (fn: (l: import("@pictocity/core").TextLayer) => Record<string, unknown>) => { const ops = sel.filter((l): l is import("@pictocity/core").TextLayer => l.type === "text").map((l) => ({ type: "layer.set" as const, id: l.id, props: fn(l) })); if (ops.length) st.dispatch(ops, "Type"); };
  useEffect(() => { const close = (e: PointerEvent) => { if (!(e.target as Element).closest?.(".menubar")) setOpenId(null); }; window.addEventListener("pointerdown", close, true); return () => window.removeEventListener("pointerdown", close, true); }, []);

  const addLayer = (layer: Layer, label: string) => { if (!doc) return; st.dispatch([{ type: "layer.add", layer, parentId: null, index: doc.layers.length }], label); st.select([layer.id]); };
  const has = sel.length > 0;
  const agents = Object.keys(presence).filter((a) => a.startsWith("agent:"));
  const selArtboard = sel.length === 1 && isGroup(sel[0]) && sel[0].artboard ? sel[0] : null;
  const hasArtboards = !!doc && artboards(doc).length > 0;

  return (
    <div className="menubar" onPointerDown={(e) => e.stopPropagation()}>
      <div className="brand">pictocity</div>
      <Menu title="File" openId={openId} setOpenId={setOpenId} items={[
        { label: "New…", kbd: `${mod}N`, run: () => useStore.setState({ modal: "new" }) },
        { label: "Open…", kbd: `${mod}O`, run: () => { st.refreshDocs(); useStore.setState({ modal: "open" }); } },
        { label: "Open Photoshop file…", run: () => psdInput.current?.click() },
        { label: "Open SVG as new document…", run: () => svgInput.current?.click() },
        { label: "Place SVG…", disabled: !doc, run: () => svgPlaceInput.current?.click() },
        { sep: true },
        { label: "Place image…", disabled: !doc, run: () => fileInput.current?.click() },
        { label: "Place image from URL…", disabled: !doc, run: async () => { const url = prompt("Image URL"); if (!url || !doc) return; const r = await fetch(`/api/docs/${doc.id}/assets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }); const a = await r.json(); if (!r.ok) { st.showToast(a.error ?? "Could not fetch that image"); return; } placeAsset(a); } },
        { label: "Install font…", run: () => fontInput.current?.click() },
        { label: "Close document", kbd: `${mod}W`, disabled: !doc, run: () => useStore.setState({ modal: "open" }) },
        { label: "Preferences…", kbd: `${mod}K`, run: () => useStore.setState({ modal: "prefs" }) },
        { label: "Clean up unused assets", run: async () => { const r = await fetch("/api/assets?gc", { method: "POST" }); const d = await r.json(); st.showToast(r.ok ? `Removed ${d.removed} unused files (${(d.bytes / 1024).toFixed(0)} KB)` : "Clean-up failed"); } },
        { label: "Canvas size…", disabled: !doc, run: () => useStore.setState({ modal: "size" }) },
        { label: "New size variant…", disabled: !doc, run: () => useStore.setState({ modal: "variant" }) },
        { label: "Duplicate document", disabled: !doc, run: async () => { if (!doc) return; const r = await fetch(`/api/docs/${doc.id}/variant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ width: doc.width, height: doc.height, name: `${doc.name} copy`, scaleContent: false }) }); const d = await r.json(); if (r.ok) { st.connect(d.id); useStore.setState({ zoom: 1, pan: { x: 0, y: 0 } }); } } },
        { sep: true },
        // kbd corrected 2026-09-07: this said ⇧⌘E, but that chord is handled
        // earlier as Merge Visible and returns, so it never exported -- the
        // menu advertised a shortcut that silently did something destructive
        // instead. The menu item's own run() was always fine. ⌥⇧S is the
        // chord that actually opens export (App.tsx, alt+shift+s).
        { label: "Export PNG", kbd: `⌥⇧S`, disabled: !doc, run: () => exportDoc("png") },
        { label: "Quick export PNG @2×", disabled: !doc, run: () => exportDoc("png", 2) },
        { label: "Export JPG", disabled: !doc, run: () => exportDoc("jpg") },
        { label: "Export JPG (quality…)", disabled: !doc, run: () => { const q = prompt("JPEG quality 1–100", "85"); if (q && doc) { const a = document.createElement("a"); a.href = withToken(`/api/docs/${doc.id}/export?format=jpg&quality=${Number(q)}&t=${Date.now()}`); a.download = `${doc.name}.jpg`; a.click(); } } },
        { label: "Export WebP", disabled: !doc, run: () => exportDoc("webp") },
        { sep: true },
        { label: selArtboard ? `Export artboard "${selArtboard.name}" PNG` : "Export selected artboard PNG", disabled: !selArtboard, run: () => selArtboard && exportDoc("png", 1, selArtboard.id) },
        { label: "Export all artboards (PNG, to data/exports)", disabled: !hasArtboards, run: () => exportAllArtboards("png") },
        { label: "Export all artboards @2×", disabled: !hasArtboards, run: () => exportAllArtboards("png", 2) },
        { sep: true },
        { label: "Export Photoshop file (.psd)", disabled: !doc, run: () => exportDoc("psd") },
        { label: "Export SVG (vector where possible)", disabled: !doc, run: () => exportDoc("svg") },
        { label: "Export animated GIF (timeline)", disabled: !doc, run: () => exportDoc("gif" as never) },
        { label: "Export HTML5 banner (timeline)", disabled: !doc, run: () => exportDoc("html" as never) },
      ]} />
      <Menu title="Edit" openId={openId} setOpenId={setOpenId} items={[
        { label: `Undo ${undoStack[undoStack.length - 1]?.label ?? ""}`, kbd: `${mod}Z`, disabled: !undoStack.length, run: () => st.undo() },
        { label: `Redo ${redoStack[redoStack.length - 1]?.label ?? ""}`, kbd: `${mod}⇧Z`, disabled: !redoStack.length, run: () => st.redo() },
        { sep: true },
        { label: "Select all", kbd: `${mod}A`, disabled: !doc, run: () => st.select(doc!.layers.map((l) => l.id)) },
        { label: "Deselect", kbd: `${mod}D`, disabled: !has, run: () => st.select([]) },
        { sep: true },
        { label: `Transform: skew${useStore.getState().distortMode === "skew" ? " ✓" : ""}`, disabled: sel.length !== 1 || isGroup(sel[0]), run: () => useStore.setState({ distortMode: "skew", tool: "move" }) },
        { label: `Transform: distort${useStore.getState().distortMode === "distort" ? " ✓" : ""}`, disabled: sel.length !== 1 || isGroup(sel[0]), run: () => useStore.setState({ distortMode: "distort", tool: "move" }) },
        { label: `Transform: perspective${useStore.getState().distortMode === "perspective" ? " ✓" : ""}`, disabled: sel.length !== 1 || isGroup(sel[0]), run: () => useStore.setState({ distortMode: "perspective", tool: "move" }) },
        { label: "Reset distortion", disabled: !sel.some((l) => l.quad), run: () => st.dispatch(sel.filter((l) => l.quad).map((l) => ({ type: "layer.set" as const, id: l.id, props: { quad: null } })), "Reset distortion") },
        { label: "Flip horizontal", disabled: !has, run: () => st.transformSelection("flipH") },
        { label: "Flip vertical", disabled: !has, run: () => st.transformSelection("flipV") },
        { label: "Rotate 90° clockwise", disabled: !has, run: () => st.transformSelection("rot90") },
        { label: "Rotate 90° counter-clockwise", disabled: !has, run: () => st.transformSelection("rot-90") },
        { label: "Rotate 180°", disabled: !has, run: () => st.transformSelection("rot180") },
        { sep: true },
        { label: "Free Transform", kbd: `${mod}T`, disabled: !has, run: () => st.setTool("move") },
        { label: "Fill selection with foreground", kbd: "⌥⌫", disabled: !pixelSelection, run: () => st.fillPixelSelection() },
        { label: "Fill selection with background", kbd: `${mod}⌫`, disabled: !pixelSelection, run: () => { const fg = st.fgColor; useStore.setState({ fgColor: st.bgColor }); st.fillPixelSelection(); useStore.setState({ fgColor: fg }); } },
        { label: "Delete inside selection", kbd: "⌫", disabled: !pixelSelection || !has, run: () => st.hidePixelSelection() },

        { sep: true },
        { label: "Cut layers", kbd: `${mod}X`, disabled: !has, run: () => { st.copyLayers(); st.deleteSelection(); } },
        { label: "Copy layers", kbd: `${mod}C`, disabled: !has, run: () => st.copyLayers() },
        { label: "Copy merged (flattened image to clipboard)", kbd: `⇧${mod}C`, disabled: !doc, run: () => { const s2 = useStore.getState(); if (!s2.doc) return; fetch(`/api/docs/${s2.doc.id}/render.png?scale=1&t=${Date.now()}`).then((r) => r.blob()).then((b) => navigator.clipboard.write([new ClipboardItem({ "image/png": b })])).then(() => s2.showToast("Merged image copied")).catch(() => s2.showToast("Clipboard images aren't available here")); } },
        { label: "Paste layers / image", kbd: `${mod}V`, disabled: !doc, run: () => st.showToast("Press ⌘V / Ctrl+V with the canvas focused") },
        { label: "Duplicate layer", kbd: `${mod}J`, disabled: !has, run: () => st.duplicateSelection() },
        { label: "Copy to artboard…", disabled: !has || !hasArtboards, run: () => useStore.setState({ modal: "copyto" }) },
        { label: "Delete layer", kbd: "⌫", disabled: !has, run: () => st.deleteSelection() },
      ]} />
      <Menu title="Image" openId={openId} setOpenId={setOpenId} items={[
        { label: "Adjustments ▸ (apply to selected layers, or as an adjustment layer)", disabled: true, run: () => undefined },
        ...([["levels", "Levels…", `${mod}L`, { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }], ["curves", "Curves…", `${mod}M`, { rgb: [[0, 0], [255, 255]] }], ["exposure", "Exposure…", "", ADJ_DEFS.exposure.init], ["vibrance", "Vibrance…", "", ADJ_DEFS.vibrance.init], ["colorize", "Hue/Saturation (colorize)…", `${mod}U`, ADJ_DEFS.colorize.init], ["colorBalance", "Color Balance…", `${mod}B`, ADJ_DEFS.colorBalance.init], ["blackWhite", "Black & White…", `⌥⇧${mod}B`, ADJ_DEFS.blackWhite.init], ["photoFilter", "Photo Filter…", "", ADJ_DEFS.photoFilter.init], ["channelMixer", "Channel Mixer…", "", ADJ_DEFS.channelMixer.init], ["invert", "Invert", `${mod}I`, 1], ["posterize", "Posterize…", "", 4], ["threshold", "Threshold…", "", 128], ["gradientMap", "Gradient Map…", "", ADJ_DEFS.gradientMap.init], ["shadowsHighlights", "Shadows/Highlights…", "", ADJ_DEFS.shadowsHighlights.init], ["grayscale", "Desaturate", `⇧${mod}U`, 1]] as [string, string, string, unknown][]).map(([k, label, kbd, init]) => ({ label: `  ${label}`, kbd: kbd || undefined, disabled: !doc, run: () => st.applyAdjustmentToSelection(k, init) })),
        { sep: true },
        { label: "Check against platform spec…", disabled: !doc, run: async () => { if (!doc) return; const platform = prompt("Platform: meta-feed, meta-story, google-display, youtube-thumbnail, linkedin, x, pinterest, print", "meta-feed"); if (!platform) return; const ab = sel.length === 1 && artboards(doc).some((a) => a.id === sel[0].id) ? `&artboard=${sel[0].id}` : ""; const r = await fetch(`/api/docs/${doc.id}/spec?platform=${encodeURIComponent(platform)}${ab}&weigh=true`); const d = await r.json(); if (!r.ok) { st.showToast(d.error); return; } alert(`${d.platform.name}: score ${d.score}/100\n\n${d.issues.length ? d.issues.map((i: { severity: string; message: string }) => `${i.severity.toUpperCase()}: ${i.message}`).join("\n") : "No issues."}${d.platform.notes ? `\n\n${d.platform.notes}` : ""}`); } },
        { label: "Image Size… / Canvas Size…", kbd: `⌥${mod}I`, disabled: !doc, run: () => useStore.setState({ modal: "size" }) },
        { label: `Mode ▸ ${doc?.linearBlending ? "✓ " : ""}Blend in linear light`, disabled: !doc, run: () => doc && st.dispatch([{ type: "doc.set", props: { linearBlending: (doc.linearBlending ? null : true) as unknown as boolean } }], "Linear blending") },
        { label: "Image Rotation ▸ 90° clockwise", disabled: !doc, run: () => st.rotateCanvas(90) },
        { label: "Image Rotation ▸ 90° counter-clockwise", disabled: !doc, run: () => st.rotateCanvas(-90) },
        { label: "Image Rotation ▸ 180°", disabled: !doc, run: () => st.rotateCanvas(180) },
        { label: "Crop (to selection or crop box)", kbd: "C", disabled: !doc, run: () => { if (pixelSelection) { const f = pixelSelection.flat(); const xs = f.filter((_, i) => i % 2 === 0), ys = f.filter((_, i) => i % 2 === 1); useStore.setState({ cropRect: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } }); st.applyCrop(); } else st.setTool("crop"); } },
        { label: "Trim transparent pixels (export option)", disabled: !doc, run: () => useStore.setState({ modal: "export" }) },
        { label: "Duplicate document", disabled: !doc, run: async () => { if (!doc) return; const r = await fetch(`/api/docs/${doc.id}/variant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ width: doc.width, height: doc.height, name: `${doc.name} copy`, scaleContent: false }) }); const d = await r.json(); if (r.ok) { st.connect(d.id); useStore.setState({ zoom: 1, pan: { x: 0, y: 0 } }); } } },
      ]} />
      <Menu title="Layer" openId={openId} setOpenId={setOpenId} items={[
        { label: "New text", kbd: "T", disabled: !doc, run: () => doc && addLayer(makeText({ text: "Headline", x: 80, y: 80, width: doc.width - 160, height: 200, color: st.fgColor }), "New text") },
        { label: "New shape", kbd: "U", disabled: !doc, run: () => doc && addLayer(makeShape({ x: Math.round(doc.width / 2 - 150), y: Math.round(doc.height / 2 - 100), fill: st.fgColor }), "New shape") },
        ...Object.keys(CUSTOM_SHAPES).map((k) => ({ label: `  Insert shape: ${k}`, disabled: !doc, run: () => doc && addLayer(makeShape({ name: k, shape: "path", path: CUSTOM_SHAPES[k], x: Math.round(doc.width / 2 - 120), y: Math.round(doc.height / 2 - 120), width: 240, height: 240, fill: st.fgColor }), `Insert ${k}`) })),
        { label: "New fill layer", disabled: !doc, run: () => doc && addLayer(makeFill({ width: doc.width, height: doc.height, fill: { kind: "linear", from: "#ff8a00", to: "#e52e71", angle: 135 } }), "New fill layer") },
        { label: "New adjustment layer", disabled: !doc, run: () => doc && addLayer(makeAdjustment({ width: doc.width, height: doc.height, adjustment: { brightness: 1, contrast: 1, saturate: 1 } }), "New adjustment layer") },
        ...(["vibrance", "exposure", "colorBalance", "blackWhite", "photoFilter", "gradientMap", "colorize", "shadowsHighlights", "threshold", "posterize"] as const).map((k) => ({ label: `  Adjustment: ${ADJ_DEFS[k].label}`, disabled: !doc, run: () => doc && addLayer(makeAdjustment({ name: ADJ_DEFS[k].label, width: doc.width, height: doc.height, adjustment: { [k]: ADJ_DEFS[k].init } }), `New ${ADJ_DEFS[k].label} layer`) })),
        { label: "New group", disabled: !doc, run: () => addLayer(makeGroup({}), "New group") },
        { label: "New artboard…", disabled: !doc, run: () => useStore.setState({ modal: "artboard" }) },
        { sep: true },
        { label: "Combine shapes: unite", disabled: sel.filter((l) => l.type === "shape").length < 2, run: () => st.combineShapes("union") },
        { label: "Combine shapes: subtract front", disabled: sel.filter((l) => l.type === "shape").length < 2, run: () => st.combineShapes("subtract") },
        { label: "Combine shapes: intersect", disabled: sel.filter((l) => l.type === "shape").length < 2, run: () => st.combineShapes("intersect") },
        { label: "Combine shapes: exclude overlap", disabled: sel.filter((l) => l.type === "shape").length < 2, run: () => st.combineShapes("exclude") },
        { label: "Convert shape to editable path", disabled: !sel.some((l) => l.type === "shape" && l.shape !== "path"), run: () => st.convertToPath() },
        { sep: true },
        { label: "Merge selected into image", kbd: `${mod}E`, disabled: !has, run: () => st.mergeSelection() },
        { label: "Mask: reveal selection", disabled: !has || !pixelSelection, run: () => st.maskFromSelection("reveal") },
        { label: "Mask: hide selection", disabled: !has || !pixelSelection, run: () => st.maskFromSelection("hide") },
        { sep: true },
        { label: sel.some((l) => l.clipToBelow) ? "Release clipping mask" : "Create clipping mask (clip to layer below)", kbd: `⌥${mod}G`, disabled: !has, run: () => st.toggleClipping() },
        { label: "Link layers (sync content)", disabled: sel.length < 2, run: () => st.linkSelection() },
        { label: "Unlink layers", disabled: !sel.some((l) => l.linkId), run: () => st.linkSelection(true) },
        { sep: true },
        { label: "Copy layer style", disabled: !has, run: () => st.copyStyle() },
        { label: "Paste layer style", disabled: !has || !styleClipboard, run: () => st.pasteStyle() },
        { sep: true },
        { label: "Group layers", kbd: `${mod}G`, disabled: !has, run: () => st.groupSelection() },
        { label: "Ungroup", kbd: `${mod}⇧G`, disabled: !sel.some((l) => l.type === "group"), run: () => st.ungroupSelection() },
        { sep: true },
        { label: "Bring to front", kbd: `${mod}⇧]`, disabled: !has, run: () => st.reorderSelection("top") },
        { label: "Bring forward", kbd: `${mod}]`, disabled: !has, run: () => st.reorderSelection("up") },
        { label: "Send backward", kbd: `${mod}[`, disabled: !has, run: () => st.reorderSelection("down") },
        { label: "Send to back", kbd: `${mod}⇧[`, disabled: !has, run: () => st.reorderSelection("bottom") },
        { sep: true },
        { label: sel.some((l) => l.locked) ? "Unlock layers" : "Lock layers", kbd: `${mod}/`, disabled: !has, run: () => toggleLock() },
        { label: sel.some((l) => !l.visible) ? "Show layers" : "Hide layers", kbd: `${mod},`, disabled: !has, run: () => toggleVisible() },
      ]} />
      <Menu title="Type" openId={openId} setOpenId={setOpenId} items={[
        { label: "Add text", kbd: "T", disabled: !doc, run: () => st.setTool("text") },
        { label: "Font size + 2 px", kbd: `⇧${mod}>`, disabled: !sel.some((l) => l.type === "text"), run: () => setText((l) => ({ fontSize: l.fontSize + 2 })) },
        { label: "Font size − 2 px", kbd: `⇧${mod}<`, disabled: !sel.some((l) => l.type === "text"), run: () => setText((l) => ({ fontSize: Math.max(1, l.fontSize - 2) })) },
        { label: "Tracking +20", kbd: "⌥→", disabled: !sel.some((l) => l.type === "text"), run: () => setText((l) => ({ letterSpacing: l.letterSpacing + l.fontSize * 0.02 })) },
        { label: "Tracking −20", kbd: "⌥←", disabled: !sel.some((l) => l.type === "text"), run: () => setText((l) => ({ letterSpacing: l.letterSpacing - l.fontSize * 0.02 })) },
        { sep: true },
        { label: "UPPERCASE", disabled: !sel.some((l) => l.type === "text"), run: () => setText(() => ({ textTransform: "uppercase" })) },
        { label: "lowercase", disabled: !sel.some((l) => l.type === "text"), run: () => setText(() => ({ textTransform: "lowercase" })) },
        { label: "As typed", disabled: !sel.some((l) => l.type === "text"), run: () => setText(() => ({ textTransform: null })) },
        { label: "Bold / Regular toggle", disabled: !sel.some((l) => l.type === "text"), run: () => setText((l) => ({ fontWeight: Number(l.fontWeight) >= 600 ? 400 : 700 })) },
        { label: "Italic toggle", disabled: !sel.some((l) => l.type === "text"), run: () => setText((l) => ({ fontStyle: l.fontStyle === "italic" ? "normal" : "italic" })) },
        { sep: true },
        { label: "Align left / centre / right / justify → Properties", disabled: true, run: () => undefined },
        { label: "Convert to paragraph text (wrap in box)", disabled: !sel.some((l) => l.type === "text" && !l.wrap), run: () => setText(() => ({ wrap: true })) },
        { label: "Convert to point text", disabled: !sel.some((l) => l.type === "text" && l.wrap), run: () => setText(() => ({ wrap: false })) },
        { label: "Text on a path: arc over the top", disabled: !sel.some((l) => l.type === "text"), run: () => setText(() => ({ onPath: { path: textPathPreset("arc-up"), align: "center", offset: 0 } })) },
        { label: "Text on a path: full circle", disabled: !sel.some((l) => l.type === "text"), run: () => setText(() => ({ onPath: { path: textPathPreset("circle"), align: "start", offset: 0 } })) },
        { label: "Straight text (remove path)", disabled: !sel.some((l) => l.type === "text" && l.onPath), run: () => setText(() => ({ onPath: null })) },
        { sep: true },
        { label: "Install font…", run: () => fontInput.current?.click() },
      ]} />
      <Menu title="Select" openId={openId} setOpenId={setOpenId} items={[
        { label: "All pixels", kbd: `${mod}A (selection tools)`, disabled: !doc, run: () => st.selectAllPixels() },
        { label: "Deselect", kbd: `${mod}D`, disabled: !pixelSelection, run: () => useStore.setState({ pixelSelection: null }) },
        { label: "Reselect", disabled: !useStore.getState().lastSelection || !!pixelSelection, run: () => useStore.setState({ pixelSelection: useStore.getState().lastSelection }) },
        { label: "Inverse", kbd: `${mod}⇧I`, disabled: !pixelSelection, run: () => st.invertPixelSelection() },
        { label: "From layer transparency", disabled: sel.length !== 1, run: () => st.selectionFromLayer(sel[0].id, (l) => (window as unknown as { __layerAlpha?: (id: string) => { canvas: HTMLCanvasElement; x: number; y: number; scale: number } | undefined }).__layerAlpha?.(l.id)) },
        { sep: true },
        { label: "Expand…", disabled: !pixelSelection, run: () => { const v = prompt("Expand by (px)", "10"); if (v) st.modifySelection("expand", Number(v)); } },
        { label: "Contract…", disabled: !pixelSelection, run: () => { const v = prompt("Contract by (px)", "10"); if (v) st.modifySelection("contract", Number(v)); } },
        { label: "Smooth…", disabled: !pixelSelection, run: () => { const v = prompt("Smooth radius (px)", "8"); if (v) st.modifySelection("smooth", Number(v)); } },
        { label: "Border…", disabled: !pixelSelection, run: () => { const v = prompt("Border width (px)", "10"); if (v) st.modifySelection("border", Number(v)); } },
        { label: `Feather… (${useStore.getState().selectionFeather} px)`, disabled: !pixelSelection, run: () => { const v = prompt("Feather radius in pixels (applies to fills, deletes and masks made from the selection)", String(useStore.getState().selectionFeather)); if (v !== null && Number.isFinite(Number(v))) useStore.setState({ selectionFeather: Math.max(0, Number(v)) }); } },
        { label: `${useStore.getState().selectionTransform ? "Finish transforming" : "Transform"} selection`, kbd: `${mod}⇧T`, disabled: !pixelSelection, run: () => useStore.setState({ selectionTransform: !useStore.getState().selectionTransform, tool: "move" }) },
        { sep: true },
        { label: "Save selection…", disabled: !pixelSelection, run: () => { const n = prompt("Selection name", `Selection ${(doc?.selections?.length ?? 0) + 1}`); if (n) st.saveSelection(n); } },
        ...(doc?.selections ?? []).map((x) => ({ label: `Load: ${x.name}`, run: () => st.loadSelection(x.id) })),
        ...(doc?.selections?.length ? [{ label: "Delete saved selections", run: () => st.dispatch([{ type: "doc.set", props: { selections: [] } }], "Delete selections") }] : []),
      ]} />
      <Menu title="Filter" openId={openId} setOpenId={setOpenId} items={[
        { label: "Filters apply to the selected layers (non-destructive; edit in Properties)", disabled: true, run: () => undefined },
        { label: "Blur ▸ Gaussian Blur…", disabled: !has, run: () => { const v = prompt("Blur radius (px)", "6"); if (v) st.dispatch(sel.map((l) => ({ type: "layer.set" as const, id: l.id, props: { filters: { ...(l.filters ?? {}), blur: Number(v) } } })), "Gaussian blur"); } },
        { label: "Blur ▸ Motion Blur…", disabled: !has, run: () => st.dispatch(sel.map((l) => ({ type: "layer.set" as const, id: l.id, props: { filters: { ...(l.filters ?? {}), motionBlur: ADJ_DEFS.motionBlur.init } } })), "Motion blur") },
        { label: "Sharpen ▸ Unsharp Mask…", disabled: !has, run: () => st.dispatch(sel.map((l) => ({ type: "layer.set" as const, id: l.id, props: { filters: { ...(l.filters ?? {}), unsharp: ADJ_DEFS.unsharp.init } } })), "Unsharp mask") },
        { label: "Noise ▸ Add Noise…", disabled: !has, run: () => st.dispatch(sel.map((l) => ({ type: "layer.set" as const, id: l.id, props: { filters: { ...(l.filters ?? {}), noise: 0.3 } } })), "Add noise") },
        { label: "Pixelate ▸ Mosaic…", disabled: !has, run: () => st.dispatch(sel.map((l) => ({ type: "layer.set" as const, id: l.id, props: { filters: { ...(l.filters ?? {}), pixelate: 12 } } })), "Mosaic") },
        { label: "Stylize ▸ Emboss", disabled: !has, run: () => st.dispatch(sel.map((l) => ({ type: "layer.set" as const, id: l.id, props: { filters: { ...(l.filters ?? {}), emboss: 1 } } })), "Emboss") },
        { label: "Stylize ▸ Find Edges", disabled: !has, run: () => st.dispatch(sel.map((l) => ({ type: "layer.set" as const, id: l.id, props: { filters: { ...(l.filters ?? {}), findEdges: 1 } } })), "Find edges") },
        { label: "Distort ▸ Perspective / Distort / Skew → Edit › Transform", disabled: true, run: () => undefined },
        { sep: true },
        { label: "Clear filters on selected layers", disabled: !sel.some((l) => l.filters), run: () => st.dispatch(sel.filter((l) => l.filters).map((l) => ({ type: "layer.set" as const, id: l.id, props: { filters: null } })), "Clear filters") },
        { label: "Image tools (knockout, external models) → Properties › Image", disabled: true, run: () => undefined },
      ]} />
      <Menu title="View" openId={openId} setOpenId={setOpenId} items={[
        { label: "Zoom in", kbd: `${mod}+`, run: () => zoomBy(1.25) },
        { label: "Zoom out", kbd: `${mod}−`, run: () => zoomBy(1 / 1.25) },
        { label: "Fit on screen", kbd: `${mod}0`, run: () => (window as unknown as { __fit?: () => void }).__fit?.() },
        { label: "Zoom to selection", kbd: `${mod}⇧0`, disabled: !has, run: () => zoomToSelection() },
        { label: "100%", kbd: `${mod}1`, run: () => st.setView(1) },
        { label: "200%", kbd: `${mod}2`, run: () => st.setView(2) },
        { sep: true },
        { label: `${useStore.getState().showRulers ? "Hide" : "Show"} rulers`, kbd: `${mod}R`, run: () => useStore.setState({ showRulers: !useStore.getState().showRulers }) },
        { label: `${useStore.getState().showGuides ? "Hide" : "Show"} guides`, kbd: `${mod};`, run: () => useStore.setState({ showGuides: !useStore.getState().showGuides }) },
        { label: `${useStore.getState().showGrid ? "Hide" : "Show"} grid`, kbd: `${mod}'`, run: () => useStore.setState({ showGrid: !useStore.getState().showGrid }) },
        { label: `${useStore.getState().showExtras ? "Hide" : "Show"} Extras (selection edges, guides, boxes)`, kbd: `${mod}H`, run: () => useStore.setState({ showExtras: !useStore.getState().showExtras }) },
        { label: `${useStore.getState().guidesLocked ? "Unlock" : "Lock"} guides`, kbd: `⌥${mod};`, run: () => useStore.setState({ guidesLocked: !useStore.getState().guidesLocked }) },
        { label: "Rotate view (R tool) / Reset view rotation", run: () => useStore.setState({ viewRotation: 0, tool: "rotate" }) },
        { label: "Screen mode: cycle (F)", run: () => { const s2 = useStore.getState(); useStore.setState(s2.menuHidden ? { menuHidden: false, panelsHidden: false } : s2.panelsHidden ? { menuHidden: true } : { panelsHidden: true }); } },
        { label: `${useStore.getState().showTimeline ? "Hide" : "Show"} timeline (animation)`, kbd: `⌥${mod}T`, run: () => useStore.setState({ showTimeline: !useStore.getState().showTimeline, animTime: 0, playing: false }) },
        { label: "Clear guides", disabled: !doc?.guides.length, run: () => st.dispatch([{ type: "doc.set", props: { guides: [] } }], "Clear guides") },
      ]} />
      <Menu title="Window" openId={openId} setOpenId={setOpenId} items={[
        { label: `${useStore.getState().panelsHidden ? "Show" : "Hide"} panels`, kbd: "Tab", run: () => useStore.setState({ panelsHidden: !useStore.getState().panelsHidden }) },
        { label: "Timeline", kbd: `⌥${mod}T`, run: () => useStore.setState({ showTimeline: !useStore.getState().showTimeline }) },
        { label: "Reset zoom & view", run: () => { useStore.setState({ viewRotation: 0 }); (window as unknown as { __fit?: () => void }).__fit?.(); } },
        { sep: true },
        ...useStore.getState().recentDocs.map((d) => ({ label: `${doc?.id === d.id ? "● " : "  "}${d.name}`, run: () => { if (doc?.id !== d.id) { st.connect(d.id); useStore.setState({ zoom: 1, pan: { x: 0, y: 0 } }); } } })),
      ]} />
      <Menu title="Help" openId={openId} setOpenId={setOpenId} items={[
        { label: "Keyboard shortcuts", kbd: "?", run: () => useStore.setState({ modal: "shortcuts" }) },
        { label: "Documentation (README)", run: () => window.open("https://github.com/", "_blank") },
      ]} />
      <div className="spacer" />
      {doc && <div className="conn" style={{ color: "var(--text)" }}>{doc.name} <span style={{ color: "var(--text-faint)" }}>rev {doc.rev}</span></div>}
      <div className={`conn${connection !== "online" ? " offline" : agents.length ? " agent" : ""}`}><i />{connection === "online" ? (agents.length ? `${agents[0].replace("agent:", "")} is editing` : "Live") : connection === "connecting" ? "Connecting…" : "Offline — reconnecting"}</div>
      <input ref={svgInput} type="file" accept=".svg,image/svg+xml" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) importSvgFile(f, false); e.target.value = ""; }} />
      <input ref={svgPlaceInput} type="file" accept=".svg,image/svg+xml" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) importSvgFile(f, true); e.target.value = ""; }} />
      <input ref={fontInput} type="file" accept=".ttf,.otf,.woff,.woff2" multiple style={{ display: "none" }} onChange={async (e) => { for (const f of Array.from(e.target.files ?? [])) { const r = await fetch("/api/fonts", { method: "POST", headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(f.name) }, body: f }); const d = await r.json(); st.showToast(r.ok ? `Installed ${d.family}` : d.error ?? "Font install failed"); } const { loadFonts, servedFamilies } = await import("../env"); const fonts = await loadFonts(); useStore.setState({ fonts, servedFonts: servedFamilies }); e.target.value = ""; }} />
      <input ref={psdInput} type="file" accept=".psd,image/vnd.adobe.photoshop" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) importPsdFile(f); e.target.value = ""; }} />
      <input ref={fileInput} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => { Array.from(e.target.files ?? []).forEach((f) => importImageFile(f)); e.target.value = ""; }} />
    </div>
  );
}

export function zoomToSelection() {
  const st = useStore.getState();
  const sel = selectedLayers(st);
  const el = document.querySelector(".canvas-area") as HTMLElement | null;
  if (!sel.length || !el) return;
  const bs = sel.map((l) => (isGroup(l) ? { ...l } : l)).map((l) => ({ x: l.x, y: l.y, w: l.width, h: l.height }));
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y)), x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
  const z = Math.min(32, Math.max(0.02, Math.min((el.clientWidth - 120) / (x1 - x0), (el.clientHeight - 120) / (y1 - y0))));
  st.setView(z, { x: (el.clientWidth - (x1 - x0) * z) / 2 - x0 * z, y: (el.clientHeight - (y1 - y0) * z) / 2 - y0 * z });
}

export function zoomBy(f: number) {
  const st = useStore.getState();
  const el = document.querySelector(".canvas-area") as HTMLElement | null;
  const cx = (el?.clientWidth ?? 0) / 2, cy = (el?.clientHeight ?? 0) / 2;
  const z = Math.min(32, Math.max(0.02, st.zoom * f));
  st.setView(z, { x: cx - ((cx - st.pan.x) / st.zoom) * z, y: cy - ((cy - st.pan.y) / st.zoom) * z });
}

export function toggleLock() {
  const st = useStore.getState(); const sel = selectedLayers(st);
  const lock = !sel.some((l) => l.locked);
  st.dispatch(sel.map((l) => ({ type: "layer.set" as const, id: l.id, props: { locked: lock } })), lock ? "Lock layers" : "Unlock layers");
}
export function toggleVisible() {
  const st = useStore.getState(); const sel = selectedLayers(st);
  const show = sel.some((l) => !l.visible);
  st.dispatch(sel.map((l) => ({ type: "layer.set" as const, id: l.id, props: { visible: show } })), show ? "Show layers" : "Hide layers");
}

// ---- Tool bar -----------------------------------------------------------------------------

const icons: Record<string, JSX.Element> = {
  move: <svg viewBox="0 0 24 24"><path d="M5 3l14 9-6 1.5L10 20z" /></svg>,
  marquee: <svg viewBox="0 0 24 24"><path d="M4 4h4M10 4h4M16 4h4M4 20h4M10 20h4M16 20h4M4 8v4M4 14v4M20 8v4M20 14v4" /></svg>,
  ellipsesel: <svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8" ry="7" strokeDasharray="3 2" /></svg>,
  direct: <svg viewBox="0 0 24 24"><path d="M5 3l14 9-6 1.5L10 20z" fill="none" /><path d="M8 7l7 4.5-3 .8-1.5 3.7z" fill="currentColor" /></svg>,
  wand: <svg viewBox="0 0 24 24"><path d="M4 20l9-9M14 4l1 2M18 8l2 1M11 6l2-1M17 3l-1 3" /><path d="M13 9l2 2" /></svg>,
  heal: <svg viewBox="0 0 24 24"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" /></svg>,
  clone: <svg viewBox="0 0 24 24"><path d="M6 12h12M12 12v7a3 3 0 0 0 3 3H9a3 3 0 0 0 3-3z" /><path d="M9 12V6a3 3 0 0 1 6 0v6" /></svg>,
  lasso: <svg viewBox="0 0 24 24"><path d="M12 4c4.4 0 8 2 8 5s-3.6 5-8 5-8-2-8-5 3.6-5 8-5zM9 13c-2 2-3 4-2 7" /></svg>,
  pen: <svg viewBox="0 0 24 24"><path d="M12 19l7-7 3 3-7 7zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18zM2 2l7.6 7.6" /><circle cx="11" cy="11" r="2" /></svg>,
  gradient: <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="1" /><path d="M8 5v14M12 5v14M16 5v14" opacity=".5" /></svg>,
  text: <svg viewBox="0 0 24 24"><path d="M5 5h14M12 5v15M9 20h6" /></svg>,
  rect: <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="1" /></svg>,
  ellipse: <svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8" ry="7" /></svg>,
  line: <svg viewBox="0 0 24 24"><path d="M5 19L19 5" /></svg>,
  polygon: <svg viewBox="0 0 24 24"><path d="M12 3l8 6-3 10H7L4 9z" /></svg>,
  star: <svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.3 6.4 20.3l1.2-6.3L3 9.6l6.3-.8z" /></svg>,
  brush: <svg viewBox="0 0 24 24"><path d="M19 3l2 2-9.5 9.5-2-2z" /><path d="M9.5 14.5c-2 0-3.5 1.5-3.5 3.5 0 1.5-1 2.5-3 3 3 .5 6.5-.5 7.5-3 .4-1 .2-2.2-.5-3z" /></svg>,
  eraser: <svg viewBox="0 0 24 24"><path d="M3 15l8-8 6 6-6 6H8z" /><path d="M11 21h9M7 11l6 6" /></svg>,
  crop: <svg viewBox="0 0 24 24"><path d="M7 2v15h15M2 7h15v15" /></svg>,
  eyedropper: <svg viewBox="0 0 24 24"><path d="M14 4l6 6-9 9H5v-6z" /><path d="M13 5l2-2a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-2 2M4 20l3-3" /></svg>,
  hand: <svg viewBox="0 0 24 24"><path d="M8 12V6a1.5 1.5 0 0 1 3 0v5V4.5a1.5 1.5 0 0 1 3 0V11V6a1.5 1.5 0 0 1 3 0v7.5c0 3.5-2.5 6-6 6-2.6 0-4.2-1.3-5.4-3.3L4 12.4a1.4 1.4 0 0 1 2.3-1.6L8 13" /></svg>,
  rotate: <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5" /></svg>,
  zoom: <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L20 20M8 10.5h5M10.5 8v5" /></svg>,
};

export function ToolBar() {
  const tool = useStore((s) => s.tool);
  const shapeKind = useStore((s) => s.shapeKind);
  const marqueeKind = useStore((s) => s.marqueeKind);
  const fgColor = useStore((s) => s.fgColor);
  const bgColor = useStore((s) => s.bgColor);
  const st = useStore.getState();
  const T = ({ t, k, title }: { t: Tool; k: string; title: string }) => (
    <button className={`tool${tool === t ? " active" : ""}`} title={`${title} (${k})`} onClick={() => st.setTool(t)}>{icons[t === "shape" ? shapeKind : t === "marquee" && marqueeKind === "ellipse" ? "ellipsesel" : t]}{(t === "shape" || t === "marquee") && <span className="corner" />}</button>
  );
  return (
    <div className="toolbar" onPointerDown={(e) => e.stopPropagation()}>
      <T t="move" k="V" title="Move" />
      <T t="direct" k="A" title="Direct selection — drag path anchors and handles" />
      <T t="marquee" k="M" title={`${marqueeKind === "rect" ? "Rectangular" : "Elliptical"} marquee — Shift+M switches`} />
      <T t="lasso" k="L" title="Lasso" />
      <T t="wand" k="W" title="Magic wand — click a colour to select it" />
      <div className="gap" />
      <T t="text" k="T" title="Type" />
      <T t="pen" k="P" title="Pen — click for corners, drag for curves, Enter or click the first point to close" />
      <T t="shape" k="U" title={`Shape: ${shapeKind} — Shift+U cycles`} />
      <div className="gap" />
      <T t="brush" k="B" title="Brush" />
      <T t="eraser" k="E" title="Eraser" />
      <T t="clone" k="S" title="Clone stamp — Alt-click a source, then paint" />
      <T t="heal" k="J" title="Healing brush — Alt-click a source; texture from the source, colour from the destination" />
      <div className="gap" />
      <T t="gradient" k="G" title="Gradient — drag to fill with foreground → background" />
      <T t="crop" k="C" title="Crop" />
      <T t="eyedropper" k="I" title="Eyedropper" />
      <div className="gap" />
      <T t="hand" k="H" title="Hand" />
      <T t="rotate" k="R" title="Rotate view — drag to spin the canvas view, double-click to reset" />
      <T t="zoom" k="Z" title="Zoom" />
      <div className="swatches" title="Foreground color">
        <input type="color" className="sw fg" value={fgColor} onChange={(e) => useStore.getState().setFgColor(e.target.value)} style={{ background: fgColor, width: 18, height: 18 }} title="Foreground colour" />
        <input type="color" className="sw bg" value={bgColor} onChange={(e) => useStore.setState({ bgColor: e.target.value })} style={{ background: bgColor, width: 18, height: 18 }} title="Background colour (gradient end)" />
      </div>
    </div>
  );
}

// ---- Options bar ------------------------------------------------------------------------------

export function OptionsBar() {
  const tool = useStore((s) => s.tool);
  const shapeKind = useStore((s) => s.shapeKind);
  const autoSelectGroup = useStore((s) => s.autoSelectGroup);
  const fgColor = useStore((s) => s.fgColor);
  const fonts = useStore((s) => s.fonts);
  const sel = useStore(selectedLayers);
  const st = useStore.getState();
  const textSel = sel.filter((l) => l.type === "text");
  const brush = useStore((s) => s.brush);
  const setBrush = (p: Partial<typeof brush>) => useStore.setState({ brush: { ...brush, ...p } });
  const editMask = useStore((s) => s.editMask);
  const cropRect = useStore((s) => s.cropRect);
  const marqueeKind = useStore((s) => s.marqueeKind);
  const pixelSelection = useStore((s) => s.pixelSelection);
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const wandTolerance = useStore((s) => s.wandTolerance);
  const names: Record<Tool, string> = { move: "Move", direct: "Direct selection", marquee: "Marquee", lasso: "Lasso", wand: "Magic wand", text: "Type", shape: "Shape", pen: "Pen", brush: "Brush", eraser: "Eraser", clone: "Clone stamp", heal: "Healing brush", gradient: "Gradient", crop: "Crop", eyedropper: "Eyedropper", hand: "Hand", zoom: "Zoom", rotate: "Rotate view" };
  const A = ({ k, title, children }: { k: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"; title: string; children: React.ReactNode }) => <button title={title} disabled={!sel.length} onClick={() => st.alignSelection(k)}>{children}</button>;
  return (
    <div className="optionsbar" onPointerDown={(e) => e.stopPropagation()}>
      <span className="tool-name">{icons[tool === "shape" ? shapeKind : tool] && <span style={{ width: 14, height: 14, display: "inline-flex" }} className="tool">{icons[tool === "shape" ? shapeKind : tool]}</span>}{names[tool]}</span>
      {tool === "move" && sel.length === 1 && !isGroup(sel[0]) && <TransformBar l={sel[0]} />}
      {tool === "rotate" && <label>Drag to rotate the view (Shift snaps to 15°); double-click the canvas or press Esc to reset. Rulers hide while rotated. <button className="btn" onClick={() => useStore.setState({ viewRotation: 0 })}>Reset</button></label>}
      {tool === "move" && <>
        <label>Auto-select <div className="seg"><button className={!autoSelectGroup ? "on" : ""} onClick={() => useStore.setState({ autoSelectGroup: false })}>Layer</button><button className={autoSelectGroup ? "on" : ""} onClick={() => useStore.setState({ autoSelectGroup: true })}>Group</button></div></label>
        <label>Align <span className="align">
          <A k="left" title="Align left edges"><svg viewBox="0 0 24 24"><path d="M4 3v18M8 7h10v4H8zM8 13h6v4H8z" /></svg></A>
          <A k="hcenter" title="Align horizontal centres"><svg viewBox="0 0 24 24"><path d="M12 3v18M6 7h12v4H6zM8 13h8v4H8z" /></svg></A>
          <A k="right" title="Align right edges"><svg viewBox="0 0 24 24"><path d="M20 3v18M6 7h10v4H6zM10 13h6v4h-6z" /></svg></A>
          <A k="top" title="Align top edges"><svg viewBox="0 0 24 24"><path d="M3 4h18M7 8h4v10H7zM13 8h4v6h-4z" /></svg></A>
          <A k="vcenter" title="Align vertical centres"><svg viewBox="0 0 24 24"><path d="M3 12h18M7 6h4v12H7zM13 8h4v8h-4z" /></svg></A>
          <A k="bottom" title="Align bottom edges"><svg viewBox="0 0 24 24"><path d="M3 20h18M7 6h4v10H7zM13 10h4v6h-4z" /></svg></A>
          <button title="Distribute horizontally" disabled={sel.length < 3} onClick={() => st.distributeSelection("x")}><svg viewBox="0 0 24 24"><path d="M3 3v18M21 3v18M9 8h6v8H9z" /></svg></button>
          <button title="Distribute vertically" disabled={sel.length < 3} onClick={() => st.distributeSelection("y")}><svg viewBox="0 0 24 24"><path d="M3 3h18M3 21h18M8 9h8v6H8z" /></svg></button>
        </span></label>
        <label>{sel.length > 1 ? "Aligns to the selection" : "Aligns to the canvas"} — Shift constrains, Alt scales from centre, drag outside a corner to rotate</label>
        {pixelSelection && <label style={{ color: "var(--text)" }}>Pixel selection active</label>}
      </>}
      {showGrid && <label style={{ marginLeft: "auto" }}>Grid <input type="number" style={{ width: 50 }} min={2} value={gridSize} onChange={(e) => useStore.setState({ gridSize: Math.max(2, Number(e.target.value)) })} onKeyDown={(e) => e.stopPropagation()} /> px</label>}
      {tool === "marquee" && <>
        <label>Shape <div className="seg"><button className={marqueeKind === "rect" ? "on" : ""} onClick={() => useStore.setState({ marqueeKind: "rect" })}>Rectangle</button><button className={marqueeKind === "ellipse" ? "on" : ""} onClick={() => useStore.setState({ marqueeKind: "ellipse" })}>Ellipse</button></div></label>
        <label>Drag to select; Shift adds to a selection (or keeps it square), Alt subtracts. Brush strokes stay inside; Delete hides the area; Alt+Backspace fills; Select menu for modify/save</label>
      </>}
      {tool === "lasso" && <>
        <label>Kind <div className="seg"><button className={useStore.getState().lassoKind === "free" ? "on" : ""} onClick={() => useStore.setState({ lassoKind: "free" })}>Freehand</button><button className={useStore.getState().lassoKind === "polygon" ? "on" : ""} onClick={() => useStore.setState({ lassoKind: "polygon" })}>Polygonal</button></div></label>
        <label>{useStore.getState().lassoKind === "polygon" ? "Click corners; click the first point or Enter to close, Esc cancels" : "Drag a freehand selection"} — Shift adds, Alt subtracts (Shift+L switches kind)</label>
      </>}
      {tool === "pen" && <label>Click to add corner points, drag to add curve points. Enter or click the first point closes the path; Backspace removes the last point; Esc cancels <input type="color" value={fgColor} onChange={(e) => useStore.setState({ fgColor: e.target.value })} /></label>}
      {tool === "gradient" && <>
        <label>Type <select value={useStore.getState().gradientType} onChange={(e) => useStore.setState({ gradientType: e.target.value as "linear" })}>{["linear", "radial", "angle", "reflected", "diamond"].map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label><input type="color" value={fgColor} onChange={(e) => useStore.setState({ fgColor: e.target.value })} /> → <input type="color" value={useStore.getState().bgColor} onChange={(e) => useStore.setState({ bgColor: e.target.value })} /> <input type="checkbox" checked={useStore.getState().gradientToTransparent} onChange={(e) => useStore.setState({ gradientToTransparent: e.target.checked })} /> to transparent</label>
        <label>Drag to add a gradient fill over the artboard or canvas; Shift snaps the angle. Edit stops in Properties</label>
      </>}
      {tool === "crop" && <>
        <label>{cropRect ? `${cropRect.width} × ${cropRect.height} px` : "Drag the area to keep"}</label>
        <button className="btn primary" disabled={!cropRect} onClick={() => st.applyCrop()}>Crop</button>
        <button className="btn" disabled={!cropRect} onClick={() => useStore.setState({ cropRect: null })}>Cancel</button>
        <label>Enter applies, Esc cancels</label>
      </>}
      {tool === "eyedropper" && <label>Click the canvas to pick the foreground colour <input type="color" value={fgColor} onChange={(e) => useStore.setState({ fgColor: e.target.value })} /></label>}
      {tool === "shape" && <>
        <label>Shape <select value={shapeKind} onChange={(e) => st.setShapeKind(e.target.value as ShapeKind)}>{["rect", "ellipse", "line", "polygon", "star"].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label>Fill <input type="color" value={fgColor} onChange={(e) => useStore.setState({ fgColor: e.target.value })} /></label>
        <label>Drag on the canvas to draw; Shift keeps it square</label>
      </>}
      {tool === "text" && <>
        <label>Click to add point text, drag to add a paragraph box</label>
        <label>Color <input type="color" value={fgColor} onChange={(e) => useStore.setState({ fgColor: e.target.value })} /></label>
        {textSel.length > 0 && <>
          <label>Font <select value={(textSel[0] as { fontFamily: string }).fontFamily} onChange={(e) => textSel.forEach((l) => st.setLayerProps(l.id, { fontFamily: e.target.value }, "Font"))}>{fonts.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
          <label>Size <input type="number" style={{ width: 54 }} value={(textSel[0] as { fontSize: number }).fontSize} onChange={(e) => textSel.forEach((l) => st.setLayerProps(l.id, { fontSize: Number(e.target.value) }, "Font size", "fs:" + l.id))} onKeyDown={(e) => e.stopPropagation()} /></label>
        </>}
      </>}
      {tool === "wand" && <label>Tolerance <input type="range" min={0} max={200} value={wandTolerance} style={{ width: 100 }} onChange={(e) => useStore.setState({ wandTolerance: Number(e.target.value) })} /> {wandTolerance} — click a colour on the canvas to select the contiguous area</label>}
      {tool === "direct" && <label>Drag anchors and handles; double-click an anchor to toggle corner/smooth; Alt-click the outline to add an anchor; Delete removes the last dragged anchor</label>}
      {(tool === "brush" || tool === "eraser" || tool === "clone" || tool === "heal") && <>
        <label>Size <input type="range" min={1} max={300} value={brush.size} style={{ width: 110 }} onChange={(e) => setBrush({ size: Number(e.target.value) })} /><input type="number" style={{ width: 50 }} value={brush.size} min={1} max={2000} onChange={(e) => setBrush({ size: Math.max(1, Number(e.target.value)) })} onKeyDown={(e) => e.stopPropagation()} /> px</label>
        <label>Hardness <input type="range" min={0} max={100} value={Math.round(brush.hardness * 100)} style={{ width: 80 }} onChange={(e) => setBrush({ hardness: Number(e.target.value) / 100 })} /> {Math.round(brush.hardness * 100)}%</label>
        <label>Opacity <input type="range" min={1} max={100} value={Math.round(brush.opacity * 100)} style={{ width: 80 }} onChange={(e) => setBrush({ opacity: Number(e.target.value) / 100 })} /> {Math.round(brush.opacity * 100)}%</label>
        {tool === "brush" && <label>Color <input type="color" value={fgColor} onChange={(e) => useStore.setState({ fgColor: e.target.value })} /></label>}
        <label>{tool === "clone" || tool === "heal" ? "Alt-click to set the source, then paint; the source follows your stroke" : editMask ? (tool === "brush" ? "Mask: revealing" : "Mask: hiding") : tool === "brush" ? "Paints into the selected paint layer, or starts a new one" : "Erases on the selected paint layer"} — [ and ] change size{sel.length === 1 && sel[0].type !== "group" ? ", \\ toggles mask editing" : ""}</label>
      </>}
      {tool === "hand" && <label>Drag to pan. Hold Space with any tool to pan temporarily.</label>}
      {tool === "zoom" && <label>Click to zoom in, Alt-click to zoom out. Ctrl/⌘ + scroll also zooms.</label>}
    </div>
  );
}

// ---- Document tabs -----------------------------------------------------------------------------

export function DocTabs() {
  const recent = useStore((s) => s.recentDocs);
  const doc = useStore((s) => s.doc);
  if (!recent.length) return <div className="doctabs" />;
  return (
    <div className="doctabs" onPointerDown={(e) => e.stopPropagation()}>
      {recent.map((d) => <button key={d.id} className={doc?.id === d.id ? "on" : ""} title={d.id} onClick={() => { if (doc?.id !== d.id) { useStore.getState().connect(d.id); useStore.setState({ zoom: 1, pan: { x: 0, y: 0 } }); } }}>{d.name}</button>)}
      <button className="new" title="New document" onClick={() => useStore.setState({ modal: "new" })}>+</button>
    </div>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["X / D", "Swap foreground & background / default colours"], ["F / Tab", "Cycle screen modes / hide panels"], ["R", "Rotate view"], ["⌘S / ⇧⌘S", "Save (autosaves) / Save As"], ["⌥⇧⌘W", "Export As…"], ["⌘K / ⌥⇧⌘K", "Preferences / Keyboard shortcuts"],
  ["⌘X / ⇧⌘C / ⇧⌘V", "Cut layers / Copy merged / Paste in place"], ["⌘T", "Free Transform (handles + options bar)"], ["⌘H / ⌥⌘;", "Hide Extras / Lock guides"], ["⇧⌘N / ⌥⇧⌘N", "New layer (with / without name)"], ["⇧⌘E", "Merge visible"],
  ["⌘L / ⌘M / ⌘U / ⌘B / ⌘I / ⇧⌘U", "Levels / Curves / Hue-Sat / Color balance / Invert / Desaturate"], ["⌥⌘I", "Image / canvas size"], ["⇧⌘> / ⇧⌘<  ⌥→ / ⌥←", "Font size / tracking"], ["⌘⌫", "Fill selection with background"], ["⇧[ ]  ⇧1-0", "Brush hardness / fill opacity"],
  ["V / A", "Move / Direct selection"], ["M / ⇧M", "Marquee rect / ellipse"], ["L / W", "Lasso / Magic wand"], ["T / P", "Type / Pen"], ["U / ⇧U", "Shape / cycle shapes"],
  ["B / E", "Brush / Eraser"], ["S / J", "Clone stamp / Healing brush"], ["G / C / I", "Gradient / Crop / Eyedropper"], ["H / Z / Space", "Hand / Zoom / temporary pan"], ["[ ]", "Brush size"],
  ["⌘Z / ⇧⌘Z", "Undo / Redo"], ["⌘J / ⌘G / ⇧⌘G", "Duplicate / Group / Ungroup"], ["⌘E / ⌘L", "Merge into image / Link layers"], ["⌘] [ / ⇧⌘] [", "Reorder / to front or back"], ["⌘/ ⌘,", "Lock / hide layers"],
  ["Edit › Transform", "Skew / distort / perspective: drag the magenta corners, Enter or Esc to finish"], ["Delete / ⌥⌫", "Delete layer or selection / Fill selection"], ["⌘D / ⇧⌘I / ⇧⌘T", "Deselect / Inverse / Transform selection"], ["\\", "Paint the layer mask"], ["1-9, 0", "Layer opacity"], ["Arrows / ⇧Arrows", "Nudge 1 / 10 px"],
  ["⌘0 / ⇧⌘0 / ⌘1 / ⌘2", "Fit / Zoom to selection / 100% / 200%"], ["⌘+ / ⌘−", "Zoom in / out"], ["⌘R / ⌘; / ⌘'", "Rulers / Guides / Grid"], ["⌘N / ⌘O / ⇧⌘E", "New / Open / Export PNG"], ["⌘A / Esc / Enter", "Select all / Cancel / Apply crop or path"],
];

/** Photoshop's transform options bar: numeric X / Y / W / H / angle for the selected layer. */
function TransformBar({ l }: { l: import("@pictocity/core").Layer }) {
  const st = useStore.getState();
  const set = (props: Record<string, number>) => st.dispatch([{ type: "layer.set", id: l.id, props }], "Transform");
  const N = ({ k, label, v, step = 1 }: { k: string; label: string; v: number; step?: number }) => <label>{label} <input type="number" step={step} value={Math.round(v * 10) / 10} style={{ width: 60 }} onChange={(e) => set({ [k]: Number(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} /></label>;
  return <>
    <N k="x" label="X" v={l.x} /><N k="y" label="Y" v={l.y} /><N k="width" label="W" v={l.width} /><N k="height" label="H" v={l.height} /><N k="rotation" label="∠" v={l.rotation} step={0.5} />
    <span className="sep" />
  </>;
}

// ---- Timeline ------------------------------------------------------------------------------------

export function Timeline() {
  const doc = useStore((s) => s.doc);
  const show = useStore((s) => s.showTimeline);
  const time = useStore((s) => s.animTime);
  const playing = useStore((s) => s.playing);
  const selection = useStore((s) => s.selection);
  const st = useStore.getState();
  const anim = doc?.animation;
  const duration = anim?.duration ?? 3000;
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => { const s = useStore.getState(); const d = s.doc?.animation?.duration ?? 3000; let t = s.animTime + (now - last); last = now; if (t > d) t = s.doc?.animation?.loop === false ? d : 0; useStore.setState({ animTime: t }); if (t >= d && s.doc?.animation?.loop === false) { useStore.setState({ playing: false }); return; } raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  if (!show || !doc) return null;
  const tracks = Object.entries(anim?.tracks ?? {}).map(([id, kfs]) => ({ id, kfs, layer: findLayer(doc, id) })).filter((t) => t.layer);
  const sel = selectedLayers(useStore.getState());
  const kfAtTime = sel.length === 1 ? anim?.tracks[sel[0].id]?.find((k) => k.t === Math.round(time)) : undefined;
  return (
    <div className="timeline" onPointerDown={(e) => e.stopPropagation()}>
      <div className="tl-controls">
        <button className="btn" title="Play / pause (Space in the timeline)" onClick={() => useStore.setState({ playing: !playing })}>{playing ? "⏸" : "▶"}</button>
        <button className="btn" title="Back to start" onClick={() => useStore.setState({ animTime: 0, playing: false })}>⏮</button>
        <input type="range" min={0} max={duration} step={1} value={Math.round(time)} style={{ flex: 1 }} onChange={(e) => useStore.setState({ animTime: Number(e.target.value), playing: false })} />
        <span className="tl-time">{(time / 1000).toFixed(2)} s</span>
        <label>Length <input type="number" style={{ width: 62 }} min={100} step={100} value={duration} onChange={(e) => st.setAnimation({ duration: Math.max(100, Number(e.target.value)) })} onKeyDown={(e) => e.stopPropagation()} /> ms</label>
        <label>FPS <input type="number" style={{ width: 44 }} min={1} max={60} value={anim?.fps ?? 12} onChange={(e) => st.setAnimation({ fps: Math.max(1, Math.min(60, Number(e.target.value))) })} onKeyDown={(e) => e.stopPropagation()} /></label>
        <label><input type="checkbox" checked={anim?.loop !== false} onChange={(e) => st.setAnimation({ loop: e.target.checked })} /> Loop</label>
        <button className="btn primary" disabled={!selection.length} title="Snapshot position, opacity, rotation and scale of the selected layers at the playhead" onClick={() => st.addKeyframe()}>◆ {kfAtTime ? "Update" : "Add"} keyframe</button>
        {kfAtTime && <>
          <select value={kfAtTime.ease ?? "linear"} onChange={(e) => { const a = doc.animation!; const tr = { ...a.tracks, [sel[0].id]: a.tracks[sel[0].id].map((k) => (k.t === kfAtTime.t ? { ...k, ease: e.target.value as "linear" } : k)) }; st.dispatch([{ type: "doc.set", props: { animation: { ...a, tracks: tr } } }], "Ease"); }}>{["linear", "ease-in", "ease-out", "ease-in-out"].map((x) => <option key={x} value={x}>{x}</option>)}</select>
          <button className="btn" onClick={() => st.deleteKeyframe()}>Delete keyframe</button>
        </>}
        <span className="spacer" />
        <button className="btn" onClick={() => exportDoc("gif" as never)}>Export GIF</button>
        <button className="btn" onClick={() => exportDoc("html" as never)}>Export HTML5</button>
        <button className="btn" onClick={() => useStore.setState({ showTimeline: false, animTime: 0, playing: false })}>×</button>
      </div>
      <div className="tl-tracks">
        {!tracks.length && <div className="hint">Select a layer, move the playhead, and add keyframes. Position, opacity, rotation and scale animate between them. Export as animated GIF or an HTML5 banner (CSS keyframes).</div>}
        {tracks.map(({ id, kfs, layer }) => (
          <div key={id} className={`tl-track${selection.includes(id) ? " sel" : ""}`} onClick={() => st.select([id])}>
            <span className="tl-name">{layer!.name}</span>
            <div className="tl-lane">
              {kfs.map((k) => <span key={k.t} className={`tl-key${Math.round(time) === k.t ? " on" : ""}`} style={{ left: `${(k.t / duration) * 100}%` }} title={`${k.t} ms — click to go there, Alt-click to delete`} onClick={(e) => { e.stopPropagation(); if (e.altKey) st.deleteKeyframe(id, k.t); else useStore.setState({ animTime: k.t, playing: false }); }} />)}
              <span className="tl-head" style={{ left: `${Math.min(100, (time / duration) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Layer comps ---------------------------------------------------------------------------------

export function CompsPanel() {
  const doc = useStore((s) => s.doc);
  const st = useStore.getState();
  const comps = doc?.comps ?? [];
  if (!doc) return null;
  return (
    <section className="panel fixed" style={{ maxHeight: "22%" }}>
      <header>Layer comps<span className="spacer" /><button title="Save the current state as a new comp" onClick={() => { const name = prompt("Comp name", `Comp ${comps.length + 1}`); if (name) st.saveComp(name); }}>+ New</button></header>
      <div className="body">
        {!comps.length && <div className="hint">Save states of visibility, position and text — A/B headlines, languages — and switch between them. Export every comp from the agent or the API.</div>}
        {comps.map((c) => (
          <div key={c.id} className="row" style={{ gap: 4 }}>
            <button className="btn" style={{ flex: 1, textAlign: "left" }} title="Apply this comp" onClick={() => st.applyComp(c.id)}>{c.name}</button>
            <button className="btn" title="Update this comp with the current state" onClick={() => st.saveComp(c.name, c.id)}>↻</button>
            <button className="btn" title="Rename" onClick={() => { const name = prompt("Comp name", c.name); if (name && name !== c.name) st.dispatch([{ type: "doc.set", props: { comps: comps.map((x) => (x.id === c.id ? { ...x, name } : x)) } }], "Rename comp"); }}>✎</button>
            <button className="btn" title="Delete" onClick={() => st.deleteComp(c.id)}>×</button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- Swatches (recent colours) -----------------------------------------------------------------

export function Swatches() {
  const recent = useStore((s) => s.recentColors);
  const fg = useStore((s) => s.fgColor);
  const [brand, setBrand] = useState<{ name?: string; colors?: { name: string; hex: string; role?: string }[] } | null>(null);
  useEffect(() => { fetch("/api/brand").then((r) => r.json()).then(setBrand).catch(() => undefined); }, []);
  return (
    <section className="panel fixed">
      <header>Swatches<span className="spacer" /><span style={{ fontWeight: 400, color: "var(--text-faint)" }}>{brand?.colors?.length ? `brand · ${brand.name ?? ""}` : "recent"}</span></header>
      {!!brand?.colors?.length && <div className="swatches-row">{brand.colors.map((c) => <button key={c.hex + c.name} title={`${c.name}${c.role ? ` (${c.role})` : ""} ${c.hex}`} className={c.hex === fg ? "on" : ""} style={{ background: c.hex }} onClick={() => useStore.getState().setFgColor(c.hex)} />)}</div>}
      <div className="swatches-row">{recent.map((c) => <button key={c} title={c} className={c === fg ? "on" : ""} style={{ background: c }} onClick={() => useStore.getState().setFgColor(c)} />)}</div>
    </section>
  );
}

// ---- History panel -------------------------------------------------------------------------

export function HistoryPanel() {
  const log = useStore((s) => s.log);
  const doc = useStore((s) => s.doc);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [log.length]);
  return (
    <section className="panel grow history" style={{ maxHeight: "28%" }}>
      <header>History<span className="spacer" /><span style={{ fontWeight: 400, color: "var(--text-faint)" }}>{log.length}</span></header>
      <div className="body" ref={ref}>
        {doc && <div className="item" onClick={() => useStore.getState().revertTo(0)}><span className="who" style={{ background: "#666" }} />Open document<span className="rev">rev 0</span></div>}
        {log.map((a) => (
          <div key={a.rev} className="item" title={`${a.actor} at ${new Date(a.at).toLocaleTimeString()} — click to revert the document to this point`} onClick={() => useStore.getState().revertTo(a.rev)}>
            <span className={`who${a.actor.startsWith("agent:") ? " agent" : ""}`} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.label ?? a.ops.map((o: Op) => o.type).join(", ")}</span>
            <span className="rev">{a.actor.startsWith("agent:") ? a.actor.replace("agent:", "") : ""} {a.rev}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- Status bar --------------------------------------------------------------------------------

export function StatusBar() {
  const zoom = useStore((s) => s.zoom);
  const doc = useStore((s) => s.doc);
  const sel = useStore(selectedLayers);
  const st = useStore.getState();
  return (
    <div className="statusbar">
      <span><input type="text" value={`${Math.round(zoom * 100)}%`} onChange={() => undefined} onKeyDown={(e) => { if (e.key === "Enter") { const v = parseFloat((e.target as HTMLInputElement).value); if (v > 0) st.setView(v / 100); } e.stopPropagation(); }} /></span>
      {doc && <span>{doc.width} × {doc.height} px</span>}
      {sel.length === 1 && <span>{sel[0].name} — {Math.round(sel[0].x)}, {Math.round(sel[0].y)}  {Math.round(sel[0].width)} × {Math.round(sel[0].height)}{sel[0].rotation ? `  ${sel[0].rotation}°` : ""}</span>}
      {sel.length > 1 && <span>{sel.length} layers selected</span>}
      <span style={{ marginLeft: "auto" }}>{doc ? "Changes save automatically and sync to the agent" : ""}</span>
    </div>
  );
}

export function layerLabel(id: string): string { const d = useStore.getState().doc; return d ? findLayer(d, id)?.name ?? id : id; }
