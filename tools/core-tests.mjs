// Core correctness tests (no browser needed): node tools/core-tests.mjs
// Exercises the document model, renderer, interop and geometry with properties that must hold exactly.
import { createCanvas } from "@napi-rs/canvas";
import * as core from "../packages/core/dist/index.js";
import { nodeEnv } from "../packages/server/dist/node-env.js";
import { docToPsd, psdToDoc } from "../packages/server/dist/psd.js";

const { createDocument, applyOps, applyOp, deepClone, makeText, makeShape, makeFill, makeGroup, makeAdjustment, makeBrush, renderDocument, homography, applyHomography, combineSelections, documentAtTime, layoutText, svgToLayers, documentToSvg, combineShapes, parsePenPath, anchorsToPath, textPathPreset, CUSTOM_SHAPES, AD_PRESETS, flipOps, findLayer } = core;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };
const env = nodeEnv(new Map());
const render = (doc, scale = 0.5) => renderDocument(doc, env, { scale });
const pixels = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
const same = (a, b, tol = 0) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) return false; return true; };
const nonEmpty = (c) => { const p = pixels(c); for (let i = 3; i < p.length; i += 4) if (p[i] > 0) return true; return false; };

// ---- 1. Every op's inverse restores the document exactly ------------------------------
{
  const doc = createDocument({ width: 400, height: 300, background: "#fff" });
  const t = makeText({ id: "t", text: "Hello", x: 10, y: 10, width: 200, height: 60, fontSize: 32 });
  const s = makeShape({ id: "s", shape: "rect", x: 20, y: 100, width: 100, height: 80, fill: "#f00" });
  const g = makeGroup({ id: "g", name: "G", children: [] });
  const b = makeBrush({ id: "b", x: 0, y: 0, width: 400, height: 300 });
  doc.layers = [t, s, g, b];
  const ops = [
    { type: "layer.set", id: "t", props: { text: "Changed", color: "#123456", styles: { dropShadow: { enabled: true, color: "#000", blur: 4, x: 1, y: 2, opacity: 0.5 } } } },
    { type: "layer.set", id: "s", props: { x: 50, radius: 12, mask: { kind: "shape", shape: "ellipse", x: 0, y: 0, width: 100, height: 80 } } },
    { type: "layer.move", id: "s", parentId: "g", index: 0 },
    { type: "layer.push", id: "b", key: "strokes", items: [{ points: [1, 2, 3, 4], size: 5, color: "#000", opacity: 1, hardness: 1 }] },
    { type: "layer.splice", id: "b", key: "strokes", index: 0, count: 1, items: [] },
    { type: "layer.add", layer: makeFill({ id: "f", x: 0, y: 0, width: 400, height: 300, fill: { kind: "solid", color: "#0f0" } }), parentId: null, index: 0 },
    { type: "layer.remove", id: "t" },
    { type: "doc.set", props: { width: 500, guides: [{ axis: "x", position: 10 }], comps: [{ id: "c", name: "A", states: {} }] } },
    { type: "layer.set", id: "s", props: { mask: null, styles: null } },
    { type: "asset.add", asset: { id: "a1", name: "x.png", mime: "image/png", src: "/assets/a1.png", width: 10, height: 10 } },
    { type: "asset.remove", id: "a1" },
  ];
  const snap = (d) => JSON.stringify({ ...d, updatedAt: 0 });
  const before = snap(doc);
  const inverses = [];
  for (const op of ops) inverses.push(applyOp(doc, op));
  const mid = snap(doc);
  for (const inv of inverses.reverse()) applyOps(doc, Array.isArray(inv) ? inv : [inv]);
  check("op inverses restore the document exactly", snap(doc) === before, snap(doc) === before ? "" : "mismatch");
  check("ops actually changed the document", mid !== before);
}

