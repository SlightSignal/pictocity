import { useEffect, useRef, useState } from "react";
import type { AdDocument, Layer, Op } from "@pictocity/core";
import { BLEND_MODES, findLayer, findParent, isGroup, walk, renderLayer, hasStyles, makeFill, makeAdjustment, makeGroup, isDescendant } from "@pictocity/core";
import { useStore, selectedLayers } from "../store";
import { browserEnv } from "../env";

const thumbCache = new Map<string, string>();

function useThumb(doc: AdDocument, layer: Layer): string | null {
  const key = `${layer.id}:${doc.rev}:${doc.width}x${doc.height}`;
  const [url, setUrl] = useState<string | null>(thumbCache.get(key) ?? null);
  useEffect(() => {
    if (thumbCache.has(key)) { setUrl(thumbCache.get(key)!); return; }
    const t = setTimeout(() => {
      try {
        const scale = 34 / Math.max(doc.width, doc.height);
        const c = renderLayer(doc, layer, browserEnv, scale) as unknown as HTMLCanvasElement;
        const u = c.toDataURL();
        if (thumbCache.size > 400) thumbCache.clear();
        thumbCache.set(key, u); setUrl(u);
      } catch { /* ignore */ }
    }, 120);
    return () => clearTimeout(t);
  }, [key, doc, layer]);
  return url;
}

const Eye = ({ on }: { on: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ opacity: on ? 1 : 0 }}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
const Lock = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;

type DropPos = { id: string; where: "top" | "bottom" | "into" } | null;

