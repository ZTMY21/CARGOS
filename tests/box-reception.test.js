import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import JSZip from 'jszip';
import {parseReceptionScan} from '../src/box-scanner.js';
import {createReceptionFixture,appendReceivedBoxes} from '../server/reception-workbook.js';
import {appendPreparedBoxToMaster} from '../server/im-master-write.js';
import {createBoxReceptionHandler} from '../api/box-reception.js';

const settings={minimumBoxes:1};
const testCode=n=>'940021'+String(n).padStart(4,'0');
const codes=Array.from({length:100},(_,i)=>({clave:testCode(i+1),codigo:'T'+testCode(i+1)}));
const excelFields=['preparacion','responsable','celda','clasificacion','envio','entrega','recibe','placa'];

test('recepción requiere un código completo incluso cuando termina sin Enter',()=>{
  for(const code of ['T940021000','94002100','TD94002100011','T94002100-01','A9400210001','S/N']) {
    assert.equal(parseReceptionScan(code).ok,false,code);
  }
  for(const prefix of ['','T','TD','P']){
    assert.deepEqual(parseReceptionScan(prefix+'9400210001'),{
      ok:true,normalized:'9400210001',original:prefix+'9400210001'
    });
  }
});

test('el Maestro recibe exactamente 55 y 45 filas, preserva las partes del libro y acepta acondicionar la misma fila',async()=>{
  const fixture=await createReceptionFixture();
  const zip=await JSZip.loadAsync(fixture.bytes);
  const macroSentinel=Buffer.from('VBA de prueba para comprobar preservación de bytes');
  zip.file('xl/vbaProject.bin',macroSentinel);
  const fixtureWithVba=await zip.generateAsync({type:'nodebuffer'});
  const first=await appendReceivedBoxes(fixtureWithVba,codes.slice(0,55),settings);
  assert.equal(first.rows.length,57);
  assert.equal(Object.keys(first.added).length,55);
  assert.equal(first.rows[2].numero,'901');
  const saved=codes.slice(0,55).map(r=>({...r,guardado:'2026-11-07T15:00:00Z',correlativo:first.added[r.clave]}));
  const repeated=await appendReceivedBoxes(first.bytes,saved,settings);
  assert.equal(Object.keys(repeated.added).length,0);
  assert.deepEqual(repeated.bytes,first.bytes);
  const second=await appendReceivedBoxes(first.bytes,[...saved,...codes.slice(55)],settings);
  assert.equal(Object.keys(second.added).length,45);
  assert.equal(second.rows.length,102);
  for(const row of second.rows.slice(2)){
    assert.equal(row.receivedOnly,true);
    assert.deepEqual(row.cargos,[]);
    for(const field of excelFields) assert.equal(row[field],'',field);
  }
  assert.equal(new Set(second.rows.map(r=>r.numero)).size,102);
  assert.deepEqual(second.rows.slice(0,2),first.rows.slice(0,2));
  const modified=await JSZip.loadAsync(second.bytes);
  for(const path of Object.keys(zip.files).filter(path=>!zip.files[path].dir &&
    !['xl/worksheets/sheet1.xml','xl/tables/table1.xml'].includes(path))) {
    assert.deepEqual(await modified.file(path).async('nodebuffer'),await zip.file(path).async('nodebuffer'),path);
  }
  await assert.rejects(appendReceivedBoxes(first.bytes,codes.slice(0,55),settings),/IM_MASTER_EXISTING_BOX_CONFLICT/);
  await assert.rejects(appendReceivedBoxes(second.bytes,[{...saved[0],correlativo:1}],settings),/IM_MASTER_RECEIPT_NOT_VERIFIED/);
  const conditioned=await appendPreparedBoxToMaster(second.bytes,{
    code:codes[0].clave,cargos:['9876540'],classification:'Cajas Nuevas'
  },{...settings,preparacion:'2026-11-07',responsable:'Operador sintético'});
  assert.equal(conditioned.rows.length,second.rows.length);
  const prepared=conditioned.rows.find(row=>row.caja===codes[0].codigo);
  assert.equal(prepared.numero,'901');
  assert.deepEqual(prepared.cargos,['9876540']);
  assert.equal(prepared.envio,'');
});

test('la API de recepción queda cerrada fuera de su rama y ante una base no aislada',async()=>{
  const env={VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'preview/recepcion-cajas-im',
    SUPABASE_URL:'https://qpbzfzcobkkfnoioqytb.supabase.co',KARDEX_RECEPCION_PRUEBA_SECRET:'a'.repeat(64)};
  for(const unsafe of [
    {...env,VERCEL_ENV:'production'},
    {...env,VERCEL_GIT_COMMIT_REF:'main'},
    {...env,SUPABASE_URL:'https://uhjwhamzjxhjqlrhgxho.supabase.co'},
    {...env,KARDEX_RECEPCION_PRUEBA_SECRET:''}
  ]){
    const res={setHeader(){},end(){},statusCode:0};
    await createBoxReceptionHandler({env:unsafe,fetcher:()=>assert.fail('contactó una dependencia externa')})({},res);
    assert.equal(res.statusCode,403);
  }
});

