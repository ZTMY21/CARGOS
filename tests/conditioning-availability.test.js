import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('imported cargos without location remain available, preserving shipment and duplicate guards',async()=>{
 const db=new PGlite();
 try {
 await db.exec(`create schema private;
 create table documentos(id uuid default gen_random_uuid(),cargos text[],ubicacion text,caja_asignada uuid,f_envio date,fecha_origen date,anio_origen int,periodo date);
 create table kardex_documentos_resumen(id uuid,im_codigo_caja text,im_caja_preparada text,im_live_codigo_caja text,im_historical_decision text);
 create table private.acond_movimientos(origen text,clave text,solicitud uuid,anios int[],cargos text[]);
 create function private.req4_cargo(v text) returns text language sql immutable as $$select upper(trim(v))$$;`);
 const original=await readFile(new URL('../supabase/migrations/20261108090000_acondicionamiento_integral.sql',import.meta.url),'utf8');
 await db.exec(original.slice(original.indexOf('create function private.acond_cargo_clave('),original.indexOf('create view private.acond_cajas')));
 await db.exec(original.slice(original.indexOf('create function private.acond_cargo('),original.indexOf('create function private.acond_buscar(')));
 await db.exec(`insert into documentos(cargos,fecha_origen) values ('{0401}','2025-03-14'),('{0419}','2025-03-28'); insert into kardex_documentos_resumen(id) select id from documentos;`);
 const check=async(code='401',year=2025)=>(await db.query('select private.acond_cargo($1,$2,null,null) result',[code,year])).rows[0].result;
 assert.equal((await check()).status,'no_disponible');
 await db.exec(await readFile(new URL('../supabase/migrations/20261109144842_acond_cargos_sin_ubicacion.sql',import.meta.url),'utf8'));
 for(const code of ['401','0401','419','0419']) assert.equal((await check(code)).status,'disponible');
 assert.equal((await check()).codigo,'0401');
 assert.equal((await check('401',2024)).status,'inexistente');
 for(const location of ['', '   ', 'Santa Anita','CD Santa Anita']){
 await db.query('update documentos set ubicacion=$1',[location]); assert.equal((await check()).status,'disponible');
 }
 await db.exec("update documentos set ubicacion='Iron Mountain'"); assert.equal((await check()).status,'no_disponible');
 await db.exec('update documentos set ubicacion=null');
 for(const col of ['im_codigo_caja','im_caja_preparada','im_live_codigo_caja','im_historical_decision']){
 await db.exec(`update kardex_documentos_resumen set ${col}='${col==='im_historical_decision'?'historico':'TD123456'}'`);
 assert.equal((await check()).status,'no_disponible'); await db.exec(`update kardex_documentos_resumen set ${col}=null`);
 }
 await db.exec("update documentos set f_envio='2026-11-01'"); assert.equal((await check()).status,'no_disponible');
 await db.exec('update documentos set f_envio=null,caja_asignada=gen_random_uuid()'); assert.equal((await check()).status,'no_disponible');
 await db.exec('update documentos set caja_asignada=null');
 await db.exec("insert into private.acond_movimientos values ('nueva','123456',gen_random_uuid(),'{2025}','{0401}')"); assert.equal((await check()).status,'no_disponible');
 await db.exec('delete from private.acond_movimientos');
 await db.exec("insert into documentos(cargos,fecha_origen) values ('{401}','2025-04-01'); insert into kardex_documentos_resumen(id) select id from documentos where cargos='{401}'"); assert.equal((await check()).status,'ambiguo');
 } finally {await db.close();}
});
