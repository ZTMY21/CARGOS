-- Consultar cargos previos por coincidencia exacta de factura, boleta o guia.
-- El indice usa los codigos ya normalizados que actualizan los triggers existentes.
create index if not exists documentos_facturas_codigos_exactos_idx
  on public.documentos using gin (pg_catalog.string_to_array(busqueda_facturas, ','));

create or replace function public.kardex_previous_cargos(p_documento_ids uuid[])
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
with requested as materialized (
  select d.id, d.kardex,
    coalesce(d.anio_origen, extract(year from d.fecha_origen)::integer,
      extract(year from d.fecha_registro)::integer) as year_cargo,
    coalesce(d.fecha_origen,d.fecha_registro) as date_cargo,
    d.busqueda_facturas
  from public.documentos d
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
matched as (
  select c.id as current_id, p.id as previous_id, c.code
  from codes c
  join requested r on r.id=c.id
  join public.documentos p on
    pg_catalog.string_to_array(p.busqueda_facturas,',') @> array[c.code]
  where p.id<>r.id
    and (
      coalesce(p.anio_origen,extract(year from p.fecha_origen)::integer,
        extract(year from p.fecha_registro)::integer),
      coalesce(p.fecha_origen,p.fecha_registro),p.kardex
    ) < (r.year_cargo,r.date_cargo,r.kardex)
),
grouped as (
  select m.current_id, older_code.cargo as cargo,
    coalesce(p.anio_origen,extract(year from p.fecha_origen)::integer,
      extract(year from p.fecha_registro)::integer) as anio,
    max(coalesce(p.fecha_origen,p.fecha_registro)) as ultima_fecha,
    count(distinct m.code) as facturas_repetidas
  from matched m
  join public.documentos p on p.id=m.previous_id
  cross join lateral pg_catalog.unnest(p.cargos) older_code(cargo)
  where nullif(pg_catalog.btrim(older_code.cargo),'') is not null
  group by m.current_id,older_code.cargo,
    coalesce(p.anio_origen,extract(year from p.fecha_origen)::integer,
      extract(year from p.fecha_registro)::integer)
),
prior as (
  select current_id,
    jsonb_agg(jsonb_build_object('cargo',cargo,'anio',anio,
      'coincidencias',facturas_repetidas)
      order by anio desc nulls last,ultima_fecha desc nulls last,cargo desc) as items
  from grouped group by current_id
)
select coalesce(jsonb_object_agg(r.id::text,coalesce(p.items,'[]'::jsonb)),'{}'::jsonb)
from requested r left join prior p on p.current_id=r.id;
$$;

revoke all on function public.kardex_previous_cargos(uuid[]) from public,anon;
grant execute on function public.kardex_previous_cargos(uuid[]) to authenticated;
