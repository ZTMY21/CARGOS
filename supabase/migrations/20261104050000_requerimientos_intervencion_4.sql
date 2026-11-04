alter table public.requerimientos
  add column estado_v4 text check (estado_v4 in ('Solicitado','Confirmado','Recibido parcialmente','Recibido','Prestado','Devuelto')),
  add column confirmado_v4 date,
  add column recibido_v4 integer not null default 0,
  add column solicitante_v4 uuid;

create table private.req4_cajas (
  requerimiento uuid not null references public.requerimientos(id),
  clave text not null check (clave ~ '^[0-9]{9,10}$'),
  codigo text not null,
  cargos text[] not null,
  recepcion date,
  devolucion date,
  primary key (requerimiento, clave)
);
create unique index req4_caja_activa on private.req4_cajas(clave) where devolucion is null;

-- Cada evento conserva el historial y queda disponible para consolidación en Excel.
create table private.req4_movimientos (
  id uuid primary key,
  requerimiento uuid not null references public.requerimientos(id),
  tipo text not null,
  fecha date not null,
  datos jsonb not null,
  actor uuid not null,
  responsable text not null,
  registrado timestamptz not null default clock_timestamp(),
  revision_excel text
);
create index req4_movimientos_req on private.req4_movimientos(requerimiento, registrado);
alter table private.req4_cajas enable row level security;
alter table private.req4_movimientos enable row level security;
revoke all on private.req4_cajas, private.req4_movimientos from public, anon, authenticated;

create function private.req4_proteger() returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon','authenticated') then
    if (tg_op <> 'INSERT' and old.estado_v4 is not null)
      or (tg_op <> 'DELETE' and (new.estado_v4 is not null or new.confirmado_v4 is not null
        or new.recibido_v4 <> 0 or new.solicitante_v4 is not null)) then
      raise exception 'Usa las acciones de seguimiento del requerimiento' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger req4_proteger before insert or update or delete on public.requerimientos
  for each row execute function private.req4_proteger();

create function private.req4_clave(codigo text) returns text language sql immutable set search_path = '' as $$
  select case when trim(coalesce(codigo,'')) ~* '^(TD?|P|A)?[[:space:]-]*[0-9]{9,10}$'
    then regexp_replace(codigo,'[^0-9]','','g') end;
$$;

