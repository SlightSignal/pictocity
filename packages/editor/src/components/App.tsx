import React, { useEffect, useState } from "react";
import { ExportDialog, OpenDialog as OpenDialog2, SaveAsDialog, ExportsDialog, PreferencesDialog } from "./Dialogs";
import { ADJ_DEFS } from "./PropertiesPanel";
import { AD_PRESETS, clampDimension, resizeLayoutOps, addArtboardOps, artboards, copyToArtboardOps, findLayer, isGroup, makeBrush } from "@pictocity/core";
import { topLevelOnly } from "../store";
import { useStore } from "../store";
import { loadFonts, servedFamilies } from "../env";
import { CanvasView } from "./CanvasView";
import { LayersPanel } from "./LayersPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { MenuBar, ToolBar, OptionsBar, HistoryPanel, StatusBar, Swatches, DocTabs, CompsPanel, Timeline, SHORTCUTS, zoomBy, zoomToSelection, exportDoc, toggleLock, toggleVisible, importPsdFile, importImageFile, importSvgFile } from "./Chrome";

/** Photoshop's ⌘⇧C: copy the flattened image to the clipboard as PNG. */
async function copyMerged() {
  const st = useStore.getState(); if (!st.doc) return;
  try { const blob = await fetch(`/api/docs/${st.doc.id}/render.png?scale=1&t=${Date.now()}`).then((r) => r.blob()); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); st.showToast("Merged image copied to the clipboard"); }
  catch { st.showToast("Clipboard image copy isn't available in this browser"); }
}
function bumpFont(delta: number) {
  const st = useStore.getState(); if (!st.doc) return;
  const ops = st.selection.map((id) => findLayer(st.doc!, id)).filter((l): l is import("@pictocity/core").TextLayer => !!l && l.type === "text").map((l) => ({ type: "layer.set" as const, id: l.id, props: { fontSize: Math.max(1, l.fontSize + delta) } }));
  if (ops.length) st.dispatch(ops, "Font size");
}
function bumpTracking(delta: number) {
  const st = useStore.getState(); if (!st.doc) return;
  const ops = st.selection.map((id) => findLayer(st.doc!, id)).filter((l): l is import("@pictocity/core").TextLayer => !!l && l.type === "text").map((l) => ({ type: "layer.set" as const, id: l.id, props: { letterSpacing: Math.round((l.letterSpacing + (delta / 1000) * l.fontSize) * 100) / 100 } }));
  if (ops.length) st.dispatch(ops, "Tracking");
}

