-- KPI anual: preparación documentada y envíos históricos sin fecha de preparación.
-- No modifica los registros ni infiere fechas de acondicionamiento.
CREATE OR REPLACE FUNCTION public.kardex_conditioned_boxes_historical()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  resultado jsonb;
  hoy date := (now() at time zone 'America/Lima')::date;
begin
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores pueden consultar el KPI histórico de acondicionamiento'
      using errcode='42501';
  end if;
  with fuente as (
    select regexp_replace(coalesce(l.codigo_caja,''),'[^0-9]','','g') clave,
      l.codigo_caja codigo, l.fecha_preparacion preparada,
      l.fecha_envio enviada, l.clasificacion_caja clasificacion,
      l.updated_at
    from public.im_envios_cargos_live l
    where l.fecha_preparacion between date '2020-01-01' and hoy
  ), consolidadas as (
    select clave, (array_agg(codigo order by updated_at desc))[1] codigo,
      min(preparada) preparada, max(enviada) enviada,
      (array_agg(clasificacion order by updated_at desc))[1] clasificacion
    from fuente where clave<>'' group by clave
  ), verificadas as (
    select distinct extract(year from preparada)::integer anio, clave
      from consolidadas
    union
    select distinct extract(year from m.preparada)::integer,
      regexp_replace(coalesce(m.clave,''),'[^0-9]','','g')
      from private.acond_movimientos m where m.preparada is not null
    union
    select distinct extract(year from p.preparada)::integer,
      regexp_replace(coalesce(p.clave,''),'[^0-9]','','g')
      from private.acond_maestro_preparadas p where p.preparada is not null
    union
    select distinct extract(year from (b.finished_at at time zone 'America/Lima')::date)::integer,
      regexp_replace(coalesce(b.code,''),'[^0-9]','','g')
      from private.box_conditioning b where b.status='LISTA' and b.finished_at is not null
  ), envios_historicos as (
    select distinct extract(year from h.envio)::integer anio,
      regexp_replace(coalesce(h.clave,''),'[^0-9]','','g') clave
    from private.acond_historia_fuente h
    where h.envio between date '2020-01-01' and hoy
  ), sin_fecha_preparacion as (
    select h.anio, count(*)::integer cajas
    from envios_historicos h
    where h.clave<>'' and not exists (
      select 1 from verificadas v where v.anio=h.anio and v.clave=h.clave
    )
    group by h.anio
  )
  select jsonb_build_object(
    'listado',coalesce((
      select jsonb_agg(jsonb_build_object(
        'codigo',c.codigo,'preparada',c.preparada,'enviada',c.enviada,
        'origen',case when upper(coalesce(c.clasificacion,'')) like '%SOLICITUD%'
          then 'solicitada' else 'nueva' end,
        'fuente','maestro_im'
      ) order by c.preparada,c.clave)
      from consolidadas c
    ),'[]'::jsonb),
    'historicos',coalesce((
      select jsonb_agg(jsonb_build_object('anio',s.anio,'cajas',s.cajas)
        order by s.anio) from sin_fecha_preparacion s
    ),'[]'::jsonb)
  ) into resultado;
  return resultado;
end
$function$

revoke all on function public.kardex_conditioned_boxes_historical() from public, anon;
grant execute on function public.kardex_conditioned_boxes_historical() to authenticated;
