// First-run environment check: node tools/doctor.mjs
// Verifies the pieces pictocity depends on and prints what to fix, so a fresh machine fails fast with a reason.
import { existsSync, readdirSync, accessSync, constants, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Fixed 2026-09-07. Was: resolve(new URL("..", import.meta.url).pathname).
// On Windows .pathname yields "/C:/Users/.../pictocity/", and resolve() on a
// leading-slash path prepends the CWD's drive, producing
// "C:\C:\Users\...\pictocity". Every existsSync/accessSync below then failed,
// so the doctor reported 5 problems on a healthy install: editor not built,
// no fonts, data unwritable. All false -- every package has a dist/, fonts/
// holds three Poppins faces, data/ is writable.
//
// packages/server/src/index.ts:16 already does this correctly with
// fileURLToPath, which is why the SERVER resolved its paths fine while the
// doctor that checks it did not. Trust the server, and now the doctor too.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
let problems = 0;
const ok = (msg) => console.log(`ok    ${msg}`);
const bad = (msg, fix) => { problems++; console.log(`FAIL  ${msg}${fix ? `\n      → ${fix}` : ""}`); };
const warn = (msg, fix) => console.log(`warn  ${msg}${fix ? `\n      → ${fix}` : ""}`);

// Node version
const [major] = process.versions.node.split(".").map(Number);
if (major >= 20) ok(`node ${process.versions.node}`); else bad(`node ${process.versions.node} is too old`, "install Node 20 or newer (22 recommended)");

// Builds present
for (const p of ["core", "server", "mcp"]) { if (existsSync(`${root}/packages/${p}/dist/index.js`)) ok(`packages/${p} is built`); else bad(`packages/${p} isn't built`, "run: npm run build"); }
if (existsSync(`${root}/packages/editor/dist/index.html`)) ok("editor is built"); else bad("editor isn't built", "run: npm run build");

// Native canvas
try { const { createCanvas } = await import("@napi-rs/canvas"); const c = createCanvas(4, 4); c.getContext("2d").fillRect(0, 0, 4, 4); c.toBuffer("image/png"); ok(`@napi-rs/canvas works on ${process.platform}/${process.arch}`); }
catch (e) { bad(`@napi-rs/canvas failed to load: ${e.message.split("\n")[0]}`, "run: npm install  (the package ships prebuilt binaries for common platforms; on unusual ones install build tools)"); }

// Fonts
const fontsDir = process.env.PICTOCITY_FONTS ?? `${root}/fonts`;
const fonts = existsSync(fontsDir) ? readdirSync(fontsDir).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f)) : [];
if (fonts.length) ok(`${fonts.length} font file(s) in ${fontsDir}`); else warn(`no fonts in ${fontsDir}`, "drop .ttf/.otf files there (or File › Install font in the editor) so previews and exports match");

// Data dir writable
const dataDir = process.env.PICTOCITY_DATA ?? `${root}/data`;
try { mkdirSync(dataDir, { recursive: true }); accessSync(dataDir, constants.W_OK); ok(`data directory writable: ${dataDir}`); } catch { bad(`cannot write to ${dataDir}`, "set PICTOCITY_DATA to a writable folder"); }

// Port
const port = Number(process.env.PICTOCITY_PORT ?? 4100);
await new Promise((res) => { const srv = createServer(); srv.once("error", (e) => { if (e.code === "EADDRINUSE") warn(`port ${port} is already in use`, "another pictocity (or something else) is running; set PICTOCITY_PORT to change it"); else bad(`cannot bind port ${port}: ${e.code}`); res(); }); srv.listen(port, () => { ok(`port ${port} is free`); srv.close(res); }); });

// Image tools config
const tools = process.env.PICTOCITY_IMAGE_TOOLS ?? `${root}/image-tools.json`;
// Fixed 2026-09-07, twice over.
// (1) await import() of a BARE Windows path throws ERR_UNSUPPORTED_ESM_URL_SCHEME
//     -- it reads "C:" as a protocol. Dynamic import needs a file:// URL.
// (2) the bare `catch` then blamed the file: it reported "isn't valid JSON"
//     for a config that parses perfectly ({}, 3 bytes). A check that cannot
//     run must not report a finding about the thing it failed to inspect.
//     The real error is now printed, so the next wrong guess is impossible.
if (existsSync(tools)) {
  try {
    const { default: cfg } = await import(pathToFileURL(tools).href, { with: { type: "json" } });
    ok(`image-tools.json: ${Object.keys(cfg).length} external tool(s)`);
  } catch (e) {
    warn(`image-tools.json could not be loaded: ${e.code || e.message}`, "see image-tools.example.json");
  }
} else warn("no image-tools.json (only the built-in knockout tool will be available)", "copy image-tools.example.json and point entries at your models/CLIs");

// Token
if (process.env.PICTOCITY_TOKEN) ok("PICTOCITY_TOKEN set — API and WebSocket require it"); else warn("no PICTOCITY_TOKEN", "fine on localhost; set one before exposing the server on a network");

console.log(problems ? `\n${problems} problem(s) to fix before starting.` : "\nAll good. Start with: npm run server   (then open http://localhost:" + port + ")");
process.exit(problems ? 1 : 0);
