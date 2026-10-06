import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const editor=pathToFileURL(resolve('packages/editor/src/')).href;
registerHooks({resolve(specifier,context,next){if(context.parentURL?.startsWith(editor)&&specifier.startsWith('.')){const url=new URL(specifier+'.ts',context.parentURL);if(existsSync(fileURLToPath(url)))return {url:url.href,shortCircuit:true};}return next(specifier,context);},load(url,context,next){if(url.startsWith(editor)&&url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};return next(url,context);}});
const {PersistenceMonitor}=await import('../packages/editor/src/persistence-status.ts');
const root=resolve('tools/persistence-status-evidence',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(root,{recursive:true});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const report={schema:'pictocity-persistence-status-tests/v1',scope:'actual production monitor and streamed response helper; no native or React DOM acceptance',hashes:Object.fromEntries(['packages/editor/src/persistence-status.ts','packages/editor/src/components/PersistenceNotice.tsx','packaging/pictocity_app.py'].map(p=>[p,hash(p)])),cases:[]};
const response=(ok,status=ok?200:503)=>new Response(JSON.stringify({app:'Pictocity',ok,persistence:{ok,errors:ok?{}:{fixture:'A damaged snapshot needs recovery'}}}),{status});
const delay=ms=>new Promise(r=>setTimeout(r,ms));const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function test(name,fn){await fn();report.cases.push({name,status:'pass'});console.log('ok '+name);writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));}
await test('A 503 recovery report is visible and a network failure cannot clear it',async()=>{
  let fail=false;const m=new PersistenceMonitor(async()=>{if(fail)throw new Error('offline');return response(false);},10000,100);
  m.setActive(true);await m.refresh();assert.equal(m.current().kind,'recovery');assert.match(m.current().errors[0],/damaged/);
  fail=true;await m.refresh();assert.equal(m.current().kind,'recovery');m.setActive(false);
});
await test('Only a fresh valid healthy service report clears recovery',async()=>{
  let ok=false;const m=new PersistenceMonitor(async()=>response(ok),10000,100);m.setActive(true);await m.refresh();
  assert.equal(m.current().kind,'recovery');ok=true;await m.refresh();assert.equal(m.current().kind,'healthy');m.setActive(false);
});
await test('Concurrent checks coalesce and hidden/unmounted work aborts without late publication',async()=>{
  const d=deferred();let requests=0,signal;const m=new PersistenceMonitor(async(_url,options)=>{requests++;signal=options.signal;return d.promise;},10000,1000);
  m.setActive(true);const task=m.refresh();assert.equal(m.refresh(),task);await delay(0);assert.equal(requests,1);
  m.setActive(false);assert.equal(signal.aborted,true);d.resolve(response(false));await task;assert.equal(m.current().kind,'checking');
});
await test('A stale response after reactivation cannot overwrite newer saved-work status',async()=>{
  const d=deferred();let count=0;const m=new PersistenceMonitor(async()=>++count===1?d.promise:response(true),10000,1000);
  m.setActive(true);const old=m.refresh();await delay(0);m.setActive(false);m.setActive(true);await m.refresh();
  assert.equal(m.current().kind,'healthy');d.resolve(response(false));await old;assert.equal(m.current().kind,'healthy');m.setActive(false);
});
await test('Request deadlines abort transport and report unavailable status',async()=>{
  let signal;const m=new PersistenceMonitor((_url,options)=>new Promise((_resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(new DOMException('Timeout','AbortError')),{once:true});}),10000,10);
  m.setActive(true);await m.refresh();assert.equal(signal.aborted,true);assert.equal(m.current().kind,'unavailable');m.setActive(false);
});
await test('Invalid and oversized status bodies refuse instead of reporting healthy',async()=>{
  for(const body of ['{}','null','invalid',JSON.stringify({app:'Other',ok:true,persistence:{ok:true}}),'x'.repeat(65537)]){
    const m=new PersistenceMonitor(async()=>new Response(body),10000,100);m.setActive(true);await m.refresh();assert.equal(m.current().kind,'unavailable');m.setActive(false);
  }
});
await test('Synchronous request errors retire correctly and a subsequent check can recover',async()=>{
  let first=true;const m=new PersistenceMonitor(()=>{if(first){first=false;throw new Error('sync failure');}return Promise.resolve(response(true));},10000,100);
  m.setActive(true);await m.refresh();assert.equal(m.current().kind,'unavailable');await m.refresh();assert.equal(m.current().kind,'healthy');m.setActive(false);
});
await test('Stopping clears periodic work and prevents further requests or notifications',async()=>{
  let requests=0,changes=0;const m=new PersistenceMonitor(async()=>{requests++;return response(true);},10,100);const unsubscribe=m.subscribe(()=>changes++);
  m.setActive(true);await m.refresh();m.setActive(false);unsubscribe();const before={requests,changes};await delay(35);assert.deepEqual({requests,changes},before);
});
report.complete=true;writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.cases.length,report:join(root,'report.json')}));
