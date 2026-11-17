-- Consulta para los indicadores del lote. El listado operativo conserva sus filtros.
create function private.acond_envios_lote(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.recepcion_solicitud(p_id);
  return (
    select coalesce(jsonb_agg(to_jsonb(caja) order by caja.clave),'[]'::jsonb)
    from (
      select c.clave,c.codigo,c.requerimiento solicitud,'nueva'::text origen,
        min(l.fecha_preparacion) preparada,max(l.fecha_envio) enviada,
        min(nullif(trim(l.responsable_preparacion),'')) responsable,
        array_agg(distinct l.codigo_cargo order by l.codigo_cargo) cargos
      from private.recepcion_cajas c
      join public.requerimientos r on r.id=c.requerimiento
      join public.im_envios_cargos_live l on private.acond_clave(l.codigo_caja)=c.clave
      where c.requerimiento=p_id and c.guardado is not null
        and l.fecha_envio between r.fecha_solicitud and (now() at time zone 'America/Lima')::date
        and lower(trim(l.clasificacion_caja))='cajas nuevas'
        and nullif(trim(l.codigo_cargo),'') is not null
      group by c.clave,c.codigo,c.requerimiento
    ) caja
  );
end;
$$;

create function public.kardex_acond_envios_lote(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
  select private.acond_envios_lote(p_id)
$$;
revoke all on function private.acond_envios_lote(uuid),
  public.kardex_acond_envios_lote(uuid) from public,anon,authenticated;
grant execute on function private.acond_envios_lote(uuid),
  public.kardex_acond_envios_lote(uuid) to authenticated;

-- El disparador existente conserva el bloqueo transaccional y comprueba el cierre de la recepción.
create or replace function private.req4_limitar_suministro() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.tipo<>'Cajas nuevas para acondicionar' or coalesce(new.cantidad_cajas,0)=0 then return new; end if;
  if tg_op='UPDATE' then
    if old.tipo=new.tipo and new.cantidad_cajas<=old.cantidad_cajas then return new; end if;
  end if;
  perform pg_advisory_xact_lock(1170196,1);
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores' using errcode='42501';
  end if;
  if exists(
    select 1 from public.requerimientos r
    where r.tipo='Cajas nuevas para acondicionar' and r.cantidad_cajas>0
      and (not exists(select 1 from private.recepcion_maestro_prueba) or r.solicitante_v4=auth.uid())
      and (
        r.fecha_recepcion is null or r.estado_v4 is distinct from 'Recibido'
        or r.recibido_v4 is distinct from r.cantidad_cajas
        or (select count(*) from private.recepcion_cajas c
            where c.requerimiento=r.id and c.guardado is not null) <> r.cantidad_cajas
        or not exists(select 1 from private.req4_movimientos m
            where m.requerimiento=r.id and m.tipo='recepcion_completa')
      )
  ) then
    raise exception 'No se pueden solicitar más cajas a Iron Mountain'
      using errcode='23514',hint='req4_suministro_pendiente';
  end if;
  return new;
end;
$$;
