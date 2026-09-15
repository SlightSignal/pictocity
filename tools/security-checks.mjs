// Verifies the two boundary fixes of 2026-09-07. Run against a server started
// WITH a token:  PICTOCITY_TOKEN=... PICTOCITY_PORT=... node tools/security-checks.mjs
//
// 1. static data routes honour the token. /exports/, /assets/ and /fonts/ used
//    to sit outside the guard, so every rendered ad was readable unauthenticated
//    even when the operator had set a token.
// 2. a socket may only write to the document it subscribed to. The envelope's
//    docId was never compared with the subscription, so a client on document A
//    could mutate document B -- silently, because the broadcast matches on the
//    applied document's id.
import WebSocket from "ws";

const PORT = Number(process.env.PICTOCITY_PORT ?? 4100);
const TOKEN = process.env.PICTOCITY_TOKEN ?? "";
const BASE = `http://127.0.0.1:${PORT}`;
let fails = 0;
const ok = (m) => console.log(`ok    ${m}`);
const bad = (m) => { fails++; console.log(`FAIL  ${m}`); };

async function status(path, withToken) {
  const url = BASE + path + (withToken ? (path.includes("?") ? "&" : "?") + "token=" + TOKEN : "");
  try {
    const r = await fetch(url, { redirect: "manual" });
    return r.status;
  } catch (e) { return `ERR ${e.message}`; }
}

if (!TOKEN) { console.log("CANNOT_RUN: start the server with PICTOCITY_TOKEN set, and pass the same value here"); process.exit(2); }

// --- 1. static routes ------------------------------------------------------
const docs = await fetch(`${BASE}/api/docs?token=${TOKEN}`).then((r) => r.json()).catch(() => []);
const list = Array.isArray(docs) ? docs : docs.docs ?? [];
if (list.length) {
  const e = await fetch(`${BASE}/api/docs/${list[0].id}/export?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json()).catch(() => null);
  const name = e?.url ? e.url.split("/").pop() : null;
  if (name) {
    const noTok = await status(`/exports/${name}`, false);
    const withTok = await status(`/exports/${name}`, true);
    if (noTok === 401) ok(`/exports/ refuses without the token (${noTok})`); else bad(`/exports/ served ${noTok} WITHOUT a token — data is readable`);
    if (withTok === 200) ok(`/exports/ still serves with the token (${withTok})`); else bad(`/exports/ returned ${withTok} WITH the token — the fix broke legitimate access`);
  } else bad("could not produce an export to test against");
} else bad("no documents to test against");

for (const p of ["/assets/nothing.png", "/fonts/nothing.ttf"]) {
  const s = await status(p, false);
  if (s === 401) ok(`${p} refuses without the token`); else bad(`${p} returned ${s} without a token (expected 401)`);
}
// the editor shell must stay reachable, or nobody can be told they need a token
const shell = await status("/", false);
if (shell === 200) ok("editor shell still loads without a token (deliberate)"); else bad(`editor shell returned ${shell} — the guard is too wide`);

// --- 2. cross-document write ----------------------------------------------
if (list.length >= 2) {
  const [a, b] = list;
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    let phase = "subscribe";
    const done = (fn) => { try { ws.close(); } catch {} fn(); resolve(); };
    ws.on("open", () => ws.send(JSON.stringify({ kind: "subscribe", docId: a.id })));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (phase === "subscribe" && m.kind === "snapshot") {
        phase = "attack";
        // subscribed to A; try to write to B
        ws.send(JSON.stringify({ kind: "ops", envelope: { docId: b.id, ops: [{ type: "doc.set", props: { name: "PWNED" } }], actor: "probe", label: "cross-doc" }, clientRev: 0 }));
        setTimeout(() => done(() => bad("cross-document write drew NO response — cannot confirm it was refused")), 4000);
      } else if (phase === "attack") {
        if (m.kind === "rejected") done(() => ok(`cross-document write refused: ${String(m.reason).slice(0, 70)}`));
        else done(() => bad(`cross-document write was ACCEPTED (${m.kind})`));
      }
    });
    ws.on("error", (e) => done(() => bad(`socket error: ${e.message}`)));
  });
  // and prove B was not modified
  const after = await fetch(`${BASE}/api/docs/${b.id}?token=${TOKEN}`).then((r) => r.json()).catch(() => null);
  const nm = (after?.doc ?? after)?.name;
  if (nm !== "PWNED") ok(`target document unchanged (name still ${JSON.stringify(nm)})`); else bad("target document WAS modified");
} else bad("need two documents to test cross-document writes");

console.log(fails ? `\n${fails} security check(s) FAILED` : "\nall security checks passed");
process.exit(fails ? 1 : 0);
