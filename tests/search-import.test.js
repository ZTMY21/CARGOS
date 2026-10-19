import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {unaccent} from '@electric-sql/pglite/contrib/unaccent';
import {highlightMatch,filterDocuments,filterRequirements,assignedBoxCode,matchesAssignedBoxCode} from '../src/search.js';
import {HistoricalAccumulator} from '../src/historical.js';
import {makeImportBatches} from '../src/repository.js';

const owner='11111111-1111-4111-8111-111111111111';
const unknown='33333333-3333-4333-8333-333333333333';
const doc={id:'d',kardex:'SA-00001',tipoDoc:'Facturas-Guia',periodo:'2026-01-01',ubicacion:'Santa Anita',folios:2,cargos:['00123'],facturas:'F001-1201, F001-1202',cajaAsignada:'r',sustento:'GR-901',obs:'Revisión de María',usuario:'José',anioOrigen:2026};
const req={id:'r',numero:'REQ-00008',usuario:'José',tipo:'Cajas nuevas para acondicionar',fechaRecepcion:'2026-10-01',cantidadCajas:10,numerosCargo:''};

test('multifield search normalizes punctuation and accents and combines all filters',()=>{
 for(const query of ['F0011201','1201','REQ-00008','GR901','revision','JOSE','SA00001','00123']) {
  assert.equal(filterDocuments([doc],[req],{query}).length,1,query);
 }
 assert.equal(filterDocuments([doc],[req],{query:'1201',state:'En Proceso de Acondicionamiento',type:'Facturas-Guia',location:'Santa Anita',year:'2026'}).length,1);
 assert.equal(filterDocuments([doc],[req],{query:'1201',location:'CD Arequipa'}).length,0);
 assert.equal(filterRequirements([req],[doc],'req00008 jose').length,1);
 assert.equal(highlightMatch('F001-1201','F0011201'),'<mark>F001-1201</mark>');
 assert.equal(highlightMatch('<img src=x> José','JOSE'),'&lt;img src=x&gt; <mark>José</mark>');
});

test('Caja asignada acepta T, TD, solo numero y mantiene coincidencia exacta si existe',()=>{
  const boxes=[
    {...doc,id:'box-t',cajaAsignada:'',imConfirmado:true,imCodigoCaja:'T203258116',cargos:['1']},
    {...doc,id:'box-td',cajaAsignada:'',imConfirmado:true,imCodigoCaja:'TD203258116',cargos:['2']},
    {...doc,id:'box-numeric',cajaAsignada:'',imConfirmado:true,imCodigoCaja:'203258116',cargos:['3']},
    {...doc,id:'box-long',cajaAsignada:'',imConfirmado:true,imCodigoCaja:'T2032581167',cargos:['4']},
    {...doc,id:'invoice-only',cajaAsignada:'',imConfirmado:false,imCodigoCaja:'',facturas:'F-203258116',cargos:['203258116']},
    {...doc,id:'req-box',cajaAsignada:'r',imConfirmado:false,imCodigoCaja:''}
  ];
  const ids=(query,extra={})=>filterDocuments(boxes,[req],{query,type:'solo-cajas',...extra}).map(d=>d.id);
  assert.deepEqual(ids('203258116'),['box-t','box-td','box-numeric']);
  assert.deepEqual(ids('T203258116'),['box-t']);
  assert.deepEqual(ids('TD203258116'),['box-td']);
  assert.deepEqual(ids('20325811'),['box-t','box-td','box-numeric','box-long']);
  assert.deepEqual(ids('TD 203258116'),['box-td']);
  assert.deepEqual(ids('203258116',{invoiceExact:true}),['box-t','box-td','box-numeric']);
  assert.deepEqual(ids('REQ00008'),['req-box']);
  assert.ok(ids('').includes('req-box'));
  assert.equal(matchesAssignedBoxCode('TD-203258116','203258116',true),true);
  assert.equal(assignedBoxCode(boxes[0],new Map([['r','REQ-00008']])),'T203258116');
});

