-- Recepciones físicas. El código de caja tiene un solo propietario.
create table private.recepcion_cajas (
  clave text primary key check (clave ~ '^[0-9]{10}$'),
  codigo text not null,
  requerimiento uuid not null references public.requerimientos(id),
  operador uuid not null,
  leido timestamptz not null default clock_timestamp(),
  guardado timestamptz,
  correlativo integer unique check (correlativo > 0),
  check ((guardado is null) = (correlativo is null))
);
create index recepcion_cajas_req on private.recepcion_cajas(requerimiento,leido);
alter table private.recepcion_cajas enable row level security;
revoke all on private.recepcion_cajas from public,anon,authenticated;

-- Solo el entorno de pruebas tiene un registro aquí. Se inicializa fuera de la migración.
create table private.recepcion_maestro_prueba (
  id boolean primary key default true check (id),
  archivo bytea not null check (octet_length(archivo) between 1 and 1048576),
  secreto_hash bytea not null,
  revision integer not null default 0,
  codigos jsonb not null
);
alter table private.recepcion_maestro_prueba enable row level security;
revoke all on private.recepcion_maestro_prueba from public,anon,authenticated;

create function private.recepcion_solicitud(p_id uuid) returns public.requerimientos
language plpgsql stable security definer set search_path='' as $$
declare r public.requerimientos;
begin
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores' using errcode='42501';
  end if;
  select * into r from public.requerimientos where id=p_id
    and tipo='Cajas nuevas para acondicionar' and cantidad_cajas between 1 and 100;
  if not found or r.solicitante_v4 is distinct from auth.uid() then
    raise exception 'Esta solicitud pertenece a otro administrador' using errcode='42501';
  end if;
  return r;
end;
$$;

create function private.recepcion_estado(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',r.id,'numero',r.numero,'cantidad',r.cantidad_cajas,'solicitante',r.usuario,
    'creada',r.created_at,'confirmada',(
      select m.registrado from private.req4_movimientos m
      where m.requerimiento=r.id and m.tipo='recepcion_completa' order by m.registrado limit 1
    ),
    'lecturas',coalesce((
      select jsonb_agg(jsonb_build_object('clave',c.clave,'codigo',c.codigo,'leido',c.leido,
        'guardado',c.guardado,'correlativo',c.correlativo,'operador',c.operador) order by c.leido,c.clave)
      from private.recepcion_cajas c where c.requerimiento=r.id
    ),'[]'::jsonb))
  from public.requerimientos r where r.id=p_id;
$$;

