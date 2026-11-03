-- Verificación pequeña de cada Excel actualizado. No almacena facturas ni imágenes.
create table if not exists private.kardex_excel_carga_recibos (
  destino text not null check(destino in ('original','depurado')),
  cargo integer not null check(cargo>=942),
  filas integer not null check(filas between 1 and 15000),
  codigos integer not null check(codigos between 1 and 15000),
  huella text not null check(huella ~ '^[a-f0-9]{64}$'),
  master_md5 text not null check(master_md5 ~ '^[a-f0-9]{32}$'),
  master_size bigint not null check(master_size>100000),
  firma text not null check(firma ~ '^[a-f0-9]{64}$'),
  verificado_at timestamptz not null default clock_timestamp(),
  primary key(destino,cargo)
);
revoke all on private.kardex_excel_carga_recibos from public, anon, authenticated;
alter table private.kardex_excel_carga_recibos enable row level security;

create or replace function public.kardex_excel_guardar_recibo(
  p_destino text,p_cargo integer,p_filas integer,p_codigos integer,
  p_huella text,p_master_md5 text,p_master_size bigint,p_firma text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if (select auth.uid()) is null or not private.kardex_has_access(true) then
    raise exception 'Solo administrador' using errcode='42501';
  end if;
  if p_destino not in ('original','depurado') or p_cargo<942
     or p_filas not between 1 and 15000 or p_codigos not between 1 and p_filas
     or p_huella !~ '^[a-f0-9]{64}$' or p_master_md5 !~ '^[a-f0-9]{32}$'
     or p_master_size<100000 or p_firma !~ '^[a-f0-9]{64}$' then
    raise exception 'Recibo inválido' using errcode='22023';
  end if;
  insert into private.kardex_excel_carga_recibos
    (destino,cargo,filas,codigos,huella,master_md5,master_size,firma)
  values (p_destino,p_cargo,p_filas,p_codigos,p_huella,p_master_md5,p_master_size,p_firma)
  on conflict(destino,cargo) do update set
    filas=excluded.filas,codigos=excluded.codigos,
    huella=excluded.huella,master_md5=excluded.master_md5,master_size=excluded.master_size,
    firma=excluded.firma,verificado_at=clock_timestamp();
  return jsonb_build_object('registrado',true,'cargo',p_cargo,'destino',p_destino);
end; $$;
revoke all on function public.kardex_excel_guardar_recibo(text,integer,integer,integer,text,text,bigint,text)
 from public,anon;
grant execute on function public.kardex_excel_guardar_recibo(text,integer,integer,integer,text,text,bigint,text)
 to authenticated;

create or replace function public.kardex_excel_consultar_recibos(p_cargo integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if (select auth.uid()) is null or not private.kardex_has_access(true) then
    raise exception 'Solo administrador' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'destino',destino,'cargo',cargo,'filas',filas,'codigos',codigos,
    'huella',huella,'master_md5',master_md5,'master_size',master_size,
    'firma',firma,'verificado_at',verificado_at))
    from private.kardex_excel_carga_recibos where cargo=p_cargo),'[]'::jsonb);
end; $$;
revoke all on function public.kardex_excel_consultar_recibos(integer) from public,anon;
grant execute on function public.kardex_excel_consultar_recibos(integer) to authenticated;

-- Corrige columnas GENERATED ALWAYS: NUNCA escribir busqueda_facturas,
-- busqueda_meta o cantidad_facturas. PostgreSQL las calcula desde facturas.
create or replace function public.kardex_excel_finalizar(
  p_anio integer,p_cargo text,p_fecha date,p_filas integer,p_grupos_por_codigo jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
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
  if p_anio<>2026 or p_cargo !~ '^[0-9]{3,7}$' or p_cargo::integer<942
    or p_fecha is null or extract(year from p_fecha)<>p_anio
    or p_filas<1 or p_filas>15000
    or jsonb_typeof(p_grupos_por_codigo)<>'object' then
    raise exception 'Cargo o entrada no válida' using errcode='22023';
  end if;
  select count(*),string_agg(code,',' order by code) into v_count,v_facturas
    from jsonb_object_keys(p_grupos_por_codigo) codes(code);
  if v_count<1 or v_count>p_filas or length(v_facturas)>400000 then
    raise exception 'Índice de códigos inválido' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_each(p_grupos_por_codigo) item
    where item.key !~ '^[A-Z0-9]{3,150}$'
    or jsonb_typeof(item.value)<>'array'
    or jsonb_array_length(item.value)<1
    or jsonb_array_length(item.value)>20) then
    raise exception 'Grupos no válidos' using errcode='22023';
  end if;
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
  select u.email into v_user from auth.users u where u.id=(select auth.uid());
  insert into public.documentos(
    tipo_doc,periodo,ubicacion,cargos,usuario,hoja_origen,
    fecha_origen,anio_origen,clave_origen,datos_origen,facturas
  ) values (
    'Fact / GR / BV',p_fecha,'Santa Anita',array[p_cargo],
    coalesce(v_user,'Importación Excel Drive'),'CARGOS NUEVOS 2026',
    p_fecha,p_anio,v_key,jsonb_build_object(
      'formato','drive-excel-dual-v2','filas_excel',p_filas,
      'grupos_por_codigo',p_grupos_por_codigo,
      'archivo_original','1E4wmCkdei32i6NEcLh4ztQaK8_fOz5u3',
      'archivo_depurado','16s2rreNgACVhPsckh8-vSFUwWMjcpvwr'
    ),v_facturas
  ) returning * into v_new;
  return jsonb_build_object('documento_id',v_new.id,'kardex',v_new.kardex,
    'ya_registrado',false,'facturas',v_new.cantidad_facturas);
end; $$;
revoke all on function public.kardex_excel_finalizar(integer,text,date,integer,jsonb) from public,anon;
grant execute on function public.kardex_excel_finalizar(integer,text,date,integer,jsonb) to authenticated;