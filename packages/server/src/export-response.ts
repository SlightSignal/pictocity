import { AsyncLocalStorage } from "node:async_hooks";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";

interface PendingResponse {
  status: number; headers: OutgoingHttpHeaders; body?: string | Uint8Array; ready: boolean;
}
const pending = new AsyncLocalStorage<PendingResponse>();

/** Buffer the response boundary, not a batch of encoded files, until resource cleanup finishes. */
export function exportResponse(response: ServerResponse) {
  const state = pending.getStore();
  if (!state) return response;
  return {
    writeHead(status: number, headers: OutgoingHttpHeaders) { state.status = status; state.headers = headers; },
    end(body?: string | Uint8Array) {
      if (state.ready) throw new Error("Export response was prepared twice");
      state.body = body; state.ready = true;
    },
  };
}

export async function afterExportCleanup<T>(response: ServerResponse, action: () => Promise<T>): Promise<T> {
  const state: PendingResponse = { status: 200, headers: {}, ready: false };
  const value = await pending.run(state, action);
  if (!state.ready) throw new Error("Export completed without a response");
  if (response.destroyed || response.writableEnded) throw Object.assign(new Error("Export request ended before completion"), { status: 499 });
  response.writeHead(state.status, state.headers); response.end(state.body);
  return value;
}