export function App() {
  const modal = useStore((s) => s.modal);
  const doc = useStore((s) => s.doc);
  const toast = useStore((s) => s.toast);
  const panelsHidden = useStore((s) => s.panelsHidden);

  useEffect(() => {
    loadFonts().then((fonts) => useStore.setState({ fonts, servedFonts: servedFamilies }));
    const id = new URL(location.href).searchParams.get("doc");
    if (id) useStore.getState().connect(id);
    else useStore.getState().refreshDocs().then(() => { const d = useStore.getState().docs; if (d.length) useStore.setState({ modal: "open" }); });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const st = useStore.getState();
      const k = e.key.toLowerCase();
      // Dialogs: Escape closes them even while a field inside has focus.
      if (st.modal) { if (k === "escape") { e.preventDefault(); useStore.setState({ modal: null }); } return; }
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta) {
        if (k === "g" && e.altKey) { e.preventDefault(); st.toggleClipping(); return; }
        if (k === "z" && e.altKey) { e.preventDefault(); st.undo(); return; }                       // step backward
        if (k === "y") { e.preventDefault(); st.redo(); return; }                                    // Windows redo
        if (k === "s" && e.altKey && e.shiftKey) { e.preventDefault(); useStore.setState({ modal: "export" }); return; }  // Save for Web
        if (k === "w" && e.altKey && e.shiftKey) { e.preventDefault(); useStore.setState({ modal: "export" }); return; }  // Export As
        if (k === "s" && e.shiftKey) { e.preventDefault(); useStore.setState({ modal: "saveas" }); return; }
        if (k === "s") { e.preventDefault(); st.showToast(`Saved — rev ${st.doc?.rev ?? 0} (every change autosaves)`); return; }
        if (k === "w") { e.preventDefault(); useStore.setState({ modal: "open" }); return; }          // close → back to Open
        if (k === "k" && e.altKey && e.shiftKey) { e.preventDefault(); useStore.setState({ modal: "shortcuts" }); return; }
        if (k === "k") { e.preventDefault(); useStore.setState({ modal: "prefs" }); return; }
        if (k === "h") { e.preventDefault(); useStore.setState({ showExtras: !st.showExtras }); return; }
        if (k === ";" && e.altKey) { e.preventDefault(); useStore.setState({ guidesLocked: !st.guidesLocked }); return; }
        if (k === "n" && e.shiftKey) { e.preventDefault(); if (st.doc) { const name = e.altKey ? "Layer" : prompt("Layer name", "Layer"); if (name) { const l = makeBrush({ name, x: 0, y: 0, width: st.doc.width, height: st.doc.height }); st.dispatch([{ type: "layer.add", layer: l, parentId: null, index: st.doc.layers.length }], "New layer"); st.select([l.id]); } } return; }
        if (k === "e" && e.shiftKey && e.altKey) { e.preventDefault(); st.select(st.doc?.layers.filter((l) => l.visible).map((l) => l.id) ?? []); void st.mergeSelection(); return; } // stamp visible (approx.)
        if (k === "e" && e.shiftKey) { e.preventDefault(); st.select(st.doc?.layers.filter((l) => l.visible).map((l) => l.id) ?? []); void st.mergeSelection(); return; }               // merge visible
        if (k === "x") { e.preventDefault(); st.copyLayers(); st.deleteSelection(); return; }
        if (k === "c" && e.shiftKey) { e.preventDefault(); copyMerged(); return; }
        if (k === "v" && e.shiftKey) { e.preventDefault(); const txt = (window as unknown as { __pictocityClipboard?: string }).__pictocityClipboard; if (txt) { try { const p = JSON.parse(txt); if (p.pictocity === 1) st.pasteLayers(p, true); } catch { /* ignore */ } } return; }
        if (k === "d" && e.shiftKey) { e.preventDefault(); useStore.setState({ pixelSelection: st.lastSelection }); return; }
        if (k === "i" && e.altKey) { e.preventDefault(); useStore.setState({ modal: "size" }); return; }   // image size
        if (k === "c" && e.altKey) { e.preventDefault(); useStore.setState({ modal: "size" }); return; }   // canvas size
        if (k === "u" && e.shiftKey) { e.preventDefault(); st.applyAdjustmentToSelection("grayscale", 1); return; } // desaturate
        if (k === "b" && e.altKey && e.shiftKey) { e.preventDefault(); st.applyAdjustmentToSelection("blackWhite", ADJ_DEFS.blackWhite.init); return; }
        if (k === "u") { e.preventDefault(); st.applyAdjustmentToSelection("colorize", ADJ_DEFS.colorize.init); return; }
        if (k === "m" && !e.shiftKey) { e.preventDefault(); st.applyAdjustmentToSelection("curves", { rgb: [[0, 0], [255, 255]] }); return; }
        if (k === "b" && !e.shiftKey) { e.preventDefault(); st.applyAdjustmentToSelection("colorBalance", ADJ_DEFS.colorBalance.init); return; }
        if (k === "i" && !e.shiftKey) { e.preventDefault(); st.applyAdjustmentToSelection("invert", 1); return; }
        if (k === "t" && !e.shiftKey && !e.altKey) { e.preventDefault(); st.setTool("move"); if (!st.selection.length && st.doc) st.select(st.doc.layers.map((l) => l.id)); st.showToast("Free Transform: drag handles, Shift constrains, Alt from centre; X/Y/W/H in the options bar"); return; }
        if (k === "backspace" || k === "delete") { e.preventDefault(); if (st.pixelSelection) { const fg = st.fgColor; useStore.setState({ fgColor: st.bgColor }); st.fillPixelSelection(); useStore.setState({ fgColor: fg }); } return; } // fill with background
        if (k === "." && e.shiftKey || k === ">" ) { e.preventDefault(); bumpFont(e.altKey ? 10 : 2); return; }
        if (k === "," && e.shiftKey || k === "<") { e.preventDefault(); bumpFont(e.altKey ? -10 : -2); return; }
        if (k === "t" && e.altKey) { e.preventDefault(); useStore.setState({ showTimeline: !st.showTimeline, animTime: 0, playing: false }); return; }
        if (k === "z") { e.preventDefault(); e.shiftKey ? st.redo() : st.undo(); }
        else if (k === "y") { e.preventDefault(); st.redo(); }
        else if (k === "j") { e.preventDefault(); st.duplicateSelection(); }
        else if (k === "g") { e.preventDefault(); e.shiftKey ? st.ungroupSelection() : st.groupSelection(); }
        else if (k === "a") { e.preventDefault(); if (["marquee", "lasso", "wand"].includes(st.tool)) st.selectAllPixels(); else if (st.doc) st.select(st.doc.layers.map((l) => l.id)); }
        else if (k === "d") { e.preventDefault(); if (st.pixelSelection) useStore.setState({ pixelSelection: null }); else st.select([]); }
        else if (k === "'") { e.preventDefault(); useStore.setState({ showGrid: !st.showGrid }); }
        else if (k === "]") { e.preventDefault(); st.reorderSelection(e.shiftKey ? "top" : "up"); }
        else if (k === "[") { e.preventDefault(); st.reorderSelection(e.shiftKey ? "bottom" : "down"); }
        else if (k === "0") { e.preventDefault(); if (e.shiftKey) zoomToSelection(); else (window as unknown as { __fit?: () => void }).__fit?.(); }
        else if (k === "i" && e.shiftKey) { e.preventDefault(); st.invertPixelSelection(); }
        else if (k === "t" && e.shiftKey) { e.preventDefault(); if (st.pixelSelection) useStore.setState({ selectionTransform: !st.selectionTransform, tool: "move" }); }
        else if (k === "l" && !e.shiftKey && !e.altKey) { e.preventDefault(); st.applyAdjustmentToSelection("levels", { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }); }
        else if (k === "c") { e.preventDefault(); st.copyLayers(); }
        else if (k === "v") { /* handled by the paste event so image files work too */ }
        else if (k === "1") { e.preventDefault(); st.setView(1); }
        else if (k === "2") { e.preventDefault(); st.setView(2); }
        else if (k === "=" || k === "+") { e.preventDefault(); zoomBy(1.25); }
        else if (k === "-") { e.preventDefault(); zoomBy(1 / 1.25); }
        // Removed 2026-09-07: this branch was unreachable. Line 67 handles
        // Ctrl+Shift+E and returns, so control never arrived here. Keeping it
        // was worse than dead code -- the shortcut sheet cited it, so the UI
        // advertised "Export PNG" for a chord that merges visible layers.
        // Line 67 is CORRECT (Photoshop: Ctrl+E merge down, Ctrl+Shift+E merge
        // visible, Ctrl+Shift+Alt+E stamp visible -- all three implemented).
        // Export already has live shortcuts: Alt+Shift+S and Alt+Shift+W both
        // open the export modal. The sheet is corrected to match.
        else if (k === "e") { e.preventDefault(); st.mergeSelection(); }
        else if (k === "s") { e.preventDefault(); st.showToast("Saved — every change is stored on the server as it happens"); }
        else if (k === "n") { e.preventDefault(); useStore.setState({ modal: "new" }); }
        else if (k === "o") { e.preventDefault(); st.refreshDocs(); useStore.setState({ modal: "open" }); }
        else if (k === "/") { e.preventDefault(); toggleLock(); }
        else if (k === "r") { e.preventDefault(); useStore.setState({ showRulers: !st.showRulers }); }
        else if (k === ";") { e.preventDefault(); useStore.setState({ showGuides: !st.showGuides }); }
        else if (k === ",") { e.preventDefault(); toggleVisible(); }
        return;
      }
      // Fixed 2026-09-07: the tracking chord used to sit BELOW the altKey
      // block, which returns unconditionally -- so Alt+Left/Right never ran,
      // and bumpTracking() (defined above) had no reachable call site at all.
      // The Type menu advertises ⌥→ / ⌥← and the shortcut sheet lists them.
      // Checked before the catch-all now; the menu items were always fine.
      if (e.altKey && (k === "arrowleft" || k === "arrowright") && !meta) { e.preventDefault(); bumpTracking(k === "arrowright" ? 20 : -20); return; }
      if (e.altKey) {
        if ((k === "backspace" || k === "delete") && st.pixelSelection) { e.preventDefault(); st.fillPixelSelection(); }
        return;
      }
      switch (k) {
        case "tab": e.preventDefault(); useStore.setState({ panelsHidden: !st.panelsHidden, menuHidden: false }); break;
        case "x": { const fg = st.fgColor; useStore.setState({ fgColor: st.bgColor, bgColor: fg }); break; }
        case "d": useStore.setState({ fgColor: "#000000", bgColor: "#ffffff" }); break;
        case "f": useStore.setState(st.menuHidden ? { menuHidden: false, panelsHidden: false } : st.panelsHidden ? { menuHidden: true } : { panelsHidden: true }); break;
        case "r": st.setTool("rotate"); break;
        // Fixed 2026-09-07: an unshifted "[" fell through to `break` here, and
        // a LATER duplicate `case "[": case "]"` held the brush-size logic --
        // dead, because the first matching case in a switch wins. So "[" and
        // "]" did nothing, while the options bar said "[ and ] change size"
        // and the shortcut sheet listed them. Both behaviours now live here.
        case "{": case "[": if (e.shiftKey) { useStore.setState({ brush: { ...st.brush, hardness: Math.max(0, Math.round((st.brush.hardness - 0.25) * 100) / 100) } }); return; }
          if (st.tool === "brush" || st.tool === "eraser") { e.preventDefault(); useStore.setState({ brush: { ...st.brush, size: Math.max(1, Math.round(st.brush.size * 0.8)) } }); } break;
        case "}": case "]": if (e.shiftKey) { useStore.setState({ brush: { ...st.brush, hardness: Math.min(1, Math.round((st.brush.hardness + 0.25) * 100) / 100) } }); return; }
          if (st.tool === "brush" || st.tool === "eraser") { e.preventDefault(); useStore.setState({ brush: { ...st.brush, size: Math.max(1, Math.round(st.brush.size * 1.25)) } }); } break;
        case "?": useStore.setState({ modal: "shortcuts" }); break;
        case "/": if (e.shiftKey) useStore.setState({ modal: "shortcuts" }); break;
        case "w": st.setTool("wand"); break;
        case "s": st.setTool("clone"); break;
        case "j": st.setTool("heal"); break;
        case "a": st.setTool("direct"); break;
        case "m": if (e.shiftKey) useStore.setState({ marqueeKind: st.marqueeKind === "rect" ? "ellipse" : "rect", tool: "marquee" }); else st.setTool("marquee"); break;
        case "l": if (e.shiftKey) useStore.setState({ lassoKind: st.lassoKind === "free" ? "polygon" : "free", tool: "lasso" }); else st.setTool("lasso"); break;
        case "p": st.setTool("pen"); break;
        case "g": st.setTool("gradient"); break;
        case "v": st.setTool("move"); break;
        case "t": st.setTool("text"); break;
        case "u": if (e.shiftKey) { const order = ["rect", "ellipse", "line", "polygon", "star"] as const; st.setShapeKind(order[(order.indexOf(st.shapeKind) + 1) % order.length]); } else st.setTool("shape"); break;
        case "b": st.setTool("brush"); break;
        case "e": st.setTool("eraser"); break;
        // (the duplicate `case "[": case "]"` that used to sit here was
        //  unreachable -- its logic moved up into the "{"/"}" cases above)
        case "h": st.setTool("hand"); break;
        case "z": st.setTool("zoom"); break;
        case "c": st.setTool("crop"); break;
        case "i": st.setTool("eyedropper"); break;
        case "\\": if (st.selection.length === 1) { e.preventDefault(); useStore.setState({ editMask: !st.editMask }); if (!st.editMask && st.tool !== "brush" && st.tool !== "eraser") st.setTool("brush"); } break;
        case "enter": if (st.distortMode) { e.preventDefault(); useStore.setState({ distortMode: null }); break; } if (st.tool === "lasso" && st.lassoKind === "polygon") { e.preventDefault(); window.dispatchEvent(new CustomEvent("pictocity:lasso", { detail: "finish" })); break; } if (st.selectionTransform) { e.preventDefault(); useStore.setState({ selectionTransform: false }); } else if (st.cropRect) { e.preventDefault(); st.applyCrop(); } else if (st.tool === "pen") { e.preventDefault(); window.dispatchEvent(new CustomEvent("pictocity:pen", { detail: "finish" })); } break;
        case "escape": if (st.viewRotation && st.tool === "rotate") { useStore.setState({ viewRotation: 0 }); break; } if (st.distortMode) { useStore.setState({ distortMode: null }); break; } if (st.tool === "lasso" && st.lassoKind === "polygon") { window.dispatchEvent(new CustomEvent("pictocity:lasso", { detail: "cancel" })); break; } if (st.selectionTransform) useStore.setState({ selectionTransform: false }); else if (st.cropRect) useStore.setState({ cropRect: null }); else if (st.tool === "pen") window.dispatchEvent(new CustomEvent("pictocity:pen", { detail: "cancel" })); else if (st.pixelSelection) useStore.setState({ pixelSelection: null }); else if (st.editMask) useStore.setState({ editMask: false }); else st.select([]); break;
        case "delete": case "backspace": e.preventDefault(); if (st.tool === "direct") { window.dispatchEvent(new CustomEvent("pictocity:anchor-delete")); break; } if (st.tool === "pen") { window.dispatchEvent(new CustomEvent("pictocity:pen", { detail: "undo" })); break; } if (st.pixelSelection && st.selection.length) st.hidePixelSelection(); else st.deleteSelection(); break;
        case "arrowleft": e.preventDefault(); st.nudge(e.shiftKey ? -10 : -1, 0); break;
        case "arrowright": e.preventDefault(); st.nudge(e.shiftKey ? 10 : 1, 0); break;
        case "arrowup": e.preventDefault(); st.nudge(0, e.shiftKey ? -10 : -1); break;
        case "arrowdown": e.preventDefault(); st.nudge(0, e.shiftKey ? 10 : 1); break;
        default:
          // Photoshop: number keys set opacity of the selected layers with the move tool.
          if (st.tool === "move" && /^[0-9]$/.test(k) && st.selection.length) {
            const v = k === "0" ? 1 : Number(k) / 10;
            st.dispatch(st.selection.map((id) => ({ type: "layer.set" as const, id, props: { opacity: v } })), "Opacity");
          }
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); files.forEach((f) => importImageFile(f)); return; }
      const text = e.clipboardData?.getData("text/plain") || (window as unknown as { __pictocityClipboard?: string }).__pictocityClipboard || "";
      if (text.includes('"pictocity"')) { try { const p = JSON.parse(text); if (p.pictocity === 1 && Array.isArray(p.layers)) { e.preventDefault(); useStore.getState().pasteLayers(p); } } catch { /* not ours */ } }
    };
    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/") || /\.(psd|svg)$/i.test(f.name));
      if (!files.length) return;
      e.preventDefault();
      files.forEach((f) => (/\.psd$/i.test(f.name) ? importPsdFile(f) : /\.svg$/i.test(f.name) || f.type === "image/svg+xml" ? importSvgFile(f, true) : importImageFile(f)));
    };
    const onDragOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragover", onDragOver);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("paste", onPaste); window.removeEventListener("drop", onDrop); window.removeEventListener("dragover", onDragOver); };
  }, []);

  return (
    <div className={`app${panelsHidden ? " panels-hidden" : ""}${useStore.getState().menuHidden ? " menu-hidden" : ""}`}>
      <MenuBar />
      <OptionsBar />
      <ToolBar />
      <DocTabs />
      <CanvasView />
      <Timeline />
      <div className="panels">
        <Swatches />
        <PropertiesPanel />
        <LayersPanel />
        <CompsPanel />
        <HistoryPanel />
      </div>
      <StatusBar />
      {modal === "new" && <NewDialog />}
      {modal === "open" && <OpenDialog2 />}
      {modal === "export" && doc && <ExportDialog />}
      {modal === "saveas" && doc && <SaveAsDialog />}
      {modal === "exports" && <ExportsDialog />}
      {modal === "prefs" && <PreferencesDialog />}
      {modal === "size" && <SizeDialog />}
      {modal === "variant" && <SizeDialog variant />}
      {modal === "artboard" && <ArtboardDialog />}
      {modal === "copyto" && <CopyToDialog />}
      {modal === "shortcuts" && <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}><div className="modal" style={{ width: 560 }}><header>Keyboard shortcuts</header><div className="content" style={{ gridTemplateColumns: "150px 1fr 150px 1fr" }}>{SHORTCUTS.map(([k, d]) => <React.Fragment key={k}><label style={{ textAlign: "left", color: "var(--text)" }}>{k}</label><span style={{ color: "var(--text-dim)" }}>{d}</span></React.Fragment>)}</div><footer><button className="btn primary" onClick={() => useStore.setState({ modal: null })}>Close</button></footer></div></div>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function NewDialog() {
  const [name, setName] = useState("Untitled ad");
  const [preset, setPreset] = useState(0);
  const [w, setW] = useState(AD_PRESETS[0].width);
  const [h, setH] = useState(AD_PRESETS[0].height);
  const [bg, setBg] = useState("#ffffff");
  const [transparent, setTransparent] = useState(false);
  const create = () => useStore.getState().createDoc({ name: name.trim() || "Untitled ad", width: clampDimension(w, 1080), height: clampDimension(h, 1080), background: transparent ? null : bg });
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal">
        <header>New document</header>
        <div className="content">
          <label>Name</label><input type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
          <label>Preset</label><select value={preset} onChange={(e) => { const i = Number(e.target.value); setPreset(i); if (i >= 0) { setW(AD_PRESETS[i].width); setH(AD_PRESETS[i].height); } }}>{[...new Set(AD_PRESETS.map((p) => p.group ?? "Other"))].map((g) => <optgroup key={g} label={g}>{AD_PRESETS.map((p, i) => (p.group ?? "Other") === g ? <option key={p.name} value={i}>{p.name} — {p.width}×{p.height}</option> : null)}</optgroup>)}<option value={-1}>Custom</option></select>
          <label>Width</label><input type="number" min={1} max={8192} value={w} onChange={(e) => { setW(Number(e.target.value)); setPreset(-1); }} />
          <label>Height</label><input type="number" min={1} max={8192} value={h} onChange={(e) => { setH(Number(e.target.value)); setPreset(-1); }} />
          <label>Background</label><div style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="color" value={bg} disabled={transparent} onChange={(e) => setBg(e.target.value)} /><label style={{ textAlign: "left" }}><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent</label></div>
        </div>
        <footer><button className="btn" onClick={() => useStore.setState({ modal: null })}>Cancel</button><button className="btn primary" onClick={create}>Create</button></footer>
      </div>
    </div>
  );
}

