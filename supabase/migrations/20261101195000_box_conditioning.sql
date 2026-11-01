-- Fase de acondicionamiento: registro transaccional independiente de Iron Mountain.
-- Nunca modifica CARGOS ENVIADOS ni elimina relaciones del Kárdex.
create table if not exists private.box_conditioning (
 code text primary key check (code ~ '^[0-9]{5,35}$'),
 original_code text not null,
 cargos text[] not null,
 classification text not null check (classification in ('POR SOLICITUD','Cajas Nuevas','Reparación')),
 status text not null default 'EN_PREPARACION' check (status in ('EN_PREPARACION','OBSERVADA','LISTA')),
 observation text not null default '',
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 responsible_id uuid not null,
 updated_at timestamptz not null default now(),
 check (array_length(cargos,1) between 1 and 50),
 check ((status='LISTA')=(finished_at is not null))
);
create index if not exists box_conditioning_status_idx on private.box_conditioning(status,updated_at desc);
create table if not exists private.box_conditioning_events(
 id bigint generated always as identity primary key,
 code text not null references private.box_conditioning(code),
 action text not null,
 actor_id uuid not null,
 created_at timestamptz not null default now(),
 detail jsonb not null default '{}'::jsonb
);
create index if not exists box_conditioning_events_code_idx on private.box_conditioning_events(code,created_at desc);
revoke all on private.box_conditioning from public,anon,authenticated;
revoke all on private.box_conditioning_events from public,anon,authenticated;

create or replace function public.kardex_box_conditioning_list()
returns jsonb language plpgsql security definer set search_path='' as $func$
begin
 if auth.uid() is null or not private.kardex_has_access(true) then
  raise exception 'Solo administradores' using errcode='42501';
 end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object(
   'code',b.code,'original_code',b.original_code,'cargos',b.cargos,
   'classification',b.classification,'status',b.status,'observation',b.observation,
   'started_at',b.started_at,'finished_at',b.finished_at,'responsible_id',b.responsible_id,
   'updated_at',b.updated_at
  ) order by b.updated_at desc)
  from (select * from private.box_conditioning order by updated_at desc limit 3000) b
 ),'[]'::jsonb);
end;
$func$;

create or replace function public.kardex_box_conditioning_write(
 p_action text,
 p_box text,
 p_cargos text[] default array[]::text[],
 p_classification text default '',
 p_observation text default ''
)
returns jsonb language plpgsql security definer set search_path='' as $func$
declare
 v_code text;
 v_original text;
 v_now timestamptz:=now();
 v_existing private.box_conditioning%rowtype;
 v_row private.box_conditioning%rowtype;
 v_cargos text[];
 v_known text[];
 v_class text;
 v_shipped boolean;
 v_valid_count integer;
