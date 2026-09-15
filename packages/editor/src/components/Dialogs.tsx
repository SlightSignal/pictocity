import React, { useEffect, useState } from "react";
import { artboards } from "@pictocity/core";
import { useStore } from "../store";
import { withToken } from "../env";
import { importPsdFile, importSvgFile, importImageFile } from "./Chrome";

/** Inputs inside dialogs keep their keystrokes to themselves, except Escape, which still closes the dialog. */
const stopKeys = (e: React.KeyboardEvent) => { if (e.key === "Escape") { useStore.setState({ modal: null }); return; } e.stopPropagation(); };

const FORMATS = [
  ["png", "PNG (lossless, alpha)"], ["png8", "PNG-8 (palette, small)"], ["jpg", "JPEG"], ["webp", "WebP"], ["avif", "AVIF"], ["gif", "GIF (animated if timeline)"],
  ["tiff", "TIFF (RGBA, print)"], ["bmp", "BMP"], ["pdf", "PDF (page per artboard)"], ["svg", "SVG (vector)"], ["psd", "Photoshop PSD (layered)"], ["html", "HTML5 banner (timeline)"], ["pictocity", ".pictocity package (document + images)"],
] as const;
const QUALITY_FORMATS = new Set(["jpg", "webp", "avif", "pdf"]);
const ALPHA_FORMATS = new Set(["png", "png8", "webp", "avif", "tiff", "bmp", "gif"]);