test('historical parser preserves missing fields, stable identities, annotations and mixed cargo headers',async()=>{
 const build=async()=>{
  const a=new HistoricalAccumulator();
  a.beginSheet('CARGOS NUEVOS 2026');
  a.addRow(1,[{col:1,value:'Fecha'},{col:2,value:'Cargo'},{col:4,value:'Codigo'},{col:6,value:'PDF'},{col:7,value:'Total_Paginas'}]);
  a.addRow(2,[{col:1,value:'06-01-2026'},{col:2,value:653},{col:4,value:'F001-1201'},{col:6,value:'documento.pdf'},{col:7,value:2}]);
  a.addRow(3,[{col:1,value:'06-01-2026'},{col:2,value:653},{col:6,value:'anexo.pdf'},{col:7,value:1}]);
  a.beginSheet('Cargos enviados 2023');
  a.addRow(4,[{col:1,value:'Fuente.xlsx · Hoja1'}]);
  a.addRow(6,[{col:1,value:'2023-01-01'},{col:2,value:'CARGO 1'},{col:6,value:'2023-01-01'},{col:7,value:'CARGO 2'}]);
  a.addRow(7,[{col:1,value:'F001-0001'},{col:6,value:'GR001-0002'},{col:8,value:'EN PROCESO'}]);
  return a.finish();
 };
 const result=await build(),again=await build();
 assert.equal(result.reqs.length,0);assert.equal(result.docs.length,3);
 assert.deepEqual(result.docs.map(d=>d.id),again.docs.map(d=>d.id));
 const flat=result.docs.find(d=>d.cargos[0]==='653');
 assert.equal(flat.periodo,'');assert.equal(flat.ubicacion,'');assert.equal(flat.cajaAsignada,'');assert.equal(flat.fEnvio,'');
 assert.equal(flat.fechaOrigen,'2026-01-06');assert.equal(flat.folios,3);
 assert.equal(flat.datosOrigen.registros.length,2);assert.equal(result.stats.filas_2026,2);
 const first=result.docs.find(d=>d.cargos[0]==='1'),second=result.docs.find(d=>d.cargos[0]==='2');
 assert.equal(first.facturas,'F001-0001');assert.equal(second.facturas,'GR001-0002');
 assert.ok(second.obs.includes('EN PROCESO'));
});

test('batching preserves every record and measures UTF-8 payload size',()=>{
 const records=Array.from({length:501},(_,i)=>({kind:i<5?'req':'doc',data:{id:i,value:'á'.repeat(10)}}));
 const chunks=makeImportBatches(records,1000,20);
 const saved=chunks.flatMap(c=>[...c.reqs,...c.docs]);
 assert.equal(saved.length,records.length);assert.equal(new Set(saved.map(r=>r.id)).size,records.length);
 assert.ok(chunks.every(c=>c.reqs.length+c.docs.length<=20));
});