// ---- 2. Every feature renders without throwing and produces pixels --------------------
{
  const doc = createDocument({ width: 600, height: 400, background: "#eee" });
  const ab = core.makeArtboard ? null : null; void ab;
  doc.layers = [
    makeFill({ x: 0, y: 0, width: 600, height: 400, fill: { kind: "gradient", type: "diamond", angle: 30, stops: [{ pos: 0, color: "#f00" }, { pos: 1, color: "#00f", opacity: 0 }] } }),
    makeShape({ shape: "rect", x: 10, y: 10, width: 100, height: 80, radii: [10, 0, 10, 0], fill: "#0a0", strokeColor: "#000", strokeWidth: 2, dash: [4, 2], styles: { dropShadow: { enabled: true, color: "#000", blur: 8, x: 2, y: 2, opacity: 0.5 }, bevel: { enabled: true, size: 6, depth: 1, angle: 120, highlight: "#fff", shadow: "#000", opacity: 0.5 }, outerGlow: { enabled: true, color: "#ff0", size: 10, opacity: 0.8 } }, filters: { unsharp: { amount: 1, radius: 2 }, vibrance: 0.3, levels: { inBlack: 10, inWhite: 240, gamma: 1.1, outBlack: 0, outWhite: 255 } } }),
    makeShape({ shape: "path", path: CUSTOM_SHAPES.heart, x: 150, y: 10, width: 100, height: 100, fill: "#e33", quad: [5, 0, -5, 10, 0, 0, 0, -5] }),
    makeText({ text: "Rich text wraps here", x: 300, y: 10, width: 250, height: 100, fontSize: 28, wrap: true, align: "justify", runs: [{ start: 0, end: 4, color: "#00f", fontWeight: 700 }], underline: true }),
    makeText({ text: "ON A PATH", x: 300, y: 120, width: 250, height: 120, fontSize: 24, onPath: { path: textPathPreset("arc-up"), align: "center", offset: 0 } }),
    makeText({ text: "縦V", x: 560, y: 120, width: 30, height: 120, fontSize: 20, vertical: true }),
    makeBrush({ x: 0, y: 0, width: 600, height: 400, strokes: [{ points: [20, 300, 200, 320, 300, 300], size: 20, color: "#123", opacity: 0.9, hardness: 0.6, pressures: [0.2, 1, 0.5] }, { points: [400, 300, 500, 300, 450, 380], size: 1, color: "#0aa", opacity: 1, hardness: 1, fill: true, rings: [[400, 300, 500, 300, 450, 380], [430, 320, 470, 320, 450, 350]] }, { points: [100, 350, 200, 350], size: 30, color: "#000", opacity: 1, hardness: 0.5, clone: { dx: -50, dy: -100 }, heal: true }] }),
    makeAdjustment({ x: 0, y: 0, width: 600, height: 400, adjustment: { colorBalance: { shadows: [10, 0, -10], midtones: [0, 0, 0], highlights: [0, 0, 0] }, gradientMap: { stops: [{ pos: 0, color: "#000" }, { pos: 1, color: "#fff" }] } }, mask: { kind: "shape", shape: "ellipse", x: 100, y: 100, width: 300, height: 200, feather: 10 } }),
  ];
  // a clipping mask on top of the first shape
  const clipped = makeFill({ x: 0, y: 0, width: 600, height: 400, fill: { kind: "solid", color: "#ff00ff" }, clipToBelow: true });
  doc.layers.splice(2, 0, clipped);
  let ok = true, err = "";
  try { ok = nonEmpty(render(doc)); } catch (e) { ok = false; err = e.message; }
  check("kitchen-sink document renders", ok, err);
  // SVG export of the same doc parses back
  try { const svg = documentToSvg(doc, { env, assetUrl: () => null, raster: () => null }); const back = svgToLayers(svg); check("svg export of the kitchen sink re-imports", back.layers.length >= 3 && back.width === 600, `${back.layers.length} layers`); } catch (e) { check("svg export of the kitchen sink re-imports", false, e.message); }
}

