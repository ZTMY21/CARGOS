-- PROPOSAL ONLY. Do not execute against the shared project without approval.
-- No data writes, grants, RLS changes, timeout changes, or new indexes.
-- Keep the existing owner, ACLs and security behavior of the summary view.
begin;
create or replace view public.kardex_documentos_resumen as
with
confirmed as materialized (select * from private.im_envios_confirmados),
prepared as materialized (select * from private.im_cajas_preparadas),
live_source as materialized (
  select l.*,regexp_replace(upper(l.codigo_cargo),'^0+(?=[0-9])','','g') as normalized_cargo
  from public.im_envios_cargos_live l
),
docs as materialized (
  select d.id,d.kardex,d.fecha_registro,d.tipo_doc,d.periodo,d.ubicacion,d.folios,d.cargos,d.caja_asignada,d.f_envio,d.sustento,d.usuario,d.obs,d.created_at,d.updated_at,d.clave_origen,d.hoja_origen,d.fecha_origen,d.anio_origen,d.estado_origen,d.importacion_id,d.cantidad_facturas,
    d.sustento_imagen <> ''::text as tiene_sustento_imagen,regexp_replace(upper(d.cargos[1]),'^0+(?=[0-9])','','g') as normalized_first_cargo
  from public.documentos d
)
select d.id,
    d.kardex,
    d.fecha_registro,
    d.tipo_doc,
    d.periodo,
    d.ubicacion,
    d.folios,
    d.cargos,
    d.caja_asignada,
    d.f_envio,
    d.sustento,
    d.usuario,
    d.obs,
    d.created_at,
    d.updated_at,
    d.clave_origen,
    d.hoja_origen,
    d.fecha_origen,
    d.anio_origen,
    d.estado_origen,
    d.importacion_id,
    d.tiene_sustento_imagen,
    d.cantidad_facturas,
    m.codigo_caja AS im_codigo_caja,
    m.fecha_envio AS im_fecha_envio,
    m.responsable AS im_responsable,
    m.documento_id IS NOT NULL AS im_confirmado,
    p.documento_id IS NOT NULL AND m.documento_id IS NULL AS im_preparado,
    p.codigo_caja AS im_caja_preparada,
    p.responsable AS im_responsable_preparacion,
    live.codigo_caja AS im_live_codigo_caja,
    live.clasificacion_caja AS im_live_clasificacion,
    live.fecha_envio AS im_live_fecha_envio
from docs d
left join confirmed m on m.documento_id=d.id
left join prepared p on p.documento_id=d.id
left join lateral (
  select l.codigo_caja,l.clasificacion_caja,l.fecha_envio
  from live_source l
  where l.codigo_cargo=any(d.cargos)
    or length(l.codigo_cargo)<=3 and l.normalized_cargo=d.normalized_first_cargo
  order by (l.fecha_envio is null) desc,l.updated_at desc
  limit 1
) live on true;

-- Preserve the existing function-local planner setting of kardex_snapshot.
-- Materialize the RLS-protected catalog once, then hash-join exact codes.
-- Reading the protected table once also prevents repeated RLS subplans inside
-- invoice-token lookup loops. No privilege escalation or policy changes.
create or replace function public.kardex_previous_cargos(p_documento_ids uuid[])
returns jsonb
language sql stable security invoker
set search_path = ''
as $function$
with catalog as materialized (
  select d.id,d.kardex,d.cargos,d.busqueda_facturas,
    coalesce(d.anio_origen,extract(year from d.fecha_origen)::integer,
      extract(year from d.fecha_registro)::integer) as year_cargo,
    coalesce(d.fecha_origen,d.fecha_registro) as date_cargo
  from public.documentos d
  where (select private.kardex_has_access(false))
),
requested as materialized (
  select d.id, d.kardex,
    d.year_cargo,d.date_cargo,
    d.busqueda_facturas
  from catalog d
  where d.id=any(p_documento_ids)
    and coalesce(cardinality(p_documento_ids),0) between 1 and 100
    and (select private.kardex_has_access(false))
),
codes as materialized (
  select distinct r.id, t.code
  from requested r
  cross join lateral pg_catalog.unnest(pg_catalog.string_to_array(r.busqueda_facturas,',')) t(code)
  where length(t.code)>=7 and t.code ~ '[0-9]'
),
catalog_codes as (
  select p.id as previous_id,
    pg_catalog.unnest(pg_catalog.string_to_array(p.busqueda_facturas,',')) as code
  from catalog p
),
code_matches as materialized (
  select c.id as current_id, pc.previous_id,c.code
  from catalog_codes pc
  join codes c on c.code=pc.code and pc.previous_id<>c.id
),
matched as (
  select m.*
  from code_matches m
  join requested r on r.id=m.current_id
  join catalog p on p.id=m.previous_id
  where (
      p.year_cargo,
      p.date_cargo,p.kardex
    ) < (r.year_cargo,r.date_cargo,r.kardex)
),
grouped as (
  select m.current_id, older_code.cargo as cargo,
    p.year_cargo as anio,
    max(p.date_cargo) as ultima_fecha,
    count(distinct m.code) as facturas_repetidas,
    array_agg(distinct m.code order by m.code) as codigos
  from matched m
  join catalog p on p.id=m.previous_id
  cross join lateral pg_catalog.unnest(p.cargos) older_code(cargo)
  where nullif(pg_catalog.btrim(older_code.cargo),'') is not null
  group by m.current_id,older_code.cargo,
    p.year_cargo
),
prior as (
  select current_id,
    jsonb_agg(jsonb_build_object('cargo',cargo,'anio',anio,
      'coincidencias',facturas_repetidas,'codigos',codigos)
      order by anio desc nulls last,ultima_fecha desc nulls last,cargo desc) as items
  from grouped group by current_id
)
select coalesce(jsonb_object_agg(r.id::text,coalesce(p.items,'[]'::jsonb)),'{}'::jsonb)
from requested r left join prior p on p.current_id=r.id;
$function$;
commit;
