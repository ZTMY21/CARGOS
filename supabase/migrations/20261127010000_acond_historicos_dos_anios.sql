-- Selección individual por año sin cambiar columnas ni formatos de los Excel.
-- Migración pendiente de aplicar a producción hasta aprobar la preview.
alter table private.acond_movimientos
  add column cargo_anios integer[],
  add column documentos_ids uuid[];

create or replace function private.acond_cargo(p_cargo text,p_anio integer,p_clave text,p_solicitud uuid)
returns jsonb language sql stable set search_path='' as $$
  with matches as (
    select d.id,c.cargo,
      (nullif(btrim(d.ubicacion),'') is null
       or regexp_replace(lower(d.ubicacion),'[^a-z]','','g') in ('santaanita','cdsantaanita')
       or exists(select 1 from private.kardex_im_historical_audit h
         where h.documento_id=d.id and h.revoked_at is null and h.decision='historico'))
      and d.caja_asignada is null
      and (d.f_envio is null or (exists(select 1 from private.kardex_im_historical_audit h
        where h.documento_id=d.id and h.revoked_at is null and h.decision='historico')
        and nullif(d.sustento,'') is null and nullif(d.sustento_imagen,'') is null))
      and not exists(select 1 from private.im_envios_confirmados s where s.documento_id=d.id)
      and not exists(select 1 from private.im_cajas_preparadas p where p.documento_id=d.id)
      and not exists (select 1 from public.im_envios_cargos h
        where private.acond_cargo_clave(h.codigo_cargo)=private.acond_cargo_clave(c.cargo))
      and not exists (select 1 from public.im_envios_cargos_live l
        where private.acond_cargo_clave(l.codigo_cargo)=private.acond_cargo_clave(c.cargo)
          and (l.fecha_envio is not null or l.fecha_preparacion is not null)
          -- Una línea del Maestro vinculada a OTRO documento/año no ocupa este cargo.
          and not exists(select 1 from private.acond_movimientos am
            where am.origen='nueva' and am.documentos_ids is not null
              and am.clave=private.acond_clave(l.codigo_caja)
              and private.acond_cargo_clave(l.codigo_cargo)=any(private.acond_cargos_claves(am.cargos))
              and not d.id=any(am.documentos_ids))) disponible
    from public.documentos d cross join lateral unnest(d.cargos) c(cargo)
    where coalesce(extract(year from d.fecha_origen)::int,d.anio_origen,extract(year from d.periodo)::int)=p_anio
      and private.acond_cargo_clave(c.cargo)=private.acond_cargo_clave(p_cargo)
  ), candidates as (
    select x.*,not exists(select 1 from private.acond_movimientos m
      where m.origen='nueva' and (m.clave,m.solicitud) is distinct from (p_clave,p_solicitud)
        and (m.documentos_ids is not null and x.id=any(m.documentos_ids)
          or m.documentos_ids is null and p_anio=any(m.anios)
             and private.acond_cargo_clave(p_cargo)=any(private.acond_cargos_claves(m.cargos)))) libre
    from matches x
  )
  select jsonb_build_object('status',case when count(*)=0 then 'inexistente'
    when count(distinct id)>1 then 'ambiguo' when bool_or(disponible and libre) then 'disponible'
    else 'no_disponible' end,
    'codigo',coalesce(min(cargo) filter(where cargo=p_cargo),min(cargo)),
    'documento_id',case when count(distinct id)=1 then (array_agg(distinct id))[1]::text end)
  from candidates
$$;