begin
 if auth.uid() is null or not private.kardex_has_access(true) then
  raise exception 'Solo administradores' using errcode='42501';
 end if;
 if p_action not in ('iniciar','observar','resolver','finalizar') then
  raise exception 'Acción inválida' using errcode='22023';
 end if;
 v_original:=upper(trim(coalesce(p_box,'')));
 if v_original !~ '^(TD|T|P)?[0-9][0-9-]*$' then
  raise exception 'Código de caja inválido' using errcode='22023';
 end if;
 v_code:=regexp_replace(v_original,'[^0-9]','','g');
 if length(v_code)<5 or length(v_code)>35 then
  raise exception 'Longitud de caja incorrecta' using errcode='22023';
 end if;
 if length(coalesce(p_observation,''))>300 then
  raise exception 'Observación demasiado larga' using errcode='22023';
 end if;
 if p_action='iniciar' then
  v_class:=case trim(coalesce(p_classification,''))
    when 'POR SOLICITUD' then 'POR SOLICITUD'
    when 'Cajas Nuevas' then 'Cajas Nuevas'
    when 'Reparación' then 'Reparación'
    else null end;
  if v_class is null then raise exception 'Selecciona clasificación de caja' using errcode='22023';end if;
  -- Bloquear envío ya registrado en la fuente conocida; si el origen está atrasado
  -- no se declara como actualizado ni se altera el origen.
  select exists(select 1 from public.im_envios_cargos_live l
    where regexp_replace(upper(l.codigo_caja),'[^0-9]','','g')=v_code
    and l.fecha_envio is not null) into v_shipped;
  if v_shipped then raise exception 'Caja ya enviada según el último registro IM' using errcode='23514';end if;
  select array_agg(distinct upper(trim(l.codigo_cargo)) order by upper(trim(l.codigo_cargo)))
    into v_known from public.im_envios_cargos_live l
   where regexp_replace(upper(l.codigo_caja),'[^0-9]','','g')=v_code
     and l.fecha_envio is null;
  select coalesce(array_agg(distinct upper(trim(v)) order by upper(trim(v))),array[]::text[])
    into v_cargos from unnest(coalesce(p_cargos,array[]::text[])) as t(v) where trim(v)<>'';
  if v_known is not null and array_length(v_known,1)>0 then
    if cardinality(v_cargos)>0 and v_cargos<>v_known then
      raise exception 'Los cargos no coinciden con Iron Mountain; actualiza la fuente antes de registrar'
       using errcode='23514';
    end if;
    v_cargos:=v_known;
  end if;
  if cardinality(v_cargos)<1 or cardinality(v_cargos)>50 or
     exists(select 1 from unnest(v_cargos) as t(c) where c !~ '^[0-9]{1,7}[A-Z]?$') then
   raise exception 'Indica de 1 a 50 cargos válidos' using errcode='22023';
  end if;
  if v_known is null then
    -- Para cajas nuevas, exigir que cada cargo tenga una relación válida en Kárdex.
    select count(*) into v_valid_count
    from unnest(v_cargos) as t(c)
    where exists(select 1 from public.documentos d where c=any(d.cargos))
       or exists(select 1 from public.kardex_live_ingresos l where l.cargo=c);
    if v_valid_count<>cardinality(v_cargos) then
      raise exception 'Hay cargos que no existen en el Kárdex' using errcode='23514';
    end if;
  end if;
  insert into private.box_conditioning(code,original_code,cargos,classification,status,observation,responsible_id)
  values(v_code,v_original,v_cargos,v_class,'EN_PREPARACION','',auth.uid())
  on conflict (code) do nothing;
  if found then
   insert into private.box_conditioning_events(code,action,actor_id,detail)
     values(v_code,'iniciar',auth.uid(),jsonb_build_object('cargos',v_cargos,'classification',v_class));
  end if;
 else
  select * into v_existing from private.box_conditioning where code=v_code for update;
  if not found then raise exception 'Primero inicia el acondicionamiento de la caja' using errcode='23514';end if;
  if p_action='observar' then
   if v_existing.status='LISTA' then raise exception 'La caja ya está lista; requiere revisión administrativa' using errcode='23514';end if;
   if trim(coalesce(p_observation,''))='' then raise exception 'Describe la incidencia' using errcode='22023';end if;
   update private.box_conditioning set status='OBSERVADA',observation=trim(p_observation),updated_at=v_now where code=v_code;
  elsif p_action='resolver' then
   if v_existing.status<>'OBSERVADA' then raise exception 'La caja no está observada' using errcode='23514';end if;
   update private.box_conditioning set status='EN_PREPARACION',observation='',updated_at=v_now where code=v_code;
  elsif p_action='finalizar' then
   if v_existing.status='OBSERVADA' then raise exception 'Resuelve la incidencia antes de finalizar' using errcode='23514';end if;
   if v_existing.status<>'LISTA' then
    update private.box_conditioning set status='LISTA',finished_at=v_now,updated_at=v_now where code=v_code;
   end if;
  end if;
  if p_action='finalizar' and v_existing.status='LISTA' then
   -- Petición repetida: no crear otro evento ni modificar fecha de finalización.
   select * into v_row from private.box_conditioning where code=v_code;
   return to_jsonb(v_row);
  end if;
  insert into private.box_conditioning_events(code,action,actor_id,detail)
    values(v_code,p_action,auth.uid(),jsonb_build_object('observation',left(coalesce(p_observation,''),300)));
 end if;
 select * into v_row from private.box_conditioning where code=v_code;
 return to_jsonb(v_row);
end;
$func$;
revoke all on function public.kardex_box_conditioning_list() from public,anon;
revoke all on function public.kardex_box_conditioning_write(text,text,text[],text,text) from public,anon;
grant execute on function public.kardex_box_conditioning_list() to authenticated,service_role;
grant execute on function public.kardex_box_conditioning_write(text,text,text[],text,text) to authenticated,service_role;
