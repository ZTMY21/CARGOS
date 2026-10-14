-- Search large invoice lists inside Postgres; the browser receives only summary rows.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
grant usage on schema extensions to authenticated;

-- The management connection is already a database administrator. PostgREST roles cannot impersonate it.
create or replace function private.kardex_has_access(admin_only boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select (
    session_user in ('postgres','supabase_admin')
    and coalesce(current_setting('role',true),'none') in ('none','postgres','supabase_admin')
  ) or ((select auth.uid()) is not null and exists (
    select 1 from auth.users u join private.kardex_miembros m on m.email=lower(u.email)
    where u.id=(select auth.uid()) and u.email_confirmed_at is not null and coalesce(u.is_anonymous,false)=false
      and (not admin_only or m.rol='admin')
  ));
$$;

alter table public.documentos alter column periodo drop not null;
alter table public.documentos alter column ubicacion drop not null;
alter table public.documentos add column clave_origen text unique;
alter table public.documentos add column hoja_origen text not null default '';
alter table public.documentos add column fecha_origen date;
alter table public.documentos add column anio_origen integer;
alter table public.documentos add column estado_origen text not null default '';
alter table public.documentos add column datos_origen jsonb not null default '{}';
alter table public.documentos add column importacion_id uuid;
alter table public.documentos add constraint documentos_periodo_origen check(periodo is not null or clave_origen is not null);

create function private.kardex_normalize(value text) returns text
language sql immutable parallel safe security invoker set search_path='' as $$
 select regexp_replace(lower(extensions.unaccent(coalesce(value,''))),'[^a-z0-9]','','g');
$$;
create function private.kardex_invoice_normalize(value text) returns text
language sql immutable parallel safe security invoker set search_path='' as $$
 select regexp_replace(lower(extensions.unaccent(coalesce(value,''))),'[^a-z0-9,;\n]','','g');
$$;
revoke all on function private.kardex_normalize(text),private.kardex_invoice_normalize(text) from public,anon;
grant execute on function private.kardex_normalize(text),private.kardex_invoice_normalize(text) to authenticated;

create function private.kardex_text_array(value text[]) returns text
language sql immutable parallel safe security invoker set search_path='' as $$ select coalesce(array_to_string(value,'|'),''); $$;
revoke all on function private.kardex_text_array(text[]) from public,anon;
grant execute on function private.kardex_text_array(text[]) to authenticated;

alter table public.documentos add column busqueda_facturas text generated always as (private.kardex_invoice_normalize(facturas)) stored;
alter table public.documentos add column busqueda_meta text generated always as (
 private.kardex_normalize(kardex||'|'||private.kardex_text_array(cargos)||'|'||tipo_doc||'|'||coalesce(ubicacion,'')||'|'||sustento||'|'||obs||'|'||usuario||'|'||hoja_origen)
) stored;
create index documentos_busqueda_facturas_idx on public.documentos using gin(busqueda_facturas extensions.gin_trgm_ops);
create index documentos_busqueda_meta_idx on public.documentos using gin(busqueda_meta extensions.gin_trgm_ops);
create index documentos_anio_origen_idx on public.documentos(anio_origen);

alter table public.documentos add column cantidad_facturas integer generated always as (
 case when facturas='' then 0 else cardinality(regexp_split_to_array(facturas,'[,;\n]+')) end
) stored;
create view public.kardex_documentos_resumen with(security_invoker=true) as
select id,kardex,fecha_registro,tipo_doc,periodo,ubicacion,folios,cargos,caja_asignada,f_envio,sustento,usuario,obs,
 created_at,updated_at,clave_origen,hoja_origen,fecha_origen,anio_origen,estado_origen,importacion_id,
 (sustento_imagen<>'') as tiene_sustento_imagen,
 cantidad_facturas
from public.documentos;
revoke all on public.kardex_documentos_resumen from public,anon;
grant select on public.kardex_documentos_resumen to authenticated;

create or replace function public.kardex_snapshot() returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'requerimientos',coalesce((select jsonb_agg(r order by r.created_at,r.id) from public.requerimientos r),'[]'::jsonb),
 'documentos',coalesce((select jsonb_agg(v order by v.created_at,v.id) from public.kardex_documentos_resumen v),'[]'::jsonb));
