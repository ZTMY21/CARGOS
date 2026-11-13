import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {validateInput} from '../server/archive/security.js';
const id='6b39b917-5938-4324-8e69-043f73e72d8e',sha='c'.repeat(64);
test('staged private evidence can be uploaded before document exists but is strictly scoped',()=>{
 const valid=validateInput({documentId:null,sourceKey:'sustento:'+id,sourceVersion:'sha256:'+sha,
 name:'sustento_'+id+'.jpg',mime:'image/jpeg',size:128,sha256:sha,category:'scans'});
 assert.equal(valid.documentId,null);
 assert.throws(()=>validateInput({...valid,name:'other.jpg'}),{code:'INVALID_EVIDENCE'});
 assert.throws(()=>validateInput({...valid,mime:'application/pdf'}),{code:'INVALID_EVIDENCE'});
 assert.throws(()=>validateInput({...valid,sourceKey:'other:'+id}),{code:'INVALID_DOCUMENT'});
});
test('SQL permits only scoped backend records and retains the FK for attached documents',async()=>{
 const sql=await readFile(new URL('../supabase/migrations/20261031204200_drive_first_global_and_staged_evidence.sql',import.meta.url),'utf8');
 assert.match(sql,/excel-import/);
 assert.match(sql,/sustento:/);
 assert.match(sql,/ADD CONSTRAINT kardex_drive_jobs_check CHECK/);
});
test('the archive database accepts pickup PDFs and rejects unrelated standalone files',async()=>{
 const db=new PGlite();
 const migration=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
 const visit='42c04d47-5120-4523-878a-37cf2ff7fc55';
 const actor='0f3d2d3c-5e3b-47fb-b4d2-5f302cb0107f';
 const pickup=validateInput({documentId:null,sourceKey:`pickup:${id}:${visit}:${actor}`,
  sourceVersion:'sha256:'+sha,name:`IM_RECOJO_2026-11-13_AV-${id.slice(0,8)}_${visit}.pdf`,
  mime:'application/pdf',size:128,sha256:sha,category:'scans'});
 const insert=data=>db.query('insert into public.kardex_drive_jobs(data) values ($1::jsonb)',[JSON.stringify(data)]);
 const rejected={code:'23514',constraint:'kardex_drive_jobs_check'};
 try{
  await db.exec('create table public.kardex_drive_jobs(document_id uuid, import_id uuid, data jsonb not null, constraint kardex_drive_jobs_check check (true))');
  await db.exec(await migration('20261031204200_drive_first_global_and_staged_evidence.sql'));
  await insert({category:'scans',sourceKey:'sustento:'+id,mime:'image/jpeg'});
  await assert.rejects(insert(pickup),rejected);
  await db.exec(await migration('20261113170611_allow_pickup_pdf_archive_jobs.sql'));
  await insert(pickup);
  await assert.rejects(insert({...pickup,mime:'image/jpeg'}),rejected);
  await assert.rejects(insert({...pickup,mime:undefined}),rejected);
  await assert.rejects(insert({...pickup,sourceKey:`pickup:${id}:${visit}`}),rejected);
  await assert.rejects(insert({...pickup,category:'originals'}),rejected);
  await insert({category:'originals',sourceKey:`excel-import:${id}:${sha}`});
 }finally{await db.close();}
});
test('private image read checks access to the original Kardex document',async()=>{
 const api=await readFile(new URL('../api/drive-archive.js',import.meta.url),'utf8');
 assert.match(api,/if\(isStagedEvidenceJob\)/);
 assert.match(api,/if\(read\)await actor\.document\(job\.sourceKey\.slice/);
 assert.match(api,/actor\.backup\(\)/);
});
