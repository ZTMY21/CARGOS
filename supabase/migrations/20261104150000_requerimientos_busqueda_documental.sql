-- Proyección opcional de solo lectura para la Preview aislada.
-- Producción consulta los documentos y las cajas vigentes directamente.
create table private.req4_referencia_busqueda (
  id uuid primary key,
  cargos text[] not null,
  codigo text,
  estado text not null,
  ubicacion text,
  documentos text[] not null default '{}'
);
alter table private.req4_referencia_busqueda enable row level security;
revoke all on private.req4_referencia_busqueda from public, anon, authenticated;
create index req4_referencia_busqueda_documentos
  on private.req4_referencia_busqueda using gin(documentos);

create function private.req4_documento_huella(codigo text) returns text
language sql immutable strict set search_path='' as $$
  select encode(sha256(convert_to(codigo,'UTF8')),'hex');
$$;
revoke all on function private.req4_documento_huella(text) from public, anon, authenticated;

create function private.req4_cargo(codigo text) returns text
language sql immutable set search_path='' as $$
  select case when trim(coalesce(codigo,'')) ~* '^(cargo[[:space:]-]+)?[0-9]{1,7}([[:space:]]*\(?[a-z]\)?)?(\.0+)?$'
    then regexp_replace(
      private.kardex_normalize(regexp_replace(trim(codigo),'(^cargo[[:space:]-]+|\.0+$)','','gi')),
      '^0+(?=[0-9])','') end;
$$;
revoke all on function private.req4_cargo(text) from public, anon, authenticated;

create or replace function private.req4_buscar(p_query text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  normalizado text := private.kardex_normalize(p_query);
  cargo_buscado text := private.req4_cargo(p_query);
  caja_buscada text := private.req4_clave(p_query);
  huella text := private.req4_documento_huella(normalizado);
  resultado jsonb;
begin
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores' using errcode='42501';
  end if;
  if normalizado='' or length(trim(coalesce(p_query,'')))>120 then return '[]'::jsonb; end if;

  with documento_candidatos as materialized (
    select d.id,d.busqueda_facturas
    from public.documentos d
    where length(normalizado)>=6 and d.busqueda_facturas like '%'||normalizado||'%'
  ), documento_exactos as materialized (
    select id from documento_candidatos
    where busqueda_facturas ~ ('(^|[,;\n])'||normalizado||'([,;\n]|$)')
  ), documentos as materialized (
    select id from documento_exactos
    union
    select id from documento_candidatos
    where normalizado ~ '^[0-9]{6,}$' and not exists(select 1 from documento_exactos)
      and busqueda_facturas ~ (normalizado||'([,;\n]|$)')
  ), coincidencias as (
    select v.cargos, caja.codigo,
      case
        when v.im_live_fecha_envio is not null then 'Enviado a Iron Mountain'
        when v.im_live_codigo_caja is not null and coalesce(v.im_live_clasificacion,'') ~* 'por[[:space:]]+solicitud' then 'Caja solicitada'
        when v.im_live_codigo_caja is not null then 'Caja preparada para envío'
        when v.im_codigo_caja is not null then 'Enviado a Iron Mountain'
        when v.im_historical_decision='historico' then 'Histórico'
        when v.im_caja_preparada is not null then 'Caja preparada para envío'
        else 'Identificación pendiente'
      end estado,
      case when v.im_live_fecha_envio is not null or (v.im_live_codigo_caja is null and v.im_codigo_caja is not null)
        then 'Iron Mountain' else v.ubicacion end ubicacion,
      case when d.id is not null then 'documento' else 'cargo' end tipo
    from public.kardex_documentos_resumen v
    left join documentos d on d.id=v.id
    cross join lateral (select coalesce(nullif(v.im_live_codigo_caja,''),nullif(v.im_codigo_caja,''),nullif(v.im_caja_preparada,'')) codigo) caja
    where d.id is not null or private.req4_clave(caja.codigo)=caja_buscada
      or (cargo_buscado is not null and exists (
        select 1 from unnest(v.cargos) c where private.req4_cargo(c)=cargo_buscado))
    union all
    select r.cargos,r.codigo,r.estado,r.ubicacion,
      case when r.documentos @> array[huella] then 'documento' else 'cargo' end
    from private.req4_referencia_busqueda r
    where r.documentos @> array[huella] or private.req4_clave(r.codigo)=caja_buscada
      or (cargo_buscado is not null and exists (
        select 1 from unnest(r.cargos) c where private.req4_cargo(c)=cargo_buscado))
  ), claves as (
    select private.req4_clave(codigo) clave from coincidencias where private.req4_clave(codigo) is not null
    union
    select private.req4_clave(l.codigo_caja)
    from public.im_envios_cargos_live l
    where private.req4_clave(l.codigo_caja) is not null and
      (private.req4_clave(l.codigo_caja)=caja_buscada or private.req4_cargo(l.codigo_cargo)=cargo_buscado)
  ), cajas as (
    select k.clave,l.codigo_caja codigo,l.codigo_cargo cargo,
      case when l.fecha_envio is not null then 'Enviado a Iron Mountain'
           when coalesce(l.clasificacion_caja,'') ~* 'por[[:space:]]+solicitud' then 'Caja solicitada'
           else 'Caja preparada para envío' end estado,
      case when l.fecha_envio is not null then 'Iron Mountain' end ubicacion
    from claves k join public.im_envios_cargos_live l on private.req4_clave(l.codigo_caja)=k.clave
    union all
    select private.req4_clave(c.codigo),c.codigo,code,c.estado,c.ubicacion
    from coincidencias c left join lateral unnest(c.cargos) code on true
    where private.req4_clave(c.codigo) is not null
  ), agrupadas as (
    select clave,min(codigo) codigo,
      coalesce(array_agg(distinct cargo order by cargo) filter(where cargo is not null),'{}') cargos,
      coalesce(max(estado) filter(where estado='Enviado a Iron Mountain'),
        max(estado) filter(where estado='Caja solicitada'),max(estado)) estado,
      coalesce(max(ubicacion) filter(where ubicacion='Iron Mountain'),max(ubicacion)) ubicacion
    from cajas group by clave
  ), resultados as (
    select jsonb_build_object('clave',a.clave,'codigo',a.codigo,'cargos',a.cargos,'estado',a.estado,'ubicacion',a.ubicacion,
      'prestamo',(select r.numero from private.req4_cajas c join public.requerimientos r on r.id=c.requerimiento
        where c.clave=a.clave and c.devolucion is null)) fila
    from agrupadas a
    union
    select jsonb_build_object('estado',estado,'cargos',cargos,'tipo',tipo)
    from coincidencias c where private.req4_clave(codigo) is null
      and (tipo='documento' or not exists(select 1 from agrupadas))
  )
  select coalesce(jsonb_agg(fila order by fila->>'codigo' nulls last, fila->>'cargos'),'[]'::jsonb) into resultado
  from (select fila from resultados order by fila->>'codigo' nulls last, fila->>'cargos' limit 100) acotados;
  return resultado;
end;
$$;
