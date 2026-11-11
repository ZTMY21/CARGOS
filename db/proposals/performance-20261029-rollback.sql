-- Revert only the proposed definitions, after approval. No record changes.
begin;
create or replace view public.kardex_documentos_resumen as
 SELECT d.id,
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
    d.sustento_imagen <> ''::text AS tiene_sustento_imagen,
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
   FROM public.documentos d
     LEFT JOIN private.im_envios_confirmados m ON m.documento_id = d.id
     LEFT JOIN private.im_cajas_preparadas p ON p.documento_id = d.id
     LEFT JOIN LATERAL ( SELECT l.codigo_caja,
            l.clasificacion_caja,
            l.fecha_envio
           FROM public.im_envios_cargos_live l
          WHERE (l.codigo_cargo = ANY (d.cargos)) OR length(l.codigo_cargo) <= 3 AND regexp_replace(upper(l.codigo_cargo), '^0+(?=[0-9])'::text, ''::text, 'g'::text) = regexp_replace(upper(d.cargos[1]), '^0+(?=[0-9])'::text, ''::text, 'g'::text)
          ORDER BY (l.fecha_envio IS NULL) DESC, l.updated_at DESC
         LIMIT 1) live ON true;
CREATE OR REPLACE FUNCTION public.kardex_previous_cargos(p_documento_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
    count(distinct m.code) as facturas_repetidas,
    array_agg(distinct m.code order by m.code) as codigos
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
      'coincidencias',facturas_repetidas,'codigos',codigos)
      order by anio desc nulls last,ultima_fecha desc nulls last,cargo desc) as items
  from grouped group by current_id
)
select coalesce(jsonb_object_agg(r.id::text,coalesce(p.items,'[]'::jsonb)),'{}'::jsonb)
from requested r left join prior p on p.current_id=r.id;
$function$;

commit;
