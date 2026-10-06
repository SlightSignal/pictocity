// Deterministic FontFace/DOM adapter for the real editor env.ts. This is not a browser.
export function installFontFixture() {
  const state = { list: [], faces: [], failures: new Set(), installed: new Set() };
  globalThis.location = { href: 'http://font-fixture.invalid/' };
  globalThis.sessionStorage = { getItem: () => null, setItem() {} };
  globalThis.history = { replaceState() {} };
  const fetchFonts = async () => state.fetch ? state.fetch() : new Response(JSON.stringify(state.list));
  globalThis.fetch = fetchFonts;
  globalThis.window = Object.assign(new EventTarget(), { fetch: fetchFonts });
  globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: 'visible', createElement: () => ({ getContext: () => ({}) }),
    fonts: { add: face => state.installed.add(face), delete: face => state.installed.delete(face) },
  });
  globalThis.FontFace = class {
    constructor(family, source, descriptors) {
      Object.assign(this, { family, source, descriptors }); state.faces.push(this);
    }
    async load() {
      if (state.failures.has(this.source)) throw new Error('Fixture decode failure: ' + this.source);
      return this;
    }
  };
  return state;
}
