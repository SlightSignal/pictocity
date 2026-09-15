// Builds a sample ad through the HTTP API - the same calls the MCP server makes -
// then exports it. Run the server first: npm run server && npm run demo
import { createCanvas } from "@napi-rs/canvas";
import { makeText, makeShape, makeImage, makeFill, makeGroup, type Op } from "@pictocity/core";

const BASE = process.env.PICTOCITY_URL ?? "http://localhost:4100";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, { headers: { "content-type": "application/json" }, ...init });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path}: ${body.error ?? r.status}`);
  return body as T;
}

/** A stand-in "product photo": a rendered coffee cup, so the demo has no external dependencies. */
function productImage(): Buffer {
  const c = createCanvas(800, 800); const ctx = c.getContext("2d");
  const bg = ctx.createLinearGradient(0, 0, 0, 800); bg.addColorStop(0, "#f5efe6"); bg.addColorStop(1, "#d9c7ae");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 800, 800);
  ctx.fillStyle = "rgba(0,0,0,0.12)"; ctx.beginPath(); ctx.ellipse(400, 640, 230, 50, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#2b1d16"; ctx.beginPath(); ctx.moveTo(250, 300); ctx.lineTo(550, 300); ctx.lineTo(510, 620); ctx.lineTo(290, 620); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#2b1d16"; ctx.lineWidth = 34; ctx.beginPath(); ctx.arc(560, 430, 80, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  ctx.fillStyle = "#e9dccb"; ctx.beginPath(); ctx.ellipse(400, 300, 150, 40, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#5a3a2a"; ctx.beginPath(); ctx.ellipse(400, 300, 120, 28, 0, 0, Math.PI * 2); ctx.fill();
  return c.toBuffer("image/png");
}

const doc = await api<{ id: string }>("/api/docs", { method: "POST", body: JSON.stringify({ name: "Roast & Co - summer promo", width: 1080, height: 1350, background: "#0f1a1c" }) });
console.log("created document", doc.id);

const asset = await api<{ id: string; width: number; height: number }>(`/api/docs/${doc.id}/assets`, {
  method: "POST", body: JSON.stringify({ name: "cup.png", mime: "image/png", base64: productImage().toString("base64") }),
});
console.log("uploaded asset", asset.id);

const ops: Op[] = [
  { type: "layer.add", parentId: null, index: 0, layer: makeFill({ name: "Backdrop gradient", width: 1080, height: 1350, fill: { kind: "linear", from: "#123c3a", to: "#0f1a1c", angle: 160 } }) },
  { type: "layer.add", parentId: null, index: 1, layer: makeShape({ name: "Sun disc", shape: "ellipse", x: 560, y: 120, width: 640, height: 640, fill: "#f2b24a", blend: "screen", opacity: 0.9,
      styles: { outerGlow: { enabled: true, color: "#f2b24a", size: 60, opacity: 0.6 } } }) },
  { type: "layer.add", parentId: null, index: 2, layer: makeImage({ name: "Product", assetId: asset.id, x: 140, y: 300, width: 800, height: 800, fit: "cover", rotation: -6,
      mask: { kind: "shape", shape: "ellipse", x: 0, y: 0, width: 800, height: 800, feather: 6 },
      styles: { dropShadow: { enabled: true, color: "#000000", blur: 40, x: 0, y: 30, opacity: 0.55 } }, tags: ["product"] }) },
  { type: "layer.add", parentId: null, index: 3, layer: makeGroup({ name: "Copy", children: [
      makeText({ text: "Cold brew.\nHot summer.", name: "Headline", x: 80, y: 90, width: 760, height: 260, fontFamily: "Poppins", fontSize: 108, fontWeight: 700, color: "#fff7ea", lineHeight: 1.0, letterSpacing: -3, tags: ["headline"],
        styles: { dropShadow: { enabled: true, color: "#000000", blur: 24, x: 0, y: 12, opacity: 0.35 } } }),
      makeText({ text: "Two for one on every cold brew, all of July.", name: "Subhead", x: 80, y: 1090, width: 620, height: 120, fontFamily: "Poppins", fontSize: 38, fontWeight: 400, color: "#d8e6e2", lineHeight: 1.25, tags: ["subhead"] }),
      makeShape({ name: "CTA button", shape: "rect", x: 760, y: 1120, width: 240, height: 84, radius: 42, fill: "#f2b24a", tags: ["cta"],
        styles: { dropShadow: { enabled: true, color: "#f2b24a", blur: 30, x: 0, y: 8, opacity: 0.45 } } }),
      makeText({ text: "Order now", name: "CTA label", x: 760, y: 1120, width: 240, height: 84, fontFamily: "Poppins", fontSize: 30, fontWeight: 700, color: "#1a1208", align: "center", verticalAlign: "middle", tags: ["cta"] }),
      makeText({ text: "ROAST & CO", name: "Brand", x: 80, y: 1260, width: 400, height: 40, fontFamily: "Poppins", fontSize: 22, fontWeight: 700, color: "#f2b24a", letterSpacing: 6, tags: ["logo"] }),
  ] }) },
];

const applied = await api<{ rev: number }>(`/api/docs/${doc.id}/ops`, { method: "POST", body: JSON.stringify({ ops, actor: "agent:demo", label: "Build summer promo" }) });
console.log("applied ops, rev", applied.rev);

const exported = await api<{ path: string; bytes: number }>(`/api/docs/${doc.id}/export`, { method: "POST", body: JSON.stringify({ format: "png", scale: 1 }) });
console.log("exported", exported.path, `${(exported.bytes / 1024).toFixed(0)} KB`);
console.log(`open the editor at ${BASE}/?doc=${doc.id}`);