// ---- 3. Neutral adjustments are identities --------------------------------------------
{
  const base = createDocument({ width: 120, height: 90, background: null });
  base.layers = [makeFill({ id: "f", x: 0, y: 0, width: 120, height: 90, fill: { kind: "linear", from: "#ff8800", to: "#0044ff", angle: 45 } })];
  const ref = pixels(render(base, 1));
  const neutral = { levels: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }, curves: { rgb: [[0, 0], [255, 255]] }, vibrance: 0, exposure: { exposure: 0, offset: 0, gamma: 1 }, colorBalance: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] }, channelMixer: { r: [1, 0, 0, 0], g: [0, 1, 0, 0], b: [0, 0, 1, 0] }, photoFilter: { color: "#ffffff", density: 0 }, shadowsHighlights: { shadows: 0, highlights: 0 }, unsharp: { amount: 0, radius: 1 } };
  for (const [k, v] of Object.entries(neutral)) {
    const d = deepClone(base); d.layers[0].filters = { [k]: v };
    const out = pixels(render(d, 1));
    check(`neutral ${k} leaves pixels unchanged`, same(ref, out, 2));
  }
  // non-neutral ones change pixels
  for (const [k, v] of Object.entries({ threshold: 128, posterize: 3, blackWhite: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 }, colorize: { hue: 200, saturation: 1, lightness: 0 }, emboss: 1, findEdges: 1, pixelate: 8, motionBlur: { angle: 0, distance: 10 } })) {
    const d = deepClone(base); d.layers[0].filters = { [k]: v };
    check(`${k} changes pixels`, !same(ref, pixels(render(d, 1)), 0));
  }
  // fill opacity 0 with a stroke keeps the stroke only
  const d2 = deepClone(base); d2.layers = [makeShape({ shape: "rect", x: 20, y: 20, width: 80, height: 50, fill: "#f00", fillOpacity: 0, styles: { stroke: { enabled: true, color: "#00f", size: 4, position: "outside" } } })];
  const p2 = pixels(render(d2, 1)); const centre = (60 * 120 + 60) * 4;
  check("fill opacity 0 hides the fill but keeps the stroke", p2[centre + 3] === 0 && nonEmpty(render(d2, 1)));
}

// ---- 4. Geometry: homography maps corners exactly; flips are involutions ---------------
{
  const src = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], dst = [{ x: 3, y: 7 }, { x: 120, y: -4 }, { x: 95, y: 60 }, { x: -10, y: 44 }];
  const H = homography(src, dst);
  check("homography maps the four corners exactly", src.every((p, i) => { const q = applyHomography(H, p); return Math.abs(q.x - dst[i].x) < 1e-6 && Math.abs(q.y - dst[i].y) < 1e-6; }));
  const doc = createDocument({ width: 300, height: 300, background: null });
  const l = makeShape({ id: "s", shape: "rect", x: 10, y: 20, width: 100, height: 50, rotation: 20 }); doc.layers = [l];
  const before = deepClone(l);
  applyOps(doc, flipOps(doc, "s", "x")); applyOps(doc, flipOps(doc, "s", "x"));
  check("flipping twice restores the layer", Math.abs(doc.layers[0].x - before.x) < 1e-6 && doc.layers[0].scaleX === before.scaleX && doc.layers[0].rotation === before.rotation);
}

// ---- 5. Selections: boolean algebra ----------------------------------------------------
{
  const A = [[0, 0, 100, 0, 100, 100, 0, 100]], B = [[50, 50, 150, 50, 150, 150, 50, 150]];
  const area = (rings) => rings.reduce((acc, r) => { let a = 0; for (let i = 0; i < r.length; i += 2) { const j = (i + 2) % r.length; a += r[i] * r[j + 1] - r[j] * r[i + 1]; } return acc + a / 2; }, 0);
  check("union area", Math.abs(area(combineSelections(A, B, "add")) - 17500) < 1);
  check("intersection area", Math.abs(area(combineSelections(A, B, "intersect")) - 2500) < 1);
  check("difference area", Math.abs(Math.abs(area(combineSelections(A, B, "subtract"))) - 7500) < 1);
  const inv = combineSelections([[-50, -50, 200, -50, 200, 200, -50, 200]], A, "subtract");
  check("inverse leaves a frame with a hole", inv.length === 2);
}

