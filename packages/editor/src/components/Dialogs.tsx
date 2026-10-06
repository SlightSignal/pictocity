import React, { useEffect, useRef, useState } from "react";
import { artboards } from "@pictocity/core";
import { useStore } from "../store";
import { withToken, refreshAssets, assetStatus } from "../env";
import type { AssetCheck } from "../asset-refresh";
import { EXPORT_DOWNLOAD_LIMITS, prepareExportSetDownload, readExportResponse, readExportJson, exportResponseError } from "../export-download";
import { importPsdFile, importSvgFile, importImageFile } from "./Chrome";

/** Inputs inside dialogs keep their keystrokes to themselves, except Escape, which still closes the dialog. */
const stopKeys = (e: React.KeyboardEvent) => { if (e.key === "Escape") { useStore.setState({ modal: null }); return; } e.stopPropagation(); };

/** Keep keyboard navigation inside the export dialog, including when controls appear or disappear. */
const trapDialogTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
  if (e.key !== "Tab") return;
  const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter((el) => el.offsetParent !== null);
  const first = controls[0], last = controls[controls.length - 1];
  if (!first) { e.preventDefault(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
};

const FORMATS = [
  ["png", "PNG (lossless, alpha)"], ["png8", "PNG-8 (palette, small)"], ["jpg", "JPEG"], ["webp", "WebP"], ["avif", "AVIF"], ["gif", "GIF (animated if timeline)"],
  ["tiff", "TIFF (RGBA raster)"], ["bmp", "BMP"], ["pdf", "PDF (page per artboard)"], ["svg", "SVG (vector)"], ["psd", "Photoshop PSD (layered)"], ["html", "HTML5 banner (timeline)"], ["pictocity", ".pictocity package (document + images)"],
  ["mp4", "MP4 video (H.264)"], ["webm", "WebM video (VP9)"],
] as const;
const QUALITY_FORMATS = new Set(["jpg", "webp", "avif", "pdf"]);
const ALPHA_FORMATS = new Set(["png", "png8", "webp", "avif", "tiff", "bmp", "gif"]);

/** Keep the Open grid from flooding the bounded native renderer with thumbnail requests. */
let thumbnailActive = 0;
const thumbnailWaiters: (() => void)[] = [];
async function thumbnailSlot() { if (thumbnailActive >= 3) await new Promise<void>((resolve) => thumbnailWaiters.push(resolve)); else thumbnailActive++; return () => { const next = thumbnailWaiters.shift(); if (next) next(); else thumbnailActive--; }; }
function DocumentThumbnail({ id, width, height, rev }: { id: string; width: number; height: number; rev: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let blobUrl: string | undefined;
    void (async () => {
      const release = await thumbnailSlot();
      try {
        for (let attempt = 0; attempt < 8 && !controller.signal.aborted; attempt++) {
          const r = await fetch(withToken(`/api/docs/${id}/render.png?scale=${Math.min(0.15, 160 / Math.max(width, height)).toFixed(3)}&t=${rev}`), { signal: controller.signal });
          if (r.status === 429) { await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
          if (!r.ok) return;
          blobUrl = URL.createObjectURL(await r.blob()); if (!controller.signal.aborted) setUrl(blobUrl); return;
        }
      } catch { /* unavailable previews leave the document openable */ }
      finally { release(); if (controller.signal.aborted && blobUrl) URL.revokeObjectURL(blobUrl); }
    })();
    return () => { controller.abort(); if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [id, width, height, rev]);
  return url ? <img src={url} alt="Document preview" /> : <div className="thumbnail-pending">Preview unavailable or loading</div>;
}

/** Photoshop's Export As: format, quality, scales with suffixes, transparency, trim, scope, destination. */
export function ExportDialog() {
  const doc = useStore((s) => s.doc)!;
  const connection = useStore((s) => s.connection);
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
  const [archive, setArchive] = useState<{ name: string; url: string; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<AssetCheck | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fps, setFps] = useState(doc.animation?.fps ?? 24);
  const [duration, setDuration] = useState((doc.animation?.duration ?? 5000) / 1000);
  const [progress, setProgress] = useState("Preparing…");
  const request = useRef<AbortController | null>(null);
  const exportAction = useRef<HTMLButtonElement | null>(null);
  const saveAction = useRef<HTMLAnchorElement | null>(null);
  const downloads = useRef<string[]>([]);
  const mounted = useRef(true);
  const currentPreview = useRef(preview); currentPreview.current = preview;
  const isVideo = format === "mp4" || format === "webm";
  const currentAb = selection.length ? abs.find((a) => a.id === selection[0]) : undefined;
  const optionsKey = JSON.stringify([doc.id, doc.rev, format, quality, colors, scales, transparent, trim, dpi, scope, scope === "current" ? currentAb?.id : null, toServer, fps, duration]);
  const currentOptions = useRef(optionsKey); currentOptions.current = optionsKey;
  const reviewedResources = useRef<string | undefined>();
  const resultScope = useRef<{ options: string; resources: string } | null>(null);
  const resultGeneration = useRef(0), renderedGeneration = resultGeneration.current;
  const usableResults = () => mounted.current && renderedGeneration === resultGeneration.current && resultScope.current?.options === currentOptions.current && resultScope.current?.resources === reviewedResources.current && useStore.getState().doc?.id === doc.id && useStore.getState().doc?.rev === doc.rev;
  const clearDownloads = () => { downloads.current.splice(0).forEach((url) => URL.revokeObjectURL(url)); resultScope.current = null; resultGeneration.current++; };
  const retire = () => { request.current?.abort(); request.current = null; clearDownloads(); setBusy(false); setResults(null); setArchive(null); setProblem(null); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); request.current = null; clearDownloads(); }; }, []);
  useEffect(() => { if (isVideo || format === "pictocity") setScope("canvas"); if (format === "pictocity") setToServer(false); if (isVideo) setTransparent(false); }, [isVideo, format]);
  useEffect(() => { retire(); }, [optionsKey]);
  useEffect(() => {
    if (!busy && preflight?.ok && preflight.revision === doc.rev && (results || problem) && !exportAction.current?.disabled) {
      if (archive && usableResults()) saveAction.current?.focus(); else exportAction.current?.focus();
    }
  }, [busy, preflight?.ok, preflight?.revision, doc.rev, results, archive, problem]);
  useEffect(() => {
    if (connection !== "online") { setPreflight(null); return; }
    let timer: ReturnType<typeof setTimeout>, generation = 0, disposed = false;
    const recheck = () => {
      const checkGeneration = ++generation; clearTimeout(timer); setPreflight(null);
      if (document.visibilityState !== "visible") return;
      timer = setTimeout(async () => {
        const check = await refreshAssets(); // Shares the canvas focus/manual refresh, including content identities.
        if (disposed || generation !== checkGeneration || useStore.getState().doc?.id !== doc.id || useStore.getState().doc?.rev !== doc.rev) return;
        const resources = check?.ok && check.docId === doc.id && check.revision === doc.rev ? check.resourceSnapshot?.sha256 : undefined;
        if (reviewedResources.current && reviewedResources.current !== resources) retire();
        reviewedResources.current = resources;
        if (check) setPreflight(check);
        else setProblem(assetStatus().issues[0] ?? "Images could not be checked. Refresh images to retry.");
      }, 250);
    };
    // Keep refresh boundaries active during transport/hashing so changed resources retire work.
    if (busy) setPreflight(null); else recheck();
    window.addEventListener("focus", recheck); document.addEventListener("visibilitychange", recheck);
    return () => { disposed = true; generation++; clearTimeout(timer); window.removeEventListener("focus", recheck); document.removeEventListener("visibilitychange", recheck); };
  }, [doc.id, doc.rev, busy, connection]);
  useEffect(() => {
    if (!busy || connection !== "online") return;
    let timer: ReturnType<typeof setTimeout>, controller: AbortController | null = null, disposed = false;
    const poll = async () => {
      if (disposed || controller || document.visibilityState !== "visible") return;
      const req = new AbortController(); controller = req;
      const deadline = setTimeout(() => req.abort(), 5000);
      try {
        const r = await fetch(withToken("/api/render-status"), { signal: req.signal }); const status = await readExportJson(r, req.signal);
        if (disposed || req.signal.aborted || useStore.getState().doc?.id !== doc.id) return;
        const set = status.exportSets?.live?.find((item: { docId: string }) => item.docId === doc.id);
        const job = status.active, capture = status.resources?.capturing?.find((item: { docId: string }) => item.docId === doc.id);
        setProgress(set && set.phase !== "capturing" ? `Exporting · ${set.completed} / ${set.total} files` : capture ? `Preparing images and fonts · ${capture.completed} / ${capture.total}` : job?.docId === doc.id ? (job.total ? `${job.phase === "encoding" ? "Finishing" : "Rendering"} · ${job.completed} / ${job.total} frames` : `${job.phase === "checking" ? "Checking project" : job.phase === "capturing" ? "Preparing images and fonts" : "Rendering"}…`) : "Waiting for the renderer…");
      } catch { /* export request reports failures */ }
      finally { clearTimeout(deadline); if (controller === req) controller = null; if (!disposed && document.visibilityState === "visible") timer = setTimeout(poll, 500); }
    };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState === "visible") void poll(); else controller?.abort(); };
    void poll(); document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [busy, doc.id, connection]);
  useEffect(() => {
    if (!preflight?.ok || preflight.docId !== doc.id || preflight.revision !== doc.rev || !preflight.resourceSnapshot?.sha256 || format === "pictocity" || format === "psd" || format === "html" || format === "svg") { setPreview(null); return; }
    const q = new URLSearchParams({ format: isVideo ? "png" : format, scale: "0.2", quality: String(quality), colors: String(colors), transparent: String(transparent), trim: String(trim), expectedRev: String(doc.rev), t: String(doc.rev) });
    if (scope === "current" && currentAb) q.set("artboard", currentAb.id);
    if (preflight?.resourceSnapshot?.sha256) q.set("expectedResources", preflight.resourceSnapshot.sha256);
    setPreview(withToken(`/api/docs/${doc.id}/export?${q}`));
  }, [format, quality, colors, transparent, trim, scope, currentAb, doc.id, doc.rev, preflight]);
  useEffect(() => {
    if (!results) return;
    const generation = resultGeneration.current;
    const timer = setTimeout(() => { if (resultGeneration.current === generation) { clearDownloads(); setResults(null); setArchive(null); } }, EXPORT_DOWNLOAD_LIMITS.lifetimeMs);
    return () => clearTimeout(timer);
  }, [results]);
  const run = async () => {
    if (!preflight?.ok || preflight.docId !== doc.id || preflight.revision !== doc.rev || !preflight.resourceSnapshot?.sha256) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const resources = preflight.resourceSnapshot.sha256;
    const inScope = () => mounted.current && request.current === controller && currentOptions.current === optionsKey && reviewedResources.current === resources && useStore.getState().doc?.id === doc.id && useStore.getState().doc?.rev === doc.rev;
    const live = () => inScope() && !controller.signal.aborted;
    const deadline = setTimeout(() => controller.abort(), EXPORT_DOWNLOAD_LIMITS.lifetimeMs);
    clearDownloads(); setBusy(true); setResults(null); setArchive(null); setProblem(null); setProgress("Preparing…");
    const link = (blob: Blob, name: string) => {
      const url = URL.createObjectURL(blob); downloads.current.push(url);
      resultScope.current = { options: optionsKey, resources };
      return { name, url, bytes: blob.size };
    };
    const download = (blob: Blob, name: string) => {
      const result = link(blob, name), url = result.url;
      const a = document.createElement("a"); a.href = url; a.download = name; a.click();
      return result;
    };
    try {
      if (format === "pictocity") {
        const r = await fetch(withToken(`/api/docs/${doc.id}/package`), { signal: controller.signal });
        if (!r.ok) throw new Error(await exportResponseError(r, "Package failed", controller.signal));
        const data = await readExportResponse(r, EXPORT_DOWNLOAD_LIMITS.envelopeBytes, controller.signal); if (!live()) return;
        const blob = new Blob([data], { type: r.headers.get("content-type") ?? "" });
        setResults([download(blob, `${doc.name}.pictocity`)]); return;
      }
      const exportScales = ["psd", "html", "svg"].includes(format) ? [1] : scales;
      const multiple = exportScales.length > 1 || (scope === "artboards" && abs.length > 1 && format !== "pdf") || scope === "comps";
      const expectedFiles = exportScales.length * (scope === "comps" ? doc.comps?.length ?? 0 : scope === "artboards" && format !== "pdf" ? abs.length : 1);
      const q = { format, quality, colors, dpi, transparent, trim: isVideo || ["gif", "psd", "svg", "html"].includes(format) ? false : trim, expectedRev: doc.rev, expectedResources: preflight.resourceSnapshot.sha256,
        ...(isVideo ? { fps, duration } : {}), ...(scope === "artboards" ? abs.length === 1 && format !== "pdf" ? { artboard: abs[0].id } : { artboards: true } : scope === "current" && currentAb ? { artboard: currentAb.id } : scope === "comps" ? { comps: true } : {}) };
      if (toServer || multiple || ((scope === "current" || scope === "artboards") && ["gif", "psd", "svg", "html"].includes(format))) {
        const r = await fetch(withToken(`/api/docs/${doc.id}/export-set`), { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...q, scales: exportScales, destination: toServer ? "server" : "download" }) });
        if (!r.ok) throw new Error(await exportResponseError(r, "Export set failed", controller.signal));
        if (toServer) {
          const data = await readExportJson(r, controller.signal); if (!live()) return;
          if (!Array.isArray(data.files) || data.files.length !== expectedFiles || data.resourceSnapshot?.revision !== doc.rev || data.resourceSnapshot?.sha256 !== q.expectedResources || data.files.some((f: { name: string; url: string; bytes: number }) => typeof f.name !== "string" || typeof f.url !== "string" || !Number.isSafeInteger(f.bytes) || f.bytes <= 0)) throw new Error("Export results do not match the reviewed set");
          resultScope.current = { options: optionsKey, resources };
          setResults(data.files.map((f: { name: string; url: string; bytes: number }) => ({ name: f.name, url: withToken(f.url), bytes: f.bytes })));
        } else {
          const data = await readExportResponse(r, EXPORT_DOWNLOAD_LIMITS.envelopeBytes, controller.signal, "application/vnd.pictocity.export-set"); if (!live()) return;
          setProgress("Checking exported files…");
          const prepared = await prepareExportSetDownload(data, { revision: doc.rev, resources, files: expectedFiles, documentName: doc.name }, controller.signal);
          if (!live()) return;
          if (prepared.archived) {
            setArchive(link(prepared.save.blob, prepared.save.name));
            setResults(prepared.members.map(({ blob, name }) => link(blob, name)));
          } else setResults([download(prepared.save.blob, prepared.save.name)]);
        }
      } else {
        const query = new URLSearchParams(Object.entries({ ...q, scale: exportScales[0] }).map(([key, value]) => [key, String(value)]));
        const r = await fetch(withToken(`/api/docs/${doc.id}/export?${query}`), { signal: controller.signal });
        if (!r.ok) throw new Error(await exportResponseError(r, "Export failed", controller.signal));
        const data = await readExportResponse(r, EXPORT_DOWNLOAD_LIMITS.envelopeBytes, controller.signal); if (!live()) return;
        const blob = new Blob([data], { type: r.headers.get("content-type") ?? "" });
        const disposition = r.headers.get("content-disposition");
        const actual = disposition?.match(/filename="([^"]+)"/)?.[1];
        const scaleSuffix = exportScales[0] === 1 ? "" : `@${exportScales[0]}x`;
        const name = `${currentAb && scope === "current" ? currentAb.name : doc.name}${scaleSuffix}.${format === "png8" ? "png" : format}`;
        setResults([download(blob, actual && exportScales[0] === 1 ? actual : name)]);
      }
    } catch (e) { if (inScope()) { clearDownloads(); setResults(null); setArchive(null); setProblem(controller.signal.aborted ? "Export cancelled." : (e as Error).message); } }
    finally { clearTimeout(deadline); if (inScope()) { setBusy(false); request.current = null; } }
  };
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) useStore.setState({ modal: null }); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title" onKeyDown={trapDialogTab} style={{ width: 640 }}>
        <header id="export-title">Export As</header>
        <div className="export-check" role="status" aria-live="polite">
          {problem ?? (preflight ? preflight.ok ? "Project checked · images and fonts available" : "Fix these project resources before exporting:" : "Checking images and fonts…")}
          {preflight && !preflight.ok && <ul>{preflight.issues.map((issue, i) => <li key={i}>{issue.message}</li>)}</ul>}
        </div>
        <div className="content" style={{ gridTemplateColumns: "110px 1fr 200px", alignItems: "start" }}>
          <label>Format</label><select aria-label="Format" autoFocus value={format} onChange={(e) => setFormat(e.target.value as never)}>{FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {isVideo && <><label>Frame rate</label><input aria-label="Frame rate" type="number" min={1} max={120} value={fps} onChange={(e) => setFps(Number(e.target.value))} /><label>Duration (seconds)</label><input aria-label="Duration (seconds)" type="number" min={0.01} max={600} step={0.1} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></>}
          <div style={{ gridRow: "1 / span 8", justifySelf: "end" }}>{preview && preflight?.ok && preflight.docId === doc.id && preflight.revision === doc.rev && preview.includes(preflight.resourceSnapshot?.sha256 ?? "missing") ? <img key={preview} src={preview} alt="Export preview" onError={() => { if (currentPreview.current === preview && useStore.getState().doc?.id === doc.id && useStore.getState().doc?.rev === doc.rev) { setPreview(null); setProblem("Preview unavailable. Refresh images to check the current sources."); } }} style={{ maxWidth: 200, maxHeight: 220, background: "repeating-conic-gradient(#666 0 25%, #999 0 50%) 0 0 / 12px 12px", border: "1px solid var(--line-2)" }} /> : <div className="hint" style={{ width: 200 }}>Preview unavailable or checking.</div>}</div>
          {QUALITY_FORMATS.has(format) && <><label>Quality</label><div className="row"><input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} style={{ flex: 1 }} /><span style={{ width: 34 }}>{quality}</span></div></>}
          {(format === "png8" || format === "gif") && <><label>Colours</label><input type="number" min={2} max={256} value={colors} onChange={(e) => setColors(Math.max(2, Math.min(256, Number(e.target.value))))} /></>}
          {format !== "svg" && format !== "psd" && format !== "html" && format !== "pictocity" && <><label>Scale</label><div className="row">{[0.5, 1, 1.5, 2, 3].map((s) => <label key={s} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><input aria-label={`Export at ${s}×`} type="checkbox" checked={scales.includes(s)} onChange={(e) => setScales(e.target.checked ? [...scales, s].sort() : scales.filter((x) => x !== s))} />{s}×</label>)}</div></>}
          {ALPHA_FORMATS.has(format) && <><label>Background</label><label style={{ textAlign: "left" }}><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent (ignore canvas colour)</label></>}
          {!isVideo && format !== "gif" && format !== "svg" && format !== "psd" && format !== "html" && format !== "pictocity" && <><label>Trim</label><label style={{ textAlign: "left" }}><input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} /> Crop to non-transparent pixels</label></>}
          {(format === "pdf" || format === "tiff") && <><label>DPI</label><input type="number" min={36} max={1200} value={dpi} onChange={(e) => setDpi(Number(e.target.value))} /></>}
          <label>Scope</label><select aria-label="Export scope" value={scope} disabled={isVideo || format === "pictocity"} onChange={(e) => setScope(e.target.value as never)}><option value="canvas">Whole canvas</option>{abs.length > 0 && <option value="artboards">Each artboard ({abs.length} files{format === "pdf" ? " → one PDF, one page each" : ""})</option>}{currentAb && <option value="current">Current artboard ({currentAb.name})</option>}{(doc.comps?.length ?? 0) > 0 && <option value="comps">Each layer comp ({doc.comps!.length})</option>}</select>
          <label>Destination</label><div className="seg"><button className={!toServer ? "on" : ""} onClick={() => setToServer(false)}>Download</button><button disabled={format === "pictocity"} className={toServer ? "on" : ""} onClick={() => setToServer(true)}>Save to server exports</button></div>
          {results && usableResults() && <div style={{ gridColumn: "1 / -1" }}>
            {archive && <div role="status" aria-live="polite" style={{ marginBottom: 8 }}><p>{results.length} files ready in one ZIP. Choose Save, then extract the ZIP to open your files.</p><a ref={saveAction} className="btn primary" style={{ display: "inline-block", height: "auto", maxWidth: "100%", padding: "6px 10px", overflowWrap: "anywhere" }} href={archive.url} download={archive.name} onClick={(e) => { if (!usableResults()) e.preventDefault(); }}>Save {archive.name}</a></div>}
            <div className="hint" style={{ maxHeight: 120, overflow: "auto", overflowWrap: "anywhere" }}>{archive ? "Individual files:" : `${results.length} file(s):`} {results.map((r) => <a key={r.url} href={r.url} download={r.name} onClick={(e) => { if (!usableResults()) e.preventDefault(); }} target={toServer ? "_blank" : undefined} rel="noreferrer" style={{ marginRight: 8 }}>{r.name}{r.bytes ? ` (${(r.bytes / 1024).toFixed(0)} KB)` : ""}</a>)}</div>
          </div>}
        </div>
        <footer><span className="hint" style={{ flex: 1 }}>{busy ? progress : scales.length > 1 ? `Files get ${scales.filter((s) => s !== 1).map((s) => `@${s}x`).join(", ")} suffixes.` : ""}</span>{busy && <button className="btn" onClick={() => request.current?.abort()}>Cancel export</button>}<button className="btn" onClick={() => useStore.setState({ modal: null })}>Close</button><button ref={exportAction} className="btn primary" disabled={busy || !scales.length || !preflight?.ok || preflight.docId !== doc.id || preflight.revision !== doc.rev || !preflight.resourceSnapshot?.sha256} onClick={run}>{busy ? "Exporting…" : toServer ? "Export to server" : "Export"}</button></footer>
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
                <DocumentThumbnail {...d} />
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
