# Served font identity correction

Historical implementation note: the named baseline/candidate results below belong to their original bytes. Current 0.2.6 source scope and public distribution boundaries are in [RELIABILITY.md](RELIABILITY.md) and [RELEASE.md](RELEASE.md); generated evidence and client libraries are not included.

This isolated candidate corrects the reproduced Pictocity 0.2.3 font identity
defect. Regular Poppins bytes named `Unrelated-Semibold.ttf` now select family
`Poppins`, weight `400`, style `normal` in both server registration and the
editor's FontFace descriptors. Names of uploaded files no longer supply identity.
This is source correctness evidence, not installed, packaged, browser, creative,
or product parity acceptance.

## Contract and implementation

`registerFontFile(fontsDir, file): string | null`, `registerFonts(fontsDir)`,
`listFontFamilies()` and `loadFonts(): Promise<string[]>` keep their call shapes.
`FontInfo.files` remains a list of original filenames. `FontInfo.faces` adds a
per-file weight, style, stretch, SHA-256, metadata source and diagnostics. The
editor only advertises successfully loaded faces and uses these descriptors,
never filename rules. Repeated refreshes reuse identical faces, obsolete results
cannot replace current selections, and `fontLoadIssues` records exact failures.
System choices remain strings; only families present before served registration
are advertised as system choices.

The installed `@napi-rs/canvas` 0.1.100 declaration and implementation were
inspected first. They expose registration handles and global family/style
listings, but no metadata lookup for an individual registration handle. The new
module reads SFNT/OTF, WOFF and WOFF2 metadata with Node built-ins. It prefers
typographic family name 16 over family name 1, with deterministic language
selection; supports Unicode/Windows UTF-16BE and Macintosh Roman; and reads
weight, slant and stretch from OS/2. Native registration must succeed and expose
the described style. The embedded family becomes the native registration alias.
No arbitrary probe aliases are created.

When metadata is unavailable, a final, successful native registration may supply
descriptors only if its family/style addition is unambiguous. Identical-byte
registrations reuse copied results by digest. An ambiguous native success keeps
the bytes and returns no fabricated family. `GET /api/fonts?diagnostics` exposes
per-file registration/metadata issues; the normal array response stays compatible.
Native upload rejection returns `400` without writing the file. Conflicting
filenames still return `409`. Native-accepted bytes without usable identity are
retained with `422`, `family: null`, diagnostics and an explicit error. This is
an intentional narrow API contract change, tested separately from native failure.

File and byte admission is bounded to 64 MiB. SFNT reads use checked random
access and a 64 KiB streaming digest, rather than copying the full file. Directories
are limited to 256 tables, metadata tables to 1 MiB, name records to 4096 and
family strings to 2048 encoded bytes. WOFF inflation is bounded to declared
table lengths. WOFF2 Brotli input/output is bounded to 32 MiB and its transformed
table directory is validated before accessing untransformed metadata tables.
Ranges, overlap, duplicate tables, name storage, supported encodings, weight/slant
values and variable axis/instance directories are checked. The parser is not a
complete font sanitizer; native admission remains authoritative. Variable fonts
carry a default-face-only diagnostic; no axis ranges are invented.

Original font filenames and bytes, resource snapshot capture/digests, store,
atomic writes, export services, core and document data are preserved. No dependency,
manifest, version, lockfile or installed/plugin change was made.

## Changed source paths

- `packages/server/src/font-metadata.ts` (new bounded metadata reader)
- `packages/server/src/node-env.ts` (font registration/descriptors only)
- `packages/server/src/index.ts` (font imports, served list and font API branches only)
- `packages/editor/src/env.ts` (font section only)
- `tools/font-identity-tests.mjs` (new production-code regression runner)
- `tools/font-identity-frontend-fixture.mjs` (new deterministic frontend adapter)
- `docs/FONT-IDENTITY.md`

Candidate build outputs and owned test data/evidence are local. The source diff
against the three frozen originals is `tools/font-identity-evidence/source.patch`.
All final source and retained evidence SHA-256 values are in
`tools/font-identity-evidence/manifest.json`.

## Validation and exact evidence

