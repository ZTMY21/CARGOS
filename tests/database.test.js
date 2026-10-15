import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

let db;
const owner='11111111-1111-4111-8111-111111111111';
const editor='22222222-2222-4222-8222-222222222222';
const stranger='33333333-3333-4333-8333-333333333333';
async function login(id=owner) {
  await db.exec('reset role;');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
  await db.exec('set role authenticated;');
}
async function query(sql,args=[]) { return (await db.query(sql,args)).rows; }
async function createReq(quantity=2) {
  return (await query("insert into public.requerimientos(tipo,fecha_solicitud,cantidad_cajas,fecha_recepcion,usuario) values ('Cajas nuevas para acondicionar','2026-10-01',$1,'2026-10-02','Juan') returning to_jsonb(requerimientos) as result",[quantity]))[0].result;
}
async function createDoc(req=null) {
  return (await query("insert into public.documentos(periodo,usuario,caja_asignada) values ('2026-01-01','Juan',$1) returning to_jsonb(documentos) as result",[req]))[0].result;
}
async function snapshot() { return (await query('select public.kardex_snapshot() as result'))[0].result; }

before(async()=>{
  db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    insert into auth.users values
      ('${owner}','owner@example.test',now(),false),
      ('${editor}','editor@example.test',now(),false),
      ('${stranger}','stranger@example.test',null,false);
  `);
  const file=(await readdir(new URL('../supabase/migrations/',import.meta.url))).find(n=>n.endsWith('_kardex_initial.sql'));
  await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  await db.exec("insert into private.kardex_miembros(email,rol) values ('owner@example.test','admin'),('editor@example.test','editor');");
  await db.exec(await readFile(new URL('../db/guest-access.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../db/automatic-guests.sql',import.meta.url),'utf8'));
  await login();
});
after(async()=>{await db?.close();});

test('database allocates unique monotonic codes under overlapping client requests',async()=>{
  await query('select public.kardex_reset()');
  const rows=await Promise.all(Array.from({length:20},()=>createReq()));
  assert.equal(new Set(rows.map(r=>r.numero)).size,20);
  assert.deepEqual(rows.map(r=>r.numero).sort(),Array.from({length:20},(_,i)=>`REQ-${String(i+1).padStart(5,'0')}`));
  const docs=await Promise.all(Array.from({length:12},()=>createDoc()));
  assert.equal(new Set(docs.map(d=>d.kardex)).size,12);
  assert.equal(docs[0].kardex,'SA-00001');
  assert.ok(docs.every(d=>d.fecha_registro&&d.created_at&&d.updated_at));
});

test('foreign key deletion leaves assigned documents unassigned; capacity is enforced',async()=>{
  await query('select public.kardex_reset()');
  const req=await createReq(1), doc=await createDoc(req.id);
  await assert.rejects(createDoc(req.id),/ya están asignadas/);
  await query('delete from public.requerimientos where id=$1',[req.id]);
  assert.equal((await query('select caja_asignada from public.documentos where id=$1',[doc.id]))[0].caja_asignada,null);
});

test('bulk replacement is atomic, links UUIDs and advances both counters',async()=>{
  await query('select public.kardex_reset()');
  const original=await createReq(), oldDoc=await createDoc();
  const reqId='44444444-4444-4444-8444-444444444444';
  const reqs=[{id:reqId,numero:'REQ-00050',tipo:'Cajas nuevas para acondicionar',fecha_solicitud:'2026-05-01',cantidad_cajas:1,numeros_cargo:'',fecha_recepcion:'2026-05-02',usuario:'Juan'}];
  const docs=[{id:'55555555-5555-4555-8555-555555555555',kardex:'SA-00125',fecha_registro:'2026-05-03',tipo_doc:'Facturas-Guia',periodo:'2026-02-01',ubicacion:'Santa Anita',folios:20,cargos:['00037'],caja_asignada:reqId,usuario:'Juan',sustento_imagen:'data:image/jpeg;base64,YWJj',facturas:'F-001',obs:'Observación'}];
  const bad=[{...docs[0],caja_asignada:'99999999-9999-4999-8999-999999999999'}];
  await assert.rejects(query('select public.kardex_import($1::jsonb,$2::jsonb)',[JSON.stringify(reqs),JSON.stringify(bad)]),/foreign key/);
  let current=await snapshot();
  assert.equal(current.requerimientos[0].id,original.id);
  assert.equal(current.documentos[0].id,oldDoc.id);
  const result=(await query('select public.kardex_import($1::jsonb,$2::jsonb) as result',[JSON.stringify(reqs),JSON.stringify(docs)]))[0].result;
  assert.equal(result.requerimientos,1); assert.equal(result.documentos,1);
  current=await snapshot(); assert.equal(current.documentos[0].caja_asignada,reqId);
  assert.equal(current.documentos[0].facturas,'F-001'); assert.equal(current.documentos[0].sustento_imagen,docs[0].sustento_imagen);
  assert.equal((await createReq()).numero,'REQ-00051');
  assert.equal((await createDoc()).kardex,'SA-00126');
});

test('RLS denies anonymous and unapproved users, editors share records but cannot import/reset',async()=>{
  await login(stranger);
  assert.deepEqual(await query('select * from public.documentos'),[]);
  assert.deepEqual((await query('select public.kardex_access() as access'))[0].access,{allowed:false,is_admin:false});
  await assert.rejects(createDoc(),/Cuenta no autorizada|row-level security/);
  await login(editor);
  assert.ok((await query('select * from public.documentos')).length>0);
  await assert.rejects(createDoc(),/row-level security/);
  assert.deepEqual(await query("update public.documentos set obs='forbidden' returning id"),[]);
  assert.deepEqual(await query('delete from public.documentos returning id'),[]);
  await assert.rejects(query('select public.kardex_reset()'),/administrador/);
  await assert.rejects(query("select public.kardex_import('[]','[]')"),/administrador/);
  await assert.rejects(query("select private.kardex_set_counters(0,0)"),/administrador/);
  await assert.rejects(query('select * from private.kardex_miembros'),/permission denied/);
  await db.exec('reset role; set role anon;');
  await assert.rejects(query('select * from public.documentos'),/permission denied/);
  await assert.rejects(query('select public.kardex_snapshot()'),/permission denied/);
  await login();
});

test('optimistic updated_at prevents overwriting another user and identities are immutable',async()=>{
  await query('select public.kardex_reset()');
  const req=await createReq(), doc=await createDoc();
  const first=(await query('update public.documentos set obs=$1 where id=$2 returning updated_at::text',['Nueva nota',doc.id]))[0];
  assert.notEqual(first.updated_at,doc.updated_at);
  const stale=await query('update public.documentos set obs=$1 where id=$2 and updated_at=$3 returning id',['Nota vieja',doc.id,doc.updated_at]);
  assert.equal(stale.length,0);
  await assert.rejects(query("update public.documentos set kardex='SA-00999' where id=$1",[doc.id]),/correlativo/);
  await assert.rejects(query("update public.requerimientos set numero='REQ-00999' where id=$1",[req.id]),/correlativo/);
  await query('select public.kardex_reset()');
  assert.equal((await createReq()).numero,'REQ-00001');
  assert.equal((await createDoc()).kardex,'SA-00001');
});

test('Realtime publication includes both tables and public functions never bypass RLS',async()=>{
  await db.exec('reset role;');
  const published=await query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename");
  assert.deepEqual(published.map(r=>r.tablename),['documentos','requerimientos']);
  const functions=await query("select p.proname,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'kardex_%'");
  assert.equal(functions.length,4); assert.ok(functions.every(f=>f.prosecdef===false));
  await login();
});

test('confirmed accounts automatically read without membership and never gain write access',async()=>{
  await db.exec('reset role');
  await db.query('update auth.users set email_confirmed_at=now() where id=$1',[stranger]);
  await login(stranger);
  assert.deepEqual((await query('select public.kardex_access() as access'))[0].access,{allowed:true,is_admin:false});
  assert.ok((await query('select * from public.documentos')).length);
  await assert.rejects(createDoc(),/row-level security/);
  await assert.rejects(createReq(),/row-level security/);
  assert.deepEqual(await query("update public.documentos set obs='forbidden' returning id"),[]);
  assert.deepEqual(await query('delete from public.documentos returning id'),[]);
  await assert.rejects(query('select public.kardex_reset()'),/administrador/);
  await db.exec('reset role');
  await db.query('update auth.users set email_confirmed_at=null where id=$1',[stranger]);
  await login(stranger);assert.deepEqual(await query('select * from public.documentos'),[]);
  await login();
});
