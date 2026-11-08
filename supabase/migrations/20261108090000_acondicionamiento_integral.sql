-- La preparación y el despacho son movimientos independientes.
create table private.acond_movimientos (
  id uuid primary key default gen_random_uuid(),
  clave text not null,
  codigo text not null,
  solicitud uuid not null references public.requerimientos(id),
  origen text not null check (origen in ('nueva','solicitada')),
  cargos text[] not null check (cardinality(cargos) between 1 and 60),
  anios integer[] not null,
  recibida date not null,
  solicitada date,
  envio_original date,
  preparada date not null,
  registrada timestamptz not null default clock_timestamp(),
  responsable_id uuid not null,
  responsable text not null,
  enviada date,
  placa text,
  entrega text,
  recibe text,
  despachada_por uuid,
  revision integer not null default 1,
  sincronizada integer not null default 0,
  unique (clave,solicitud)
);
create index acond_pendientes on private.acond_movimientos(preparada,id) where revision<>sincronizada;
create table private.acond_historia_fuente (
  clave text not null, codigo text not null, cargos text[] not null, envio date,
  primary key (clave,codigo,cargos)
);
create table private.acond_historico_prueba (
  id boolean primary key default true check(id),
  archivo bytea not null
);
alter table private.acond_movimientos enable row level security;
alter table private.acond_historia_fuente enable row level security;
alter table private.acond_historico_prueba enable row level security;
revoke all on private.acond_movimientos,private.acond_historia_fuente,private.acond_historico_prueba from public,anon,authenticated;

create function private.acond_clave(valor text) returns text language sql immutable set search_path='' as $$
  select case when codigo ~ '^[A-Z]*[0-9]{5,35}$' then regexp_replace(codigo,'[^0-9]','','g') end
  from (select regexp_replace(upper(coalesce(valor,'')), '[[:space:]./_-]', '', 'g') codigo) c
$$;

create function private.acond_cargo_clave(valor text) returns text language sql immutable set search_path='' as $
  select private.req4_cargo(regexp_replace(btrim(valor),'^0+(?=[0-9])',''))
$;
create function private.acond_cargos_claves(valores text[]) returns text[] language sql immutable set search_path='' as $
  select coalesce(array_agg(distinct clave) filter(where clave is not null),'{}')
  from (select private.acond_cargo_clave(valor) clave from unnest(valores) valor) c
$;

create view private.acond_cajas as
  select c.clave,c.codigo,c.requerimiento solicitud,'nueva'::text origen,
    (c.leido at time zone 'America/Lima')::date recibida,r.fecha_solicitud solicitada,
    null::date envio_original,null::text[] cargos
  from private.recepcion_cajas c join public.requerimientos r on r.id=c.requerimiento
  where c.guardado is not null
    and not exists(select 1 from private.req4_cajas q where q.clave=c.clave and q.devolucion is null)
    and (c.origen='escaneo' or not exists(select 1 from public.im_envios_cargos_live l
      where private.acond_clave(l.codigo_caja)=c.clave and l.fecha_envio is not null))
    and not exists(select 1 from private.acond_movimientos m where m.clave=c.clave and m.enviada is not null)
  union all
  select c.clave,c.codigo,c.requerimiento,'solicitada',c.recepcion,r.fecha_solicitud,
    case when h.coincidencias=1 then h.envio end,
    case when h.coincidencias=1 then h.cargos else c.cargos end
  from private.req4_cajas c join public.requerimientos r on r.id=c.requerimiento
  left join lateral (
    select count(*) coincidencias,min(f.envio) envio,(array_agg(f.cargos::text))[1]::text[] cargos
    from private.acond_historia_fuente f where f.clave=c.clave and
      private.acond_cargos_claves(c.cargos) <@ private.acond_cargos_claves(f.cargos)
  ) h on true
  where c.devolucion is null;

