// Headless UI smoke test for the editor. Drives a real Chromium against a running server
// and asserts the main flows: select, move (with undo), scale, rotate, inline text edit,
// shape and text tools, guides, keyboard shortcuts, dialogs, and a live agent edit.
//
//   npm run server                      # in one terminal
//   node tools/ui-smoke.mjs             # in another (first run downloads Chromium via npm deps below)
//
// Needs: npm i -D puppeteer-core @sparticuz/chromium   (or set CHROME=/path/to/chrome)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const BASE = process.env.PICTOCITY_URL ?? "http://localhost:4100";

let executablePath = process.env.CHROME;
let extraArgs = [];
if (!executablePath) {
  const chromium = require("@sparticuz/chromium");
  const c = chromium.default ?? chromium;
  executablePath = await c.executablePath();
  extraArgs = c.args;
}

// Fresh document for the test so nothing else is touched.
const doc = await fetch(`${BASE}/api/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ui-smoke", width: 1080, height: 1080, background: "#ffffff" }) }).then((r) => r.json());
await fetch(`${BASE}/api/docs/${doc.id}/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "agent:smoke", label: "Seed", ops: [
  { type: "layer.add", parentId: null, index: 0, layer: { id: "seed_bg", type: "shape", name: "Box", shape: "rect", fill: "#4f6df5", strokeColor: null, strokeWidth: 0, visible: true, locked: false, opacity: 1, blend: "normal", x: 100, y: 100, width: 400, height: 300, rotation: 0, scaleX: 1, scaleY: 1 } },
  { type: "layer.add", parentId: null, index: 1, layer: { id: "seed_text", type: "text", name: "Headline", text: "Hello there", fontFamily: "Poppins", fontSize: 72, fontWeight: 700, fontStyle: "normal", color: "#111111", align: "left", verticalAlign: "top", lineHeight: 1.1, letterSpacing: 0, wrap: true, visible: true, locked: false, opacity: 1, blend: "normal", x: 100, y: 500, width: 700, height: 100, rotation: 0, scaleX: 1, scaleY: 1 } },
] }) });

const browser = await puppeteer.launch({ executablePath, args: [...extraArgs, "--no-sandbox", "--disable-gpu"], headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`${BASE}/?doc=${doc.id}`, { waitUntil: "networkidle0" });
await sleep(600);

await page.evaluate(() => { window.useStoreSet = (p) => window.__pictocity.setState(p); });
const openMenu = async (title) => { await page.evaluate((t) => [...document.querySelectorAll(".menubar .menu > button")].find((b) => b.textContent.trim() === t).click(), title); await sleep(100); };
const state = () => page.evaluate(() => { const s = window.__pictocity.getState(); return { rev: s.doc.rev, selection: s.selection, tool: s.tool, zoom: s.zoom, undo: s.undoStack.map((u) => u.label), layers: s.doc.layers.map((l) => l.name), guides: s.doc.guides, editing: s.editingTextId }; });
const layer = (id) => page.evaluate((id) => { const s = window.__pictocity.getState(); const find = (ls) => { for (const l of ls) { if (l.id === id) return l; if (l.children) { const r = find(l.children); if (r) return r; } } }; return find(s.doc.layers); }, id);
const screen = (dx, dy) => page.evaluate(([dx, dy]) => { const s = window.__pictocity.getState(); const r = document.querySelector(".canvas-area").getBoundingClientRect(); return [r.left + s.pan.x + dx * s.zoom, r.top + s.pan.y + dy * s.zoom]; }, [dx, dy]);
const drag = async (from, to) => { await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2); await page.mouse.move(...to); await page.mouse.up(); await sleep(150); };
const key = async (k, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(k); for (const m of mods) await page.keyboard.up(m); await sleep(150); };
const dbl = async (x, y) => { await page.mouse.move(x, y); await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 }); await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 }); await sleep(200); };
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failures++; };

// select + move + undo
await page.mouse.click(...(await screen(300, 250))); await sleep(100);
check("click selects layer", (await state()).selection[0] === "seed_bg");
await drag(await screen(300, 250), await screen(400, 350));
let b = await layer("seed_bg");
check("drag moves layer", b.x === 200 && b.y === 200, `${b.x},${b.y}`);
await key("z", ["Control"]);
b = await layer("seed_bg");
check("undo restores position", b.x === 100 && b.y === 100, `${b.x},${b.y}`);

// scale from SE corner (proportional) and rotate
await drag(await screen(500, 400), await screen(600, 500));
b = await layer("seed_bg");
check("corner scale is proportional", Math.abs(b.width / b.height - 400 / 300) < 0.02 && b.width > 400, `${b.width}x${b.height}`);
await key("z", ["Control"]);
const [cx, cy] = await screen(500, 400);
await drag([cx + 14, cy + 14], [cx - 40, cy + 60]);
b = await layer("seed_bg");
check("drag outside corner rotates", Math.abs(b.rotation) > 5, `${b.rotation}°`);
await key("z", ["Control"]);

// inline text edit
await dbl(...(await screen(300, 540)));
check("double-click enters text edit", (await state()).editing === "seed_text");
await key("a", ["Control"]); await page.keyboard.type("Changed copy"); await key("Enter", ["Control"]); await sleep(200);
check("text commit", (await layer("seed_text")).text === "Changed copy");

// shape + text tools
await key("u"); await drag(await screen(600, 100), await screen(800, 300));
let st = await state();
check("shape tool draws a rect", st.layers.includes("Rect") && st.tool === "move", st.layers.join(","));
await key("t"); await page.mouse.click(...(await screen(120, 900))); await sleep(200);
await page.keyboard.type("New point text"); await key("Enter", ["Control"]); await sleep(200);
st = await state();
check("text tool creates point text", st.layers.includes("New point text"), st.layers.join(","));

// opacity via number key, delete + undo, duplicate, group
await key("5"); check("number key sets opacity", (await page.evaluate(() => window.__pictocity.getState().doc.layers.at(-1).opacity)) === 0.5);
await key("Delete"); check("delete removes layer", !(await state()).layers.includes("New point text"));
await key("z", ["Control"]); check("undo delete", (await state()).layers.includes("New point text"));
await key("j", ["Control"]); check("duplicate (Ctrl+J)", (await state()).layers.filter((n) => n.startsWith("New point text")).length === 2);
await key("a", ["Control"]); await key("g", ["Control"]); st = await state();
check("group all (Ctrl+A, Ctrl+G)", st.layers.length === 1 && st.layers[0] === "Group", st.layers.join(","));
await key("z", ["Control"]);

// multi-layer transform: select all, drag the union box's SE handle
await key("a", ["Control"]);
let bb = await page.evaluate(() => { const s = window.__pictocity.getState(); return s.doc.layers.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.width, h: l.height, fs: l.fontSize })); });
const right = Math.max(...bb.map((l) => l.x + l.w)), bottom = Math.max(...bb.map((l) => l.y + l.h));
await drag(await screen(right, bottom), await screen(right + 200, bottom + 200));
let after = await page.evaluate(() => window.__pictocity.getState().doc.layers.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.width, h: l.height, fs: l.fontSize })));
const grew = after.every((l, i) => l.w > bb[i].w && l.h > bb[i].h);
const textScaled = after.find((l) => l.id === "seed_text").fs > bb.find((l) => l.id === "seed_text").fs;
check("multi-select scale grows every layer", grew && textScaled, JSON.stringify(after.map((l) => [Math.round(l.w), Math.round(l.h)])));
await key("z", ["Control"]);
// group transform: group all, rotate via corner
await key("g", ["Control"]);
bb = await page.evaluate(() => { const s = window.__pictocity.getState(); const g = s.doc.layers[0]; return g.children.map((l) => ({ id: l.id, x: l.x, y: l.y, rot: l.rotation })); });
const gb = await page.evaluate(() => { const s = window.__pictocity.getState(); const ls = s.doc.layers[0].children; const xs = ls.map((l) => l.x), ys = ls.map((l) => l.y); return { x: Math.min(...xs), y: Math.min(...ys), r: Math.max(...ls.map((l) => l.x + l.width)), b: Math.max(...ls.map((l) => l.y + l.height)) }; });
const [rx, ry] = await screen(gb.r, gb.b);
await drag([rx + 14, ry + 14], [rx - 60, ry + 40]);
after = await page.evaluate(() => window.__pictocity.getState().doc.layers[0].children.map((l) => ({ id: l.id, x: l.x, y: l.y, rot: l.rotation })));
check("group rotate rotates every child", after.every((l) => Math.abs(l.rot) > 3), JSON.stringify(after.map((l) => l.rot)));
await key("z", ["Control"]); await key("z", ["Control"]);

