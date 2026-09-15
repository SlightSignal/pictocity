import type { Layer } from "@pictocity/core";
import { toLocal } from "@pictocity/core";

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLE_ANCHOR: Record<Handle, [number, number]> = { se: [0, 0], nw: [1, 1], ne: [0, 1], sw: [1, 0], e: [0, 0.5], w: [1, 0.5], n: [0.5, 1], s: [0.5, 0] };

export function localToDoc(l: Layer, q: { x: number; y: number }) {
  const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
  const r = (l.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = (q.x - l.width / 2) * l.scaleX, dy = (q.y - l.height / 2) * l.scaleY;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** New geometry for a handle drag; keeps the opposite side (or centre with alt) pinned even when rotated. */
export function scaleProps(l0: Layer, h: Handle, p: { x: number; y: number }, shift: boolean, alt: boolean): Record<string, unknown> {
  const q = toLocal(l0, p);
  const w0 = l0.width, h0 = l0.height;
  let [ax, ay] = HANDLE_ANCHOR[h];
  if (alt) { ax = 0.5; ay = 0.5; }
  let nw = w0, nh = h0;
  const horiz = h.includes("e") || h.includes("w"), vert = h.includes("n") || h.includes("s");
  if (horiz) nw = alt ? Math.abs(q.x - w0 / 2) * 2 : h.includes("e") ? q.x : w0 - q.x;
  if (vert) nh = alt ? Math.abs(q.y - h0 / 2) * 2 : h.includes("s") ? q.y : h0 - q.y;
  const corner = horiz && vert;
  const proportional = corner ? !shift : false;
  let s = 1;
  if (proportional) { s = Math.max(nw / w0, nh / h0); nw = w0 * s; nh = h0 * s; }
  nw = Math.max(1, nw); nh = Math.max(1, nh);
  const anchorDoc = localToDoc(l0, { x: ax * w0, y: ay * h0 });
  const r = (l0.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const ox = (0.5 - ax) * nw * l0.scaleX, oy = (0.5 - ay) * nh * l0.scaleY;
  const cx = anchorDoc.x + ox * cos - oy * sin, cy = anchorDoc.y + ox * sin + oy * cos;
  const props: Record<string, unknown> = { x: Math.round((cx - nw / 2) * 10) / 10, y: Math.round((cy - nh / 2) * 10) / 10, width: Math.round(nw * 10) / 10, height: Math.round(nh * 10) / 10 };
  if (l0.type === "text" && proportional) { props.fontSize = Math.max(1, Math.round(l0.fontSize * s * 10) / 10); props.letterSpacing = Math.round(l0.letterSpacing * s * 10) / 10; }
  return props;
}


// ---- Multi-layer / group transforms ---------------------------------------------------
// Photoshop shows one axis-aligned box around several layers (or a group) and transforms
// all of them together. We treat that box as a virtual layer and map every member into
// the new box.

export interface Box { x: number; y: number; width: number; height: number }

export function virtualLayer(box: Box): Layer {
  return { id: "__box", name: "", type: "shape", visible: true, locked: false, opacity: 1, blend: "normal", x: box.x, y: box.y, width: box.width, height: box.height, rotation: 0, scaleX: 1, scaleY: 1, shape: "rect", fill: null, strokeColor: null, strokeWidth: 0 } as Layer;
}

/** Props for each member after the selection box goes from `from` to `to`. */
export function mapMembersToBox(members: Layer[], from: Box, to: Box, proportional: boolean): { id: string; props: Record<string, unknown> }[] {
  const sx = to.width / Math.max(1e-6, from.width), sy = to.height / Math.max(1e-6, from.height);
  const s = proportional ? Math.max(sx, sy) : Math.min(sx, sy);
  return members.map((l) => {
    const props: Record<string, unknown> = {
      x: r1(to.x + (l.x - from.x) * sx), y: r1(to.y + (l.y - from.y) * sy),
      width: r1(Math.max(1, l.width * sx)), height: r1(Math.max(1, l.height * sy)),
    };
    if (l.type === "text") { props.fontSize = r1(Math.max(1, l.fontSize * s)); props.letterSpacing = r1(l.letterSpacing * s); }
    if (l.type === "shape") { if (l.radius) props.radius = r1(l.radius * s); if (l.strokeWidth) props.strokeWidth = r1(l.strokeWidth * s); }
    if (l.type === "brush") props.strokes = l.strokes.map((st) => ({ ...st, size: st.size * s, points: st.points.map((v, i) => (i % 2 ? v * sy : v * sx)) }));
    return { id: l.id, props };
  });
}

/** Rotate every member around the selection box centre by `delta` degrees. */
export function rotateMembers(members: Layer[], center: { x: number; y: number }, delta: number): { id: string; props: Record<string, unknown> }[] {
  const a = (delta * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return members.map((l) => {
    const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
    const dx = cx - center.x, dy = cy - center.y;
    const nx = center.x + dx * cos - dy * sin, ny = center.y + dx * sin + dy * cos;
    let rot = l.rotation + delta;
    rot = ((rot + 180) % 360 + 360) % 360 - 180;
    return { id: l.id, props: { x: r1(nx - l.width / 2), y: r1(ny - l.height / 2), rotation: r1(rot) } };
  });
}

const r1 = (v: number) => Math.round(v * 10) / 10;
