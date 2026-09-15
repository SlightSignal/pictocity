// Extra export encoders the canvas engine doesn't provide: TIFF, BMP, PDF (one page per image), PNG-8.
import { deflateSync } from "node:zlib";

/** Uncompressed 8-bit RGBA TIFF (little-endian). */
export function encodeTiff(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const entries: [number, number, number, number | Buffer][] = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, 4, Buffer.from(Uint16Array.from([8, 8, 8, 8]).buffer)], [259, 3, 1, 1], [262, 3, 1, 2],
    [273, 4, 1, 0 /* strip offset, patched */], [277, 3, 1, 4], [278, 4, 1, height], [279, 4, 1, pixels.length], [284, 3, 1, 1], [338, 3, 1, 2],
  ];
  const ifdOffset = 8, ifdSize = 2 + entries.length * 12 + 4;
  let extraOffset = ifdOffset + ifdSize; const extras: Buffer[] = [];
  const ifd = Buffer.alloc(ifdSize); ifd.writeUInt16LE(entries.length, 0);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 2 + i * 12; ifd.writeUInt16LE(tag, o); ifd.writeUInt16LE(type, o + 2); ifd.writeUInt32LE(count, o + 4);
    if (Buffer.isBuffer(value)) { ifd.writeUInt32LE(extraOffset, o + 8); extras.push(value); extraOffset += value.length + (value.length % 2); }
    else if (type === 3) ifd.writeUInt16LE(value, o + 8); else ifd.writeUInt32LE(value, o + 8);
  });
  const stripOffset = extraOffset;
  ifd.writeUInt32LE(stripOffset, 2 + 5 * 12 + 8); // patch tag 273
  const header = Buffer.alloc(8); header.write("II", 0, "ascii"); header.writeUInt16LE(42, 2); header.writeUInt32LE(ifdOffset, 4);
  const padded = extras.map((b) => (b.length % 2 ? Buffer.concat([b, Buffer.alloc(1)]) : b));
  return Buffer.concat([header, ifd, ...padded, pixels]);
}

/** 32-bit BGRA BMP (bottom-up), alpha kept. */
export function encodeBmp(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const rowSize = width * 4, dataSize = rowSize * height, headerSize = 14 + 108;
  const buf = Buffer.alloc(headerSize + dataSize);
  buf.write("BM", 0, "ascii"); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(headerSize, 10);
  buf.writeUInt32LE(108, 14); buf.writeInt32LE(width, 18); buf.writeInt32LE(height, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(32, 28); buf.writeUInt32LE(3, 30); buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(2835, 38); buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0x00ff0000, 54); buf.writeUInt32LE(0x0000ff00, 58); buf.writeUInt32LE(0x000000ff, 62); buf.writeUInt32LE(0xff000000, 66); buf.write("BGRs", 70, "ascii");
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const si = ((height - 1 - y) * width + x) * 4, di = headerSize + y * rowSize + x * 4;
    buf[di] = rgba[si + 2]; buf[di + 1] = rgba[si + 1]; buf[di + 2] = rgba[si]; buf[di + 3] = rgba[si + 3];
  }
  return buf;
}

/** PDF with one page per image (JPEG-encoded pages for photos, Flate RGB otherwise). Sizes in points at the given DPI. */
export function encodePdf(pages: { width: number; height: number; jpeg?: Buffer; rgb?: Buffer; title?: string }[], dpi = 72): Buffer {
  const objs: Buffer[] = []; const add = (b: Buffer | string) => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1")); return objs.length; };
  const pageIds: number[] = []; const pagesId = 2;
  add("<< /Type /Catalog /Pages 2 0 R >>"); add("PLACEHOLDER");
  for (const p of pages) {
    const w = (p.width / dpi) * 72, h = (p.height / dpi) * 72;
    const data = p.jpeg ?? deflateSync(p.rgb!);
    const imgId = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${p.jpeg ? "DCTDecode" : "FlateDecode"} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
    const content = `q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} 0 0 cm /Im${imgId} Do Q`;
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${w.toFixed(3)} ${h.toFixed(3)}] /Resources << /XObject << /Im${imgId} ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`, "latin1");
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")]; const offsets: number[] = []; let pos = parts[0].length;
  objs.forEach((o, i) => { offsets.push(pos); const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), o, Buffer.from("\nendobj\n", "latin1")]); parts.push(chunk); pos += chunk.length; });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

/** Indexed (palette) PNG with alpha, for ad platforms with tight weight limits. `index` and `palette` come from gifenc. */
export function encodePng8(width: number, height: number, index: Uint8Array, palette: number[][]): Buffer {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  const crc = (buf: Buffer) => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const plte = Buffer.alloc(palette.length * 3), trns = Buffer.alloc(palette.length);
  palette.forEach((c, i) => { plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2]; trns[i] = c.length > 3 ? c[3] : 255; });
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width + 1)] = 0; for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = index[y * width + x]; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("PLTE", plte), chunk("tRNS", trns), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
