-- Registro del correo de solicitud de cajas. Reutiliza el historial protegido de
-- Requerimientos; no envía emails, no crea Excel y no altera el estado de las cajas.
create or replace function public.kardex_req4_mail(
  p_accion text,
  p_requerimiento uuid,
  p_asunto text default null
) returns jsonb
language plpgsql security definer set search_path='' as $func$
declare
  v_actor uuid := auth.uid();
  v_req public.requerimientos%rowtype;
  v_sent private.req4_movimientos%rowtype;
  v_cfg private.pickup_mail_config%rowtype;
  v_fecha date := (clock_timestamp() at time zone 'America/Lima')::date;
begin
  if v_actor is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo requerido' using errcode='42501';
  end if;
  if p_accion not in ('estado','confirmar') or p_requerimiento is null then
    raise exception 'Acción de correo inválida' using errcode='22023';
  end if;
  select * into v_req from public.requerimientos
    where id=p_requerimiento
      and tipo in ('Cajas nuevas para acondicionar','Préstamo de Cajas (búsqueda de documentos)');
  if not found then
    raise exception 'No existe este requerimiento de cajas' using errcode='22023';
  end if;

  -- La consulta no escribe y puede repetirse al abrir la bandeja.
  if p_accion='estado' then
    select * into v_sent from private.req4_movimientos
      where requerimiento=p_requerimiento and tipo='correo_solicitud_enviado'
      order by registrado desc limit 1;
    return jsonb_build_object(
      'estado',case when v_sent.id is null then 'NO_ENVIADO' else 'ENVIADO' end,
      'enviado_at',v_sent.registrado,'asunto',v_sent.datos->>'asunto'
    );
  end if;

  if p_asunto is null or length(trim(p_asunto)) not between 10 and 190
    or p_asunto ~ '[\r\n\x00-\x1f\x7f]' then
    raise exception 'Asunto de correo inválido' using errcode='22023';
  end if;
  select * into v_cfg from private.pickup_mail_config where id=true;
  if v_cfg.id is null or v_cfg.sender_email='' or
     v_cfg.signature_name='' or v_cfg.signature_company='' then
    raise exception 'Falta la configuración de correo en Aviso de recojo' using errcode='22023';
  end if;

  -- Doble clic u otros administradores: conservar una sola confirmación por
  -- requerimiento. El correo se envía manualmente en Outlook, no por esta función.
  perform pg_advisory_xact_lock(688002,hashtext(p_requerimiento::text));
  select * into v_sent from private.req4_movimientos
    where requerimiento=p_requerimiento and tipo='correo_solicitud_enviado'
    order by registrado desc limit 1;
  if v_sent.id is not null then
    return jsonb_build_object('estado','ENVIADO','enviado_at',v_sent.registrado,
      'asunto',v_sent.datos->>'asunto','ya_registrado',true);
  end if;
  insert into private.req4_movimientos(
    id,requerimiento,tipo,fecha,datos,actor,responsable
  ) values(
    gen_random_uuid(),p_requerimiento,'correo_solicitud_enviado',v_fecha,
    jsonb_build_object(
      'asunto',trim(p_asunto),'remitente',v_cfg.sender_email,
      'destinatarios',array['joramos@farmaciasperuanas.pe',
        'alopezv@farmaciasperuanas.pe','bsalvador@farmaciasperuanas.pe'],
      'copias',array['fp-qs-liquidaciones@intercorpretail.pe'],
      'confirmacion','Declarada manualmente por el administrador; Outlook no fue verificado'
    ),v_actor,'Administrador autenticado'
  ) returning * into v_sent;
  return jsonb_build_object('estado','ENVIADO','enviado_at',v_sent.registrado,
    'asunto',v_sent.datos->>'asunto','ya_registrado',false);
end;$func$;

revoke all on function public.kardex_req4_mail(text,uuid,text) from public,anon;
grant execute on function public.kardex_req4_mail(text,uuid,text) to authenticated;
