-- Al finalizar la caja número 30 se crea el aviso PENDIENTE.
-- Nunca envía email ni modifica la preparación si falla la cola.
create or replace function private.kardex_pickup_mail_auto_queue()
returns trigger language plpgsql security definer set search_path='' as $func$
declare cfg private.pickup_mail_config%rowtype; v_codes text[]; v_id uuid;
begin
 if new.status<>'LISTA' or new.classification<>'Cajas Nuevas' or
    old.status='LISTA' or auth.uid() is null or not private.kardex_has_access(true) then
   return new;
 end if;
 select * into cfg from private.pickup_mail_config where id=true;
 if cardinality(cfg.recipients)<1 or cfg.sender_email='' or
    cfg.signature_name='' or cfg.signature_company='' then
   return new; -- Sin firma real no se preparan correos automáticos.
 end if;
 perform pg_advisory_xact_lock(5482311601);
 loop
  select array_agg(b.code order by b.finished_at,b.code) into v_codes from (
    select code,finished_at from private.box_conditioning b
    where b.classification='Cajas Nuevas' and b.status='LISTA' and b.finished_at is not null
      and not exists(select 1 from private.pickup_mail_boxes pb where pb.code=b.code)
      and not exists(select 1 from public.im_envios_cargos_live l
       where regexp_replace(upper(l.codigo_caja),'[^0-9]','','g')=b.code
       and l.fecha_envio is not null)
    order by b.finished_at,b.code limit 30 for update of b
  ) b;
  exit when coalesce(cardinality(v_codes),0)<30;
  insert into private.pickup_mail_batches(created_by,recipients,copies,sender_email,signature,subject)
  values(auth.uid(),cfg.recipients,cfg.copies,cfg.sender_email,
    jsonb_build_object('name',cfg.signature_name,'position',cfg.signature_position,
      'area',cfg.signature_area,'company',cfg.signature_company,'contact',cfg.signature_contact),
    'Solicitud de recojo de 30 cajas nuevas | CD Santa Anita')
    returning id into v_id;
  insert into private.pickup_mail_boxes(code,batch_id) select unnest(v_codes),v_id;
  insert into private.pickup_mail_events(batch_id,action,actor_id)
    values(v_id,'GENERADO_AUTOMATICAMENTE',auth.uid());
 end loop;
 return new;
exception when others then
 -- Nunca impedir registrar una caja real debido al módulo de correos.
 raise warning 'KARDEX_PICKUP_MAIL_QUEUE_PENDING';
 return new;
end;$func$;
drop trigger if exists trg_pickup_mail_auto_queue on private.box_conditioning;
create trigger trg_pickup_mail_auto_queue
after update of status on private.box_conditioning
for each row when (old.status is distinct from new.status and new.status='LISTA')
execute function private.kardex_pickup_mail_auto_queue();
revoke all on function private.kardex_pickup_mail_auto_queue() from public,anon,authenticated;
