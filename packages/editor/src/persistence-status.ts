import { readExportJson } from "./export-download";

export type PersistenceState = { kind: "checking" | "healthy" | "recovery" | "unavailable"; errors: string[] };
export class PersistenceMonitor {
  private state: PersistenceState = { kind: "checking", errors: [] };
  private listeners = new Set<(value: PersistenceState) => void>();
  private active = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private request: typeof fetch = (...args) => fetch(...args), private interval = 5000, private timeout = 5000) {}
  current() { return this.state; }
  subscribe(listener: (value: PersistenceState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(value: PersistenceState) { this.state = value; for (const listener of this.listeners) listener(value); }
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (!active) { this.generation++; this.controller?.abort(); this.controller = null; this.pending = null; }
    else void this.refresh();
  }
  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.pending) return this.pending;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const controller = new AbortController(), generation = ++this.generation;
    this.controller = controller;
    const live = () => this.active && this.generation === generation && this.controller === controller;
    const deadline = setTimeout(() => controller.abort(), this.timeout);
    const task = (async () => {
      await Promise.resolve(); // Install ownership before even a synchronous request failure.
      try {
        const response = await this.request("/api/health", { signal: controller.signal, cache: "no-store" });
        const data = await readExportJson(response, controller.signal);
        if (!live()) return;
        if (data?.app !== "Pictocity" || typeof data?.persistence?.ok !== "boolean") throw new Error("Invalid saved-work status");
        if (!data.persistence.ok) {
          const errors = data.persistence.errors && typeof data.persistence.errors === "object" ? Object.values(data.persistence.errors).filter((v): v is string => typeof v === "string").slice(0, 20).map(v => v.slice(0, 2048)) : [];
          this.publish({ kind: "recovery", errors });
        } else if (response.ok && data.ok === true) this.publish({ kind: "healthy", errors: [] });
        else throw new Error("Saved-work status is unavailable");
      } catch {
        if (live()) {
          // A network failure must never clear a previously observed recovery warning.
          if (this.state.kind !== "recovery") this.publish({ kind: "unavailable", errors: [] });
        }
      } finally {
        clearTimeout(deadline);
        if (live()) { this.controller = null; this.pending = null; this.timer = setTimeout(() => void this.refresh(), this.interval); }
      }
    })();
    this.pending = task; return task;
  }
}
export const persistenceMonitor = new PersistenceMonitor();
