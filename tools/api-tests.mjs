// Server robustness tests: node tools/api-tests.mjs  (server must be running on PICTOCITY_URL or :4100)
import WebSocket from "ws";
const BASE = process.env.PICTOCITY_URL ?? "http://localhost:4100";
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };
const j = async (path, init) => { const r = await fetch(BASE + path, init); let body = null; try { body = await r.clone().json(); } catch { body = await r.text(); } return { status: r.status, body, headers: r.headers }; };
const post = (path, body, headers = {}) => j(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

// ---- Basic error handling -------------------------------------------------------------
check("unknown route is 404", (await j("/api/nothing-here")).status === 404);
check("missing document is 404", (await j("/api/docs/doc_nope")).status === 404);
check("bad JSON is 400, not 500", (await post("/api/docs", "{not json")).status === 400);
{ const r = await post("/api/docs", { name: "x" }); check("document without a size gets defaults", r.status === 201 && r.body?.width > 0); if (r.body?.id) await j(`/api/docs/${r.body.id}`, { method: "DELETE" }); }
check("absurd size is rejected", (await post("/api/docs", { name: "x", width: 1e9, height: 10 })).status >= 400);

const doc = (await post("/api/docs", { name: "api-test", width: 400, height: 300, background: "#fff" })).body;
check("create document", !!doc?.id);
const layer = { type: "shape", id: "s1", name: "Box", shape: "rect", x: 10, y: 10, width: 100, height: 80, fill: "#f00", strokeColor: null, strokeWidth: 0, visible: true, locked: false, opacity: 1, blend: "normal", rotation: 0, scaleX: 1, scaleY: 1 };
const ok1 = await post(`/api/docs/${doc.id}/ops`, { actor: "t", ops: [{ type: "layer.add", layer, parentId: null, index: 0 }] });
check("apply op", ok1.status === 200 && ok1.body.rev === 1, JSON.stringify(ok1.body).slice(0, 100));

// ---- Validation through the API -------------------------------------------------------
check("NaN through JSON (null) on a required prop is rejected", (await post(`/api/docs/${doc.id}/ops`, { actor: "t", ops: [{ type: "layer.set", id: "s1", props: { x: null } }] })).status === 400);
check("unknown op type is rejected", (await post(`/api/docs/${doc.id}/ops`, { actor: "t", ops: [{ type: "layer.explode", id: "s1" }] })).status === 400);
check("ops must be an array", (await post(`/api/docs/${doc.id}/ops`, { actor: "t", ops: "nope" })).status === 400);
check("op on a missing layer is rejected and the rev is unchanged", (await post(`/api/docs/${doc.id}/ops`, { actor: "t", ops: [{ type: "layer.set", id: "ghost", props: { x: 1 } }] })).status === 400 && (await j(`/api/docs/${doc.id}`)).body.rev === 1);
check("a batch is atomic: a bad op in the middle applies nothing", (await post(`/api/docs/${doc.id}/ops`, { actor: "t", ops: [{ type: "layer.set", id: "s1", props: { x: 99 } }, { type: "layer.set", id: "ghost", props: { x: 1 } }] })).status === 400 && (await j(`/api/docs/${doc.id}`)).body.layers[0].x === 10);
check("locked layer refuses edits", await (async () => { await post(`/api/docs/${doc.id}/ops`, { actor: "t", ops: [{ type: "layer.set", id: "s1", props: { locked: true } }] }); const r = await post(`/api/docs/${doc.id}/ops`, { actor: "t", ops: [{ type: "layer.set", id: "s1", props: { x: 50 } }] }); await post(`/api/docs/${doc.id}/ops`, { actor: "t", ops: [{ type: "layer.set", id: "s1", props: { locked: false } }] }); return r.status === 400 || r.status === 409; })());

// ---- Abuse limits ---------------------------------------------------------------------
const big = await j(`/api/docs/${doc.id}/render.png?scale=1000`);
check("huge render scale is clamped, not a crash", big.status === 200 || big.status === 400, `status ${big.status}`);
const gifAbuse = await j(`/api/docs/${doc.id}/export?format=gif&fps=100000`);
check("absurd fps is clamped", gifAbuse.status === 200 || gifAbuse.status === 400, `status ${gifAbuse.status}`);
check("quality out of range is tolerated", (await j(`/api/docs/${doc.id}/export?format=jpg&quality=999`)).status === 200);
check("negative scale is rejected or clamped", [200, 400].includes((await j(`/api/docs/${doc.id}/export?format=png&scale=-2`)).status));
check("unknown export format is 400", (await j(`/api/docs/${doc.id}/export?format=exe`)).status === 400);
check("path traversal in asset URLs is blocked", (await j("/assets/..%2F..%2Fpackage.json")).status === 404);
check("server still healthy after abuse", (await j("/api/health")).status === 200);

// ---- Concurrency: two writers, sequential revs, no lost ops -----------------------------
{
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => post(`/api/docs/${doc.id}/ops`, { actor: `t${i % 2}`, ops: [{ type: "layer.set", id: "s1", props: { x: 10 + i } }] })));
  const revs = burst.map((r) => r.body.rev).sort((a, b) => a - b);
  check("20 concurrent ops all applied with distinct sequential revs", burst.every((r) => r.status === 200) && new Set(revs).size === 20 && revs[19] - revs[0] === 19, revs.join(","));
  const hist = (await j(`/api/docs/${doc.id}/history`)).body;
  check("history contains every applied op", Array.isArray(hist) && hist.length >= 20);
}