create function private.acond_cargo(p_cargo text,p_anio integer,p_clave text,p_solicitud uuid)
returns jsonb language sql stable set search_path='' as $$
  with matches as (
    select d.id,c.cargo,
      regexp_replace(lower(coalesce(d.ubicacion,'')),'[^a-z]','','g') in ('santaanita','cdsantaanita')
      and d.caja_asignada is null and v.im_codigo_caja is null and v.im_caja_preparada is null
      and v.im_live_codigo_caja is null and v.im_historical_decision is distinct from 'historico'
      and d.f_envio is null disponible
    from public.documentos d join public.kardex_documentos_resumen v on v.id=d.id
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

create function private.acond_buscar(p_codigo text) returns jsonb language plpgsql stable set search_path='' as $$
declare
  clave_busqueda text:=private.acond_clave(p_codigo);
  caja record;
  movimiento private.acond_movimientos%rowtype;
  coincidencias integer;
  legacy private.box_conditioning%rowtype;
  anios integer[];
begin
  if clave_busqueda is null then return jsonb_build_object('status','inexistente'); end if;
  select count(*) into coincidencias from (
    select upper(regexp_replace(codigo,'[[:space:]./_-]','','g')) from private.acond_cajas where clave=clave_busqueda
    union select upper(regexp_replace(codigo,'[[:space:]./_-]','','g')) from private.acond_movimientos where clave=clave_busqueda
    union select upper(regexp_replace(original_code,'[[:space:]./_-]','','g')) from private.box_conditioning where code=clave_busqueda
    union select upper(regexp_replace(codigo,'[[:space:]./_-]','','g')) from private.acond_historia_fuente where clave=clave_busqueda
  ) candidatos;
  if coincidencias>1 then return jsonb_build_object('status','ambiguo'); end if;
  select * into caja from private.acond_cajas where clave=clave_busqueda
    order by (origen='solicitada') desc,recibida desc nulls last limit 1;
  select * into movimiento from private.acond_movimientos m where m.clave=clave_busqueda
    and (caja.solicitud is null or m.solicitud=caja.solicitud) order by m.registrada desc,m.id desc limit 1;
  if movimiento.id is not null then
    return to_jsonb(movimiento)||jsonb_build_object('status','preparada');
  end if;
  select * into legacy from private.box_conditioning where code=clave_busqueda;
  if legacy.code is not null and coalesce(caja.origen,'nueva')='nueva' then
    return jsonb_build_object('status',case legacy.status when 'LISTA' then 'preparada' else 'observada' end,
      'codigo',legacy.original_code,'clave',legacy.code,'origen',case when legacy.classification='POR SOLICITUD'
        then 'solicitada' when legacy.classification='Reparación' then 'reparacion' else 'nueva' end,
      'cargos',legacy.cargos,'preparada',(legacy.finished_at at time zone 'America/Lima')::date,
      'responsable',(select coalesce(u.raw_user_meta_data->>'kardex_username',u.raw_user_meta_data->>'name','')
        from auth.users u where u.id=legacy.responsible_id));
  end if;
  if caja.solicitud is null then return jsonb_build_object('status',case when coincidencias=1 then 'no_recibida' else 'inexistente' end); end if;
  if caja.origen='solicitada' then
    select array_agg(distinct y order by y) into anios
    from public.documentos d cross join lateral unnest(d.cargos) c(cargo)
    cross join lateral (select coalesce(extract(year from d.fecha_origen)::int,d.anio_origen,extract(year from d.periodo)::int) y) a
    where y between 2020 and 2026 and private.acond_cargo_clave(c.cargo)=any(private.acond_cargos_claves(caja.cargos));
  end if;
  return to_jsonb(caja)||jsonb_build_object('anios',anios,'status',case when caja.recibida is null then 'no_recibida'
    when caja.origen='solicitada' and caja.envio_original is null then 'revisar_historico' else 'disponible' end);
end
$$;

create function private.acond_operacion(p_accion text,p_codigo text,p_anio integer,p_cargos text[],p_datos jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid();
  nombre text;
  hoy date:=(now() at time zone 'America/Lima')::date;
  caja jsonb;
  item jsonb;
  salida private.acond_movimientos%rowtype;
  solicitud_id uuid;
  codigo_cargo text;
  clave text;
  cargos_originales text[]:='{}';
  anios integer[];
  fecha_real date;
begin
  if actor is null or not private.kardex_has_access(true) then raise exception 'Solo administradores' using errcode='42501'; end if;
  if p_accion='listar' then
    return (with activas as (
      select distinct on (c.clave) c.* from private.acond_cajas c
      where c.recibida is not null order by c.clave,(c.origen='solicitada') desc,c.recibida desc
    ), preparadas as (
      select to_jsonb(m) data,m.preparada fecha from private.acond_movimientos m
      union all select jsonb_build_object('codigo',b.original_code,'origen',
        case b.classification when 'POR SOLICITUD' then 'solicitada' when 'Reparación' then 'reparacion' else 'nueva' end,
        'cargos',b.cargos,'preparada',(b.finished_at at time zone 'America/Lima')::date,
        'responsable',coalesce(u.raw_user_meta_data->>'kardex_username',u.raw_user_meta_data->>'name','')),
        (b.finished_at at time zone 'America/Lima')::date
      from private.box_conditioning b left join auth.users u on u.id=b.responsible_id
      where b.status='LISTA' and not exists(select 1 from private.acond_movimientos m where m.clave=b.code and m.origen='nueva')
    )
    select jsonb_build_object(
      'nuevas',(select count(*) from activas where origen='nueva'),
      'solicitadas',(select count(*) from activas where origen='solicitada'),
      'preparadas',(select count(*) from activas a where exists(select 1 from private.acond_movimientos m where m.clave=a.clave and m.solicitud=a.solicitud)
        or (a.origen='nueva' and exists(select 1 from private.box_conditioning b where b.code=a.clave and b.status='LISTA'))),
      'listado',coalesce((select jsonb_agg(data order by fecha desc,data->>'codigo') from preparadas),'[]'::jsonb)));
  end if;
  if p_accion='buscar' then return private.acond_buscar(p_codigo); end if;
  if p_accion='estados' then
    return coalesce((select jsonb_agg(to_jsonb(x)) from (
      select distinct on (q.clave) q.codigo,q.clave,q.origen,q.cargos,q.anios,q.enviada,q.entrega,q.recibe,q.placa
      from (
        select m.codigo,m.clave,m.origen,m.cargos,m.anios,m.enviada,m.entrega,m.recibe,m.placa,
          coalesce(m.enviada,m.preparada) fecha,m.registrada,1 prioridad
        from private.acond_movimientos m
        union all
        select c.codigo,c.clave,c.origen,c.cargos,'{}'::integer[],null,null,null,null,c.recibida,'infinity'::timestamptz,2
        from private.acond_cajas c where c.origen='solicitada' and c.recibida is not null
          and not exists(select 1 from private.acond_movimientos m where m.clave=c.clave and m.solicitud=c.solicitud)
      ) q order by q.clave,q.fecha desc,q.prioridad desc,q.registrada desc
    ) x),'[]'::jsonb);
  end if;
  if coalesce(p_accion,'') not in ('recibir','cargo','preparar','enviar') then raise exception 'Acción inválida'; end if;
  if p_accion in ('recibir','preparar','enviar') then
    if not exists(select 1 from private.acond_historico_prueba where id) then raise exception 'Entorno aislado no disponible'; end if;
    -- Serializar asignaciones cruzadas y reintentos, incluso entre dos cajas.
    perform pg_advisory_xact_lock(66110435);
  end if;
  caja:=private.acond_buscar(p_codigo);
  if p_accion='recibir' then
    if caja->>'status'<>'no_recibida' or caja->>'origen' is distinct from 'solicitada' then
      raise exception 'No hay una solicitud pendiente de recepción para este código';
    end if;
    perform private.req4_accion(gen_random_uuid(),'recibir_caja',jsonb_build_object(
      'requerimiento',caja->>'solicitud','caja',caja->>'codigo','fecha',hoy));
    return private.acond_buscar(p_codigo);
  end if;
  clave:=caja->>'clave';
  solicitud_id:=(caja->>'solicitud')::uuid;
  if p_accion='cargo' then
    if caja->>'status'<>'disponible' or caja->>'origen'<>'nueva' or coalesce(p_anio,0) not between 2020 and 2026
      or cardinality(p_cargos) is distinct from 1 then raise exception 'Selecciona una caja recibida y un año válido'; end if;
    return private.acond_cargo(p_cargos[1],p_anio,clave,solicitud_id);
  end if;
  if p_accion='enviar' then
    select * into salida from private.acond_movimientos m where m.id=(p_datos->>'id')::uuid for update;
    if not found then raise exception 'Prepara primero la caja'; end if;
    if salida.enviada is not null then return to_jsonb(salida); end if;
    fecha_real:=(p_datos->>'fecha')::date;
    if fecha_real is null or fecha_real<salida.preparada or fecha_real>hoy then raise exception 'La fecha real debe estar entre la preparación y hoy'; end if;
    if salida.origen='solicitada' then
      perform private.req4_accion(gen_random_uuid(),'devolver_caja',jsonb_build_object(
        'requerimiento',salida.solicitud,'caja',salida.codigo,'fecha',fecha_real,'acond_movimiento',salida.id));
      -- El disparador conserva también devoluciones confirmadas desde Requerimientos.
    end if;
    update private.acond_movimientos set enviada=fecha_real,despachada_por=actor,
      placa=left(nullif(btrim(p_datos->>'placa'),''),30),entrega=left(nullif(btrim(p_datos->>'entrega'),''),150),
      recibe=left(nullif(btrim(p_datos->>'recibe'),''),150),revision=2
      where id=salida.id returning * into salida;
    return to_jsonb(salida);
  end if;
  if caja->>'status'='preparada' and caja ? 'id' then return caja; end if;
  if caja->>'status'<>'disponible' then raise exception 'La caja no está disponible para preparación'; end if;
  if caja->>'origen'='nueva' then
    if p_anio is null or p_anio not between 2020 and 2026 or coalesce(cardinality(p_cargos),0) not between 1 and 3
      or cardinality(private.acond_cargos_claves(p_cargos))<>cardinality(p_cargos) then
      raise exception 'Indica de uno a tres cargos distintos y un año válido';
    end if;
    foreach codigo_cargo in array p_cargos loop
      item:=private.acond_cargo(codigo_cargo,p_anio,clave,solicitud_id);
      if item->>'status'<>'disponible' then raise exception 'El cargo % no está disponible en el año elegido',codigo_cargo; end if;
      cargos_originales:=array_append(cargos_originales,item->>'codigo');
    end loop;
    anios:=array[p_anio];
  else
    if not coalesce((p_datos->>'verificada')::boolean,false) then raise exception 'Confirma la verificación física de todos los cargos'; end if;
    cargos_originales:=array(select jsonb_array_elements_text(caja->'cargos'));
    anios:=case when jsonb_typeof(caja->'anios')='array'
      then array(select jsonb_array_elements_text(caja->'anios')::int) else '{}' end;
  end if;
  select coalesce(nullif(u.raw_user_meta_data->>'kardex_username',''),nullif(u.raw_user_meta_data->>'name',''),u.email)
    into nombre from auth.users u where u.id=actor;
  insert into private.acond_movimientos(clave,codigo,solicitud,origen,cargos,anios,recibida,solicitada,envio_original,preparada,responsable_id,responsable)
    values(clave,caja->>'codigo',solicitud_id,caja->>'origen',cargos_originales,anios,(caja->>'recibida')::date,
      (caja->>'solicitada')::date,(caja->>'envio_original')::date,hoy,actor,nombre) returning * into salida;
  if salida.origen='nueva' and cardinality(salida.cargos)<=50 then
    insert into private.box_conditioning(code,original_code,cargos,classification,status,finished_at,responsible_id)
    values(salida.clave,salida.codigo,salida.cargos,'Cajas Nuevas','LISTA',now(),actor)
    on conflict(code) do nothing;
  end if;
  return to_jsonb(salida);
end
$$;

create function private.acond_retorno_req() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.devolucion is null and new.devolucion is not null and exists(select 1 from private.acond_historico_prueba where id) then
    update private.acond_movimientos m set enviada=new.devolucion,despachada_por=auth.uid(),revision=2
    where m.solicitud=new.requerimiento and m.clave=new.clave and m.origen='solicitada'
      and m.enviada is null and m.preparada<=new.devolucion;
    if not found then raise exception 'Registra primero el acondicionamiento y la fecha real de retorno'; end if;
  end if;
  return new;
end
$$;
create trigger acond_retorno before update of devolucion on private.req4_cajas for each row execute function private.acond_retorno_req();

create function private.acond_excel(p_accion text,p_secreto text,p_revision integer,p_maestro text,p_historico text,p_lote jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  maestro private.recepcion_maestro_prueba%rowtype;
  historico bytea;
  trabajos jsonb;
begin
  if auth.uid() is null or not private.kardex_has_access(true) then raise exception 'Solo administradores' using errcode='42501'; end if;
  select * into maestro from private.recepcion_maestro_prueba where id for update;
  select archivo into historico from private.acond_historico_prueba where id;
  if maestro.archivo is null or historico is null or p_secreto is null or
    maestro.secreto_hash is distinct from sha256(convert_to(p_secreto,'UTF8')) then
    raise exception 'Entorno aislado no disponible' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into trabajos from (
    select * from private.acond_movimientos m where m.revision<>m.sincronizada order by m.preparada,m.id limit 30 for update
  ) t;
  if p_accion='leer' then
    return jsonb_build_object('revision',maestro.revision,'lote',trabajos,
      'maestro',encode(maestro.archivo,'base64'),'historico',encode(historico,'base64'));
  end if;
  if p_accion<>'confirmar' or p_revision is distinct from maestro.revision or trabajos is distinct from p_lote then
    raise exception 'Otra operación modificó el lote. Reintenta.' using errcode='40001';
  end if;
  if p_maestro is null or p_historico is null or length(p_maestro) not between 1000 and 12000000 or length(p_historico) not between 1000 and 12000000 then
    raise exception 'Tamaño inválido';
  end if;
  update private.recepcion_maestro_prueba set archivo=decode(p_maestro,'base64'),revision=revision+1 where id;
  update private.acond_historico_prueba set archivo=decode(p_historico,'base64') where id;
  update private.acond_movimientos m set sincronizada=m.revision
    where exists(select 1 from jsonb_array_elements(p_lote) x where (x->>'id')::uuid=m.id);
  return jsonb_build_object('revision',maestro.revision+1,'verificado',true);
end
$$;

create function public.kardex_acondicionamiento(p_accion text,p_codigo text default null,p_anio integer default null,
  p_cargos text[] default null,p_datos jsonb default '{}') returns jsonb language sql set search_path='' as $$
  select private.acond_operacion(p_accion,p_codigo,p_anio,p_cargos,p_datos)
$$;
create function public.kardex_acondicionamiento_excel(p_accion text,p_secreto text,p_revision integer default null,
  p_maestro text default null,p_historico text default null,p_lote jsonb default null)
returns jsonb language sql set search_path='' as $$
  select private.acond_excel(p_accion,p_secreto,p_revision,p_maestro,p_historico,p_lote)
$$;
revoke execute on function private.acond_clave(text),private.acond_buscar(text),
  private.acond_cargo_clave(text),private.acond_cargos_claves(text[]),
  private.acond_cargo(text,integer,text,uuid),private.acond_retorno_req() from public,anon,authenticated;
revoke all on private.acond_cajas from public,anon,authenticated;
revoke execute on function private.acond_operacion(text,text,integer,text[],jsonb),
  private.acond_excel(text,text,integer,text,text,jsonb),
  public.kardex_acondicionamiento(text,text,integer,text[],jsonb),
  public.kardex_acondicionamiento_excel(text,text,integer,text,text,jsonb) from public,anon;
grant execute on function private.acond_operacion(text,text,integer,text[],jsonb),
  private.acond_excel(text,text,integer,text,text,jsonb),
  public.kardex_acondicionamiento(text,text,integer,text[],jsonb),
  public.kardex_acondicionamiento_excel(text,text,integer,text,text,jsonb) to authenticated;
