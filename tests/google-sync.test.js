import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {unaccent} from '@electric-sql/pglite/contrib/unaccent';
import {highlightMatch,filterDocuments,filterRequirements} from '../src/search.js';
import {HistoricalAccumulator} from '../src/historical.js';
import {makeImportBatches} from '../src/repository.js';

const owner='11111111-1111-4111-8111-111111111111',unknown='33333333-3333-4333-8333-333333333333';
test('Google sync adds only new invoices, preserves admin fields, is idempotent and respects pause',async()=>{
 const db=new PGlite({extensions:{pg_trgm,unaccent}});
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,storage to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;grant select,insert on storage.objects to authenticated;
    create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
    insert into auth.users values('${owner}','owner@example.test',now(),false),('${unknown}','unknown@example.test',now(),false);`);
  const migrations=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
  for(const f of migrations){try{await db.exec(await readFile(new URL(`../supabase/migrations/${f}`,import.meta.url),'utf8'));}catch(e){throw new Error(`${f}: ${e.message}`);}}
  await db.exec("insert into private.kardex_miembros(email,rol) values ('owner@example.test','admin');");

 await db.exec(await readFile(new URL('../db/google-sync.sql',import.meta.url),'utf8'));
 const payload=JSON.stringify([{year:2026,cargo:'653',date:'2026-01-06',codes:['F001-1','F001-1']}]);
 const run=async p=>(await db.query('select public.kardex_google_append($1) as result',[p])).rows[0].result;
 assert.equal((await run(payload)).cargos_nuevos,1);
 await db.exec("update public.documentos set obs='Manual',ubicacion='Iron Mountain',anio_origen=2027");
 assert.equal((await run(payload)).cargos_actualizados,0);
 const withGroups=JSON.stringify([{year:2026,cargo:'653',date:'2026-01-06',codes:['F001-1'],code_groups:{'F001-1':['2','17']}}]);
 assert.equal((await run(withGroups)).cargos_actualizados,1);
 assert.equal((await run(withGroups)).cargos_actualizados,0);
 const stored=(await db.query("select datos_origen->'grupos_por_codigo' as groups from public.documentos")).rows[0].groups;
 assert.deepEqual(stored,{'f0011':['2','17']});
 const second=JSON.stringify([{year:2026,cargo:'653',date:'2026-01-06',codes:['F0011','F001-2']}]);
 assert.equal((await run(second)).cargos_actualizados,1);
 const row=(await db.query('select * from public.documentos')).rows[0];
 assert.equal(row.obs,'Manual');assert.equal(row.ubicacion,'Iron Mountain');assert.equal(row.cantidad_facturas,2);
 await db.exec('update public.kardex_google_sync set enabled=false');await assert.rejects(run(payload),/pausada/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[unknown]);await db.exec('set role authenticated');
 assert.deepEqual((await db.query('select * from public.kardex_google_sync')).rows,[]);
 await assert.rejects(run(payload),/permission denied/);
 }finally{await db.close();}
});
