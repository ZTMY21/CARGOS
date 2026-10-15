-- Existing non-admin memberships become read-only; only approved, confirmed users can read.
alter table private.kardex_miembros drop constraint if exists kardex_miembros_rol_check;
alter table private.kardex_miembros add constraint kardex_miembros_rol_check check (rol in ('editor','viewer','admin'));
alter table private.kardex_miembros alter column rol set default 'viewer';
update private.kardex_miembros set rol='viewer' where rol='editor';
alter policy kardex_documentos_insert on public.documentos with check ((select private.kardex_has_access(true)));
alter policy kardex_documentos_update on public.documentos using ((select private.kardex_has_access(true))) with check ((select private.kardex_has_access(true)));
alter policy kardex_documentos_delete on public.documentos using ((select private.kardex_has_access(true)));
alter policy kardex_requerimientos_insert on public.requerimientos with check ((select private.kardex_has_access(true)));
alter policy kardex_requerimientos_update on public.requerimientos using ((select private.kardex_has_access(true))) with check ((select private.kardex_has_access(true)));
alter policy kardex_requerimientos_delete on public.requerimientos using ((select private.kardex_has_access(true)));

create or replace function private.kardex_guests(action text, guest_email text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare normalized text := lower(trim(guest_email));
begin
  if (select auth.uid()) is null or not private.kardex_has_access(true) then
    raise exception 'Solo el administrador puede gestionar invitados' using errcode='42501';
  end if;
  if action not in ('list','add','remove') or action is null then raise exception 'Acción inválida'; end if;
  if action <> 'list' then
    if normalized is null or length(normalized)>254 or normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Correo inválido'; end if;
    if exists(select 1 from private.kardex_miembros where email=normalized and rol='admin') then
      raise exception 'No se puede modificar al administrador';
    end if;
    if action='add' then
      insert into private.kardex_miembros(email,rol) values(normalized,'viewer') on conflict(email) do nothing;
    else
      delete from private.kardex_miembros where email=normalized and rol<>'admin';
    end if;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('email',email,'rol','viewer') order by email) from private.kardex_miembros where rol<>'admin'),'[]'::jsonb);
end;
$$;
revoke all on function private.kardex_guests(text,text) from public,anon;
grant execute on function private.kardex_guests(text,text) to authenticated;
create or replace function public.kardex_guests(action text,guest_email text default null) returns jsonb
language sql security invoker set search_path='' as $$ select private.kardex_guests(action,guest_email); $$;
revoke all on function public.kardex_guests(text,text) from public,anon;
grant execute on function public.kardex_guests(text,text) to authenticated;
