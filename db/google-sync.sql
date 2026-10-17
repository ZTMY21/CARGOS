create table public.kardex_google_sync (
 id boolean primary key default true check(id), enabled boolean not null default true,
 file_id text not null default '1GvTelpW7OQnt4sl_e-AfmWnNdSFQnL7E',
 last_sha256 text, last_checked_at timestamptz, last_synced_at timestamptz,
 status text not null default 'Pendiente de primera revisión', last_result jsonb not null default '{}'
);
alter table public.kardex_google_sync enable row level security;
revoke all on public.kardex_google_sync from public,anon,authenticated;
grant select on public.kardex_google_sync to authenticated;
grant update(enabled) on public.kardex_google_sync to authenticated;
create policy google_sync_read on public.kardex_google_sync for select to authenticated using((select private.kardex_has_access(true)));
create policy google_sync_admin on public.kardex_google_sync for update to authenticated using((select private.kardex_has_access(true))) with check((select private.kardex_has_access(true)));
insert into public.kardex_google_sync(id) values(true);
-- Connector-only ingestion: never exposed to guests or the browser.
create or replace function public.kardex_google_append(groups_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare g jsonb; target uuid; candidates integer; yr integer; cargo text; new_codes text; new_groups jsonb; groups_changed boolean; inserted integer:=0; changed integer:=0; conflicts integer:=0;
begin
 if not private.kardex_has_access(true) then raise exception 'Solo el administrador' using errcode='42501'; end if;
 perform pg_catalog.pg_advisory_xact_lock(1170196,1);
 if not exists(select 1 from public.kardex_google_sync where enabled) then raise exception 'Sincronización pausada'; end if;
 if jsonb_typeof(groups_data)<>'array' or jsonb_array_length(groups_data)>100 then raise exception 'Lote inválido'; end if;
 for g in select value from jsonb_array_elements(groups_data) loop
  yr:=(g->>'year')::integer; cargo:=trim(g->>'cargo');
  if yr not between 2000 and 2100 or cargo is null or cargo='' or jsonb_typeof(g->'codes')<>'array' then raise exception 'Cargo, año o códigos inválidos'; end if;
  select count(*),min(id::text)::uuid into candidates,target from public.documentos d
  where (coalesce(d.anio_origen,extract(year from d.periodo)::int)=yr or d.fecha_origen=(g->>'date')::date)
    and exists(select 1 from unnest(d.cargos) c where regexp_replace(c,'\.0+$','')=cargo);
  if candidates>1 then conflicts:=conflicts+1;continue;end if;
  with existing as materialized (
    select private.kardex_normalize(oldcode) as normalized from public.documentos d,
      lateral regexp_split_to_table(d.facturas,'[,;\n]+') oldcode where d.id=target
  ), incoming as (
    select distinct on (private.kardex_normalize(value)) trim(value) as code,private.kardex_normalize(value) as normalized
    from jsonb_array_elements_text(g->'codes') where trim(value)<>'' and length(value)<=200
    order by private.kardex_normalize(value),trim(value)
  )
  select string_agg(i.code,', ' order by i.code) into new_codes from incoming i
  where i.normalized<>'' and not exists(select 1 from existing e where e.normalized=i.normalized);
  new_groups:=null; groups_changed:=false;
  if g ? 'code_groups' then
   if jsonb_typeof(g->'code_groups')<>'object' then raise exception 'Grupos inválidos'; end if;
   select coalesce(jsonb_object_agg(private.kardex_normalize(key),value),'{}'::jsonb) into new_groups
   from jsonb_each(g->'code_groups');
   if target is not null then
    update public.documentos set datos_origen=jsonb_set(datos_origen,'{grupos_por_codigo}',
      coalesce(datos_origen->'grupos_por_codigo','{}'::jsonb)||new_groups)
    where id=target and coalesce(datos_origen->'grupos_por_codigo','{}'::jsonb) is distinct from
      coalesce(datos_origen->'grupos_por_codigo','{}'::jsonb)||new_groups;
    groups_changed:=found;
   end if;
  end if;
  if new_codes is null then
   if groups_changed then changed:=changed+1;end if;
   continue;
  end if;
  if target is null then
   insert into public.documentos(tipo_doc,periodo,ubicacion,cargos,usuario,facturas,clave_origen,hoja_origen,anio_origen,fecha_origen,datos_origen)
   values('Fact / GR / BV',null,null,array[cargo],'Sincronización Google Drive',new_codes,
     'google-drive|1GvTelpW7OQnt4sl_e-AfmWnNdSFQnL7E|'||yr||'|'||cargo,'Reporte Consolidado',yr,(g->>'date')::date,
     jsonb_build_object('google_drive_file','1GvTelpW7OQnt4sl_e-AfmWnNdSFQnL7E','grupos_por_codigo',coalesce(new_groups,'{}'::jsonb)));
   inserted:=inserted+1;
  else
   update public.documentos set facturas=concat_ws(', ',nullif(facturas,''),new_codes) where id=target;
   changed:=changed+1;
  end if;
 end loop;
 return jsonb_build_object('cargos_nuevos',inserted,'cargos_actualizados',changed,'conflictos',conflicts);
end;
$$;
revoke all on function public.kardex_google_append(jsonb) from public,anon,authenticated;