// ---- WebSocket: malformed messages don't kill the socket; subscribe + ops + rejection ------
{
  const url = BASE.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(url);
  const msgs = [];
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.on("message", (m) => msgs.push(JSON.parse(m)));
  ws.send("this is not json");
  ws.send(JSON.stringify({ kind: "wat" }));
  ws.send(JSON.stringify({ kind: "subscribe", docId: "doc_nope" }));
  ws.send(JSON.stringify({ kind: "subscribe", docId: doc.id }));
  await new Promise((r) => setTimeout(r, 400));
  check("socket survives garbage and unknown messages", ws.readyState === WebSocket.OPEN);
  check("subscribe returns a snapshot", msgs.some((m) => m.kind === "snapshot" && m.doc?.id === doc.id));
  ws.send(JSON.stringify({ kind: "ops", envelope: { docId: doc.id, actor: "ws-test", ops: [{ type: "layer.set", id: "ghost", props: { x: 1 } }] }, clientRev: 0 }));
  ws.send(JSON.stringify({ kind: "ops", envelope: { docId: doc.id, actor: "ws-test", ops: [{ type: "layer.set", id: "s1", props: { y: 77 } }] }, clientRev: 0 }));
  await new Promise((r) => setTimeout(r, 400));
  check("bad op over the socket is rejected with a reason", msgs.some((m) => m.kind === "rejected" && typeof m.reason === "string"));
  check("good op over the socket is applied and echoed", msgs.some((m) => m.kind === "applied" && m.applied?.ops?.[0]?.props?.y === 77));
  ws.close();
}

// ---- Persistence: the document on disk is valid JSON after a burst of writes -------------
{
  const health = (await j("/api/health")).body;
  if (health.paths?.data) {
    const { readFileSync, existsSync } = await import("node:fs");
    const file = `${health.paths.data}/docs/${doc.id}.json`;
    let valid = false; try { valid = existsSync(file) && JSON.parse(readFileSync(file, "utf8")).id === doc.id; } catch { valid = false; }
    check("document file on disk is valid JSON", valid);
    const { readdirSync } = await import("node:fs");
    check("no temp files left behind by atomic writes", !readdirSync(`${health.paths.data}/docs`).some((f) => f.endsWith(".tmp")));
  }
}

// ---- Cleanup -----------------------------------------------------------------------------
check("delete document", (await j(`/api/docs/${doc.id}`, { method: "DELETE" })).status === 200);
check("deleted document is gone", (await j(`/api/docs/${doc.id}`)).status === 404);
console.log(`\n${fail === 0 ? "all api tests passed" : `${fail} failure(s)`} (${pass} ok)`);
process.exit(fail ? 1 : 0);