/** Photoshop's Export As: format, quality, scales with suffixes, transparency, trim, scope, destination. */
export function ExportDialog() {
  const doc = useStore((s) => s.doc)!;
  const selection = useStore((s) => s.selection);
  const abs = artboards(doc);
  const [format, setFormat] = useState<(typeof FORMATS)[number][0]>("png");
  const [quality, setQuality] = useState(90);
  const [colors, setColors] = useState(256);
  const [scales, setScales] = useState<number[]>([1]);
  const [transparent, setTransparent] = useState(false);
  const [trim, setTrim] = useState(false);
  const [dpi, setDpi] = useState(72);
  const [scope, setScope] = useState<"canvas" | "artboards" | "current" | "comps">(abs.length ? "artboards" : "canvas");
  const [toServer, setToServer] = useState(false);
  const [results, setResults] = useState<{ name: string; url: string; bytes?: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const currentAb = selection.length ? abs.find((a) => a.id === selection[0]) : undefined;
  useEffect(() => {
    if (format === "pictocity" || format === "psd" || format === "html" || format === "svg") { setPreview(null); return; }
    const q = new URLSearchParams({ format, scale: "0.2", quality: String(quality), colors: String(colors), transparent: String(transparent), trim: String(trim), t: String(Date.now()) });
    if (scope === "current" && currentAb) q.set("artboard", currentAb.id);
    setPreview(withToken(`/api/docs/${doc.id}/export?${q}`));
  }, [format, quality, colors, transparent, trim, scope, currentAb, doc.id]);
  const suffix = (s: number) => (s === 1 ? "" : `@${s}x`);
  const run = async () => {
    setBusy(true); setResults(null);
    const out: { name: string; url: string; bytes?: number }[] = [];
    try {
      if (format === "pictocity") { const a = document.createElement("a"); a.href = withToken(`/api/docs/${doc.id}/package`); a.download = `${doc.name}.pictocity`; a.click(); setBusy(false); useStore.setState({ modal: null }); return; }
      const targets: { name: string; artboard?: string }[] = scope === "artboards" && abs.length ? abs.map((a) => ({ name: a.name, artboard: a.id })) : scope === "current" && currentAb ? [{ name: currentAb.name, artboard: currentAb.id }] : [{ name: doc.name }];
      for (const s of scales) for (const t of targets) {
        const q: Record<string, string> = { format, scale: String(s), quality: String(quality), colors: String(colors), transparent: String(transparent), trim: String(trim), dpi: String(dpi) };
        if (t.artboard) q.artboard = t.artboard;
        if (format === "pdf" && scope === "artboards") { q.artboards = "true"; delete q.artboard; }
        const ext = format === "jpg" ? "jpg" : format === "png8" ? "png" : format;
        const fileName = `${t.name}${suffix(s)}.${ext}`;
        if (toServer || scope === "comps") {
          const r = await fetch(`/api/docs/${doc.id}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...q, ...(scope === "comps" ? { comps: true } : {}), scale: s, quality, colors, dpi, transparent, trim, artboards: format === "pdf" && scope === "artboards" ? true : undefined, artboard: t.artboard }) });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error ?? "export failed");
          if (d.files) d.files.forEach((f: { name: string; path: string }) => out.push({ name: f.name, url: withToken(`/exports/${encodeURIComponent(f.path.split("/").pop()!)}`) }));
          else out.push({ name: fileName, url: withToken(d.url ?? `/exports/${encodeURIComponent(d.path.split("/").pop()!)}`), bytes: d.bytes });
          if (format === "pdf" && scope === "artboards") break;
        } else {
          const a = document.createElement("a"); a.href = withToken(`/api/docs/${doc.id}/export?${new URLSearchParams({ ...q, t: String(Date.now()) })}`); a.download = fileName; a.click();
          out.push({ name: fileName, url: a.href });
          if (format === "pdf" && scope === "artboards") break;
          await new Promise((r) => setTimeout(r, 350));
        }
      }
      setResults(out);
    } catch (e) { useStore.getState().showToast((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal" style={{ width: 640 }}>
        <header>Export As</header>
        <div className="content" style={{ gridTemplateColumns: "110px 1fr 200px", alignItems: "start" }}>
          <label>Format</label><select value={format} onChange={(e) => setFormat(e.target.value as never)}>{FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <div style={{ gridRow: "1 / span 8", justifySelf: "end" }}>{preview ? <img src={preview} alt="" style={{ maxWidth: 200, maxHeight: 220, background: "repeating-conic-gradient(#666 0 25%, #999 0 50%) 0 0 / 12px 12px", border: "1px solid var(--line-2)" }} /> : <div className="hint" style={{ width: 200 }}>No preview for this format.</div>}</div>
          {QUALITY_FORMATS.has(format) && <><label>Quality</label><div className="row"><input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} style={{ flex: 1 }} /><span style={{ width: 34 }}>{quality}</span></div></>}
          {(format === "png8" || format === "gif") && <><label>Colours</label><input type="number" min={2} max={256} value={colors} onChange={(e) => setColors(Math.max(2, Math.min(256, Number(e.target.value))))} /></>}
          {format !== "svg" && format !== "psd" && format !== "html" && format !== "pictocity" && <><label>Scale</label><div className="row">{[0.5, 1, 1.5, 2, 3].map((s) => <label key={s} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={scales.includes(s)} onChange={(e) => setScales(e.target.checked ? [...scales, s].sort() : scales.filter((x) => x !== s))} />{s}×</label>)}</div></>}
          {ALPHA_FORMATS.has(format) && <><label>Background</label><label style={{ textAlign: "left" }}><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent (ignore canvas colour)</label></>}
          {format !== "svg" && format !== "psd" && format !== "html" && format !== "pictocity" && <><label>Trim</label><label style={{ textAlign: "left" }}><input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} /> Crop to non-transparent pixels</label></>}
          {(format === "pdf" || format === "tiff") && <><label>DPI</label><input type="number" min={36} max={1200} value={dpi} onChange={(e) => setDpi(Number(e.target.value))} /></>}
          <label>Scope</label><select value={scope} onChange={(e) => setScope(e.target.value as never)}><option value="canvas">Whole canvas</option>{abs.length > 0 && <option value="artboards">Each artboard ({abs.length} files{format === "pdf" ? " → one PDF, one page each" : ""})</option>}{currentAb && <option value="current">Current artboard ({currentAb.name})</option>}{(doc.comps?.length ?? 0) > 0 && <option value="comps">Each layer comp ({doc.comps!.length})</option>}</select>
          <label>Destination</label><div className="seg"><button className={!toServer ? "on" : ""} onClick={() => setToServer(false)}>Download</button><button className={toServer ? "on" : ""} onClick={() => setToServer(true)}>Save to server exports</button></div>
          {results && <div style={{ gridColumn: "1 / -1" }} className="hint">{results.length} file(s): {results.map((r) => <a key={r.url} href={r.url} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>{r.name}{r.bytes ? ` (${(r.bytes / 1024).toFixed(0)} KB)` : ""}</a>)}</div>}
        </div>
        <footer><span className="hint" style={{ flex: 1 }}>{scales.length > 1 ? `Files get ${scales.filter((s) => s !== 1).map((s) => `@${s}x`).join(", ")} suffixes.` : ""}</span><button className="btn" onClick={() => useStore.setState({ modal: null })}>Close</button><button className="btn primary" disabled={busy || !scales.length} onClick={run}>{busy ? "Exporting…" : toServer ? "Export to server" : "Export"}</button></footer>
      </div>
    </div>
  );
}

/** Open: server documents with thumbnails and search, recent, and files from the computer. */
export function OpenDialog() {
  const docs = useStore((s) => s.docs);
  const recent = useStore((s) => s.recentDocs);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const st = useStore.getState();
  const open = (id: string) => { st.connect(id); useStore.setState({ modal: null, zoom: 1, pan: { x: 0, y: 0 } }); };
  const list = docs.filter((d) => d.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt)));
  const fromComputer = async (f: File) => {
    const name = f.name.toLowerCase();
    if (name.endsWith(".psd")) return importPsdFile(f);
    if (name.endsWith(".svg")) return importSvgFile(f, false);
    if (name.endsWith(".pictocity") || name.endsWith(".json")) {
      const r = await fetch("/api/docs/import-package", { method: "POST", headers: { "content-type": "application/json" }, body: await f.text() });
      const d = await r.json(); if (!r.ok) { st.showToast(d.error ?? "Could not open that file"); return; }
      open(d.id); return;
    }
    if (f.type.startsWith("image/")) {
      // Like Photoshop: an image opens as a document of its own size with the image as a layer.
      const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
      const r = await fetch("/api/docs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: f.name.replace(/\.[^.]+$/, ""), width: img.naturalWidth, height: img.naturalHeight, background: null }) });
      const d = await r.json(); st.connect(d.id); useStore.setState({ modal: null, zoom: 1, pan: { x: 0, y: 0 } });
      setTimeout(() => importImageFile(f), 500); return;
    }
    st.showToast("Open .pictocity, .psd, .svg or an image file");
  };
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal" style={{ width: 620 }}>
        <header>Open</header>
        <div className="content" style={{ display: "block" }}>
          <div className="row" style={{ marginBottom: 6 }}><input type="text" placeholder="Search documents…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={stopKeys} style={{ flex: 1 }} autoFocus /><div className="seg"><button className={sort === "recent" ? "on" : ""} onClick={() => setSort("recent")}>Recent</button><button className={sort === "name" ? "on" : ""} onClick={() => setSort("name")}>Name</button></div></div>
          {recent.length > 0 && !q && <div className="hint" style={{ marginBottom: 4 }}>Recent: {recent.slice(0, 6).map((r) => <button key={r.id} className="btn" style={{ marginRight: 4 }} onClick={() => open(r.id)}>{r.name}</button>)}</div>}
          <div className="list" style={{ maxHeight: 340, overflow: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
            {list.length === 0 && <div className="hint">No documents match. Create one, open a file from your computer, or ask the agent.</div>}
            {list.map((d) => (
              <div key={d.id} className="doc-card" onDoubleClick={() => open(d.id)}>
                <img src={withToken(`/api/docs/${d.id}/render.png?scale=${Math.min(0.15, 160 / Math.max(d.width, d.height)).toFixed(3)}&t=${d.rev}`)} alt="" loading="lazy" />
                <div className="doc-meta"><strong title={d.name}>{d.name}</strong><span>{d.width}×{d.height} · rev {d.rev}</span></div>
                <div className="row" style={{ gap: 2 }}>
                  <button className="btn primary" onClick={() => open(d.id)}>Open</button>
                  <button className="btn" title="Rename" onClick={async () => { const n = prompt("Name", d.name); if (n && n !== d.name) { await fetch(`/api/docs/${d.id}/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "user:editor", label: "Rename", ops: [{ type: "doc.set", props: { name: n } }] }) }); st.refreshDocs(); } }}>✎</button>
                  <button className="btn" title="Duplicate" onClick={async () => { await fetch(`/api/docs/${d.id}/variant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ width: d.width, height: d.height, name: `${d.name} copy`, scaleContent: false }) }); st.refreshDocs(); }}>⧉</button>
                  <button className="btn" title="Delete" onClick={async () => { if (confirm(`Delete "${d.name}"? This cannot be undone.`)) { await fetch(`/api/docs/${d.id}`, { method: "DELETE" }); st.refreshDocs(); } }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <footer>
          <label className="btn" style={{ display: "inline-flex", alignItems: "center" }}>Open from computer… (.pictocity, .psd, .svg, image)<input type="file" accept=".pictocity,.json,.psd,.svg,image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) fromComputer(f); e.target.value = ""; }} /></label>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => useStore.setState({ modal: null })}>Cancel</button>
          <button className="btn primary" onClick={() => useStore.setState({ modal: "new" })}>New…</button>
        </footer>
      </div>
    </div>
  );
}

/** Save As: rename, save a copy on the server, or download the document as a file. */
export function SaveAsDialog() {
  const doc = useStore((s) => s.doc)!;
  const [name, setName] = useState(doc.name);
  const st = useStore.getState();
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal" style={{ width: 460 }}>
        <header>Save As</header>
        <div className="content">
          <label>Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={stopKeys} autoFocus />
          <div style={{ gridColumn: "1 / -1" }} className="hint">Every change is already saved on the server (rev {doc.rev}). Use these to keep a copy or take the file elsewhere.</div>
        </div>
        <footer style={{ flexWrap: "wrap", gap: 6 }}>
          <button className="btn" onClick={() => { if (name && name !== doc.name) st.dispatch([{ type: "doc.set", props: { name } }], "Rename"); useStore.setState({ modal: null }); }}>Rename</button>
          <button className="btn" onClick={async () => { const r = await fetch(`/api/docs/${doc.id}/variant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ width: doc.width, height: doc.height, name, scaleContent: false }) }); const d = await r.json(); if (r.ok) { st.connect(d.id); useStore.setState({ modal: null }); } }}>Save a copy on the server</button>
          <button className="btn" onClick={() => { const a = document.createElement("a"); a.href = withToken(`/api/docs/${doc.id}/package`); a.download = `${name}.pictocity`; a.click(); }}>Download .pictocity</button>
          <button className="btn" onClick={() => { const a = document.createElement("a"); a.href = withToken(`/api/docs/${doc.id}/export?format=psd&t=${Date.now()}`); a.download = `${name}.psd`; a.click(); }}>Download .psd</button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => useStore.setState({ modal: null })}>Done</button>
        </footer>
      </div>
    </div>
  );
}