test('Supabase aplica propiedad, límite, conciliación idempotente y bloqueo hasta que todas las cajas estén listas',async()=>{
  const db=new PGlite();
  const owner='11111111-1111-4111-8111-111111111111';
  const stranger='22222222-2222-4222-8222-222222222222';
  const user='33333333-3333-4333-8333-333333333333';
  const migration = async name => db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  const one=async(sql,params=[]) => (await db.query(sql,params)).rows[0].result;
  const actor=id=>one("select set_config('request.jwt.claim.sub',$1,false) result",[id]);
  const req=(action,data,id=randomUUID())=>one('select public.kardex_req4_accion($1,$2,$3::jsonb) result',[id,action,JSON.stringify(data)]);
  const op=(action,id,code)=>one('select public.kardex_recepcion_operacion($1,$2,$3) result',[action,id,code]);
  const commit=(action,id,version,rows)=>one('select public.kardex_recepcion_prueba_excel($1,$2,$3,$4,$5,$6::jsonb) result',
    [action,id,'prueba-local',version,Buffer.from('bytes verificados por el API').toString('base64'),JSON.stringify(rows)]);
  try{
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        is_anonymous boolean default false,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated,anon;
      grant execute on function auth.uid() to authenticated,anon;
      insert into auth.users(id,email,email_confirmed_at) values
        ('${owner}','owner@example.test',now()),('${stranger}','other@example.test',now()),('${user}','guest@example.test',now());
    `);
    await migration('20261014013220_kardex_initial.sql');
    await db.exec(`
      insert into private.kardex_miembros(email,rol) values
        ('owner@example.test','admin'),('other@example.test','admin'),('guest@example.test','editor');
      create table public.im_envios_cargos_live(codigo_caja text,codigo_cargo text,fecha_envio date);
      create view public.kardex_documentos_resumen as select id,null::text im_live_codigo_caja from public.documentos;
      create view public.kardex_live_ingresos as select null::text cargo where false;
      create function private.req4_cargos_unicos(text[]) returns text[] language sql immutable as $$ select $1 $$;
    `);
    await migration('20261101195000_box_conditioning.sql');
    await migration('20261101200500_box_conditioning_rls.sql');
    await migration('20261104050000_requerimientos_intervencion_4.sql');
    await migration('20261106023211_req4_bloqueo_cajas_pendientes.sql');
    await migration('20261106023558_req4_codigos_suministro.sql');
    await migration('20261107172500_recepcion_cajas.sql');
    await actor(owner);
    await db.exec(`
      insert into private.recepcion_maestro_prueba(archivo,secreto_hash,codigos)
        values(decode('0102','hex'),sha256(convert_to('prueba-local','UTF8')),'{"9900000700":700}');
      insert into public.documentos(cargos,usuario,periodo) values(array['9876540'],'Fixture','2026-11-01');
    `);
    const row=await req('crear',{tipo:'nuevas',cantidad:2});
    const id=row.id;
    assert.equal((await op('estado',null,null)).lecturas.length,0);
    await assert.rejects(req('recibir',{requerimiento:id,cantidad:2}),/Control de cajas/);
    await assert.rejects(op('leer',id,'T940021000'),/incompleto/);
    await assert.rejects(op('leer',id,'T9900000700'),/ya está registrada/);
    await actor(stranger);
    await assert.rejects(op('leer',id,codes[0].codigo),/otro administrador/);
    const other=await req('crear',{tipo:'nuevas',cantidad:1});
    await actor(user);
    await assert.rejects(op('leer',id,codes[0].codigo),/Solo administradores/);
    await actor(owner);
    assert.equal((await op('leer',id,codes[0].codigo)).lecturas.length,1);
    assert.equal((await op('leer',id,codes[0].clave)).duplicada,true);
    await actor(stranger);
    await assert.rejects(op('leer',other.id,codes[0].codigo),/otro requerimiento/);
    await actor(owner);
    await assert.rejects(commit('completa',id,0,{}),/todavía/);
    assert.equal((await commit('parcial',id,0,{[codes[0].clave]:901})).lecturas[0].correlativo,901);
    await assert.rejects(commit('parcial',id,0,{[codes[0].clave]:901}),/Maestro cambió/);
    assert.equal((await op('estado',id,null)).lecturas.length,1);
    assert.equal((await op('leer',id,codes[1].codigo)).lecturas.length,2);
    await assert.rejects(op('leer',id,codes[2].codigo),/cantidad solicitada/);
    const complete=await commit('completa',id,1,{[codes[1].clave]:902});
    assert.ok(complete.confirmada);
    assert.equal((await commit('completa',id,2,{})).confirmada,complete.confirmada);
    await assert.rejects(req('crear',{tipo:'nuevas',cantidad:100}),/No se pueden solicitar/);
    const condition=async({codigo})=>{
      for(const action of ['iniciar','finalizar'])await one(
        'select public.kardex_box_conditioning_write($1,$2,$3,$4,$5) result',
        [action,codigo,['9876540'],'Cajas Nuevas','']);
    };
    await condition(codes[0]);
    await assert.rejects(req('crear',{tipo:'nuevas',cantidad:1}),/No se pueden solicitar/);
    await condition(codes[1]);
    assert.equal((await req('crear',{tipo:'nuevas',cantidad:100})).cantidad_cajas,100);
    const detail=await one('select public.kardex_req4_detalle() result');
    assert.deepEqual(detail.movimientos.filter(x=>x.requerimiento===id).map(x=>x.tipo),
      ['crear','recepcion_parcial','recepcion_completa']);
  }finally{await db.close();}
});
