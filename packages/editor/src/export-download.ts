/** Portable downloads from the legacy captured export-set envelope. No rerender or recapture. */
export const EXPORT_DOWNLOAD_LIMITS = Object.freeze({
  files: 64, envelopeBytes: 128 * 1024 * 1024, manifestBytes: 64 * 1024,
  filenameUnits: 180, filenameBytes: 240, crcChunkBytes: 256 * 1024,
  // At most 64 * (30 + 46 + 2 * 240) + 22 bytes beyond the original payload.
  zipOverheadBytes: 35_606, jsonBytes: 64 * 1024, lifetimeMs: 600_000,
});
const ZIP32_SENTINEL = 0xffffffff;
const encoder = new TextEncoder();
const invalid = (message: string): never => { throw new Error(message); };
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError"); };
const reserved = (name: string) => /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9]|lpt[0-9])$/i.test(name.split(".")[0].trimEnd());

/** Flat, portable names only. Preserve spelling; refuse ambiguous extraction destinations. */
export function exportFilename(name: string): Uint8Array<ArrayBuffer> {
  if (typeof name !== "string" || !name || name.length > EXPORT_DOWNLOAD_LIMITS.filenameUnits) return invalid("Invalid export filename");
  for (const character of name) {
    const cp = character.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) return invalid("Invalid Unicode export filename");
  }
  const portable = name.normalize("NFKC");
  if (portable === "." || portable === ".." || /[<>:"/\\|?*\p{Cc}\p{Cf}\u034f\u180b-\u180d\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u.test(portable) || /[. ]$/.test(portable) || reserved(portable)) return invalid("Unsafe export filename");
  const bytes = encoder.encode(name);
  // HFS+ decomposes names; keep both original and NFD spelling below the 255-byte floor.
  if (bytes.length > EXPORT_DOWNLOAD_LIMITS.filenameBytes || encoder.encode(name.normalize("NFD")).length > EXPORT_DOWNLOAD_LIMITS.filenameBytes) return invalid("Export filename is too long");
  return bytes;
}
const nameKey = (name: string) => name.normalize("NFKC").toUpperCase().toLowerCase();

export function exportArchiveName(documentName: string): string {
  const suffix = "-exports.zip";
  let stem = "";
  for (const character of documentName.normalize("NFKC").replace(/[^\p{L}\p{N}._ -]/gu, "_")) {
    if (stem.length + character.length > 72 || encoder.encode((stem + character + suffix).normalize("NFD")).length > EXPORT_DOWNLOAD_LIMITS.filenameBytes - 7) break;
    stem += character;
  }
  stem = stem.replace(/[. ]+$/g, "");
  if (!stem || reserved(stem)) stem = `Export${stem ? "-" + stem : ""}`;
  const name = `${stem}${suffix}`; exportFilename(name); return name;
}

/** All arithmetic is checked before CRC work, Blob construction or URL allocation. */
export function planExportZip(files: readonly { name: string; bytes: number }[]) {
  if (!Array.isArray(files) || !files.length || files.length > EXPORT_DOWNLOAD_LIMITS.files) return invalid("Export ZIP requires 1–64 files");
  let offset = 0, payload = 0, directoryBytes = 0;
  const names = new Set<string>();
  const entries = files.map((file) => {
    const nameBytes = exportFilename(file.name), key = nameKey(file.name);
    if (names.has(key)) return invalid("Export filenames collide");
    names.add(key);
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) return invalid("Invalid export member size");
    if (file.bytes >= ZIP32_SENTINEL || offset >= ZIP32_SENTINEL) return invalid("ZIP64 export sizes are unsupported");
    const entry = { name: file.name, nameBytes, bytes: file.bytes, offset, dataOffset: offset + 30 + nameBytes.length };
    offset = entry.dataOffset + file.bytes; payload += file.bytes; directoryBytes += 46 + nameBytes.length;
    return entry;
  });
  const size = offset + directoryBytes + 22;
  if (offset >= ZIP32_SENTINEL || directoryBytes >= ZIP32_SENTINEL || size >= ZIP32_SENTINEL) return invalid("ZIP64 export offsets are unsupported");
  if (payload > EXPORT_DOWNLOAD_LIMITS.envelopeBytes || size > EXPORT_DOWNLOAD_LIMITS.envelopeBytes + EXPORT_DOWNLOAD_LIMITS.zipOverheadBytes) return invalid("Export ZIP exceeds the 128 MiB payload limit");
  return { entries, directoryOffset: offset, directoryBytes, size };
}

