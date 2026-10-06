import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateSync, brotliDecompressSync } from "node:zlib";

export type FontStyle = "normal" | "italic" | "oblique";
export interface FontMetadata {
  family: string; weight: number; style: FontStyle; stretch: string;
  source: "sfnt" | "woff" | "woff2"; diagnostics: string[];
}
export interface FontInspection { metadata: FontMetadata | null; sha256: string; diagnostics: string[] }
// Native registration is also bounded. Metadata reads do not copy an entire SFNT.
export const MAX_FONT_BYTES = 64 * 1024 * 1024;
const MAX_TABLE_BYTES = 1024 * 1024, MAX_WOFF2_BYTES = 32 * 1024 * 1024, MAX_TABLES = 256;
interface Reader { size: number; read(offset: number, length: number): Buffer }
interface Table { offset: number; length: number; original: number; transformed?: boolean }
const fail = (message: string): never => { throw new Error(message); };
function bounds(offset: number, length: number, size: number) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > size || length > size - offset) fail("Font table range is outside the input");
}
function bufferReader(bytes: Buffer): Reader {
  return { size: bytes.length, read(offset, length) { bounds(offset, length, bytes.length); return bytes.subarray(offset, offset + length); } };
}
const widths = ["", "ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded"];
const woff2Tags = "cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill".split(" ").map(t => t.replace(/_/g, " "));

