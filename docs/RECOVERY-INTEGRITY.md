# Recovery integrity candidate (Pictocity 0.2.3)

Historical implementation note: the named baseline/candidate results below belong to their original bytes. Current 0.2.6 source scope and public distribution boundaries are in [RELIABILITY.md](RELIABILITY.md) and [RELEASE.md](RELEASE.md); generated evidence and client libraries are not included.

This local source correction covers `store.ts`, the append/backup functions in
`atomic-file.ts`, focused fixtures, and this guide. It is not an installed release
or native, package, creative, format-parity, or owner acceptance. Filmocity and
canonical/plugin/client data were not changed.

## Reproduced failures

The unchanged production constructor lost malformed snapshots from its visible
library while `persistence().ok` remained true. Its history reader also deleted a
malformed final record even when a newline terminated it. Revision duplication,
invalid already-snapshotted operations, and identity-changing operations were not
adequately checked. Appends that failed after writing bytes did not affect store
health, and rollback errors were suppressed. On this Windows terminal, truncating
the append-only descriptor actually returned `EPERM`. A descriptor stat failure
also bypassed descriptor cleanup, and a zero-byte write retried without progress.

Frozen original source and compiled bytes are under
`tools/recovery-integrity-evidence/red/`. The original focused run was 14 passing
and 34 failing cases. Later baseline runs use those same frozen production bytes
with the expanded suite; consult their reports for exact suite hashes and counts.
The final identical 62-case suite reports **16 pass / 46 fail** on the frozen
baseline (`final-red/report.json`) and **62 pass / 0 fail** on the correction
(`final-green/report.json`). Both retain the production source and compiled hashes.

## Admission and publication

Snapshot identity must match its filename and be safe as a Windows filename.
Version, nonnegative safe revision, timestamps, dimensions, required document
containers, unique layer identities, base geometry and type-specific required
shape are checked before the snapshot enters the store. Structural depth,
non-finite numbers and dangerous object keys are checked too. The existing
transparent-background null-clearing behavior is preserved: an absent background
can represent transparency. Missing resources are a separate resource-service
check; recovery does not pretend to validate fonts, images or rendering fidelity.

Every journal record must have the actual AppliedOps metadata, a positive safe
revision, nonempty supported operations, a structurally valid inverse, and an
expectedRev matching its predecessor when present. All retained records must be
consecutive, including records already represented by the snapshot. A rotated
contiguous suffix ending at the snapshot revision is supported. Replay uses the
real core operations and store lock checks, validates the resulting document, and
does not repeat linked-layer propagation. Stored operations already include it.
New layer additions persist the core's defaults and generated identities. Older
additions may omit deterministic defaults if they supply stable identities.

Only after the whole journal succeeds can recovery repair a tail, advance the
snapshot, rotate the journal, or publish the recovered document/history. A later
bad record therefore cannot publish an earlier replay prefix or overwrite the
prior snapshot. A validated prior snapshot remains readable when its journal
fails; malformed snapshots remain excluded with a filename-bound health error.
Any recovery error blocks create, put, delete and apply across the library.
Loading another healthy document cannot clear that error. Successful ordinary
snapshot retries still clear their own save error, preserving the existing flush
retry contract; they cannot clear a recovery/append error.

## Tail and preservation contract

A newline commits a record even if its bytes or semantics are corrupt. Such a
record is refused and retained exactly. A complete invalid object without a
newline is also refused. Only an unterminated syntactically incomplete JSON
object prefix qualifies as a torn append. Prefix checks cover nested structures,
strings/escapes, numbers, literals and a truncated final UTF-8 character. Garbage,
invalid UTF-8 within a record and malformed complete values are refused.

A valid complete final record without a newline still replays. Before another
append, recovery adds a separator while preserving the original bytes. Empty
lines retain their existing compatibility; complete CRLF records remain valid.

Before destructive journal repair, rotation or snapshot advancement, an exclusive
UUID-named `.recovery-<uuid>.bak` freezes the exact input file. That copy is flushed
and a sibling `.diagnosis` records the original/backup paths and repair reason
before publication proceeds. Failed preservation or repair refuses edits. These
files are retained for review; there is no automatic cleanup or restore command.
Corrupt inputs that are not repaired remain in their original paths, with the
diagnosis in `persistence().errors` including the file and record line.

## Append failure

Short writes continue; zero or invalid progress throws immediately. Descriptor
stat, write, sync and close failures are handled without publishing the staged
document, revision, history or notifications. Before rollback, failed journal
bytes and the original length are preserved with an unresolved diagnosis.
Rollback opens a separate read/write descriptor, checks file identity, truncates,
flushes and closes it. Successful rollback updates the diagnosis to resolved.
The original failure still reaches the caller and the current store stays
unhealthy until reopen/review.

Unresolved rollback, failed backup creation, or close uncertainty also attempts a
`.history.jsonl.recovery-error` refusal marker. Reopening refuses if that marker,
an unresolved rollback diagnosis, or an orphan backup without its diagnosis is
present. Even a syntactically complete journal cannot hide known append
uncertainty. If all evidence/marker writes are denied, only current-process
refusal is guaranteed; persistent refusal cannot be guaranteed without a writable
filesystem. The thrown error states marker failure. No power-loss claim follows.

