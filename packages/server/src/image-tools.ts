// Image tools operate on an asset and produce a new asset. Two kinds:
//  - built-in (pure pixel work in Node), e.g. knockout_background
//  - external commands from image-tools.json, e.g. rembg or a Stable Diffusion script:
//      { "remove_background": { "description": "...", "command": "rembg i {in} {out}", "params": { "model": "u2net" } } }
//    {in} and {out} are file paths; every param is available as {name}. The command must write an image to {out}.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export interface ImageToolInfo { name: string; description: string; params: Record<string, unknown>; builtin: boolean }
interface ExternalTool { description?: string; command: string; params?: Record<string, unknown>; timeoutMs?: number }

let external: Record<string, ExternalTool> = {};

export function loadImageTools(file: string): ImageToolInfo[] {
  external = {};
  if (existsSync(file)) {
    try { external = JSON.parse(readFileSync(file, "utf8")); }
    catch (e) { console.warn(`image-tools.json: ${(e as Error).message}`); }
  }
  return listImageTools();
}

export function listImageTools(): ImageToolInfo[] {
  return [
    { name: "knockout_background", description: "Remove a plain or gradient background by flood-filling from the edges (magic wand + delete). Params: tolerance 0-255 (default 28), feather px (default 1).", params: { tolerance: 28, feather: 1 }, builtin: true },
    ...Object.entries(external).map(([name, t]) => ({ name, description: t.description ?? t.command, params: t.params ?? {}, builtin: false })),
  ];
}

/** Run a tool on PNG/JPG bytes and return PNG bytes. */
export async function runImageTool(name: string, input: Buffer, params: Record<string, unknown> = {}): Promise<Buffer> {
  if (name === "knockout_background") return knockoutBackground(input, Number(params.tolerance ?? 28), Number(params.feather ?? 1));
  const tool = external[name];
  if (!tool) throw new Error(`Unknown image tool "${name}". Available: ${listImageTools().map((t) => t.name).join(", ")}`);
  const dir = mkdtempSync(join(tmpdir(), "pictocity-tool-"));
  const inFile = join(dir, "in.png"), outFile = join(dir, "out.png");
  try {
    // Normalise the input to PNG so tools get a predictable format.
    const img = await loadImage(input);
    const c = createCanvas(img.width, img.height); c.getContext("2d").drawImage(img, 0, 0);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(inFile, c.toBuffer("image/png"));
    const all = { ...(tool.params ?? {}), ...params, in: inFile, out: outFile };
    const cmd = tool.command.replace(/\{(\w+)\}/g, (_, k) => (k in all ? shellQuote(String(all[k as keyof typeof all])) : `{${k}}`));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr?.on("data", (d) => (err += d.toString()));
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)); }, tool.timeoutMs ?? 180_000);
      child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}: ${err.slice(-400)}`)); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    if (!existsSync(outFile)) throw new Error(`${name} did not write ${outFile}`);
    const out = await loadImage(outFile);
    const oc = createCanvas(out.width, out.height); oc.getContext("2d").drawImage(out, 0, 0);
    return oc.toBuffer("image/png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shellQuote = (s: string) => (/^[\w./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Flood-fill from every border pixel through similar neighbouring colours (so gradients count as
 * background) and make what was reached transparent. Contiguous only, like the magic wand.
 */
export async function knockoutBackground(input: Buffer, tolerance = 28, feather = 1): Promise<Buffer> {
  const img = await loadImage(input);
  const w = img.width, h = img.height;
  const c = createCanvas(w, h); const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, w, h); const px = id.data;
  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => { if (!bg[i]) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  // Reference colour = mean of the border. Neighbours may drift gradually (gradients), but never
  // far from the reference, so the fill can't creep through an anti-aliased edge into the subject.
  let rr = 0, rg = 0, rb = 0, n = 0;
  for (const i of stack) { rr += px[i * 4]; rg += px[i * 4 + 1]; rb += px[i * 4 + 2]; n++; }
  rr /= n; rg /= n; rb /= n;
  const tol2 = tolerance * tolerance * 3, cap2 = tolerance * tolerance * 3 * 9;
  const similar = (a: number, b: number) => {
    const dr = px[a * 4] - px[b * 4], dg = px[a * 4 + 1] - px[b * 4 + 1], db = px[a * 4 + 2] - px[b * 4 + 2];
    if (dr * dr + dg * dg + db * db > tol2) return false;
    const cr = px[b * 4] - rr, cg = px[b * 4 + 1] - rg, cb = px[b * 4 + 2] - rb;
    return cr * cr + cg * cg + cb * cb <= cap2;
  };
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - x) / w;
    if (x > 0 && !bg[i - 1] && similar(i, i - 1)) push(i - 1);
    if (x < w - 1 && !bg[i + 1] && similar(i, i + 1)) push(i + 1);
    if (y > 0 && !bg[i - w] && similar(i, i - w)) push(i - w);
    if (y < h - 1 && !bg[i + w] && similar(i, i + w)) push(i + w);
  }
  // Alpha = 0 for background, then soften the boundary a little.
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = bg[i] ? 0 : px[i * 4 + 3] / 255;
  let a = alpha;
  for (let pass = 0; pass < Math.max(0, Math.round(feather)); pass++) {
    const next = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { sum += a[yy * w + xx]; n++; } }
      const i = y * w + x;
      next[i] = bg[i] ? Math.min(a[i], sum / n) : a[i] * 0.5 + (sum / n) * 0.5;
    }
    a = next;
  }
  for (let i = 0; i < w * h; i++) px[i * 4 + 3] = Math.round(a[i] * 255);
  ctx.putImageData(id, 0, 0);
  return c.toBuffer("image/png");
}