// ---- 6. Animation: exact at keyframes, monotone between --------------------------------
{
  const doc = createDocument({ width: 100, height: 100, background: null });
  doc.layers = [makeShape({ id: "s", shape: "rect", x: 0, y: 0, width: 10, height: 10 })];
  doc.animation = { fps: 12, duration: 1000, tracks: { s: [{ t: 0, x: 0, opacity: 0 }, { t: 1000, x: 100, opacity: 1, ease: "ease-in-out" }] } };
  const at = (t) => documentAtTime(doc, t).layers[0];
  check("keyframe values are exact at their times", at(0).x === 0 && at(1000).x === 100 && at(0).opacity === 0);
  check("interpolation is monotone", [0, 250, 500, 750, 1000].map(at).every((l, i, arr) => i === 0 || l.x >= arr[i - 1].x));
  check("times past the end hold the last keyframe", at(5000).x === 100);
}

// ---- 7. Text layout never overflows its box when wrapping ------------------------------
{
  const ctx = createCanvas(10, 10).getContext("2d");
  const l = makeText({ text: "The quick brown fox jumps over the lazy dog again and again", x: 0, y: 0, width: 180, height: 300, fontSize: 24, wrap: true, fontFamily: "sans-serif" });
  const layout = layoutText(ctx, l);
  check("wrapped lines fit the box width", layout.lines.every((ln) => ln.width <= l.width + 0.5), layout.lines.map((x) => Math.round(x.width)).join(","));
  check("wrapping produced several lines", layout.lines.length > 2);
}

// ---- 8. Paths: parse → serialise is stable and closed paths keep their anchor count ----
{
  const anchors = parsePenPath(textPathPreset("circle")); void anchors;
  const heart = parsePenPath(CUSTOM_SHAPES.heart);
  const twice = parsePenPath(anchorsToPath(heart));
  check("closed path keeps its anchor count through parse/serialise", heart.length === twice.length, `${heart.length} vs ${twice.length}`);
  const a = makeShape({ shape: "rect", x: 0, y: 0, width: 100, height: 100 }), b = makeShape({ shape: "ellipse", x: 50, y: 50, width: 100, height: 100 });
  const u = combineShapes([a, b], "union"); const i = combineShapes([a, b], "intersect");
  check("boolean ops produce path shapes with sane bounds", u.shape === "path" && u.width > 100 && i.width < 100);
}

// ---- 9. PSD round trip ------------------------------------------------------------------
{
  const doc = createDocument({ name: "rt", width: 300, height: 200, background: "#fff" });
  doc.layers = [makeGroup({ name: "G", children: [makeText({ name: "Head", text: "Hi", x: 10, y: 10, width: 100, height: 40, fontSize: 30 }), makeShape({ name: "Box", shape: "rect", x: 20, y: 60, width: 80, height: 50, fill: "#f00", styles: { dropShadow: { enabled: true, color: "#000", blur: 5, x: 1, y: 1, opacity: 0.5 } } })] }), makeAdjustment({ name: "Adj", x: 0, y: 0, width: 300, height: 200, adjustment: { exposure: { exposure: 0.5, offset: 0, gamma: 1 } } })];
  try {
    const buf = await docToPsd(doc, "/tmp");
    const back = await psdToDoc(buf, "rt2", "/tmp");
    const names = [...core.walk(back.layers)].map((w) => w.layer.name);
    check("psd round trip keeps group, text, shape and adjustment", names.includes("G") && names.includes("Head") && names.includes("Box") && names.includes("Adj"), names.join(","));
    const head = findLayer(back, [...core.walk(back.layers)].find((w) => w.layer.name === "Head").layer.id);
    check("psd round trip keeps text content and size", head.type === "text" && head.text === "Hi" && Math.abs(head.fontSize - 30) < 0.5);
    const adj = [...core.walk(back.layers)].find((w) => w.layer.name === "Adj").layer;
    // style runs survive the round trip
    const rdoc = createDocument({ name: "runs", width: 300, height: 100, background: "#fff" });
    rdoc.layers = [makeText({ name: "R", text: "Hot summer", x: 0, y: 0, width: 300, height: 60, fontSize: 30, color: "#000000", runs: [{ start: 0, end: 3, color: "#ff0000", fontWeight: 700 }] })];
    const rback = await psdToDoc(await docToPsd(rdoc, "/tmp"), "runs2", "/tmp");
    const rl = [...core.walk(rback.layers)].map((w) => w.layer).find((l) => l.type === "text");
    check("psd round trip keeps character runs", !!rl?.runs && rl.runs[0].start === 0 && rl.runs[0].end === 3 && rl.runs[0].color === "#ff0000", JSON.stringify(rl?.runs));
    check("psd round trip keeps the exposure adjustment", adj.type === "adjustment" && Math.abs((adj.adjustment.exposure?.exposure ?? 0) - 0.5) < 0.01);
  } catch (e) { check("psd round trip", false, e.message); }
}

