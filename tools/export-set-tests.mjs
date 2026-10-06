import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, utimesSync, unlinkSync, openSync, closeSync, truncateSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDocument, makeImage, makeArtboard, captureComp, makeShape } from '../packages/core/dist/index.js';
import { planExportSet, EXPORT_SET_LIMITS } from '../packages/server/dist/export-set.js';
import { productionDownload, productionHelperPath } from './export-download-production.mjs';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tools/export-set-evidence', stamp), data = join(root, 'data'), temp = join(root, 'temp'), assets = join(data, 'assets');
for (const folder of [assets, temp]) mkdirSync(folder, { recursive: true });
const control = join(root, 'fault.json'), delay = ms => new Promise(r => setTimeout(r, ms)), hash = b => createHash('sha256').update(b).digest('hex');
// Date restoration is exact only when the owned fixture begins on a whole ms.
// Keep the strict timestamp assertions; do not round away a failed preservation.
const fixtureTime = new Date('2026-10-03T00:00:00.000Z');
const normalizeTime = path => utimesSync(path, fixtureTime, fixtureTime);
const report = { schema: 'pictocity-export-set-tests/v1', root, transport: 'actual HTTP and unchanged production child renderer', cases: [], serverClosed: false, portReleased: false,
  sourceHashes: Object.fromEntries(['packages/server/src/index.ts','packages/server/src/export-set.ts','packages/server/src/resource-snapshot.ts','packages/editor/src/components/Dialogs.tsx',productionHelperPath,'packaging/pictocity_app.py'].map(p => [p,hash(readFileSync(p))])) };
