import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync, fstatSync, ftruncateSync, copyFileSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";

/** Stage beside the destination, flush bytes, then replace the completed file. */
export function atomicWrite(file: string, bytes: string | Uint8Array) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx"); writeFileSync(fd, bytes); fsyncSync(fd);
    closeSync(fd); fd = undefined; renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* renamed or never created */ }
  }
}

/** Freeze bytes and diagnosis before a destructive repair. Failure leaves the original alone. */
export function preserveForRecovery(file: string, diagnosis: Record<string, unknown>): string {
  const backup = `${file}.recovery-${randomUUID()}.bak`;
  copyFileSync(file, backup, constants.COPYFILE_EXCL);
  const fd = openSync(backup, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  atomicWrite(backup.slice(0, -4) + ".diagnosis", JSON.stringify({ ...diagnosis, original: file, backup }, null, 2));
  return backup;
}

export class DurableAppendError extends Error {
  constructor(message: string, public rollbackSucceeded: boolean, options: ErrorOptions) { super(message, options); }
}

/** Flush the edit record before acknowledging it to either editing client. */
export function durableAppend(file: string, record: string) {
  const fd = openSync(file, "a");
  let failure: unknown, rollbackSucceeded = false;
  try {
    const before = fstatSync(fd), size = before.size;
    try {
      const bytes = Buffer.from(record); let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error("Journal write made no valid progress");
        offset += written;
      }
      fsyncSync(fd);
    } catch (cause) {
      let backup: string | undefined;
      try {
        backup = preserveForRecovery(file, { reason: "Failed durable append; saved before attempted rollback", originalSize: size, error: String(cause), rollbackSucceeded: false });
        // Windows append-only handles cannot be truncated. Open a repair handle without O_APPEND.
        const repairFd = openSync(file, "r+");
        try {
          const current = fstatSync(repairFd);
          if (current.dev !== before.dev || current.ino !== before.ino) throw new Error("Journal identity changed before rollback");
          ftruncateSync(repairFd, size); fsyncSync(repairFd);
        } finally { closeSync(repairFd); }
        rollbackSucceeded = true;
        atomicWrite(backup.slice(0, -4) + ".diagnosis", JSON.stringify({ reason: "Failed append rolled back and flushed", original: file, backup, originalSize: size, error: String(cause), rollbackSucceeded: true }, null, 2));
      } catch (repair) {
        throw new DurableAppendError(`Journal append failed: ${String(cause)}; rollback unresolved: ${String(repair)}; original ${file}; backup ${backup ?? "preservation failed (inspect retained recovery files)"}`, false, { cause });
      }
      throw new DurableAppendError(`Journal append failed: ${String(cause)}; rollback flushed; backup ${backup}`, true, { cause });
    }
  } catch (e) { failure = e; }
  try { closeSync(fd); }
  catch (e) { failure = new DurableAppendError(`Journal descriptor close failed: ${String(e)}${failure ? `; earlier failure: ${String(failure)}` : ""}; inspect ${file} before editing`, false, { cause: failure ?? e }); }
  if (failure) {
    let error = failure instanceof DurableAppendError ? failure : new DurableAppendError(`Journal append failed: ${String(failure)}; inspect ${file} before editing`, rollbackSucceeded, { cause: failure });
    if (!error.rollbackSucceeded) {
      // If even backup creation failed, leave a separate conservative reopen refusal when possible.
      const marker = `${file}.recovery-error`;
      try { atomicWrite(marker, JSON.stringify({ original: file, error: error.message, rollbackSucceeded: false }, null, 2)); }
      catch (e) { error = new DurableAppendError(`${error.message}; could not persist refusal marker ${marker}: ${String(e)}`, false, { cause: error }); }
    }
    throw error;
  }
}
