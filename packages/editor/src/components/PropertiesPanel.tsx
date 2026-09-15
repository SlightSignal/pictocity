import { useEffect, useState } from "react";
import type { Layer, LayerStyles, LayerFilters, TextLayer, ShapeLayer, FillLayer, ImageLayer, AdjustmentLayer, LayerMask } from "@pictocity/core";
import { BLEND_MODES, layerBounds, textPathPreset, GRADIENT_PRESETS } from "@pictocity/core";
import { useStore, selectedLayers } from "../store";
import { measureText, servedWeights } from "../env";

function Num({ label, value, onChange, step = 1, min, max, unit }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string }) {
  return (
    <label><span>{label}</span>
      <input type="number" value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0} step={step} min={min} max={max}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(min !== undefined ? Math.max(min, max !== undefined ? Math.min(max, v) : v) : v); }}
        onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); const d = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1) * step; onChange(value + d); } e.stopPropagation(); }} />
      {unit && <span style={{ minWidth: 0 }}>{unit}</span>}
    </label>
  );
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return (
    <label><span>{label}</span>
      <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} />
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
    </label>
  );
}

export function PropertiesPanel() {
  const sel = useStore(selectedLayers);
  const doc = useStore((s) => s.doc);
  const fonts = useStore((s) => s.fonts);
  const l = sel[sel.length - 1];
  const st = useStore.getState();
  if (!doc || !l) return <section className="panel fixed" style={{ maxHeight: "44%" }}><header>Properties</header><div className="hint">{doc ? `${doc.name} — ${doc.width} × ${doc.height} px. Select a layer to edit it.` : ""}</div></section>;

  const set = (props: Record<string, unknown>, label?: string, mergeKey?: string) => st.setLayerProps(l.id, props, label, mergeKey ?? `${l.id}:${Object.keys(props).join(",")}`);
  const setStyle = <K extends keyof LayerStyles>(k: K, v: Partial<NonNullable<LayerStyles[K]>>) => set({ styles: { ...(l.styles ?? {}), [k]: { ...defaultStyle(k), ...(l.styles?.[k] ?? {}), ...v } } }, "Layer effects");
  const setFilter = (k: keyof LayerFilters, v: number | undefined) => {
    if (l.type === "adjustment") set({ adjustment: { ...(l as AdjustmentLayer).adjustment, [k]: v } }, "Adjustment");
    else set({ filters: { ...(l.filters ?? {}), [k]: v } }, "Filters");
  };
  const filters: LayerFilters = l.type === "adjustment" ? (l as AdjustmentLayer).adjustment : (l.filters ?? {});
  const setLut = (k: keyof LayerFilters, v: unknown) => {
    const next = { ...filters, [k]: v };
    if (v === undefined) delete (next as Record<string, unknown>)[k];
    if (l.type === "adjustment") set({ adjustment: next }, "Adjustment"); else set({ filters: next }, "Filters");
  };
  const b = layerBounds(l);

  return (
    <section className="panel fixed" style={{ maxHeight: "44%" }}>
      <header>Properties <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>{l.type}</span><span className="spacer" />{sel.length > 1 && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>{sel.length} selected</span>}</header>
      <div className="body">
        <div className="grid2">
          <Num label="X" value={l.x} onChange={(v) => set({ x: v }, "Move")} />
          <Num label="Y" value={l.y} onChange={(v) => set({ y: v }, "Move")} />
          <Num label="W" value={l.width} min={1} onChange={(v) => set({ width: v }, "Resize")} />
          <Num label="H" value={l.height} min={1} onChange={(v) => set({ height: v }, "Resize")} />
          <Num label="⟳" value={l.rotation} step={1} onChange={(v) => set({ rotation: v }, "Rotate")} unit="°" />
          <label><span></span><span style={{ color: "var(--text-faint)" }}>bounds {Math.round(b.width)}×{Math.round(b.height)}</span></label>
        </div>
        <div className="row">
          <button className="btn" onClick={() => set({ x: Math.round((doc.width - b.width) / 2 + (l.x - b.x)) }, "Align")}>Center H</button>
          <button className="btn" onClick={() => set({ y: Math.round((doc.height - b.height) / 2 + (l.y - b.y)) }, "Align")}>Center V</button>
          <button className="btn" onClick={() => set({ x: 0, y: 0, width: doc.width, height: doc.height, rotation: 0 }, "Fit to canvas")}>Fill canvas</button>
        </div>

        {l.type === "text" && <TextProps l={l as TextLayer} fonts={fonts} set={set} />}
        {l.type === "shape" && <ShapeProps l={l as ShapeLayer} set={set} />}
        {l.type === "image" && <ImageProps l={l as ImageLayer} set={set} />}
        {l.type === "fill" && <FillProps l={l as FillLayer} set={set} />}
        {l.type === "brush" && <div className="section"><h4>Paint</h4><div className="row"><span style={{ color: "var(--text-dim)" }}>{(l as { strokes: unknown[] }).strokes.length} strokes</span><span style={{ flex: 1 }} /><button className="btn" disabled={!(l as { strokes: unknown[] }).strokes.length} onClick={() => set({ strokes: [] }, "Clear paint")}>Clear</button></div></div>}

        {l.type !== "group" && (
          <div className="section">
            <h4>{l.type === "adjustment" ? "Adjustment (applies to everything below)" : "Filters"}</h4>
            <div className="grid2">
              <Num label="Blur" value={filters.blur ?? 0} min={0} onChange={(v) => setFilter("blur", v || undefined)} />
              <Num label="Bright" value={filters.brightness ?? 1} step={0.05} min={0} onChange={(v) => setFilter("brightness", v)} />
              <Num label="Contr" value={filters.contrast ?? 1} step={0.05} min={0} onChange={(v) => setFilter("contrast", v)} />
              <Num label="Satur" value={filters.saturate ?? 1} step={0.05} min={0} onChange={(v) => setFilter("saturate", v)} />
              <Num label="Hue" value={filters.hueRotate ?? 0} onChange={(v) => setFilter("hueRotate", v || undefined)} unit="°" />
              <Num label="Gray" value={filters.grayscale ?? 0} step={0.1} min={0} max={1} onChange={(v) => setFilter("grayscale", v || undefined)} />
              <Num label="Grain" value={filters.noise ?? 0} step={0.05} min={0} max={1} onChange={(v) => setFilter("noise", v || undefined)} />
            </div>
            <div className="row">
              <span style={{ color: "var(--text-dim)" }}>Add</span>
              <select value="" onChange={(e) => { const k = e.target.value as keyof typeof ADJ_DEFS; if (k) setLut(k as never, ADJ_DEFS[k].init); }}>
                <option value="">adjustment or filter…</option>
                {(Object.keys(ADJ_DEFS) as (keyof typeof ADJ_DEFS)[]).filter((k) => (filters as Record<string, unknown>)[k] === undefined).map((k) => <option key={k} value={k}>{ADJ_DEFS[k].label}</option>)}
              </select>
            </div>
            {(Object.keys(ADJ_DEFS) as (keyof typeof ADJ_DEFS)[]).filter((k) => (filters as Record<string, unknown>)[k] !== undefined).map((k) => {
              const def = ADJ_DEFS[k]; const val = (filters as Record<string, any>)[k];
              const upd = (patch: Record<string, unknown>) => setLut(k as never, typeof val === "object" && val !== null ? { ...val, ...patch } : (patch.value as never));
              return (
                <div key={k}>
                  <h4>{def.label}<span className="spacer" /><button className="btn" onClick={() => setLut(k as never, undefined)}>×</button></h4>
                  <div className="grid2">
                    {def.fields.map((fd) => fd.kind === "color"
                      ? <Color key={fd.key} label={fd.label} value={fd.key === "value" ? val : (val as Record<string, string>)[fd.key]} onChange={(v) => upd({ [fd.key]: v })} />
                      : fd.kind === "bool"
                        ? <label key={fd.key}><span></span><input type="checkbox" checked={!!(val as Record<string, boolean>)[fd.key]} onChange={(e) => upd({ [fd.key]: e.target.checked })} /> {fd.label}</label>
                        : fd.kind === "tuple"
                          ? <label key={fd.key} style={{ gridColumn: "1 / -1" }}><span>{fd.label}</span>{[0, 1, 2].map((ti) => <input key={ti} type="number" style={{ width: 52 }} min={fd.min} max={fd.max} step={fd.step} value={(val as Record<string, number[]>)[fd.key][ti]} onChange={(e) => { const t = [...(val as Record<string, number[]>)[fd.key]]; t[ti] = Number(e.target.value); upd({ [fd.key]: t }); }} onKeyDown={(e) => e.stopPropagation()} />)}</label>
                          : <Num key={fd.key} label={fd.label} value={fd.key === "value" ? Number(val) : Number((val as Record<string, number>)[fd.key])} min={fd.min} max={fd.max} step={fd.step} onChange={(v) => upd({ [fd.key]: v })} />)}
                    {k === "gradientMap" && <label style={{ gridColumn: "1 / -1" }}><span>Stops</span>{(val as { stops: { pos: number; color: string }[] }).stops.map((st, si) => <span key={si} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><input type="color" value={st.color} onChange={(e) => { const stops = [...(val as { stops: { pos: number; color: string }[] }).stops]; stops[si] = { ...st, color: e.target.value }; upd({ stops }); }} /><input type="number" style={{ width: 44 }} min={0} max={1} step={0.05} value={st.pos} onChange={(e) => { const stops = [...(val as { stops: { pos: number; color: string }[] }).stops]; stops[si] = { ...st, pos: Number(e.target.value) }; upd({ stops }); }} onKeyDown={(e) => e.stopPropagation()} /></span>)}<button className="btn" onClick={() => upd({ stops: [...(val as { stops: { pos: number; color: string }[] }).stops, { pos: 0.5, color: "#888888" }] })}>+</button></label>}
                  </div>
                </div>
              );
            })}
            <h4><input type="checkbox" checked={!!filters.levels} onChange={(e) => setLut("levels", e.target.checked ? { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 } : undefined)} />Levels</h4>
            {filters.levels && <div className="grid2">
              <Num label="In ●" value={filters.levels.inBlack} min={0} max={254} onChange={(v) => setLut("levels", { ...filters.levels!, inBlack: v })} />
              <Num label="In ○" value={filters.levels.inWhite} min={1} max={255} onChange={(v) => setLut("levels", { ...filters.levels!, inWhite: v })} />
              <Num label="Gamma" value={filters.levels.gamma} step={0.05} min={0.1} max={10} onChange={(v) => setLut("levels", { ...filters.levels!, gamma: v })} />
              <label><span></span></label>
              <Num label="Out ●" value={filters.levels.outBlack} min={0} max={255} onChange={(v) => setLut("levels", { ...filters.levels!, outBlack: v })} />
              <Num label="Out ○" value={filters.levels.outWhite} min={0} max={255} onChange={(v) => setLut("levels", { ...filters.levels!, outWhite: v })} />
            </div>}
            <h4><input type="checkbox" checked={!!filters.curves} onChange={(e) => setLut("curves", e.target.checked ? { rgb: [[0, 0], [255, 255]] } : undefined)} />Curves</h4>
            {filters.curves && <CurvesEditor value={filters.curves} onChange={(c) => setLut("curves", c)} />}
          </div>
        )}

        {l.type === "adjustment" && (
          <div className="section">
            <h4><input type="checkbox" checked={!!l.mask} onChange={(e) => set({ mask: e.target.checked ? ({ kind: "paint", base: "show", strokes: [] } as LayerMask) : null }, "Layer mask")} />Adjustment mask</h4>
            {l.mask && <div className="hint">Paint the mask (\ or the mask badge): brush reveals the adjustment, eraser hides it. Selections: Layer › Mask: reveal / hide selection.</div>}
          </div>
        )}
        {l.type !== "adjustment" && (
          <>
            <StylePresets layer={l} set={set} />
            <div className="section">
              <h4><input type="checkbox" checked={!!l.styles?.dropShadow?.enabled} onChange={(e) => setStyle("dropShadow", { enabled: e.target.checked })} />Drop shadow</h4>
              {l.styles?.dropShadow?.enabled && <div className="grid2">
                <Color label="Color" value={l.styles.dropShadow.color} onChange={(v) => setStyle("dropShadow", { color: v })} />
                <Num label="Opacity" value={l.styles.dropShadow.opacity} step={0.05} min={0} max={1} onChange={(v) => setStyle("dropShadow", { opacity: v })} />
                <Num label="Blur" value={l.styles.dropShadow.blur} min={0} onChange={(v) => setStyle("dropShadow", { blur: v })} />
                <Num label="X" value={l.styles.dropShadow.x} onChange={(v) => setStyle("dropShadow", { x: v })} />
                <Num label="Y" value={l.styles.dropShadow.y} onChange={(v) => setStyle("dropShadow", { y: v })} />
              </div>}
            </div>
            <div className="section">
              <h4><input type="checkbox" checked={!!l.styles?.innerShadow?.enabled} onChange={(e) => setStyle("innerShadow", { enabled: e.target.checked })} />Inner shadow</h4>
              {l.styles?.innerShadow?.enabled && <div className="grid2">
                <Color label="Color" value={l.styles.innerShadow.color} onChange={(v) => setStyle("innerShadow", { color: v })} />
                <Num label="Opacity" value={l.styles.innerShadow.opacity} step={0.05} min={0} max={1} onChange={(v) => setStyle("innerShadow", { opacity: v })} />
                <Num label="Blur" value={l.styles.innerShadow.blur} min={0} onChange={(v) => setStyle("innerShadow", { blur: v })} />
                <Num label="X" value={l.styles.innerShadow.x} onChange={(v) => setStyle("innerShadow", { x: v })} />
                <Num label="Y" value={l.styles.innerShadow.y} onChange={(v) => setStyle("innerShadow", { y: v })} />
              </div>}
            </div>
            <div className="section">
              <h4><input type="checkbox" checked={!!l.styles?.stroke?.enabled} onChange={(e) => setStyle("stroke", { enabled: e.target.checked })} />Stroke</h4>
              {l.styles?.stroke?.enabled && <div className="grid2">
                <Color label="Color" value={l.styles.stroke.color} onChange={(v) => setStyle("stroke", { color: v })} />
                <Num label="Size" value={l.styles.stroke.size} min={0} onChange={(v) => setStyle("stroke", { size: v })} />
                <label><span>Pos</span><select value={l.styles.stroke.position} onChange={(e) => setStyle("stroke", { position: e.target.value as "outside" | "inside" | "center" })}><option value="outside">Outside</option><option value="inside">Inside</option><option value="center">Center</option></select></label>
              </div>}
            </div>
            <div className="section">
              <h4><input type="checkbox" checked={!!l.styles?.outerGlow?.enabled} onChange={(e) => setStyle("outerGlow", { enabled: e.target.checked })} />Outer glow</h4>
              {l.styles?.outerGlow?.enabled && <div className="grid2">
                <Color label="Color" value={l.styles.outerGlow.color} onChange={(v) => setStyle("outerGlow", { color: v })} />
                <Num label="Size" value={l.styles.outerGlow.size} min={0} onChange={(v) => setStyle("outerGlow", { size: v })} />
                <Num label="Opacity" value={l.styles.outerGlow.opacity} step={0.05} min={0} max={1} onChange={(v) => setStyle("outerGlow", { opacity: v })} />
              </div>}
            </div>
            <div className="section">
              <h4><input type="checkbox" checked={!!l.styles?.innerGlow?.enabled} onChange={(e) => setStyle("innerGlow", { enabled: e.target.checked })} />Inner glow</h4>
              {l.styles?.innerGlow?.enabled && <div className="grid2">
                <Color label="Color" value={l.styles.innerGlow.color} onChange={(v) => setStyle("innerGlow", { color: v })} />
                <Num label="Size" value={l.styles.innerGlow.size} min={0} onChange={(v) => setStyle("innerGlow", { size: v })} />
                <Num label="Opacity" value={l.styles.innerGlow.opacity} step={0.05} min={0} max={1} onChange={(v) => setStyle("innerGlow", { opacity: v })} />
              </div>}
            </div>
            <div className="section">
              <h4><input type="checkbox" checked={!!l.styles?.bevel?.enabled} onChange={(e) => setStyle("bevel", { enabled: e.target.checked })} />Bevel & emboss</h4>
              {l.styles?.bevel?.enabled && <div className="grid2">
                <Num label="Size" value={l.styles.bevel.size} min={0} onChange={(v) => setStyle("bevel", { size: v })} />
                <Num label="Depth" value={l.styles.bevel.depth} step={0.1} min={0} max={3} onChange={(v) => setStyle("bevel", { depth: v })} />
                <Num label="Angle" value={l.styles.bevel.angle} onChange={(v) => setStyle("bevel", { angle: v })} unit="°" />
                <Num label="Opacity" value={l.styles.bevel.opacity} step={0.05} min={0} max={1} onChange={(v) => setStyle("bevel", { opacity: v })} />
                <Color label="Light" value={l.styles.bevel.highlight} onChange={(v) => setStyle("bevel", { highlight: v })} />
                <Color label="Shade" value={l.styles.bevel.shadow} onChange={(v) => setStyle("bevel", { shadow: v })} />
              </div>}
            </div>
            <div className="section">
              <h4><input type="checkbox" checked={!!l.styles?.patternOverlay?.enabled} onChange={(e) => setStyle("patternOverlay", { enabled: e.target.checked, assetId: l.styles?.patternOverlay?.assetId ?? Object.keys(doc.assets)[0] ?? "" })} />Pattern overlay</h4>
              {l.styles?.patternOverlay?.enabled && <div className="grid2">
                <label style={{ gridColumn: "1 / -1" }}><span>Image</span><select value={l.styles.patternOverlay.assetId} onChange={(e) => setStyle("patternOverlay", { assetId: e.target.value })}>{Object.values(doc.assets).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                <Num label="Scale" value={l.styles.patternOverlay.scale} step={0.05} min={0.01} onChange={(v) => setStyle("patternOverlay", { scale: v })} />
                <Num label="Opacity" value={l.styles.patternOverlay.opacity} step={0.05} min={0} max={1} onChange={(v) => setStyle("patternOverlay", { opacity: v })} />
              </div>}
            </div>
            <div className="section">
              <h4><input type="checkbox" checked={!!l.styles?.colorOverlay?.enabled} onChange={(e) => setStyle("colorOverlay", { enabled: e.target.checked })} />Color overlay</h4>
              {l.styles?.colorOverlay?.enabled && <div className="grid2">
                <Color label="Color" value={l.styles.colorOverlay.color} onChange={(v) => setStyle("colorOverlay", { color: v })} />
                <Num label="Opacity" value={l.styles.colorOverlay.opacity} step={0.05} min={0} max={1} onChange={(v) => setStyle("colorOverlay", { opacity: v })} />
              </div>}
            </div>
            <div className="section">
              <h4><input type="checkbox" checked={!!l.styles?.gradientOverlay?.enabled} onChange={(e) => setStyle("gradientOverlay", { enabled: e.target.checked })} />Gradient overlay</h4>
              {l.styles?.gradientOverlay?.enabled && <div className="grid2">
                <Color label="From" value={l.styles.gradientOverlay.from} onChange={(v) => setStyle("gradientOverlay", { from: v })} />
                <Color label="To" value={l.styles.gradientOverlay.to} onChange={(v) => setStyle("gradientOverlay", { to: v })} />
                <Num label="Angle" value={l.styles.gradientOverlay.angle} onChange={(v) => setStyle("gradientOverlay", { angle: v })} unit="°" />
                <Num label="Opacity" value={l.styles.gradientOverlay.opacity} step={0.05} min={0} max={1} onChange={(v) => setStyle("gradientOverlay", { opacity: v })} />
              </div>}
            </div>
            <div className="section">
              <h4><input type="checkbox" checked={!!l.mask} onChange={(e) => set({ mask: e.target.checked ? ({ kind: "shape", shape: "rect", x: 0, y: 0, width: l.width, height: l.height, radius: 0, feather: 0 } as LayerMask) : null }, "Layer mask")} />Layer mask</h4>
              {l.mask?.kind === "shape" && <div className="grid2">
                <label><span>Shape</span><select value={l.mask.shape} onChange={(e) => set({ mask: { ...l.mask, shape: e.target.value } }, "Layer mask")}><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option></select></label>
                <Num label="Feather" value={l.mask.feather ?? 0} min={0} onChange={(v) => set({ mask: { ...l.mask, feather: v } }, "Layer mask")} />
                <Num label="X" value={l.mask.x} onChange={(v) => set({ mask: { ...l.mask, x: v } }, "Layer mask")} />
                <Num label="Y" value={l.mask.y} onChange={(v) => set({ mask: { ...l.mask, y: v } }, "Layer mask")} />
                <Num label="W" value={l.mask.width} min={1} onChange={(v) => set({ mask: { ...l.mask, width: v } }, "Layer mask")} />
                <Num label="H" value={l.mask.height} min={1} onChange={(v) => set({ mask: { ...l.mask, height: v } }, "Layer mask")} />
                <Num label="Radius" value={l.mask.radius ?? 0} min={0} onChange={(v) => set({ mask: { ...l.mask, radius: v } }, "Layer mask")} />
                <label><span></span><input type="checkbox" checked={!!l.mask.inverted} onChange={(e) => set({ mask: { ...l.mask, inverted: e.target.checked } }, "Layer mask")} /> Invert</label>
              </div>}
              {l.mask && <div className="row"><label>Kind</label><select value={l.mask.kind} onChange={(e) => { const k = e.target.value; if (k === l.mask!.kind) return; set({ mask: k === "shape" ? { kind: "shape", shape: "rect", x: 0, y: 0, width: l.width, height: l.height, radius: 0, feather: 0 } : k === "paint" ? { kind: "paint", base: "show", strokes: [] } : l.mask }, "Layer mask"); }}><option value="shape">Shape</option><option value="paint">Painted</option>{l.mask.kind === "raster" && <option value="raster">Raster</option>}</select></div>}
              {l.mask?.kind === "paint" && <div className="grid2">
                <label><span>Start</span><select value={l.mask.base} onChange={(e) => set({ mask: { ...l.mask, base: e.target.value } }, "Layer mask")}><option value="show">Visible (hide with eraser)</option><option value="hide">Hidden (reveal with brush)</option></select></label>
                <label><span></span><input type="checkbox" checked={!!l.mask.inverted} onChange={(e) => set({ mask: { ...l.mask, inverted: e.target.checked } }, "Layer mask")} /> Invert</label>
                <label><span></span><button className={`btn${useStore.getState().editMask ? " primary" : ""}`} onClick={() => { const on = !useStore.getState().editMask; useStore.setState({ editMask: on }); if (on) useStore.getState().setTool("brush"); }}>{useStore.getState().editMask ? "Painting mask" : "Paint mask"}</button></label>
                <label><span></span><span style={{ color: "var(--text-faint)" }}>{l.mask.strokes.length} strokes</span><button className="btn" disabled={!l.mask.strokes.length} onClick={() => set({ mask: { ...l.mask, strokes: [] } }, "Clear mask")}>Clear</button></label>
              </div>}
              {l.mask?.kind === "raster" && <div className="hint">Raster mask from asset {l.mask.assetId}. <label><input type="checkbox" checked={!!l.mask.inverted} onChange={(e) => set({ mask: { ...l.mask, inverted: e.target.checked } }, "Layer mask")} /> Invert</label></div>}
            </div>
          </>
        )}
        <div className="section"><div className="grid2">
          <label><span>Blend</span><select value={l.blend} onChange={(e) => set({ blend: e.target.value }, "Blend mode")}>{BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <Num label="Opac" value={l.opacity * 100} min={0} max={100} onChange={(v) => set({ opacity: v / 100 }, "Opacity")} unit="%" />
          <Num label="Fill" value={(l.fillOpacity ?? 1) * 100} min={0} max={100} onChange={(v) => set({ fillOpacity: v / 100 }, "Fill opacity")} unit="%" />
          <label><span>Tags</span><input type="text" value={(l.tags ?? []).join(", ")} placeholder="headline, cta…" onChange={(e) => set({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }, "Tags")} onKeyDown={(e) => e.stopPropagation()} /></label>
        </div></div>
      </div>
    </section>
  );
}

function defaultStyle(k: keyof LayerStyles) {
  switch (k) {
    case "dropShadow": return { enabled: true, color: "#000000", blur: 20, x: 0, y: 10, opacity: 0.5 };
    case "innerShadow": return { enabled: true, color: "#000000", blur: 16, x: 0, y: 8, opacity: 0.5 };
    case "innerGlow": return { enabled: true, color: "#ffffff", size: 24, opacity: 0.6 };
    case "bevel": return { enabled: true, size: 12, depth: 1, angle: 120, highlight: "#ffffff", shadow: "#000000", opacity: 0.6 };
    case "patternOverlay": return { enabled: true, assetId: "", scale: 0.25, opacity: 0.5, blend: "normal" };
    case "stroke": return { enabled: true, color: "#ffffff", size: 4, position: "outside" };
    case "outerGlow": return { enabled: true, color: "#ffd166", size: 30, opacity: 0.7 };
    case "colorOverlay": return { enabled: true, color: "#ff5c5c", opacity: 1, blend: "normal" };
    case "gradientOverlay": return { enabled: true, from: "#ff8a00", to: "#e52e71", angle: 90, opacity: 1, blend: "normal" };
  }
}

type Setter = (props: Record<string, unknown>, label?: string, mergeKey?: string) => void;

function TextProps({ l, fonts, set }: { l: TextLayer; fonts: string[]; set: Setter }) {
  const textSel = useStore((s) => s.textSelection);
  const editingId = useStore((s) => s.editingTextId);
  const range = editingId === l.id && textSel && textSel.id === l.id && textSel.end > textSel.start ? textSel : null;
  /** While characters are selected in the inline editor, colour/weight/style/underline apply to that range. */
  const styleOrSet = (runProps: Partial<Omit<import("@pictocity/core").TextRun, "start" | "end">>, layerProps: Record<string, unknown>, label: string) => { if (range && useStore.getState().styleTextRange(runProps)) return; set(layerProps, label); };
  const setAndFit = (props: Partial<TextLayer>) => {
    if (!l.wrap) { const m = measureText({ ...l, ...props }); props.width = Math.ceil(m.width) + 2; props.height = Math.ceil(m.height); }
    set(props as Record<string, unknown>, "Character");
  };
  const list = fonts.includes(l.fontFamily) ? fonts : [l.fontFamily, ...fonts];
  const served = useStore((s) => s.servedFonts);
  return (
    <div className="section">
      <h4>Character</h4>
      <div className="row"><textarea className="field" rows={3} value={l.text} onChange={(e) => setAndFit({ text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} /></div>
      <div className="grid2">
        <label style={{ gridColumn: "1 / -1" }}><span>Font</span><select value={l.fontFamily} onChange={(e) => setAndFit({ fontFamily: e.target.value })}>{list.map((f) => <option key={f} value={f}>{f}{served.length && !served.includes(f) ? " (server only)" : ""}</option>)}</select></label>
        {served.length > 0 && !served.includes(l.fontFamily) && <label style={{ gridColumn: "1 / -1", color: "#f0a534" }}><span>⚠</span>Not in fonts/ — the browser may substitute it; exports use the server's copy. Drop the .ttf into fonts/ for a matching preview.</label>}
        <Num label="Size" value={l.fontSize} min={1} onChange={(v) => setAndFit({ fontSize: v })} />
        <label><span>Weight</span><select value={String(l.fontWeight)} onChange={(e) => setAndFit({ fontWeight: Number(e.target.value) })}>{(servedWeights[l.fontFamily]?.length ? [...new Set([...servedWeights[l.fontFamily], Number(l.fontWeight) || 400])].sort((a, b) => a - b) : [100, 200, 300, 400, 500, 600, 700, 800, 900]).map((w) => <option key={w} value={w}>{w}{servedWeights[l.fontFamily]?.length && !servedWeights[l.fontFamily].includes(w) ? " (synthetic)" : ""}</option>)}</select></label>
        <Num label="Lead" value={l.lineHeight} step={0.05} min={0.5} onChange={(v) => setAndFit({ lineHeight: v })} />
        <Num label="Track" value={l.letterSpacing} step={0.5} onChange={(v) => setAndFit({ letterSpacing: v })} />
        {range && <label style={{ gridColumn: "1 / -1", color: "#7fd0ff" }}><span>✎</span>Styling characters {range.start}–{range.end}: colour, weight, style and underline apply to the selection</label>}
        <Color label="Color" value={l.color} onChange={(v) => styleOrSet({ color: v }, { color: v }, "Text color")} />
        <label><span>Style</span><div className="seg"><button className={l.fontStyle === "normal" ? "on" : ""} onClick={() => styleOrSet({ fontStyle: "normal" }, { fontStyle: "normal" }, "Style")}>A</button><button className={l.fontStyle === "italic" ? "on" : ""} style={{ fontStyle: "italic" }} onClick={() => styleOrSet({ fontStyle: "italic" }, { fontStyle: "italic" }, "Style")}>A</button><button className={l.underline ? "on" : ""} style={{ textDecoration: "underline" }} onClick={() => styleOrSet({ underline: true }, { underline: !l.underline }, "Underline")}>U</button><button className={l.strikethrough ? "on" : ""} style={{ textDecoration: "line-through" }} onClick={() => set({ strikethrough: !l.strikethrough }, "Strikethrough")}>S</button><button title="Bold the selected characters" onClick={() => styleOrSet({ fontWeight: 700 }, { fontWeight: 700 }, "Bold")} style={{ fontWeight: 700 }}>B</button></div></label>
        {!!l.runs?.length && <label><span></span><button className="btn" onClick={() => set({ runs: null }, "Clear character styles")}>Clear character styles ({l.runs.length})</button></label>}
        <label><span>Align</span><div className="seg">{(["left", "center", "right", "justify"] as const).map((a) => <button key={a} className={l.align === a ? "on" : ""} title={a} onClick={() => set({ align: a }, "Paragraph")}>{a === "left" ? "≡" : a === "center" ? "☰" : a === "right" ? "≣" : "▤"}</button>)}</div></label>
        <label><span>Vert</span><div className="seg">{(["top", "middle", "bottom"] as const).map((a) => <button key={a} className={l.verticalAlign === a ? "on" : ""} onClick={() => set({ verticalAlign: a }, "Paragraph")}>{a[0].toUpperCase()}</button>)}</div></label>
        <label><span>Case</span><select value={l.textTransform ?? "none"} onChange={(e) => setAndFit({ textTransform: e.target.value as TextLayer["textTransform"] })}><option value="none">As typed</option><option value="uppercase">UPPER</option><option value="lowercase">lower</option></select></label>
        <label><span></span><input type="checkbox" checked={l.wrap} onChange={(e) => (e.target.checked ? set({ wrap: true }, "Paragraph text") : setAndFit({ wrap: false }))} /> Paragraph (wrap in box)</label>
        <label><span></span><input type="checkbox" checked={!!l.vertical} onChange={(e) => set({ vertical: e.target.checked || null }, "Vertical type")} /> Vertical type</label>
        <Num label="Base" value={l.baselineShift ?? 0} onChange={(v) => set({ baselineShift: v || null }, "Baseline shift")} unit="px" />
        <label><span></span><input type="checkbox" checked={l.kerning !== false} onChange={(e) => set({ kerning: e.target.checked ? null : false }, "Kerning")} /> Kerning</label>
        <Num label="H scale" value={(l.textScaleX ?? 1) * 100} step={5} min={10} max={500} onChange={(v) => set({ textScaleX: v === 100 ? null : v / 100 }, "Horizontal scale")} unit="%" />
        <Num label="V scale" value={(l.textScaleY ?? 1) * 100} step={5} min={10} max={500} onChange={(v) => set({ textScaleY: v === 100 ? null : v / 100 }, "Vertical scale")} unit="%" />
        <label style={{ gridColumn: "1 / -1" }}><span>Path</span><select value={l.onPath ? (l.onPath.path === textPathPreset("arc-up") ? "arc-up" : l.onPath.path === textPathPreset("arc-down") ? "arc-down" : l.onPath.path === textPathPreset("circle") ? "circle" : "custom") : "none"} onChange={(e) => { const v = e.target.value; if (v === "none") set({ onPath: null }, "Text on path"); else if (v !== "custom") set({ onPath: { ...(l.onPath ?? { align: "center", offset: 0 }), path: textPathPreset(v as "arc-up" | "arc-down" | "circle") } }, "Text on path"); }}><option value="none">Straight</option><option value="arc-up">Arc over the top</option><option value="arc-down">Arc along the bottom</option><option value="circle">Full circle</option>{l.onPath && <option value="custom">Custom path</option>}</select></label>
        {l.onPath && <>
          <label><span>Along</span><select value={l.onPath.align ?? "center"} onChange={(e) => set({ onPath: { ...l.onPath, align: e.target.value } }, "Text on path")}><option value="start">Start</option><option value="center">Centre</option><option value="end">End</option></select></label>
          <Num label="Offset" value={(l.onPath.offset ?? 0) * 100} step={1} min={-100} max={100} onChange={(v) => set({ onPath: { ...l.onPath, offset: v / 100 } }, "Text on path")} unit="%" />
          <label><span></span><input type="checkbox" checked={!!l.onPath.flip} onChange={(e) => set({ onPath: { ...l.onPath, flip: e.target.checked } }, "Text on path")} /> Flip to the other side</label>
        </>}
      </div>
    </div>
  );
}

function ShapeProps({ l, set }: { l: ShapeLayer; set: Setter }) {
  return (
    <div className="section">
      <h4>Shape</h4>
      <div className="grid2">
        <label><span>Kind</span><select value={l.shape} onChange={(e) => set({ shape: e.target.value }, "Shape")}>{["rect", "ellipse", "line", "polygon", "star"].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        {l.shape === "rect" && <Num label="Radius" value={l.radius ?? 0} min={0} onChange={(v) => set({ radius: v, radii: null }, "Shape")} />}
        {l.shape === "rect" && <label><span></span><input type="checkbox" checked={!!l.radii} onChange={(e) => set({ radii: e.target.checked ? [l.radius ?? 0, l.radius ?? 0, l.radius ?? 0, l.radius ?? 0] : null }, "Shape")} /> Per corner</label>}
        {l.shape === "rect" && l.radii && (["TL", "TR", "BR", "BL"] as const).map((k, i) => <Num key={k} label={k} value={l.radii![i]} min={0} onChange={(v) => { const r = [...l.radii!] as [number, number, number, number]; r[i] = v; set({ radii: r }, "Shape"); }} />)}
        {(l.shape === "polygon" || l.shape === "star") && <Num label="Sides" value={l.sides ?? 5} min={3} onChange={(v) => set({ sides: Math.round(v) }, "Shape")} />}
        {l.shape === "star" && <Num label="Inner" value={l.innerRadius ?? 0.5} step={0.05} min={0.05} max={1} onChange={(v) => set({ innerRadius: v }, "Shape")} />}
        <label><span>Fill</span><input type="checkbox" checked={l.fill !== null} onChange={(e) => set({ fill: e.target.checked ? "#4f6df5" : null }, "Shape")} /><input type="color" value={l.fill ?? "#000000"} disabled={l.fill === null} onChange={(e) => set({ fill: e.target.value }, "Shape fill")} /><input type="text" value={l.fill ?? ""} disabled={l.fill === null} onChange={(e) => set({ fill: e.target.value }, "Shape fill")} onKeyDown={(e) => e.stopPropagation()} /></label>
        <label><span>Stroke</span><input type="checkbox" checked={l.strokeColor !== null} onChange={(e) => set({ strokeColor: e.target.checked ? "#ffffff" : null, strokeWidth: l.strokeWidth || 4 }, "Shape")} /><input type="color" value={l.strokeColor ?? "#000000"} disabled={l.strokeColor === null} onChange={(e) => set({ strokeColor: e.target.value }, "Shape stroke")} /><input type="text" value={l.strokeColor ?? ""} disabled={l.strokeColor === null} onChange={(e) => set({ strokeColor: e.target.value }, "Shape stroke")} onKeyDown={(e) => e.stopPropagation()} /></label>
        <Num label="Width" value={l.strokeWidth} min={0} onChange={(v) => set({ strokeWidth: v }, "Shape stroke")} />
        <label><span>Dash</span><input type="text" placeholder="e.g. 8 4" value={(l.dash ?? []).join(" ")} onChange={(e) => { const d = e.target.value.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0); set({ dash: d.length ? d : null }, "Dash"); }} onKeyDown={(e) => e.stopPropagation()} /></label>
        {l.shape === "line" && <label><span>Arrows</span><select value={l.arrows ?? "none"} onChange={(e) => set({ arrows: e.target.value }, "Arrowheads")}><option value="none">None</option><option value="start">Start</option><option value="end">End</option><option value="both">Both</option></select></label>}
      </div>
    </div>
  );
}

/** Photoshop-style curves: click to add a point, drag to move, double-click to remove. */
function CurvesEditor({ value, onChange }: { value: NonNullable<LayerFilters["curves"]>; onChange: (v: NonNullable<LayerFilters["curves"]>) => void }) {
  const [channel, setChannel] = useState<"rgb" | "r" | "g" | "b">("rgb");
  const [drag, setDrag] = useState<number | null>(null);
  const SIZE = 160;
  const pts: [number, number][] = [...(value[channel] ?? [[0, 0], [255, 255]])].sort((a, b) => a[0] - b[0]);
  const toScreen = (p: [number, number]) => ({ x: (p[0] / 255) * SIZE, y: SIZE - (p[1] / 255) * SIZE });
  const commit = (next: [number, number][]) => onChange({ ...value, [channel]: next });
  const fromEvent = (e: React.PointerEvent<SVGSVGElement>): [number, number] => { const r = e.currentTarget.getBoundingClientRect(); return [Math.round(Math.max(0, Math.min(255, ((e.clientX - r.left) / r.width) * 255))), Math.round(Math.max(0, Math.min(255, 255 - ((e.clientY - r.top) / r.height) * 255)))]; };
  const path = pts.map((p, i) => { const q = toScreen(p); return `${i ? "L" : "M"}${q.x} ${q.y}`; }).join(" ");
  return (
    <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
      <div className="seg" style={{ alignSelf: "flex-start" }}>{(["rgb", "r", "g", "b"] as const).map((c) => <button key={c} className={channel === c ? "on" : ""} onClick={() => setChannel(c)}>{c.toUpperCase()}</button>)}</div>
      <svg width={SIZE} height={SIZE} style={{ background: "#1a1a1a", border: "1px solid var(--line-2)", touchAction: "none" }}
        onPointerDown={(e) => { const p = fromEvent(e); const near = pts.findIndex((q) => Math.abs(q[0] - p[0]) < 10 && Math.abs(q[1] - p[1]) < 10); if (near >= 0) { setDrag(near); } else { const next = [...pts, p].sort((a, b) => a[0] - b[0]); commit(next); setDrag(next.findIndex((q) => q === p)); } e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (drag === null) return; const p = fromEvent(e); const next = pts.map((q, i) => (i === drag ? ([i === 0 ? 0 : i === pts.length - 1 ? 255 : p[0], p[1]] as [number, number]) : q)); commit(next); }}
        onPointerUp={() => setDrag(null)}
        onDoubleClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * 255, py = 255 - ((e.clientY - r.top) / r.height) * 255; const i = pts.findIndex((q) => Math.abs(q[0] - px) < 10 && Math.abs(q[1] - py) < 10); if (i > 0 && i < pts.length - 1) commit(pts.filter((_, j) => j !== i)); }}>
        {[0.25, 0.5, 0.75].map((t) => <g key={t}><line x1={t * SIZE} y1={0} x2={t * SIZE} y2={SIZE} stroke="#333" /><line x1={0} y1={t * SIZE} x2={SIZE} y2={t * SIZE} stroke="#333" /></g>)}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="#444" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={channel === "r" ? "#e55" : channel === "g" ? "#5d5" : channel === "b" ? "#59f" : "#eee"} strokeWidth={1.5} />
        {pts.map((p, i) => { const q = toScreen(p); return <rect key={i} x={q.x - 3.5} y={q.y - 3.5} width={7} height={7} fill="#fff" stroke="var(--accent)" />; })}
      </svg>
      <span style={{ color: "var(--text-faint)" }}>{pts.map((p) => `${p[0]}→${p[1]}`).join("  ")}</span>
    </div>
  );
}

type Field = { key: string; label: string; kind?: "num" | "color" | "bool" | "tuple"; min?: number; max?: number; step?: number };
/** Photoshop-style adjustments and pixel filters, with defaults and field definitions for the generic controls. */
export const ADJ_DEFS: Record<string, { label: string; init: unknown; fields: Field[] }> = {
  vibrance: { label: "Vibrance", init: 0.3, fields: [{ key: "value", label: "Amount", min: -1, max: 1, step: 0.05 }] },
  exposure: { label: "Exposure", init: { exposure: 0.5, offset: 0, gamma: 1 }, fields: [{ key: "exposure", label: "Stops", min: -5, max: 5, step: 0.1 }, { key: "offset", label: "Offset", min: -0.5, max: 0.5, step: 0.01 }, { key: "gamma", label: "Gamma", min: 0.1, max: 10, step: 0.05 }] },
  colorBalance: { label: "Color balance", init: { shadows: [0, 0, 0], midtones: [20, 0, -20], highlights: [0, 0, 0], preserveLuminosity: true }, fields: [{ key: "shadows", label: "Shadows", kind: "tuple", min: -100, max: 100, step: 5 }, { key: "midtones", label: "Midtones", kind: "tuple", min: -100, max: 100, step: 5 }, { key: "highlights", label: "Highl.", kind: "tuple", min: -100, max: 100, step: 5 }, { key: "preserveLuminosity", label: "Preserve luminosity", kind: "bool" }] },
  blackWhite: { label: "Black & white", init: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 }, fields: [{ key: "reds", label: "Reds", min: -200, max: 300, step: 5 }, { key: "yellows", label: "Yellows", min: -200, max: 300, step: 5 }, { key: "greens", label: "Greens", min: -200, max: 300, step: 5 }, { key: "cyans", label: "Cyans", min: -200, max: 300, step: 5 }, { key: "blues", label: "Blues", min: -200, max: 300, step: 5 }, { key: "magentas", label: "Magentas", min: -200, max: 300, step: 5 }] },
  photoFilter: { label: "Photo filter", init: { color: "#ec8a00", density: 0.25, preserveLuminosity: true }, fields: [{ key: "color", label: "Color", kind: "color" }, { key: "density", label: "Density", min: 0, max: 1, step: 0.05 }, { key: "preserveLuminosity", label: "Preserve luminosity", kind: "bool" }] },
  gradientMap: { label: "Gradient map", init: { stops: [{ pos: 0, color: "#1d3557" }, { pos: 1, color: "#f1faee" }] }, fields: [{ key: "reverse", label: "Reverse", kind: "bool" }] },
  channelMixer: { label: "Channel mixer", init: { r: [1, 0, 0, 0], g: [0, 1, 0, 0], b: [0, 0, 1, 0] }, fields: [{ key: "monochrome", label: "Monochrome", kind: "bool" }] },
  colorize: { label: "Colorize (hue/sat)", init: { hue: 30, saturation: 0.5, lightness: 0 }, fields: [{ key: "hue", label: "Hue", min: 0, max: 360, step: 1 }, { key: "saturation", label: "Sat", min: 0, max: 1, step: 0.05 }, { key: "lightness", label: "Light", min: -1, max: 1, step: 0.05 }] },
  shadowsHighlights: { label: "Shadows / highlights", init: { shadows: 0.35, highlights: 0 }, fields: [{ key: "shadows", label: "Shadows", min: 0, max: 1, step: 0.05 }, { key: "highlights", label: "Highl.", min: 0, max: 1, step: 0.05 }] },
  threshold: { label: "Threshold", init: 128, fields: [{ key: "value", label: "Level", min: 1, max: 255, step: 1 }] },
  posterize: { label: "Posterize", init: 4, fields: [{ key: "value", label: "Levels", min: 2, max: 255, step: 1 }] },
  unsharp: { label: "Unsharp mask", init: { amount: 1, radius: 2 }, fields: [{ key: "amount", label: "Amount", min: 0, max: 5, step: 0.1 }, { key: "radius", label: "Radius", min: 0.5, max: 50, step: 0.5 }] },
  motionBlur: { label: "Motion blur", init: { angle: 0, distance: 20 }, fields: [{ key: "angle", label: "Angle", min: -180, max: 180, step: 1 }, { key: "distance", label: "Distance", min: 1, max: 200, step: 1 }] },
  pixelate: { label: "Pixelate (mosaic)", init: 12, fields: [{ key: "value", label: "Cell", min: 2, max: 200, step: 1 }] },
  emboss: { label: "Emboss", init: 1, fields: [{ key: "value", label: "Amount", min: 0, max: 1, step: 0.05 }] },
  findEdges: { label: "Find edges", init: 1, fields: [{ key: "value", label: "Amount", min: 0, max: 1, step: 0.05 }] },
};

/** Photoshop-style gradient editor: type, angle, scale, reverse, and a stop list with colour, opacity and position. */
function GradientEditor({ value, onChange }: { value: import("@pictocity/core").GradientFill; onChange: (g: import("@pictocity/core").GradientFill) => void }) {
  const stops = [...value.stops].sort((a, b) => a.pos - b.pos);
  const css = `linear-gradient(90deg, ${stops.map((st) => { const m = /^#?([0-9a-f]{6})$/i.exec(st.color); const n = m ? parseInt(m[1], 16) : 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${st.opacity ?? 1}) ${Math.round(st.pos * 100)}%`; }).join(", ")})`;
  const upd = (i: number, patch: Partial<import("@pictocity/core").GradientStop>) => onChange({ ...value, stops: value.stops.map((st, k) => (k === i ? { ...st, ...patch } : st)) });
  return (
    <>
      <label style={{ gridColumn: "1 / -1" }}><span>Preview</span><div style={{ flex: 1, height: 16, border: "1px solid #000", background: `${css}, repeating-conic-gradient(#666 0 25%, #999 0 50%) 0 0 / 8px 8px` }} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const pos = Math.round(((e.clientX - r.left) / r.width) * 100) / 100; onChange({ ...value, stops: [...value.stops, { pos, color: "#888888", opacity: 1 }] }); }} title="Click to add a stop" /></label>
      <label><span>Preset</span><select value="" onChange={(e) => { const p = GRADIENT_PRESETS.find((x) => x.name === e.target.value); if (p) onChange({ ...value, stops: p.stops.map((st) => ({ ...st, color: st.color === "#000000" && p.name.startsWith("Foreground") ? useStore.getState().fgColor : st.color })) }); }}><option value="">Choose…</option>{GRADIENT_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select></label>
      <label><span>Type</span><select value={value.type} onChange={(e) => onChange({ ...value, type: e.target.value as import("@pictocity/core").GradientFill["type"] })}>{["linear", "radial", "angle", "reflected", "diamond"].map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
      <Num label="Angle" value={value.angle} onChange={(v) => onChange({ ...value, angle: v })} unit="°" />
      <Num label="Scale" value={value.scale ?? 1} step={0.05} min={0.05} max={5} onChange={(v) => onChange({ ...value, scale: v })} />
      <label><span></span><input type="checkbox" checked={!!value.reverse} onChange={(e) => onChange({ ...value, reverse: e.target.checked })} /> Reverse</label>
      {value.stops.map((st, i) => (
        <label key={i} style={{ gridColumn: "1 / -1" }}><span>Stop</span>
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(st.color) ? st.color : "#000000"} onChange={(e) => upd(i, { color: e.target.value })} />
          <input type="number" style={{ width: 52 }} min={0} max={100} step={1} value={Math.round(st.pos * 100)} onChange={(e) => upd(i, { pos: Number(e.target.value) / 100 })} onKeyDown={(e) => e.stopPropagation()} title="Position %" />
          <input type="number" style={{ width: 52 }} min={0} max={100} step={5} value={Math.round((st.opacity ?? 1) * 100)} onChange={(e) => upd(i, { opacity: Number(e.target.value) / 100 })} onKeyDown={(e) => e.stopPropagation()} title="Opacity %" />
          <button className="btn" disabled={value.stops.length <= 2} onClick={() => onChange({ ...value, stops: value.stops.filter((_, k) => k !== i) })}>×</button>
        </label>
      ))}
    </>
  );
}