const saveReport = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report,null,2));
let failures = 0, cannotRun = 0, rendererAvailable = false;
const test = async (name, action, needsRenderer = false) => {
  if (needsRenderer && !rendererAvailable) { cannotRun++; report.cases.push({ name, status: 'cannot-run', reason: report.rendererFailure }); saveReport(); console.log('cannot-run ' + name); return; }
  try { await action(); report.cases.push({ name, status: 'pass' }); console.log('ok ' + name); }
  catch (e) { failures++; report.cases.push({ name, status: 'fail', error: String(e), stack: e.stack }); console.log('FAIL ' + name + ': ' + e.message); }
  saveReport();
};
const png = color => { const c=createCanvas(8,8),ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,8,8);return c.toBuffer('image/png'); };
const r = png('red'), b = png('blue'), size = Math.max(r.length,b.length), red = Buffer.concat([r,Buffer.alloc(size-r.length)]), blue = Buffer.concat([b,Buffer.alloc(size-b.length)]);
const imageFile = join(assets, 'photo.png'); writeFileSync(imageFile,red);
const picture = (name='Export set fixture', boards=false) => {
  const d=createDocument({name,width:128,height:64,background:null});
  d.assets.image={id:'image',name:'Fixture image',src:'/assets/photo.png',mime:'image/png',width:8,height:8};
  if(boards) d.layers=[makeArtboard({id:'A',name:'A',x:0,y:0,width:64,height:64,children:[makeImage({assetId:'image',width:64,height:64})]}),makeArtboard({id:'B',name:'B',x:64,y:0,width:64,height:32,children:[makeImage({assetId:'image',x:64,width:64,height:32})]})];
  else d.layers=[makeImage({assetId:'image',width:128,height:64})];
  return d;
};
const decoded = async bytes => { const img=await loadImage(bytes),c=createCanvas(img.width,img.height);c.getContext('2d').drawImage(img,0,0);return { width:img.width,height:img.height,pixel:[...c.getContext('2d').getImageData(0,0,1,1).data] }; };
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
const logFd=openSync(join(root,'server.log'),'w');
// File descriptors avoid a launcher pipe dependency; the production renderer still uses its real IPC.
const server=spawn(process.execPath,['--import',pathToFileURL(resolve('tools/export-set-faults.mjs')).href,resolve('packages/server/dist/index.js')],{windowsHide:true,stdio:['ignore',logFd,logFd],env:{...process.env,PICTOCITY_PORT:String(port),PICTOCITY_DATA:data,PICTOCITY_FONTS:join(data,'fonts'),PICTOCITY_TOKEN:'',TEMP:temp,TMP:temp,PICTOCITY_EXPORT_TEST_CONTROL:control}});
closeSync(logFd);report.serverPid=server.pid;report.port=port;
const base=`http://127.0.0.1:${port}`;
const request=async(path,body,signal)=>{
  const response=await fetch(base+path,{...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal});
  const bytes=Buffer.from(await productionDownload.readExportResponse(response,productionDownload.EXPORT_DOWNLOAD_LIMITS.envelopeBytes,signal));let result;try{result=JSON.parse(bytes.toString());}catch{}
  return {status:response.status,body:result,bytes,headers:Object.fromEntries(response.headers)};
};
const waitFor=async(fn,ms=20_000)=>{const end=Date.now()+ms;while(!await fn()){if(server.exitCode!==null)throw new Error(readFileSync(join(root,'server.log'),'utf8'));assert.ok(Date.now()<end,'Condition timed out');await delay(15);}};
const faults=cfg=>{for(const suffix of ['.checkpoint','.release'])if(existsSync(control+suffix))unlinkSync(control+suffix);writeFileSync(control,JSON.stringify(cfg));};
const release=()=>writeFileSync(control+'.release','release');
const checkpoint=()=>waitFor(()=>existsSync(control+'.checkpoint'));
const create=async d=>{const out=await request('/api/docs',{document:d});assert.equal(out.status,201,JSON.stringify(out.body));return out.body;};
const checked=async d=>{const p=await request(`/api/docs/${d.id}/preflight`);assert.equal(p.status,200,JSON.stringify(p.body));assert.equal(p.body.ok,true);return {expectedRev:p.body.revision,expectedResources:p.body.resourceSnapshot.sha256};};
const clean=async()=>{const h=(await request('/api/health')).body;assert.equal(h.renderer.resources.snapshots,0);assert.equal(h.renderer.resources.bytes,0);assert.equal(h.exportSets.live.length,0);assert.equal(h.exportSets.bytes,0);assert.equal(readdirSync(temp).filter(n=>n.startsWith('pictocity-export-set-')||n.startsWith('pictocity-resources-')).length,0);};
const previous=(doc,options)=>{
  const dir=join(root,'outputs',String(report.cases.length));mkdirSync(dir,{recursive:true});
  const plan=planExportSet(doc,{...options,dir},join(data,'exports'));
  for(const [i,m]of plan.members.entries()){const target=join(dir,m.name);writeFileSync(target,'previous member '+i);normalizeTime(target);}
  return {dir,paths:plan.members.map(m=>join(dir,m.name)),hashes:plan.members.map(m=>hash(readFileSync(join(dir,m.name))))};
};
const preserved=p=>assert.deepEqual(p.paths.map(path=>hash(readFileSync(path))),p.hashes);
const exportSet=(d,q,signal)=>request(`/api/docs/${d.id}/export-set`,q,signal);
const envelope=out=>{
  assert.equal(out.status,200,JSON.stringify(out.body));assert.equal(out.headers['content-type'],'application/vnd.pictocity.export-set');
  const length=out.bytes.readUInt32BE(),manifest=JSON.parse(out.bytes.subarray(4,4+length));let offset=4+length;
  const files=manifest.files.map(f=>{const bytes=out.bytes.subarray(offset,offset+f.bytes);offset+=f.bytes;assert.equal(hash(bytes),f.sha256);return {...f,bytes};});
  assert.equal(offset,out.bytes.length);return {manifest,files};
};
try {
  await waitFor(async()=>{try{return(await request('/api/health')).body.ok;}catch{return false;}});
  report.health=(await request('/api/health')).body;
  assert.equal(report.health.app,'Pictocity');assert.equal(report.health.version,JSON.parse(readFileSync(resolve('package.json'),'utf8')).version);assert.equal(report.health.paths.data,data);
  const doc=await create(picture());
  await test('HTTP set requires both reviewed revision and resource hash',async()=>{assert.equal((await exportSet(doc,{format:'png'})).status,400);await clean();});
  await test('HTTP validates revision/hash types and refuses stale revision before resource capture',async()=>{
    for(const expectedRev of [null,-1,0.2])assert.equal((await exportSet(doc,{format:'png',expectedRev,expectedResources:'0'.repeat(64)})).status,400);
    assert.equal((await exportSet(doc,{format:'png',expectedRev:1,expectedResources:'0'.repeat(64)})).status,409);await clean();
  });
  const guard={expectedRev:0,expectedResources:'0'.repeat(64)};
  await test('HTTP unknown formats, invalid scales, duplicate scales and options refuse upfront',async()=>{
    for(const q of [{format:'exe'},{scales:[]},{scales:[1,1]},{scales:[1,-2]},{quality:101},{colors:1},{dpi:0},{transparent:'maybe'},{scales:[1,2],path:join(root,'bad.png')},{destination:'elsewhere'}])assert.equal((await exportSet(doc,{...guard,...q})).status,400,JSON.stringify(q));await clean();
  });
  await test('HTTP missing and empty artboards/comps refuse upfront',async()=>{for(const q of [{artboard:'absent'},{comp:'absent'},{artboards:true},{comps:true}])assert.equal((await exportSet(doc,{...guard,...q})).status,404);await clean();});
  await test('HTTP does not advertise opaque video transparency or artboard video',async()=>{const d=await create(picture('Video boards',true));for(const q of [{transparent:true},{artboards:true}])assert.equal((await exportSet(d,{...guard,format:'mp4',...q})).status,400);await clean();});
  await test('upfront case-insensitive and sanitized-name collisions, filename/path limits and file/page count',async()=>{
    const d=picture('Collision',true);d.layers[0].name='A B';d.layers[1].name='A?B';assert.throws(()=>planExportSet(d,{artboards:true},data),/collide/);
    d.layers[0].name='Case';d.layers[1].name='case';assert.throws(()=>planExportSet(d,{artboards:true},data),/collide/);
    assert.throws(()=>planExportSet(doc,{scales:Array.from({length:65},(_,i)=>i+1)},data),/64/);
    assert.throws(()=>planExportSet(doc,{path:join(root,'CON.png')},data),/filename/);
    assert.throws(()=>planExportSet(doc,{path:join(root,'out.png'),dir:root},data),/path or dir/);
    d.layers=Array.from({length:65},(_,i)=>makeArtboard({name:String(i),width:1,height:1}));assert.throws(()=>planExportSet(d,{format:'pdf',artboards:true},data),/64-page/);
    d.comps=[captureComp(d,'Duplicate'),captureComp(d,'duplicate')];assert.throws(()=>planExportSet(d,{comps:true},data),/collide/);
  });
  await test('HTTP destination case collision, non-file destination and foreign directory lock preserve originals',async()=>{
    const p=previous(doc,{scales:[1,2]});const name=p.paths[0].split(/[\\/]/).pop();const other=join(p.dir,name.toUpperCase());
    // Rename rather than creating a case-only sibling works on default Windows directories.
    const {renameSync}=await import('node:fs');renameSync(p.paths[0],other);
    assert.equal((await exportSet(doc,{...guard,scales:[1,2],dir:p.dir})).status,409);assert.equal(hash(readFileSync(other)),p.hashes[0]);
    const folder=join(root,'non-file.png');mkdirSync(folder);assert.equal((await request(`/api/docs/${doc.id}/export`,{path:folder})).status,400);
    const lock=join(p.dir,'.pictocity-export-set.lock');mkdirSync(lock);writeFileSync(join(lock,'owner.json'),'foreign');
    assert.equal((await exportSet(doc,{...guard,scales:[1,2],dir:p.dir})).status,409);assert.equal(readFileSync(join(lock,'owner.json'),'utf8'),'foreign');
  });
  await test('HTTP previous-file backup quota refuses without resource capture and releases set quota',async()=>{
    const file=join(root,'sparse-old.bmp');writeFileSync(file,'old');truncateSync(file,EXPORT_SET_LIMITS.perSetBytes+1);
    assert.equal((await request(`/api/docs/${doc.id}/export`,{path:file})).status,413);assert.equal(statSync(file).size,EXPORT_SET_LIMITS.perSetBytes+1);await clean();
  });
  await test('production child renderer actually renders HTTP PNG',async()=>{
    const result=await request(`/api/docs/${doc.id}/export`,{format:'png',path:join(root,'renderer-gate.png')});
    if(result.status!==200){report.rendererFailure=JSON.stringify(result.body);await clean();report.rendererFailureCleanupVerified=true;throw new Error(report.rendererFailure);}
    assert.deepEqual((await decoded(readFileSync(result.body.path))).pixel,[255,0,0,255]);rendererAvailable=true;await clean();
  });
  await test('whole set captures once at one revision despite equal-size/equal-timestamp image and document edits between members',async()=>{
    faults({pauseStage:0});writeFileSync(imageFile,red);normalizeTime(imageFile);const d=await create(picture('One revision')),g=await checked(d),p=previous(d,{scales:[1,2]});
    const exporting=exportSet(d,{...g,scales:[1,2],dir:p.dir});await checkpoint();preserved(p);
    const state=(await request('/api/render-status')).body;assert.equal(state.resources.snapshots,1);assert.equal(state.active,null);assert.equal(state.exportSets.live[0].completed,0);
    const before=statSync(imageFile),beforeNs=statSync(imageFile,{bigint:true});writeFileSync(imageFile,blue);utimesSync(imageFile,before.atime,before.mtime);assert.equal(statSync(imageFile).size,before.size);assert.equal(statSync(imageFile).mtimeMs,before.mtimeMs);assert.equal(statSync(imageFile,{bigint:true}).mtimeNs,beforeNs.mtimeNs);
    await request(`/api/docs/${d.id}/ops`,{expectedRev:0,ops:[{type:'layer.set',id:d.layers[0].id,props:{x:999}}]});release();
    const out=await exporting;assert.equal(out.status,200,JSON.stringify(out.body));assert.equal(out.body.resourceSnapshot.revision,0);assert.equal(out.body.resourceSnapshot.documentSha256,hash(Buffer.from(JSON.stringify(d))));assert.equal(out.body.resourceSnapshot.sha256,g.expectedResources);
    for(const [i,f]of out.body.files.entries()){const px=await decoded(readFileSync(f.path));assert.deepEqual([px.width,px.height],[128*(i+1),64*(i+1)]);assert.deepEqual(px.pixel,[255,0,0,255]);}await clean();
  },true);
  await test('Download captures the whole 1x/2x set once, exposes actual names, bytes, pixels and dimensions, publishes no files',async()=>{
    faults({});writeFileSync(imageFile,red);const d=await create(picture('Download')),g=await checked(d),out=envelope(await exportSet(d,{...g,scales:[1,2],destination:'download'}));
    assert.equal(out.files.length,2);assert.equal(out.manifest.resourceSnapshot.sha256,g.expectedResources);
    for(const [i,f]of out.files.entries()){assert.ok(f.name.endsWith(i?'@2x.png':'.png'));assert.deepEqual(await decoded(f.bytes),{width:128*(i+1),height:64*(i+1),pixel:[255,0,0,255]});}
    assert.equal(readdirSync(join(data,'exports')).filter(n=>n.startsWith('Download')).length,0);await clean();
  },true);
  await test('actual Download envelope: two boards x two scales capture once, survive original replacement and independently extract one ZIP',async()=>{
    faults({pauseStage:0});writeFileSync(imageFile,red);normalizeTime(imageFile);const d=await create(picture('Portable ZIP',true)),g=await checked(d);
    const exporting=exportSet(d,{...g,artboards:true,scales:[1,2],destination:'download'});await checkpoint();
    const state=(await request('/api/render-status')).body;assert.equal(state.resources.snapshots,1);assert.equal(state.active,null);assert.equal(state.exportSets.live[0].completed,0);
    const before=statSync(imageFile),beforeNs=statSync(imageFile,{bigint:true});writeFileSync(imageFile,blue);utimesSync(imageFile,before.atime,before.mtime);assert.equal(statSync(imageFile).size,before.size);assert.equal(statSync(imageFile).mtimeMs,before.mtimeMs);assert.equal(statSync(imageFile,{bigint:true}).mtimeNs,beforeNs.mtimeNs);
    await request(`/api/docs/${d.id}/ops`,{expectedRev:0,ops:[{type:'layer.set',id:'A',props:{x:999}}]});release();
    const response=await exporting,out=envelope(response);assert.equal(out.manifest.resourceSnapshot.revision,0);assert.equal(out.manifest.resourceSnapshot.sha256,g.expectedResources);assert.equal(out.files.length,4);
    const names=planExportSet(d,{artboards:true,scales:[1,2],destination:'download'},join(data,'exports')).members.map(m=>m.name);assert.deepEqual(out.files.map(f=>f.name),names);
    for(const [i,f]of out.files.entries()){const px=await decoded(f.bytes),scale=i<2?1:2;assert.deepEqual([px.width,px.height],[64*scale,(i%2?32:64)*scale]);assert.deepEqual(px.pixel,[255,0,0,255]);}
    const dataBuffer=response.bytes.buffer.slice(response.bytes.byteOffset,response.bytes.byteOffset+response.bytes.length);
    const prepared=await productionDownload.prepareExportSetDownload(dataBuffer,{revision:0,resources:g.expectedResources,files:4,documentName:d.name});assert.equal(prepared.archived,true);assert.equal(prepared.save.name,'Portable ZIP-exports.zip');
    const archive=join(root,'captured-boards-scales.zip'),expected=join(root,'captured-boards-scales-expected.json');writeFileSync(archive,Buffer.from(await prepared.save.blob.arrayBuffer()));
    const files=out.files.map((f,i)=>{const path=join(root,`captured-member-${i}.png`);writeFileSync(path,f.bytes);return{name:f.name,path};});writeFileSync(expected,JSON.stringify({archive,files}));
    const log=join(root,'zipfile-extraction.log'),fd=openSync(log,'w');try{execFileSync(process.env.PICTOCITY_TEST_PYTHON??(process.platform === 'win32' ? 'python' : 'python3'),[resolve('tools/export-download-verify.py'),expected],{windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,TEMP:temp,TMP:temp}});}finally{closeSync(fd);}
    report.portableZip=JSON.parse(readFileSync(log,'utf8'));
    for(const [i,file]of prepared.members.entries())assert.deepEqual(Buffer.from(await file.blob.arrayBuffer()),out.files[i].bytes);
    assert.equal(readdirSync(join(data,'exports')).filter(n=>n.startsWith('Portable_ZIP')).length,0);await clean();
  },true);
  await test('artboard and comp scale cross product stages every member coherently',async()=>{
    faults({});writeFileSync(imageFile,red);const d=picture('Cross product',true);d.comps=[captureComp(d,'First'),captureComp(d,'Second')];const created=await create(d),g=await checked(created),out=await exportSet(created,{...g,artboards:true,comps:true,scales:[1,2]});assert.equal(out.status,200,JSON.stringify(out.body));assert.equal(out.body.files.length,8);
    for(const f of out.body.files){const px=await decoded(readFileSync(f.path));assert.equal(px.width,f.width);assert.equal(px.height,f.height);assert.deepEqual(px.pixel,[255,0,0,255]);}await clean();
  },true);
  await test('PDF makes one page per artboard and exactly one PDF per scale (no redundant target repetition)',async()=>{
    faults({});writeFileSync(imageFile,red);const d=await create(picture('PDF set',true)),g=await checked(d),out=await exportSet(d,{...g,format:'pdf',artboards:true,scales:[1,2]});assert.equal(out.status,200,JSON.stringify(out.body));assert.equal(out.body.files.length,2);
    for(const f of out.body.files){assert.equal(f.pages,2);assert.equal((readFileSync(f.path).toString('latin1').match(/\/Type \/Page\s/g)||[]).length,2);}await clean();
  },true);
  await test('later real render failure preserves both previous outputs and clears resources/staging',async()=>{
    faults({pauseStage:0});writeFileSync(imageFile,red);const d=await create(picture('Render failure')),g=await checked(d),p=previous(d,{scales:[1,2]}),exporting=exportSet(d,{...g,scales:[1,2],dir:p.dir});await checkpoint();
    const snapshot=readdirSync(temp).find(n=>n.startsWith('pictocity-resources-'));assert.ok(snapshot);writeFileSync(join(temp,snapshot,'assets/photo.png'),'corrupt captured resource');preserved(p);release();
    const out=await exporting;assert.equal(out.status,422,JSON.stringify(out.body));preserved(p);await clean();
  },true);
  await test('later stage failure preserves both previous outputs and clears all quotas',async()=>{
    faults({failStage:1});writeFileSync(imageFile,red);const d=await create(picture('Stage failure')),g=await checked(d),p=previous(d,{scales:[1,2]}),out=await exportSet(d,{...g,scales:[1,2],dir:p.dir});assert.equal(out.status,500);assert.match(out.body.error,/stage/);preserved(p);await clean();
  },true);
  await test('precommit same-size/timestamp destination mutation refuses all publication',async()=>{
    faults({pauseStage:0});writeFileSync(imageFile,red);const d=await create(picture('Precommit')),g=await checked(d),p=previous(d,{scales:[1,2]}),exporting=exportSet(d,{...g,scales:[1,2],dir:p.dir});await checkpoint();const before=statSync(p.paths[1]),beforeNs=statSync(p.paths[1],{bigint:true});writeFileSync(p.paths[1],'external member 1');utimesSync(p.paths[1],before.atime,before.mtime);assert.equal(statSync(p.paths[1]).size,before.size);assert.equal(statSync(p.paths[1],{bigint:true}).mtimeNs,beforeNs.mtimeNs);const changed=hash(readFileSync(p.paths[1]));release();const out=await exporting;assert.equal(out.status,409);assert.equal(hash(readFileSync(p.paths[0])),p.hashes[0]);assert.equal(hash(readFileSync(p.paths[1])),changed);await clean();
  },true);
  await test('publication error rolls back replaced members and removes private transaction',async()=>{
    faults({failPublish:1});writeFileSync(imageFile,red);const d=await create(picture('Rollback')),g=await checked(d),p=previous(d,{scales:[1,2]}),out=await exportSet(d,{...g,scales:[1,2],dir:p.dir});assert.equal(out.status,500);assert.equal(out.body.report.rollback.complete,true);preserved(p);assert.equal(existsSync(join(p.dir,'.pictocity-export-set.lock')),false);await clean();
  },true);
  await test('rollback removes newly created members as well as restoring replacements',async()=>{
    faults({failPublish:1});writeFileSync(imageFile,red);const d=await create(picture('New rollback')),g=await checked(d),p=previous(d,{scales:[1,2]});unlinkSync(p.paths[0]);const out=await exportSet(d,{...g,scales:[1,2],dir:p.dir});assert.equal(out.status,500);assert.equal(existsSync(p.paths[0]),false);assert.equal(hash(readFileSync(p.paths[1])),p.hashes[1]);await clean();
  },true);
  for(const phase of ['pauseStage','pausePublish'])await test(`HTTP abort/disconnect during ${phase} preserves both previous outputs`,async()=>{
    faults({[phase]:0});writeFileSync(imageFile,red);const d=await create(picture('Disconnect '+phase)),g=await checked(d),p=previous(d,{scales:[1,2]}),controller=new AbortController(),outcome=exportSet(d,{...g,scales:[1,2],dir:p.dir},controller.signal).catch(e=>e);await checkpoint();controller.abort();await outcome;await delay(75);release();await waitFor(async()=>!(await request('/api/health')).body.exportSets.live.length);preserved(p);await clean();
  },true);
  await test('legacy artboard and layer-comp POST APIs use rollback transaction and compatible file results',async()=>{
    writeFileSync(imageFile,red);for(const kind of ['artboards','comps']){const d=picture('Legacy '+kind,true);d.comps=[captureComp(d,'First'),captureComp(d,'Second')];const created=await create(d),p=previous(created,{[kind]:true});faults({failPublish:1});const failed=await request(`/api/docs/${created.id}/export`,{[kind]:true,format:'png',dir:p.dir});assert.equal(failed.status,500);preserved(p);faults({});const out=await request(`/api/docs/${created.id}/export`,{[kind]:true,format:'png',dir:p.dir});assert.equal(out.status,200);assert.equal(out.body.files.length,2);assert.ok(out.body.files.every(f=>f.path&&f.name&&f.bytes));}await clean();
  },true);
  await test('all supported raster, vector, layered, HTML and animated formats remain actual exports',async()=>{
    faults({});writeFileSync(imageFile,red);const d=await create(picture('Formats',true)),g=await checked(d);
    for(const format of ['png','png8','jpg','jpeg','webp','avif','tif','tiff','bmp','pdf','svg','psd','html','gif']){const out=await exportSet(d,{...g,format,artboards:true});assert.equal(out.status,200,format+': '+JSON.stringify(out.body));assert.equal(out.body.files.length,format==='pdf'?1:2);for(const f of out.body.files)assert.ok(statSync(f.path).size>0);if(format==='psd')for(const f of out.body.files)assert.equal(readFileSync(f.path).subarray(0,4).toString(),'8BPS');}
    await clean();
  },true);
  await test('video 1x/2x shares captured audio and preserves decoded dimensions/frames/pixels',async()=>{
    faults({pauseStage:0});writeFileSync(imageFile,red);const audio=join(root,'audio.wav'),replacement=join(root,'audio-blue.wav');const ffmpeg=process.env.PICTOCITY_FFMPEG,ffprobe=process.env.PICTOCITY_FFPROBE;assert.ok(ffmpeg&&ffprobe);
    for(const [frequency,path]of [[440,audio],[880,replacement]])execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000:duration=1`,path],{windowsHide:true});
    const audioHash=hash(readFileSync(audio)),d=await create(picture('Video set')),g=await checked(d),exporting=exportSet(d,{...g,format:'mp4',scales:[1,2],audio,duration:.25,fps:24});await checkpoint();writeFileSync(audio,readFileSync(replacement));writeFileSync(imageFile,blue);release();const out=await exporting;assert.equal(out.status,200,JSON.stringify(out.body));assert.equal(out.body.resourceSnapshot.audio.sha256,audioHash);
    for(const [i,f]of out.body.files.entries()){const info=JSON.parse(execFileSync(ffprobe,['-v','error','-count_frames','-show_streams','-of','json',f.path],{windowsHide:true}));const v=info.streams.find(s=>s.codec_type==='video');assert.equal(v.nb_read_frames,'6');assert.deepEqual([v.width,v.height],[128*(i+1),64*(i+1)]);const px=execFileSync(ffmpeg,['-v','error','-i',f.path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true});assert.ok(px[0]>220&&px[2]<20);const pcm=execFileSync(ffmpeg,['-v','error','-i',f.path,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1'],{windowsHide:true});let crossings=0;for(let n=1001;n<9000;n++)if(pcm.readFloatLE((n-1)*4)<=0&&pcm.readFloatLE(n*4)>0)crossings++;assert.ok(Math.abs(crossings*48000/8000-440)<12);}
    faults({});const webm=await exportSet(d,{...(await checked(d)),format:'webm',scales:[1,2],duration:.1,fps:10});assert.equal(webm.status,200);await clean();
  },true);
  await test('actual encoded staged-byte quota fails complete Download and cleans every staged file',async()=>{
    faults({});const d=await create(createDocument({name:'Bounded bytes',width:4096,height:4096,background:'#ff0000'})),g=await checked(d),out=await exportSet(d,{...g,format:'bmp',scales:[1,1.01],destination:'download'});assert.equal(out.status,413,JSON.stringify(out.body));assert.match(out.body.error,/128 MiB/);await clean();
  },true);
  await test('resource cleanup failure refuses precommit, preserves old set and identifies retained resource directory',async()=>{
    faults({});writeFileSync(imageFile,red);const d=await create(picture('Resource cleanup')),g=await checked(d);faults({failResourceCleanup:true});
    // Enable only after preflight retired its own snapshot.
    const p=previous(d,{scales:[1,2]}),out=await exportSet(d,{...g,scales:[1,2],dir:p.dir});assert.equal(out.status,500);preserved(p);assert.ok(out.body.report.resourceRecoveryPath);assert.ok(existsSync(out.body.report.resourceRecoveryPath));const h=(await request('/api/health')).body;assert.equal(h.renderer.resources.snapshots,1);faults({});
  },true);
  await test('cleanup failure reports committed state and recovery paths instead of success, retaining quota',async()=>{
    faults({});writeFileSync(imageFile,red);const d=await create(picture('Cleanup retained')),g=await checked(d),p=previous(d,{scales:[1,2]});faults({failCleanup:true});const out=await exportSet(d,{...g,scales:[1,2],dir:p.dir});assert.equal(out.status,500);assert.equal(out.body.report.committed,true);assert.ok(out.body.report.recoveryPaths.every(existsSync));assert.ok((await request('/api/health')).body.exportSets.bytes>0);report.cleanupRecovery=out.body.report;faults({});
  },true);
  await test('incomplete rollback retains old backup and exact recovery paths, blocks cooperative writers',async()=>{
    faults({});writeFileSync(imageFile,red);const d=await create(picture('Rollback retained')),g=await checked(d),p=previous(d,{scales:[1,2]});faults({failPublish:1,failRollback:0});const out=await exportSet(d,{...g,scales:[1,2],dir:p.dir});assert.equal(out.status,500);assert.equal(out.body.report.rollback.complete,false);assert.equal(out.body.report.committed,false);assert.ok(out.body.report.recoveryPaths.every(existsSync));assert.equal(hash(readFileSync(join(out.body.report.directory,'backup','0'))),p.hashes[0]);assert.equal(hash(readFileSync(p.paths[1])),p.hashes[1]);report.rollbackRecovery=out.body.report;faults({});assert.equal((await exportSet(d,{...g,scales:[1,2],dir:p.dir})).status,429);const h=(await request('/api/health')).body;assert.equal(h.exportSets.live.length,2);assert.ok(h.exportSets.bytes>0);
  },true);
  report.counts={pass:report.cases.filter(c=>c.status==='pass').length,fail:failures,cannotRun};
} finally {
  release();faults({}); // Never leave an owned checkpoint waiting on failure.
  if(server.exitCode===null){const ended=once(server,'exit');server.kill();await ended;}report.serverClosed=server.exitCode!==null||server.signalCode!==null;
  const listening=()=>new Promise(r=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();r(true);});socket.once('error',e=>{socket.destroy();r(e.code!=='ECONNREFUSED');});socket.setTimeout(1000,()=>{socket.destroy();r(true);});});
  await waitFor(async()=>!await listening()).catch(e=>{report.shutdownFailure=String(e);failures++;});report.portReleased=!await listening();saveReport();
}
console.log(JSON.stringify(report.counts)+'. Evidence: '+relative(resolve('.'),root));
if(failures||cannotRun||!report.portReleased)process.exitCode=1;
