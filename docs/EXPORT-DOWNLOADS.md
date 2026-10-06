# Editor export downloads

Historical implementation note: the named baseline/candidate results below belong to their original bytes. Current 0.2.6 source scope and public distribution boundaries are in [RELIABILITY.md](RELIABILITY.md) and [RELEASE.md](RELEASE.md); generated evidence and client libraries are not included.

The editor turns an export set of two or more captured files into one standard
ZIP. Choose **Save …-exports.zip**, then extract it to open the files. The dialog
retains individual member links. Preparing a set does not click download links
automatically or issue another export request. A one-member set and the direct
single-file workflow retain their original formats, MIME types and filename
rules. Save to server exports still displays the server's returned file links.

This is an isolated source candidate based on Pictocity 0.2.3. It is not an
accepted package or a native Save receipt. Server/MCP capture, publication and
the custom HTTP export-set envelope remain unchanged.

## Admission and cancellation

`packages/editor/src/export-download.ts` checks the envelope's big-endian
manifest length, fatal UTF-8 decoding, version, reviewed resource revision and
SHA-256, expected member count, member sizes, contiguous ranges, complete body
consumption, portable filenames and collisions. Every member must match its
advertised SHA-256 **before any ZIP/member output Blob is allocated**. CRC32 in
the ZIP is an independent extraction check; a newly computed CRC cannot replace
comparison with the advertised SHA-256.

SHA-256 uses pure JavaScript and needs no secure-origin WebCrypto facility. It
handles padding and nonzero-offset views, scans at most 256 KiB between task
yields, and checks cancellation at those boundaries. CRC32 and member Blob
snapshots use the same bounded chunks. The input views must stay unchanged until
the helper promise retires; the editor owns those response bytes privately.

Export and package responses use `ReadableStream` readers, never a whole-body
`arrayBuffer()`, `blob()` or `json()` call. Each delivered chunk is checked
against the 128 MiB cap and any declared Content-Length **before copying** it.
Malformed, unsafe-integer, oversize, extra or truncated lengths refuse. The set
response must have `application/vnd.pictocity.export-set` MIME. Non-identity
Content-Encoding refuses, since encoded Content-Length does not describe the
decoded stream. Missing Content-Length is supported with bounded slabs.
Successful server results, progress JSON and error bodies have a separate
64 KiB cap. Invalid/oversize error JSON produces the existing generic error.
Cancellation retains AbortError semantics. Error/cancel invokes reader
cancellation and releases the reader lock without waiting on a possibly stalled
underlying source's cancellation promise.

The dialog guards pending responses and results with request identity,
document ID/revision, export options and the reviewed resource snapshot. Focus
and visibility refresh checks remain active during export; a changed or failed
resource check retires current work. Resource detection occurs at those refresh
boundaries, not continuously against the filesystem. Cancellation, option or
document replacement, URL allocation failure, replacement exports and unmount
retire owned object URLs. Links expire together ten minutes after preparation.
Old rendered anchors refuse activation after their result generation retires.
The focus trap includes Save and member anchors, and completion focuses Save or
the export action as appropriate. These source behaviors still need native/DOM
verification.

## ZIP and name limits

ZIP32 uses STORE (no compression), UTF-8 bit 11, CRC32, exact sizes, standard
local/central headers and EOCD, one disk, no extra fields/comments/descriptors,
and midnight 1980-01-01. Entries retain manifest order. Identical inputs produce
identical archive bytes. ZIP64 sizes and offsets are refused before construction.

There are at most 64 nonempty files and 128 MiB of envelope bytes. ZIP planning
also caps payload bytes at 128 MiB and archive size at that amount plus 35,606
bytes of worst-case headers/names/EOCD. A real admitted envelope's manifest and
prefix reduce its available member payload below 128 MiB.

Member names remain flat and preserve their spelling. They must fit 180 UTF-16
units and 240 UTF-8 bytes, including the NFD spelling used by decomposing
filesystems. Paths, forbidden punctuation, controls, format/bidi characters,
variation selectors, malformed surrogates, trailing dots/spaces and Windows
device aliases (including CONIN$, CONOUT$, CLOCK$, COM0–9 and LPT0–9) refuse.
NFKC normalization plus upper/lower casing detects conservative case/Unicode
collisions. The archive title is sanitized and truncated to the same budget.
This policy deliberately refuses ambiguous names rather than renaming members.
The former interrupted draft's 540-byte allowance was unsafe on macOS and is
superseded. Filename vectors establish the policy; they are not tests on every
Windows/macOS filesystem or extractor.

## Memory accounting

This is bounded buffering, not a zero-copy network-to-disk export. With an
ordinary declared-length production response, the reader allocates one exact
envelope buffer, up to 128 MiB. Member views share it. SHA-256 adds a 256-byte
schedule, 32-byte state and at most 128 padding bytes, without another full
member ArrayBuffer. ZIP construction snapshots payload into 256 KiB Blobs;
the final ZIP uses those Blob parts, and individual links use ZIP Blob slices.
The implementation avoids a second full-size ZIP ArrayBuffer and separate
full-size member Blobs for those links.

The reachable envelope plus payload snapshots can approach **256 MiB**, plus
headers, manifest strings/objects, small hash/CRC state and Blob metadata.
Missing-length responses additionally hold up to 128 MiB of slabs while
allocating/copying their final body buffer; the last slab has at most 256 KiB of
unused capacity. Direct single-file output similarly retains response bytes
while Blob snapshots are made. A network chunk is supplied by the browser and
can itself be large; the application can refuse it before copying, but cannot
prevent that prior network allocation. Blob composition/slicing may share
storage in a runtime, but physical sharing is not guaranteed here. Additional
runtime copies and delayed garbage collection can take peak process memory
above 256 MiB (and potentially above 384 MiB). No measured browser RSS ceiling
or total process memory guarantee is claimed.

## Review commands and remaining gates

Use the existing Node/dependencies and build Python, with TEMP/TMP pointing to
an owned candidate test directory:

```
node tools/export-download-tests.mjs
node tools/export-set-frontend-tests.mjs
node tools/export-set-tests.mjs
node tools/export-set-regressions.mjs
node node_modules/typescript/bin/tsc -p packages/editor/tsconfig.json --noEmit
```

The helper suite compares SHA-256 with Node crypto (empty, 55/56/63/64/65-byte
padding boundaries, longer/multiple-chunk, Unicode, binary and offset fixtures),
checks corruption before output allocation, streaming bounds and cancellation,
and invokes Python's independent `zipfile` extractor. Extraction verifies exact
bytes, CRC32, dates, UTF-8, local/central offsets and EOCD for 2, 6 and 64 entries.
Frontend fixtures import the actual helper and transpiled dialog, with narrowly
updated transport fixtures and real JavaScript hash cancellation. They are
source/effect checks, not React DOM, browser, native or creative acceptance.

The HTTP suite uses the production reader and has a real two-artboard/two-scale
capture-to-ZIP/extraction case. In restricted environments renderer, MCP or
esbuild child-process denial is **cannot-run**, even if earlier checks passed.
Preserve nonzero exits and assertion failures; do not replace the renderer to
claim those gates passed.

Before integration, the parent must run the ordinary Windows Vite build,
production HTTP capture/extraction and full cache/snapshot/API/MCP compatibility
checks. It must also verify one user Save ZIP through the actual Windows Save
dialog and independently extract the four real PNGs, checking hashes,
dimensions/colors, cancellation, link lifetime, keyboard/focus and cleanup.
Packaging/install/native/parity/creative acceptance is outside this batch.