| Check | Result | Evidence under `tools/` |
| --- | --- | --- |
| Frozen production baseline | 0 passed, 2 expected failures | `font-identity-evidence/red-final/report.json` |
| Final focused production/FontFace fixture checks | 29 passed, 0 failed, 0 cannot-run | `font-identity-evidence/green-final-3/report.json` |
| Core suite | 70 passed | `font-identity-evidence/core-tests-final.log` |
| Snapshot suite without rendering children | 22 passed | `font-identity-evidence/snapshot-direct-report.json` |
| Cache suite, existing explicit in-process adapter | 23 passed | `cache-consistency-evidence/2026-10-05T07-50-57-110Z/report.json` |
| Existing API suite, production worker transport | 30 passed; 2 checks blocked by `spawn EPERM` | `font-identity-evidence/api-tests.log` |
| Full production snapshot/cache/snapshot-API checks | Cannot-run beyond child-process boundary | `font-identity-evidence/{snapshot-tests,cache-tests,snapshot-api-tests}.log` |
| Core and server TypeScript builds | Passed | `font-identity-evidence/{core-build,server-build}.log` |
| Editor TypeScript check | Passed | `font-identity-evidence/editor-typecheck.log` |
| Editor Vite bundle build | Cannot-run: esbuild `spawn EPERM` | `font-identity-evidence/editor-build.log` |

Red report SHA-256:
`8d894e91687ffc114a8e8e93ff1841fffbe3cab91283bbcdb0495cdec6a7a041`.
Final green report SHA-256:
`94f5faf7b26a6c67bb54a37884953f0874df94d901f45b6d9f71435b5ad41fde`.
Renamed native render PNG SHA-256:
`4b1bbb51c5eb744094e1390ceaca0ff454dd3c2aea41e03132084c5bdf3834e3`.

The red runner loads the frozen original production sources in memory; its two
assertions fail for exactly the reproduced family and weight defects. Earlier
red/green attempts are retained, including a corrected fixture count and denied
child starts. `green-final-3` supersedes earlier reports. Earlier external-server
reports incorrectly marked a runner-unowned server closed; the final runner
records an external lifecycle with `serverClosed: null`, and the separate
`font-identity-evidence/server-stop.json` receipt verifies actual shutdown.

The native PNG comparison checks production exporter selection after arbitrary
renaming and metadata-selected rendering through the same native engine. The
frontend tests import real editor source with a deterministic FontFace/DOM adapter;
they do **not** compare real browser pixels. Production font upload checks used a
server launched directly by the terminal because Node child spawn was denied.
The terminal stopped that process and launched a fresh Node process against the
same owned data; the runner compared its descriptors with `restart-before.json`.
Raw, JSON local-path and JSON local-URL paths, repeat/conflict rejection, invalid
admission and retained ambiguous native success were exercised. The local URL
test reused owned fixture bytes; no external assets or dependencies were fetched.

To run focused tests, set owned `TEMP`/`TMP` and optionally
`PICTOCITY_FONT_EVIDENCE` to a fresh candidate evidence folder, then run existing
Node with `tools/font-identity-tests.mjs`. `--baseline` uses frozen source originals.
Where Node can create children, the default runner starts/stops its own server
and tests restart. In this terminal, an externally launched owned server was used
with `PICTOCITY_FONT_TEST_URL`, `PICTOCITY_FONT_TEST_DATA`, and
`PICTOCITY_FONT_RESTART_BEFORE`. External mode requires a separate terminal
stop/restart and port-release observation. `--existing-api` requires working
child creation; its denial cannot count as a pass.

## Implementation limits and remaining gates

Real browser preview versus native export pixels, full worker transport, editor
bundle generation, native application review, packaging and installation remain
open. System/glyph fallback, variable axis selection and complete shaping fidelity
are separate gates. Different font builds sharing a family/style, system/served
duplicates, localized naming across engines, stretch in document text styles,
special-character family escaping in core, external live font replacement and
concurrent filesystem mutation need wider integration review. The registration
cache assumes this application owns served registrations; external removal from
GlobalFonts is not a supported invalidation mechanism. It stores at most 1024
successful digest entries. Native registration is not rolled back if the existing
atomic write subsequently fails; this preexisting upload ordering is outside the
assigned persistence scope.

All four existing extensions remain admitted. In retained generated fixtures,
native WOFF registration succeeded, while native WOFF2 registration rejected the
fixture; the candidate returned that same honest failure. WOFF2 metadata parsing
passed, but this does not establish successful WOFF2 native rendering. A wider
real CFF/OTF and transformed/variable WOFF2 corpus remains a gate. No rejected
native font is presented as a selectable hosted browser font.

This batch stops at the bounded font identity correction.