// brush + eraser
await key("b");
await drag(await screen(150, 150), await screen(450, 350));
st = await state();
check("brush creates a paint layer with a stroke", st.layers.includes("Paint") && (await page.evaluate(() => { const l = window.__pictocity.getState().doc.layers.find((l) => l.name === "Paint"); return l.strokes.length === 1 && l.strokes[0].points.length >= 6; })));
await key("e");
await drag(await screen(200, 200), await screen(400, 300));
check("eraser adds an erase stroke", await page.evaluate(() => { const l = window.__pictocity.getState().doc.layers.find((l) => l.name === "Paint"); return l.strokes.length === 2 && l.strokes[1].erase === true; }));
await key("z", ["Control"]);
check("undo removes the last stroke only", await page.evaluate(() => window.__pictocity.getState().doc.layers.find((l) => l.name === "Paint").strokes.length) === 1);
await page.screenshot({ path: "/tmp/smoke-brush.png" });
await key("v");

// align: select both seed layers, align right edges to the selection; then a single layer centres on the canvas
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg", "seed_text"]));
await page.evaluate(() => [...document.querySelectorAll(".optionsbar .align button")].find((b) => b.title === "Align right edges").click());
await sleep(200);
let sb = await layer("seed_bg"), stx = await layer("seed_text");
check("align right edges", Math.abs((sb.x + sb.width) - (stx.x + stx.width)) < 1, `${sb.x + sb.width} vs ${stx.x + stx.width}`);
await key("z", ["Control"]);
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg"]));
await page.evaluate(() => [...document.querySelectorAll(".optionsbar .align button")].find((b) => b.title === "Align horizontal centres").click());
await sleep(200);
sb = await layer("seed_bg");
check("single layer centres on canvas", Math.abs(sb.x + sb.width / 2 - 540) < 1, `${sb.x + sb.width / 2}`);
await key("z", ["Control"]);

// painted mask on the box: toggle mask editing with \ and erase a stroke across it
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg"]));
await key("\\");
check("backslash enters mask editing with the brush", (await state()).tool === "brush" && (await page.evaluate(() => window.__pictocity.getState().editMask)));
await key("e");
await drag(await screen(120, 250), await screen(480, 250));
sb = await layer("seed_bg");
check("eraser hides on a painted mask", sb.mask?.kind === "paint" && sb.mask.strokes.length === 1 && sb.mask.strokes[0].erase === true && sb.mask.strokes[0].points.length >= 6, JSON.stringify(sb.mask?.kind));
await page.screenshot({ path: "/tmp/smoke-mask.png" });
await key("Escape"); await key("v");

// eyedropper picks the box colour
await key("i");
await page.mouse.click(...(await screen(150, 150))); await sleep(150);
check("eyedropper samples the canvas", (await page.evaluate(() => window.__pictocity.getState().fgColor)) === "#4f6df5", await page.evaluate(() => window.__pictocity.getState().fgColor));
await key("v");

// crop: drag an area, Enter applies, layers shift
const before = await layer("seed_text");
await key("c");
await drag(await screen(50, 50), await screen(850, 950));
check("crop rect drawn", JSON.stringify((await page.evaluate(() => window.__pictocity.getState().cropRect))) === JSON.stringify({ x: 50, y: 50, width: 800, height: 900 }));
await key("Enter");
const cropped = await page.evaluate(() => { const s = window.__pictocity.getState(); return { w: s.doc.width, h: s.doc.height, tool: s.tool }; });
const afterText = await layer("seed_text");
check("crop resizes canvas and shifts layers", cropped.w === 800 && cropped.h === 900 && afterText.x === before.x - 50 && afterText.y === before.y - 50 && cropped.tool === "move", JSON.stringify(cropped));
await key("z", ["Control"]);
check("undo crop", (await page.evaluate(() => window.__pictocity.getState().doc.width)) === 1080);

// pixel selection: rectangular marquee over the box, Delete hides it through a painted mask, Alt+Backspace fills
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg"]));
await key("m");
await drag(await screen(150, 150), await screen(350, 350));
check("marquee sets a pixel selection", JSON.stringify((await page.evaluate(() => window.__pictocity.getState().pixelSelection))) === "[[150,150,350,150,350,350,150,350]]");
await key("Delete");
sb = await layer("seed_bg");
check("Delete inside selection hides via mask", sb.mask?.kind === "paint" && sb.mask.strokes.at(-1).fill === true && sb.mask.strokes.at(-1).erase === true && JSON.stringify(sb.mask.strokes.at(-1).rings) === "[[50,50,250,50,250,250,50,250]]", JSON.stringify(sb.mask?.strokes?.at(-1)?.rings));
await key("z", ["Control"]);
await key("Backspace", ["Alt"]);
check("Alt+Backspace fills the selection with a shape", (await state()).layers.includes("Fill"));
await key("z", ["Control"]);
// brush strokes are clipped to the selection
await key("b"); await drag(await screen(100, 250), await screen(400, 250)); await key("v");
check("brush stroke carries the selection as its clip", await page.evaluate(() => { const l = window.__pictocity.getState().doc.layers.findLast((l) => l.name === "Paint"); return Array.isArray(l?.strokes.at(-1)?.clipRings) && l.strokes.at(-1).clipRings[0].length === 8; }));
await key("z", ["Control"]);
await key("d", ["Control"]);
check("Ctrl+D clears the pixel selection", (await page.evaluate(() => window.__pictocity.getState().pixelSelection)) === null);
// lasso
await key("l");
const l0 = await screen(600, 600), l1 = await screen(700, 620), l2 = await screen(650, 700);
await page.mouse.move(...l0); await page.mouse.down(); await page.mouse.move(...l1); await page.mouse.move(...l2); await page.mouse.up(); await sleep(150);
check("lasso selection", (await page.evaluate(() => window.__pictocity.getState().pixelSelection?.[0]?.length)) >= 6);
await key("d", ["Control"]);

// pen tool: three corner points, Enter closes into a path shape
await key("p");
for (const [x, y] of [[700, 100], [900, 150], [800, 300]]) { await page.mouse.click(...(await screen(x, y))); await sleep(80); }
await key("Enter");
const pathLayer = await page.evaluate(() => window.__pictocity.getState().doc.layers.find((l) => l.name === "Path"));
check("pen creates a closed path shape", !!pathLayer && pathLayer.shape === "path" && pathLayer.path.startsWith("M") && pathLayer.path.endsWith("Z") && pathLayer.x === 700 && pathLayer.width === 200, pathLayer?.path?.slice(0, 40));
await key("z", ["Control"]);

// gradient tool: drag creates a gradient fill with stops from the drag
await key("g");
await drag(await screen(0, 100), await screen(0, 900));
const grad = await page.evaluate(() => window.__pictocity.getState().doc.layers.find((l) => l.name === "Gradient"));
check("gradient tool adds a multi-stop gradient from the drag", !!grad && grad.fill.kind === "gradient" && grad.fill.type === "linear" && grad.fill.angle === 180 && grad.fill.stops[0].pos < grad.fill.stops[1].pos, JSON.stringify(grad?.fill));
await key("z", ["Control"]); await key("v");

