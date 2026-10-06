import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,symlinkSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {createDocument,makeShape} from '../packages/core/dist/index.js';
const source=resolve('.'),root=mkdtempSync(join(process.env.PICTOCITY_OWNERSHIP_TEST_ROOT??process.env.TEMP??process.env.TMP??'/tmp','pictocity-ownership-tests-'));
const children=[],pause=ms=>new Promise(r=>setTimeout(r,ms));let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
const freePort=async()=>{const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port;};
const seed=name=>{const data=join(root,name);mkdirSync(join(data,'docs'),{recursive:true});const doc=createDocument({id:name,name});doc.layers=[makeShape({id:'shape',x:0,y:0})];writeFileSync(join(data,'docs',doc.id+'.json'),JSON.stringify(doc));return {data,doc};};
const files=dir=>{const result={};const walk=(folder,rel='')=>{for(const name of readdirSync(folder)){const file=join(folder,name),path=rel+name;if(statSync(file).isDirectory())walk(file,path+'/');else result[path]=createHash('sha256').update(readFileSync(file)).digest('hex');}};walk(dir);return result;};
const launch=async(data,extra={})=>{
 const port=await freePort(),child=spawn(process.execPath,['packages/server/dist/index.js'],{cwd:source,env:{...process.env,PICTOCITY_DATA:data,PICTOCITY_FONTS:join(data,'fonts'),PICTOCITY_PORT:String(port),PICTOCITY_TOKEN:'',...extra},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const instance={child,port,base:'http://127.0.0.1:'+port,log:'',exited:once(child,'exit')};children.push(instance);child.stdout.on('data',b=>instance.log+=b);child.stderr.on('data',b=>instance.log+=b);return instance;
};
const ready=async instance=>{for(let i=0;i<200;i++){if(instance.child.exitCode!==null)throw new Error(instance.log);try{const r=await fetch(instance.base+'/api/health');if(r.status===200)return r.json();}catch{}await pause(25);}throw new Error('Readiness '+instance.log);};
const stop=async instance=>{if(instance.child.exitCode===null){instance.child.kill();await instance.exited;}for(let i=0;i<50;i++){try{await fetch(instance.base+'/api/health');}catch{return;}await pause(20);}throw new Error('Owned port remains');};
const refused=async instance=>{const result=await Promise.race([instance.exited,pause(5000).then(()=>null)]);assert.ok(result,'Duplicate process did not retire');assert.equal(instance.child.exitCode,73,instance.log);assert.match(instance.log,/Another Pictocity instance is using this library/);await assert.rejects(fetch(instance.base+'/api/health'));};
let owner,fixture;
try{
 await test('First process owns the library before exposing health',async()=>{fixture=seed('shared');owner=await launch(fixture.data);const health=await ready(owner);assert.deepEqual(health.dataOwnership,{acquired:true,scope:'same-host',mode:process.platform==='win32'?'windows-named-pipe':process.platform==='linux'?'linux-abstract-socket':'unix-path-socket',documentsOwned:true});});
 await test('Same library on another port refuses before changing any existing bytes',async()=>{const before=files(fixture.data);await refused(await launch(fixture.data));assert.deepEqual(files(fixture.data),before);});
 await test('Dot path aliases cannot bypass directory ownership',async()=>{await refused(await launch(join(fixture.data,'.')));});
 await test('Filesystem junction or symlink aliases cannot bypass directory ownership',async()=>{const alias=join(root,'alias');symlinkSync(fixture.data,alias,process.platform==='win32'?'junction':'dir');await refused(await launch(alias));});
 if(process.platform==='win32')await test('Windows case aliases cannot bypass ownership',async()=>{await refused(await launch(fixture.data.toUpperCase()));});
 await test('A shared physical docs directory cannot bypass ownership with a different data parent',async()=>{const other=join(root,'shared-docs-parent');mkdirSync(other);symlinkSync(join(fixture.data,'docs'),join(other,'docs'),process.platform==='win32'?'junction':'dir');const before=files(fixture.data);await refused(await launch(other));assert.deepEqual(files(fixture.data),before);assert.ok(!readdirSync(other).includes('fonts'));});
 await test('An unrelated library can start concurrently',async()=>{const other=seed('other'),instance=await launch(other.data);await ready(instance);assert.equal((await fetch(owner.base+'/api/health')).status,200);await stop(instance);});
 await test('A refused second server cannot seed a supplied new font file',async()=>{const bundle=join(root,'new-bundle');mkdirSync(bundle);writeFileSync(join(bundle,'MustNotCopy.ttf'),'not a valid font');await refused(await launch(fixture.data,{PICTOCITY_BUNDLED_FONTS:bundle}));assert.ok(!readdirSync(join(fixture.data,'fonts')).includes('MustNotCopy.ttf'));});
 await test('The admitted owner still edits with one sequential acknowledged journal revision',async()=>{const r=await fetch(owner.base+'/api/docs/'+fixture.doc.id+'/ops',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRev:0,ops:[{type:'layer.set',id:'shape',props:{x:17}}]})});assert.equal(r.status,200);assert.equal((await r.json()).rev,1);assert.deepEqual(readFileSync(join(fixture.data,'docs',fixture.doc.id+'.history.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line).rev),[1]);});
 await test('Force-stopping the owner retires its port',async()=>{await stop(owner);});
 if(process.platform==='win32'||process.platform==='linux')await test('OS-released ownership reopens acknowledged edits after force stop without stale-file deletion',async()=>{owner=await launch(fixture.data);await ready(owner);const doc=await(await fetch(owner.base+'/api/docs/'+fixture.doc.id)).json();assert.equal(doc.rev,1);assert.equal(doc.layers[0].x,17);assert.ok(!readdirSync(fixture.data).some(name=>name.includes('owner')));});
 await test('Simultaneous startup admits exactly one owner',async()=>{const simultaneous=seed('simultaneous');const pair=await Promise.all([launch(simultaneous.data),launch(simultaneous.data)]);const results=await Promise.all(pair.map(async instance=>{try{await ready(instance);return 'ready';}catch{await refused(instance);return 'refused';}}));assert.deepEqual(results.sort(),['ready','refused']);await Promise.all(pair.map(stop));});
 // A live rename may make the first process's configured pathname unavailable.
 // Ownership itself must still reject a new spelling of that same directory.
 await test('Renaming the owned directory does not create a second filesystem owner',async()=>{const renamed=join(root,'renamed-shared');renameSync(fixture.data,renamed);await refused(await launch(renamed));renameSync(renamed,fixture.data);assert.equal((await fetch(owner.base+'/api/health')).status,200);});
}finally{await Promise.all(children.map(stop));}
console.log(JSON.stringify({passed,ownedChildrenAndPortsRetired:true,root,scope:'Actual cooperating server processes on this host; not cross-machine writers, old versions or external edits'}));