$$;

create function public.kardex_search(
 query_text text default '',estado_filter text default '',tipo_filter text default '',ubicacion_filter text default '',
 year_filter text default '',invoice_exact boolean default false,page_offset integer default 0,page_limit integer default 100
) returns jsonb language sql stable security invoker set search_path='' as $$
 with input as (
  select private.kardex_normalize(query_text) as q,
   array(select private.kardex_normalize(t) from regexp_split_to_table(trim(query_text),'\s+') t where private.kardex_normalize(t)<>'') as terms
 ), candidates as materialized (
  select d.id from public.documentos d cross join input i where i.q=''
  union
  select d.id from public.documentos d cross join input i where i.q<>'' and d.busqueda_meta like '%'||i.terms[1]||'%'
  union
  select d.id from public.documentos d cross join input i where i.q<>'' and d.busqueda_facturas like '%'||i.terms[1]||'%'
  union
  select d.id from public.requerimientos r join public.documentos d on d.caja_asignada=r.id cross join input i
   where i.q<>'' and private.kardex_normalize(r.numero) like '%'||i.terms[1]||'%'
 ), matched as materialized (
  select d.id,d.folios,d.kardex,
   (d.busqueda_facturas ~ ('(^|[,;\n])'||i.q||'([,;\n]|$)') and i.q<>'') as exact_match
  from candidates c join public.documentos d on d.id=c.id left join public.requerimientos r on r.id=d.caja_asignada cross join input i
  where (not invoice_exact or i.q='' or d.busqueda_facturas ~ ('(^|[,;\n])'||i.q||'([,;\n]|$)'))
   and not exists(select 1 from unnest(i.terms) t where not (
    d.busqueda_meta like '%'||t||'%' or d.busqueda_facturas like '%'||t||'%'
    or private.kardex_normalize(r.numero) like '%'||t||'%'))
   and (estado_filter='' or estado_filter=case
    when d.f_envio is not null and (d.sustento<>'' or d.sustento_imagen<>'') then 'Enviado a Iron Mountain'
    when d.caja_asignada is not null then 'En Proceso de Acondicionamiento' else 'Pendiente de Envío' end)
   and (tipo_filter='' or d.tipo_doc=tipo_filter)
   and (ubicacion_filter='' or d.ubicacion=ubicacion_filter or (ubicacion_filter='sin-dato' and d.ubicacion is null))
   and (year_filter='' or (year_filter='sin-periodo' and d.periodo is null)
    or (year_filter~'^origen:[0-9]{4}$' and d.anio_origen=case when year_filter~'^origen:[0-9]{4}$' then substring(year_filter from 8)::integer end)
    or (year_filter~'^[0-9]{4}$' and extract(year from d.periodo)::integer=case when year_filter~'^[0-9]{4}$' then year_filter::integer end))
 ), page as (
  select * from matched order by exact_match desc,kardex desc limit least(greatest(page_limit,1),1000) offset greatest(page_offset,0)
 ), output as (
  select p.kardex,p.exact_match,to_jsonb(v)||jsonb_build_object('facturas_encontradas',coalesce((
   select jsonb_agg(f.numero) from (
    select distinct trim(raw) as numero from regexp_split_to_table(d.facturas,'[,;\n]+') raw cross join input i
    where trim(raw)<>'' and (i.q='' or (invoice_exact and private.kardex_normalize(raw)=i.q)
     or (not invoice_exact and exists(select 1 from unnest(i.terms) t where private.kardex_normalize(raw) like '%'||t||'%')))
    limit case when trim(query_text)='' then 3 else 10 end
   ) f),'[]'::jsonb)) as data
  from page p join public.documentos d on d.id=p.id join public.kardex_documentos_resumen v on v.id=p.id
 )
 select jsonb_build_object('rows',coalesce((select jsonb_agg(data order by exact_match desc,kardex desc) from output),'[]'::jsonb),
  'total',(select count(*) from matched),'folios',(select coalesce(sum(folios),0) from matched),
  'folios_sin_dato',(select count(*) from matched where folios is null));
$$;
revoke all on function public.kardex_search(text,text,text,text,text,boolean,integer,integer) from public,anon;
grant execute on function public.kardex_search(text,text,text,text,text,boolean,integer,integer) to authenticated;