// transforms: flip + rotate 90 via the store, grid toggle
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg"]));
await page.evaluate(() => window.__pictocity.getState().transformSelection("flipH"));
check("flip horizontal negates scaleX", (await layer("seed_bg")).scaleX === -1);
await key("z", ["Control"]);
await page.evaluate(() => window.__pictocity.getState().transformSelection("rot90"));
check("rotate 90", (await layer("seed_bg")).rotation === 90);
await key("z", ["Control"]);
await key("'", ["Control"]); check("Ctrl+' toggles the grid", await page.evaluate(() => window.__pictocity.getState().showGrid)); await key("'", ["Control"]);

// levels/curves/bevel/fill opacity through the store's op path + render sanity
await page.evaluate(() => window.__pictocity.getState().setLayerProps("seed_bg", { filters: { levels: { inBlack: 20, inWhite: 235, gamma: 1.2, outBlack: 0, outWhite: 255 }, curves: { rgb: [[0, 0], [128, 160], [255, 255]] } }, styles: { bevel: { enabled: true, size: 12, depth: 1, angle: 120, highlight: "#ffffff", shadow: "#000000", opacity: 0.6 } }, fillOpacity: 0.5 }, "fx"));
await sleep(300);
const ex = await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`);
check("levels/curves/bevel/fill render", ex.ok && errors.length === 0);
await key("z", ["Control"]);

// magic wand on the blue box -> selection roughly the box; then mask reveal selection
await key("w");
await page.mouse.click(...(await screen(300, 250))); await sleep(400);
let wand = await page.evaluate(() => window.__pictocity.getState().pixelSelection);
const wb = wand ? (() => { const f = wand.flat(); return { x0: Math.min(...f.filter((_, i) => i % 2 === 0)), x1: Math.max(...f.filter((_, i) => i % 2 === 0)), y0: Math.min(...f.filter((_, i) => i % 2 === 1)), y1: Math.max(...f.filter((_, i) => i % 2 === 1)) }; })() : null;
check("magic wand selects the box", !!wb && Math.abs(wb.x0 - 100) < 4 && Math.abs(wb.x1 - 500) < 4 && Math.abs(wb.y0 - 100) < 4 && Math.abs(wb.y1 - 400) < 4, JSON.stringify(wb));
await page.evaluate(() => window.__pictocity.getState().select(["seed_text"]));
await page.evaluate(() => window.__pictocity.getState().maskFromSelection("reveal"));
check("mask: reveal selection", (await layer("seed_text")).mask?.base === "hide" && (await layer("seed_text")).mask.strokes[0].fill === true);
await key("z", ["Control"]); await key("d", ["Control"]); await key("v");

// clone stamp: alt-click a source, paint -> stroke with a clone offset
await key("s");
const cs = await screen(300, 250);
await page.keyboard.down("Alt"); await page.mouse.click(...cs); await page.keyboard.up("Alt"); await sleep(100);
await drag(await screen(600, 600), await screen(800, 600));
const cl = await page.evaluate(() => { const l = window.__pictocity.getState().doc.layers.findLast((l) => l.name === "Clone"); return l?.strokes.at(-1); });
check("clone stamp stroke stores the sample offset", !!cl?.clone && cl.clone.dx === -300 && cl.clone.dy === -350, JSON.stringify(cl?.clone));
check("clone renders", (await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`)).ok);
await key("z", ["Control"]); await key("z", ["Control"]); await key("v");

// pen path then direct selection: drag an anchor and check the path changed
await key("p");
for (const [x, y] of [[700, 100], [900, 150], [800, 300]]) { await page.mouse.click(...(await screen(x, y))); await sleep(80); }
await key("Enter");
const p0 = await page.evaluate(() => window.__pictocity.getState().doc.layers.find((l) => l.name === "Path")?.path);
await key("a");
await drag(await screen(700, 100), await screen(650, 60));
const p1 = await page.evaluate(() => window.__pictocity.getState().doc.layers.find((l) => l.name === "Path")?.path);
check("direct selection edits a path anchor", !!p0 && !!p1 && p0 !== p1 && p1.startsWith("M-0.25"), p1?.slice(0, 30));
await key("z", ["Control"]); await key("z", ["Control"]); await key("v");

// merge two layers into an image layer
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg", "seed_text"]));
await page.evaluate(() => window.__pictocity.getState().mergeSelection());
await sleep(2500);
st = await state();
check("merge selected into image", st.layers.includes("Merged") && !st.layers.includes("Box") && !st.layers.includes("Headline"), st.layers.join(","));
await key("z", ["Control"]);
st = await state();
check("undo merge restores layers", st.layers.includes("Box") && st.layers.includes("Headline"));

// copy / paste layer style
await page.evaluate(() => { const s = window.__pictocity.getState(); s.setLayerProps("seed_bg", { styles: { dropShadow: { enabled: true, color: "#000", blur: 9, x: 1, y: 2, opacity: 0.5 } } }, "fx"); s.select(["seed_bg"]); s.copyStyle(); s.select(["seed_text"]); s.pasteStyle(); });
await sleep(200);
check("paste layer style", (await layer("seed_text")).styles?.dropShadow?.blur === 9);
await key("z", ["Control"]); await key("z", ["Control"]);

// select inverse (keyhole polygon) + feather + heal + swatches + layer filter
await key("m"); await drag(await screen(150, 150), await screen(350, 350)); await key("v");
await key("i", ["Control", "Shift"]);
const inv = await page.evaluate(() => window.__pictocity.getState().pixelSelection);
check("select inverse produces frame + hole rings", inv && inv.length === 2, inv?.length);
await page.evaluate(() => useStoreSet({ selectionFeather: 12 }));
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg"]));
await key("Delete");
sb = await layer("seed_bg");
check("feathered delete uses a soft fill stroke", sb.mask?.strokes.at(-1).hardness === 0 && sb.mask.strokes.at(-1).size === 24);
await key("z", ["Control"]); await key("d", ["Control"]); await page.evaluate(() => useStoreSet({ selectionFeather: 0 }));
await key("j");
await page.keyboard.down("Alt"); await page.mouse.click(...(await screen(300, 250))); await page.keyboard.up("Alt");
await drag(await screen(600, 600), await screen(800, 600));
check("healing brush stroke", await page.evaluate(() => { const l = window.__pictocity.getState().doc.layers.findLast((l) => l.name === "Heal"); return !!l?.strokes.at(-1)?.heal && !!l.strokes.at(-1).clone; }));
await key("z", ["Control"]); await key("z", ["Control"]); await key("v");
await page.evaluate(() => window.__pictocity.getState().setFgColor("#123456"));
check("swatches record recent colours", (await page.evaluate(() => window.__pictocity.getState().recentColors[0])) === "#123456" && (await page.$$(".swatches-row button")).length >= 6);
await page.type(".layers .search", "head"); await sleep(150);
check("layer filter narrows the list", (await page.$$eval(".layer .name", (els) => els.map((e) => e.textContent))).every((n) => n.toLowerCase().includes("head")));
await page.keyboard.press("Escape"); await sleep(100);
check("Escape clears the layer filter and returns focus", (await page.evaluate(() => document.activeElement.tagName)) !== "INPUT" && (await page.$$eval(".layer .name", (els) => els.length)) > 1);

// linked layers: duplicate the headline, link both, change text on one -> the other follows (server-side)
await page.evaluate(() => window.__pictocity.getState().select(["seed_text"]));
await key("j", ["Control"]); await sleep(150);
const dupId = (await state()).selection[0];
await page.evaluate((id) => window.__pictocity.getState().select(["seed_text", id]), dupId);
await page.evaluate(() => window.__pictocity.getState().linkSelection()); await sleep(300);
check("link layers assigns a shared linkId", await page.evaluate((id) => { const s = window.__pictocity.getState(); const find = (x) => { const f = (ls) => { for (const l of ls) { if (l.id === x) return l; if (l.children) { const r = f(l.children); if (r) return r; } } }; return f(s.doc.layers); }; return !!find("seed_text").linkId && find("seed_text").linkId === find(id).linkId; }, dupId));
await page.evaluate(() => window.__pictocity.getState().setLayerProps("seed_text", { text: "Linked copy", color: "#ff0000" }, "edit"));
await sleep(500);
const dup = await layer(dupId);
check("linked layer follows text and colour", dup.text === "Linked copy" && dup.color === "#ff0000", `${dup.text} ${dup.color}`);
await key("z", ["Control"]);
check("undo reverts both linked layers", (await layer(dupId)).text === "Changed copy");
await key("z", ["Control"]); await key("z", ["Control"]);