/** A task yield (not a microtask) lets input, cancellation and retirement run. */
function pause(signal?: AbortSignal): Promise<void> {
  check(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException("Export cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 0);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** Bound every streamed chunk before copying it. No arrayBuffer/blob/json convenience reads.
 * A declared length uses one exact buffer. Chunked bodies use bounded 256 KiB slabs and
 * one final concatenation (temporarily two body copies); browser/network storage is separate.
 */
export async function readExportResponse(response: Response, maximum: number, signal?: AbortSignal, mime?: string): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > EXPORT_DOWNLOAD_LIMITS.envelopeBytes) return invalid("Invalid export response limit");
  const reader = response.body?.getReader();
  if (!reader) return invalid("Export response has no readable body");
  let finished = false, cancelled = false;
  const cancelReader = () => { if (cancelled) return; cancelled = true; try { void reader.cancel().catch(() => undefined); } catch { /* still release the lock */ } };
  const abort = () => cancelReader();
  signal?.addEventListener("abort", abort, { once: true });
  const read = () => new Promise<ReadableStreamReadResult<Uint8Array<ArrayBufferLike>>>((resolve, reject) => {
    // Remove each read's listener as it settles; do not accumulate races against one
    // pending abort promise over arbitrarily many tiny network chunks.
    const cancelledRead = () => { signal?.removeEventListener("abort", cancelledRead); reject(new DOMException("Export cancelled", "AbortError")); };
    signal?.addEventListener("abort", cancelledRead, { once: true });
    reader.read().then(resolve, reject).finally(() => signal?.removeEventListener("abort", cancelledRead));
  });
  try {
    check(signal);
    if (mime && response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== mime) return invalid("Unexpected export response type");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.trim().toLowerCase() !== "identity") return invalid("Encoded export responses are unsupported");
    const header = response.headers.get("content-length");
    let declared: number | undefined;
    if (header !== null) {
      if (!/^\d+$/.test(header)) return invalid("Invalid export response length");
      declared = Number(header);
      if (!Number.isSafeInteger(declared) || declared > maximum) return invalid("Export response length exceeds the limit");
    }
    const exact = declared === undefined ? undefined : new Uint8Array(declared);
    const slabs: Uint8Array<ArrayBuffer>[] = [];
    let total = 0, slabUsed = 0;
    for (;;) {
      check(signal);
      const { done, value } = await read();
      check(signal);
      if (done) break;
      if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)) return invalid("Invalid export response chunk");
      if (value.byteLength > maximum - total || (declared !== undefined && value.byteLength > declared - total)) return invalid("Export response length exceeds the limit");
      for (let start = 0; start < value.length;) {
        check(signal);
        if (exact) {
          const end = Math.min(value.length, start + EXPORT_DOWNLOAD_LIMITS.crcChunkBytes);
          exact.set(value.subarray(start, end), total); total += end - start; start = end;
        } else {
          if (!slabs.length || slabUsed === slabs[slabs.length - 1].length) { slabs.push(new Uint8Array(Math.min(EXPORT_DOWNLOAD_LIMITS.crcChunkBytes, maximum - total))); slabUsed = 0; }
          const slab = slabs[slabs.length - 1], count = Math.min(value.length - start, slab.length - slabUsed);
          slab.set(value.subarray(start, start + count), slabUsed); slabUsed += count; total += count; start += count;
        }
        await pause(signal);
      }
      // Even zero-byte or tiny synchronous chunks must let deadlines/input run.
      if (!value.length) await pause(signal);
    }
    if (declared !== undefined && total !== declared) return invalid("Truncated export response length");
    check(signal);
    const output = exact ?? new Uint8Array(total);
    if (!exact) {
      let offset = 0;
      for (const slab of slabs) { check(signal); const count = Math.min(slab.length, total - offset); output.set(slab.subarray(0, count), offset); offset += count; await pause(signal); }
    }
    check(signal); finished = true; return output.buffer;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!finished) cancelReader();
    reader.releaseLock();
  }
}

