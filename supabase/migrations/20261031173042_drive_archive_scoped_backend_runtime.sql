-- Archive-only backend capability. No operational table or row changes.
create table private.kardex_drive_runtime (
 id boolean primary key default true check(id),
 backend_key_sha256 text not null check(backend_key_sha256 ~ '^[a-f0-9]{64}$'),
 oauth_cipher text,
 updated_at timestamptz not null default now()
);
create table private.kardex_drive_oauth_sessions (
 id uuid primary key,
 payload jsonb not null,
 expires_at timestamptz not null default now()+interval '10 minutes'
);
alter table private.kardex_drive_runtime enable row level security;
alter table private.kardex_drive_oauth_sessions enable row level security;
revoke all on private.kardex_drive_runtime,private.kardex_drive_oauth_sessions from public,anon,authenticated,service_role;
create function public.kardex_drive_runtime_access(p_key_sha256 text,p_action text,p_id uuid default null,p_payload jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from private.kardex_drive_runtime where id and backend_key_sha256=p_key_sha256) then
  raise exception 'ARCHIVE_BACKEND_UNAUTHORIZED' using errcode='42501';
 end if;
 if p_action='authorize' then return jsonb_build_object('authorized',true);
 elsif p_action='get-oauth' then
  select jsonb_build_object('cipher',oauth_cipher) into result from private.kardex_drive_runtime where id;return result;
 elsif p_action='set-oauth' then
  if length(p_payload->>'cipher') not between 40 and 16000 or p_payload->>'cipher' !~ '^[A-Za-z0-9+/=]+$' then raise exception 'INVALID_CIPHER';end if;
  update private.kardex_drive_runtime set oauth_cipher=p_payload->>'cipher',updated_at=now() where id;return jsonb_build_object('saved',true);
 elsif p_action='create-session' then
  -- Only disposable OAuth sessions expire; business data is never deleted.
  delete from private.kardex_drive_oauth_sessions where expires_at<now();
  if (select count(*) from private.kardex_drive_oauth_sessions)>=20 or pg_column_size(p_payload)>8000 then raise exception 'OAUTH_SESSION_LIMIT';end if;
  insert into private.kardex_drive_oauth_sessions(id,payload) values(p_id,p_payload);return jsonb_build_object('created',true);
 elsif p_action='consume-session' then
  delete from private.kardex_drive_oauth_sessions where id=p_id and expires_at>now() returning payload into result;return result;
 end if;
 raise exception 'INVALID_ARCHIVE_OPERATION';
end;
$$;
revoke all on function public.kardex_drive_runtime_access(text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kardex_drive_runtime_access(text,text,uuid,jsonb) to service_role;
