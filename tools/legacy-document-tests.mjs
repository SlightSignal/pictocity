import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDocument,makeShape,makeText} from '../packages/core/dist/index.js';
import {DocStore} from '../packages/server/dist/store.js';

const root=mkdtempSync(join(tmpdir(),'pictocity-legacy-documents-'));
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
const seed=(name,createdAt)=>{
  const dir=join(root,name);mkdirSync(dir);
  const doc=createDocument({id:name,name});doc.layers=[makeShape({id:'shape'})];
  if(createdAt==='omitted')delete doc.createdAt;else doc.createdAt=createdAt;
  const file=join(dir,name+'.json'),bytes=JSON.stringify(doc);writeFileSync(file,bytes);
  return {dir,doc,file,bytes};
};
await test('Legacy version-1 import with omitted creation date remains editable without inventing metadata',()=>{
  const fixture=seed('legacy-omitted','omitted'),store=new DocStore(fixture.dir);
  assert.equal(store.persistence().ok,true);assert.deepEqual(store.get(fixture.doc.id),fixture.doc);
  assert.equal(readFileSync(fixture.file,'utf8'),fixture.bytes);
  assert.equal(Object.hasOwn(store.get(fixture.doc.id),'createdAt'),false);
  store.apply({docId:fixture.doc.id,actor:'test',expectedRev:0,ops:[{type:'layer.set',id:'shape',props:{x:42}}]});
  store.flush();
  const reopened=new DocStore(fixture.dir);assert.equal(reopened.persistence().ok,true);
  assert.equal(reopened.get(fixture.doc.id).rev,1);assert.equal(reopened.get(fixture.doc.id).layers[0].x,42);
  assert.equal(Object.hasOwn(reopened.get(fixture.doc.id),'createdAt'),false);
});
for(const [name,value] of [['null',null],['invalid-string','not-a-date'],['numeric',123],['object',{}]]){
  await test('Present invalid creation date '+name+' still refuses without changing bytes',()=>{
    const fixture=seed('legacy-invalid-'+name,value),store=new DocStore(fixture.dir);
    assert.equal(store.persistence().ok,false);assert.equal(readFileSync(fixture.file,'utf8'),fixture.bytes);
    assert.throws(()=>store.create({name:'Must refuse'}));
  });
}
await test('Legacy omitted wrap retains its existing renderer semantics through edit and reopen',()=>{
  const fixture=seed('legacy-wrap','omitted'),text=makeText({id:'legacy-text',text:'A longer text string',width:20});delete text.wrap;
  fixture.doc.layers=[text];writeFileSync(fixture.file,JSON.stringify(fixture.doc));const before=readFileSync(fixture.file,'utf8');
  const store=new DocStore(fixture.dir);assert.equal(store.persistence().ok,true);assert.deepEqual(store.get(fixture.doc.id),fixture.doc);
  assert.equal(readFileSync(fixture.file,'utf8'),before);assert.equal(Object.hasOwn(store.get(fixture.doc.id).layers[0],'wrap'),false);
  store.apply({docId:fixture.doc.id,actor:'test',expectedRev:0,ops:[{type:'layer.set',id:'legacy-text',props:{x:42}}]});store.flush();
  const reopened=new DocStore(fixture.dir);assert.equal(reopened.persistence().ok,true);assert.equal(reopened.get(fixture.doc.id).layers[0].x,42);
  assert.equal(Object.hasOwn(reopened.get(fixture.doc.id).layers[0],'wrap'),false);
});
for(const [name,value] of [['null',null],['string','false'],['numeric',0]])await test('Present invalid wrap '+name+' still refuses without changing bytes',()=>{
  const fixture=seed('legacy-wrap-invalid-'+name,'omitted');fixture.doc.layers=[makeText({id:'legacy-text',text:'Text'})];fixture.doc.layers[0].wrap=value;
  const before=JSON.stringify(fixture.doc);writeFileSync(fixture.file,before);const store=new DocStore(fixture.dir);
  assert.equal(store.persistence().ok,false);assert.equal(readFileSync(fixture.file,'utf8'),before);assert.throws(()=>store.create({name:'Must refuse'}));
});
await test('Legacy omitted asset descriptions remain absent; mandatory identity and geometry are retained',()=>{
  const fixture=seed('legacy-asset','omitted');fixture.doc.assets.photo={id:'photo',src:'assets/photo.png',width:8,height:8};
  const before=JSON.stringify(fixture.doc);writeFileSync(fixture.file,before);const store=new DocStore(fixture.dir);
  assert.equal(store.persistence().ok,true);assert.deepEqual(store.get(fixture.doc.id),fixture.doc);assert.equal(readFileSync(fixture.file,'utf8'),before);
  store.apply({docId:fixture.doc.id,actor:'test',expectedRev:0,ops:[{type:'layer.set',id:'shape',props:{x:42}}]});store.flush();
  const reopened=new DocStore(fixture.dir);assert.equal(reopened.persistence().ok,true);assert.equal(Object.hasOwn(reopened.get(fixture.doc.id).assets.photo,'mime'),false);
  assert.equal(Object.hasOwn(reopened.get(fixture.doc.id).assets.photo,'name'),false);
  assert.throws(()=>reopened.apply({docId:fixture.doc.id,actor:'test',expectedRev:1,ops:[{type:'asset.add',asset:{id:'new',src:'/assets/new.png',width:8,height:8}}]}));
});
for(const field of ['name','mime'])await test('Present invalid legacy asset '+field+' still refuses',()=>{
  const fixture=seed('legacy-asset-invalid-'+field,'omitted');fixture.doc.assets.photo={id:'photo',src:'assets/photo.png',width:8,height:8,[field]:null};
  const before=JSON.stringify(fixture.doc);writeFileSync(fixture.file,before);const store=new DocStore(fixture.dir);
  assert.equal(store.persistence().ok,false);assert.equal(readFileSync(fixture.file,'utf8'),before);
});
console.log(JSON.stringify({passed,failed:0,root}));