export function LayersPanel() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const presence = useStore((s) => s.presence);
  const editMask = useStore((s) => s.editMask);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropPos>(null);
  const [query, setQuery] = useState("");
  const lastClicked = useRef<string | null>(null);
  const dragId = useRef<string | null>(null);
  const sel = useStore(selectedLayers);
  const primary = sel[sel.length - 1];

  if (!doc) return <section className="panel grow layers"><header>Layers</header><div className="hint">Open a document to see its layers.</div></section>;

  const agentTouched = new Set(Object.entries(presence).filter(([a]) => a.startsWith("agent:")).flatMap(([, p]) => p.selection));
  const rows: { layer: Layer; depth: number; hidden: boolean }[] = [];
  const collect = (layers: Layer[], depth: number, hidden: boolean) => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      rows.push({ layer: l, depth, hidden });
      if (isGroup(l)) collect(l.children, depth + 1, hidden || !!collapsed[l.id]);
    }
  };
  collect(doc.layers, 0, false);

  const st = useStore.getState();
  const setProp = (id: string, props: Record<string, unknown>, label: string, mergeKey?: string) => st.setLayerProps(id, props, label, mergeKey);
  const onDrop = () => {
    const from = dragId.current, d = drop; dragId.current = null; setDrop(null);
    if (!from || !d || from === d.id) return;
    const target = findLayer(doc, d.id); if (!target) return;
    if (isDescendant(doc, from, d.id)) return;
    let parentId: string | null, index: number;
    if (d.where === "into" && isGroup(target)) { parentId = target.id; index = target.children.length; }
    else {
      const loc = findParent(doc, d.id)!;
      parentId = loc.parent?.id ?? null;
      const fromLoc = findParent(doc, from)!;
      // list is displayed top-to-bottom = highest index first
      index = d.where === "top" ? loc.index + 1 : loc.index;
      if ((fromLoc.parent?.id ?? null) === parentId && fromLoc.index < index) index -= 1;
    }
    st.dispatch([{ type: "layer.move", id: from, parentId, index }], "Reorder layers");
  };

  const addLayer = (layer: Layer, label: string) => {
    const loc = primary ? findParent(doc, primary.id) : undefined;
    const parentId = loc?.parent?.id ?? null, index = loc ? loc.index + 1 : doc.layers.length;
    st.dispatch([{ type: "layer.add", layer, parentId, index }], label); st.select([layer.id]);
  };

  return (
    <section className="panel grow layers">
      <header>Layers<span className="spacer" /><input className="search" type="text" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { setQuery(""); (e.target as HTMLInputElement).blur(); } if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></header>
      <div className="controls">
        <select value={primary?.blend ?? "normal"} disabled={!primary} onChange={(e) => sel.forEach((l) => setProp(l.id, { blend: e.target.value }, "Blend mode"))}>
          {BLEND_MODES.map((b) => <option key={b} value={b}>{b[0].toUpperCase() + b.slice(1).replace("-", " ")}</option>)}
        </select>
        <div className="opacity">Opacity <input type="number" min={0} max={100} value={primary ? Math.round(primary.opacity * 100) : 100} disabled={!primary}
          onChange={(e) => { const v = Math.min(100, Math.max(0, Number(e.target.value))) / 100; sel.forEach((l) => setProp(l.id, { opacity: v }, "Opacity", "opacity:" + l.id)); }} />%</div>
      </div>
      <div className="body" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        {rows.filter((r) => !r.hidden && (!query || r.layer.name.toLowerCase().includes(query.toLowerCase()) || r.layer.type.includes(query.toLowerCase()) || (r.layer.tags ?? []).some((t) => t.toLowerCase().includes(query.toLowerCase())))).map(({ layer: l, depth }) => (
          <LayerRow key={l.id} doc={doc} layer={l} depth={depth} selected={selection.includes(l.id)} primary={primary?.id === l.id} agent={agentTouched.has(l.id)}
            collapsed={!!collapsed[l.id]} renaming={renaming === l.id} drop={drop?.id === l.id ? drop.where : null}
            onToggleCollapse={() => setCollapsed({ ...collapsed, [l.id]: !collapsed[l.id] })}
            onSelect={(e) => {
              if (e.shiftKey && lastClicked.current && lastClicked.current !== l.id) {
                // Shift-click selects the range between the last clicked row and this one.
                const ids = rows.filter((r) => !r.hidden).map((r) => r.layer.id);
                const a = ids.indexOf(lastClicked.current), b = ids.indexOf(l.id);
                if (a >= 0 && b >= 0) { st.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
              }
              lastClicked.current = l.id;
              st.select([l.id], e.metaKey || e.ctrlKey ? { toggle: true } : undefined);
            }}
            onRename={(name) => { setRenaming(null); if (name && name !== l.name) setProp(l.id, { name }, "Rename layer"); }}
            onStartRename={() => setRenaming(l.id)}
            onDragStart={() => { dragId.current = l.id; }}
            onDragOver={(e) => { e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const y = (e.clientY - r.top) / r.height; setDrop({ id: l.id, where: isGroup(l) && y > 0.3 && y < 0.7 ? "into" : y < 0.5 ? "top" : "bottom" }); }}
            onToggleVisible={(alt) => (alt ? st.soloLayer(l.id) : setProp(l.id, { visible: !l.visible }, l.visible ? "Hide layer" : "Show layer"))}
            onToggleLock={() => setProp(l.id, { locked: !l.locked }, l.locked ? "Unlock layer" : "Lock layer")}
            maskEditing={editMask && selection.length === 1 && selection[0] === l.id}
            onToggleMask={() => { const on = !(editMask && selection[0] === l.id); st.select([l.id]); useStore.setState({ editMask: on }); if (on && st.tool !== "brush" && st.tool !== "eraser") st.setTool("brush"); }}
          />
        ))}
      </div>
      <div className="footer">
        <button title="New fill layer" onClick={() => addLayer(makeFill({ width: doc.width, height: doc.height, fill: { kind: "solid", color: st.fgColor } }), "New fill layer")}><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></svg></button>
        <button title="New adjustment layer" onClick={() => addLayer(makeAdjustment({ width: doc.width, height: doc.height, adjustment: { brightness: 1, contrast: 1, saturate: 1 } }), "New adjustment layer")}><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="#2b2b2b" /><circle cx="15" cy="12" r="2" fill="#2b2b2b" /><circle cx="7" cy="18" r="2" fill="#2b2b2b" /></svg></button>
        <button title="New group" onClick={() => (sel.length > 1 ? st.groupSelection() : addLayer(makeGroup({ name: "Group" }), "New group"))}><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></button>
        <button title="Duplicate layer" disabled={!sel.length} onClick={() => st.duplicateSelection()}><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M16 8V5a1.5 1.5 0 0 0-1.5-1.5h-9A1.5 1.5 0 0 0 4 5v9A1.5 1.5 0 0 0 5.5 16H8" /></svg></button>
        <button title="Delete layer" disabled={!sel.length} onClick={() => st.deleteSelection()}><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg></button>
      </div>
    </section>
  );
}