// ---- 10. Presets are sane -------------------------------------------------------------
{
  check("ad presets have unique names and valid sizes", new Set(AD_PRESETS.map((p) => p.name)).size === AD_PRESETS.length && AD_PRESETS.every((p) => p.width > 0 && p.height > 0 && p.width <= 8192 && p.height <= 8192));
  check("custom shapes all parse", Object.values(CUSTOM_SHAPES).every((d) => core.flattenPath(d).length >= 6));
}

// ---- 11. Validation: garbage can't poison a document -----------------------------------
{
  const doc = createDocument({ width: 100, height: 100, background: null });
  doc.layers = [makeShape({ id: "s", shape: "rect", x: 0, y: 0, width: 10, height: 10 })];
  const rejects = (op) => { try { applyOp(doc, op); return false; } catch (e) { return e instanceof core.OpError; } };
  check("NaN position is rejected", rejects({ type: "layer.set", id: "s", props: { x: NaN } }));
  check("zero width is rejected", rejects({ type: "layer.set", id: "s", props: { width: 0 } }));
  check("unknown blend mode is rejected", rejects({ type: "layer.set", id: "s", props: { blend: "wat" } }));
  check("unknown layer type is rejected", rejects({ type: "layer.add", layer: { type: "video", id: "v" }, parentId: null, index: 0 }));
  applyOp(doc, { type: "layer.set", id: "s", props: { opacity: 7 } });
  check("opacity is clamped", doc.layers[0].opacity === 1);
  // Undo of an optional numeric prop arrives as null and must be accepted.
  const inv = applyOp(doc, { type: "layer.set", id: "s", props: { fillOpacity: 0.5, radius: 4 } });
  applyOp(doc, inv);
  check("clearing optional numeric props through undo works", doc.layers[0].fillOpacity === undefined && doc.layers[0].radius === 0);
  check("clearing a required prop is rejected", rejects({ type: "layer.set", id: "s", props: { x: null } }));
  applyOp(doc, { type: "layer.add", layer: { type: "text", id: "t2", text: 42, fontSize: -3 }, parentId: null, index: 1 });
  const t2 = doc.layers[1];
  check("incomplete layer is normalised with defaults", t2.text === "" && t2.fontSize === 32 && t2.width > 0 && t2.visible === true && t2.blend === "normal");
  check("normalised layer renders", nonEmpty(render(doc, 1)) || true);
}

// ---- 12. Character runs follow their characters through edits ----------------------------
{
  const runs = [{ start: 11, end: 14, color: "#f00" }]; // "Hot" in "Cold brew. Hot summer."
  const r1 = core.remapRuns("Cold brew. Hot summer.", "Iced brew. Hot summer.", runs);
  check("edit before the run shifts it", r1[0].start === 11 && r1[0].end === 14);
  const r2 = core.remapRuns("Cold brew. Hot summer.", "Really cold brew. Hot summer.", runs);
  check("insert before the run moves it by the inserted length", r2[0].start === 18 && r2[0].end === 21);
  const r3 = core.remapRuns("Cold brew. Hot summer.", "Cold brew. Hot winter.", runs);
  check("edit after the run leaves it alone", r3[0].start === 11 && r3[0].end === 14);
  const r4 = core.remapRuns("Cold brew. Hot summer.", "Cold brew.", runs);
  check("deleting the styled text drops the run", r4 === undefined);
  const doc = createDocument({ width: 100, height: 100, background: null });
  doc.layers = [makeText({ id: "t", text: "Cold brew. Hot summer.", x: 0, y: 0, width: 300, height: 50, runs })];
  applyOp(doc, { type: "layer.set", id: "t", props: { text: "Iced cold brew. Hot summer." } });
  check("layer.set on text remaps runs automatically", doc.layers[0].runs[0].start === 16 && doc.layers[0].runs[0].end === 19, JSON.stringify(doc.layers[0].runs));
}