create function private.req4_buscar(p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare resultado jsonb;
begin
  if auth.uid() is null or not private.kardex_has_access(true) then raise exception 'Solo administradores' using errcode='42501'; end if;
  if length(trim(coalesce(p_query,''))) not between 1 and 120 then return '[]'::jsonb; end if;
  with coincidencias as materialized (
    select j, coalesce(nullif(j->>'im_live_codigo_caja',''), nullif(j->>'im_codigo_caja',''), nullif(j->>'im_caja_preparada','')) codigo
    from jsonb_array_elements(public.kardex_search(p_query,'','','','',false,0,100)->'rows') j
  ), cargos as (
    select c from coincidencias cross join lateral jsonb_array_elements_text(coalesce(j->'cargos','[]'::jsonb)) c
  ), claves as (
    select private.req4_clave(codigo) clave from coincidencias where private.req4_clave(codigo) is not null
    union
    select private.req4_clave(l.codigo_caja) from public.im_envios_cargos_live l
    where (private.req4_clave(l.codigo_caja) = private.req4_clave(p_query)
        or (private.kardex_normalize(p_query) ~ '^[0-9]{1,7}a?$'
          and ltrim(private.kardex_normalize(l.codigo_cargo),'0') = ltrim(private.kardex_normalize(p_query),'0'))
        or l.codigo_cargo in (select c from cargos)
        or (length(l.codigo_cargo) <= 3 and exists(select 1 from cargos
          where ltrim(upper(c),'0')=ltrim(upper(l.codigo_cargo),'0'))))
      and private.req4_clave(l.codigo_caja) is not null
  ), cajas as (
    select k.clave, l.codigo_caja codigo, l.codigo_cargo cargo,
           case when l.fecha_envio is not null then 'Enviado a Iron Mountain'
                when l.clasificacion_caja ilike '%por solicitud%' then 'Caja solicitada'
                else 'Caja preparada para envío' end estado,
           case when l.fecha_envio is not null then 'Iron Mountain' end ubicacion
    from claves k join public.im_envios_cargos_live l on private.req4_clave(l.codigo_caja)=k.clave
    union all
    select private.req4_clave(c.codigo), c.codigo, jcargo, coalesce(c.j->>'estado','Caja registrada'), c.j->>'ubicacion'
    from coincidencias c cross join lateral jsonb_array_elements_text(coalesce(c.j->'cargos','[]'::jsonb)) jcargo
    where private.req4_clave(c.codigo) is not null
  ), agrupadas as (
    select clave, min(codigo) codigo, array_agg(distinct cargo order by cargo) cargos,
      coalesce(max(estado) filter(where estado='Enviado a Iron Mountain'), max(estado)) estado, max(ubicacion) ubicacion
    from cajas group by clave
  ), resultados as (
    select jsonb_build_object('clave',a.clave,'codigo',a.codigo,'cargos',a.cargos,'estado',a.estado,'ubicacion',a.ubicacion,
      'prestamo',(select r.numero from private.req4_cajas c join public.requerimientos r on r.id=c.requerimiento
        where c.clave=a.clave and c.devolucion is null)) fila
    from agrupadas a
    union all
    select jsonb_build_object('estado','Identificación pendiente','cargos',j->'cargos')
    from coincidencias where private.req4_clave(codigo) is null and not exists(select 1 from agrupadas)
  )
  select coalesce(jsonb_agg(fila order by fila->>'codigo'),'[]'::jsonb) into resultado from resultados;
  return resultado;
end;
$$;

create function private.req4_accion(p_id uuid, p_accion text, p_datos jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := auth.uid();
  actor_nombre text;
  hoy date := (now() at time zone 'America/Lima')::date;
  movimiento_fecha date := hoy;
  r public.requerimientos;
  anterior private.req4_movimientos;
  cantidad integer;
  tipo_req text;
  codigo text;
  caja jsonb;
  cajas jsonb := '[]';
  clave_caja text;
begin
  if actor_id is null or not private.kardex_has_access(true) then raise exception 'Solo administradores' using errcode='42501'; end if;
  if p_id is null or jsonb_typeof(p_datos) is distinct from 'object' then raise exception 'Solicitud inválida'; end if;
  select left(coalesce(nullif(trim(raw_user_meta_data->>'kardex_username'),''),email),150)
    into actor_nombre from auth.users where id=actor_id;
  perform pg_advisory_xact_lock(1170196,1);
  select * into anterior from private.req4_movimientos where id=p_id;
  if found then
    if anterior.actor<>actor_id or anterior.tipo<>p_accion or anterior.datos<>p_datos then
      raise exception 'La operación ya se registró con otros datos';
    end if;
    select * into r from public.requerimientos where id=anterior.requerimiento;
    return to_jsonb(r);
  end if;

  if p_accion='crear' then
    tipo_req := p_datos->>'tipo';
    if tipo_req='nuevas' then
      if coalesce(p_datos->>'cantidad','') !~ '^([1-9][0-9]?|100)$' then raise exception 'Ingresa de 1 a 100 cajas enteras'; end if;
      cantidad := (p_datos->>'cantidad')::integer;
      insert into public.requerimientos(id,tipo,fecha_solicitud,cantidad_cajas,usuario,estado_v4,solicitante_v4)
      values(p_id,'Cajas nuevas para acondicionar',hoy,cantidad,actor_nombre,'Solicitado',actor_id) returning * into r;
    elsif tipo_req='prestamo' then
      if jsonb_typeof(p_datos->'cajas') is distinct from 'array' then raise exception 'Selecciona las cajas físicas'; end if;
      if jsonb_array_length(p_datos->'cajas')=0 then raise exception 'Selecciona al menos una caja física'; end if;
      for codigo in select value from jsonb_array_elements_text(p_datos->'cajas') loop
        clave_caja := private.req4_clave(codigo);
        if clave_caja is null then raise exception 'Identifica el código físico de la caja'; end if;
        if exists(select 1 from jsonb_array_elements(cajas) b where b->>'clave'=clave_caja) then continue; end if;
        select b into caja from jsonb_array_elements(private.req4_buscar(codigo)) b where b->>'clave'=clave_caja;
        if caja is null then raise exception 'La caja % no está identificada',codigo; end if;
        if caja->>'prestamo' is not null then raise exception 'La caja % pertenece al préstamo activo %',codigo,caja->>'prestamo'; end if;
        cajas := cajas || jsonb_build_array(caja);
      end loop;
      insert into public.requerimientos(id,tipo,fecha_solicitud,cantidad_cajas,numeros_cargo,usuario,estado_v4,solicitante_v4)
      values(p_id,'Préstamo de Cajas (búsqueda de documentos)',hoy,jsonb_array_length(cajas),
        (select string_agg(distinct c,', ' order by c) from jsonb_array_elements(cajas) b cross join lateral jsonb_array_elements_text(b->'cargos') c),
        actor_nombre,'Solicitado',actor_id) returning * into r;
      insert into private.req4_cajas(requerimiento,clave,codigo,cargos)
      select r.id,b->>'clave',b->>'codigo',array(select jsonb_array_elements_text(b->'cargos')) from jsonb_array_elements(cajas) b;
    else
      raise exception 'Tipo de requerimiento inválido';
    end if;
  else
    select * into r from public.requerimientos where id=(p_datos->>'requerimiento')::uuid and estado_v4 is not null for update;
    if not found then raise exception 'Requerimiento no disponible'; end if;
    movimiento_fecha := coalesce(nullif(p_datos->>'fecha','')::date,hoy);
    if movimiento_fecha not between r.fecha_solicitud and hoy then raise exception 'La fecha debe estar entre la solicitud y hoy'; end if;
    if p_accion='confirmar' and r.tipo='Cajas nuevas para acondicionar' and r.confirmado_v4 is null then
      update public.requerimientos set confirmado_v4=movimiento_fecha,
        estado_v4=case when estado_v4='Solicitado' then 'Confirmado' else estado_v4 end where id=r.id returning * into r;
    elsif p_accion='recibir' and r.tipo='Cajas nuevas para acondicionar' then
      if coalesce(p_datos->>'cantidad','') !~ '^([1-9][0-9]?|100)$' then raise exception 'Ingresa una cantidad entera válida'; end if;
      cantidad := r.recibido_v4 + (p_datos->>'cantidad')::integer;
      if cantidad > r.cantidad_cajas then raise exception 'La recepción supera las cajas pendientes'; end if;
      update public.requerimientos set recibido_v4=cantidad,
        estado_v4=case when cantidad=cantidad_cajas then 'Recibido' else 'Recibido parcialmente' end,
        fecha_recepcion=case when cantidad=cantidad_cajas then movimiento_fecha end where id=r.id returning * into r;
    elsif p_accion in ('recibir_caja','devolver_caja') and r.tipo='Préstamo de Cajas (búsqueda de documentos)' then
      clave_caja := private.req4_clave(p_datos->>'caja');
      if p_accion='recibir_caja' then
        update private.req4_cajas set recepcion=movimiento_fecha
          where requerimiento=r.id and clave=clave_caja and recepcion is null;
      else
        update private.req4_cajas set devolucion=movimiento_fecha
          where requerimiento=r.id and clave=clave_caja and recepcion<=movimiento_fecha and devolucion is null;
      end if;
      if not found then raise exception 'La caja no está disponible para este movimiento'; end if;
      update public.requerimientos set
        recibido_v4=(select count(*) from private.req4_cajas where requerimiento=r.id and recepcion is not null),
        fecha_recepcion=coalesce(fecha_recepcion,movimiento_fecha),
        estado_v4=case when not exists(select 1 from private.req4_cajas where requerimiento=r.id and devolucion is null)
          then 'Devuelto' else 'Prestado' end,
        fecha_devolucion=case when not exists(select 1 from private.req4_cajas where requerimiento=r.id and devolucion is null)
          then movimiento_fecha end where id=r.id returning * into r;
    else
      raise exception 'Movimiento inválido para el estado actual';
    end if;
  end if;
  insert into private.req4_movimientos(id,requerimiento,tipo,fecha,datos,actor,responsable)
    values(p_id,r.id,p_accion,movimiento_fecha,p_datos,actor_id,actor_nombre);
  return to_jsonb(r);
end;
$$;

create function private.req4_detalle() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not private.kardex_has_access(true) then raise exception 'Solo administradores' using errcode='42501'; end if;
  return jsonb_build_object(
    'cajas',coalesce((select jsonb_agg(c order by c.codigo) from private.req4_cajas c),'[]'::jsonb),
    'movimientos',coalesce((select jsonb_agg(m order by m.registrado) from private.req4_movimientos m),'[]'::jsonb)
  );
end;
$$;

create function public.kardex_req4_buscar(p_query text) returns jsonb language sql stable set search_path='' as $$
  select private.req4_buscar(p_query);
$$;
create function public.kardex_req4_accion(p_id uuid,p_accion text,p_datos jsonb) returns jsonb language sql set search_path='' as $$
  select private.req4_accion(p_id,p_accion,p_datos);
$$;
create function public.kardex_req4_detalle() returns jsonb language sql stable set search_path='' as $$
  select private.req4_detalle();
$$;

revoke execute on function private.req4_buscar(text), private.req4_accion(uuid,text,jsonb), private.req4_detalle(),
  public.kardex_req4_buscar(text), public.kardex_req4_accion(uuid,text,jsonb), public.kardex_req4_detalle() from public,anon;
grant execute on function private.req4_buscar(text), private.req4_accion(uuid,text,jsonb), private.req4_detalle(),
  public.kardex_req4_buscar(text), public.kardex_req4_accion(uuid,text,jsonb), public.kardex_req4_detalle() to authenticated;
