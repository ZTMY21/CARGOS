import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {randomBytes,createHash} from 'node:crypto';
const oldCargos='18TbKWiVUWKfkJOXvR0kGEMb5eVKTDCfoXAUtD5rCxts',newCargos='14GzTxs9-hk3_vPTI7AYLc3jiqLAaAC5q7y910wo8Jh0';
const oldIM='1aWqIoj5UXAeyKhNN1paoYnTa4jdfN8LhDEcdH_lQ4mk',newIM='1VWmKFmE8UcXV6ukG8k-wqKqCzuJbPGYOf9RFowojhSw';
test('source transition preserves canonical identities, enrollment stays inactive and active credentials cannot be replaced',async()=>{
 const db=new PGlite();try{
  await db.exec("create schema private;create role anon;create role authenticated;create role service_role;create table private.kardex_live_sheet_config(sheet_id text primary key,token_sha256 text not null,active boolean not null,created_at timestamptz default now());create table private.im_envios_live_config(sheet_id text primary key,token_sha256 text not null,active boolean not null);create table public.kardex_google_sync(id boolean primary key,enabled boolean,file_id text);create table public.documentos(id uuid,kardex text,fecha_registro date,tipo_doc text,periodo date,ubicacion text,folios int,cargos text[],caja_asignada uuid,f_envio date,sustento text,sustento_imagen text,usuario text,facturas text,obs text,created_at timestamptz,updated_at timestamptz,clave_origen text,hoja_origen text,fecha_origen date,anio_origen int,estado_origen text,datos_origen jsonb,importacion_id uuid,busqueda_facturas text,busqueda_meta text,cantidad_facturas int);");
  await db.exec('create table public.kardex_live_ingresos(sheet_id text,row_number integer,anio integer,cargo text,codigo text,grupo text,documento_id uuid,estado text,observacion text,registrado_at timestamptz);');
  await db.exec(await readFile(new URL('../supabase/migrations/20261031180855_prepare_authenticated_source_cutover_preserve_canonical_ids.sql',import.meta.url),'utf8'));
  const secret=randomBytes(32).toString('hex'),hash=createHash('sha256').update(secret).digest('hex');
  await db.exec('set role authenticated');await assert.rejects(db.query('select public.kardex_enroll_live_source($1,$2,$3)',['cargos',newCargos,hash]));await db.exec('reset role;set role service_role');
  const enrolled=(await db.query('select public.kardex_enroll_live_source($1,$2,$3) as r',['cargos',newCargos,hash])).rows[0].r;assert.equal(enrolled.active,false);
  const probe=async()=> (await db.query('select public.kardex_live_source_probe($1,$2,$3) as r',['cargos',newCargos,secret])).rows[0].r;
  assert.equal((await probe()).canonical_id,oldCargos);assert.equal((await probe()).activa,false);
  await assert.rejects(db.query('select public.kardex_live_source_probe($1,$2,$3)',['cargos',newCargos,'wrong-secret-but-long-enough-to-validate']));
  await db.exec('reset role');await db.query('update private.kardex_live_sheet_config set active=true where sheet_id=$1',[newCargos]);await db.query('insert into public.kardex_google_sync values(true,true,$1)',[newCargos]);await db.exec('set role service_role');
  assert.equal((await probe()).activa,true);
  await assert.rejects(db.query('select public.kardex_enroll_live_source($1,$2,$3)',['cargos',newCargos,'a'.repeat(64)]));
  assert.equal((await probe()).activa,true);
  await db.exec('reset role');
  assert.equal((await db.query('select private.kardex_canonical_sheet($1,$2) as id',[newIM,'im'])).rows[0].id,oldIM);
  assert.equal((await db.query('select private.kardex_canonical_sheet($1,$2) as id',[oldCargos,'cargos'])).rows[0].id,oldCargos);
 }finally{await db.close();}
});