let presetCache: { name: string; styles: LayerStyles }[] | null = null;

/** Layer style presets stored on the server (shared by everyone using it). */
function StylePresets({ layer, set }: { layer: Layer; set: Setter }) {
  const [presets, setPresets] = useState(presetCache ?? []);
  useEffect(() => { if (!presetCache) fetch("/api/style-presets").then((r) => r.json()).then((p) => { presetCache = p; setPresets(p); }).catch(() => undefined); }, []);
  const save = async (list: { name: string; styles: LayerStyles }[]) => { presetCache = list; setPresets(list); await fetch("/api/style-presets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(list) }); };
  return (
    <div className="section"><h4>Layer styles</h4>
      <div className="row">
        <select value="" onChange={(e) => { const p = presets.find((x) => x.name === e.target.value); if (p) set({ styles: JSON.parse(JSON.stringify(p.styles)) }, `Style: ${p.name}`); }}><option value="">Apply preset…</option>{presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select>
        <button className="btn" disabled={!layer.styles || !Object.keys(layer.styles).length} onClick={() => { const name = prompt("Preset name"); if (name) save([...presets.filter((p) => p.name !== name), { name, styles: layer.styles! }]); }}>Save…</button>
        {presets.length > 0 && <button className="btn" onClick={() => { const name = prompt("Delete which preset?", presets[0].name); if (name) save(presets.filter((p) => p.name !== name)); }}>Delete…</button>}
      </div>
    </div>
  );
}

let toolCache: { name: string; description: string; builtin: boolean }[] | null = null;

function ImageProps({ l, set }: { l: ImageLayer; set: Setter }) {
  const doc = useStore((s) => s.doc)!;
  const a = doc.assets[l.assetId];
  const [tools, setTools] = useState(toolCache ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (!toolCache) fetch("/api/image-tools").then((r) => r.json()).then((t) => { toolCache = t; setTools(t); }).catch(() => undefined); }, []);
  const run = async (tool: string) => {
    setBusy(tool);
    try {
      const r = await fetch(`/api/docs/${doc.id}/process`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, assetId: l.assetId }) });
      const asset = await r.json();
      if (!r.ok) throw new Error(asset.error ?? "tool failed");
      // The server registers the new asset via an op; wait for it to arrive, then swap the layer's image (undoable).
      const wait = (n: number): Promise<void> => new Promise((res, rej) => { const d = useStore.getState().doc; if (d?.assets[asset.id]) res(); else if (n <= 0) rej(new Error("asset did not arrive")); else setTimeout(() => wait(n - 1).then(res, rej), 80); });
      await wait(50);
      set({ assetId: asset.id }, `${tool} on ${l.name}`, `tool:${asset.id}`);
    } catch (e) { useStore.getState().showToast((e as Error).message); }
    setBusy(null);
  };
  const replace = async (file: File) => {
    const r = await fetch(`/api/docs/${doc.id}/assets`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(file.name) }, body: file });
    const asset = await r.json();
    if (!r.ok) { useStore.getState().showToast(asset.error ?? "Upload failed"); return; }
    const wait = (n: number): Promise<void> => new Promise((res) => { const d = useStore.getState().doc; if (d?.assets[asset.id] || n <= 0) res(); else setTimeout(() => wait(n - 1).then(res), 80); });
    await wait(50);
    set({ assetId: asset.id }, `Replace image ${l.name}`);
  };
  return (
    <div className="section">
      <h4>Image</h4>
      <div className="grid2">
        <label><span>Fit</span><select value={l.fit} onChange={(e) => set({ fit: e.target.value }, "Image fit")}><option value="cover">Cover (crop)</option><option value="contain">Contain</option><option value="fill">Stretch</option></select></label>
        <label><span></span><span style={{ color: "var(--text-faint)" }}>{a ? `${a.name} ${a.width}×${a.height}` : "missing asset"}</span></label>
        <label><span></span><button className="btn" onClick={() => a && set({ width: a.width, height: a.height }, "Original size")}>Original size</button></label>
        <label><span></span><label className="btn" style={{ display: "inline-flex", alignItems: "center" }}>Replace…<input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) replace(f); e.target.value = ""; }} /></label></label>
      </div>
      {tools.length > 0 && <div className="row" style={{ flexWrap: "wrap" }}>
        <span style={{ color: "var(--text-dim)" }}>Tools</span>
        {tools.map((t) => <button key={t.name} className="btn" title={t.description} disabled={!!busy || !a} onClick={() => run(t.name)}>{busy === t.name ? "Working…" : t.name.replace(/_/g, " ")}</button>)}
      </div>}
    </div>
  );
}