-- Original uploads and import manifests remain private; no accounting data is stored in GitHub.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('respaldos-excel','respaldos-excel',false,52428800,array[
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 'application/vnd.ms-excel.sheet.macroEnabled.12','application/octet-stream','application/zip'
]);
create policy kardex_backups_read on storage.objects for select to authenticated
 using(bucket_id='respaldos-excel' and (select private.kardex_has_access(false)));
create policy kardex_backups_insert on storage.objects for insert to authenticated
 with check(bucket_id='respaldos-excel' and (select private.kardex_has_access(true))
  and (storage.foldername(name))[1]=(select auth.uid())::text);

create table public.importaciones (
 id uuid primary key default gen_random_uuid(),nombre_archivo text not null,storage_path text not null,sha256 text not null,
 formato text not null,estado text not null default 'preparando' check(estado in('preparando','completada')),
 created_by uuid default auth.uid(),created_at timestamptz not null default now(),completed_at timestamptz,
 requerimientos integer not null default 0,documentos integer not null default 0,resultado jsonb
);
alter table public.importaciones enable row level security;
revoke all on public.importaciones from public,anon;
grant select,insert,update on public.importaciones to authenticated;
create policy importaciones_read on public.importaciones for select to authenticated using((select private.kardex_has_access(true)));
create policy importaciones_insert on public.importaciones for insert to authenticated with check((select private.kardex_has_access(true)));
create policy importaciones_update on public.importaciones for update to authenticated using((select private.kardex_has_access(true))) with check((select private.kardex_has_access(true)));
alter table public.documentos add constraint documentos_importacion_fk foreign key(importacion_id) references public.importaciones(id);

create table public.importacion_lotes (
 importacion_id uuid not null references public.importaciones(id),numero_lote integer not null,
 requerimientos jsonb not null default '[]',documentos jsonb not null default '[]',
 created_at timestamptz not null default now(),primary key(importacion_id,numero_lote)
);
alter table public.importacion_lotes enable row level security;
revoke all on public.importacion_lotes from public,anon;
grant select,insert,update,delete on public.importacion_lotes to authenticated;
create policy import_lotes_read on public.importacion_lotes for select to authenticated using((select private.kardex_has_access(true)));
create policy import_lotes_insert on public.importacion_lotes for insert to authenticated with check((select private.kardex_has_access(true)));
create policy import_lotes_update on public.importacion_lotes for update to authenticated using((select private.kardex_has_access(true))) with check((select private.kardex_has_access(true)));
create policy import_lotes_delete on public.importacion_lotes for delete to authenticated using((select private.kardex_has_access(true)));

create table private.kardex_historial (
 id bigint generated always as identity primary key,tabla text not null,registro_id uuid not null,operacion text not null,
 actor_id uuid,fecha timestamptz not null default now(),importacion_id uuid,antes jsonb,despues jsonb
);
alter table private.kardex_historial enable row level security;
revoke all on private.kardex_historial from public,anon,authenticated;
create function private.kardex_audit() returns trigger language plpgsql security definer set search_path='' as $$
declare before_record jsonb;after_record jsonb;changed_before jsonb;changed_after jsonb;
begin
 if not private.kardex_has_access(false) then raise exception 'Cuenta no autorizada' using errcode='42501'; end if;
 if tg_op<>'INSERT' then before_record=to_jsonb(old)-'busqueda_facturas'-'busqueda_meta'-'updated_at'-'importacion_id';end if;
 if tg_op<>'DELETE' then after_record=to_jsonb(new)-'busqueda_facturas'-'busqueda_meta'-'updated_at'-'importacion_id';end if;
 if tg_op='UPDATE' then
  select coalesce(jsonb_object_agg(o.key,o.value),'{}') into changed_before
   from jsonb_each(before_record) o where o.value is distinct from after_record->o.key;
  if changed_before='{}' then return null;end if;
  select coalesce(jsonb_object_agg(n.key,n.value),'{}') into changed_after
   from jsonb_each(after_record) n where changed_before ? n.key;
 else
  changed_before=before_record;
  changed_after=case when tg_op='INSERT' then jsonb_build_object('id',new.id) else null end;
 end if;
 insert into private.kardex_historial(tabla,registro_id,operacion,actor_id,importacion_id,antes,despues)
 values(tg_table_name,case when tg_op='DELETE' then old.id else new.id end,tg_op,auth.uid(),
 nullif(current_setting('kardex.import_id',true),'')::uuid,
 changed_before,changed_after);
 return null;
