import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDocument, makeFill } from '@pictocity/core';

const mode='pattern';
const root=resolve('tools/asset-boundary-evidence',new Date().toISOString().replace(/[:.]/g,'-'));
for(const dir of [root,join(root,'data/assets'),join(root,'temp')]) mkdirSync(dir,{recursive:true});
const probe=createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); const port=probe.address().port; await new Promise(r=>probe.close(r));
const child=spawn(process.execPath,[resolve('packages/server/dist/index.js')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PICTOCITY_PORT:String(port),PICTOCITY_DATA:join(root,'data'),PICTOCITY_FONTS:join(root,'data/fonts'),PICTOCITY_TOKEN:'',TEMP:join(root,'temp'),TMP:join(root,'temp')}});
let log=''; for(const stream of [child.stdout,child.stderr]) stream.on('data',b=>log+=b);
const base=`http://127.0.0.1:${port}`, hash=b=>createHash('sha256').update(b).digest('hex'), delay=ms=>new Promise(r=>setTimeout(r,ms));
const report={scope:'actual isolated HTTP server and production renderer subprocesses',mode,cases:[],serverClosed:false,root,
 serverSha256:hash(readFileSync(resolve('packages/server/dist/index.js'))),assetsSha256:hash(readFileSync(resolve('packages/server/dist/assets.js')))};
const json=async(path,body)=>{const r=await fetch(base+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,body:r.headers.get('content-type')?.includes('application/json')?await r.json():(await r.arrayBuffer(),null)};};
const png=color=>{const c=createCanvas(8,8);c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,8,8);return c.toBuffer('image/png');};
const photo=join(root,'data/assets/photo.png'), red=png('red'),blue=png('blue');writeFileSync(photo,red);
const make=()=>{const d=createDocument({name:'Pattern boundary fixture',width:8,height:8,background:null});d.assets.image={id:'image',name:'Pattern image',src:'/assets/photo.png',width:8,height:8,mime:'image/png'};d.layers=[makeFill({name:'Pattern fill',width:8,height:8,fill:{kind:'pattern',assetId:'image',scale:1}})];return d;};
const paused=[];
try {
  for(let i=0;;i++){if(child.exitCode!==null)throw new Error(log);try{if((await json('/api/health')).body.ok)break;}catch{}assert.ok(i<80,'Server readiness');await delay(50);}
  const created=await json('/api/docs',{document:make()});assert.equal(created.status,201,JSON.stringify(created));const doc=(await json('/api/docs/'+created.body.id)).body;
  const content=(id,digest)=>`/api/docs/${doc.id}/asset-content?assetId=${id}&sha256=${digest}&expectedRev=${doc.rev}`;
  {
    let checked=(await json(`/api/docs/${doc.id}/preflight`)).body;
    assert.equal(checked.ok,true,JSON.stringify(checked));assert.equal(checked.assets.find(a=>a.id==='image')?.sha256,hash(red),'Pattern-fill asset must enter preflight and immutable input capture');
    const exportPixels=async(expected)=>{const r=await fetch(base+`/api/docs/${doc.id}/export?format=png&expectedRev=${doc.rev}&expectedResources=${checked.resourceSnapshot.sha256}`);assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());const image=await loadImage(bytes);const c=createCanvas(8,8);c.getContext('2d').drawImage(image,0,0);assert.deepEqual([...c.getContext('2d').getImageData(4,4,1,1).data],expected);};
    await exportPixels([255,0,0,255]);writeFileSync(photo,blue);checked=(await json(`/api/docs/${doc.id}/preflight`)).body;assert.equal(checked.assets[0].sha256,hash(blue));await exportPixels([0,0,255,255]);
    unlinkSync(photo);assert.equal((await json(`/api/docs/${doc.id}/preflight`)).body.ok,false);writeFileSync(photo,red);
    assert.equal((await json('/api/health')).body.renderer.resources.snapshots,0);report.cases.push('pattern fill enters capture, renders red/blue, and missing source refuses preflight');console.log('ok '+report.cases.at(-1));
  }
} catch(error) {report.failure=String(error);throw error;}
finally {
  for(const req of paused)req.destroy();
  if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}report.serverClosed=child.exitCode!==null||child.signalCode!==null;
  writeFileSync(join(root,'server.log'),log);writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log('Evidence: '+root);
}