function FillProps({ l, set }: { l: FillLayer; set: Setter }) {
  const f = l.fill;
  const doc = useStore((s) => s.doc)!;
  return (
    <div className="section">
      <h4>Fill</h4>
      <div className="grid2">
        <label><span>Kind</span><select value={f.kind} onChange={(e) => { const k = e.target.value; set({ fill: k === "solid" ? { kind: "solid", color: f.kind === "solid" ? f.color : "#ffffff" } : k === "linear" ? { kind: "linear", from: "#ff8a00", to: "#e52e71", angle: 90 } : k === "pattern" ? { kind: "pattern", assetId: Object.keys(doc.assets)[0] ?? "", scale: 0.25 } : k === "gradient" ? { kind: "gradient", type: "linear", angle: 90, stops: f.kind === "linear" || f.kind === "radial" ? [{ pos: 0, color: f.from }, { pos: 1, color: f.to }] : [{ pos: 0, color: "#ff8a00" }, { pos: 1, color: "#e52e71" }] } : { kind: "radial", from: "#ffffff", to: "#000000" } }, "Fill"); }}><option value="solid">Solid</option><option value="gradient">Gradient (editor)</option><option value="linear">Linear (2 colours)</option><option value="radial">Radial (2 colours)</option><option value="pattern">Pattern (image)</option></select></label>
        {f.kind === "solid" && <Color label="Color" value={f.color} onChange={(v) => set({ fill: { ...f, color: v } }, "Fill color")} />}
        {f.kind === "pattern" && <><label style={{ gridColumn: "1 / -1" }}><span>Image</span><select value={f.assetId} onChange={(e) => set({ fill: { ...f, assetId: e.target.value } }, "Fill")}>{Object.values(doc.assets).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><Num label="Scale" value={f.scale} step={0.05} min={0.01} onChange={(v) => set({ fill: { ...f, scale: v } }, "Fill")} /></>}
        {f.kind === "gradient" && <GradientEditor value={f} onChange={(g) => set({ fill: g }, "Gradient")} />}
        {f.kind !== "solid" && f.kind !== "pattern" && f.kind !== "gradient" && <><Color label="From" value={f.from} onChange={(v) => set({ fill: { ...f, from: v } }, "Fill")} /><Color label="To" value={f.to} onChange={(v) => set({ fill: { ...f, to: v } }, "Fill")} /></>}
        {f.kind === "linear" && <Num label="Angle" value={f.angle} onChange={(v) => set({ fill: { ...f, angle: v } }, "Fill")} unit="°" />}
      </div>
    </div>
  );
}

export type { Layer };
