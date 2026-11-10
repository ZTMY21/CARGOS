-- Solicitudes de recojo que el administrador ya envió fuera del aplicativo.
create or replace function private.pickup_batch(b private.pickup_mail_batches) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',b.id,'workflow',b.pickup_workflow,
    'external_mail',exists(select 1 from private.pickup_mail_events e where e.batch_id=b.id and e.action='CORREO_EXTERNO'),'created_at',b.created_at,
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

create or replace function public.kardex_pickup_workflow(p_action text,p_id uuid default null,p_data jsonb default '{}')
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
  if p_action in ('prepare','register_sent') then
    if p_id is null or jsonb_typeof(p_data->'keys') is distinct from 'array' then raise exception 'Selección inválida'; end if;
    select array_agg(value order by value) into selected from jsonb_array_elements_text(p_data->'keys');
    if found and b.id is not null then
      if b.created_by<>actor or not b.pickup_workflow or
        (p_action='register_sent') is distinct from (exists(select 1 from private.pickup_mail_events e
          where e.batch_id=b.id and e.action='CORREO_EXTERNO')) or selected is distinct from
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
    if p_action='prepare' and (cardinality(cfg.recipients)<1 or cfg.sender_email='' or cfg.signature_name='' or cfg.signature_company='')
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
      select p_id,case when not (x->'box' ? 'master_id') then (x->>'id')::uuid end,x->>'clave',x->'box' from jsonb_array_elements(candidates) x;
    insert into private.pickup_mail_events(batch_id,action,actor_id) values(p_id,'CREADO',actor);
    if p_action='register_sent' then
      update private.pickup_mail_batches set status='CONFIRMADO',confirmed_at=clock_timestamp(),confirmed_by=actor where id=p_id;
      insert into private.pickup_mail_events(batch_id,action,actor_id) values(p_id,'CORREO_EXTERNO',actor);
    end if;
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