export async function readExportJson(response: Response, signal?: AbortSignal) {
  const data = await readExportResponse(response, EXPORT_DOWNLOAD_LIMITS.jsonBytes, signal);
  check(signal); return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
}
export async function exportResponseError(response: Response, fallback: string, signal?: AbortSignal): Promise<string> {
  try { const body = await readExportJson(response, signal); return typeof body?.error === "string" && body.error ? body.error : fallback; }
  catch { check(signal); return fallback; }
}
const shaConstants = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** SHA-256 without a secure-origin requirement, worker, native full-member copy or opaque work.
 * At most 256 KiB between task yields; 256-byte schedule, 32-byte state, 128-byte padding.
 */
export async function exportMemberSha256(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
  check(signal);
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.length > EXPORT_DOWNLOAD_LIMITS.envelopeBytes) return invalid("Invalid export digest bytes");
  const state = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), words = new Uint32Array(64);
  const block = (source: Uint8Array<ArrayBuffer>, offset: number) => {
    for (let i = 0; i < 16; i++) { const p = offset + i * 4; words[i] = (source[p] << 24) | (source[p + 1] << 16) | (source[p + 2] << 8) | source[p + 3]; }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + shaConstants[i] + words[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e; state[5] += f; state[6] += g; state[7] += h;
  };
  const complete = bytes.length - bytes.length % 64;
  for (let start = 0; start < complete; start += EXPORT_DOWNLOAD_LIMITS.crcChunkBytes) {
    check(signal);
    const end = Math.min(complete, start + EXPORT_DOWNLOAD_LIMITS.crcChunkBytes);
    for (let offset = start; offset < end; offset += 64) block(bytes, offset);
    await pause(signal);
  }
  check(signal);
  const tail = bytes.length - complete, padding = new Uint8Array(tail < 56 ? 64 : 128), length = new DataView(padding.buffer), bits = bytes.length * 8;
  padding.set(bytes.subarray(complete)); padding[tail] = 0x80;
  length.setUint32(padding.length - 8, Math.floor(bits / 0x100000000)); length.setUint32(padding.length - 4, bits >>> 0);
  block(padding, 0); if (padding.length === 128) block(padding, 64);
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
async function storedMember(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal, progress?: (bytes: number) => void) {
  let crc = 0xffffffff;
  const parts: Blob[] = [];
  for (let start = 0; start < bytes.length; start += EXPORT_DOWNLOAD_LIMITS.crcChunkBytes) {
    check(signal);
    const end = Math.min(start + EXPORT_DOWNLOAD_LIMITS.crcChunkBytes, bytes.length);
    for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    // Bound the synchronous snapshot as well as the CRC scan. Final assembly uses Blob parts.
    parts.push(new Blob([bytes.subarray(start, end)]));
    progress?.(end - start); await pause(signal);
  }
  check(signal); return { checksum: (crc ^ 0xffffffff) >>> 0, parts };
}

/** Standard ZIP STORE: UTF-8 flag, CRC32, exact sizes, local headers, central directory, EOCD.
 * The input views are read-only for the caller until this promise retires. No full-buffer concat.
 */
export async function createExportZip(files: readonly { name: string; bytes: Uint8Array<ArrayBuffer> }[], signal?: AbortSignal, progress?: (bytes: number) => void) {
  check(signal);
  if (!Array.isArray(files) || files.some((file) => !file || !(file.bytes instanceof Uint8Array) || !(file.bytes.buffer instanceof ArrayBuffer))) return invalid("Invalid export ZIP bytes");
  const plan = planExportZip(files.map((file) => ({ name: file.name, bytes: file.bytes.byteLength })));
  const parts: BlobPart[] = [], directory: BlobPart[] = [];
  for (const [i, entry] of plan.entries.entries()) {
    const stored = await storedMember(files[i].bytes, signal, progress), checksum = stored.checksum;
    const local = new Uint8Array(30), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true);
    l.setUint16(12, 33, true); // STORE, midnight 1980-01-01; no extra fields or data descriptor.
    l.setUint32(14, checksum, true); l.setUint32(18, entry.bytes, true); l.setUint32(22, entry.bytes, true); l.setUint16(26, entry.nameBytes.length, true);
    const central = new Uint8Array(46), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 33, true);
    c.setUint32(16, checksum, true); c.setUint32(20, entry.bytes, true); c.setUint32(24, entry.bytes, true); c.setUint16(28, entry.nameBytes.length, true); c.setUint32(42, entry.offset, true);
    parts.push(local, entry.nameBytes, ...stored.parts); directory.push(central, entry.nameBytes);
  }
  check(signal);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, plan.entries.length, true); e.setUint16(10, plan.entries.length, true);
  e.setUint32(12, plan.directoryBytes, true); e.setUint32(16, plan.directoryOffset, true);
  const blob = new Blob([...parts, ...directory, end], { type: "application/zip" });
  if (blob.size !== plan.size) return invalid("Incomplete export ZIP");
  return { blob, entries: plan.entries };
}

