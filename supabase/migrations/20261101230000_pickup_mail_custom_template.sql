-- Vista previa: configuración de plantilla e imagen de firma para avisos de recojo.
-- Esta migración es ADITIVA. Mantener en la rama de preview hasta su aprobación.
alter table private.pickup_mail_config
 add column if not exists subject_template text not null
 default 'Solicitud de recojo | {{cantidad}} cajas nuevas | {{sede}} | {{fecha}}',
 add column if not exists greeting text not null default 'Estimados(as),',
 add column if not exists introduction text not null
 default 'Se comunica que tenemos {{cantidad}} cajas nuevas acondicionadas y listas para recojo en {{sede}}.',
 add column if not exists request_text text not null
 default 'Agradeceremos gestionar la solicitud de recojo ante Iron Mountain y confirmar la fecha estimada de atención.',
 add column if not exists closing_text text not null
 default 'Quedamos atentos a la confirmación de la coordinación.',
 add column if not exists logo_png_base64 text not null default '';

create or replace function public.kardex_pickup_mail_brand_state()
returns jsonb language plpgsql security definer set search_path='' as $func$
declare v private.pickup_mail_config%rowtype;
begin
 if auth.uid() is null or not private.kardex_has_access(true) then
   raise exception 'Acceso administrativo requerido' using errcode='42501';
 end if;
 select * into v from private.pickup_mail_config where id=true;
 return jsonb_build_object(
  'subject',v.subject_template,'greeting',v.greeting,
  'introduction',v.introduction,'request',v.request_text,'closing',v.closing_text,
  'logo',v.logo_png_base64
 );
end;$func$;

create or replace function public.kardex_pickup_mail_configure_v2(
 p_sender text,p_recipients text[],p_copies text[],
 p_name text,p_position text,p_area text,p_company text,p_contact text,
 p_subject text,p_greeting text,p_introduction text,p_request text,p_closing text,
 p_logo text
) returns jsonb language plpgsql security definer set search_path='' as $func$
declare logo_bytes bytea;
begin
 if auth.uid() is null or not private.kardex_has_access(true) then
   raise exception 'Acceso administrativo requerido' using errcode='42501';
 end if;
 if length(coalesce(p_subject,'')) not between 15 and 180 or
    length(coalesce(p_greeting,'')) not between 3 and 100 or
    length(coalesce(p_introduction,'')) not between 15 and 1200 or
    length(coalesce(p_request,'')) not between 15 and 1200 or
    length(coalesce(p_closing,'')) not between 3 and 400 or
    (coalesce(p_subject,'') || coalesce(p_greeting,'') || coalesce(p_introduction,'') ||
     coalesce(p_request,'') || coalesce(p_closing,'')) ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]' or
    p_subject ~ '[\r\n]' then
   raise exception 'Formato o extensión del correo inválidos' using errcode='22023';
 end if;
 if length(coalesce(p_logo,''))>170000 then
   raise exception 'Logotipo demasiado grande' using errcode='22023';
 end if;
 if coalesce(p_logo,'')<>'' then
   if p_logo !~ '^[A-Za-z0-9+/=]+$' or left(p_logo,12)<>'iVBORw0KGgo' then
     raise exception 'El logotipo debe ser un PNG válido' using errcode='22023';
   end if;
   begin logo_bytes:=decode(p_logo,'base64');
   exception when others then raise exception 'Logotipo PNG inválido' using errcode='22023';end;
   if octet_length(logo_bytes)>120000 or substring(logo_bytes from 1 for 8)<>decode('89504e470d0a1a0a','hex') then
     raise exception 'El logotipo debe ser PNG, máximo 120 KB' using errcode='22023';
   end if;
 end if;
 perform public.kardex_pickup_mail_configure(
  p_sender,p_recipients,p_copies,p_name,p_position,p_area,p_company,p_contact
 );
 update private.pickup_mail_config set
  subject_template=trim(p_subject),greeting=trim(p_greeting),
  introduction=trim(p_introduction),request_text=trim(p_request),
  closing_text=trim(p_closing),logo_png_base64=coalesce(p_logo,''),
  updated_by=auth.uid(),updated_at=now()
 where id=true;
 return jsonb_build_object('saved',true);
end;$func$;

-- Captura la plantilla y logo en el momento de preparar cada lote de 30.
-- Los avisos ya existentes conservan su contenido original.
create or replace function private.kardex_pickup_mail_snapshot_brand()
returns trigger language plpgsql security definer set search_path='' as $func$
declare cfg private.pickup_mail_config%rowtype;
begin
 select * into cfg from private.pickup_mail_config where id=true;
 new.signature:=coalesce(new.signature,'{}'::jsonb) || jsonb_build_object(
  'greeting',cfg.greeting,'introduction',cfg.introduction,
  'request',cfg.request_text,'closing',cfg.closing_text,
  'logo_png_base64',cfg.logo_png_base64,'sede','CD Santa Anita'
 );
 new.subject:=replace(replace(replace(cfg.subject_template,
  '{{cantidad}}','30'),'{{sede}}','CD Santa Anita'),
  '{{fecha}}',to_char(new.created_at AT TIME ZONE 'America/Lima','DD/MM/YYYY'));
 return new;
end;$func$;
drop trigger if exists trg_pickup_mail_snapshot_brand on private.pickup_mail_batches;
create trigger trg_pickup_mail_snapshot_brand before insert
on private.pickup_mail_batches for each row
execute function private.kardex_pickup_mail_snapshot_brand();

revoke all on function public.kardex_pickup_mail_brand_state() from public,anon;
revoke all on function public.kardex_pickup_mail_configure_v2(
 text,text[],text[],text,text,text,text,text,text,text,text,text,text,text
) from public,anon;
grant execute on function public.kardex_pickup_mail_brand_state() to authenticated,service_role;
grant execute on function public.kardex_pickup_mail_configure_v2(
 text,text[],text[],text,text,text,text,text,text,text,text,text,text,text
) to authenticated,service_role;
revoke all on function private.kardex_pickup_mail_snapshot_brand() from public,anon,authenticated;
