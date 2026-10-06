import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const heldOwners = new Set<ReturnType<typeof createServer>>();

export class DataOwnershipError extends Error {
  readonly exitCode: number;
  constructor(message: string, readonly kind: "busy" | "unavailable") {
    super(message); this.name = "DataOwnershipError";
    this.exitCode = kind === "busy" ? 73 : 74;
  }
}

/** Same-host ownership for cooperating server processes, before library writes.
 * Windows named pipes and Linux abstract sockets disappear on process exit,
 * including a crash. Other Unix hosts refuse an existing socket rather than
 * guessing whether it is stale. This is not a distributed filesystem lock. */
export async function acquireDataOwnership(directory: string): Promise<{
  readonly acquired: true; readonly scope: "same-host"; readonly mode: string;
}> {
  const path = resolve(directory);
  mkdirSync(path, { recursive: true });
  const canonical = realpathSync.native(path);
  const stat = statSync(canonical, { bigint: true });
  if (!stat.isDirectory() || stat.ino === 0n) {
    throw new DataOwnershipError("Cannot identify the library directory safely. Choose a supported local data folder.", "unavailable");
  }
  // Directory identity, not spelling: junctions, case aliases and renames must
  // not admit a second owner of the same local filesystem directory.
  const key = createHash("sha256").update(`pictocity-data-owner-v1:${stat.dev}:${stat.ino}`).digest("hex");
  const mode = process.platform === "win32" ? "windows-named-pipe" : process.platform === "linux" ? "linux-abstract-socket" : "unix-path-socket";
  const endpoint = mode === "windows-named-pipe" ? `\\\\.\\pipe\\pictocity-data-${key}`
    : mode === "linux-abstract-socket" ? `\0pictocity-data-${key}`
    : join(canonical, ".pictocity-owner.sock");
  const owner = createServer(socket => socket.destroy());
  await new Promise<void>((accepted, refused) => {
    const failed = (error: NodeJS.ErrnoException) => {
      const busy = error.code === "EADDRINUSE";
      refused(new DataOwnershipError(busy
        ? "Another Pictocity instance is using this library. Close that instance before opening it again."
        : `Pictocity cannot confirm exclusive library access (${error.code ?? "unknown"}). Review the data folder before opening it.`, busy ? "busy" : "unavailable"));
    };
    owner.once("error", failed);
    owner.listen({ path: endpoint, exclusive: true }, () => {
      owner.removeListener("error", failed); owner.unref(); heldOwners.add(owner); accepted();
    });
  });
  // Keep the bound OS handle for the entire process lifetime. No caller-facing
  // release method can unlock it while queued saves or exports are still live.
  // An unexpected later server error is fatal, rather than losing ownership
  // silently and continuing to write. No connection is served any data.
  return Object.freeze({ acquired: true, scope: "same-host", mode });
}
