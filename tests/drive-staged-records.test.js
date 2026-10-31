import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
test('private image read checks access to the original Kardex document',async()=>{
 const api=await readFile(new URL('../api/drive-archive.js',import.meta.url),'utf8');
 assert.match(api,/if\(isStagedEvidenceJob\)/);
 assert.match(api,/if\(read\)await actor\.document\(job\.sourceKey\.slice/);
 assert.match(api,/actor\.backup\(\)/);
});
