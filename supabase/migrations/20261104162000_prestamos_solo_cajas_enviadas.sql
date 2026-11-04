create function private.req4_envio_confirmado(p_clave text) returns boolean
language sql stable strict set search_path='' as $$
  select coalesce(
    -- Una caja en la hoja vigente prevalece sobre un envío anterior del mismo código.
    (select bool_and(l.fecha_envio is not null) from public.im_envios_cargos_live l
     where private.req4_clave(l.codigo_caja)=p_clave),
    not exists (
      select 1 from public.kardex_documentos_resumen v
      where private.req4_clave(v.im_caja_preparada)=p_clave and v.im_codigo_caja is null
    ) and (exists (
      select 1 from public.kardex_documentos_resumen v
      where private.req4_clave(v.im_codigo_caja)=p_clave
        and nullif(to_jsonb(v)->>'im_fecha_envio','') is not null
    ) or exists (
      -- Referencias verificadas de la Preview. Esta tabla queda vacía en producción.
      select 1 from private.req4_referencia_busqueda r
      where private.req4_clave(r.codigo)=p_clave and r.estado='Enviado a Iron Mountain'
    ))
  );
$$;
revoke execute on function private.req4_envio_confirmado(text) from public, anon, authenticated;

create function private.req4_resultados_prestamo(p_query text) returns jsonb
language sql stable security definer set search_path='' as $$
  with resultados as materialized (
    select fila,orden,coalesce(private.req4_envio_confirmado(fila->>'clave'),false) confirmado
    from jsonb_array_elements(private.req4_buscar(p_query)) with ordinality as r(fila,orden)
  )
  select coalesce(jsonb_agg(fila || jsonb_build_object(
    'solicitable',confirmado and fila->>'prestamo' is null,
    'estado',case when not confirmado and fila->>'estado'='Enviado a Iron Mountain'
      then 'Envío a Iron Mountain sin confirmar' else fila->>'estado' end
  ) order by orden),'[]'::jsonb)
  from resultados;
$$;
revoke execute on function private.req4_resultados_prestamo(text) from public, anon;
grant execute on function private.req4_resultados_prestamo(text) to authenticated;

create or replace function public.kardex_req4_buscar(p_query text) returns jsonb
language sql stable set search_path='' as $$
  select private.req4_resultados_prestamo(p_query);
$$;

create function private.req4_validar_envio_prestamo() returns trigger
language plpgsql set search_path='' as $$
begin
  -- La sincronización de envíos usa el bloqueo exclusivo de esta misma clave.
  perform pg_advisory_xact_lock_shared(1170196,3);
  if private.req4_clave(new.codigo) is distinct from new.clave
    or not coalesce(private.req4_envio_confirmado(new.clave),false) then
    raise exception 'Solo puedes solicitar cajas físicas con envío confirmado a Iron Mountain'
      using errcode='23514';
  end if;
  return new;
end;
$$;
revoke execute on function private.req4_validar_envio_prestamo() from public, anon, authenticated;
create trigger req4_caja_enviada before insert or update of codigo,clave on private.req4_cajas
  for each row execute function private.req4_validar_envio_prestamo();
