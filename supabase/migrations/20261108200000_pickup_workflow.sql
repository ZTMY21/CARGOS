-- Avisos de recojo: reserva, correo, programación, sustento y retiro separados.
alter table private.pickup_mail_batches
  add column pickup_workflow boolean not null default false,
  add column pickup_cancelled_at timestamptz,
  add column pickup_schedule jsonb not null default '{}';
alter table private.pickup_mail_events add column pickup_details jsonb;
drop trigger if exists trg_pickup_mail_auto_queue on private.box_conditioning;

create table private.pickup_visits (
  id uuid primary key,
  batch_id uuid not null references private.pickup_mail_batches(id),
  real_date date not null,
  pdf_id text not null unique,
  pdf_revision text not null,
  pdf_name text not null,
  pdf_size integer not null check (pdf_size between 1 and 5242880),
  pdf_pages integer not null check (pdf_pages between 1 and 2),
  pdf_sha256 text not null check(pdf_sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by uuid not null,
  confirmed_by uuid not null,
  confirmed_at timestamptz not null default clock_timestamp(),
  master_at timestamptz,
  history_at timestamptz,
  projection_at timestamptz,
  synced_by uuid,
  last_attempt timestamptz,
  sync_error text
);
create index pickup_visits_batch on private.pickup_visits(batch_id);
create table private.pickup_items (
  batch_id uuid not null references private.pickup_mail_batches(id),
  movement_id uuid not null references private.acond_movimientos(id),
  box_key text not null,
  snapshot jsonb not null,
  reserved boolean not null default true,
  visit_id uuid references private.pickup_visits(id),
  primary key(batch_id,box_key)
);
create unique index pickup_items_reserved on private.pickup_items(box_key) where reserved;
create unique index pickup_items_withdrawn on private.pickup_items(movement_id) where visit_id is not null;
alter table private.pickup_visits enable row level security;
alter table private.pickup_items enable row level security;
revoke all on private.pickup_visits,private.pickup_items from public,anon,authenticated;

create view private.pickup_available as
  select m.id,m.clave,m.preparada,
    jsonb_build_object('key',m.clave,'code',m.codigo,'cargos',m.cargos,'prepared_at',m.preparada,
      'type',case m.origen when 'nueva' then 'NUEVAS' else 'DEVOLUCION' end) box
  from private.acond_movimientos m
  join private.acond_cajas c on c.clave=m.clave and c.solicitud=m.solicitud and c.origen=m.origen
  where m.enviada is null and c.recibida is not null
    and (m.origen='nueva' or m.envio_original is not null)
    and not exists(select 1 from private.pickup_items i where i.box_key=m.clave and i.reserved)
    and not exists(select 1 from private.pickup_mail_boxes l join private.pickup_mail_batches b on b.id=l.batch_id
      where l.code=m.clave and b.status in ('PENDIENTE','PREPARADO'));
revoke all on private.pickup_available from public,anon,authenticated;

create function private.pickup_actor() returns uuid language plpgsql stable set search_path='' as $$
begin
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo requerido' using errcode='42501';
  end if;
  return auth.uid();
end
$$;

create function private.pickup_batch(b private.pickup_mail_batches) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',b.id,'workflow',b.pickup_workflow,'created_at',b.created_at,
    'status',case when b.pickup_cancelled_at is not null then 'CANCELADO' else b.status end,
    'subject',b.subject,'sender',b.sender_email,'to',b.recipients,'cc',b.copies,'signature',b.signature,
    'schedule',b.pickup_schedule,
    'boxes',coalesce((select jsonb_agg(i.snapshot order by i.snapshot->>'type',i.box_key)
      from private.pickup_items i where i.batch_id=b.id),'[]'),
    'events',coalesce((select jsonb_agg(e.pickup_details||jsonb_build_object('date',e.occurred_at,
      'actor',coalesce(u.raw_user_meta_data->>'kardex_username',u.raw_user_meta_data->>'name',e.actor_id::text)) order by e.id)
      from private.pickup_mail_events e left join auth.users u on u.id=e.actor_id
      where e.batch_id=b.id and e.action in ('PROGRAMADO','REPROGRAMADO')),'[]'),
    'visits',coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'date',v.real_date,'name',v.pdf_name,
      'synced',v.master_at is not null and v.history_at is not null and v.projection_at is not null,'master',v.master_at,'history',v.history_at,
      'error',v.sync_error,'attempt',v.last_attempt,'pages',v.pdf_pages,
      'actor',coalesce(u.raw_user_meta_data->>'kardex_username',u.raw_user_meta_data->>'name',v.confirmed_by::text),
      'codes',(select jsonb_agg(i.snapshot->>'code' order by i.box_key) from private.pickup_items i where i.visit_id=v.id)
    ) order by v.confirmed_at) from private.pickup_visits v left join auth.users u on u.id=v.confirmed_by where v.batch_id=b.id),'[]'))
