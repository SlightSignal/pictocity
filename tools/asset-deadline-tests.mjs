import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer, get } from 'node:http';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';
import { createDocument } from '@pictocity/core';

const root=resolve('tools/asset-deadline-evidence',new Date().toISOString().replace(/[:.]/g,'-'));
for(const dir of [root,join(root,'data/assets'),join(root,'temp')])fs.mkdirSync(dir,{recursive:true});
const canvas=createCanvas(8,8);canvas.getContext('2d').fillStyle='red';canvas.getContext('2d').fillRect(0,0,8,8);const bytes=canvas.toBuffer('image/png');
const hash=b=>createHash('sha256').update(b).digest('hex'),blocked=join(root,'data/assets/slow.png');
fs.writeFileSync(blocked,bytes);fs.writeFileSync(join(root,'data/assets/photo.png'),bytes);
const report={scope:'actual HTTP route with controlled slow filesystem streams; unchanged production renderer subprocesses',root,cases:[],serverClosed:false,
 serverSha256:hash(fs.readFileSync(resolve('packages/server/dist/index.js'))),controlledStreams:0,abortedStreams:0};
const cjs=createRequire(import.meta.url)('node:fs'), realRead=cjs.createReadStream;
cjs.createReadStream=(file,options)=>{
 if(resolve(file)!==blocked)return realRead(file,options);
 report.controlledStreams++;const stream=new PassThrough();const abort=()=>{report.abortedStreams++;stream.destroy(Object.assign(new Error('Controlled slow read aborted'),{name:'AbortError'}));};
 options?.signal?.addEventListener('abort',abort,{once:true});stream.once('close',()=>options?.signal?.removeEventListener('abort',abort));if(options?.signal?.aborted)abort();return stream;
};syncBuiltinESMExports();
const entry=pathToFileURL(resolve('packages/server/dist/index.js')).href;
registerHooks({load(url,context,next){if(url===entry)return {format:'module',shortCircuit:true,source:fs.readFileSync(fileURLToPath(url),'utf8').replace('const server = createServer','export const server = createServer')+'\nexport {store,renderer};\n'};return next(url,context);}});
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
Object.assign(process.env,{PICTOCITY_PORT:String(port),PICTOCITY_DATA:join(root,'data'),PICTOCITY_FONTS:join(root,'data/fonts'),PICTOCITY_TOKEN:'',TEMP:join(root,'temp'),TMP:join(root,'temp')});
const production=await import(entry);await once(production.server,'listening');const base=`http://127.0.0.1:${port}`;
const delay=ms=>new Promise(r=>setTimeout(r,ms)), requests=[];
const doc=createDocument({name:'Slow file response fixture',width:8,height:8,background:null});doc.assets.slow={id:'slow',name:'Slow file',src:'/assets/slow.png',width:8,height:8,mime:'image/png'};doc.assets.photo={id:'photo',name:'Photo',src:'/assets/photo.png',width:8,height:8,mime:'image/png'};
const response=await fetch(base+'/api/docs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({document:doc})});assert.equal(response.status,201);const created=await response.json();
const content=id=>`/api/docs/${created.id}/asset-content?assetId=${id}&sha256=${hash(bytes)}&expectedRev=0`;
const startSlow=()=>{const req=get(base+content('slow'),res=>{req.resultStatus=res.statusCode;res.resume();});req.on('error',()=>{});requests.push(req);return req;};
const status=async()=>{const r=await fetch(base+content('photo'));await r.arrayBuffer();return r.status;};
try {
 startSlow();startSlow();for(let i=0;report.controlledStreams<2;i++){assert.ok(i<100);await delay(10);}
 assert.equal(await status(),429);report.cases.push('two slow reads retain both admission slots');console.log('ok '+report.cases.at(-1));
 requests[0].destroy();let admitted;for(let i=0;i<100;i++){admitted=await status();if(admitted===200)break;await delay(10);}assert.equal(admitted,200);assert.equal(report.abortedStreams,1);report.cases.push('client disconnect aborts the slow stream and releases one slot');console.log('ok '+report.cases.at(-1));
 startSlow();for(let i=0;report.controlledStreams<3;i++){assert.ok(i<100);await delay(10);}assert.equal(await status(),429);
 console.log('waiting for the production 30-second deadline');const start=Date.now();await delay(31_000);
 assert.equal(await status(),200,'The server must abort and retire stalled reads by its deadline');assert.equal(report.abortedStreams,3);
 assert.equal(requests[1].resultStatus,408);assert.equal(requests[2].resultStatus,408);
 report.deadlineElapsedMs=Date.now()-start;report.cases.push('deadline aborts both held streams, returns 408, and admits a new request');console.log('ok '+report.cases.at(-1));
}catch(error){report.failure=String(error);throw error;}
finally {
 for(const req of requests)req.destroy();await delay(50);production.store.flush();await production.renderer.close();await new Promise(r=>production.server.close(r));
 report.serverClosed=!production.server.listening;cjs.createReadStream=realRead;syncBuiltinESMExports();fs.writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log('Evidence: '+root);
}
