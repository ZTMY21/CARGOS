-- La recepción productiva se habilita después de comprobar Drive con un archivo temporal.
create table private.recepcion_maestro_produccion (
  id boolean primary key default true check (id),
  secreto_hash bytea not null,
  habilitada boolean not null default false
);
create table private.im_master_write_lock (
  id boolean primary key default true check (id),
  token uuid not null,
  actor uuid not null,
  hasta timestamptz not null
);
alter table private.recepcion_maestro_produccion enable row level security;
alter table private.im_master_write_lock enable row level security;
revoke all on private.recepcion_maestro_produccion,private.im_master_write_lock from public,anon,authenticated;

create function private.im_master_lock(p_accion text,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tomado uuid; solicitante uuid:=auth.uid();
begin
  if solicitante is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores' using errcode='42501';
  end if;
  if p_accion='tomar' then
    insert into private.im_master_write_lock(id,token,actor,hasta)
    values(true,gen_random_uuid(),solicitante,clock_timestamp()+interval '90 seconds')
    on conflict (id) do update set token=excluded.token,actor=excluded.actor,hasta=excluded.hasta
      where im_master_write_lock.hasta<=clock_timestamp()
    returning token into tomado;
    return jsonb_build_object('token',tomado);
  end if;
  if p_accion='liberar' then
    delete from private.im_master_write_lock where id and token=p_token and actor=solicitante;
    return jsonb_build_object('liberado',found);
  end if;
  raise exception 'Operación inválida';
end;
$$;

create function private.recepcion_produccion_excel(
  p_accion text,p_id uuid,p_secreto text,p_token uuid,p_revision text,p_filas jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  r public.requerimientos; filas integer; esperadas integer; pendientes integer;
  actual timestamptz; hoy date;
begin
  perform pg_advisory_xact_lock(1170196,1);
  actual:=clock_timestamp();
  hoy:=(actual at time zone 'America/Lima')::date;
  r:=private.recepcion_solicitud(p_id);
  if not exists(select 1 from private.recepcion_maestro_produccion where id and habilitada
      and secreto_hash=sha256(convert_to(coalesce(p_secreto,''),'UTF8'))) then
    raise exception 'El guardado de recepción aún no está habilitado' using errcode='42501';
  end if;
  if not exists(select 1 from private.im_master_write_lock where id and token=p_token
      and actor=auth.uid() and hasta>actual) then
    raise exception 'La reserva del Excel venció. Reintenta.' using errcode='40001';
  end if;
  if p_accion='estado' then return private.recepcion_estado(r.id); end if;
  if p_accion not in ('parcial','completa') or p_accion is null
      or coalesce(length(p_revision),0) not between 1 and 256
      or jsonb_typeof(p_filas) is distinct from 'object' then raise exception 'Conciliación inválida'; end if;
  if r.fecha_recepcion is not null then return private.recepcion_estado(r.id); end if;

  select count(*),count(*) filter(where guardado is null) into esperadas,pendientes
    from private.recepcion_cajas where requerimiento=r.id;
  if esperadas=0 or (p_accion='completa' and esperadas<>r.cantidad_cajas) then
    raise exception 'La cantidad registrada aún no permite esta operación';
  end if;
  select count(*) into filas from jsonb_each(p_filas);
  if filas>pendientes or (p_accion='completa' and filas<>pendientes) or exists(
    select 1 from jsonb_each_text(p_filas) f
    left join private.recepcion_cajas c on c.clave=f.key and c.requerimiento=r.id
    where c.clave is null or c.guardado is not null or f.value !~ '^[1-9][0-9]{0,8}$'
  ) then raise exception 'Las cajas cambiaron. Reintenta el guardado.' using errcode='40001'; end if;
  if filas=0 and p_accion='parcial' then return private.recepcion_estado(r.id); end if;

  update private.recepcion_cajas c set guardado=actual,correlativo=(p_filas->>c.clave)::integer
    where c.requerimiento=r.id and p_filas ? c.clave;
  perform set_config('kardex.recepcion_verificada','true',true);
  update public.requerimientos set recibido_v4=esperadas-pendientes+filas,
    estado_v4=case when p_accion='completa' then 'Recibido' else 'Recibido parcialmente' end,
    fecha_recepcion=case when p_accion='completa' then hoy end
    where id=r.id;
  perform set_config('kardex.recepcion_verificada','false',true);
  insert into private.req4_movimientos(id,requerimiento,tipo,fecha,datos,actor,responsable,registrado,revision_excel)
  values(gen_random_uuid(),r.id,case when p_accion='completa' then 'recepcion_completa' else 'recepcion_parcial' end,
    hoy,jsonb_build_object('cantidad',esperadas-pendientes+filas,'nuevas',filas),auth.uid(),
    (select coalesce(nullif(raw_user_meta_data->>'kardex_username',''),email) from auth.users where id=auth.uid()),
    actual,p_revision);
  return private.recepcion_estado(r.id);
end;
$$;

-- Conservar la validación de lecturas de Preview y habilitar las lecturas reales por separado.
do $$
declare
  definition text:=pg_get_functiondef('private.recepcion_operacion(text,uuid,text)'::regprocedure);
  anchor text:='if not exists(select 1 from private.recepcion_maestro_prueba) then';
begin
  if position(anchor in definition)=0 then raise exception 'Versión de recepción no reconocida'; end if;
  execute replace(definition,anchor,
    'if not exists(select 1 from private.recepcion_maestro_prueba) and not exists(select 1 from private.recepcion_maestro_produccion where id and habilitada) then');
end;
$$;

-- Las cajas ya preparadas en el Maestro se verifican contra sus relaciones reales.
do $$
declare
  definition text:=pg_get_functiondef('private.req4_suministro_estado()'::regprocedure);
  anchor text:=$p$count(*) filter(where c.guardado is not null and b.status='LISTA' and cardinality(b.cargos)>0
        and b.classification='Cajas Nuevas' and b.finished_at>=c.leido)::integer listas$p$;
begin
  if position(anchor in definition)=0 then raise exception 'Versión de suministro no reconocida'; end if;
  execute replace(definition,anchor,$p$count(*) filter(where c.guardado is not null and (
      (b.status='LISTA' and cardinality(b.cargos)>0 and b.classification='Cajas Nuevas' and b.finished_at>=c.leido)
      or (c.origen='maestro' and exists(select 1 from private.recepcion_maestro_produccion where id and habilitada)
        and exists(select 1 from public.im_envios_cargos_live l
          where private.req4_clave_suministro(l.codigo_caja)=c.clave
            and l.fecha_preparacion is not null and lower(trim(l.clasificacion_caja))='cajas nuevas'
            and nullif(trim(l.codigo_cargo),'') is not null))
    ))::integer listas$p$);
end;
$$;

create function public.kardex_im_master_lock(p_accion text,p_token uuid)
returns jsonb language sql set search_path='' as $$
  select private.im_master_lock(p_accion,p_token);
$$;
create function public.kardex_recepcion_produccion_excel(
  p_accion text,p_id uuid,p_secreto text,p_token uuid,p_revision text,p_filas jsonb
) returns jsonb language sql set search_path='' as $$
  select private.recepcion_produccion_excel(p_accion,p_id,p_secreto,p_token,p_revision,p_filas);
$$;
revoke all on function private.im_master_lock(text,uuid),public.kardex_im_master_lock(text,uuid),
  private.recepcion_produccion_excel(text,uuid,text,uuid,text,jsonb),
  public.kardex_recepcion_produccion_excel(text,uuid,text,uuid,text,jsonb) from public,anon;
grant execute on function private.im_master_lock(text,uuid),public.kardex_im_master_lock(text,uuid),
  private.recepcion_produccion_excel(text,uuid,text,uuid,text,jsonb),
  public.kardex_recepcion_produccion_excel(text,uuid,text,uuid,text,jsonb) to authenticated;