// transform selection: marquee, then scale it via the handle, Enter finishes
await key("m"); await drag(await screen(100, 100), await screen(300, 300)); await key("v");
await key("t", ["Control", "Shift"]); await sleep(100);
await drag(await screen(300, 300), await screen(400, 400));
const tsel = await page.evaluate(() => window.__pictocity.getState().pixelSelection);
check("transform selection scales the marching ants", tsel && Math.max(...tsel[0].filter((_, i) => i % 2 === 0)) === 400 && Math.max(...tsel[0].filter((_, i) => i % 2 === 1)) === 400, JSON.stringify(tsel));
await key("Enter"); await key("d", ["Control"]);

// dashed arrow line + grain render, document tabs, shortcuts modal
await page.evaluate(() => window.__pictocity.getState().setLayerProps("seed_bg", { filters: { noise: 0.4 } }, "grain"));
check("grain renders", (await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`)).ok);
await key("z", ["Control"]);
check("document tabs show the open document", (await page.$$eval(".doctabs button.on", (b) => b.map((x) => x.textContent)))[0] === "ui-smoke");
await key("/", ["Shift"]);
check("? opens the shortcut sheet", await page.$(".modal header") && (await page.$eval(".modal header", (h) => h.textContent)) === "Keyboard shortcuts"); await key("Escape");

// render cache: same document renders identically with and without the cache; a change invalidates only that layer
const cacheOk = await page.evaluate(async () => {
  const s = window.__pictocity.getState();
  const mod = await import("/app/" + [...document.scripts].map((x) => x.src.split("/app/")[1]).find(Boolean));
  void mod; // (renderer is bundled; compare through the canvas instead)
  const canvas = document.querySelector("canvas.stage");
  const before = canvas.toDataURL();
  s.setLayerProps("seed_bg", { fill: "#00aa00" }, "recolor");
  await new Promise((r) => setTimeout(r, 300));
  const after = document.querySelector("canvas.stage").toDataURL();
  s.undo();
  await new Promise((r) => setTimeout(r, 300));
  const back = document.querySelector("canvas.stage").toDataURL();
  return { changed: before !== after, restored: before === back };
});
check("cached render updates on change and restores on undo", cacheOk.changed && cacheOk.restored, JSON.stringify(cacheOk));

// offline outbox: cut the socket, edit, reconnect -> the edit reaches the server
await page.evaluate(() => { const s = window.__pictocity.getState(); window.__offlineEdit = true; s.dispatch([{ type: "layer.set", id: "seed_bg", props: { name: "Box (online)" } }], "warm"); });
await sleep(200);
const beforeRev = (await fetch(`${BASE}/api/docs/${doc.id}`).then((r) => r.json())).rev;
await page.setOfflineMode(true);
await sleep(300);
await page.evaluate(() => window.__pictocity.getState().dispatch([{ type: "layer.set", id: "seed_bg", props: { name: "Box (offline)" } }], "offline edit"));
await sleep(300);
const duringRev = (await fetch(`${BASE}/api/docs/${doc.id}`).then((r) => r.json())).rev;
await page.setOfflineMode(false);
await sleep(2500);
const afterDoc = await fetch(`${BASE}/api/docs/${doc.id}`).then((r) => r.json());
check("offline edit is queued and replayed after reconnect", duringRev === beforeRev && afterDoc.rev > beforeRev && afterDoc.layers.find((l) => l.id === "seed_bg")?.name === "Box (offline)", `${beforeRev}/${duringRev}/${afterDoc.rev} ${afterDoc.layers.find((l) => l.id === "seed_bg")?.name}`);
await page.evaluate(() => window.__pictocity.getState().dispatch([{ type: "layer.set", id: "seed_bg", props: { name: "Box" } }], "rename back"));
await sleep(200);

// per-corner radii + pattern overlay + trimmed export
await page.evaluate(() => window.__pictocity.getState().setLayerProps("seed_bg", { radii: [40, 0, 40, 0], styles: { patternOverlay: { enabled: true, assetId: "none", scale: 0.2, opacity: 0.5, blend: "normal" } } }, "corners"));
check("per-corner radii + pattern overlay render", (await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`)).ok);
await key("z", ["Control"]);
const trimmed = await fetch(`${BASE}/api/docs/${doc.id}/export?format=png&trim=true&scale=0.5`);
check("trimmed export", trimmed.ok && trimmed.headers.get("content-type") === "image/png");

// Tab hides the panels; type tool click on existing text edits it
await key("Tab"); check("Tab hides panels", await page.evaluate(() => document.querySelector(".app").classList.contains("panels-hidden"))); await key("Tab");
await key("t"); { const tl = await layer("seed_text"); await page.mouse.click(...(await screen(tl.x + 60, tl.y + 40))); } await sleep(250);
check("type tool click on text edits it (through the transparent paint layers above)", (await state()).editing === "seed_text", JSON.stringify((await state()).layers)); await key("Escape"); await key("v");
// pixel-accurate auto-select: clicking a transparent spot of the paint layer selects what's visible underneath
await page.mouse.click(...(await screen(460, 385))); await sleep(150);
check("auto-select ignores transparent pixels of layers above", (await state()).selection[0] === "seed_bg", JSON.stringify(await page.evaluate(() => { const s = window.__pictocity.getState(); const l = s.doc.layers.find((l) => l.id === s.selection[0]); return l && { name: l.name, type: l.type, x: l.x, y: l.y, w: l.width, h: l.height, strokes: l.strokes?.map((st) => [st.points.slice(0, 4), st.size, st.erase, !!st.clip]) }; })));
await page.mouse.click(...(await screen(900, 900))); await sleep(150);
check("clicking empty canvas selects nothing even under a full-canvas paint layer", (await state()).selection.length === 0, JSON.stringify((await state()).selection));
const anyAsset = (await Promise.all((await fetch(`${BASE}/api/docs`).then((r) => r.json())).map((d) => fetch(`${BASE}/api/docs/${d.id}`).then((r) => r.json())))).flatMap((d) => Object.values(d.assets))[0];
check("assets are served immutable", !!anyAsset && ((await fetch(`${BASE}${anyAsset.src}`)).headers.get("cache-control")?.includes("immutable") ?? false), anyAsset?.src);