create or replace function private.acond_operacion(p_accion text,p_codigo text,p_anio integer,p_cargos text[],p_datos jsonb)
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
  cargo_anios integer[];
  documentos_ids uuid[]:='{}';
  indice integer;
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
        and not exists(select 1 from private.acond_maestro_preparadas p where p.clave=b.code)
      union all select to_jsonb(p)||jsonb_build_object('origen','nueva'),p.preparada
      from private.acond_maestro_preparadas p
      where not exists(select 1 from private.acond_movimientos m where m.clave=p.clave and m.origen='nueva')
    )
    select jsonb_build_object(
      'nuevas',(select count(*) from activas where origen='nueva'),
      'solicitadas',(select count(*) from activas where origen='solicitada'),
      'preparadas',(select count(*) from activas a where exists(select 1 from private.acond_movimientos m where m.clave=a.clave and m.solicitud=a.solicitud)
        or (a.origen='nueva' and (exists(select 1 from private.box_conditioning b where b.code=a.clave and b.status='LISTA')
          or exists(select 1 from private.acond_maestro_preparadas p where p.clave=a.clave)))),
      'listado',coalesce((select jsonb_agg(data order by fecha desc,data->>'codigo') from preparadas),'[]'::jsonb)));
  end if;
  if p_accion='buscar' then return private.acond_buscar(p_codigo); end if;
  if p_accion='estados' then
    return coalesce((select jsonb_agg(to_jsonb(x)) from (
      select distinct on (q.clave) q.codigo,q.clave,q.origen,q.cargos,q.anios,q.documentos_ids,q.cargo_anios,q.enviada,q.entrega,q.recibe,q.placa
      from (
        select m.codigo,m.clave,m.origen,m.cargos,m.anios,m.documentos_ids,m.cargo_anios,m.enviada,m.entrega,m.recibe,m.placa,
          coalesce(m.enviada,m.preparada) fecha,m.registrada,1 prioridad
        from private.acond_movimientos m
        union all
        select c.codigo,c.clave,c.origen,c.cargos,'{}'::integer[],null::uuid[],null::integer[],null,null,null,null,c.recibida,'infinity'::timestamptz,2
        from private.acond_cajas c where c.origen='solicitada' and c.recibida is not null
          and not exists(select 1 from private.acond_movimientos m where m.clave=c.clave and m.solicitud=c.solicitud)
      ) q order by q.clave,q.fecha desc,q.prioridad desc,q.registrada desc
    ) x),'[]'::jsonb);
  end if;
  if coalesce(p_accion,'') not in ('recibir','cargo','preparar','enviar') then raise exception 'Acción inválida'; end if;
  if p_accion in ('recibir','preparar','enviar') then
    if not private.acond_habilitada() then raise exception 'Acondicionamiento aún no está habilitado'; end if;
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
    if p_datos ? 'anios_cargos' then
      if jsonb_typeof(p_datos->'anios_cargos') is distinct from 'array' or
        jsonb_array_length(p_datos->'anios_cargos')<>cardinality(p_cargos) then
        raise exception 'Asigna un año a cada cargo';
      end if;
      cargo_anios:=array(select jsonb_array_elements_text(p_datos->'anios_cargos')::integer);
    else
      cargo_anios:=array_fill(p_anio,array[cardinality(p_cargos)]);
    end if;
    if exists(select 1 from unnest(cargo_anios) y where y not between 2020 and 2026)
      or (select count(distinct y) from unnest(cargo_anios) y)>2
      or p_anio<>cargo_anios[1] then raise exception 'Selecciona uno o dos años válidos'; end if;
    for indice in 1..cardinality(p_cargos) loop
      codigo_cargo:=p_cargos[indice];
      item:=private.acond_cargo(codigo_cargo,cargo_anios[indice],clave,solicitud_id);
      if item->>'status'<>'disponible' then
        raise exception 'El cargo % no está disponible en el año %',codigo_cargo,cargo_anios[indice];
      end if;
      cargos_originales:=array_append(cargos_originales,item->>'codigo');
      documentos_ids:=array_append(documentos_ids,(item->>'documento_id')::uuid);
    end loop;
    anios:=array(select distinct y from unnest(cargo_anios) y order by y);
  else
    if not coalesce((p_datos->>'verificada')::boolean,false) then raise exception 'Confirma la verificación física de todos los cargos'; end if;
    cargos_originales:=array(select jsonb_array_elements_text(caja->'cargos'));
    anios:=case when jsonb_typeof(caja->'anios')='array'
      then array(select jsonb_array_elements_text(caja->'anios')::int) else '{}' end;
  end if;
  select coalesce(nullif(u.raw_user_meta_data->>'kardex_username',''),nullif(u.raw_user_meta_data->>'name',''),u.email)
    into nombre from auth.users u where u.id=actor;
  insert into private.acond_movimientos(clave,codigo,solicitud,origen,cargos,anios,cargo_anios,documentos_ids,recibida,solicitada,envio_original,preparada,responsable_id,responsable)
    values(clave,caja->>'codigo',solicitud_id,caja->>'origen',cargos_originales,anios,cargo_anios,documentos_ids,(caja->>'recibida')::date,
      (caja->>'solicitada')::date,(caja->>'envio_original')::date,hoy,actor,nombre) returning * into salida;
  -- El registro original permanece en auditoría; solo las decisiones históricas
  -- de los documentos efectivamente seleccionados dejan de estar activas.
  if salida.origen='nueva' then
    update private.kardex_im_historical_audit h set revoked_at=clock_timestamp(),
      revoked_by=nombre,revocation_reason='Acondicionamiento en caja '||salida.codigo
    where h.documento_id=any(documentos_ids) and h.revoked_at is null
      and h.decision='historico';
  end if;
  if salida.origen='nueva' and cardinality(salida.cargos)<=50 then
    insert into private.box_conditioning(code,original_code,cargos,classification,status,finished_at,responsible_id)
    values(salida.clave,salida.codigo,salida.cargos,'Cajas Nuevas','LISTA',now(),actor)
    on conflict(code) do nothing;
  end if;
  return to_jsonb(salida);
