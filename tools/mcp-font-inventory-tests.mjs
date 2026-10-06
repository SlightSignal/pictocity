import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const inventories=[['Arial','Japanese 日本語'],[{family:'Poppins',files:['Renamed.ttf'],faces:[{file:'Renamed.ttf',weight:700,style:'italic',stretch:'normal',sha256:'1'.repeat(64),source:'sfnt',diagnostics:[]}]},'Arial'],[]];
let fonts,reads=0;
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/api/health')return res.end(JSON.stringify({app:'Pictocity',ok:true}));assert.equal(req.url,'/api/fonts');reads++;res.end(JSON.stringify(fonts));});
server.listen(0,'127.0.0.1');await once(server,'listening');
const client=new Client({name:'font-inventory-regression',version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args:[process.env.PICTOCITY_MCP_ENTRY??'packages/mcp/dist/index.js'],env:{...process.env,PICTOCITY_URL:'http://127.0.0.1:'+server.address().port},stderr:'pipe'});
try{
 await client.connect(transport);
 for(const [i,inventory] of inventories.entries()){
  fonts=inventory;const result=await client.callTool({name:'list_fonts',arguments:{}});assert.ok(!result.isError);
  assert.deepEqual(JSON.parse(result.content[0].text),inventory,'Actual MCP must preserve names and hosted face metadata');console.log('ok font inventory '+i);
 }
 assert.equal(reads,3);
}finally{await client.close();server.close();await once(server,'close');}
console.log('3 MCP font inventory checks passed; client and fixture server closed');