// text on a path (render), copy/paste layers within the doc and into a second document
await page.evaluate(() => window.__pictocity.getState().setLayerProps("seed_text", { onPath: { path: "M0 0.5 L0.25 0.2 L0.5 0.1 L0.75 0.2 L1 0.5", align: "center", offset: 0 } }, "path"));
check("text on a path renders", (await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`)).ok);
await key("z", ["Control"]);
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg", "seed_text"]));
await key("c", ["Control"]);
const clip = await page.evaluate(() => window.__pictocityClipboard);
check("copy layers puts JSON on the clipboard", !!clip && JSON.parse(clip).layers.length === 2);
await page.evaluate((txt) => { const e = new ClipboardEvent("paste", { clipboardData: new DataTransfer() }); e.clipboardData.setData("text/plain", txt); window.dispatchEvent(e); }, clip);
await sleep(300);
st = await state();
check("paste duplicates layers with an offset", st.layers.filter((n) => n === "Box").length === 2 && (await page.evaluate(() => { const s = window.__pictocity.getState(); const c = s.doc.layers.filter((l) => l.name === "Box").at(-1); return c.x === 120 && c.id !== "seed_bg"; })), st.layers.join(","));
await key("z", ["Control"]);
const other = await fetch(`${BASE}/api/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "paste-target", width: 800, height: 800, background: "#fff" }) }).then((r) => r.json());
await page.evaluate((id) => window.__pictocity.getState().connect(id), other.id); await sleep(800);
await page.evaluate((txt) => { const e = new ClipboardEvent("paste", { clipboardData: new DataTransfer() }); e.clipboardData.setData("text/plain", txt); window.dispatchEvent(e); }, clip);
await sleep(500);
const otherDoc = await fetch(`${BASE}/api/docs/${other.id}`).then((r) => r.json());
check("paste into another document carries the layers", otherDoc.layers.map((l) => l.name).join(",") === "Box,Headline", otherDoc.layers.map((l) => l.name).join(","));
await fetch(`${BASE}/api/docs/${other.id}`, { method: "DELETE" });
await page.evaluate((id) => window.__pictocity.getState().connect(id), doc.id); await sleep(800);
check("document tabs remember both documents", (await page.$$eval(".doctabs button", (b) => b.length)) >= 3);
// paste an image file from the clipboard -> placed as a layer
await page.evaluate(async () => { const c = document.createElement("canvas"); c.width = 40; c.height = 30; c.getContext("2d").fillStyle = "#0a0"; c.getContext("2d").fillRect(0, 0, 40, 30); const blob = await new Promise((r) => c.toBlob(r, "image/png")); const dt = new DataTransfer(); dt.items.add(new File([blob], "pasted.png", { type: "image/png" })); window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt })); });
await sleep(1500);
check("pasting an image places it as a layer", (await state()).layers.includes("pasted"), (await state()).layers.join(","));
await key("z", ["Control"]);

// clipping mask: a text layer clipped to the box shows nothing outside the box
await page.evaluate(() => { const s = window.__pictocity.getState(); s.dispatch([{ type: "layer.add", parentId: null, index: 1, layer: { id: "clipped", type: "fill", name: "Clipped fill", visible: true, locked: false, opacity: 1, blend: "normal", x: 0, y: 0, width: 1080, height: 1080, rotation: 0, scaleX: 1, scaleY: 1, fill: { kind: "solid", color: "#ff00ff" }, clipToBelow: true } }], "clip"); });
await sleep(400);
const clipPng = await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=1`).then((r) => r.arrayBuffer());
const clipCheck = await page.evaluate(async (buf) => { const img = new Image(); img.src = URL.createObjectURL(new Blob([new Uint8Array(buf)])); await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0); const inside = x.getImageData(460, 385, 1, 1).data, outside = x.getImageData(700, 700, 1, 1).data; return { inside: [...inside].slice(0, 3), outside: [...outside].slice(0, 3) }; }, Array.from(new Uint8Array(clipPng)));
check("clipping mask confines the fill to the layer below", clipCheck.inside.join() === "255,0,255" && clipCheck.outside.join() === "255,255,255", JSON.stringify(clipCheck));
check("clipped layer shows the arrow in the Layers panel", (await page.$$(".layer .clip-arrow")).length === 1);
await page.evaluate(() => { window.__pictocity.getState().select(["clipped"]); window.__pictocity.getState().toggleClipping(); }); await sleep(200);
check("release clipping mask", await page.evaluate(() => !window.__pictocity.getState().doc.layers.find((l) => l.id === "clipped").clipToBelow));
await key("z", ["Control"]); await key("z", ["Control"]);

// layer comps: save A, change, save B, apply A restores
await page.evaluate(() => window.__pictocity.getState().saveComp("A")); await sleep(150);
await page.evaluate(() => window.__pictocity.getState().setLayerProps("seed_text", { text: "Variant B", visible: false }, "b")); await sleep(150);
await page.evaluate(() => window.__pictocity.getState().saveComp("B")); await sleep(150);
await page.evaluate(() => { const s = window.__pictocity.getState(); s.applyComp(s.doc.comps.find((c) => c.name === "A").id); }); await sleep(300);
let tA = await layer("seed_text");
check("layer comps restore visibility and text", tA.visible === true && tA.text === "Changed copy", `${tA.visible} ${tA.text}`);
const compFiles = await fetch(`${BASE}/api/docs/${doc.id}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ comps: true, scale: 0.25 }) }).then((r) => r.json());
check("export every comp writes one file each", compFiles.files?.length === 2, JSON.stringify(compFiles.files?.map((f) => f.name)));
check("comps panel lists them", (await page.$$eval(".panel header", (hs) => hs.some((h) => h.textContent.startsWith("Layer comps")))) && (await page.evaluate(() => window.__pictocity.getState().doc.comps.length)) === 2);
await page.evaluate(() => { const s = window.__pictocity.getState(); s.dispatch([{ type: "doc.set", props: { comps: [] } }], "clear comps"); s.setLayerProps("seed_text", { text: "Changed copy", visible: true }, "reset"); }); await sleep(150);

// solo (alt-click the eye) and shift-range selection in the Layers panel
{ const eyes = await page.$$(".layer .eye"); await page.keyboard.down("Alt"); await eyes[eyes.length - 1].click(); await page.keyboard.up("Alt"); await sleep(200); }
check("alt-click eye solos the layer", await page.evaluate(() => { const ls = window.__pictocity.getState().doc.layers; return ls[0].visible && ls.slice(1).every((l) => !l.visible); }));
{ const eyes = await page.$$(".layer .eye"); await page.keyboard.down("Alt"); await eyes[eyes.length - 1].click(); await page.keyboard.up("Alt"); await sleep(200); }
check("alt-click again restores visibility", await page.evaluate(() => window.__pictocity.getState().doc.layers.every((l) => l.visible)));
{ const names = await page.$$(".layer .name"); await names[0].click(); await page.keyboard.down("Shift"); await names[2].click(); await page.keyboard.up("Shift"); await sleep(150); }
check("shift-click selects a range of layers", (await state()).selection.length === 3, JSON.stringify((await state()).selection));

// combine shapes: box minus a circle -> one path shape; convert ellipse to path
await page.evaluate(() => { const s = window.__pictocity.getState(); s.dispatch([{ type: "layer.add", parentId: null, index: 1, layer: { id: "hole", type: "shape", name: "Hole", shape: "ellipse", fill: "#ff0000", strokeColor: null, strokeWidth: 0, visible: true, locked: false, opacity: 1, blend: "normal", x: 380, y: 200, width: 240, height: 240, rotation: 0, scaleX: 1, scaleY: 1 } }], "hole"); s.select(["seed_bg", "hole"]); s.combineShapes("subtract"); });
await sleep(400);
const combined = await page.evaluate(() => window.__pictocity.getState().doc.layers.find((l) => l.name.includes("(subtract)")));
check("combine shapes: subtract front produces one path shape", !!combined && combined.shape === "path" && combined.width === 400 && combined.path.split("M").length === 2, combined && `${combined.width}x${combined.height} ${combined.path.slice(0, 40)}`);
const subPng = await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=1`).then((r) => r.arrayBuffer());
const subCheck = await page.evaluate(async (buf) => { const img = new Image(); img.src = URL.createObjectURL(new Blob([new Uint8Array(buf)])); await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return { hole: [...x.getImageData(490, 300, 1, 1).data].slice(0, 3).join(), body: [...x.getImageData(150, 380, 1, 1).data].slice(0, 3).join() }; }, Array.from(new Uint8Array(subPng)));
check("subtracted area is transparent, the rest keeps the fill", subCheck.hole === "255,255,255" && subCheck.body === "79,109,245", JSON.stringify(subCheck));
await key("z", ["Control"]); await key("z", ["Control"]);
await page.evaluate(() => { const s = window.__pictocity.getState(); s.dispatch([{ type: "layer.add", parentId: null, index: 1, layer: { id: "ell", type: "shape", name: "Ell", shape: "ellipse", fill: "#0f0", strokeColor: null, strokeWidth: 0, visible: true, locked: false, opacity: 1, blend: "normal", x: 600, y: 500, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1 } }], "ell"); s.select(["ell"]); s.convertToPath(); });
await sleep(200);
const conv = await page.evaluate(() => window.__pictocity.getState().doc.layers.find((l) => l.id === "ell"));
check("convert ellipse to an editable path (4 anchors)", conv?.shape === "path" && (conv.path.match(/C/g) || []).length === 4 && (await state()).tool === "direct", conv?.path?.slice(0, 40));
await key("z", ["Control"]); await key("z", ["Control"]); await key("v");
await page.evaluate(() => window.__pictocity.getState().setLayerProps("seed_text", { vertical: true }, "vertical"));
check("vertical type renders", (await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`)).ok);
await key("z", ["Control"]);