test('indexed search, transactional batch upsert, backups, stable IDs and audit survive repeated imports',async()=>{
 const db=new PGlite({extensions:{pg_trgm,unaccent}});
 try {
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
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.exec('set role authenticated');
  const query=async(sql,args=[])=> (await db.query(sql,args)).rows;
  const path=`${owner}/file/history.xlsm`;
  await query("insert into storage.objects(bucket_id,name) values('respaldos-excel',$1)",[path]);
  const begin=async()=> (await query("select public.kardex_begin_import('history.xlsm',$1,'sha-test','historico') as id",[path]))[0].id;
  const id='44444444-4444-4444-8444-444444444444';
  const source={id,kardex:null,tipo_doc:'Facturas-Guia',periodo:null,ubicacion:null,folios:10,cargos:['653'],usuario:'Importación Excel',facturas:'F001-1201, F001-1202',clave_origen:'historico|2026|653',hoja_origen:'CARGOS NUEVOS 2026',anio_origen:2026,fecha_origen:'2026-01-06',datos_origen:{registros:[{PDF:'documento.pdf'}]}};
  const first=await begin();
  await query("select public.kardex_stage_import($1,0,'[]',$2::jsonb)",[first,JSON.stringify([source])]);
  assert.equal((await query('select count(*)::int as n from public.documentos'))[0].n,0);
  await assert.rejects(query('select public.kardex_commit_import($1,2)',[first]),/Faltan lotes/);
  const committed=(await query('select public.kardex_commit_import($1,1) as r',[first]))[0].r;
  assert.equal(committed.documentos_nuevos,1);
  const row=(await query('select to_jsonb(d) as d from public.documentos d'))[0].d;
  assert.equal(row.kardex,'SA-00001');assert.equal(row.periodo,null);assert.equal(row.ubicacion,null);
  const find=(await query("select public.kardex_search('f0011201') as r"))[0].r;
  assert.equal(find.total,1);assert.deepEqual(find.rows[0].facturas_encontradas,['F001-1201']);
  assert.equal(find.rows[0].kardex,'SA-00001');assert.ok(!('facturas' in find.rows[0]));assert.ok(!('datos_origen' in find.rows[0]));
  assert.equal((await query("select public.kardex_search('1201','','','','',true) as r"))[0].r.total,0);
  assert.equal((await query("select public.kardex_search('F001-1201','','','','origen:2026',true) as r"))[0].r.total,1);
  await query("update public.documentos set periodo='2026-01-01',ubicacion='CD Arequipa',usuario='José',obs='Revisión' where id=$1",[id]);
  const second=await begin();
  await query("select public.kardex_stage_import($1,0,'[]',$2::jsonb)",[second,JSON.stringify([{...source,facturas:'F001-1201, F001-1203'}])]);
  await query('select public.kardex_commit_import($1,1)',[second]);
  const revised=(await query('select to_jsonb(d) as d from public.documentos d'))[0].d;
  assert.equal(revised.id,row.id);assert.equal(revised.kardex,row.kardex);
  assert.equal(revised.ubicacion,'CD Arequipa');assert.equal(revised.periodo,'2026-01-01');assert.equal(revised.usuario,'José');
  assert.ok(revised.facturas.includes('1203'));assert.ok(!revised.facturas.includes('1202'));
  assert.equal((await query("select public.kardex_search('jose') as r"))[0].r.total,1);
  assert.equal((await query("select public.kardex_search('jose F0011203') as r"))[0].r.total,1);
  assert.equal((await query("select public.kardex_search('revision','','','Santa Anita') as r"))[0].r.total,0);
  const third=await begin();
  await query("select public.kardex_stage_import($1,0,'[]',$2::jsonb)",[third,JSON.stringify([{...source,id:'55555555-5555-4555-8555-555555555555',clave_origen:'another',req_numero:'REQ-99999'}])]);
  await assert.rejects(query('select public.kardex_commit_import($1,1)',[third]),/requerimiento inexistente/);
  assert.equal((await query('select count(*)::int as n from public.documentos'))[0].n,1);
  const standard=(await query("select public.kardex_begin_import('standard.xlsx',$1,'sha-test','kardex') as id",[path]))[0].id;
  await query("select public.kardex_stage_import($1,0,'[]',$2::jsonb)",[standard,JSON.stringify([{
   ...source,id:'66666666-6666-4666-8666-666666666666',kardex:row.kardex,clave_origen:null,hoja_origen:'',datos_origen:{},
   fecha_origen:null,anio_origen:null,periodo:'2026-02-01',ubicacion:'Santa Anita',facturas:revised.facturas
  }])]);
  await query('select public.kardex_commit_import($1,1)',[standard]);
  const standardRow=(await query('select to_jsonb(d) as d from public.documentos d'))[0].d;
  assert.equal(standardRow.id,id);assert.equal(standardRow.ubicacion,'Santa Anita');
  assert.deepEqual(standardRow.datos_origen,source.datos_origen);assert.equal(standardRow.fecha_origen,source.fecha_origen);
  const extra=(await query("insert into public.documentos(periodo,usuario) values('2026-01-01','Editor') returning id,kardex"))[0];
  const conflict=await begin();
  await query("select public.kardex_stage_import($1,0,'[]',$2::jsonb)",[conflict,JSON.stringify([{...source,id,kardex:extra.kardex}])]);
  await assert.rejects(query('select public.kardex_commit_import($1,1)',[conflict]),/Identificadores incompatibles/);
  assert.equal((await query('select count(*)::int as n from public.documentos'))[0].n,2);
  await query("select set_config('request.jwt.claim.sub',$1,false)",[unknown]);
  // Conservo la factura original incluso cuando la consulta omite todos los guiones.
  // También se puede buscar sólo por la terminación sin consultar toda la hoja.
  await query("update public.documentos set facturas='01-0FF01-0217573, 01-0FF01-0217574' where id=$1",[id]);
  for(const code of ['01-0FF01-0217573','010FF010217573','217573']) {
    const result=(await query('select public.kardex_search($1) as r',[code]))[0].r;
    assert.ok(result.total>=1,code);
    const found=result.rows.find(row=>row.facturas_encontradas?.includes('01-0FF01-0217573'));
    assert.ok(found,'La factura debe conservar los guiones originales: '+code);
    assert.ok(!found.facturas_encontradas.includes('01-0FF01-0217574'));
  }
  const exactNormalized=(await query("select public.kardex_search('010FF010217573','','','','',true) as r"))[0].r;
  assert.equal(exactNormalized.total,1);
  assert.deepEqual(exactNormalized.rows[0].facturas_encontradas,['01-0FF01-0217573']);
  const exactSuffix=(await query("select public.kardex_search('217573','','','','',true) as r"))[0].r;
  assert.equal(exactSuffix.total,0,'La opción Factura exacta exige código completo');
  await query("update public.documentos set facturas='F001-1201, F001-1203' where id=$1",[id]);
  assert.equal((await query("select public.kardex_search('F001') as r"))[0].r.total,0);
  await assert.rejects(query("select public.kardex_begin_import('x','x','x','x')"),/administrador/);
  await db.exec('reset role');
  const audit=(await query("select count(*)::int as n from private.kardex_historial where operacion='UPDATE'"))[0].n;
  assert.ok(audit>=2);
  const manualAudit=(await query("select antes,despues from private.kardex_historial where despues->>'obs'='Revisión' limit 1"))[0];
  assert.equal(manualAudit.despues.ubicacion,'CD Arequipa');assert.ok(!('facturas' in manualAudit.antes));
  const indexes=await query("select indexname from pg_indexes where tablename='documentos' and indexname like '%busqueda%'");
  assert.equal(indexes.length,2);
  assert.equal((await query("select public from storage.buckets where id='respaldos-excel'"))[0].public,false);
 } finally {await db.close();}
});
