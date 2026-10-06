// Owned HTTP-test preload. Only filesystem stage/publication failures are controlled.
// Production render-process.js, its IPC and encoders are untouched.
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
const control = process.env.PICTOCITY_EXPORT_TEST_CONTROL;
if (control) {
  const original = { open: promises.open, rename: promises.rename, rm: promises.rm };
  const config = () => { try { return JSON.parse(fs.readFileSync(control, 'utf8')); } catch { return {}; } };
  const error = (what) => Object.assign(new Error(`Injected ${what} failure`), { code: 'EACCES' });
  const pause = async (kind, index) => {
    const cfg = config(); if (cfg[kind] !== index) return;
    fs.writeFileSync(control + '.checkpoint', JSON.stringify({ kind, index, pid: process.pid }));
    const until = Date.now() + 30_000;
    while (!fs.existsSync(control + '.release')) {
      if (Date.now() > until) throw new Error('Owned fault checkpoint timed out');
      await new Promise(r => setTimeout(r, 10));
    }
  };
  promises.open = async (file, flags, ...args) => {
    const path = String(file), index = Number(basename(path));
    if (basename(dirname(path)) === 'new' && config().failStage === index && flags === 'wx') throw error('stage');
    const handle = await original.open(file, flags, ...args);
    if (basename(dirname(path)) === 'new' && flags === 'wx') {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); await pause('pauseStage', index); };
    }
    return handle;
  };
  promises.rename = async (source, target) => {
    const folder = basename(dirname(String(source))), index = Number(basename(String(source))), cfg = config();
    if (folder === 'new' && cfg.failPublish === index) throw error('publication');
    if (folder === 'backup' && cfg.failRollback === index) throw error('rollback');
    const result = await original.rename(source, target);
    if (folder === 'new') await pause('pausePublish', index);
    return result;
  };
  promises.rm = async (path, ...args) => {
    const cfg = config(), name = basename(String(path));
    if ((cfg.failCleanup && name === '.pictocity-export-set.lock') || (cfg.failResourceCleanup && name.startsWith('pictocity-resources-'))) throw error('cleanup');
    return original.rm(path, ...args);
  };
  syncBuiltinESMExports();
}
