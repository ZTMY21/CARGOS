import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {validateInput,sha256} from '../server/archive/security.js';
import {ArchiveService} from '../server/archive/service.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {MemoryArchiveStore,demoInput} from '../server/archive/demo.js';
test('original Excel belongs to an existing import without inventing a cargo',()=>{
 const original={...demoInput,documentId:null,importId:'4d4c0f31-1a42-46b1-8ee7-8cb8c3df024d',category:'originals',mime:'application/vnd.ms-excel.sheet.macroEnabled.12'};
 assert.equal(validateInput(original).mime,'application/vnd.ms-excel.sheet.macroenabled.12');
 assert.throws(()=>validateInput({...original,importId:undefined}));
 assert.notEqual(validateInput(original).key,validateInput({...original,importId:'1b4488d0-d6ae-443a-ac72-cad3681402df'}).key);
});
test('adopting an existing copy reads a revision and never uploads or replaces it',async()=>{
 const bytes=Buffer.from('authorized existing copy'),input={...demoInput,name:'existing.json',sha256:sha256(bytes),size:bytes.length};let mediaReads=0,requests=[],corrupt=false;
 const drive=new DriveClient({GOOGLE_DRIVE_ROOT_FOLDER_ID:'approved-root',GOOGLE_DRIVE_OWNER_EMAIL:'owner@example.test',GOOGLE_DRIVE_FOLDER_IDS_JSON:JSON.stringify({history:'approved-history'})},{fetcher:async(url,opts={})=>{
  requests.push([url,opts.method||'GET']);
  if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'test-only',expires_in:3600});
  if(url.includes('/revisions/revision-1')){mediaReads++;return new Response(corrupt?Buffer.from('corrupt'):bytes);}
  if(url.includes('/approved-root'))return Response.json({mimeType:'application/vnd.google-apps.folder',owners:[{emailAddress:'owner@example.test'}],capabilities:{canAddChildren:true},permissions:[{type:'user'}]});
  if(url.includes('/approved-history'))return Response.json({mimeType:'application/vnd.google-apps.folder',parents:['approved-root']});
  return Response.json({id:'existing-drive-file',name:input.name,mimeType:input.mime,size:String(bytes.length),parents:['approved-history'],headRevisionId:'revision-1'});
 }});
 const store=new MemoryArchiveStore(),service=new ArchiveService(store,drive,randomBytes(32).toString('base64'));
 const first=await service.adopt(input,'existing-drive-file');assert.equal(first.status,'verified');assert.equal(first.adopted,true);
 const again=await service.adopt(input,'existing-drive-file');assert.equal(first.id,again.id);assert.equal(store.rows.size,1);
 await assert.rejects(service.adopt(input,'different-drive-file'),{code:'DRIVE_REFERENCE_CONFLICT'});
 assert.equal((await store.get(first.id)).status,'verified');assert.equal(mediaReads,2);
 assert.ok(requests.filter(([u])=>u.includes('www.googleapis.com')).every(([u,m])=>m==='GET'&&!u.includes('upload/')));
 corrupt=true;await assert.rejects(service.adopt({...input,sourceVersion:'2'},'existing-drive-file'),{code:'CHECKSUM_MISMATCH'});assert.notEqual([...store.rows.values()].at(-1).status,'verified');
});