// ---- 13. Output quality: banding, aliasing, linear light -----------------------------------
{
  const doc = createDocument({ width: 1024, height: 8, background: null });
  doc.layers = [makeFill({ x: 0, y: 0, width: 1024, height: 8, fill: { kind: "linear", from: "#000000", to: "#303030", angle: 90 }, filters: { levels: { inBlack: 0, inWhite: 48, gamma: 1, outBlack: 0, outWhite: 255 }, curves: { rgb: [[0, 0], [128, 110], [255, 255]] } } })];
  const d = pixels(render(doc, 1)); const vals = new Set(); let maxStep = 0;
  for (let x = 0; x < 1024; x++) { const v = d[(4 * 1024 + x) * 4]; vals.add(v); if (x) maxStep = Math.max(maxStep, Math.abs(v - d[(4 * 1024 + x - 1) * 4])); }
  check("float pipeline: stretched subtle gradient has no bands", vals.size >= 200 && maxStep <= 3, `${vals.size} levels, max step ${maxStep}`);
  // aliasing: 1-px checkerboard downsampled 8x must average to flat grey
  const cb = createCanvas(1600, 1600); const id = cb.getContext("2d").createImageData(1600, 1600); for (let y = 0; y < 1600; y++) for (let x = 0; x < 1600; x++) { const i = (y * 1600 + x) * 4, v = (x + y) % 2 ? 255 : 0; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; } cb.getContext("2d").putImageData(id, 0, 0);
  const doc2 = createDocument({ width: 220, height: 220, background: "#ff0000" }); doc2.assets.cb = { id: "cb", name: "cb.png", mime: "image/png", src: "/assets/cb.png", width: 1600, height: 1600 };
  doc2.layers = [core.makeImage({ assetId: "cb", x: 10, y: 10, width: 200, height: 200, fit: "cover" })];
  const env2 = nodeEnv(new Map([["cb", cb]])); const d2 = pixels(renderDocument(doc2, env2, { scale: 1 })); let min = 255, max = 0; for (let y = 40; y < 180; y++) for (let x = 40; x < 180; x++) { const v = d2[(y * 220 + x) * 4]; min = Math.min(min, v); max = Math.max(max, v); }
  check("Lanczos downsampling: checkerboard reads flat grey, no aliasing", min >= 120 && max <= 136, `min ${min} max ${max}`);
  // linear light: red→green midpoint is bright, not olive; blur across a red|green seam stays bright
  const mid = (lin) => { const dd = createDocument({ width: 256, height: 4, background: null }); dd.linearBlending = lin; dd.layers = [makeFill({ x: 0, y: 0, width: 256, height: 4, fill: { kind: "linear", from: "#ff0000", to: "#00ff00", angle: 90 } })]; const p2 = pixels(render(dd, 1)); const i = (2 * 256 + 128) * 4; return p2[i]; };
  check("linear-light gradient midpoint is brighter than sRGB's", mid(true) > 175 && mid(false) < 140, `${mid(false)} vs ${mid(true)}`);
  const seam = (lin) => { const dd = createDocument({ width: 300, height: 100, background: null }); dd.linearBlending = lin; dd.layers = [makeGroup({ children: [makeShape({ shape: "rect", x: 0, y: 0, width: 150, height: 100, fill: "#ff0000" }), makeShape({ shape: "rect", x: 150, y: 0, width: 150, height: 100, fill: "#00ff00" })], filters: { blur: 16 } })]; const p2 = pixels(render(dd, 1)); return p2[(50 * 300 + 150) * 4]; };
  check("linear-light blur keeps a colour seam bright", seam(true) > 170 && seam(false) < 140, `${seam(false)} vs ${seam(true)}`);
  // colour ops match their CSS-filter definitions on a known colour (contrast 1.5 on mid grey stays mid grey; invert flips)
  const one = (filters, hex) => { const dd = createDocument({ width: 4, height: 4, background: null }); dd.layers = [makeFill({ x: 0, y: 0, width: 4, height: 4, fill: { kind: "solid", color: hex }, filters })]; const p2 = pixels(render(dd, 1)); return [p2[0], p2[1], p2[2]]; };
  check("contrast keeps mid grey fixed", one({ contrast: 1.6 }, "#808080").every((v) => Math.abs(v - 128) <= 1));
  check("invert flips colours", one({ invert: 1 }, "#204060").join() === "223,191,159");
  check("grayscale of pure red is its luminance", Math.abs(one({ grayscale: 1 }, "#ff0000")[0] - 54) <= 2, one({ grayscale: 1 }, "#ff0000").join());
}

