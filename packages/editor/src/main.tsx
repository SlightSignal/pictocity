import React from "react";
import { renderDocument } from "@pictocity/core";
import { browserEnv } from "./env";

/** One rendering bug must not white-screen the whole editor; the document is safe on the server regardless. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("pictocity UI error", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", color: "#e8e8e8", background: "#1e1e1e", height: "100vh" }}>
        <h2 style={{ marginTop: 0 }}>Something went wrong in the editor</h2>
        <p>Your document is saved on the server — nothing is lost. Reloading restores the last state.</p>
        <pre style={{ whiteSpace: "pre-wrap", color: "#f0a534", fontSize: 12 }}>{String(this.state.error?.stack ?? this.state.error)}</pre>
        <button onClick={() => location.reload()} style={{ padding: "6px 14px" }}>Reload</button>
      </div>
    );
  }
}

import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import "./styles.css";
import { useStore } from "./store";

// Debug/automation hook: window.__pictocity.getState() exposes the editor store.
(window as unknown as { __pictocity: typeof useStore }).__pictocity = useStore;
// Renders the current document with the browser engine at a given scale (for what-you-see-is-what-you-export checks).
(window as unknown as { __pictocityRender?: (scale: number) => string | null }).__pictocityRender = (scale: number) => {
  const doc = useStore.getState().doc; if (!doc) return null;
  return (renderDocument(doc, browserEnv, { scale }) as unknown as HTMLCanvasElement).toDataURL("image/png");
};

createRoot(document.getElementById("root")!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