function CopyToDialog() {
  const doc = useStore((s) => s.doc)!;
  const selection = useStore((s) => s.selection);
  const [fit, setFit] = useState(true);
  const list = artboards(doc);
  const copy = (targetId: string) => {
    try {
      const { ops, newIds } = copyToArtboardOps(doc, topLevelOnly(doc, selection), targetId, { fit });
      if (ops.length) { useStore.getState().dispatch(ops, "Copy to artboard"); useStore.getState().select(newIds); }
    } catch (e) { useStore.getState().showToast((e as Error).message); }
    useStore.setState({ modal: null });
  };
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal">
        <header>Copy {selection.length} layer{selection.length === 1 ? "" : "s"} to artboard</header>
        <div className="content">
          <div className="list">{list.map((a) => <button key={a.id} onClick={() => copy(a.id)}><span>{a.name}</span><span style={{ color: "var(--text-dim)" }}>{a.width}×{a.height}</span></button>)}</div>
          <label></label><label style={{ textAlign: "left" }}><input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} /> Scale to fit the target size</label>
        </div>
        <footer><button className="btn" onClick={() => useStore.setState({ modal: null })}>Cancel</button></footer>
      </div>
    </div>
  );
}

function ArtboardDialog() {
  const doc = useStore((s) => s.doc)!;
  const count = artboards(doc).length;
  const canAdopt = count === 0 && doc.layers.length > 0;
  const [name, setName] = useState(`Artboard ${count + 1}`);
  const [preset, setPreset] = useState(canAdopt ? -1 : 0);
  const [w, setW] = useState(canAdopt ? doc.width : AD_PRESETS[0].width);
  const [h, setH] = useState(canAdopt ? doc.height : AD_PRESETS[0].height);
  const [bg, setBg] = useState(doc.background && count === 0 ? doc.background : "#ffffff");
  const [adopt, setAdopt] = useState(canAdopt);
  const create = () => {
    const { ops, artboard } = addArtboardOps(doc, { name: name.trim() || undefined, width: clampDimension(w, 1080), height: clampDimension(h, 1080), background: bg, adoptExisting: canAdopt && adopt });
    useStore.getState().dispatch(ops, `New artboard ${artboard.name}`);
    useStore.getState().select([artboard.id]);
    useStore.setState({ modal: null });
    setTimeout(() => (window as unknown as { __fit?: () => void }).__fit?.(), 50);
  };
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal">
        <header>New artboard</header>
        <div className="content">
          <label>Name</label><input type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
          <label>Preset</label><select value={preset} onChange={(e) => { const i = Number(e.target.value); setPreset(i); if (i >= 0) { setW(AD_PRESETS[i].width); setH(AD_PRESETS[i].height); } }}>{[...new Set(AD_PRESETS.map((p) => p.group ?? "Other"))].map((g) => <optgroup key={g} label={g}>{AD_PRESETS.map((p, i) => (p.group ?? "Other") === g ? <option key={p.name} value={i}>{p.name} — {p.width}×{p.height}</option> : null)}</optgroup>)}<option value={-1}>Custom</option></select>
          <label>Width</label><input type="number" min={1} max={8192} value={w} onChange={(e) => { setW(Number(e.target.value)); setPreset(-1); }} />
          <label>Height</label><input type="number" min={1} max={8192} value={h} onChange={(e) => { setH(Number(e.target.value)); setPreset(-1); }} />
          <label>Background</label><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
          {canAdopt && <><label></label><label style={{ textAlign: "left" }}><input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} /> Move the existing layers into this artboard</label></>}
          <label></label><span style={{ color: "var(--text-dim)" }}>{count ? "Placed to the right of the existing artboards; the pasteboard grows to fit." : "The document becomes a pasteboard; export artboards individually from the File menu."}</span>
        </div>
        <footer><button className="btn" onClick={() => useStore.setState({ modal: null })}>Cancel</button><button className="btn primary" onClick={create}>Create</button></footer>
      </div>
    </div>
  );
}

