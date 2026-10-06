import { inspectResources, assetFile } from "./assets.js";
import { registerFonts, renderToBuffer, renderGif, renderVideo, renderHtmlBanner, loadAssets, nodeEnv } from "./node-env.js";
import { docToPsd } from "./psd.js";
import { documentToSvg, rasterizeLayerForSvg, type AdDocument } from "@pictocity/core";
import { readFileSync } from "node:fs";
import type { Canvas } from "@napi-rs/canvas";
import type { SnapshotReport } from "./resource-snapshot.js";

const controller = new AbortController();
let started = false;
const send = (value: unknown) => { if (process.connected) process.send?.(value); };
process.once("disconnect", () => controller.abort());
process.on("message", async (raw) => {
  const message = raw as { cancel?: boolean; kind: string; doc: AdDocument; assetsDir: string; fontsDir: string; options: Record<string, unknown>; snapshotReport?: SnapshotReport };
  if (message.cancel) { controller.abort(); return; }
  if (started) return; started = true;
  const { doc, assetsDir, kind, options } = message;
  try {
    registerFonts(message.fontsDir); send({ phase: "checking" });
    let value: unknown;
    if (kind === "preflight") value = { ...(await inspectResources(doc, assetsDir)).report, resourceSnapshot: message.snapshotReport };
    else {
      send({ phase: "rendering" });
      if (controller.signal.aborted) throw new Error("Export cancelled");
      if (kind === "raster") value = await renderToBuffer(doc, assetsDir, options);
      else if (kind === "video") value = await renderVideo(doc, assetsDir, { ...options, signal: controller.signal,
        onProgress: (completed, total) => send({ phase: completed === total ? "encoding" : "rendering", completed, total }),
        onEncoder: (pid) => send({ encoder: pid ?? null }) });
      else if (kind === "gif") value = await renderGif(doc, assetsDir, { ...options, signal: controller.signal });
      else if (kind === "html") value = await renderHtmlBanner(doc, assetsDir);
      else if (kind === "psd") value = await docToPsd(doc, assetsDir);
      else if (kind === "svg") {
        const images = await loadAssets(doc, assetsDir), env = nodeEnv(images);
        value = documentToSvg(doc, { env, assetUrl: (id) => { const asset = doc.assets[id]; return asset ? `data:${asset.mime};base64,${readFileSync(assetFile(assetsDir, asset.src)).toString("base64")}` : null; }, raster: (layer) => rasterizeLayerForSvg(doc, layer, env, (c) => `data:image/png;base64,${(c as unknown as Canvas).toBuffer("image/png").toString("base64")}`) });
      } else throw new Error("Unknown render task");
    }
    if (controller.signal.aborted) throw new Error("Export cancelled");
    if ((Buffer.isBuffer(value) && value.length > 256 * 1024 * 1024) || (typeof value === "string" && Buffer.byteLength(value) > 256 * 1024 * 1024)) throw Object.assign(new Error("Encoded export exceeds the 256 MiB publication budget. Reduce scale, duration or quality."), { status: 413 });
    if (process.connected) await new Promise<void>((resolve) => process.send?.({ done: true, value }, () => resolve()));
  } catch (error) {
    const e = error as Error & { status?: number; report?: unknown };
    await new Promise<void>((resolve) => { if (process.connected) process.send?.({ done: true, error: { message: e.message, status: e.status, report: e.report } }, () => resolve()); else resolve(); });
  } finally { if (process.connected) process.disconnect(); }
});
