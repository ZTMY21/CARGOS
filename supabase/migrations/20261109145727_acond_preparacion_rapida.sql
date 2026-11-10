-- Consultar únicamente los cargos de la preparación; la vista global de envíos tarda más que el límite de la API.
-- Los cargos importados sin ubicación no están enviados por ese solo hecho.
-- Conservar todas las restricciones de asignación, envío, histórico y concurrencia.
create or replace function private.acond_cargo(p_cargo text,p_anio integer,p_clave text,p_solicitud uuid)
returns jsonb language sql stable set search_path='' as $$
  with matches as (
    select d.id,c.cargo,
      (nullif(btrim(d.ubicacion),'') is null
        or regexp_replace(lower(d.ubicacion),'[^a-z]','','g') in ('santaanita','cdsantaanita'))
      and d.caja_asignada is null and d.f_envio is null
      and not exists (select 1 from public.im_envios_cargos h
        where private.acond_cargo_clave(h.codigo_cargo)=private.acond_cargo_clave(c.cargo))
      and not exists (select 1 from public.im_envios_cargos_live l
        where private.acond_cargo_clave(l.codigo_cargo)=private.acond_cargo_clave(c.cargo)
          and (l.fecha_envio is not null or l.fecha_preparacion is not null))
      and not exists (select 1 from private.kardex_im_historical_audit h
        where h.documento_id=d.id and h.revoked_at is null and h.decision='historico') disponible
    from public.documentos d
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
