-- Email confirmation grants read access; administrator membership alone grants writes.
create or replace function private.kardex_has_access(admin_only boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
  select (
    session_user in ('postgres','supabase_admin')
    and coalesce(current_setting('role',true),'none') in ('none','postgres','supabase_admin')
  ) or ((select auth.uid()) is not null and exists (
    select 1 from auth.users u
    where u.id=(select auth.uid()) and u.email_confirmed_at is not null
      and coalesce(u.is_anonymous,false)=false
      and (not admin_only or exists (
        select 1 from private.kardex_miembros m where m.email=lower(u.email) and m.rol='admin'
      ))
  ));
$$;
drop function if exists public.kardex_guests(text,text);
drop function if exists private.kardex_guests(text,text);
