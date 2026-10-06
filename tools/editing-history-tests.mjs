import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createCanvas } from '@napi-rs/canvas';
import { createDocument, makeShape, deepClone } from '@pictocity/core';

// Execute the actual editor store and operation engine. Minimal browser globals
// provide the environment; this does not assert React DOM or native behavior.
globalThis.location = { href:'http://127.0.0.1:4100/', protocol:'http:', host:'127.0.0.1:4100' };
globalThis.sessionStorage = { getItem(){return null;}, setItem(){} };
globalThis.history = { replaceState(){} };
globalThis.window = { fetch:globalThis.fetch, addEventListener(){}, removeEventListener(){} };
globalThis.document = { visibilityState:'hidden', addEventListener(){}, removeEventListener(){},
  createElement(tag){assert.equal(tag,'canvas');return createCanvas(1,1);} };
globalThis.WebSocket = { OPEN:1 };
const editor = pathToFileURL(resolve('packages/editor/src/')).href;
registerHooks({
  resolve(specifier,context,next) {
    if(context.parentURL?.startsWith(editor) && specifier.startsWith('.')) {
      for(const ext of ['.ts','.tsx']) {
        const url = new URL(specifier+ext,context.parentURL);
        if(existsSync(fileURLToPath(url))) return {url:url.href,shortCircuit:true};
      }
    }
    return next(specifier,context);
  },
  load(url,context,next) {
    if(url.startsWith(editor) && /\.tsx?$/.test(url)) return {format:'module',shortCircuit:true,
      source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText};
    return next(url,context);
  }
});
const {useStore} = await import('../packages/editor/src/store.ts');
const label=process.env.PICTOCITY_HISTORY_LABEL ?? new Date().toISOString().replace(/[:.]/g,'-');
assert.match(label,/^[a-zA-Z0-9-]+$/);
const root=resolve('tools/editing-history-evidence',label);mkdirSync(root,{recursive:true});
const report={schema:'pictocity-editing-history/v1',scope:'actual production editor store and core operations; no WebSocket/DOM/native acceptance',sourceSha256:createHash('sha256').update(readFileSync('packages/editor/src/store.ts')).digest('hex'),cases:[]};
const canonical=doc=>{const value=deepClone(doc);delete value.updatedAt;return value;};
function reset(layers=[makeShape({id:'one',x:2,y:3,width:30,height:20})]) {
  const doc=createDocument({name:'History engineering fixture',width:200,height:100,background:null});
  doc.layers=layers;
  useStore.setState({doc,undoStack:[],redoStack:[],selection:[],actor:'editor:fixture',toast:null});
  return canonical(doc);
}
const edit=(ops,key='gesture')=>useStore.getState().dispatch(ops,'Fixture edit',{mergeKey:key});
let failures=0;
async function test(name,run) {
  try {await run();report.cases.push({name,status:'pass'});console.log('ok '+name);}
  catch(e){failures++;report.cases.push({name,status:'fail',error:String(e)});console.log('FAIL '+name+': '+e.message);}
  writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));
}
await test('Merged different properties restore the whole pre-gesture document and redo exactly',()=>{
  const before=reset();edit([{type:'layer.set',id:'one',props:{x:40}}]);edit([{type:'layer.set',id:'one',props:{y:60}}]);
  const after=canonical(useStore.getState().doc);assert.equal(useStore.getState().undoStack.length,1);
  useStore.getState().undo();assert.deepEqual(canonical(useStore.getState().doc),before);
  useStore.getState().redo();assert.deepEqual(canonical(useStore.getState().doc),after);
});
await test('Merged edits to two layers undo both and preserve inverse order',()=>{
  const before=reset([makeShape({id:'one',x:2}),makeShape({id:'two',x:8})]);
  edit([{type:'layer.set',id:'one',props:{x:40}}]);edit([{type:'layer.set',id:'two',props:{x:90}}]);
  useStore.getState().undo();assert.deepEqual(canonical(useStore.getState().doc),before);
});
await test('Repeated same-property edits return the original value through three undo/redo cycles',()=>{
  const before=reset();for(const x of [4,20,80])edit([{type:'layer.set',id:'one',props:{x}}]);
  const after=canonical(useStore.getState().doc);
  for(let i=0;i<3;i++){useStore.getState().undo();assert.deepEqual(canonical(useStore.getState().doc),before);useStore.getState().redo();assert.deepEqual(canonical(useStore.getState().doc),after);}
});
await test('Merged add-then-remove is an atomic reversible gesture',()=>{
  const before=reset([]);edit([{type:'layer.add',layer:makeShape({id:'new'}),parentId:null,index:0}]);edit([{type:'layer.remove',id:'new'}]);
  assert.equal(useStore.getState().undoStack.length,1);useStore.getState().undo();
  assert.equal(useStore.getState().undoStack.length,0);assert.equal(useStore.getState().redoStack.length,1);assert.deepEqual(canonical(useStore.getState().doc),before);
  useStore.getState().redo();assert.deepEqual(canonical(useStore.getState().doc),before);
});
await test('Merged additions remove every new layer on undo',()=>{
  const before=reset([]);for(const id of ['a','b'])edit([{type:'layer.add',layer:makeShape({id}),parentId:null,index:0}]);
  useStore.getState().undo();assert.deepEqual(canonical(useStore.getState().doc),before);
});
await test('Absent optional properties and separate document changes restore exactly',()=>{
  const before=reset();edit([{type:'layer.set',id:'one',props:{styles:{dropShadow:{color:'#000',opacity:0.5,blur:4,x:2,y:3}}}}]);
  edit([{type:'doc.set',props:{name:'Changed'}}]);useStore.getState().undo();assert.deepEqual(canonical(useStore.getState().doc),before);
});
await test('Different keys and an expired gesture remain separate history steps',()=>{
  reset();edit([{type:'layer.set',id:'one',props:{x:40}}],'x');edit([{type:'layer.set',id:'one',props:{y:60}}],'y');
  assert.equal(useStore.getState().undoStack.length,2);
  const old=useStore.getState().undoStack;useStore.setState({undoStack:[...old.slice(0,-1),{...old.at(-1),at:Date.now()-1300}]});
  edit([{type:'layer.set',id:'one',props:{y:70}}],'y');assert.equal(useStore.getState().undoStack.length,3);
});
await test('Undo and redo close the old gesture before a fresh edit with the same key',()=>{
  reset();edit([{type:'layer.set',id:'one',props:{x:40}}]);useStore.getState().undo();useStore.getState().redo();
  edit([{type:'layer.set',id:'one',props:{y:60}}]);assert.equal(useStore.getState().undoStack.length,2);
  useStore.getState().undo();assert.equal(useStore.getState().doc.layers[0].x,40);assert.equal(useStore.getState().doc.layers[0].y,3);
});
await test('A failed undo keeps the complete document and retryable history entry',()=>{
  reset();edit([{type:'layer.set',id:'one',props:{x:40}}]);const missing=deepClone(useStore.getState().doc);missing.layers=[];
  useStore.setState({doc:missing});const before=canonical(missing),entry=useStore.getState().undoStack.at(-1);
  useStore.getState().undo();assert.deepEqual(canonical(useStore.getState().doc),before);assert.equal(useStore.getState().undoStack.at(-1),entry);assert.match(useStore.getState().toast,/Can't undo/);
});
await test('A failed redo keeps the complete document and retryable redo entry',()=>{
  reset();edit([{type:'layer.set',id:'one',props:{x:40}}]);useStore.getState().undo();const missing=deepClone(useStore.getState().doc);missing.layers=[];
  useStore.setState({doc:missing});const before=canonical(missing),entry=useStore.getState().redoStack.at(-1);
  useStore.getState().redo();assert.deepEqual(canonical(useStore.getState().doc),before);assert.equal(useStore.getState().redoStack.at(-1),entry);assert.match(useStore.getState().toast,/Can't redo/);
});
await test('A rejected local batch changes neither document nor undo stack',()=>{
  const before=reset();edit([{type:'layer.set',id:'one',props:{x:40}},{type:'layer.set',id:'missing',props:{y:5}}]);
  assert.deepEqual(canonical(useStore.getState().doc),before);assert.equal(useStore.getState().undoStack.length,0);
});
await test('A long continuous gesture stays bounded and every history segment remains reversible',()=>{
  const before=reset();for(let i=0;i<600;i++)edit([{type:'layer.set',id:'one',props:{x:i}}],'long-gesture');
  assert.ok(useStore.getState().undoStack.length>1);
  assert.ok(useStore.getState().undoStack.every(e=>e.ops.length<=512 && e.inverse.length<=512));
  while(useStore.getState().undoStack.length)useStore.getState().undo();
  assert.deepEqual(canonical(useStore.getState().doc),before);
  while(useStore.getState().redoStack.length)useStore.getState().redo();
  assert.equal(useStore.getState().doc.layers[0].x,599);
});
report.passed=report.cases.length-failures;report.failed=failures;writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,failed:failures,report:join(root,'report.json')}));
if(failures)process.exitCode=1;
