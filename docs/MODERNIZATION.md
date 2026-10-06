# Professional workflow acceptance — Pictocity

This is an engineering target, not a claim that Pictocity matches Photoshop.
Reviewed on October 5, 2026 against the current local code and official sources.
Targets below are our proposed measurable gates; they are not Adobe performance
numbers or a blanket WCAG conformance claim. Unsupported inputs must be explicit.

| Area | Required observed behavior | Verification before release |
|---|---|---|
| Saved work and recovery | Acknowledged edits survive a controlled process crash; corruption is visible and cannot silently become an empty healthy library; recovery preserves original evidence | Disk reopen/crash/fault fixtures, exact original-byte hashes, committed/torn record distinction, no partial replay, real-library compatibility |
| Export sets | One reviewed document/resource version, predictable names/dimensions/alpha, one ordinary ZIP save for multiple files, previous outputs preserved on handled refusal | Production HTTP and independent ZIP extraction/CRC/SHA; real native Save; empty pools and retired reader/process ownership |
| Undo and reconnect | Undo/redo restores the intended state; remote edits and rejected/offline batches cannot silently lose changes or target a different document | Production editor/store tests with delayed/reordered messages, real server transport, two-client workflows and native keyboard checks |
| Typography | Metadata-based family/weight/style, consistent browser/export font selection, visible missing font/glyph decisions and stable line breaks/bounds | Renamed/mislabeled font fixtures, real font bytes, Latin/diacritics/multilingual/missing-glyph strings, browser-versus-export measurements at output size |
| Layers and interchange | Stable layer identity/locks; supported transforms, masks, blends and PSD/SVG imports preserve their declared semantics | Independently frozen fixtures with per-feature reference provenance, editable round trips, pixel differences and documented lossy/refused cases |
| Color | Explicit input/working/output assumptions and profile handling; tagged conversion differs from merely attaching metadata; no unsupported print/HDR claim | Tagged/untagged and differing-profile fixtures, independent profile/pixel oracles, browser/export comparison; separately gate higher bit depth/CMYK/print |
| Editing performance | Measured latency and memory on declared hardware/documents; cancellation remains responsive; large work has bounded admission and visible progress | Fixture ladder of 25/100/500 layers and 1080/2048/4096-pixel sides, image/mask/text mixes, p50/p95/max timings, peak process memory, failure/cancel recovery |
| Accessible controls | Reachable named controls, working keyboard actions, visible focus, no accidental focus trap, useful errors and status announcements | DOM plus actual native workflow; 100/150/200% scaling and both monitor layouts; inspect WCAG criteria and exceptions individually |
| Portable release | Source/build/payload/executable lineage, stable data selection, successful native start/export/shutdown, rollback and dependency notices | Existing-dependency builds first, exact-byte API/MCP/native checks, clean-machine gate separately, no source-only evidence called installed acceptance |

Start with reliable web-design workflows: a readable promotional layout, a masked
photo composition, a two-artboard/two-scale brand set, a layered PSD import, and a
text-heavy document. Freeze the actual fixture bytes and render hashes. Inspect
the resulting artifacts at delivery size. Technical agreement is separate from
owner taste; a synthetic fixture alone cannot establish attractive client work.

Initial proposed interaction targets: on the named fixture/hardware, p95 simple
input-to-visible-update below 100 ms, pan/zoom frame work near a 60 Hz budget,
and observable cancellation within 250 ms between interruptible chunks. Measure
the baseline before using these as release criteria; synchronous native calls
and operating-system dialogs require separately measured limits. No benchmark
for long projects or full high-DPI behavior exists yet.

Current primary references:

- Adobe describes explicit preserve/convert policies and warnings for embedded
  or missing profiles. Pictocity currently documents 8-bit sRGB edges without
  ICC/CMYK; implementing a declared profile contract is a material gap.
  [Manage color profiles when opening images](https://helpx.adobe.com/photoshop/desktop/adjust-color/choose-colors/manage-color-profiles-when-opening-images.html)
- Adobe's artboard PDF workflow exposes page grouping and profile choices; use
  those concrete workflow dimensions when measuring supported PDF behavior.
  [Export artboards as PDF](https://helpx.adobe.com/photoshop/desktop/save-and-export/export-files-to-different-formats/export-artboards-as-pdf.html)
- WCAG 2.2 defines keyboard access, focus visibility/order, focus not entirely
  obscured and minimum pointer target sizes with exceptions. These are useful
  criteria for the React frontend, not proof about the whole desktop product.
  [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- A ZIP is a specified container with directory records, CRC and filename/UTF-8
  rules. Independently parse the real archive rather than trusting its suffix.
  [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)

Version 0.2.4 focuses on one ZIP save, strict recovery with retained evidence,
embedded font descriptors, complete merged undo/redo, bounded cache admission and
a visible saved-work recovery notice. Parent review also tests restart ordering
for ambiguous font metadata and version-1 imports with an omitted creation date.
Unknown legacy creation dates and asset descriptions stay absent; omitted text
wrapping retains the old renderer behavior. Invalid present fields still refuse,
and new asset.add records still require complete descriptive metadata.

Release acceptance requires the exact packaged executable to pass copied-library,
API/MCP and native checks, including a visible recovery warning, keyboard editing,
independent ZIP extraction, Windows Save and return to the editor. Retain build,
source, payload and executable hashes plus rollback bytes. A source test alone
does not establish these package gates. Filmocity development is elsewhere.

Next major gates remain profile-aware color, browser/export typography and glyph
coverage, PSD/SVG round trips, two-client undo/reconnect, mixed-document input
latency and high-DPI/clean-machine behavior. These require separate fixture-based
work and do not become complete because this release's narrower checks pass.


Version 0.2.6 closes a reproduced same-host multi-process journal conflict:
two servers previously acknowledged different edits with the same revision.
Cooperating new servers now acquire ownership of physical data and document
directories before journal recovery, stores, font seeding and API admission.
Windows force-stop/reopen, simultaneous starts, case/junction/shared-doc aliases
and preserved bytes are actual process gates. Cross-machine/older-version/direct
writers, independently shared resource directories, two-client/offline undo and
power-loss transactions remain open. Linux/other Unix behavior is implemented
with the documented IPC primitives but is not validated on this Windows host.
