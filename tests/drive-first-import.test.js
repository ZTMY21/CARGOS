import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateInput} from '../server/archive/security.js';

const digest='a'.repeat(64);
const owner='11111111-2222-4333-8444-555555555555';
const original={
  documentId:null,
  sourceKey:'excel-import:'+owner+':'+digest,
  sourceVersion:'sha256:'+digest,
  name:'Kardex_2026.xlsx',
  mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size:7,
  sha256:digest,
  category:'originals'
};
test('Drive-first Excel originals have a strict user/sha scoped identity',()=>{
  const safe=validateInput(original);
  assert.equal(safe.documentId,null);
  assert.equal(safe.category,'originals');
  assert.match(safe.key,/^[a-f0-9]{64}$/);
  assert.throws(()=>validateInput({...original,sourceKey:'not-an-excel-import'}),{code:'INVALID_DOCUMENT'});
  assert.throws(()=>validateInput({...original,sourceKey:'excel-import:'+owner+':'+('b'.repeat(64))}),{code:'INVALID_EXCEL_IMPORT'});
  assert.throws(()=>validateInput({...original,mime:'application/pdf'}),{code:'INVALID_EXCEL_IMPORT'});
  assert.throws(()=>validateInput({...original,name:'not-excel.pdf'}),{code:'INVALID_EXCEL_IMPORT'});
});
test('the source importer waits for Drive readback before creating database rows',async()=>{
  const code=await readFile(new URL('../src/repository.js',import.meta.url),'utf8');
  const importSection=code.slice(code.indexOf('async importFile('),code.indexOf('async reset()'));
  assert.ok(importSection.includes("archive('finish'"));
  assert.ok(importSection.includes('job.backendVerified!==true'));
  assert.ok(importSection.indexOf("archive('finish'")<importSection.indexOf("rpc('kardex_begin_drive_import'"));
  assert.ok(!importSection.includes("storage.from('respaldos-excel')"));
});
test('Drive import SQL only accepts owner-scoped backend-verified originals',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20261031202000_drive_first_excel_import.sql',import.meta.url),'utf8');
  assert.match(sql,/j\.data->>'backendVerified'='true'/);
  assert.match(sql,/j\.data->>'sha256'=archivo_sha256/);
  assert.match(sql,/auth\.uid\(\)::text/);
  assert.match(sql,/REVOKE ALL ON FUNCTION.*FROM PUBLIC, anon/);
});
