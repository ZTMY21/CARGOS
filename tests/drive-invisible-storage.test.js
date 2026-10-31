import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const root=new URL('../',import.meta.url);
const code=async name=>readFile(new URL('../'+name,import.meta.url),'utf8');

test('No new Drive modules or archive controls are exposed in Kardex',async()=>{
  const app=await code('index.html');
  const vite=await code('vite.config.js');
  assert.ok(!app.includes('btnOpenDriveArchive'));
  assert.ok(!app.includes('drive-archive.html'));
  assert.ok(!vite.includes('drive-archive.html'));
  await assert.rejects(readFile(new URL('../drive-archive.html',import.meta.url),'utf8'),{code:'ENOENT'});
});
test('Evidence image upload stores a verified Drive reference rather than inline JPEG',async()=>{
  const repository=await code('src/repository.js');
  assert.match(repository,/async saveDoc\(row, existing\)/);
  const method=repository.slice(repository.indexOf('async saveDoc('),repository.indexOf('async save('));
  assert.match(method,/category:'scans'/);
  assert.match(method,/job\.backendVerified!==true/);
  assert.match(method,/sustentoImagen:'drive-job:'/);
  assert.ok(method.indexOf("upload('finish'")<method.indexOf("return this.save('documentos'"));
  assert.match(repository,/fetchImage\(id\)/);
  assert.match(repository,/\/api\/drive-archive\?action=download&id=/);
  assert.match(repository,/new Blob\(\[payload\],\{type:'image\/jpeg'\}\)/);
});
test('Existing Drive evidence is kept on edit and never publicly linked',async()=>{
  const frontend=await code('src/app.js');
  assert.match(frontend,/d\.driveImageJob/);
  assert.match(frontend,/startsWith\('drive-job:'\)/);
  assert.ok(!frontend.includes('btnOpenDriveArchive'));
});
test('Drive imports do not store new original Excels in Supabase Storage',async()=>{
  const repository=await code('src/repository.js');
  const importSection=repository.slice(repository.indexOf('async importFile('),repository.indexOf('async reset()'));
  assert.match(importSection,/kardex_begin_drive_import/);
  assert.match(importSection,/backendVerified/);
  assert.ok(!importSection.includes("storage.from('respaldos-excel')"));
});