create function private.recepcion_operacion(p_accion text,p_id uuid,p_codigo text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requerimientos; clave_caja text; existe private.recepcion_cajas;
begin
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores' using errcode='42501';
  end if;
  if p_accion='estado' then
    if p_id is null then
      select id into p_id from public.requerimientos
      where tipo='Cajas nuevas para acondicionar' and solicitante_v4=auth.uid()
        and cantidad_cajas between 1 and 100 and (fecha_recepcion is null or exists(
          select 1 from private.recepcion_cajas c where c.requerimiento=requerimientos.id))
      order by (fecha_recepcion is null) desc, created_at desc limit 1;
    end if;
    if p_id is null then return null; end if;
    perform private.recepcion_solicitud(p_id);
    return private.recepcion_estado(p_id);
  end if;
  if p_accion is distinct from 'leer' then raise exception 'Acción inválida'; end if;
  perform pg_advisory_xact_lock(1170196,1);
  r:=private.recepcion_solicitud(p_id);
  if not exists(select 1 from private.recepcion_maestro_prueba) then
    raise exception 'Recepción de prueba deshabilitada';
  end if;
  if r.fecha_recepcion is not null then raise exception 'La recepción ya está cerrada'; end if;
  if p_codigo is null or p_codigo !~ '^(TD|T|P)?[0-9]{10}$' then
    raise exception 'Código incompleto o inválido. Se esperan diez dígitos y un prefijo opcional T, TD o P';
  end if;
  clave_caja:=regexp_replace(p_codigo,'[^0-9]','','g');
  select * into existe from private.recepcion_cajas c where c.clave=clave_caja;
  if found then
    if existe.requerimiento=r.id then
      return private.recepcion_estado(r.id) || jsonb_build_object('duplicada',true);
    end if;
    raise exception 'La caja pertenece a otro requerimiento' using errcode='23505';
  end if;
  if exists(select 1 from private.recepcion_maestro_prueba m where m.codigos ? clave_caja)
    or exists(select 1 from public.im_envios_cargos_live l where private.req4_clave_suministro(l.codigo_caja)=clave_caja)
    or exists(select 1 from private.box_conditioning b where b.code=clave_caja)
    or exists(select 1 from private.req4_cajas b where b.clave=clave_caja) then
    raise exception 'La caja ya está registrada en el Maestro o en otro proceso' using errcode='23505';
  end if;
  if (select count(*) from private.recepcion_cajas c where c.requerimiento=r.id)>=r.cantidad_cajas then
    raise exception 'Ya se alcanzó la cantidad solicitada';
  end if;
  insert into private.recepcion_cajas(clave,codigo,requerimiento,operador)
  values(clave_caja,p_codigo,r.id,auth.uid());
  return private.recepcion_estado(r.id);
end;
$$;

create function private.recepcion_prueba_excel(
  p_accion text,p_id uuid,p_secreto text,p_revision integer,p_archivo text,p_filas jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  r public.requerimientos; m private.recepcion_maestro_prueba;
  filas integer; esperadas integer; pendientes integer; actual timestamptz;
  hoy date:=(now() at time zone 'America/Lima')::date;
begin
  r:=private.recepcion_solicitud(p_id);
  select * into m from private.recepcion_maestro_prueba;
  if not found or sha256(convert_to(coalesce(p_secreto,''),'UTF8'))<>m.secreto_hash then
    raise exception 'Maestro de pruebas no autorizado' using errcode='42501';
  end if;
  if p_accion='cargar' then
    return private.recepcion_estado(r.id) || jsonb_build_object('archivo',encode(m.archivo,'base64'),'revision',m.revision);
  end if;
  if p_accion not in ('parcial','completa','acondicionar') then raise exception 'Operación inválida'; end if;

  -- Todas las escrituras compiten por la misma revisión del archivo.
  perform pg_advisory_xact_lock(1170196,1);
  r:=private.recepcion_solicitud(p_id);
  select * into m from private.recepcion_maestro_prueba for update;
  if p_revision is distinct from m.revision then
    raise exception 'El Maestro cambió. Reintenta la operación' using errcode='40001';
  end if;
  if p_accion='acondicionar' then
    if r.fecha_recepcion is null or jsonb_typeof(p_filas) is distinct from 'object'
      or (select count(*) from jsonb_each(p_filas))<>1
      or not exists(
        select 1 from private.recepcion_cajas c join private.box_conditioning b on b.code=c.clave
        where c.requerimiento=r.id and p_filas->>c.clave=c.correlativo::text
          and b.status='LISTA' and b.classification='Cajas Nuevas' and cardinality(b.cargos)>0)
    then raise exception 'Acondicionamiento sin verificar'; end if;
    update private.recepcion_maestro_prueba set archivo=decode(p_archivo,'base64'),revision=revision+1 where id;
    return private.recepcion_estado(r.id);
  end if;
  if r.fecha_recepcion is not null then return private.recepcion_estado(r.id); end if;
  select count(*),count(*) filter(where guardado is null) into esperadas,pendientes
    from private.recepcion_cajas where requerimiento=r.id;
  if esperadas=0 or (p_accion='completa' and esperadas<>r.cantidad_cajas) then
    raise exception 'La cantidad de cajas escaneadas todavía no permite esta operación';
  end if;
  if jsonb_typeof(p_filas) is distinct from 'object' then raise exception 'Conciliación inválida'; end if;
  select count(*) into filas from jsonb_each(p_filas);
  if filas>pendientes or (p_accion='completa' and filas<>pendientes) or exists(
    select 1 from jsonb_each_text(p_filas) f
    left join private.recepcion_cajas c on c.clave=f.key and c.requerimiento=r.id
    where c.clave is null or c.guardado is not null or m.codigos ? f.key or f.value !~ '^[1-9][0-9]{0,8}$'
  ) then raise exception 'Las cajas cambiaron. Reintenta la conciliación' using errcode='40001'; end if;
  if filas=0 and p_accion='parcial' then return private.recepcion_estado(r.id); end if;

  actual:=clock_timestamp();
  if filas>0 then
    if p_archivo is null then raise exception 'Falta el Excel verificado'; end if;
    update private.recepcion_maestro_prueba set archivo=decode(p_archivo,'base64'),
      revision=revision+1,codigos=codigos||p_filas where id;
    update private.recepcion_cajas c set guardado=actual,correlativo=(p_filas->>c.clave)::integer
      where c.requerimiento=r.id and p_filas ? c.clave;
  end if;
  perform set_config('kardex.recepcion_verificada','true',true);
  update public.requerimientos set recibido_v4=esperadas,
    estado_v4=case when p_accion='completa' then 'Recibido' else 'Recibido parcialmente' end,
    fecha_recepcion=case when p_accion='completa' then hoy end
    where id=r.id;
  perform set_config('kardex.recepcion_verificada','false',true);
  insert into private.req4_movimientos(id,requerimiento,tipo,fecha,datos,actor,responsable,registrado,revision_excel)
  values(gen_random_uuid(),r.id,case when p_accion='completa' then 'recepcion_completa' else 'recepcion_parcial' end,
    hoy,jsonb_build_object('cantidad',esperadas-(pendientes-filas),'nuevas',filas),auth.uid(),
    (select coalesce(nullif(raw_user_meta_data->>'kardex_username',''),email) from auth.users where id=auth.uid()),
    actual,(m.revision+(filas>0)::integer)::text);
  return private.recepcion_estado(r.id);
end;
$$;

-- Las antiguas acciones por cantidad no pueden marcar una recepción como completa.
create function private.recepcion_proteger_estado() returns trigger language plpgsql set search_path='' as $$
begin
  if new.tipo='Cajas nuevas para acondicionar' and auth.uid() is not null
    and (new.fecha_recepcion is distinct from old.fecha_recepcion or new.recibido_v4 is distinct from old.recibido_v4)
    and current_setting('kardex.recepcion_verificada',true) is distinct from 'true'
  then raise exception 'Registra la recepción con el lector en Control de cajas' using errcode='23514'; end if;
  return new;
end;
$$;
create trigger req_recepcion_proteger before update of fecha_recepcion,recibido_v4 on public.requerimientos
  for each row execute function private.recepcion_proteger_estado();

create or replace function private.req4_suministro_estado() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare resultado jsonb;
begin
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores' using errcode='42501';
  end if;
  with solicitudes as materialized (
    select r.id,r.numero,r.cantidad_cajas,r.fecha_recepcion,r.created_at,r.fecha_solicitud
    from public.requerimientos r
    where r.tipo='Cajas nuevas para acondicionar' and r.cantidad_cajas>0
      and (not exists(select 1 from private.recepcion_maestro_prueba) or r.solicitante_v4=auth.uid())
  ), escaneos as (
    select c.requerimiento,count(*)::integer leidas,
      count(*) filter(where c.guardado is not null)::integer guardadas,
      count(*) filter(where c.guardado is not null and b.status='LISTA' and cardinality(b.cargos)>0
        and b.classification='Cajas Nuevas' and b.finished_at>=c.leido)::integer listas
    from private.recepcion_cajas c left join private.box_conditioning b on b.code=c.clave
    join solicitudes r on r.id=c.requerimiento group by c.requerimiento
  ), relaciones as materialized (
    select distinct r.id,private.req4_clave_suministro(v.im_live_codigo_caja) clave
    from solicitudes r join public.documentos d on d.caja_asignada=r.id
    join public.kardex_documentos_resumen v on v.id=d.id
    where private.req4_clave_suministro(v.im_live_codigo_caja) is not null
  ), anteriores as (
    select x.id,count(*)::integer listas from relaciones x
    join (select clave from relaciones group by clave having count(*)=1) unicas using(clave)
    join solicitudes r on r.id=x.id
    where exists(select 1 from private.box_conditioning b where b.code=x.clave
      and b.status='LISTA' and cardinality(b.cargos)>0)
      or exists(select 1 from public.im_envios_cargos_live l
        where private.req4_clave_suministro(l.codigo_caja)=x.clave
          and l.fecha_envio between r.fecha_solicitud and (now() at time zone 'America/Lima')::date
          and nullif(trim(l.codigo_cargo),'') is not null)
    group by x.id
  ), detalle as (
    select r.id,r.numero,r.created_at creada,r.cantidad_cajas solicitadas,
      coalesce(e.leidas,0) leidas,coalesce(e.guardadas,0) guardadas,
      least(r.cantidad_cajas,case when e.leidas is not null
        then case when r.fecha_recepcion is not null then e.listas else 0 end
        else coalesce(a.listas,0) end) acondicionadas,
      (select m.registrado from private.req4_movimientos m where m.requerimiento=r.id
        and m.tipo='recepcion_completa' order by m.registrado limit 1) confirmada
    from solicitudes r left join escaneos e on e.requerimiento=r.id
    left join anteriores a on a.id=r.id
  ), balance as (
    select *,solicitadas-acondicionadas pendientes from detalle
  )
  select jsonb_build_object('bloqueado',coalesce(bool_or(pendientes>0),false),
    'solicitadas',coalesce(sum(solicitadas),0),'acondicionadas',coalesce(sum(acondicionadas),0),
    'pendientes',coalesce(sum(pendientes),0),
    'solicitudes',coalesce(jsonb_agg(to_jsonb(balance) order by creada,numero),'[]'::jsonb))
    into resultado from balance;
  return resultado;
end;
$$;

create function public.kardex_recepcion_operacion(p_accion text,p_id uuid default null,p_codigo text default null)
returns jsonb language sql set search_path='' as $$
  select private.recepcion_operacion(p_accion,p_id,p_codigo);
$$;
create function public.kardex_recepcion_prueba_excel(p_accion text,p_id uuid,p_secreto text,
  p_revision integer default null,p_archivo text default null,p_filas jsonb default null)
returns jsonb language sql set search_path='' as $$
  select private.recepcion_prueba_excel(p_accion,p_id,p_secreto,p_revision,p_archivo,p_filas);
$$;
revoke all on function private.recepcion_solicitud(uuid),private.recepcion_estado(uuid),
  private.recepcion_proteger_estado() from public,anon,authenticated;
revoke all on function private.recepcion_operacion(text,uuid,text),
  private.recepcion_prueba_excel(text,uuid,text,integer,text,jsonb),
  public.kardex_recepcion_operacion(text,uuid,text),
  public.kardex_recepcion_prueba_excel(text,uuid,text,integer,text,jsonb) from public,anon;
grant execute on function private.recepcion_operacion(text,uuid,text),
  private.recepcion_prueba_excel(text,uuid,text,integer,text,jsonb),
  public.kardex_recepcion_operacion(text,uuid,text),
  public.kardex_recepcion_prueba_excel(text,uuid,text,integer,text,jsonb) to authenticated;
