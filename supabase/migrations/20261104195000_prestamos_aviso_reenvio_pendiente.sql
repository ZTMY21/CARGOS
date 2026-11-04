create or replace function private.req4_validar_envio_prestamo() returns trigger
language plpgsql set search_path='' as $$
begin
  perform pg_advisory_xact_lock_shared(1170196,3);
  if private.req4_clave(new.codigo) is distinct from new.clave then
    raise exception 'La caja % no tiene un código físico válido.',new.codigo using errcode='23514';
  end if;
  if not coalesce(private.req4_envio_confirmado(new.clave),false) then
    if exists (
      select 1 from public.im_envios_cargos_live l
      where private.req4_clave(l.codigo_caja)=new.clave and l.fecha_envio is null
        and coalesce(l.clasificacion_caja,'') ~* 'por[[:space:]]+solicitud'
    ) then
      raise exception 'La caja % figura «Por solicitud» en la hoja de envíos y le falta la fecha de reenvío a Iron Mountain.',new.codigo
        using errcode='23514', detail=new.clave, hint='req4_envio_pendiente';
    end if;
    raise exception 'La caja % no tiene un envío vigente confirmado a Iron Mountain.',new.codigo
      using errcode='23514', detail=new.clave, hint='req4_envio_pendiente';
  end if;
  return new;
end;
$$;
