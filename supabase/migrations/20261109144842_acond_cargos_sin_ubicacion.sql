-- Los cargos importados sin ubicación no están enviados por ese solo hecho.
-- Conservar todas las restricciones de asignación, envío, histórico y concurrencia.
create or replace function private.acond_cargo(p_cargo text,p_anio integer,p_clave text,p_solicitud uuid)
returns jsonb language sql stable set search_path='' as $$
  with matches as (
    select d.id,c.cargo,
      (nullif(btrim(d.ubicacion),'') is null
        or regexp_replace(lower(d.ubicacion),'[^a-z]','','g') in ('santaanita','cdsantaanita'))
      and d.caja_asignada is null and v.im_codigo_caja is null and v.im_caja_preparada is null
      and v.im_live_codigo_caja is null and v.im_historical_decision is distinct from 'historico'
      and d.f_envio is null disponible
    from public.documentos d join public.kardex_documentos_resumen v on v.id=d.id
    cross join lateral unnest(d.cargos) c(cargo)
    where coalesce(extract(year from d.fecha_origen)::int,d.anio_origen,extract(year from d.periodo)::int)=p_anio
      and private.acond_cargo_clave(c.cargo)=private.acond_cargo_clave(p_cargo)
  ), candidates as (
    select *, not exists(
      select 1 from private.acond_movimientos m where m.origen='nueva'
        and (m.clave,m.solicitud) is distinct from (p_clave,p_solicitud)
        and p_anio=any(m.anios)
        and private.acond_cargo_clave(p_cargo)=any(private.acond_cargos_claves(m.cargos))
    ) libre from matches
  )
  select jsonb_build_object('status',case when count(*)=0 then 'inexistente'
    when count(distinct id)>1 then 'ambiguo' when bool_or(disponible and libre) then 'disponible'
    else 'no_disponible' end,
    'codigo',coalesce(min(cargo) filter(where cargo=p_cargo),min(cargo)))
  from candidates
$$;