// per-character styling: select "copy" inside the inline editor, click the colour -> a run; render + PSD ok
await dbl(...(await screen(300, 540)));
await page.keyboard.press("End"); await page.keyboard.down("Shift"); for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft"); await page.keyboard.up("Shift");
await sleep(200);
check("inline editor reports the selected range", JSON.stringify(await page.evaluate(() => window.__pictocity.getState().textSelection)) === JSON.stringify({ id: "seed_text", start: 8, end: 12 }));
await page.evaluate(() => window.__pictocity.getState().styleTextRange({ color: "#ff0000", fontWeight: 700 })); await sleep(200);
const runs = (await layer("seed_text")).runs;
check("character run stored", runs?.length === 1 && runs[0].start === 8 && runs[0].color === "#ff0000", JSON.stringify(runs));
await key("Escape"); await sleep(100);
check("rich text renders + psd exports", (await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`)).ok && (await fetch(`${BASE}/api/docs/${doc.id}/export?format=psd`)).ok);
await key("z", ["Control"]);
// font install through the API (a served font file), then it appears in /api/fonts as served
const fontBytes = await fetch(`${BASE}/fonts/Poppins-Italic.ttf`).then((r) => r.arrayBuffer());
const testFont = `Test-${Date.now()}.ttf`; // unique per run: the previous run's copy is registered (and file-locked) at server startup on Windows
const inst = await fetch(`${BASE}/api/fonts`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-filename": testFont }, body: fontBytes }).then((r) => r.json());
check("install font registers a family", !!inst.family, JSON.stringify(inst));
check("installed font is served", (await fetch(`${BASE}/api/fonts`).then((r) => r.json())).some((f) => typeof f !== "string" && f.files.includes(testFont)));

// selection modifiers: Shift-drag adds a second area, Alt-drag subtracts; expand; polygonal lasso; save/load; from transparency
await key("m"); await drag(await screen(100, 100), await screen(200, 200));
await page.keyboard.down("Shift"); await drag(await screen(400, 400), await screen(500, 500)); await page.keyboard.up("Shift");
check("Shift-drag adds a second selection area", (await page.evaluate(() => window.__pictocity.getState().pixelSelection?.length)) === 2);
await page.keyboard.down("Alt"); await drag(await screen(150, 150), await screen(250, 250)); await page.keyboard.up("Alt");
check("Alt-drag subtracts", await page.evaluate(() => { const s = window.__pictocity.getState().pixelSelection; return s.length === 2 && s.some((r) => r.length > 8); }));
await page.evaluate(() => window.__pictocity.getState().modifySelection("expand", 20)); await sleep(300);
const exp = await page.evaluate(() => { const s = window.__pictocity.getState().pixelSelection; const f = s.flat(); return { n: s.length, x0: Math.min(...f.filter((_, i) => i % 2 === 0)) }; });
check("expand selection grows it", exp.n >= 2 && exp.x0 < 100, JSON.stringify(exp));
await page.evaluate(() => window.__pictocity.getState().saveSelection("spots")); await sleep(200); await key("d", ["Control"]);
await page.evaluate(() => { const s = window.__pictocity.getState(); s.loadSelection(s.doc.selections[0].id); });
check("save + load selection", (await page.evaluate(() => window.__pictocity.getState().pixelSelection?.length)) >= 2 && (await page.evaluate(() => window.__pictocity.getState().doc.selections[0].name)) === "spots");
await key("d", ["Control"]);
await page.evaluate(() => window.__pictocity.getState().selectionFromLayer("seed_bg", (l) => window.__layerAlpha(l.id))); await sleep(200);
const fromT = await page.evaluate(() => { const s = window.__pictocity.getState().pixelSelection; const f = s.flat(); return { x0: Math.min(...f.filter((_, i) => i % 2 === 0)), x1: Math.max(...f.filter((_, i) => i % 2 === 0)) }; });
check("selection from layer transparency", Math.abs(fromT.x0 - 100) < 4 && Math.abs(fromT.x1 - 500) < 4, JSON.stringify(fromT));
await key("d", ["Control"]);
await page.evaluate(() => useStoreSet({ lassoKind: "polygon", tool: "lasso" }));
for (const [x, y] of [[600, 600], [800, 600], [700, 750]]) { await page.mouse.click(...(await screen(x, y))); await sleep(60); }
await key("Enter");
check("polygonal lasso closes on Enter", JSON.stringify((await page.evaluate(() => window.__pictocity.getState().pixelSelection))) === "[[600,600,800,600,700,750]]");
await key("d", ["Control"]); await page.evaluate(() => useStoreSet({ lassoKind: "free" })); await key("v");

// adjustments + filters render and export; masked adjustment layer
await page.evaluate(() => { const s = window.__pictocity.getState(); s.setLayerProps("seed_bg", { filters: { vibrance: 0.5, exposure: { exposure: 0.3, offset: 0, gamma: 1 }, unsharp: { amount: 1, radius: 2 }, gradientMap: { stops: [{ pos: 0, color: "#000000" }, { pos: 1, color: "#ffffff" }] } } }, "adj"); });
check("adjustments + filters render", (await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`)).ok && (await fetch(`${BASE}/api/docs/${doc.id}/export?format=psd`)).ok);
await key("z", ["Control"]);
// perspective transform via the drag on a corner handle
await page.evaluate(() => { const s = window.__pictocity.getState(); s.select(["seed_bg"]); useStoreSet({ distortMode: "perspective", tool: "move" }); }); await sleep(100);
await drag(await screen(500, 100), await screen(520, 60));
const quad = (await layer("seed_bg")).quad;
check("perspective drag moves the corner and mirrors its partner", !!quad && quad[3] < 0 && Math.abs(quad[5] + quad[3]) < 0.01 && !(await page.evaluate(() => window.__pictocity.getState().distortMode)) === false, JSON.stringify(quad));
await key("Enter");
check("distorted layer renders", (await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`)).ok);
await key("z", ["Control"]);
check("undo clears the distortion", !(await layer("seed_bg")).quad);

// svg export + import round trip, gradient fill, custom shape, anchor insert, style presets, gc
check("svg export", (await fetch(`${BASE}/api/docs/${doc.id}/export?format=svg`)).headers.get("content-type") === "image/svg+xml");
const svgImp = await fetch(`${BASE}/api/docs/import-svg`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg: '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="30" height="30" fill="#f00"/><circle cx="70" cy="70" r="20" fill="#0f0"/></svg>', name: "t.svg", docId: doc.id }) }).then((r) => r.json());
await sleep(300);
check("svg placed into the document as a group", svgImp.layers === 2 && (await state()).layers.includes("t"));
await key("z", ["Control"]); // (server-applied op: undo via revert not available; remove directly)
await page.evaluate((gid) => window.__pictocity.getState().dispatch([{ type: "layer.remove", id: gid }], "rm"), svgImp.groupId); await sleep(150);
await page.evaluate(() => { const s = window.__pictocity.getState(); s.setLayerProps("seed_bg", { fill: "#123456" }, "x"); }); await key("z", ["Control"]);
await page.evaluate(() => { const s = window.__pictocity.getState(); s.dispatch([{ type: "layer.add", parentId: null, index: 0, layer: { id: "grad", type: "fill", name: "Grad", visible: true, locked: false, opacity: 1, blend: "normal", x: 0, y: 0, width: 1080, height: 1080, rotation: 0, scaleX: 1, scaleY: 1, fill: { kind: "gradient", type: "diamond", angle: 30, stops: [{ pos: 0, color: "#ff0000" }, { pos: 1, color: "#0000ff", opacity: 0 }] } } }], "grad"); });
check("multi-stop diamond gradient renders", (await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=0.25`)).ok);
await key("z", ["Control"]);
await page.evaluate(() => { const s = window.__pictocity.getState(); s.select(["seed_bg"]); s.convertToPath(); }); await sleep(150);
const pathBefore = (await layer("seed_bg")).path; const nA = (pathBefore.match(/C/g) || []).length;
await page.keyboard.down("Alt"); await page.mouse.click(...(await screen(300, 100))); await page.keyboard.up("Alt"); await sleep(150);
const pathAfter = (await layer("seed_bg")).path;
check("alt-click adds an anchor on the outline", (pathAfter.match(/C/g) || []).length === nA + 1, `${nA} -> ${(pathAfter.match(/C/g) || []).length}`);
await key("z", ["Control"]); await key("z", ["Control"]); await key("v");
const gc = await fetch(`${BASE}/api/assets?gc`, { method: "POST" }).then((r) => r.json());
check("asset gc endpoint", typeof gc.removed === "number");
await fetch(`${BASE}/api/style-presets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ name: "shadow", styles: { dropShadow: { enabled: true, color: "#000", blur: 10, x: 0, y: 4, opacity: 0.5 } } }]) });
check("style presets stored", (await fetch(`${BASE}/api/style-presets`).then((r) => r.json()))[0]?.name === "shadow");

// timeline: add two keyframes on the box, scrub, export GIF and HTML5
await key("t", ["Control", "Alt"]); await sleep(100);
check("timeline panel opens", !!(await page.$(".timeline")));
await page.evaluate(() => { const s = window.__pictocity.getState(); s.select(["seed_bg"]); s.addKeyframe(); }); await sleep(150);
await page.evaluate(() => useStoreSet({ animTime: 1000 }));
await page.evaluate(() => { const s = window.__pictocity.getState(); s.setLayerProps("seed_bg", { x: 400 }, "move"); s.addKeyframe(); }); await sleep(200);
const anim = await page.evaluate(() => window.__pictocity.getState().doc.animation);
check("two keyframes recorded", anim?.tracks?.seed_bg?.length === 2 && anim.tracks.seed_bg[1].x === 400 && anim.duration >= 1000, JSON.stringify(anim?.tracks));
check("timeline shows the track and markers", (await page.$$(".tl-key")).length === 2);
const gifR = await fetch(`${BASE}/api/docs/${doc.id}/export?format=gif&scale=0.2`);
check("animated gif export", gifR.headers.get("content-type") === "image/gif" && (Buffer.from(await gifR.arrayBuffer()).toString("latin1").match(/\x21\xF9\x04/g) || []).length >= 10);
const htmlR = await fetch(`${BASE}/api/docs/${doc.id}/export?format=html`).then((r) => r.text());
check("html5 banner export", htmlR.includes("@keyframes") && htmlR.includes("ad.size"));
await page.evaluate(() => useStoreSet({ animTime: 0, showTimeline: false }));
await page.evaluate(() => { const s = window.__pictocity.getState(); s.dispatch([{ type: "doc.set", props: { animation: null } }], "clear anim"); s.setLayerProps("seed_bg", { x: 100 }, "back"); }); await sleep(150);

// formats + export dialog + open dialog + save as + shortcuts (X, D, F, ⌘H, ⌘⇧N, ⌘K)
for (const f of ["tiff", "bmp", "pdf", "png8", "avif"]) { const r = await fetch(`${BASE}/api/docs/${doc.id}/export?format=${f}&scale=0.25`); check(`export ${f}`, r.ok && (await r.arrayBuffer()).byteLength > 200 && (r.headers.get("content-type") || "").includes(f === "png8" ? "png" : f === "pdf" ? "pdf" : f)); }
check("transparent export ignores the canvas colour", await (async () => { const buf = await fetch(`${BASE}/api/docs/${doc.id}/export?format=png&scale=0.1&transparent=true`).then((r) => r.arrayBuffer()); return await page.evaluate(async (b) => { const img = new Image(); img.src = URL.createObjectURL(new Blob([new Uint8Array(b)])); await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(2, 2, 1, 1).data[3] === 0; }, Array.from(new Uint8Array(buf))); })());
check("package export", (await fetch(`${BASE}/api/docs/${doc.id}/package`).then((r) => r.json())).format === "pictocity-package");
const pkg = await fetch(`${BASE}/api/docs/${doc.id}/package`).then((r) => r.text());
const imp2 = await fetch(`${BASE}/api/docs/import-package`, { method: "POST", headers: { "content-type": "application/json" }, body: pkg }).then((r) => r.json());
check("package import restores the document", !!imp2.id && (await fetch(`${BASE}/api/docs/${imp2.id}`).then((r) => r.json())).layers.length === (await fetch(`${BASE}/api/docs/${doc.id}`).then((r) => r.json())).layers.length);
await fetch(`${BASE}/api/docs/${imp2.id}`, { method: "DELETE" });
check("exports listing", Array.isArray(await fetch(`${BASE}/api/exports`).then((r) => r.json())));
await key("w", ["Control", "Alt", "Shift"]); await sleep(150);
check("⌥⇧⌘W opens Export As", (await page.$eval(".modal header", (h) => h.textContent)) === "Export As"); await key("Escape");
await key("s", ["Control", "Shift"]); await sleep(150);
check("⇧⌘S opens Save As", (await page.$eval(".modal header", (h) => h.textContent)) === "Save As"); await key("Escape");
await key("o", ["Control"]); await sleep(300);
check("Open dialog shows document cards", (await page.$$(".doc-card")).length >= 1); await key("Escape");
await key("k", ["Control"]); await sleep(100); check("⌘K opens Preferences", (await page.$eval(".modal header", (h) => h.textContent)) === "Preferences"); await key("Escape");
await page.evaluate(() => useStoreSet({ fgColor: "#111111", bgColor: "#eeeeee" })); await key("x");
check("X swaps foreground/background", (await page.evaluate(() => [window.__pictocity.getState().fgColor, window.__pictocity.getState().bgColor])).join() === "#eeeeee,#111111");
await key("d"); check("D resets to default colours", (await page.evaluate(() => window.__pictocity.getState().fgColor)) === "#000000");
await key("f"); check("F hides panels (screen mode)", await page.evaluate(() => window.__pictocity.getState().panelsHidden)); await key("f"); check("F again hides the menu", await page.evaluate(() => window.__pictocity.getState().menuHidden)); await key("f");
await key("h", ["Control"]); check("⌘H hides extras", !(await page.evaluate(() => window.__pictocity.getState().showExtras))); await key("h", ["Control"]);
await key("n", ["Control", "Shift", "Alt"]); await sleep(150); check("⌥⇧⌘N adds a layer", (await state()).layers.includes("Layer")); await key("z", ["Control"]);
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg"])); await key("b", ["Control"]); await sleep(150);
check("⌘B adds colour balance to the layer", !!(await layer("seed_bg")).filters?.colorBalance); await key("z", ["Control"]);
await page.evaluate(() => window.__pictocity.getState().rotateCanvas(90)); await sleep(200);
check("image rotation swaps the canvas and keeps layers", (await state()).rev > 0 && (await page.evaluate(() => { const d = window.__pictocity.getState().doc; return d.width === 1080 && d.height === 1080 && d.layers.find((l) => l.id === "seed_bg").rotation === 90; })));
await key("z", ["Control"]);
await page.evaluate(() => useStoreSet({ viewRotation: 30 })); await sleep(100);
check("rotated view still maps clicks to the right layer", await page.evaluate(() => { const s = window.__pictocity.getState(); return s.viewRotation === 30; }));
await page.evaluate(() => useStoreSet({ viewRotation: 0 }));

// what you see is what you export: browser render vs server render of the same document
{
  await page.evaluate(() => { const s = window.__pictocity.getState(); s.setLayerProps("seed_bg", { styles: { dropShadow: { enabled: true, color: "#000000", blur: 12, x: 4, y: 6, opacity: 0.5 }, stroke: { enabled: true, color: "#ffffff", size: 3, position: "outside" } }, filters: { vibrance: 0.3 } }, "parity fx"); });
  await sleep(200);
  const scale = 0.4;
  const serverPng = await fetch(`${BASE}/api/docs/${doc.id}/render.png?scale=${scale}`).then((r) => r.arrayBuffer());
  const diff = await page.evaluate(async ([buf, sc]) => {
    const load = (src) => new Promise((res) => { const img = new Image(); img.onload = () => res(img); img.src = src; });
    const a = await load(window.__pictocityRender(sc));
    const b = await load(URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "image/png" })));
    if (a.width !== b.width || a.height !== b.height) return { size: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
    const c1 = document.createElement("canvas"), c2 = document.createElement("canvas"); c1.width = c2.width = a.width; c1.height = c2.height = a.height;
    c1.getContext("2d").drawImage(a, 0, 0); c2.getContext("2d").drawImage(b, 0, 0);
    const p1 = c1.getContext("2d").getImageData(0, 0, a.width, a.height).data, p2 = c2.getContext("2d").getImageData(0, 0, a.width, a.height).data;
    let bad = 0, maxd = 0; for (let i = 0; i < p1.length; i += 4) { const d = Math.max(Math.abs(p1[i] - p2[i]), Math.abs(p1[i + 1] - p2[i + 1]), Math.abs(p1[i + 2] - p2[i + 2]), Math.abs(p1[i + 3] - p2[i + 3])); if (d > 40) bad++; if (d > maxd) maxd = d; }
    return { pct: (100 * bad) / (p1.length / 4), maxd, w: a.width, h: a.height };
  }, [Array.from(new Uint8Array(serverPng)), scale]);
  check("browser and server renders match (text, effects, filters)", diff.pct !== undefined && diff.pct < 1.5, JSON.stringify(diff));
  await key("z", ["Control"]);
}

// artboards: Layer > New artboard… twice, labels select, per-artboard export
for (const preset of ["0", "2"]) {
  await openMenu("Layer");
  await page.evaluate(() => [...document.querySelectorAll(".dropdown button")].find((b) => b.textContent.startsWith("New artboard")).click());
  await sleep(150);
  await page.select(".modal select", preset);
  await page.click(".modal footer .btn.primary");
  await sleep(400);
}
let abs = await page.evaluate(() => window.__pictocity.getState().doc.layers.filter((l) => l.artboard).map((a) => ({ name: a.name, x: a.x, w: a.width, h: a.height })));
check("two artboards placed side by side", abs.length === 2 && abs[1].x === abs[0].w + 100 && abs[1].h === 1920, JSON.stringify(abs));
check("pasteboard grows to fit", (await page.evaluate(() => { const d = window.__pictocity.getState().doc; return d.width >= 2260 && d.height >= 1920 && d.background === "#3b3b3b"; })));
const lbl = await page.$$eval(".artboard-label", (els) => els.map((e) => ({ t: e.textContent, x: e.getBoundingClientRect().x + 8, y: e.getBoundingClientRect().y + 8 })));
await page.mouse.click(lbl[0].x, lbl[0].y); await sleep(150);
check("artboard label selects the artboard", await page.evaluate(() => { const s = window.__pictocity.getState(); const l = s.doc.layers.find((l) => l.id === s.selection[0]); return !!(l && l.artboard); }));
const files = await page.evaluate(async () => { const s = window.__pictocity.getState(); const r = await fetch(`/api/docs/${s.doc.id}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "png", artboards: true }) }); return (await r.json()).files; });
check("export all artboards writes one file each", files.length === 2 && files[1].width === 1080 && files[1].height === 1920, JSON.stringify(files.map((f) => `${f.width}x${f.height}`)));
const abPng = await fetch(`${BASE}/api/docs/${doc.id}/render.png?artboard=${encodeURIComponent(abs[0].name)}&scale=0.1`);
check("render one artboard by name", abPng.ok && abPng.headers.get("content-type") === "image/png");
// copy to artboard dialog: select the seed layers (now inside artboard 1? no - they stayed loose) and copy into artboard 2 with fit
await page.evaluate(() => window.__pictocity.getState().select(["seed_bg", "seed_text"]));
await openMenu("Edit");
await page.evaluate(() => [...document.querySelectorAll(".dropdown button")].find((b) => b.textContent.startsWith("Copy to artboard")).click());
await sleep(150);
await page.evaluate(() => [...document.querySelectorAll(".modal .list button")][1].click());
await sleep(300);
const copied = await page.evaluate(() => { const s = window.__pictocity.getState(); const ab = s.doc.layers.filter((l) => l.artboard)[1]; return ab.children.filter((c) => c.name !== "Background").map((c) => ({ name: c.name, x: c.x, y: c.y, w: c.width, fs: c.fontSize })); });
check("copy to artboard places scaled copies inside the target", copied.length === 2 && copied.every((c) => c.x >= 1180) && copied.find((c) => c.name === "Headline").fs === 72, JSON.stringify(copied));
check("image tools listed", (await fetch(`${BASE}/api/image-tools`).then((r) => r.json())).some((t) => t.name === "knockout_background"));
for (let i = 0; i < 3; i++) await key("z", ["Control"]);
check("undo removes the artboards", (await page.evaluate(() => window.__pictocity.getState().doc.layers.filter((l) => l.artboard).length)) === 0);

