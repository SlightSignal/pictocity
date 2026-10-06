// Runs compatibility suites with the production renderer and MCP transports.
// The snapshot API queue fixture uses a separate blocker destination because
// export sets reserve their publication directory; its output assertions remain.
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, createConnection } from 'node:net';
const root=resolve('tools/export-set-evidence',new Date().toISOString().replace(/[:.]/g,'-')+'-regressions');
const temp=join(root,'temp'),data=join(root,'data');for(const d of [temp,data])mkdirSync(d,{recursive:true});
const report={root,scope:'candidate compatibility suites; separate snapshot blocker destination; production transports, no renderer substitution',suites:[]},env={...process.env,TEMP:temp,TMP:temp,PICTOCITY_FFMPEG:process.env.PICTOCITY_FFMPEG??'ffmpeg',PICTOCITY_FFPROBE:process.env.PICTOCITY_FFPROBE??'ffprobe'};
const save=()=>writeFileSync(join(root,'regressions.json'),JSON.stringify(report,null,2));
async function run(suite,extra={}){
  const log=join(root,suite+'.log'),fd=openSync(log,'w');let child;
  try{child=spawn(process.execPath,[resolve('tools/'+suite+'.mjs')],{windowsHide:true,stdio:['ignore',fd,fd],env:{...env,...extra}});}finally{closeSync(fd);}
  const timer=setTimeout(()=>child.kill(),180_000);let code,signal;
  try{[code,signal]=await once(child,'exit');}finally{clearTimeout(timer);}
  const output=readFileSync(log,'utf8'),entry={suite,exitCode:code,signal,passedCaseLines:output.split(/\r?\n/).filter(s=>/^ok\s/.test(s)).length,status:code===0?'pass':'failed-or-cannot-run',log,tail:output.slice(-3000)};report.suites.push(entry);save();console.log(suite+': '+entry.status+'; exit '+code+'; '+entry.passedCaseLines+' ok lines');
}
await Promise.all([run('core-tests'),run('snapshot-tests'),run('cache-consistency-tests'),run('snapshot-api-tests',{PICTOCITY_TEST_DATA:join(root,'snapshot-api-data'),PICTOCITY_TEST_REPORT:join(root,'snapshot-api.json')})]);
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
const fd=openSync(join(root,'api-server.log'),'w'),server=spawn(process.execPath,[resolve('packages/server/dist/index.js')],{windowsHide:true,stdio:['ignore',fd,fd],env:{...env,PICTOCITY_PORT:String(port),PICTOCITY_DATA:data,PICTOCITY_FONTS:join(data,'fonts'),PICTOCITY_TOKEN:''}});closeSync(fd);
const base=`http://127.0.0.1:${port}`;report.serverPid=server.pid;report.port=port;
try{
  for(let i=0;;i++){if(server.exitCode!==null)throw new Error(readFileSync(join(root,'api-server.log'),'utf8'));try{if((await(await fetch(base+'/api/health')).json()).ok)break;}catch{}if(i>100)throw new Error('Compatibility server readiness timed out');await new Promise(r=>setTimeout(r,20));}
  await run('api-tests',{PICTOCITY_URL:base});await run('mcp-tests',{PICTOCITY_URL:base,PICTOCITY_MCP_ENTRY:resolve('packages/mcp/dist/index.js')});
  await run('export-set-mcp-tests',{PICTOCITY_URL:base,PICTOCITY_TEST_OWNED_ROOT:data,PICTOCITY_MCP_ENTRY:resolve('packages/mcp/dist/index.js'),PICTOCITY_MCP_SET_REPORT:join(root,'export-set-mcp.json')});
}finally{
  if(server.exitCode===null){const ended=once(server,'exit');server.kill();await ended;}report.serverClosed=true;
  report.portReleased=await new Promise(r=>{const s=createConnection({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();r(false);});s.once('error',e=>{s.destroy();r(e.code==='ECONNREFUSED');});s.setTimeout(1000,()=>{s.destroy();r(false);});});save();
}
console.log('Evidence: '+root);if(report.suites.some(s=>s.status!=='pass')||!report.portReleased)process.exitCode=1;