export type ReviewedExport = { revision: number; resources: string; files: number; documentName: string };
/** Validate the whole manifest/range layout, then every SHA-256, before creating any save result. */
export async function validateExportEnvelope(data: ArrayBuffer, expected: ReviewedExport, signal?: AbortSignal) {
  check(signal);
  if (!(data instanceof ArrayBuffer) || data.byteLength < 4 || data.byteLength > EXPORT_DOWNLOAD_LIMITS.envelopeBytes) return invalid("Invalid export set size");
  if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || !/^[a-f0-9]{64}$/.test(expected.resources) || !Number.isSafeInteger(expected.files) || expected.files < 1 || expected.files > EXPORT_DOWNLOAD_LIMITS.files || typeof expected.documentName !== "string") return invalid("Invalid reviewed export set");
  const length = new DataView(data).getUint32(0);
  if (!length || length > EXPORT_DOWNLOAD_LIMITS.manifestBytes || length + 4 > data.byteLength) return invalid("Invalid export set manifest");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data, 4, length)));
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > EXPORT_DOWNLOAD_LIMITS.files || manifest.files.length !== expected.files || manifest.resourceSnapshot?.revision !== expected.revision || manifest.resourceSnapshot?.sha256 !== expected.resources) return invalid("Export set does not match the reviewed project");
  let offset = 4 + length;
  const files = manifest.files.map((file: { name: string; mime: string; bytes: number; sha256: string }) => {
    if (!file || typeof file.mime !== "string" || !file.mime || /[\x00-\x1f\x7f]/.test(file.mime) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > data.byteLength - offset) return invalid("Invalid export set member");
    const bytes = new Uint8Array(data, offset, file.bytes); offset += file.bytes;
    return { name: file.name, mime: file.mime, bytes, sha256: file.sha256 };
  }) as { name: string; mime: string; bytes: Uint8Array<ArrayBuffer>; sha256: string }[];
  planExportZip(files.map((file) => ({ name: file.name, bytes: file.bytes.length })));
  if (offset !== data.byteLength) return invalid("Incomplete export set response");
  for (const file of files) {
    await pause(signal);
    const digest = await exportMemberSha256(file.bytes, signal);
    check(signal);
    if (digest !== file.sha256) return invalid("Export file bytes do not match the manifest");
  }
  return files;
}

export async function prepareExportSetDownload(data: ArrayBuffer, expected: ReviewedExport, signal?: AbortSignal, progress?: (bytes: number) => void) {
  const files = await validateExportEnvelope(data, expected, signal);
  if (files.length === 1) {
    check(signal);
    const file = { name: files[0].name, blob: new Blob([files[0].bytes], { type: files[0].mime }) };
    return { save: file, members: [file], archived: false };
  }
  const zip = await createExportZip(files, signal, progress); check(signal);
  return {
    save: { name: exportArchiveName(expected.documentName), blob: zip.blob }, archived: true,
    // Blob slices share archive storage; no separate full member Blob copies.
    members: zip.entries.map((entry, i) => ({ name: entry.name, blob: zip.blob.slice(entry.dataOffset, entry.dataOffset + entry.bytes, files[i].mime) })),
  };
}