## Conservative refusals and actual limits

Missing snapshots with orphan journals make the library unhealthy. A nonzero
snapshot requires a journal ending at least at its revision; absent, empty or
stale history refuses. This deliberately tightens old silent admission of
standalone nonzero snapshots and incomplete historical logs. Whole-document
imports with a new identity require revision zero rather than producing a
snapshot that the next startup would reject. Importing existing archived JSON
with a nonzero revision needs an explicit reviewed import/rebase workflow outside
this batch. Legacy records missing AppliedOps metadata or stable added-layer
identities are refused, with originals retained. A directory where both a
snapshot and its journal have vanished cannot be distinguished from a legitimate
empty/new directory: there is no independent library inventory in this batch.

Each snapshot or journal is limited to **67,108,864 bytes (64 MiB)** before body
allocation/read. Each recovery diagnostic is limited to **65,536 bytes**. Startup
admits at most **268,435,456 bytes (256 MiB)** of snapshot inputs across the
library. Each parsed snapshot/record admits at most **1,000,000 values** and
**128 levels** of JSON nesting. Journals admit **100,000 records**, retain at most
1,500 records during recovery and expose the existing last 500 for history. A
validated journal above 2,000 records rotates to its last 1,500 after recovered
snapshot publication, with its original bytes preserved first. New edits refuse
before exceeding snapshot/journal byte or journal-record limits. Flush and reopen
can rotate a valid full journal. A separator that would exceed the file cap is
also refused before repair.

These are admission/read/work bounds, not a measured V8 heap ceiling: UTF-8/JSON
objects, staged clones and operation inverses consume additional memory. Directory
enumeration, aggregate journal validation time, archive disk usage and in-memory
library growth are not hard bounded. Legitimate larger legacy files are
unsupported by automatic recovery in this candidate and remain untouched for
separate migration/memory review. The sparse oversized fixtures prove rejection
before reading a body, not successful editing of 64-MiB projects.

## Verification and remaining gates

`tools/recovery-integrity-tests.mjs` runs compiled production DocStore/core/atomic
functions. Its narrow fs hooks inject failures while forwarding actual reads,
writes, copies, truncation and sync to Node. It retains original/corrected builds,
source hashes, failure observations, exact byte checks, backup diagnoses and
reopened-disk checks in owned evidence folders. It uses no substitute store or
append implementation. `build-hooks.mjs` maps test imports to those isolated
compiled bytes; dependencies and existing dist files stay unchanged.

Core/server integration builds use the existing TypeScript dependency:

```powershell
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --outDir tools/recovery-integrity-evidence/final-green/build/core
node node_modules/typescript/bin/tsc -p packages/server/tsconfig.json --outDir tools/recovery-integrity-evidence/final-green/build/server
```

Ordinary builds use the actual packages' compiled files by default. Set
`PICTOCITY_RECOVERY_EVIDENCE` to a fresh run folder before repeating fault cases.
The optional `PICTOCITY_RECOVERY_BUILD` selects a separately frozen build whose
sibling `source/` contains the exact tested store/atomic source. Set `TEMP`/`TMP`
to an owned folder on restricted hosts. Evidence supplies paths, counts and hashes.

Parent integration passed the full reliability, snapshot, cache, HTTP and MCP
suites with actual subprocess transport. The worker's denied-run results below
remain historical worker evidence, separate from those parent results.

Version-1 whole-document imports may omit `createdAt`; that unknown field stays
absent and is never replaced with an invented timestamp. A present malformed or
null creation date still refuses, as do invalid revisions, update dates and
committed log records. The focused legacy-document suite checks admission,
unchanged bytes, edit/reopen and four invalid-date forms. Exact packaged-library
compatibility remains a separate release gate.

Omitted legacy text `wrap` keeps the renderer's existing unwrapped behavior;
no normalization to `true` changes old layouts. Snapshot-only asset name/mime
descriptions may also remain absent. Present invalid values still refuse, and
new `asset.add` records retain the full metadata requirement. Twelve legacy
checks cover these fields, unchanged files, edits, reopen and invalid inputs.

The unchanged core suite passed 70 checks. The full reliability suite passed six
cases then could not run ffprobe because Node child creation returned `EPERM`.
`store-reliability.mjs` selects the ten original store/atomic test bodies verbatim
and retains every assertion; it does not turn the full suite into a pass. The full
cache suite passed ten cases then could not spawn its server (`EPERM`). Its
existing explicit in-process fallback passed 23 cases against copied unchanged
test/editor source and these compiled server/core bytes. That fallback excludes
production subprocess transport. Setup failures and denied-run logs are retained.

Native Windows sharing/failure behavior beyond the observed append-handle
truncation, release packaging, clean-machine operation, actual frontend/native
interaction and creative acceptance remain open. There is no data-directory
ownership lock, reader-atomic multi-file transaction, directory-fsync/power-loss
transaction guarantee, automatic recovery-archive reconciliation, historical
inverse equivalence proof, or cross-client undo ownership in this correction.
Concurrent processes and noncooperating file replacement remain outside the
single-store recovery contract. Do not remove refusal markers or relabel unresolved
diagnoses as resolved without reviewing copies of all affected files, byte
lengths, snapshots, journal sequence and actual write failures first.
