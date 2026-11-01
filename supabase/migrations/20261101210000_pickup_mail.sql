-- Correos de recojo: cola de preparación, no envía mensajes ni crea registros en Sheets.
-- Registros privados, acciones administrativas auditables y batches exactamente de 30 cajas.
create table if not exists private.pickup_mail_config(
 id boolean primary key default true check(id),
 sender_email text not null default '',
 recipients text[] not null default '{}',
 copies text[] not null default '{}',
 signature_name text not null default '',
 signature_position text not null default '',
 signature_area text not null default '',
 signature_company text not null default '',
 signature_contact text not null default '',
 updated_by uuid,
 updated_at timestamptz not null default now()
);
insert into private.pickup_mail_config(id) values(true) on conflict do nothing;

create table if not exists private.pickup_mail_batches(
 id uuid primary key default gen_random_uuid(),
 status text not null default 'PENDIENTE'
   check (status in('PENDIENTE','PREPARADO','CONFIRMADO')),
 created_by uuid not null,
 created_at timestamptz not null default now(),
 prepared_at timestamptz,
 confirmed_at timestamptz,
 confirmed_by uuid,
 recipients text[] not null,
 copies text[] not null,
 sender_email text not null,
 signature jsonb not null,
 subject text not null,
 check ((status='CONFIRMADO') = (confirmed_at is not null))
);
create index if not exists pickup_mail_batches_created_idx on private.pickup_mail_batches(created_at desc);
create table if not exists private.pickup_mail_boxes(
 code text primary key references private.box_conditioning(code),
 batch_id uuid not null references private.pickup_mail_batches(id),
 inserted_at timestamptz not null default now()
);
create index if not exists pickup_mail_boxes_batch_idx on private.pickup_mail_boxes(batch_id);
create table if not exists private.pickup_mail_events(
 id bigint generated always as identity primary key,
 batch_id uuid not null references private.pickup_mail_batches(id),
 action text not null,
 actor_id uuid not null,
 occurred_at timestamptz not null default now()
);
create index if not exists pickup_mail_events_batch_idx on private.pickup_mail_events(batch_id,occurred_at desc);
alter table private.pickup_mail_config enable row level security;
alter table private.pickup_mail_batches enable row level security;
alter table private.pickup_mail_boxes enable row level security;
alter table private.pickup_mail_events enable row level security;
revoke all on private.pickup_mail_config,private.pickup_mail_batches,private.pickup_mail_boxes,private.pickup_mail_events from public,anon,authenticated;

create or replace function public.kardex_pickup_mail_configure(
 p_sender text,p_recipients text[],p_copies text[],
 p_name text,p_position text,p_area text,p_company text,p_contact text
) returns jsonb language plpgsql security definer set search_path='' as $func$
declare v_to text[];v_cc text[];
begin
 if auth.uid() is null or not private.kardex_has_access(true) then
   raise exception 'Acceso administrativo requerido' using errcode='42501';
 end if;
 if length(coalesce(p_sender,''))>180 or length(coalesce(p_name,''))>120 or
    length(coalesce(p_position,''))>120 or length(coalesce(p_area,''))>120 or
    length(coalesce(p_company,''))>120 or length(coalesce(p_contact,''))>240 then
    raise exception 'Datos demasiado largos' using errcode='22023';
 end if;
 if coalesce(p_sender,'')<>'' and
    trim(p_sender) !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then
    raise exception 'Remitente inválido' using errcode='22023';
 end if;
 select coalesce(array_agg(lower(trim(x)) order by lower(trim(x))),array[]::text[])
   into v_to from (select distinct unnest(coalesce(p_recipients,array[]::text[])) as x) s
   where trim(x)<>'';
 select coalesce(array_agg(lower(trim(x)) order by lower(trim(x))),array[]::text[])
   into v_cc from (select distinct unnest(coalesce(p_copies,array[]::text[])) as x) s
   where trim(x)<>'';
 if cardinality(v_to)>10 or cardinality(v_cc)>20 or exists(
   select 1 from unnest(v_to||v_cc) x where
   x !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' or length(x)>180
 ) then raise exception 'Destinatarios o copias inválidos' using errcode='22023';end if;
 update private.pickup_mail_config set
  sender_email=lower(trim(coalesce(p_sender,''))),recipients=v_to,copies=v_cc,
  signature_name=trim(coalesce(p_name,'')),
  signature_position=trim(coalesce(p_position,'')),
  signature_area=trim(coalesce(p_area,'')),
  signature_company=trim(coalesce(p_company,'')),
  signature_contact=trim(coalesce(p_contact,'')),
  updated_by=auth.uid(),updated_at=now() where id=true;
 return jsonb_build_object('saved',true);