interface RowProps {
  doc: AdDocument; layer: Layer; depth: number; selected: boolean; primary: boolean; agent: boolean; collapsed: boolean; renaming: boolean; drop: "top" | "bottom" | "into" | null;
  onToggleCollapse(): void; onSelect(e: React.MouseEvent): void; onRename(name: string): void; onStartRename(): void;
  onDragStart(): void; onDragOver(e: React.DragEvent): void; onToggleVisible(alt: boolean): void; onToggleLock(): void;
  maskEditing: boolean; onToggleMask(): void;
}

function LayerRow(p: RowProps) {
  const { layer: l } = p;
  const thumb = useThumb(p.doc, l);
  const badges: string[] = [];
  if (l.type === "text") badges.push("T");
  if (l.mask) badges.push("mask");
  if (hasStyles(l.styles)) badges.push("fx");
  if (l.type === "adjustment") badges.push("adj");
  if (isGroup(l) && l.artboard) badges.unshift("artboard");
  if (l.linkId) badges.push("link");
  return (
    <div className={`layer${p.selected ? " selected" : ""}${p.primary ? " primary" : ""}${p.agent ? " agent" : ""}${p.drop === "into" ? " drop-into" : ""}`}
      draggable={!p.renaming} onDragStart={p.onDragStart} onDragOver={p.onDragOver} onClick={p.onSelect} onDoubleClick={p.onStartRename}>
      {p.drop === "top" && <div className="drop-line top" />}
      {p.drop === "bottom" && <div className="drop-line bottom" />}
      <div className={`eye${l.visible ? "" : " off"}`} title="Click to hide/show, Alt-click to solo" onClick={(e) => { e.stopPropagation(); p.onToggleVisible(e.altKey); }}><Eye on={l.visible} /></div>
      <div style={{ width: 8 + p.depth * 14 + (l.clipToBelow ? 12 : 0), flex: "none" }} />
      {l.clipToBelow && <div className="clip-arrow" title="Clipped to the layer below">↳</div>}
      {isGroup(l) ? <div className="caret" onClick={(e) => { e.stopPropagation(); p.onToggleCollapse(); }}>{p.collapsed ? "▸" : "▾"}</div> : <div className="caret" />}
      <div className={`thumb${isGroup(l) ? " group" : ""}`} title="Ctrl/⌘-click: select the layer's pixels" onClick={(e) => { if ((e.metaKey || e.ctrlKey) && !isGroup(l)) { e.stopPropagation(); useStore.getState().selectionFromLayer(l.id, (x) => (window as unknown as { __layerAlpha?: (id: string) => { canvas: HTMLCanvasElement; x: number; y: number; scale: number } | undefined }).__layerAlpha?.(x.id)); } }}>{isGroup(l) ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg> : thumb ? <img src={thumb} alt="" /> : null}</div>
      <div className="name">
        {p.renaming ? <input type="text" autoFocus defaultValue={l.name} onClick={(e) => e.stopPropagation()} onBlur={(e) => p.onRename(e.target.value.trim())} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") p.onRename(l.name); e.stopPropagation(); }} /> : l.name}
      </div>
      <div className="badges">{badges.map((b) => b === "mask" ? <span key={b} className={`mask${p.maskEditing ? " on" : ""}`} title="Click to paint the mask (brush reveals, eraser hides)" onClick={(e) => { e.stopPropagation(); p.onToggleMask(); }}>mask</span> : <span key={b} className={b === "link" ? "link" : ""} title={b === "link" ? "Linked: content stays in sync with its siblings" : ""}>{b}</span>)}</div>
      <div className="lock" onClick={(e) => { e.stopPropagation(); p.onToggleLock(); }} title={l.locked ? "Unlock" : "Lock"} style={{ opacity: l.locked ? 1 : 0.25 }}><Lock /></div>
    </div>
  );
}

export function opsToMoveSelectionTo(doc: AdDocument, ids: string[], parentId: string | null, index: number): Op[] {
  return ids.map((id, i) => ({ type: "layer.move" as const, id, parentId, index: index + i }));
}

export { walk };
