-- Carga Excel Drive-first de cargos completos, sin Google Sheets.
-- La tabla privada solo guarda un candado temporal; los datos permanecen en Drive.
create table if not exists private.kardex_excel_carga_lease (
  destino text primary key check (destino in ('original','depurado')),
  cargo integer not null default 0,
  token uuid,
  hasta timestamptz not null default '-infinity'::timestamptz
);
revoke all on private.kardex_excel_carga_lease from public, anon, authenticated;
insert into private.kardex_excel_carga_lease(destino) values ('original'),('depurado') on conflict do nothing;

create or replace function public.kardex_excel_tomar_lease(p_destino text,p_cargo integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_token uuid;
begin
  if (select auth.uid()) is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo obligatorio' using errcode='42501';
  end if;
  if p_destino not in ('original','depurado') or p_cargo < 942 or p_cargo > 9999999 then
    raise exception 'Destino o cargo no válido' using errcode='22023';
  end if;
  update private.kardex_excel_carga_lease
    set token=gen_random_uuid(), hasta=clock_timestamp()+interval '150 seconds',cargo=p_cargo
    where destino=p_destino and hasta<clock_timestamp()
    returning token into v_token;
  if v_token is null then raise exception 'CARGA_DE_ESE_EXCEL_EN_PROCESO' using errcode='55P03'; end if;
  return v_token;
end;$$;
revoke all on function public.kardex_excel_tomar_lease(text,integer) from public, anon;
grant execute on function public.kardex_excel_tomar_lease(text,integer) to authenticated;

create or replace function public.kardex_excel_liberar_lease(p_destino text,p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  if (select auth.uid()) is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo obligatorio' using errcode='42501';
  end if;
  update private.kardex_excel_carga_lease set token=null,hasta='-infinity'::timestamptz
    where destino=p_destino and token=p_token returning true into v_ok;
  return coalesce(v_ok,false);
end;$$;
revoke all on function public.kardex_excel_liberar_lease(text,uuid) from public, anon;
grant execute on function public.kardex_excel_liberar_lease(text,uuid) to authenticated;

create or replace function public.kardex_excel_finalizar(
  p_anio integer,p_cargo text,p_fecha date,p_filas integer,p_grupos_por_codigo jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_old public.documentos%rowtype;
  v_new public.documentos%rowtype;
  v_facturas text;
  v_key text;
  v_user text;
begin
  if (select auth.uid()) is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo obligatorio' using errcode='42501';
  end if;
  if p_anio<>2026 or p_cargo !~ '^[0-9]{3,7}$' or p_cargo::integer < 942
    or p_fecha is null or extract(year from p_fecha)<>p_anio
    or p_filas<1 or p_filas>15000
    or jsonb_typeof(p_grupos_por_codigo)<>'object' then
    raise exception 'Cargo o entrada no válida' using errcode='22023';
  end if;
  select count(*),string_agg(code,',' order by code) into v_count,v_facturas
  from jsonb_object_keys(p_grupos_por_codigo) as codes(code);
  if v_count<1 or v_count>p_filas or length(v_facturas)>400000 then
    raise exception 'Índice de códigos inválido' using errcode='22023';
  end if;
  if exists (
    select 1 from jsonb_each(p_grupos_por_codigo) item
      where item.key !~ '^[A-Z0-9]{3,150}$'
         or jsonb_typeof(item.value)<>'array'
         or jsonb_array_length(item.value)<1
         or jsonb_array_length(item.value)>20
  ) then raise exception 'Grupos no válidos' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(1170196,2);
  v_key='excel-drive|'||p_anio||'|'||p_cargo;
  select * into v_old from public.documentos
  where anio_origen=p_anio and p_cargo=any(cargos)
  limit 1 for update;
  if found then
    if v_old.clave_origen=v_key and v_old.cantidad_facturas=v_count
       and v_old.datos_origen->'grupos_por_codigo'=p_grupos_por_codigo then
      return jsonb_build_object('documento_id',v_old.id,'ya_registrado',true);
    end if;
    raise exception 'CARGO_YA_EXISTE_CON_OTRO_CONTENIDO' using errcode='23505';
  end if;
  select coalesce(u.email,'Importación Excel Drive') into v_user
    from auth.users u where u.id=(select auth.uid());
  insert into public.documentos(
    tipo_doc,cargos,usuario,hoja_origen,fecha_origen,anio_origen,
    clave_origen,datos_origen,busqueda_facturas,busqueda_meta,cantidad_facturas
  ) values (
    'Fact / GR / BV',array[p_cargo],coalesce(v_user,'Importación Excel Drive'),
    'CARGOS NUEVOS 2026',p_fecha,p_anio,v_key,
    jsonb_build_object(
      'formato','drive-excel-dual-v1',
      'filas_excel',p_filas,'grupos_por_codigo',p_grupos_por_codigo,
      'archivo_original','1E4wmCkdei32i6NEcLh4ztQaK8_fOz5u3',
      'archivo_depurado','16s2rreNgACVhPsckh8-vSFUwWMjcpvwr'),
    v_facturas,
    '2026 cargo '||p_cargo||' excel drive',v_count
  ) returning * into v_new;
  return jsonb_build_object('documento_id',v_new.id,'kardex',v_new.kardex,'ya_registrado',false);
end;$$;
revoke all on function public.kardex_excel_finalizar(integer,text,date,integer,jsonb) from public, anon;
grant execute on function public.kardex_excel_finalizar(integer,text,date,integer,jsonb) to authenticated;

-- Reanuda la indexación si Drive ya contiene el cargo pero falló la última fase.
create or replace function public.kardex_excel_estado()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_last integer;v_indexed jsonb;
begin
  if (select auth.uid()) is null or not private.kardex_has_access(true) then
    raise exception 'Acceso administrativo obligatorio' using errcode='42501';
  end if;
  select greatest(941,coalesce(max(num::integer),941)) into v_last
    from public.documentos d cross join lateral unnest(d.cargos) c(num)
    where d.anio_origen=2026 and num ~ '^[0-9]{1,7}$';
  select coalesce(jsonb_agg(distinct num::integer), '[]'::jsonb) into v_indexed
    from public.documentos d cross join lateral unnest(d.cargos) c(num)
    where d.anio_origen=2026 and num ~ '^[0-9]{1,7}$' and num::integer>=942;
  return jsonb_build_object('indexedLastCargo',v_last,'indexedCargos',v_indexed);
end;$$;
revoke all on function public.kardex_excel_estado() from public, anon;
grant execute on function public.kardex_excel_estado() to authenticated;
