-- Una solicitud de cajas nuevas permanece abierta hasta acreditar el envío
-- de sus cajas físicas. La recepción, por sí sola, no cierra el suministro.
create function private.req4_suministro_estado() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare resultado jsonb;
begin
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores' using errcode='42501';
  end if;
  with solicitudes as materialized (
    select r.id,r.numero,r.fecha_solicitud,r.cantidad_cajas
    from public.requerimientos r
    where r.tipo='Cajas nuevas para acondicionar' and r.cantidad_cajas>0
  ), relaciones as materialized (
    select distinct r.id,private.req4_clave(v.im_live_codigo_caja) clave
    from solicitudes r
    join public.documentos d on d.caja_asignada=r.id
    join public.kardex_documentos_resumen v on v.id=d.id
    where private.req4_clave(v.im_live_codigo_caja) is not null
  ), propietarios as (
    select clave from relaciones group by clave having count(distinct id)=1
  ), envios as (
    select rel.id,count(*)::integer cantidad
    from relaciones rel
    join propietarios p on p.clave=rel.clave
    join solicitudes r on r.id=rel.id
    where exists (
      select 1 from public.im_envios_cargos_live l
      where private.req4_clave(l.codigo_caja)=rel.clave
    ) and not exists (
      select 1 from public.im_envios_cargos_live l
      where private.req4_clave(l.codigo_caja)=rel.clave
        and (l.fecha_envio is null or l.fecha_envio<r.fecha_solicitud
          or l.fecha_envio>(now() at time zone 'America/Lima')::date)
    )
    group by rel.id
  ), detalle as (
    select r.id,r.numero,r.cantidad_cajas solicitadas,
      least(r.cantidad_cajas,coalesce(e.cantidad,0)) enviadas,
      greatest(0,r.cantidad_cajas-coalesce(e.cantidad,0)) pendientes
    from solicitudes r left join envios e on e.id=r.id
  )
  select jsonb_build_object(
    'bloqueado',coalesce(bool_or(pendientes>0),false),
    'solicitadas',coalesce(sum(solicitadas),0),
    'enviadas',coalesce(sum(enviadas),0),
    'pendientes',coalesce(sum(pendientes),0),
    'solicitudes',coalesce(jsonb_agg(to_jsonb(detalle) order by numero),'[]'::jsonb)
  ) into resultado from detalle;
  return resultado;
end;
$$;
revoke all on function private.req4_suministro_estado() from public,anon,authenticated;

create function private.req4_limitar_suministro() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.tipo<>'Cajas nuevas para acondicionar' or coalesce(new.cantidad_cajas,0)=0 then return new; end if;
  if tg_op='UPDATE' then
    if old.tipo=new.tipo and new.cantidad_cajas<=old.cantidad_cajas then return new; end if;
  end if;
  -- Usa la misma exclusión que las solicitudes y las asignaciones de documentos.
  perform pg_advisory_xact_lock(1170196,1);
  if (private.req4_suministro_estado()->>'bloqueado')::boolean then
    raise exception 'No se pueden solicitar más cajas a Iron Mountain'
      using errcode='23514',hint='req4_suministro_pendiente';
  end if;
  return new;
end;
$$;
revoke all on function private.req4_limitar_suministro() from public,anon,authenticated;
create trigger req4_limitar_suministro before insert or update of tipo,cantidad_cajas
  on public.requerimientos for each row execute function private.req4_limitar_suministro();

create or replace function private.req4_detalle() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores' using errcode='42501';
  end if;
  return jsonb_build_object(
    'cajas',coalesce((
      select jsonb_agg(to_jsonb(c) || jsonb_build_object('cargos',private.req4_cargos_unicos(c.cargos)) order by c.codigo)
      from private.req4_cajas c
    ),'[]'::jsonb),
    'movimientos',coalesce((select jsonb_agg(m order by m.registrado) from private.req4_movimientos m),'[]'::jsonb),
    'suministro',private.req4_suministro_estado()
  );
end;
$$;