/** Parse only name, OS/2 and variation-presence data, with validated directories. */
function metadataFrom(reader: Reader): FontMetadata {
  if (reader.size < 12 || reader.size > MAX_FONT_BYTES) fail("Font input is truncated or exceeds the 64 MiB limit");
  const signature = reader.read(0, 4).toString("latin1"), tables = new Map<string, Table>();
  let source: FontMetadata["source"] = "sfnt", tableReader = reader;
  const add = (tag: string, table: Table, dataStart: number) => {
    if (tables.has(tag)) fail("Duplicate font table: " + tag);
    if (table.offset < dataStart) fail("Font table overlaps its directory");
    bounds(table.offset, table.length, tableReader.size); tables.set(tag, table);
  };
  if (signature === "wOF2") {
    source = "woff2";
    const header = reader.read(0, 48), count = header.readUInt16BE(12), compressed = header.readUInt32BE(20);
    if (header.readUInt32BE(8) !== reader.size || header.readUInt16BE(14) !== 0 || count < 1 || count > MAX_TABLES || header.toString("latin1", 4, 8) === "ttcf") fail("Invalid or unsupported WOFF2 header/collection");
    let cursor = 48, streamSize = 0, sfntSize = 12 + count * 16;
    const byte = () => reader.read(cursor++, 1)[0];
    const base128 = () => {
      let value = 0;
      for (let i = 0; i < 5; i++) {
        const b = byte(); if (i === 0 && b === 0x80) fail("Noncanonical WOFF2 integer");
        if (value > 0x1ffffff) fail("Overflowing WOFF2 integer");
        value = value * 128 + (b & 127); if (!(b & 128)) return value;
      }
      return fail("Overlong WOFF2 integer");
    };
    const directory: [string, Table][] = [];
    for (let i = 0; i < count; i++) {
      const flags = byte(), index = flags & 63, version = flags >>> 6;
      const tag = index === 63 ? reader.read(cursor, 4).toString("latin1") : woff2Tags[index];
      if (index === 63) cursor += 4;
      const original = base128(), glyf = tag === "glyf" || tag === "loca";
      if (glyf && version !== 0 && version !== 3) fail("Unsupported WOFF2 outline transform");
      const transformed = glyf ? version === 0 : version !== 0;
      const length = transformed ? base128() : original;
      if (tag === "loca" && transformed && length !== 0) fail("Invalid WOFF2 loca transform length");
      directory.push([tag, { offset: streamSize, length, original, transformed }]);
      streamSize += length; sfntSize += Math.ceil(original / 4) * 4;
      if (streamSize > MAX_WOFF2_BYTES) fail("WOFF2 decoded stream exceeds the 32 MiB limit");
    }
    if (header.readUInt32BE(16) !== sfntSize || sfntSize > MAX_FONT_BYTES) fail("Invalid WOFF2 SFNT size");
    bounds(cursor, compressed, reader.size);
    if (!compressed || compressed > MAX_WOFF2_BYTES) fail("WOFF2 compressed stream exceeds the work limit");
    const decoded = brotliDecompressSync(reader.read(cursor, compressed), { maxOutputLength: MAX_WOFF2_BYTES });
    if (decoded.length !== streamSize) fail("WOFF2 decoded stream length mismatch");
    tableReader = bufferReader(decoded);
    for (const [tag, table] of directory) add(tag, table, 0);
  } else if (signature === "wOFF") {
    source = "woff";
    const header = reader.read(0, 44), count = header.readUInt16BE(12);
    if (header.readUInt32BE(8) !== reader.size || header.readUInt16BE(14) !== 0 || count < 1 || count > MAX_TABLES || ![0x00010000, 0x4f54544f, 0x74727565].includes(header.readUInt32BE(4))) fail("Invalid WOFF header");
    const start = 44 + count * 20, directory = reader.read(44, count * 20);
    let sfntSize = 12 + count * 16;
    for (let i = 0; i < count; i++) {
      const p = i * 20, length = directory.readUInt32BE(p + 8), original = directory.readUInt32BE(p + 12);
      if (length > original) fail("Invalid WOFF compressed table length");
      add(directory.toString("latin1", p, p + 4), { offset: directory.readUInt32BE(p + 4), length, original }, start);
      sfntSize += Math.ceil(original / 4) * 4;
    }
    if (sfntSize !== header.readUInt32BE(16) || sfntSize > MAX_FONT_BYTES) fail("Invalid WOFF SFNT size");
  } else {
    const header = reader.read(0, 12), count = header.readUInt16BE(4);
    if (![0x00010000, 0x4f54544f, 0x74727565].includes(header.readUInt32BE(0)) || count < 1 || count > MAX_TABLES) fail("Unsupported SFNT signature or table count");
    const start = 12 + count * 16, directory = reader.read(12, count * 16);
    for (let i = 0; i < count; i++) {
      const p = i * 16, length = directory.readUInt32BE(p + 12);
      add(directory.toString("latin1", p, p + 4), { offset: directory.readUInt32BE(p + 8), length, original: length }, start);
    }
  }
  // Overlapping nonempty tables are malformed (zero-length WOFF2 loca is allowed).
  const ranges = [...tables.values()].filter(t => t.length).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].offset + ranges[i - 1].length) fail("Overlapping font tables");
  const table = (tag: string) => {
    const t = tables.get(tag); if (!t) return fail("Missing font metadata table: " + tag);
    if (t.transformed || t.original > MAX_TABLE_BYTES || t.length > MAX_TABLE_BYTES) fail("Unsupported or oversized metadata table: " + tag);
    const raw = tableReader.read(t.offset, t.length);
    const decoded = source === "woff" && t.length < t.original ? inflateSync(raw, { maxOutputLength: t.original }) : raw;
    if (decoded.length !== t.original) fail("Font metadata table length mismatch");
    return decoded;
  };
  const diagnostics: string[] = [], names = table("name");
  if (names.length < 6) fail("Truncated font name header");
  const format = names.readUInt16BE(0), count = names.readUInt16BE(2), start = names.readUInt16BE(4);
  if (format > 1 || count > 4096) fail("Unsupported font name format or record count");
  bounds(6, count * 12, names.length);
  let recordsEnd = 6 + count * 12;
  if (format === 1) {
    bounds(recordsEnd, 2, names.length); const languages = names.readUInt16BE(recordsEnd); recordsEnd += 2;
    bounds(recordsEnd, languages * 4, names.length);
    for (let i = 0; i < languages; i++) bounds(start + names.readUInt16BE(recordsEnd + i * 4 + 2), names.readUInt16BE(recordsEnd + i * 4), names.length);
    recordsEnd += languages * 4;
  }
  if (start < recordsEnd || start > names.length) fail("Font name storage overlaps records");
  const choices: { id: number; rank: number; name: string }[] = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12, platform = names.readUInt16BE(p), encoding = names.readUInt16BE(p + 2), language = names.readUInt16BE(p + 4), id = names.readUInt16BE(p + 6);
    const length = names.readUInt16BE(p + 8), offset = start + names.readUInt16BE(p + 10);
    bounds(offset, length, names.length); if (id !== 1 && id !== 16) continue;
    let charset: string;
    if ((platform === 0 && encoding <= 6) || (platform === 3 && [1, 10].includes(encoding))) charset = "utf-16be";
    else if (platform === 1 && encoding === 0) charset = "macintosh";
    else { diagnostics.push(`Unsupported family name encoding ${platform}/${encoding}`); continue; }
    if (length > 2048 || (charset === "utf-16be" && length % 2)) fail("Invalid font family name length");
    const name = new TextDecoder(charset, { fatal: true }).decode(names.subarray(offset, offset + length)).trim();
    if (!name || /[\u0000-\u001f\u007f]/.test(name)) fail("Invalid font family name");
    // English, then language-neutral Unicode, then stable language/platform order.
    const rank = (platform === 3 && language === 0x409) || (platform === 1 && language === 0) ? 0 : platform === 0 ? 1 : 2 + language;
    choices.push({ id, rank: rank * 4 + (platform === 3 ? 0 : platform === 0 ? 1 : 2), name });
  }
  const preferred = choices.some(n => n.id === 16) ? 16 : 1;
  const candidates = choices.filter(n => n.id === preferred).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, "en"));
  if (!candidates.length) fail("No supported embedded font family name");
  if (candidates.some(n => n.rank === candidates[0].rank && n.name !== candidates[0].name)) fail("Ambiguous embedded font family names");
  const os2 = table("OS/2");
  if (os2.length < 64) fail("Truncated OS/2 weight/style metadata");
  const weight = os2.readUInt16BE(4), width = os2.readUInt16BE(6), flags = os2.readUInt16BE(62), version = os2.readUInt16BE(0);
  if (weight < 1 || weight > 1000 || width < 1 || width > 9) fail("Invalid OS/2 weight or width class");
  if ((flags & 1) && (flags & 512) && version >= 4) fail("Ambiguous OS/2 italic and oblique flags");
  const style: FontStyle = flags & 1 ? "italic" : version >= 4 && flags & 512 ? "oblique" : "normal";
  if (tables.has("fvar")) {
    const fvar = table("fvar"); if (fvar.length < 16 || fvar.readUInt32BE(0) !== 0x00010000) fail("Invalid variable font metadata");
    const axes = fvar.readUInt16BE(8), axisSize = fvar.readUInt16BE(10), offset = fvar.readUInt16BE(4), instances = fvar.readUInt16BE(12), instanceSize = fvar.readUInt16BE(14);
    if (!axes || axes > 64 || axisSize !== 20 || offset < 16 || fvar.readUInt16BE(6) !== 2 || ![4 + axes * 4, 6 + axes * 4].includes(instanceSize)) fail("Invalid variable font axis directory");
    bounds(offset, axes * axisSize, fvar.length);
    bounds(offset + axes * axisSize, instances * instanceSize, fvar.length);
    const tags = new Set<string>();
    for (let i = 0; i < axes; i++) {
      const p = offset + i * axisSize, min = fvar.readInt32BE(p + 4), def = fvar.readInt32BE(p + 8), max = fvar.readInt32BE(p + 12);
      const tag = fvar.toString("latin1", p, p + 4);
      if (tags.has(tag) || min > def || def > max) fail("Invalid variable font axis bounds or duplicate tag");
      tags.add(tag);
    }
    diagnostics.push("Variable font: only the native default face is described; axis selection is not implemented");
  }
  return { family: candidates[0].name, weight, style, stretch: widths[width], source, diagnostics: [...new Set(diagnostics)] };
}
function inspect(reader: Reader, sha256: string): FontInspection {
  try { const metadata = metadataFrom(reader); return { metadata, sha256, diagnostics: metadata.diagnostics }; }
  catch (error) { return { metadata: null, sha256, diagnostics: [(error as Error).message] }; }
}
export function inspectFontBytes(bytes: Buffer): FontInspection {
  if (bytes.length > MAX_FONT_BYTES) fail("Font input exceeds the 64 MiB limit");
  return inspect(bufferReader(bytes), createHash("sha256").update(bytes).digest("hex"));
}
export function inspectFontFile(path: string): FontInspection {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FONT_BYTES) fail("Font input is not a file or exceeds the 64 MiB limit");
    const reader: Reader = { size: stat.size, read(offset, length) {
      bounds(offset, length, stat.size); const result = Buffer.alloc(length); let done = 0;
      while (done < length) { const n = readSync(fd, result, done, length - done, offset + done); if (!n) fail("Font changed during metadata read"); done += n; }
      return result;
    } };
    // Streaming digest; original file names/bytes and snapshot digests are untouched.
    const digest = createHash("sha256"), chunk = Buffer.alloc(65536);
    for (let offset = 0; offset < stat.size;) { const n = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset); if (!n) fail("Font changed during digest read"); digest.update(chunk.subarray(0, n)); offset += n; }
    const result = inspect(reader, digest.digest("hex")), after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail("Font changed during inspection");
    return result;
  } finally { closeSync(fd); }
}
