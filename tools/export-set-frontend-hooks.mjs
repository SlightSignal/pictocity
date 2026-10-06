// Source-effect fixture only; does not represent React DOM, browser or native acceptance.
export { useState, useRef, useEffect, useCallback, default, useStore, importPsdFile, importSvgFile, importImageFile } from './cache-consistency-hooks.mjs';
export const withToken = url => url;
export const refreshAssets = async () => globalThis.__exportPreflight;
export const assetStatus = () => ({ issues: [] });
