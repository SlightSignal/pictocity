// Deterministic source-effect fixture, NOT React DOM or a native/browser session.
export const useState = (initial) => globalThis.__cacheHooks.state(initial);
export const useRef = (initial) => globalThis.__cacheHooks.ref(initial);
export const useEffect = (fn, deps) => globalThis.__cacheHooks.effect(fn, deps);
export const useCallback = (fn, deps) => globalThis.__cacheHooks.callback(fn, deps);
export default { useState, useRef, useEffect, useCallback };
export const useStore = Object.assign((selector) => selector(globalThis.__cacheStore.useStore.getState()), {
  getState: () => globalThis.__cacheStore.useStore.getState(),
  setState: (...args) => globalThis.__cacheStore.useStore.setState(...args),
});
export const topLevelOnly = (...args) => globalThis.__cacheStore.topLevelOnly(...args);
export const unionBounds = (...args) => globalThis.__cacheStore.unionBounds(...args);
export const importPsdFile = () => { throw new Error("Not exercised in this fixture"); };
export const importSvgFile = importPsdFile, importImageFile = importPsdFile;

export const elements = (tree) => Array.isArray(tree) ? tree.flatMap(elements) : tree && typeof tree === "object" ? [tree, ...elements(tree.props?.children)] : [];
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
export class EffectFixture {
  slots = []; cursor = 0; queued = []; dirty = true; alive = true; setsAfterUnmount = 0;
  constructor(component, attach) { this.component = component; this.attach = attach; this.unsubscribe = globalThis.__cacheStore.useStore.subscribe(() => { this.dirty = true; }); }
  state(initial) {
    const index = this.cursor++;
    this.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
    return [this.slots[index].value, (value) => {
      if (!this.alive) { this.setsAfterUnmount++; return; }
      const next = typeof value === "function" ? value(this.slots[index].value) : value;
      if (!Object.is(next, this.slots[index].value)) { this.slots[index].value = next; this.dirty = true; }
    }];
  }
  ref(initial) { const index = this.cursor++; this.slots[index] ??= { current: initial }; return this.slots[index]; }
  callback(fn, deps) { const index = this.cursor++; if (!same(this.slots[index]?.deps, deps)) this.slots[index] = { value: fn, deps }; return this.slots[index].value; }
  effect(fn, deps) {
    const index = this.cursor++, prior = this.slots[index];
    if (!same(prior?.deps, deps)) { this.slots[index] = { deps, cleanup: prior?.cleanup }; this.queued.push(() => { prior?.cleanup?.(); this.slots[index].cleanup = fn(); }); }
  }
  settle() {
    for (let pass = 0; this.dirty; pass++) {
      if (pass > 20) throw new Error("Effect fixture did not settle");
      this.dirty = false; this.cursor = 0; globalThis.__cacheHooks = this;
      this.tree = this.component(); this.attach?.(this.tree);
      for (const effect of this.queued.splice(0)) effect();
    }
    return this.tree;
  }
  close() { this.alive = false; this.unsubscribe(); for (const slot of this.slots) slot?.cleanup?.(); }
}