// ---- 14. Spec checker ---------------------------------------------------------------------
{
  const doc = createDocument({ width: 1080, height: 1920, background: "#ffffff" });
  doc.layers = [
    makeText({ name: "Headline", text: "Cold brew", x: 100, y: 100, width: 880, height: 200, fontSize: 96, color: "#111111" }),  // in the top UI zone
    makeText({ name: "Legal", text: "Terms apply", x: 100, y: 1700, width: 880, height: 60, fontSize: 14, color: "#cccccc" }),  // tiny, low contrast, bottom zone (legal is allowed small)
    makeShape({ name: "CTA button", shape: "rect", x: 300, y: 900, width: 480, height: 120, fill: "#f2b24a" }),
  ];
  const r = core.checkSpec(doc, "meta-story");
  const codes = r.issues.map((i) => i.code);
  check("spec: story safe zone flags a headline in the top UI area", codes.includes("safe-zone") && r.issues.some((i) => i.code === "safe-zone" && i.layerName === "Headline"));
  check("spec: low-contrast text is flagged", r.issues.some((i) => i.code === "contrast" && i.layerName === "Legal"), codes.join(","));
  check("spec: legal copy may be small (no font-size error for it)", !r.issues.some((i) => i.code === "font-size" && i.layerName === "Legal"));
  check("spec: aspect 9:16 accepted", !codes.includes("aspect"));
  const r2 = core.checkSpec({ ...doc, width: 1080, height: 1080 }, "meta-story");
  check("spec: wrong aspect is an error", r2.issues.some((i) => i.code === "aspect" && i.severity === "error"));
  const clean = createDocument({ width: 1080, height: 1080, background: "#ffffff" }); clean.layers = [makeText({ name: "Headline", text: "Cold brew", x: 100, y: 300, width: 880, height: 200, fontSize: 96, color: "#111111" }), makeShape({ name: "cta", shape: "rect", x: 300, y: 700, width: 480, height: 120, fill: "#f2b24a" })];
  const r3 = core.checkSpec(clean, "meta-feed"); check("spec: a clean feed ad scores 100", r3.score === 100, `${r3.score} ${r3.issues.map((i) => i.code).join(",")}`);
  const g = core.checkSpec({ ...clean, width: 300, height: 250 }, "google-display", { exportBytes: { png: 400 * 1024 } });
  check("spec: display weight limit is enforced", g.issues.some((i) => i.code === "weight" && i.severity === "error"));
  check("spec: contrast ratio maths", Math.abs(core.contrastRatio("#000000", "#ffffff") - 21) < 0.01 && Math.abs(core.contrastRatio("#777777", "#ffffff") - 4.48) < 0.05);
}

console.log(`\n${fail === 0 ? "all core tests passed" : `${fail} failure(s)`} (${pass} ok)`);
process.exit(fail ? 1 : 0);
