import React, { useEffect, useState } from "react";
import { persistenceMonitor } from "../persistence-status";

export function PersistenceNotice() {
  const [state, setState] = useState(persistenceMonitor.current());
  useEffect(() => {
    const unsubscribe = persistenceMonitor.subscribe(setState);
    const visibility = () => persistenceMonitor.setActive(document.visibilityState === "visible");
    const focus = () => { void persistenceMonitor.refresh(); };
    visibility(); document.addEventListener("visibilitychange", visibility); window.addEventListener("focus", focus);
    return () => { unsubscribe(); persistenceMonitor.setActive(false); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("focus", focus); };
  }, []);
  if (state.kind === "healthy" || state.kind === "checking") return null;
  return <div className="persistence-notice" role="alert">
    <div className="row"><strong>{state.kind === "recovery" ? "Saved work needs recovery. Editing is paused to protect your files." : "Could not verify saved work. Some changes may still be waiting to save."}</strong>
      <button className="btn" onClick={() => void persistenceMonitor.refresh()}>Check saved work</button></div>
    {state.kind === "recovery" && <details><summary>Recovery details</summary>
      <p>Keep your data folder intact. Restore the affected files from a known good backup, then restart Pictocity.</p>
      {state.errors.length > 0 && <ul>{state.errors.map((error, i) => <li key={i}>{error}</li>)}</ul>}
    </details>}
  </div>;
}