$$;

create function public.kardex_pickup_workflow(p_action text,p_id uuid default null,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=private.pickup_actor();
  b private.pickup_mail_batches%rowtype;
  cfg private.pickup_mail_config%rowtype;
  selected text[];
  candidates jsonb;
  dates jsonb:='{}';
  kind text;
  due text;
  n integer;
  d integer;
begin
  if p_action='state' then
    return jsonb_build_object(
      'available',coalesce((select jsonb_agg(a.box order by a.preparada,a.clave)
        from private.pickup_available a where not exists(select 1 from private.pickup_available x where x.clave=a.clave and x.id<>a.id)),'[]'),
      'batches',coalesce((select jsonb_agg(
        (case when x.pickup_workflow then private.pickup_batch(x) else public.kardex_pickup_mail_detail(x.id)||jsonb_build_object('workflow',false) end)
        -array['signature','to','cc','sender']
        order by x.created_at desc) from private.pickup_mail_batches x),'[]'));
  end if;
  perform pg_advisory_xact_lock(66110435);
  select * into b from private.pickup_mail_batches where id=p_id for update;
  if p_action='prepare' then
    if p_id is null or jsonb_typeof(p_data->'keys') is distinct from 'array' then raise exception 'Selección inválida'; end if;
    select array_agg(value order by value) into selected from jsonb_array_elements_text(p_data->'keys');
    if found and b.id is not null then
      if b.created_by<>actor or not b.pickup_workflow or selected is distinct from
        (select array_agg(i.box_key order by i.box_key) from private.pickup_items i where i.batch_id=b.id)
        then raise exception 'El identificador pertenece a otro aviso'; end if;
      return jsonb_build_object('id',b.id);
    end if;
    if coalesce(cardinality(selected),0) not between 1 and 60 then raise exception 'Selecciona entre 1 y 60 cajas'; end if;
    select count(*) filter(where a.box->>'type'='NUEVAS'),count(*) filter(where a.box->>'type'='DEVOLUCION'),
      jsonb_agg(to_jsonb(a)) into n,d,candidates from private.pickup_available a where a.clave=any(selected)
      and not exists(select 1 from private.pickup_available x where x.clave=a.clave and x.id<>a.id);
    if n>30 or d>30 or n+d<>cardinality(selected) then raise exception 'Hay cajas repetidas, reservadas o fuera del límite por tipo'; end if;
    select * into cfg from private.pickup_mail_config where id;
    if cardinality(cfg.recipients)<1 or cfg.sender_email='' or cfg.signature_name='' or cfg.signature_company=''
      then raise exception 'Completa el remitente, destinatarios y firma'; end if;
    insert into private.pickup_mail_batches(id,created_by,recipients,copies,sender_email,signature,subject,pickup_workflow)
    values(p_id,actor,cfg.recipients,cfg.copies,cfg.sender_email,jsonb_build_object('name',cfg.signature_name,
      'position',cfg.signature_position,'area',cfg.signature_area,'company',cfg.signature_company,'contact',cfg.signature_contact),
      'Solicitud de recojo',true);
    -- Reutiliza la firma que captura el disparador y restaura el asunto con los conteos reales.
    update private.pickup_mail_batches set subject=case
      when cfg.subject_template='Solicitud de recojo | {{cantidad}} cajas nuevas | {{sede}} | {{fecha}}'
      then 'Solicitud de recojo | {{nuevas}} nuevas · {{devoluciones}} devolución | {{sede}} | {{fecha}}'
      else cfg.subject_template end where id=p_id;
    insert into private.pickup_items(batch_id,movement_id,box_key,snapshot)
      select p_id,(x->>'id')::uuid,x->>'clave',x->'box' from jsonb_array_elements(candidates) x;
    insert into private.pickup_mail_events(batch_id,action,actor_id) values(p_id,'CREADO',actor);
    return jsonb_build_object('id',p_id);
  end if;
  if b.id is null or not b.pickup_workflow or b.pickup_cancelled_at is not null then raise exception 'Aviso no disponible'; end if;
  if p_action='cancel' and b.status in ('PENDIENTE','PREPARADO') then
    update private.pickup_mail_batches set pickup_cancelled_at=clock_timestamp() where id=b.id;
    update private.pickup_items set reserved=false where batch_id=b.id;
    insert into private.pickup_mail_events(batch_id,action,actor_id) values(b.id,'CANCELADO',actor);
  elsif p_action='schedule' and b.status='CONFIRMADO' and jsonb_typeof(p_data)='object' then
    for kind,due in select key,value from jsonb_each_text(p_data) loop
      if kind not in ('NUEVAS','DEVOLUCION') or not exists(select 1 from private.pickup_items i where i.batch_id=b.id and i.snapshot->>'type'=kind)
        then raise exception 'Tipo de caja fuera del aviso'; end if;
      if nullif(due,'') is not null then
        if due !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Fecha inválida'; end if;
        dates:=dates||jsonb_build_object(kind,due::date);
      end if;
    end loop;
    if dates='{}' or exists(select 1 from private.pickup_items i where i.batch_id=b.id and i.visit_id is not null
      and (b.pickup_schedule->>(i.snapshot->>'type')) is distinct from (dates->>(i.snapshot->>'type'))
      and not exists(select 1 from private.pickup_items pending where pending.batch_id=b.id
        and pending.snapshot->>'type'=i.snapshot->>'type' and pending.visit_id is null))
      then raise exception 'Se requiere una fecha y las fechas de retiros realizados se conservan'; end if;
    if dates is distinct from b.pickup_schedule then
      update private.pickup_mail_batches set pickup_schedule=dates where id=b.id;
      insert into private.pickup_mail_events(batch_id,action,actor_id,pickup_details)
        values(b.id,case when b.pickup_schedule='{}' then 'PROGRAMADO' else 'REPROGRAMADO' end,actor,
          jsonb_build_object('previous',b.pickup_schedule,'next',dates));
    end if;
  else raise exception 'Acción incompatible con el estado del aviso';
  end if;
  return jsonb_build_object('id',b.id);
end
$$;

-- Mantiene el RPC y los avisos anteriores. CONFIRMADO sigue siendo únicamente el correo.
alter function public.kardex_pickup_mail_detail(uuid) rename to kardex_pickup_mail_detail_legacy;
create function public.kardex_pickup_mail_detail(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b private.pickup_mail_batches%rowtype;
begin
  perform private.pickup_actor();
  select * into b from private.pickup_mail_batches where id=p_id;
  if not b.pickup_workflow then return public.kardex_pickup_mail_detail_legacy(p_id); end if;
  return private.pickup_batch(b);
end
$$;

create function public.kardex_pickup_visit(p_action text,p_id uuid,p_visit uuid,p_data jsonb,p_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=private.pickup_actor();
  v private.pickup_visits%rowtype;
  b private.pickup_mail_batches%rowtype;
  m private.acond_movimientos%rowtype;
  keys text[];
  items uuid[];
  day date;
begin
  if not exists(select 1 from private.recepcion_maestro_produccion where id and habilitada
    and secreto_hash=sha256(convert_to(coalesce(p_secret,''),'UTF8')))
    then raise exception 'Integración de recojos no autorizada' using errcode='42501'; end if;
  if p_action='pdf' then
    select * into strict v from private.pickup_visits where id=p_visit and batch_id=p_id;
    return jsonb_build_object('fileId',v.pdf_id,'revision',v.pdf_revision,'name',v.pdf_name);
  end if;
  perform pg_advisory_xact_lock(66110435);
  select * into v from private.pickup_visits where id=p_visit and batch_id=p_id for update;
  if p_action='confirm' and v.id is null then
    select * into b from private.pickup_mail_batches where id=p_id for update;
    if b.status is distinct from 'CONFIRMADO' or not b.pickup_workflow or b.pickup_cancelled_at is not null
      then raise exception 'Primero registra el correo enviado'; end if;
    if jsonb_typeof(p_data->'codes') is distinct from 'array' then raise exception 'Faltan los códigos retirados'; end if;
    day:=(p_data->>'date')::date;
    select array_agg(private.acond_clave(x)) into keys from jsonb_array_elements_text(p_data->'codes') x;
    select array_agg(i.movement_id) into items from private.pickup_items i join private.acond_movimientos a on a.id=i.movement_id
      where i.batch_id=p_id and i.box_key=any(keys) and i.reserved and i.visit_id is null
        and b.pickup_schedule ? (i.snapshot->>'type') and a.enviada is null and a.preparada<=day;
    if day is null or day>(now() at time zone 'America/Lima')::date or
      coalesce(cardinality(keys),0) not between 1 and 60 or cardinality(keys) is distinct from cardinality(items)
      then raise exception 'Revisa la fecha y los códigos programados y pendientes'; end if;
    insert into private.pickup_visits(id,batch_id,real_date,pdf_id,pdf_revision,pdf_name,pdf_size,pdf_pages,pdf_sha256,uploaded_by,confirmed_by)
      values(p_visit,p_id,day,p_data->>'fileId',p_data->>'revision',p_data->>'name',
        (p_data->>'size')::integer,(p_data->>'pages')::integer,p_data->>'sha256',(p_data->>'uploadedBy')::uuid,actor)
      returning * into v;
    update private.pickup_items set visit_id=v.id,reserved=false where batch_id=b.id and movement_id=any(items);
    for m in select * from private.acond_movimientos where id=any(items) for update loop
      if m.origen='solicitada' then
        perform private.req4_accion(gen_random_uuid(),'devolver_caja',jsonb_build_object(
          'requerimiento',m.solicitud,'caja',m.codigo,'fecha',day,'acond_movimiento',m.id));
      end if;
      update private.acond_movimientos set enviada=day,despachada_por=actor,revision=2 where id=m.id;
    end loop;
  end if;
  if v.id is null then raise exception 'Visita no encontrada'; end if;
  if p_action='progress' then
    update private.pickup_visits set
      master_at=coalesce(master_at,case when p_data->>'destination'='master' then clock_timestamp() end),
      history_at=coalesce(history_at,case when p_data->>'destination'='history' then clock_timestamp() end),
      projection_at=coalesce(projection_at,case when p_data->>'destination'='projection' then clock_timestamp() end),
      last_attempt=clock_timestamp(),synced_by=actor,sync_error=left(p_data->>'error',100) where id=v.id returning * into v;
  end if;
  return jsonb_build_object('id',v.id,'verified',v.master_at is not null and v.history_at is not null and v.projection_at is not null,
    'master',v.master_at,'history',v.history_at,
    'lote',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from private.pickup_items i
      join private.acond_movimientos a on a.id=i.movement_id where i.visit_id=v.id),'[]'));
end
$$;

create function private.pickup_guard_reserved() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.enviada is null and new.enviada is not null and exists(
    select 1 from private.pickup_items i where i.movement_id=old.id and i.reserved
  ) then raise exception 'Confirma el retiro y adjunta el sustento desde Avisos de recojo'; end if;
  return new;
end
$$;
create trigger pickup_guard_reserved before update of enviada on private.acond_movimientos
  for each row execute function private.pickup_guard_reserved();

revoke all on function private.pickup_actor(),private.pickup_batch(private.pickup_mail_batches),
  private.pickup_guard_reserved() from public,anon,authenticated;
revoke all on function public.kardex_pickup_workflow(text,uuid,jsonb),public.kardex_pickup_visit(text,uuid,uuid,jsonb,text),
  public.kardex_pickup_mail_detail(uuid) from public,anon;
grant execute on function public.kardex_pickup_workflow(text,uuid,jsonb),public.kardex_pickup_visit(text,uuid,uuid,jsonb,text),
  public.kardex_pickup_mail_detail(uuid) to authenticated;

create function private.pickup_guard_cancelled() returns trigger language plpgsql set search_path='' as $$
begin
  if old.pickup_cancelled_at is not null and new.status is distinct from old.status then
    raise exception 'El aviso ya fue cancelado';
  end if;
  return new;
end
$$;
create trigger pickup_guard_cancelled before update of status on private.pickup_mail_batches
  for each row execute function private.pickup_guard_cancelled();
revoke all on function private.pickup_guard_cancelled() from public,anon,authenticated;
