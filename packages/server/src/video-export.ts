import { spawn } from "node:child_process";
import { setImmediate as yieldFrame } from "node:timers/promises";

export class ExportValidationError extends Error { readonly status = 400; }

export interface VideoOptions {
  format?: "mp4" | "webm"; fps?: number; scale?: number; audioPath?: string;
  duration?: number; crf?: number; signal?: AbortSignal; timeoutMs?: number;
  ffmpegPath?: string;
  onProgress?: (completed: number, total: number) => void;
  onEncoder?: (pid: number | undefined) => void;
}

/** A bounded export plan, calculated before allocating canvases or starting a process. */
export function videoPlan(doc: { width: number; height: number; animation?: { duration: number; fps: number } }, opts: VideoOptions = {}) {
  const fps = opts.fps ?? doc.animation?.fps ?? 24;
  const scale = opts.scale ?? 1;
  const duration = opts.duration ?? (doc.animation ? doc.animation.duration / 1000 : 5);
  const format = opts.format ?? "mp4";
  const crf = opts.crf ?? (format === "webm" ? 32 : 20);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  if (format !== "mp4" && format !== "webm") throw new ExportValidationError("Video format must be mp4 or webm");
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new ExportValidationError("Video fps must be between 1 and 120");
  if (!Number.isFinite(scale) || scale <= 0) throw new ExportValidationError("Video scale must be positive and finite");
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new ExportValidationError("Video duration must be greater than 0 and at most 600 seconds");
  if (!Number.isFinite(crf) || crf < 0 || crf > (format === "webm" ? 63 : 51)) throw new ExportValidationError("Video CRF is outside the codec's range");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) throw new ExportValidationError("Video timeout must be between 1 and 1800000 milliseconds");
  const rasterWidth = Math.max(1, Math.ceil(doc.width * scale)), rasterHeight = Math.max(1, Math.ceil(doc.height * scale));
  // Pad odd dimensions; never stretch or crop the final row/column to satisfy yuv420p.
  const width = rasterWidth + rasterWidth % 2, height = rasterHeight + rasterHeight % 2;
  const frames = Math.max(1, Math.round(duration * fps));
  if (![width, height].every(Number.isSafeInteger) || width > 16384 || height > 16384 || width * height > 64e6) throw new ExportValidationError("Video raster exceeds the 16384-pixel side or 64-megapixel allocation limit");
  if (frames > 72_000 || frames * width * height > 12e9) throw new ExportValidationError("Video export exceeds the frame/pixel work budget; reduce duration, fps or scale");
  return { width, height, rasterWidth, rasterHeight, frames, fps, duration: frames / fps, format, crf, timeoutMs };
}

/** Consume raw frames with backpressure, bounded errors, cancellation and process cleanup. */
export async function encodeFrames(args: string[], frames: AsyncIterable<Uint8Array>, opts: VideoOptions = {}): Promise<void> {
  if (opts.signal?.aborted) throw new Error("Video export cancelled");
  const child = spawn(opts.ffmpegPath ?? process.env.PICTOCITY_FFMPEG ?? "ffmpeg", args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  opts.onEncoder?.(child.pid);
  const exitCleanup = () => { if (!closed) child.kill(); };
  process.once("exit", exitCleanup);
  let stderr = "", failure: Error | undefined, closed = false, inputEnded = false;
  let stop!: (error: Error) => void;
  // Resolve outcomes instead of rejecting in an event handler: an early exit must never be an unhandled rejection.
  const stopped = new Promise<Error>((resolve) => { stop = (error) => { failure ??= error; resolve(failure); }; });
  const done = new Promise<void>((resolve) => {
    child.once("error", (error) => { stop(new Error(`Cannot start FFmpeg: ${error.message}`)); });
    child.once("close", (code, signal) => { closed = true; if (code !== 0) stop(new Error(`FFmpeg failed (${code ?? signal}): ${stderr.slice(-4000)}`)); else if (!inputEnded) stop(new Error("FFmpeg exited before all frames were written")); resolve(); });
  });
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-65536); });
  child.stdin.on("error", (error) => { stop(new Error(`FFmpeg input failed: ${error.message}`)); });
  const abort = () => { stop(new Error("Video export cancelled")); child.kill(); };
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();
  const timer = setTimeout(() => { stop(new Error("Video export timed out")); child.kill(); }, opts.timeoutMs ?? 120_000);
  const guard = () => { if (failure) throw failure; if (closed) throw new Error("FFmpeg exited before all frames were written"); };
  try {
    for await (const frame of frames) {
      guard();
      // The write callback handles both queued writes and backpressure; error/close also wakes this wait.
      const written = new Promise<Error | undefined>((resolve) => child.stdin.write(frame, (error) => resolve(error ? new Error(`FFmpeg input failed: ${error.message}`) : undefined)));
      const error = await Promise.race([written, stopped]);
      if (error) throw error;
    }
    guard(); inputEnded = true; child.stdin.end();
    const error = await Promise.race([done.then(() => failure), stopped]);
    if (error) throw error;
  } finally {
    clearTimeout(timer); opts.signal?.removeEventListener("abort", abort);
    if (!closed) { child.stdin.destroy(); child.kill(); }
    await done;
    process.removeListener("exit", exitCleanup); opts.onEncoder?.(undefined);
  }
}

export { yieldFrame };
