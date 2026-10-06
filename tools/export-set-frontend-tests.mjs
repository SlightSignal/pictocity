import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createDocument, makeArtboard, captureComp } from '../packages/core/dist/index.js';
import { EffectFixture, elements } from './cache-consistency-hooks.mjs';
import { productionDownload, productionHelperPath } from './export-download-production.mjs';
const root=resolve('tools/export-set-evidence',new Date().toISOString().replace(/[:.]/g,'-')+'-frontend');mkdirSync(root,{recursive:true});
const report={scope:'deterministic source-effect/transport fixture with actual ZIP helper; no DOM/browser/native or production-render acceptance',sourceHashes:Object.fromEntries([productionHelperPath,resolve('packages/editor/src/components/Dialogs.tsx')].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')])),cases:[]};
const dialog=pathToFileURL(resolve('packages/editor/src/components/Dialogs.tsx')).href,adapter=pathToFileURL(resolve('tools/export-set-frontend-hooks.mjs')).href;
registerHooks({
  resolve(specifier,context,next){if(context.parentURL===dialog&&['react','../store','../env','./Chrome'].includes(specifier))return {url:adapter,shortCircuit:true};return next(specifier,context);},
  load(url,context,next){if(url===dialog)return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText};return next(url,context);}
});
const {ExportDialog}=await import(dialog),delay=ms=>new Promise(r=>setTimeout(r,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const hash=b=>createHash('sha256').update(b).digest('hex');
const calls=[],clicks=[],urls=new Map(),listeners=new Set();let state,intercept,id=0;
globalThis.__cacheStore={useStore:{getState:()=>state,setState:patch=>{state={...state,...patch};for(const fn of listeners)fn();},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}};
globalThis.window=new EventTarget();globalThis.document=Object.assign(new EventTarget(),{visibilityState:'visible',createElement:()=>({click(){clicks.push({href:this.href,name:this.download});}})});
const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
URL.createObjectURL=blob=>{const url=`blob:export-fixture-${++id}`;urls.set(url,blob);return url;};URL.revokeObjectURL=url=>urls.delete(url);
globalThis.fetch=async(url,init)=>{calls.push({url,init});if(String(url).includes('render-status'))return new Response(JSON.stringify({active:null,resources:{capturing:[]},exportSets:{live:[]}}));return intercept(url,init);};
const install=(doc=createDocument({name:'Frontend',width:128,height:64}))=>{state={doc,connection:'online',selection:[]};globalThis.__exportPreflight={ok:true,docId:doc.id,revision:doc.rev,issues:[],resourceSnapshot:{sha256:'a'.repeat(64)}};return doc;};
const attach=tree=>{for(const e of elements(tree))if(['button','a'].includes(e.type)&&e.ref)e.ref.current={disabled:e.props.disabled,focus(){report.focusRestorations=(report.focusRestorations??0)+1;if(e.type==='a')report.archiveFocusRestorations=(report.archiveFocusRestorations??0)+1;}};};
const ready=async fixture=>{for(let i=0;i<100;i++){fixture.settle();const e=elements(fixture.tree).find(e=>e.type==='button'&&e.props.children==='Export'&&!e.props.disabled);if(e)return e;await delay(10);}throw new Error('Dialog readiness timeout');};
const field=(f,label)=>elements(f.tree).find(e=>e.props?.['aria-label']===label);
const button=(f,label)=>elements(f.tree).find(e=>e.type==='button'&&e.props.children===label);
const memberBytes=i=>Buffer.from('captured actual member '+i);
const makeEnvelope=(names,doc=state.doc,change=m=>m,bytes=names.map((_,i)=>memberBytes(i)))=>{
  const manifest=change({version:1,resourceSnapshot:{revision:doc.rev,sha256:'a'.repeat(64)},files:names.map((name,i)=>({name,bytes:bytes[i].length,mime:'image/png',sha256:hash(bytes[i])}))});
  const m=Buffer.from(JSON.stringify(manifest)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(m.length);return Buffer.concat([prefix,m,...bytes]);
};
const setResponse=bytes=>new Response(bytes,{headers:{'content-type':'application/vnd.pictocity.export-set','content-length':String(bytes.length)}});
const test=async(name,run)=>{if(process.env.PICTOCITY_FRONTEND_CASE&&!name.includes(process.env.PICTOCITY_FRONTEND_CASE))return;calls.length=0;clicks.length=0;try{await run();assert.equal(urls.size,0,'Owned object URLs must retire');report.cases.push({name,status:'pass'});console.log('ok '+name);}catch(e){report.cases.push({name,status:'fail',error:String(e)});throw e;}finally{writeFileSync(join(root,'frontend-report.json'),JSON.stringify(report,null,2));}};
// Model a user's activation of one returned anchor; this is not browser/DOM verification.
const activate=link=>{let prevented=false;link.props.onClick?.({preventDefault(){prevented=true;}});if(!prevented){const a=document.createElement('a');a.href=link.props.href;a.download=link.props.download;a.click();}return !prevented;};
try {
  await test('resource refresh during a pending export retires the request before response admission',async()=>{
    const doc=install(),fixture=new EffectFixture(ExportDialog,attach),gate=deferred();let pending;
    try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();intercept=()=>gate.promise;pending=button(fixture,'Export').props.onClick();fixture.settle();
      globalThis.__exportPreflight={...globalThis.__exportPreflight,resourceSnapshot:{sha256:'b'.repeat(64)}};window.dispatchEvent(new Event('focus'));await delay(350);fixture.settle();
      assert.equal(calls.find(c=>c.url.includes('/export-set')).init.signal.aborted,true,'Changed reviewed resources must retire in-flight exports');
      gate.resolve(setResponse(makeEnvelope(['one.png','two.png'],doc)));await pending;fixture.settle();assert.equal(urls.size,0);assert.equal(clicks.length,0);
    }finally{fixture.close();gate.resolve(setResponse(makeEnvelope(['one.png','two.png'],doc)));await pending;}
  });
  await test('production set response streams without any unbounded convenience allocation',async()=>{
    install();const fixture=new EffectFixture(ExportDialog,attach);let unbounded=0;
    try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();
      intercept=async()=>{const bytes=makeEnvelope(['one.png','two.png']),response=new Response(bytes,{headers:{'content-type':'application/vnd.pictocity.export-set','content-length':String(bytes.length)}});for(const method of ['arrayBuffer','blob','json']){const original=response[method].bind(response);response[method]=()=>{unbounded++;return original();};}return response;};
      await button(fixture,'Export').props.onClick();fixture.settle();assert.equal(unbounded,0,'No whole-response convenience reader may be used');assert.equal(elements(fixture.tree).filter(e=>e.type==='a').length,3);assert.equal(clicks.length,0);
    }finally{fixture.close();}
  });
  await test('set response declared lengths, MIME and bounded JSON errors cannot admit links',async()=>{
    for(const kind of ['over-limit','negative','truncated','extra','MIME','json-error']){
      install();const fixture=new EffectFixture(ExportDialog,attach);let response,cancelled=0,unbounded=0;
      try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();
        intercept=async()=>{const bytes=makeEnvelope(['one.png','two.png']);let chunk=bytes;const headers={'content-type':kind==='MIME'?'application/zip':'application/vnd.pictocity.export-set','content-length':String(kind==='over-limit'?productionDownload.EXPORT_DOWNLOAD_LIMITS.envelopeBytes+1:kind==='negative'?-1:kind==='truncated'?bytes.length+1:kind==='extra'?bytes.length-1:bytes.length)};
          if(kind==='json-error'){chunk=Buffer.alloc(productionDownload.EXPORT_DOWNLOAD_LIMITS.jsonBytes+1,32);delete headers['content-length'];}
          response=new Response(new ReadableStream({pull(c){c.enqueue(chunk);if(kind==='truncated')c.close();},cancel(){cancelled++;}},{highWaterMark:0}),{headers,status:kind==='json-error'?500:200});
          for(const method of ['arrayBuffer','blob','json'])response[method]=()=>{unbounded++;throw new Error('Unbounded reader');};return response;};
        await button(fixture,'Export').props.onClick();fixture.settle();assert.equal(unbounded,0);assert.equal(response.body.locked,false);if(kind!=='truncated')assert.equal(cancelled,1);assert.equal(urls.size,0);assert.equal(elements(fixture.tree).filter(e=>e.type==='a').length,0);assert.equal(clicks.length,0);
      }finally{fixture.close();}
    }
  });
  for(const action of ['cancel','unmount','options','switch'])await test(`partial streamed set response after ${action} cancels its reader and admits no URLs`,async()=>{
    const doc=install(),fixture=new EffectFixture(ExportDialog,attach),started=deferred();let cancelled=0,response,pending;
    try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();
      intercept=async()=>{const bytes=makeEnvelope(['one.png','two.png']);response=new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,4));},pull(){started.resolve();},cancel(){cancelled++;}},{highWaterMark:0}),{headers:{'content-type':'application/vnd.pictocity.export-set','content-length':String(bytes.length)}});return response;};
      pending=button(fixture,'Export').props.onClick();fixture.settle();await started.promise;
      if(action==='cancel')button(fixture,'Cancel export').props.onClick();else if(action==='unmount')fixture.close();else if(action==='options')field(fixture,'Format').props.onChange({target:{value:'pdf'}});else globalThis.__cacheStore.useStore.setState({doc:{...doc,id:'switched'}});if(fixture.alive)fixture.settle();
      await pending;if(fixture.alive)fixture.settle();assert.equal(cancelled,1);assert.equal(response.body.locked,false);assert.equal(urls.size,0);assert.equal(clicks.length,0);assert.equal(fixture.setsAfterUnmount,0);
    }finally{if(fixture.alive)fixture.close();await pending;}
  });
  await test('multi-scale Download uses one guarded set request, validates all bytes and prepares one explicit archive Save',async()=>{
    install();const body=deferred(),fixture=new EffectFixture(ExportDialog,attach);let stream;try{
      await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();
      intercept=async()=>new Response(new ReadableStream({start(c){stream=c;body.resolve();}}),{headers:{'content-type':'application/vnd.pictocity.export-set'}});const exporting=button(fixture,'Export').props.onClick();fixture.settle();await delay(0);assert.equal(clicks.length,0);
      const request=calls.find(c=>c.url.includes('/export-set'));assert.ok(request);const q=JSON.parse(request.init.body);assert.deepEqual(q.scales,[1,2]);assert.equal(q.expectedRev,0);assert.equal(q.expectedResources,'a'.repeat(64));assert.equal(q.destination,'download');
      const bytes=makeEnvelope(['actual.png','actual@2x.png']);await body.promise;stream.enqueue(bytes);stream.close();await exporting;fixture.settle();assert.equal(calls.filter(c=>c.url.includes('/export-set')).length,1);assert.equal(clicks.length,0);const links=elements(fixture.tree).filter(e=>e.type==='a');assert.equal(links.length,3);assert.deepEqual(links.map(e=>e.props.download),['Frontend-exports.zip','actual.png','actual@2x.png']);assert.equal(urls.get(links[0].props.href).type,'application/zip');assert.equal(Buffer.from(await urls.get(links[0].props.href).arrayBuffer()).readUInt32LE(),0x04034b50);for(const [i,link]of links.slice(1).entries())assert.deepEqual(Buffer.from(await urls.get(link.props.href).arrayBuffer()),memberBytes(i));assert.ok(activate(links[0]));assert.equal(clicks.length,1);assert.equal(clicks[0].name,'Frontend-exports.zip');await ready(fixture);assert.ok(report.archiveFocusRestorations>0);
    }finally{fixture.close();}
  });
  await test('multi-file Save to server uses one coherent request and actual returned result URLs',async()=>{
    const doc=install(),fixture=new EffectFixture(ExportDialog,attach);try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});button(fixture,'Save to server exports').props.onClick();fixture.settle();intercept=async()=>new Response(JSON.stringify({resourceSnapshot:{revision:0,sha256:'a'.repeat(64)},files:[{name:'one.png',url:'/exports/one.png',bytes:20},{name:'two.png',url:'/exports/two.png',bytes:30}]}));await button(fixture,'Export to server').props.onClick();fixture.settle();assert.equal(calls.filter(c=>c.url.includes('/export-set')).length,1);assert.equal(clicks.length,0);assert.deepEqual(elements(fixture.tree).filter(e=>e.type==='a').map(e=>e.props.href),['/exports/one.png','/exports/two.png']);}finally{fixture.close();}
  });
  await test('PDF artboards become exactly one set member per scale; comps Download stays Download',async()=>{
    const d=createDocument({name:'Boards',width:128,height:64});d.layers=[makeArtboard({name:'A',width:64,height:64}),makeArtboard({name:'B',x:64,width:64,height:64})];d.comps=[captureComp(d,'First'),captureComp(d,'Second')];install(d);const fixture=new EffectFixture(ExportDialog,attach);
    try{await ready(fixture);field(fixture,'Format').props.onChange({target:{value:'pdf'}});field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();intercept=async()=>setResponse(makeEnvelope(['boards.pdf','boards@2x.pdf']));await button(fixture,'Export').props.onClick();fixture.settle();assert.equal(clicks.length,0);assert.deepEqual(elements(fixture.tree).filter(e=>e.type==='a').map(e=>e.props.download),['Boards-exports.zip','boards.pdf','boards@2x.pdf']);let q=JSON.parse(calls.find(c=>c.url.includes('/export-set')).init.body);assert.equal(q.artboards,true);assert.deepEqual(q.scales,[1,2]);
      await ready(fixture);field(fixture,'Export scope').props.onChange({target:{value:'comps'}});field(fixture,'Export at 2×').props.onChange({target:{checked:false}});fixture.settle();calls.length=0;intercept=async()=>setResponse(makeEnvelope(['first.pdf','second.pdf']));await button(fixture,'Export').props.onClick();q=JSON.parse(calls.find(c=>c.url.includes('/export-set')).init.body);assert.equal(q.comps,true);assert.equal(q.destination,'download');assert.equal(q.artboards,undefined);
    }finally{fixture.close();}
  });
  await test('corrupt, truncated, wrong-count, unsafe/duplicate names and mismatched captures expose no downloads',async()=>{
    for(const invalid of ['corrupt','truncate','count','duplicate','unsafe','revision','resource','hash']){install();const fixture=new EffectFixture(ExportDialog,attach);try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();let bytes=makeEnvelope(invalid==='count'?['one.png']:invalid==='duplicate'?['same.png','SAME.PNG']:invalid==='unsafe'?['one.png','../two.png']:['one.png','two.png'],invalid==='revision'?{...state.doc,rev:7}:state.doc,m=>invalid==='resource'?{...m,resourceSnapshot:{...m.resourceSnapshot,sha256:'b'.repeat(64)}}:invalid==='hash'?{...m,files:m.files.map(f=>({...f,sha256:undefined}))}:m);if(invalid==='truncate')bytes=bytes.subarray(0,bytes.length-1);if(invalid==='corrupt')bytes[bytes.length-1]^=1;intercept=async()=>setResponse(bytes);const before=clicks.length;await button(fixture,'Export').props.onClick();fixture.settle();assert.equal(clicks.length,before);assert.equal(elements(fixture.tree).filter(e=>e.type==='a').length,0);assert.equal(urls.size,0);}finally{fixture.close();}}
  });
  for(const action of ['unmount','switch','revision','cancel','options'])await test(`late set responses after ${action} do not download or update a new document`,async()=>{
    const d=install(),gate=deferred(),fixture=new EffectFixture(ExportDialog,attach);try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();intercept=()=>gate.promise;const pending=button(fixture,'Export').props.onClick();fixture.settle();if(action==='unmount')fixture.close();else if(action==='cancel')button(fixture,'Cancel export').props.onClick();else if(action==='options')field(fixture,'Format').props.onChange({target:{value:'pdf'}});else globalThis.__cacheStore.useStore.setState({doc:{...d,...(action==='switch'?{id:'switched'}:{rev:1})}});if(fixture.alive)fixture.settle();gate.resolve(setResponse(makeEnvelope(['one.png','two.png'],d)));await pending;if(fixture.alive)fixture.settle();assert.equal(clicks.length,0);assert.equal(fixture.setsAfterUnmount,0);assert.equal(urls.size,0);}finally{if(fixture.alive)fixture.close();}
  });
  await test('a one-member comp set retains its original filename/bytes and direct single download',async()=>{
    const d=install();d.comps=[captureComp(d,'Only')];const fixture=new EffectFixture(ExportDialog,attach);
    try{await ready(fixture);field(fixture,'Export scope').props.onChange({target:{value:'comps'}});fixture.settle();intercept=async()=>setResponse(makeEnvelope(['actual-comp.svg']));await button(fixture,'Export').props.onClick();fixture.settle();assert.equal(calls.filter(c=>c.url.includes('/export-set')).length,1);assert.equal(clicks.length,1);assert.equal(clicks[0].name,'actual-comp.svg');assert.deepEqual(Buffer.from(await urls.get(clicks[0].href).arrayBuffer()),memberBytes(0));assert.deepEqual(elements(fixture.tree).filter(e=>e.type==='a').map(e=>e.props.download),['actual-comp.svg']);}finally{fixture.close();}
  });
  for(const action of ['options','revision','resource','replacement'])await test(`prepared archive and member URLs retire on ${action}; stale links refuse activation`,async()=>{
    const d=install(),fixture=new EffectFixture(ExportDialog,attach);try{
      await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();intercept=async()=>setResponse(makeEnvelope(['one.png','two.png']));await button(fixture,'Export').props.onClick();fixture.settle();const oldLinks=elements(fixture.tree).filter(e=>e.type==='a'),oldUrls=oldLinks.map(e=>e.props.href);assert.equal(oldUrls.length,3);await ready(fixture);
      if(action==='options'){field(fixture,'Format').props.onChange({target:{value:'pdf'}});fixture.settle();}
      else if(action==='revision'){globalThis.__cacheStore.useStore.setState({doc:{...d,rev:1}});fixture.settle();}
      else if(action==='resource'){globalThis.__exportPreflight={...globalThis.__exportPreflight,resourceSnapshot:{sha256:'b'.repeat(64)}};window.dispatchEvent(new Event('focus'));await ready(fixture);}
      else {const gate=deferred();intercept=()=>gate.promise;const pending=button(fixture,'Export').props.onClick();fixture.settle();assert.ok(oldUrls.every(url=>!urls.has(url)));gate.resolve(new Response('failed',{status:500}));await pending;fixture.settle();}
      assert.ok(oldUrls.every(url=>!urls.has(url)));assert.equal(elements(fixture.tree).filter(e=>e.type==='a').length,0);assert.equal(activate(oldLinks[0]),false);assert.equal(clicks.length,0);
    }finally{fixture.close();}
  });
  for(const action of ['unmount','cancel','options','revision','resource'])await test(`archive preparation after ${action} cancels real JavaScript hashing and ignores a late task yield`,async()=>{
    const doc=install(),fixture=new EffectFixture(ExportDialog,attach),started=deferred(),set=globalThis.setTimeout,clear=globalThis.clearTimeout;let held;
    try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();
      intercept=async()=>setResponse(makeEnvelope(['one.png','two.png'],doc,m=>m,[Buffer.alloc(productionDownload.EXPORT_DOWNLOAD_LIMITS.crcChunkBytes*3,17),memberBytes(1)]));
      globalThis.setTimeout=(fn,ms,...args)=>{if(ms===0&&new Error().stack.includes('exportMemberSha256')){held={fn,args};started.resolve();return held;}return set(fn,ms,...args);};globalThis.clearTimeout=id=>{if(id!==held)clear(id);};
      const pending=button(fixture,'Export').props.onClick();fixture.settle();let timeout;try{await Promise.race([started.promise,new Promise((_,reject)=>{timeout=set(()=>reject(new Error('Real digest did not yield')),3000);})]);}finally{clear(timeout);}
      if(action==='unmount')fixture.close();else if(action==='cancel')button(fixture,'Cancel export').props.onClick();else if(action==='options')field(fixture,'Format').props.onChange({target:{value:'pdf'}});else if(action==='revision')globalThis.__cacheStore.useStore.setState({doc:{...doc,rev:1}});else{globalThis.__exportPreflight={...globalThis.__exportPreflight,resourceSnapshot:{sha256:'b'.repeat(64)}};window.dispatchEvent(new Event('focus'));}
      if(fixture.alive)fixture.settle();
      if(action==='resource'){await delay(350);fixture.settle();}
      await pending;held.fn(...held.args);await delay(0);if(fixture.alive)fixture.settle();
      assert.equal(clicks.length,0);assert.equal(urls.size,0);assert.equal(fixture.setsAfterUnmount,0);
    }finally{globalThis.setTimeout=set;globalThis.clearTimeout=clear;if(fixture.alive)fixture.close();}
  });
  await test('partial URL-allocation failure revokes the archive and every already created member link',async()=>{
    install();const fixture=new EffectFixture(ExportDialog,attach),create=URL.createObjectURL;let allocations=0;
    try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();intercept=async()=>setResponse(makeEnvelope(['one.png','two.png']));URL.createObjectURL=blob=>{if(++allocations===3)throw new Error('Owned URL allocation failure');return create(blob);};await button(fixture,'Export').props.onClick();fixture.settle();assert.equal(allocations,3);assert.equal(urls.size,0);assert.equal(clicks.length,0);assert.equal(elements(fixture.tree).filter(e=>e.type==='a').length,0);}finally{URL.createObjectURL=create;fixture.close();}
  });
  await test('replacement succeeds without an obsolete result link activating the successor; all anchors stay in the focus trap',async()=>{
    install();const fixture=new EffectFixture(ExportDialog,attach);try{
      await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();intercept=async()=>setResponse(makeEnvelope(['old.png','old@2x.png']));await button(fixture,'Export').props.onClick();fixture.settle();const old=elements(fixture.tree).filter(e=>e.type==='a');await ready(fixture);intercept=async()=>setResponse(makeEnvelope(['new.png','new@2x.png']));await button(fixture,'Export').props.onClick();fixture.settle();const links=elements(fixture.tree).filter(e=>e.type==='a');assert.equal(activate(old[0]),false);assert.equal(clicks.length,0);assert.ok(activate(links[0]));assert.ok(activate(links[2]));assert.deepEqual(clicks.map(c=>c.name),['Frontend-exports.zip','new@2x.png']);
      const modal=elements(fixture.tree).find(e=>e.props?.role==='dialog');let focused;
      const controls=elements(fixture.tree).filter(e=>['button','input','select','a'].includes(e.type)&&!e.props.disabled).map((e,i)=>({offsetParent:{},kind:e.type,focus(){focused=i;}}));assert.equal(controls.filter(e=>e.kind==='a').length,3);
      const key=(active,shift)=>{document.activeElement=active;let prevented=false;modal.props.onKeyDown({key:'Tab',shiftKey:shift,currentTarget:{querySelectorAll:selector=>{assert.ok(selector.includes('a[href]'));return controls;}},preventDefault(){prevented=true;}});return prevented;};assert.ok(key(controls.at(-1),false));assert.equal(focused,0);assert.ok(key(controls[0],true));assert.equal(focused,controls.length-1);
    }finally{fixture.close();}
  });
  await test('archive and individual links expire together at the explicit ten-minute lifetime',async()=>{
    install();const fixture=new EffectFixture(ExportDialog,attach),set=globalThis.setTimeout,clear=globalThis.clearTimeout,expiry=new Map();let n=0;
    try{await ready(fixture);field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();globalThis.setTimeout=(fn,ms,...args)=>{if(ms!==productionDownload.EXPORT_DOWNLOAD_LIMITS.lifetimeMs)return set(fn,ms,...args);const id={ownedExpiry:++n};expiry.set(id,fn);return id;};globalThis.clearTimeout=id=>{if(expiry.delete(id))return;clear(id);};intercept=async()=>setResponse(makeEnvelope(['one.png','two.png']));await button(fixture,'Export').props.onClick();fixture.settle();assert.equal(urls.size,3);assert.equal(expiry.size,1);for(const fn of expiry.values())fn();fixture.settle();assert.equal(urls.size,0);assert.equal(elements(fixture.tree).filter(e=>e.type==='a').length,0);}finally{fixture.close();globalThis.setTimeout=set;globalThis.clearTimeout=clear;}
  });
  await test('direct single-file Download remains the original GET workflow',async()=>{
    install();const fixture=new EffectFixture(ExportDialog,attach);try{await ready(fixture);intercept=async()=>new Response(Buffer.from('single-file'),{headers:{'content-disposition':'attachment; filename="single.png"'}});await button(fixture,'Export').props.onClick();assert.equal(calls.filter(c=>c.url.includes('/export-set')).length,0);assert.equal(calls.filter(c=>c.url.includes('/export?')).length,1);assert.equal(clicks[0].name,'single.png');}finally{fixture.close();}
  });
  await test('direct single-file formats retain MIME, disposition and scaled extension rules',async()=>{
    for(const format of ['png8','jpg','pdf','gif','mp4','pictocity']){
      calls.length=0;clicks.length=0;const doc=install(),fixture=new EffectFixture(ExportDialog,attach);
      try{await ready(fixture);field(fixture,'Format').props.onChange({target:{value:format}});fixture.settle();let mime=format==='pictocity'?'application/json':format==='mp4'?'video/mp4':format==='pdf'?'application/pdf':'image/'+(format==='png8'?'png':format);
        const bytes=Buffer.from('single '+format);intercept=async()=>new Response(bytes,{headers:{'content-type':mime,'content-length':String(bytes.length),'content-disposition':`attachment; filename="actual.${format==='png8'?'png':format}"`}});await button(fixture,'Export').props.onClick();fixture.settle();assert.equal(clicks.length,1);assert.equal(clicks[0].name,format==='pictocity'?doc.name+'.pictocity':`actual.${format==='png8'?'png':format}`);assert.equal(urls.get(clicks[0].href).type,mime);assert.deepEqual(Buffer.from(await urls.get(clicks[0].href).arrayBuffer()),bytes);
      }finally{fixture.close();}
    }
    calls.length=0;clicks.length=0;install();const fixture=new EffectFixture(ExportDialog,attach);try{await ready(fixture);field(fixture,'Export at 1×').props.onChange({target:{checked:false}});fixture.settle();field(fixture,'Export at 2×').props.onChange({target:{checked:true}});field(fixture,'Format').props.onChange({target:{value:'png8'}});fixture.settle();intercept=async()=>new Response('scaled',{headers:{'content-disposition':'attachment; filename="server.png"'}});await button(fixture,'Export').props.onClick();assert.equal(clicks[0].name,'Frontend@2x.png');}finally{fixture.close();}
  });
  await test('GIF and video scales remain one captured set with original options',async()=>{
    for(const format of ['gif','mp4','webm']){install();const fixture=new EffectFixture(ExportDialog,attach);try{await ready(fixture);field(fixture,'Format').props.onChange({target:{value:format}});field(fixture,'Export at 2×').props.onChange({target:{checked:true}});fixture.settle();intercept=async()=>setResponse(makeEnvelope([`one.${format}`,`two.${format}`]));await button(fixture,'Export').props.onClick();fixture.settle();const q=JSON.parse(calls.filter(c=>c.url.includes('/export-set')).at(-1).init.body);assert.equal(q.format,format);assert.deepEqual(q.scales,[1,2]);assert.equal(q.trim,false);if(format!=='gif'){assert.equal(q.artboards,undefined);assert.equal(q.fps,24);assert.equal(q.duration,5);assert.equal(q.transparent,false);}assert.equal(elements(fixture.tree).filter(e=>e.type==='a').length,3);assert.equal(clicks.length,0);}finally{fixture.close();}}
  });
  await test('video scope and transparency reset without dropping formats; keyboard focus remains trapped',async()=>{
    install();const fixture=new EffectFixture(ExportDialog,attach);try{await ready(fixture);const formats=field(fixture,'Format').props.children;assert.deepEqual(formats.map(e=>e.props.value),["png","png8","jpg","webp","avif","gif","tiff","bmp","pdf","svg","psd","html","pictocity","mp4","webm"]);field(fixture,'Format').props.onChange({target:{value:'webm'}});fixture.settle();assert.equal(field(fixture,'Export scope').props.value,'canvas');assert.equal(field(fixture,'Export scope').props.disabled,true);const modal=elements(fixture.tree).find(e=>e.props?.role==='dialog');const first={offsetParent:{},focus(){report.trapFirst=true;}},last={offsetParent:{},focus(){report.trapLast=true;}};document.activeElement=last;let prevented=false;modal.props.onKeyDown({key:'Tab',shiftKey:false,currentTarget:{querySelectorAll:()=>[first,last]},preventDefault(){prevented=true;}});assert.ok(prevented&&report.trapFirst);document.activeElement=first;modal.props.onKeyDown({key:'Tab',shiftKey:true,currentTarget:{querySelectorAll:()=>[first,last]},preventDefault(){}});assert.ok(report.trapLast);}finally{fixture.close();}
  });
  if(!process.env.PICTOCITY_FRONTEND_CASE)assert.ok(report.focusRestorations>0);
} catch(e){report.failure=String(e);throw e;}finally{URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;writeFileSync(join(root,'frontend-report.json'),JSON.stringify(report,null,2));}
console.log(report.cases.length+' source-effect frontend checks passed. Evidence: '+root);