/** Files the server has exported, newest first. */
export function ExportsDialog() {
  const [files, setFiles] = useState<{ file: string; bytes: number; mtime: number; url: string }[]>([]);
  const [paths, setPaths] = useState<{ data?: string; exports?: string }>({});
  useEffect(() => { fetch("/api/exports").then((r) => r.json()).then(setFiles).catch(() => undefined); fetch("/api/health").then((r) => r.json()).then((h) => setPaths(h.paths ?? {})).catch(() => undefined); }, []);
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal" style={{ width: 560 }}>
        <header>Exports on the server</header>
        <div className="content" style={{ display: "block" }}>
          {paths.exports && <div className="hint" style={{ marginBottom: 6 }}>Folder: <code>{paths.exports}</code></div>}
          <div className="list" style={{ maxHeight: 360, overflow: "auto" }}>
            {files.length === 0 && <div className="hint">Nothing exported yet.</div>}
            {files.map((f) => <a key={f.file} className="row" href={withToken(f.url)} target="_blank" rel="noreferrer" style={{ justifyContent: "space-between", padding: "4px 6px", color: "var(--text)" }}><span>{f.file}</span><span style={{ color: "var(--text-faint)" }}>{(f.bytes / 1024).toFixed(0)} KB · {new Date(f.mtime).toLocaleString()}</span></a>)}
          </div>
        </div>
        <footer><button className="btn primary" onClick={() => useStore.setState({ modal: null })}>Close</button></footer>
      </div>
    </div>
  );
}

