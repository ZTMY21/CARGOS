import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const proposal=await readFile(new URL('../db/proposals/performance-20261029.sql',import.meta.url),'utf8');
const rollback=await readFile(new URL('../db/proposals/performance-20261029-rollback.sql',import.meta.url),'utf8');
const uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');

test('performance: SQL preserves historical relations, every summary field, access and records',async()=>{
  const db=new PGlite();
  const query=async(sql,args=[])=>(await db.query(sql,args)).rows;
  try {
    await db.exec(`create schema private;
      create role authenticated;create role anon;
      create table public.documentos(id uuid,
kardex text,
fecha_registro date,
tipo_doc text,
periodo date,
ubicacion text,
folios integer,
cargos text[],
caja_asignada uuid,
f_envio date,
sustento text,
sustento_imagen text,
usuario text,
facturas text,
obs text,
created_at timestamp with time zone,
updated_at timestamp with time zone,
clave_origen text,
hoja_origen text,
fecha_origen date,
anio_origen integer,
estado_origen text,
datos_origen jsonb,
importacion_id uuid,
busqueda_facturas text,
busqueda_meta text,
cantidad_facturas integer);
      create table private.im_envios_confirmados(documento_id uuid,codigo_caja text,fecha_envio date,responsable text);
      create table private.im_cajas_preparadas(documento_id uuid,codigo_caja text,responsable text);
      create table public.im_envios_cargos_live(codigo_cargo text,codigo_caja text,clasificacion_caja text,fecha_envio date,updated_at timestamptz);
      create function private.kardex_has_access(boolean) returns boolean language sql stable
        as $$select current_setting('test.allowed',true) is distinct from 'false'$$;
    `);
    await db.exec(rollback);
    await db.exec(`revoke all on function public.kardex_previous_cargos(uuid[]) from public;
      grant execute on function public.kardex_previous_cargos(uuid[]) to authenticated;
      grant usage on schema private to authenticated;
      grant execute on function private.kardex_has_access(boolean) to authenticated;
      grant select on public.documentos to authenticated;
      alter table public.documentos enable row level security;
      create policy read_documents on public.documentos for select to authenticated using ((select private.kardex_has_access(false)));
    `);
    const records=[];
    for(let n=1;n<=125;n++)records.push({
      id:uid(n),kardex:'SA-'+String(n).padStart(5,'0'),
      fecha_registro:n===124?null:'2026-01-01',
      fecha_origen:n===124?null:(n<=15?'2024-01-01':'2026-01-01'),
      anio_origen:n===124?null:(n<=15?2024:2026),
      cargos:n===125?[]:[String(n<=15?n:n%9).padStart(4,'0'),...(n===3?['SECOND-CARGO']:[])],
      busqueda_facturas:n===125?'tiny,abc':'ff010000001,ff010000001,gr0000000'+(n%7),
      facturas:'ORIGINAL, ORIGINAL',datos_origen:{registros:[{Codigo:'ORIGINAL'},{Codigo:'ORIGINAL'}]},
      sustento_imagen:n===1?'data:image/png;base64,AAAA':'',
      created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'
    });
    for(const r of records)await query('insert into public.documentos select * from jsonb_populate_record(null::public.documentos,$1::jsonb)',[JSON.stringify(r)]);
    await query('insert into private.im_envios_confirmados values ($1,\'TD123\',\'2026-02-01\',\'Owner\')',[uid(1)]);
    await query('insert into private.im_cajas_preparadas values ($1,\'P456\',\'Preparer\')',[uid(2)]);
    await db.exec(`insert into public.im_envios_cargos_live values
      ('3','T111','Por Solicitud',null,'2026-01-01'),
      ('0003','T222','Nueva','2026-03-01','2026-04-01'),
      ('SECOND-CARGO','TD333','Dañada',null,'2026-04-02');`);
    const fingerprint=async()=>(await query("select count(*) as rows,md5(string_agg(to_jsonb(d)::text,'' order by id)) as digest from public.documentos d"))[0];
    const before=await fingerprint();
    const summary=await query('select * from public.kardex_documentos_resumen order by id');
    const selections=[null,[],[uid(125)],[uid(124)],[uid(3)],[uid(3),uid(3)],
      records.slice(-10).map(r=>r.id),records.slice(-11).map(r=>r.id),records.slice(-100).map(r=>r.id),records.slice(-101).map(r=>r.id)];
    const prior=[];
    for(const ids of selections)prior.push((await query('select public.kardex_previous_cargos($1::uuid[]) result',[ids]))[0].result);
    const aclBefore=await query("select proacl::text from pg_proc where oid='public.kardex_previous_cargos(uuid[])'::regprocedure");
    await db.exec(proposal);
    for(let i=0;i<selections.length;i++){
      const next=(await query('select public.kardex_previous_cargos($1::uuid[]) result',[selections[i]]))[0].result;
      assert.deepEqual(next,prior[i],'selection '+i);
    }
    assert.ok(Object.values(prior[8]).some(items=>items.some(item=>item.codigos.length>0)));
    assert.deepEqual(await query('select * from public.kardex_documentos_resumen order by id'),summary);
    assert.deepEqual(await fingerprint(),before,'all records including duplicate source rows are unchanged');
    assert.deepEqual(await query("select proacl::text from pg_proc where oid='public.kardex_previous_cargos(uuid[])'::regprocedure"),aclBefore);
    await db.exec("set test.allowed='false';set role authenticated;");
    assert.deepEqual((await query('select public.kardex_previous_cargos($1::uuid[]) result',[selections[8]]))[0].result,{});
    await db.exec('reset role;set role anon;');
    await assert.rejects(query('select public.kardex_previous_cargos($1::uuid[])',[selections[8]]),/permission denied/);
    await db.exec('reset role;');
    await db.exec(rollback);
    assert.deepEqual(await query('select * from public.kardex_documentos_resumen order by id'),summary);
    assert.deepEqual(await fingerprint(),before);
  } finally {await db.close();}
});