end;$func$;

create or replace function public.kardex_pickup_mail_state()
returns jsonb language plpgsql security definer set search_path='' as $func$
declare cfg private.pickup_mail_config%rowtype; v_ready integer;
begin
 if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo requerido' using errcode='42501';
 end if;
 select * into cfg from private.pickup_mail_config where id=true;
 select count(*) into v_ready from private.box_conditioning b
  where b.classification='Cajas Nuevas' and b.status='LISTA' and b.finished_at is not null
  and not exists(select 1 from private.pickup_mail_boxes pb where pb.code=b.code)
  and not exists(select 1 from public.im_envios_cargos_live l
    where regexp_replace(upper(l.codigo_caja),'[^0-9]','','g')=b.code
    and l.fecha_envio is not null);
 return jsonb_build_object(
 'ready',v_ready,'threshold',30,
 'config',jsonb_build_object('sender',cfg.sender_email,'to',cfg.recipients,'cc',cfg.copies,
   'name',cfg.signature_name,'position',cfg.signature_position,
   'area',cfg.signature_area,'company',cfg.signature_company,'contact',cfg.signature_contact),
 'batches',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'status',q.status,
   'created_at',q.created_at,'prepared_at',q.prepared_at,'confirmed_at',q.confirmed_at,
   'subject',q.subject,'boxes',q.boxes) order by q.created_at desc)
    from (select b.id,b.status,b.created_at,b.prepared_at,b.confirmed_at,b.subject,
      (select count(*) from private.pickup_mail_boxes pb where pb.batch_id=b.id) boxes
      from private.pickup_mail_batches b order by b.created_at desc limit 50) q),'[]'::jsonb));
end;$func$;

create or replace function public.kardex_pickup_mail_prepare()
returns jsonb language plpgsql security definer set search_path='' as $func$
declare cfg private.pickup_mail_config%rowtype; v_codes text[]; v_id uuid;
begin
 if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo requerido' using errcode='42501';
 end if;
 -- Serializa las preparaciones, incluso entre varios administradores.
 perform pg_advisory_xact_lock(5482311601);
 select * into cfg from private.pickup_mail_config where id=true;
 if cardinality(cfg.recipients)<1 or cfg.sender_email='' or cfg.signature_name='' or cfg.signature_company='' then
   raise exception 'Completa destinatarios, remitente, nombre y empresa de la firma' using errcode='22023';
 end if;
 select array_agg(candidate.code order by candidate.finished_at,candidate.code) into v_codes
 from (
   select b.code,b.finished_at from private.box_conditioning b
   where b.classification='Cajas Nuevas' and b.status='LISTA' and b.finished_at is not null
     and not exists(select 1 from private.pickup_mail_boxes pb where pb.code=b.code)
     and not exists(select 1 from public.im_envios_cargos_live l
       where regexp_replace(upper(l.codigo_caja),'[^0-9]','','g')=b.code
       and l.fecha_envio is not null)
   order by b.finished_at,b.code limit 30 for update of b
 ) candidate;
 if coalesce(cardinality(v_codes),0)<30 then
    raise exception 'Aún no existen 30 cajas nuevas listas sin comunicar' using errcode='23514';
 end if;
 insert into private.pickup_mail_batches(
  created_by,recipients,copies,sender_email,signature,subject
 ) values (
  auth.uid(),cfg.recipients,cfg.copies,cfg.sender_email,
  jsonb_build_object('name',cfg.signature_name,'position',cfg.signature_position,
    'area',cfg.signature_area,'company',cfg.signature_company,'contact',cfg.signature_contact),
  'Solicitud de recojo de 30 cajas nuevas | CD Santa Anita'
 ) returning id into v_id;
 insert into private.pickup_mail_boxes(code,batch_id)
 select unnest(v_codes),v_id;
 insert into private.pickup_mail_events(batch_id,action,actor_id) values(v_id,'CREADO',auth.uid());
 return jsonb_build_object('id',v_id,'count',30,'status','PENDIENTE');