/** Preferences (⌘K): the handful of settings that exist. */
export function PreferencesDialog() {
  const doc = useStore((s) => s.doc);
  const gridSize = useStore((s) => s.gridSize);
  const wand = useStore((s) => s.wandTolerance);
  const feather = useStore((s) => s.selectionFeather);
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal" style={{ width: 420 }}>
        <header>Preferences</header>
        <div className="content">
          <label>Grid spacing</label><input type="number" min={2} value={gridSize} onChange={(e) => useStore.setState({ gridSize: Math.max(2, Number(e.target.value)) })} onKeyDown={stopKeys} />
          <label>Wand tolerance</label><input type="number" min={0} max={255} value={wand} onChange={(e) => useStore.setState({ wandTolerance: Number(e.target.value) })} onKeyDown={stopKeys} />
          <label>Selection feather</label><input type="number" min={0} value={feather} onChange={(e) => useStore.setState({ selectionFeather: Math.max(0, Number(e.target.value)) })} onKeyDown={stopKeys} />
          <label>Blending</label><label style={{ textAlign: "left" }}><input type="checkbox" checked={!!doc?.linearBlending} disabled={!doc} onChange={(e) => doc && useStore.getState().dispatch([{ type: "doc.set", props: { linearBlending: (e.target.checked || null) as unknown as boolean } }], "Linear blending")} /> Blend gradients and blurs in linear light (this document). Photoshop's default is off; on avoids muddy gradient midpoints and dark blur halos.</label>
          <div style={{ gridColumn: "1 / -1" }} className="hint">Documents autosave on every change. Fonts live in the server's fonts/ folder (File › Install font…). Image tools come from image-tools.json.</div>
        </div>
        <footer><button className="btn primary" onClick={() => useStore.setState({ modal: null })}>Done</button></footer>
      </div>
    </div>
  );
}
