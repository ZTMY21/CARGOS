import test, {before, after, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

let db;
const owner='11111111-1111-4111-8111-111111111111';
const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Lima'});
const migrationDirectory=new URL('../supabase/migrations/',import.meta.url);

before(async()=>{
  db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    insert into auth.users(id,email,email_confirmed_at) values ('${owner}','owner@example.test',now());
  `);
  const files=await readdir(migrationDirectory);
  const initial=files.find(name=>name.endsWith('_kardex_initial.sql'));
  await db.exec(await readFile(new URL(initial,migrationDirectory),'utf8'));
  await db.exec(`
    insert into private.kardex_miembros(email,rol) values ('owner@example.test','admin');
    create table public.im_envios_cargos_live(codigo_caja text,codigo_cargo text,fecha_envio date);
    create view public.kardex_documentos_resumen as
      select d.id,l.codigo_caja im_live_codigo_caja from public.documentos d
      left join lateral (select codigo_caja from public.im_envios_cargos_live l
        where l.codigo_cargo=any(d.cargos) order by (l.fecha_envio is null) desc,l.codigo_caja limit 1) l on true;
    create function private.req4_cargos_unicos(text[]) returns text[] language sql immutable as $$ select $1 $$;
  `);
  await db.exec(await readFile(new URL('20261104050000_requerimientos_intervencion_4.sql',migrationDirectory),'utf8'));
  for (const migration of files.filter(name=>/_req4_(bloqueo_cajas_pendientes|codigos_suministro)\.sql$/.test(name)).sort()) {
    await db.exec(await readFile(new URL(migration,migrationDirectory),'utf8'));
  }
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
});
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});
after(async()=>{await db?.close();});

async function action(kind,data,id=randomUUID()) {
  return (await db.query('select public.kardex_req4_accion($1,$2,$3::jsonb) result',[id,kind,JSON.stringify(data)])).rows[0].result;
}
async function supply(quantity,id) {return action('crear',{tipo:'nuevas',cantidad:quantity},id);}
async function status() {return (await db.query('select public.kardex_req4_detalle() result')).rows[0].result.suministro;}
async function assign(row,cargo) {
  await db.query("insert into public.documentos(caja_asignada,periodo,cargos,usuario) values ($1,'2026-01-01',$2,'Juan')",[row.id,[cargo]]);
}

test('recepcionar cien cajas no permite solicitar ni una, ni dos, ni cien más',async()=>{
  const row=await supply(100);
  await action('recibir',{requerimiento:row.id,fecha:today,cantidad:100});
  const balance=await status();
  assert.equal(balance.pendientes,100);
  assert.equal(balance.enviadas,0);
  for(const quantity of [1,2,100]) {
    await db.exec('savepoint blocked_request');
    await assert.rejects(supply(quantity),/No se pueden solicitar más cajas a Iron Mountain/);
    await db.exec('rollback to savepoint blocked_request');
  }
  assert.equal((await db.query('select count(*)::integer n from public.requerimientos')).rows[0].n,1);
});

test('solo el envío completo de cajas físicas vinculadas libera otra solicitud y permite reintentos',async()=>{
  const id=randomUUID();
  const row=await supply(2,id);
  await action('recibir',{requerimiento:row.id,fecha:today,cantidad:2});
  await assign(row,'10');await assign(row,'11');
  await db.query("insert into public.im_envios_cargos_live values ('T1000000001','10',$1),('T1000000001','11',$1),('T9999999999','99',$1)",[today]);
  assert.equal((await status()).enviadas,1,'Dos cargos en la misma caja cuentan como una caja');
  await db.query("update public.im_envios_cargos_live set codigo_caja='T1000000002',fecha_envio=null where codigo_cargo='11'");
  assert.equal((await status()).pendientes,1,'El envío parcial mantiene el bloqueo');
  await db.query("update public.im_envios_cargos_live set fecha_envio=$1 where codigo_cargo='11'",[today]);
  assert.equal((await status()).bloqueado,false);
  const next=await supply(1);
  assert.notEqual(next.id,row.id);
  assert.equal((await status()).pendientes,1);
  assert.equal((await supply(2,id)).id,row.id,'Reintentar el mismo pedido no crea otro');
});

test('fechas antiguas, futuras o cargos sin envío en la misma caja mantienen el bloqueo',async()=>{
  const row=await supply(1);
  await action('recibir',{requerimiento:row.id,fecha:today,cantidad:1});await assign(row,'10');
  await db.query("insert into public.im_envios_cargos_live values ('T1000000001','10',$1::date-1)",[today]);
  assert.equal((await status()).pendientes,1);
  await db.query('update public.im_envios_cargos_live set fecha_envio=$1::date+1',[today]);
  assert.equal((await status()).pendientes,1);
  await db.query('update public.im_envios_cargos_live set fecha_envio=$1',[today]);
  await db.query("insert into public.im_envios_cargos_live values ('t1000000001','12',null)");
  assert.equal((await status()).pendientes,1);
});

test('el control de suministro exige permisos de administrador',async()=>{
  await db.query("select set_config('request.jwt.claim.sub','',false)");
  await assert.rejects(status(),/Solo administradores/);
});

test('el suministro admite los códigos de Control de cajas sin contar prefijos duplicados',async()=>{
  const row=await supply(2);
  await action('recibir',{requerimiento:row.id,fecha:today,cantidad:2});
  await assign(row,'10');await assign(row,'11');
  await db.query("insert into public.im_envios_cargos_live values ('TD123-45','10',$1),('12345','11',$1)",[today]);
  assert.equal((await status()).enviadas,1);
  await db.query("update public.im_envios_cargos_live set codigo_caja='P54321' where codigo_cargo='11'");
  assert.equal((await status()).bloqueado,false);
});