function SizeDialog({ variant = false }: { variant?: boolean }) {
  const doc = useStore((s) => s.doc)!;
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [preset, setPreset] = useState(-1);
  const [name, setName] = useState(variant ? `${doc.name} variant` : doc.name);
  const [bg, setBg] = useState(doc.background ?? "#ffffff");
  const [transparent, setTransparent] = useState(doc.background === null);
  const [scaleContent, setScaleContent] = useState(true);
  const apply = async () => {
    const width = clampDimension(w, doc.width), height = clampDimension(h, doc.height);
    if (variant) {
      const r = await fetch(`/api/docs/${doc.id}/variant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ width, height, name: name.trim() || undefined, scaleContent }) });
      const d = await r.json();
      if (!r.ok) { useStore.getState().showToast(d.error ?? "Could not create variant"); return; }
      useStore.getState().connect(d.id);
      useStore.setState({ modal: null, zoom: 1, pan: { x: 0, y: 0 } });
      return;
    }
    const ops = (width !== doc.width || height !== doc.height) ? resizeLayoutOps(doc, width, height, { scaleContent }) : [];
    ops.unshift({ type: "doc.set", props: { name: name.trim() || doc.name, background: transparent ? null : bg } });
    useStore.getState().dispatch(ops, "Canvas size");
    useStore.setState({ modal: null });
  };
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal">
        <header>{variant ? "New size variant" : "Canvas"}</header>
        <div className="content">
          <label>Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          <label>Preset</label><select value={preset} onChange={(e) => { const i = Number(e.target.value); setPreset(i); if (i >= 0) { setW(AD_PRESETS[i].width); setH(AD_PRESETS[i].height); } }}><option value={-1}>Custom</option>{AD_PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name} — {p.width}×{p.height}</option>)}</select>
          <label>Width</label><input type="number" min={1} max={8192} value={w} onChange={(e) => { setW(Number(e.target.value)); setPreset(-1); }} />
          <label>Height</label><input type="number" min={1} max={8192} value={h} onChange={(e) => { setH(Number(e.target.value)); setPreset(-1); }} />
          <label></label><label style={{ textAlign: "left" }}><input type="checkbox" checked={scaleContent} onChange={(e) => setScaleContent(e.target.checked)} /> Scale layers to fit the new size</label>
          <label>Background</label><div style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="color" value={bg} disabled={transparent} onChange={(e) => setBg(e.target.value)} /><label style={{ textAlign: "left" }}><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent</label></div>
        </div>
        <footer><button className="btn" onClick={() => useStore.setState({ modal: null })}>Cancel</button><button className="btn primary" onClick={apply}>{variant ? "Create variant" : "Apply"}</button></footer>
      </div>
    </div>
  );
}