end;
$$;
revoke all on function private.kardex_audit() from public,anon,authenticated;
create trigger req_audit after insert or update or delete on public.requerimientos for each row execute function private.kardex_audit();
create trigger doc_audit after insert or update or delete on public.documentos for each row execute function private.kardex_audit();

create function public.kardex_begin_import(archivo_nombre text,archivo_path text,archivo_sha256 text,archivo_formato text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare result uuid;
begin
 if not private.kardex_has_access(true) then raise exception 'Solo el administrador puede importar' using errcode='42501'; end if;
 if not exists(select 1 from storage.objects where bucket_id='respaldos-excel' and name=archivo_path) then
  raise exception 'Debe guardarse el archivo original antes de comenzar la importación'; end if;
 insert into public.importaciones(nombre_archivo,storage_path,sha256,formato)
 values(archivo_nombre,archivo_path,archivo_sha256,archivo_formato) returning id into result;
 return result;
end;
$$;
create function public.kardex_stage_import(import_id uuid,batch_number integer,req_data jsonb,doc_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if not private.kardex_has_access(true) then raise exception 'Solo el administrador puede importar' using errcode='42501'; end if;
 if not exists(select 1 from public.importaciones where id=import_id and estado='preparando') then raise exception 'Importación no disponible'; end if;
 if jsonb_typeof(req_data) is distinct from 'array' or jsonb_typeof(doc_data) is distinct from 'array' then raise exception 'Lote inválido'; end if;
 insert into public.importacion_lotes(importacion_id,numero_lote,requerimientos,documentos) values(import_id,batch_number,req_data,doc_data)
 on conflict(importacion_id,numero_lote) do update set requerimientos=excluded.requerimientos,documentos=excluded.documentos;
 return jsonb_build_object('lote',batch_number,'requerimientos',jsonb_array_length(req_data),'documentos',jsonb_array_length(doc_data));
end;
$$;

create function private.kardex_advance_counters() returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.kardex_has_access(true) then raise exception 'Solo el administrador puede actualizar correlativos' using errcode='42501'; end if;
 update private.kardex_contadores set valor=greatest(valor,coalesce((select max(substring(numero from 5)::bigint) from public.requerimientos),0)) where nombre='req';
 update private.kardex_contadores set valor=greatest(valor,coalesce((select max(substring(kardex from 4)::bigint) from public.documentos),0)) where nombre='doc';
end;
$$;
revoke all on function private.kardex_advance_counters() from public,anon;
grant execute on function private.kardex_advance_counters() to authenticated;

create function public.kardex_commit_import(import_id uuid,expected_batches integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare manifest public.importaciones;req_count integer;doc_count integer;doc_inserted integer;req_inserted integer;result jsonb;
begin
 if not private.kardex_has_access(true) then raise exception 'Solo el administrador puede importar' using errcode='42501'; end if;
 perform pg_catalog.pg_advisory_xact_lock(1170196,1);
 select * into manifest from public.importaciones where id=import_id for update;
 if not found then raise exception 'Importación no encontrada'; end if;
 if manifest.estado='completada' then return manifest.resultado; end if;
 if expected_batches<=0 or (select count(*) from public.importacion_lotes where importacion_id=import_id)<>expected_batches then
  raise exception 'Faltan lotes. No se modificó el inventario'; end if;
 perform set_config('kardex.importing','on',true);perform set_config('kardex.import_id',import_id::text,true);
 select count(*) into req_inserted from public.importacion_lotes l cross join lateral jsonb_to_recordset(l.requerimientos) r(numero text)
 where l.importacion_id=import_id and not exists(select 1 from public.requerimientos old where old.numero=r.numero);
 insert into public.requerimientos(id,numero,tipo,fecha_solicitud,cantidad_cajas,numeros_cargo,fecha_recepcion,fecha_devolucion,usuario)
 select coalesce(old.id,r.id,gen_random_uuid()),r.numero,r.tipo,r.fecha_solicitud,r.cantidad_cajas,coalesce(r.numeros_cargo,''),r.fecha_recepcion,r.fecha_devolucion,r.usuario
 from public.importacion_lotes l cross join lateral jsonb_to_recordset(l.requerimientos) r(
  id uuid,numero text,tipo text,fecha_solicitud date,cantidad_cajas integer,numeros_cargo text,fecha_recepcion date,fecha_devolucion date,usuario text)
 left join public.requerimientos old on old.numero=r.numero where l.importacion_id=import_id
 on conflict(numero) do update set tipo=excluded.tipo,fecha_solicitud=excluded.fecha_solicitud,cantidad_cajas=excluded.cantidad_cajas,
 numeros_cargo=excluded.numeros_cargo,fecha_recepcion=excluded.fecha_recepcion,fecha_devolucion=excluded.fecha_devolucion,usuario=excluded.usuario;
 get diagnostics req_count=row_count;
 if exists(select 1 from public.importacion_lotes l cross join lateral jsonb_to_recordset(l.documentos) d(req_numero text)
  where l.importacion_id=import_id and coalesce(d.req_numero,'')<>'' and not exists(select 1 from public.requerimientos r where r.numero=d.req_numero)) then
  raise exception 'Un documento referencia un requerimiento inexistente. No se modificó el inventario';end if;
 if exists(select 1 from public.importacion_lotes l cross join lateral jsonb_to_recordset(l.documentos) d(id uuid,kardex text,clave_origen text)
  join public.documentos old on old.id=d.id or (nullif(d.kardex,'') is not null and old.kardex=d.kardex)
   or (d.clave_origen is not null and old.clave_origen=d.clave_origen)
  where l.importacion_id=import_id group by d.id,d.kardex,d.clave_origen having count(distinct old.id)>1) then
  raise exception 'Identificadores incompatibles: el ID, Kardex y origen deben señalar el mismo documento';end if;
 select count(*) into doc_inserted from public.importacion_lotes l cross join lateral jsonb_to_recordset(l.documentos) d(id uuid,kardex text,clave_origen text)
 where l.importacion_id=import_id and not exists(select 1 from public.documentos old where old.id=d.id or (d.kardex is not null and old.kardex=d.kardex) or (d.clave_origen is not null and old.clave_origen=d.clave_origen));
 insert into public.documentos(id,kardex,fecha_registro,tipo_doc,periodo,ubicacion,folios,cargos,caja_asignada,f_envio,sustento,sustento_imagen,usuario,facturas,obs,
 clave_origen,hoja_origen,fecha_origen,anio_origen,estado_origen,datos_origen,importacion_id)
 select coalesce(old.id,d.id,gen_random_uuid()),coalesce(old.kardex,nullif(d.kardex,'')),coalesce(old.fecha_registro,d.fecha_registro,(now() at time zone 'America/Lima')::date),
 d.tipo_doc,d.periodo,d.ubicacion,d.folios,coalesce(d.cargos,'{}'),case when coalesce(d.req_numero,'')<>'' then r.id else d.caja_asignada end,
 d.f_envio,coalesce(d.sustento,''),coalesce(d.sustento_imagen,''),coalesce(nullif(d.usuario,''),'Importación Excel'),coalesce(d.facturas,''),coalesce(d.obs,''),
 d.clave_origen,coalesce(d.hoja_origen,''),d.fecha_origen,d.anio_origen,coalesce(d.estado_origen,''),coalesce(d.datos_origen,'{}'),import_id
 from public.importacion_lotes l cross join lateral jsonb_to_recordset(l.documentos) d(
  id uuid,kardex text,fecha_registro date,tipo_doc text,periodo date,ubicacion text,folios integer,cargos text[],caja_asignada uuid,req_numero text,
  f_envio date,sustento text,sustento_imagen text,usuario text,facturas text,obs text,clave_origen text,hoja_origen text,fecha_origen date,
  anio_origen integer,estado_origen text,datos_origen jsonb)
 left join public.documentos old on old.id=d.id or (d.kardex is not null and old.kardex=d.kardex) or (d.clave_origen is not null and old.clave_origen=d.clave_origen)
 left join public.requerimientos r on r.numero=d.req_numero where l.importacion_id=import_id
 on conflict(id) do update set
 tipo_doc=case when manifest.formato='historico' then documentos.tipo_doc else excluded.tipo_doc end,
 periodo=case when manifest.formato='historico' then documentos.periodo else excluded.periodo end,
 ubicacion=case when manifest.formato='historico' then documentos.ubicacion else excluded.ubicacion end,
 folios=coalesce(excluded.folios,documentos.folios),cargos=excluded.cargos,
 caja_asignada=case when manifest.formato='historico' then documentos.caja_asignada else excluded.caja_asignada end,
 f_envio=case when manifest.formato='historico' then documentos.f_envio else excluded.f_envio end,
 sustento=case when manifest.formato='historico' then documentos.sustento else excluded.sustento end,
 sustento_imagen=case when manifest.formato='historico' then documentos.sustento_imagen else excluded.sustento_imagen end,
 usuario=case when manifest.formato='historico' then documentos.usuario else excluded.usuario end,
 facturas=excluded.facturas,obs=case when manifest.formato='historico' then documentos.obs else excluded.obs end,
 clave_origen=coalesce(excluded.clave_origen,documentos.clave_origen),
 hoja_origen=case when excluded.clave_origen is null then documentos.hoja_origen else excluded.hoja_origen end,
 fecha_origen=case when excluded.clave_origen is null then documentos.fecha_origen else excluded.fecha_origen end,
 anio_origen=case when excluded.clave_origen is null then documentos.anio_origen else excluded.anio_origen end,
 estado_origen=case when excluded.clave_origen is null then documentos.estado_origen else excluded.estado_origen end,
 datos_origen=case when excluded.clave_origen is null then documentos.datos_origen else excluded.datos_origen end,
 importacion_id=excluded.importacion_id;
 get diagnostics doc_count=row_count;
 perform private.kardex_advance_counters();
 result=jsonb_build_object('requerimientos',req_count,'documentos',doc_count,'requerimientos_nuevos',req_inserted,'documentos_nuevos',doc_inserted,
 'requerimientos_actualizados',req_count-req_inserted,'documentos_actualizados',doc_count-doc_inserted);
 update public.importaciones set estado='completada',completed_at=now(),requerimientos=req_count,documentos=doc_count,resultado=result where id=import_id;
 delete from public.importacion_lotes where importacion_id=import_id;
 perform set_config('kardex.importing','off',true);perform set_config('kardex.import_id','',true);
 return result;
end;
$$;
revoke all on function public.kardex_begin_import(text,text,text,text),public.kardex_stage_import(uuid,integer,jsonb,jsonb),public.kardex_commit_import(uuid,integer) from public,anon;
grant execute on function public.kardex_begin_import(text,text,text,text),public.kardex_stage_import(uuid,integer,jsonb,jsonb),public.kardex_commit_import(uuid,integer) to authenticated;

-- Send a small invalidation event instead of every invoice and provenance field to each browser.
create table public.kardex_eventos(nombre text primary key,updated_at timestamptz not null default now());
alter table public.kardex_eventos enable row level security;
revoke all on public.kardex_eventos from public,anon,authenticated;
grant select on public.kardex_eventos to authenticated;
create policy kardex_eventos_read on public.kardex_eventos for select to authenticated using((select private.kardex_has_access(false)));
insert into public.kardex_eventos(nombre) values('requerimientos'),('documentos');
create function private.kardex_notify_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not private.kardex_has_access(false) then raise exception 'Cuenta no autorizada' using errcode='42501';end if;
 insert into public.kardex_eventos(nombre) values(tg_table_name)
 on conflict(nombre) do update set updated_at=greatest(clock_timestamp(),kardex_eventos.updated_at+interval '1 microsecond');
 return null;
end;
$$;
revoke all on function private.kardex_notify_change() from public,anon,authenticated;
create trigger req_notify after insert or update or delete on public.requerimientos for each statement execute function private.kardex_notify_change();
create trigger doc_notify after insert or update or delete on public.documentos for each statement execute function private.kardex_notify_change();
alter publication supabase_realtime add table public.kardex_eventos;