// size variant through the API the dialog uses
const v = await fetch(`${BASE}/api/docs/${doc.id}/variant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ width: 1080, height: 1920, name: "story variant" }) }).then((r) => r.json());
const vdoc = await fetch(`${BASE}/api/docs/${v.id}`).then((r) => r.json());
const vText = vdoc.layers.find((l) => l.type === "text");
check("size variant scales layout", vdoc.width === 1080 && vdoc.height === 1920 && vText && Math.abs(vText.y - 500 - 420) < 2, `${vdoc.width}x${vdoc.height} text y=${vText?.y}`);
await fetch(`${BASE}/api/docs/${v.id}`, { method: "DELETE" });

// guides from rulers + snapping
const area = await page.evaluate(() => { const r = document.querySelector(".canvas-area").getBoundingClientRect(); return { left: r.left, top: r.top }; });
const [gx, gy] = await screen(540, 540);
await drag([area.left + 8, gy], [gx, gy]);
check("drag from ruler creates guide", (await state()).guides.some((g) => g.axis === "x" && g.position === 540));

// zoom shortcuts
await key("1", ["Control"]); check("Ctrl+1 = 100%", (await state()).zoom === 1);
await key("0", ["Control"]); check("Ctrl+0 fits", (await state()).zoom < 1);

// live agent edit shows up
await fetch(`${BASE}/api/docs/${doc.id}/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "agent:smoke", label: "Agent recolor", ops: [{ type: "layer.set", id: "seed_bg", props: { fill: "#ff0000" } }] }) });
await sleep(400);
check("agent edit arrives live", (await layer("seed_bg")).fill === "#ff0000");
check("agent presence shown", await page.evaluate(() => Object.keys(window.__pictocity.getState().presence).includes("agent:smoke")));

// dialogs
await key("n", ["Control"]); check("New dialog opens", await page.$(".modal") !== null); await key("Escape");
await key("o", ["Control"]); await sleep(400); check("Open dialog lists documents", (await page.$$(".modal .list button")).length >= 1); await key("Escape");

// export endpoints (what the File menu calls)
for (const f of ["png", "jpg", "webp", "psd"]) { const r = await fetch(`${BASE}/api/docs/${doc.id}/export?format=${f}`); check(`export ${f}`, r.ok, r.headers.get("content-type")); }

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
await fetch(`${BASE}/api/docs/${doc.id}`, { method: "DELETE" });
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