end;$func$;

create or replace function public.kardex_pickup_mail_detail(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $func$
declare b private.pickup_mail_batches%rowtype;
begin
 if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo requerido' using errcode='42501';
 end if;
 select * into b from private.pickup_mail_batches where id=p_id;
 if not found then raise exception 'Solicitud no encontrada' using errcode='22023';end if;
 return jsonb_build_object(
   'id',b.id,'status',b.status,'created_at',b.created_at,'subject',b.subject,
   'sender',b.sender_email,'to',b.recipients,'cc',b.copies,'signature',b.signature,
   'boxes',coalesce((select jsonb_agg(jsonb_build_object(
      'code',c.original_code,'cargos',c.cargos,'classification',c.classification,
      'finished_at',c.finished_at) order by c.finished_at,c.code)
      from private.pickup_mail_boxes link
      join private.box_conditioning c on c.code=link.code
      where link.batch_id=b.id),'[]'::jsonb)
 );
end;$func$;

create or replace function public.kardex_pickup_mail_mark(p_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $func$
declare b private.pickup_mail_batches%rowtype;
begin
 if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo requerido' using errcode='42501';
 end if;
 if p_action not in ('PREPARADO','CONFIRMADO') then
    raise exception 'Acción inválida' using errcode='22023';
 end if;
 select * into b from private.pickup_mail_batches where id=p_id for update;
 if not found then raise exception 'Solicitud no encontrada' using errcode='22023';end if;
 if b.status=p_action then return jsonb_build_object('id',b.id,'status',b.status,'unchanged',true);end if;
 if p_action='PREPARADO' and b.status='PENDIENTE' then
    update private.pickup_mail_batches set status='PREPARADO',prepared_at=now() where id=p_id;
 elsif p_action='CONFIRMADO' and b.status='PREPARADO' then
    update private.pickup_mail_batches set status='CONFIRMADO',confirmed_at=now(),confirmed_by=auth.uid() where id=p_id;
 else
    raise exception 'Acción no permitida para estado actual' using errcode='23514';
 end if;
 insert into private.pickup_mail_events(batch_id,action,actor_id)
 values(p_id,p_action,auth.uid());
 return jsonb_build_object('id',p_id,'status',p_action);
end;$func$;

revoke all on function public.kardex_pickup_mail_configure(text,text[],text[],text,text,text,text,text) from public,anon;
revoke all on function public.kardex_pickup_mail_state() from public,anon;
revoke all on function public.kardex_pickup_mail_prepare() from public,anon;
revoke all on function public.kardex_pickup_mail_detail(uuid) from public,anon;
revoke all on function public.kardex_pickup_mail_mark(uuid,text) from public,anon;
grant execute on function public.kardex_pickup_mail_configure(text,text[],text[],text,text,text,text,text) to authenticated,service_role;
grant execute on function public.kardex_pickup_mail_state() to authenticated,service_role;
grant execute on function public.kardex_pickup_mail_prepare() to authenticated,service_role;
grant execute on function public.kardex_pickup_mail_detail(uuid) to authenticated,service_role;
grant execute on function public.kardex_pickup_mail_mark(uuid,text) to authenticated,service_role;
