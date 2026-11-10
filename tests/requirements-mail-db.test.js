import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

let db;
const id='11111111-1111-4111-8111-111111111111';
const loanId='22222222-2222-4222-8222-222222222222';
const user='33333333-3333-4333-8333-333333333333';
const migration=new URL('../supabase/migrations/20261110153000_req4_correo_solicitud.sql',import.meta.url);

before(async()=>{
  db=new PGlite();
  await db.exec([
    "create role anon;create role authenticated;",
    "create schema auth;create schema private;",
    "create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
    "create function private.kardex_has_access(boolean) returns boolean language sql stable as $$select auth.uid() is not null$$;",
    "create table public.requerimientos(id uuid primary key,tipo text not null);",
    "create table private.req4_movimientos(id uuid primary key,requerimiento uuid not null references public.requerimientos(id),tipo text not null,fecha date not null,datos jsonb not null,actor uuid not null,responsable text not null,registrado timestamptz not null default clock_timestamp());",
    "create table private.pickup_mail_config(id boolean primary key default true,sender_email text not null,recipients text[] not null,copies text[] not null,signature_name text not null,signature_company text not null);",
    "insert into public.requerimientos(id,tipo) values('"+id+"','Cajas nuevas para acondicionar'),('"+loanId+"','Préstamo de Cajas (búsqueda de documentos)');",
    "insert into private.pickup_mail_config(id,sender_email,recipients,copies,signature_name,signature_company) values(true,'admin@example.com',array['destino@example.com'],array['copia@example.com'],'Responsable','Farmacias Peruanas');",
    "select set_config('request.jwt.claim.sub','"+user+"',false);"
  ].join('\n'));
  await db.exec(await readFile(migration,'utf8'));
});
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});
after(async()=>{await db?.close();});
const call=async(action,request=id,subject=null)=>
  (await db.query('select public.kardex_req4_mail($1,$2::uuid,$3::text) as result',[action,request,subject])).rows[0].result;

test('estado no registra eventos antes del envío',async()=>{
  const result=await call('estado');
  assert.equal(result.estado,'NO_ENVIADO');
  assert.equal((await db.query("select count(*)::int n from private.req4_movimientos")).rows[0].n,0);
});
test('confirmar correo registra remitente y destinatarios, no toca solicitudes',async()=>{
  const result=await call('confirmar',id,'Solicitud de 100 cajas nuevas | CD Santa Anita');
  assert.equal(result.estado,'ENVIADO');
  assert.equal(result.ya_registrado,false);
  const entry=(await db.query("select tipo,datos,actor from private.req4_movimientos where requerimiento=$1",[id])).rows[0];
  assert.equal(entry.tipo,'correo_solicitud_enviado');
  assert.deepEqual(entry.datos.destinatarios,['destino@example.com']);
  assert.deepEqual(entry.datos.copias,['copia@example.com']);
  assert.equal(entry.actor,user);
  assert.equal((await call('estado')).estado,'ENVIADO');
  assert.equal((await db.query('select count(*)::int n from public.requerimientos')).rows[0].n,2);
});
test('confirmación repetida no duplica eventos y conserva el primer asunto',async()=>{
  await call('confirmar',loanId,'Solicitud préstamo | CD Santa Anita');
  const again=await call('confirmar',loanId,'Otro asunto válido | CD Santa Anita');
  assert.equal(again.ya_registrado,true);
  assert.equal(again.asunto,'Solicitud préstamo | CD Santa Anita');
  assert.equal((await db.query('select count(*)::int n from private.req4_movimientos')).rows[0].n,1);
});
test('sin autenticación bloquea estado',async()=>{
  await db.query("select set_config('request.jwt.claim.sub','',true)");
  await assert.rejects(call('estado'),/Acceso administrativo requerido/);
});
test('no confirma si faltan destinatarios de Aviso de recojo',async()=>{
  await db.exec("update private.pickup_mail_config set recipients=array[]::text[]");
  await assert.rejects(call('confirmar',id,'Solicitud de cajas | CD Santa Anita'),/Falta la configuración/);
});