end
$$;

create or replace view public.kardex_documentos_resumen as
SELECT d.id,
    d.kardex,
    d.fecha_registro,
    d.tipo_doc,
    d.periodo,
    d.ubicacion,
    d.folios,
    d.cargos,
    d.caja_asignada,
    d.f_envio,
    d.sustento,
    d.usuario,
    d.obs,
    d.created_at,
    d.updated_at,
    d.clave_origen,
    d.hoja_origen,
    d.fecha_origen,
    d.anio_origen,
    d.estado_origen,
    d.importacion_id,
    (d.sustento_imagen <> ''::text) AS tiene_sustento_imagen,
    d.cantidad_facturas,
    m.codigo_caja AS im_codigo_caja,
    m.fecha_envio AS im_fecha_envio,
    m.responsable AS im_responsable,
    (m.documento_id IS NOT NULL) AS im_confirmado,
    ((p.documento_id IS NOT NULL) AND (m.documento_id IS NULL)) AS im_preparado,
    p.codigo_caja AS im_caja_preparada,
    p.responsable AS im_responsable_preparacion,
    live.codigo_caja AS im_live_codigo_caja,
    live.clasificacion_caja AS im_live_clasificacion,
    live.fecha_envio AS im_live_fecha_envio,
    CASE WHEN h.decision = 'historico' AND live.codigo_caja IS NOT NULL
         THEN NULL ELSE h.decision END AS im_historical_decision,
    CASE WHEN h.decision IS NOT NULL AND live.fecha_envio IS NOT NULL
         THEN live.responsable_entrega END AS im_live_responsable_entrega
FROM public.documentos d
LEFT JOIN private.im_envios_confirmados m ON m.documento_id = d.id
LEFT JOIN private.im_cajas_preparadas p ON p.documento_id = d.id
LEFT JOIN private.kardex_im_historical_audit h
  ON h.documento_id = d.id AND h.revoked_at IS NULL
  AND coalesce(extract(year from d.fecha_origen)::integer, d.anio_origen,
               extract(year from d.periodo)::integer) BETWEEN 2020 AND 2024
LEFT JOIN LATERAL (
  SELECT l.codigo_caja, l.clasificacion_caja, l.fecha_envio, l.responsable_entrega
  FROM public.im_envios_cargos_live l
  WHERE (
    l.codigo_cargo = ANY (d.cargos)
    OR (
      length(l.codigo_cargo) <= 3
      AND regexp_replace(upper(l.codigo_cargo), '^0+(?=[0-9])', '', 'g')
          = regexp_replace(upper(d.cargos[1]), '^0+(?=[0-9])', '', 'g')
    )
  )
  -- Un código ambiguo del Excel no debe retirar el estado histórico de otro cargo.
  AND (
    h.decision IS DISTINCT FROM 'historico'
    OR NOT EXISTS (
      SELECT 1 FROM public.documentos other
      WHERE other.id <> d.id AND (
        l.codigo_cargo = ANY (other.cargos)
        OR (
          NOT (l.codigo_cargo = ANY (d.cargos)) AND length(l.codigo_cargo) <= 3
          AND regexp_replace(upper(l.codigo_cargo), '^0+(?=[0-9])', '', 'g')
              = regexp_replace(upper(other.cargos[1]), '^0+(?=[0-9])', '', 'g')
        )
      )
    )
  )
  AND (NOT EXISTS (
    SELECT 1 FROM private.acond_movimientos am
    WHERE am.origen='nueva' AND am.documentos_ids IS NOT NULL
      AND private.acond_clave(l.codigo_caja)=am.clave
      AND private.acond_cargo_clave(l.codigo_cargo)=ANY(private.acond_cargos_claves(am.cargos))
  ) OR EXISTS (
    SELECT 1 FROM private.acond_movimientos am
    JOIN LATERAL generate_subscripts(am.cargos,1) AS idx(pos) ON true
    WHERE am.origen='nueva' AND am.clave=private.acond_clave(l.codigo_caja)
      AND am.documentos_ids[idx.pos]=d.id
      AND private.acond_cargo_clave(am.cargos[idx.pos])=private.acond_cargo_clave(l.codigo_cargo)
  ))
  ORDER BY (l.fecha_envio IS NULL) DESC, l.updated_at DESC
  LIMIT 1
) live ON true;
