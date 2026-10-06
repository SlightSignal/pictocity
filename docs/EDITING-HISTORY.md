# Editing history

Edits sharing a gesture key within the 1.2-second inactivity window form one
history step. Undo applies each batch's inverse in reverse chronological order,
including changes to different properties or layers and layer additions/removals.
Redo reconstructs the complete gesture from the successful undo result.

Undo, redo and a fresh connection close the previous gesture. An undo or redo
that cannot apply leaves both the document and the retryable history entry in
place and reports the failure. A continuous merged step is capped at 512 forward
and inverse operations; larger gestures continue as separate undoable steps.
The existing 200-entry history limit remains.

Run `node tools/editing-history-tests.mjs` after building the core package. The
suite executes the actual editor store and operation engine with minimal browser
globals. It covers complete round trips, operation ordering, optional properties,
failed atomic batches and bounded continuous gestures. It does not establish
native interaction, cross-client conflict handling or exactly-once offline replay.
The latter remain separate modernization work.
