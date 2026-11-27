import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
import {attachConditioningWorkspace} from '../src/conditioning-workspace.js';
import {inventoryConditioning} from '../src/conditioning-inventory.js';

test('histórico físico disponible; envío y otra caja bloqueados por documento',async()=>{
  const db=new PGlite();
  try{
    await db.exec("create schema private; create table documentos(id uuid default gen_random_uuid(),cargos text[],ubicacion text,caja_asignada uuid,f_envio date,sustento text,sustento_imagen text,fecha_origen date,anio_origen int,periodo date); create table private.acond_movimientos(origen text,clave text,solicitud uuid,anios int[],cargos text[],documentos_ids uuid[]); create table private.kardex_im_historical_audit(documento_id uuid,revoked_at timestamptz,decision text); create table private.im_envios_confirmados(documento_id uuid); create table private.im_cajas_preparadas(documento_id uuid); create table im_envios_cargos(codigo_cargo text); create table im_envios_cargos_live(codigo_cargo text,codigo_caja text,fecha_envio date,fecha_preparacion date); create function private.req4_cargo(v text) returns text language sql immutable as 'select ltrim(upper(trim(v)),''0'')';");
    const base=await readFile(new URL('../supabase/migrations/20261108090000_acondicionamiento_integral.sql',import.meta.url),'utf8');
    await db.exec(base.slice(base.indexOf('create function private.acond_clave('),base.indexOf('create view private.acond_cajas')));
    const migration=await readFile(new URL('../supabase/migrations/20261127010000_acond_historicos_dos_anios.sql',import.meta.url),'utf8');
    await db.exec(migration.slice(migration.indexOf('create or replace function private.acond_cargo('),migration.indexOf('create or replace function private.acond_operacion(')));
    await db.exec(migration.slice(migration.indexOf('create or replace function private.acond_operacion('),migration.indexOf('create or replace view public.kardex_documentos_resumen')));
    const docs=(await db.query("insert into documentos(cargos,fecha_origen,ubicacion,f_envio) values ('{0350}','2024-04-01','Iron Mountain','2024-10-01'),('{0350}','2025-04-01','Santa Anita',null),('{0419}','2025-04-01','Santa Anita',null) returning id")).rows;
    await db.query("insert into private.kardex_im_historical_audit values ($1,null,'historico')",[docs[0].id]);
    const lookup=async(cargo,year)=>(await db.query('select private.acond_cargo($1,$2,null,null) result',[cargo,year])).rows[0].result;
    assert.equal((await lookup('350',2024)).documento_id,docs[0].id);
    assert.equal((await lookup('350',2025)).documento_id,docs[1].id);
    assert.equal((await lookup('419',2025)).status,'disponible');
    await db.query('insert into private.im_envios_confirmados values ($1)',[docs[0].id]);
    assert.equal((await lookup('350',2024)).status,'no_disponible');
    await db.exec('delete from private.im_envios_confirmados');
    await db.query('update documentos set caja_asignada=gen_random_uuid() where id=$1',[docs[0].id]);
    assert.equal((await lookup('350',2024)).status,'no_disponible');
    await db.query('update documentos set caja_asignada=null where id=$1',[docs[0].id]);
    await db.query("insert into private.acond_movimientos values ('nueva','9000000123',gen_random_uuid(),'{2024}','{0350}',array[$1::uuid])",[docs[0].id]);
    assert.equal((await lookup('350',2024)).status,'no_disponible');
    assert.equal((await lookup('350',2025)).status,'disponible');
    await db.exec("insert into im_envios_cargos_live values ('350','T9000000123','2026-11-20','2026-11-19')");
    assert.equal((await lookup('350',2025)).status,'disponible');
    await db.exec("update im_envios_cargos_live set codigo_caja='T9000000999'");
    assert.equal((await lookup('350',2025)).status,'no_disponible');
  }finally{await db.close();}
});

test('dos años por caja y asociación exacta en existencias',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html);globalThis.document=dom.window.document;
  const calls=[];
  const repository={
    async conditioning(action,data){
      if(action==='listar')return {nuevas:1,solicitadas:0,preparadas:0,listado:[]};
      if(action==='buscar')return {codigo:'T9000000123',origen:'nueva',status:'disponible'};
      if(action==='cargo'){calls.push(data);return {status:'disponible',codigo:data.p_cargos[0]};}
      calls.push({action,...data});return {codigo:'T9000000123',cargos:['0350','0419'],anios:[2024,2025]};
    },
    async reception(){return null;},async conditioningExcel(){return {verified:true,count:1};}
  };
  const controller=attachConditioningWorkspace({repository});
  const el=id=>document.getElementById(id);
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  try{
    controller.activate();
    el('acondScan').value='T9000000123';el('acondScanForm').requestSubmit();await settle();
    el('acondYears').querySelector('[value="2024"]').click();
    el('acondYears').querySelector('[value="2025"]').click();
    assert.equal(el('acondYears').querySelectorAll('[aria-pressed="true"]').length,2);
    el('acondCargo1').value='0350';el('acondCargo2').value='0419';
    el('acondCargo2').parentElement.querySelector('select').value='2025';
    for(const i of [1,2])el('acondCargo'+i).parentElement.querySelector('button').click();
    await settle();
    assert.deepEqual(calls.map(c=>c.p_anio),[2024,2025]);
    el('acondSave').click();await settle();
    const prepared=calls.find(c=>c.action==='preparar');
    assert.deepEqual(prepared.p_datos.anios_cargos,[2024,2025]);
    assert.deepEqual(prepared.p_cargos,['0350','0419']);
    const bound=inventoryConditioning([{codigo:'T9000000123',clave:'9000000123',origen:'nueva',
      cargos:['0350','0419'],anios:[2024,2025],cargo_anios:[2024,2025],documentos_ids:['doc-2024','doc-2025']}]);
    assert.equal(bound({id:'doc-2024',cargos:['0350'],anioOrigen:2024}).acondicionamiento?.codigo,'T9000000123');
    assert.equal(bound({id:'doc-other',cargos:['0350'],anioOrigen:2025}).acondicionamiento,undefined);
  }finally{controller.reset();dom.window.close();delete globalThis.document;}
});
