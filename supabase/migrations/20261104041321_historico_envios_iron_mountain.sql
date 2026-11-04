-- The overlay never updates a document, shipment, or Google Sheets source.
-- Only the active decision is exposed through the existing authenticated view.
create table private.kardex_im_historical_audit (
  id bigint generated always as identity primary key,
  documento_id uuid not null,
  batch_key text not null,
  decision text not null check (decision in ('historico', 'confirmado_documental', 'revision')),
  previous_state text not null,
  previous_snapshot jsonb not null,
  reason text not null,
  authorized_by text not null,
  applied_by text not null default current_user,
  applied_at timestamptz not null default now(),
  revoked_by text,
  revoked_at timestamptz,
  revocation_reason text,
  check (
    (revoked_by is null and revoked_at is null and revocation_reason is null)
    or (revoked_by is not null and revoked_at is not null and revocation_reason is not null)
  ),
  unique (batch_key, documento_id)
);
create unique index kardex_im_historical_audit_active
  on private.kardex_im_historical_audit (documento_id) where revoked_at is null;
alter table private.kardex_im_historical_audit enable row level security;
revoke all on private.kardex_im_historical_audit from public, anon, authenticated;

create or replace view public.kardex_documentos_resumen as
SELECT d.id,
    d.kardex,
    d.fecha_registro,
    d.tipo_doc,
    d.periodo,
    d.ubicacion,
    d.folios,
    d.cargos,
    d.caja_asignada,
    d.f_envio,
    d.sustento,
    d.usuario,
    d.obs,
    d.created_at,
    d.updated_at,
    d.clave_origen,
    d.hoja_origen,
    d.fecha_origen,
    d.anio_origen,
    d.estado_origen,
    d.importacion_id,
    (d.sustento_imagen <> ''::text) AS tiene_sustento_imagen,
    d.cantidad_facturas,
    m.codigo_caja AS im_codigo_caja,
    m.fecha_envio AS im_fecha_envio,
    m.responsable AS im_responsable,
    (m.documento_id IS NOT NULL) AS im_confirmado,
    ((p.documento_id IS NOT NULL) AND (m.documento_id IS NULL)) AS im_preparado,
    p.codigo_caja AS im_caja_preparada,
    p.responsable AS im_responsable_preparacion,
    live.codigo_caja AS im_live_codigo_caja,
    live.clasificacion_caja AS im_live_clasificacion,
    live.fecha_envio AS im_live_fecha_envio,
    h.decision AS im_historical_decision,
    CASE WHEN h.decision IS NOT NULL AND live.fecha_envio IS NOT NULL
         THEN live.responsable_entrega END AS im_live_responsable_entrega
   FROM (((public.documentos d
     LEFT JOIN private.im_envios_confirmados m ON ((m.documento_id = d.id)))
     LEFT JOIN private.im_cajas_preparadas p ON ((p.documento_id = d.id)))
     LEFT JOIN LATERAL ( SELECT l.codigo_caja,
            l.clasificacion_caja,
            l.fecha_envio,
            l.responsable_entrega
           FROM public.im_envios_cargos_live l
          WHERE ((l.codigo_cargo = ANY (d.cargos)) OR ((length(l.codigo_cargo) <= 3) AND (regexp_replace(upper(l.codigo_cargo), '^0+(?=[0-9])'::text, ''::text, 'g'::text) = regexp_replace(upper(d.cargos[1]), '^0+(?=[0-9])'::text, ''::text, 'g'::text))))
          ORDER BY (l.fecha_envio IS NULL) DESC, l.updated_at DESC
         LIMIT 1) live ON (true))
     LEFT JOIN private.kardex_im_historical_audit h
       ON h.documento_id = d.id AND h.revoked_at IS NULL
       AND coalesce(extract(year from d.fecha_origen)::integer, d.anio_origen,
                    extract(year from d.periodo)::integer) BETWEEN 2020 AND 2024;

CREATE OR REPLACE FUNCTION public.kardex_search(query_text text DEFAULT ''::text, estado_filter text DEFAULT ''::text, tipo_filter text DEFAULT ''::text, ubicacion_filter text DEFAULT ''::text, year_filter text DEFAULT ''::text, invoice_exact boolean DEFAULT false, page_offset integer DEFAULT 0, page_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
 SET enable_nestloop TO 'off'
AS $function$
 with input as (
  select private.kardex_normalize(query_text) as q,
   array(select private.kardex_normalize(t) from regexp_split_to_table(trim(query_text),'[[:space:]]+') t where private.kardex_normalize(t)<>'') as terms
 ), exact_cargo as materialized (
  select d.id from public.documentos d cross join input i where i.q<>'' and exists (
   select 1 from unnest(d.cargos) code where private.kardex_normalize(code)=i.q)
 ), resumen as materialized (
  select * from public.kardex_documentos_resumen
 ), candidates as materialized (
  select id from exact_cargo
  union
  select d.id from public.documentos d cross join input i where i.q=''
  union
  select d.id from public.documentos d cross join input i where i.q<>'' and not exists (select 1 from exact_cargo) and d.busqueda_meta like '%'||i.terms[1]||'%'
  union
  select d.id from public.documentos d cross join input i where i.q<>'' and not exists (select 1 from exact_cargo) and d.busqueda_facturas like '%'||i.terms[1]||'%'
  union
  select d.id from public.requerimientos r join public.documentos d on d.caja_asignada=r.id cross join input i
   where i.q<>'' and not exists (select 1 from exact_cargo) and private.kardex_normalize(r.numero) like '%'||i.terms[1]||'%'
  union
  select m.id from resumen m cross join input i
   where i.q<>'' and not exists (select 1 from exact_cargo) and ((private.kardex_normalize(m.im_codigo_caja) like '%'||i.terms[1]||'%' or private.kardex_normalize(m.im_live_codigo_caja) like '%'||i.terms[1]||'%') or private.kardex_normalize(m.im_responsable) like '%'||i.terms[1]||'%')
 ), matched as materialized (
  select d.id,d.folios,d.kardex,
   (d.busqueda_facturas ~ ('(^|[,;\n])'||i.q||'([,;\n]|$)') and i.q<>'') as exact_match
  from candidates c join public.documentos d on d.id=c.id left join public.requerimientos r on r.id=d.caja_asignada left join resumen m on m.id=d.id cross join input i
  cross join lateral (
    select case
      when m.im_live_fecha_envio is not null then 'Enviado a Iron Mountain'
      when m.im_historical_decision is not null and
        (m.im_confirmado or (d.f_envio is not null and (d.sustento<>'' or d.sustento_imagen<>''))) then 'Enviado a Iron Mountain'
      when m.im_historical_decision='historico' then 'Histórico'
      when m.im_live_codigo_caja is not null
        and coalesce(m.im_live_clasificacion,'') ~* 'por[[:space:]]+solicitud' then 'Caja solicitada'
      when m.im_live_codigo_caja is not null then 'Caja preparada para envío'
      when coalesce(m.im_confirmado,false) or (d.f_envio is not null and (d.sustento<>'' or d.sustento_imagen<>'')) then 'Enviado a Iron Mountain'
      when d.caja_asignada is not null then 'En Proceso de Acondicionamiento'
      else 'Pendiente de Envío' end as estado
  ) status
  cross join lateral (
    select case when m.im_historical_decision is not null and status.estado in ('Histórico','Enviado a Iron Mountain')
      then 'Iron Mountain' else d.ubicacion end as ubicacion
  ) destination
  where (not invoice_exact or exists(select 1 from exact_cargo) or i.q='' or d.busqueda_facturas ~ ('(^|[,;\n])'||i.q||'([,;\n]|$)'))
   and not exists(select 1 from unnest(i.terms) t where not (
    d.busqueda_meta like '%'||t||'%' or d.busqueda_facturas like '%'||t||'%'
    or private.kardex_normalize(r.numero) like '%'||t||'%' or (private.kardex_normalize(m.im_codigo_caja) like '%'||t||'%' or private.kardex_normalize(m.im_live_codigo_caja) like '%'||t||'%') or private.kardex_normalize(m.im_responsable) like '%'||t||'%'))
   and (estado_filter='' or estado_filter=status.estado)
   and (tipo_filter='' or d.tipo_doc=tipo_filter)
   and (ubicacion_filter='' or destination.ubicacion=ubicacion_filter or (ubicacion_filter='sin-dato' and destination.ubicacion is null))
   and (year_filter='' or (year_filter='sin-periodo' and d.periodo is null)
    or (
      (year_filter ~ '^[0-9]{4}$' or year_filter ~ '^origen:[0-9]{4}$')
      and coalesce(extract(year from d.fecha_origen)::integer,
        d.anio_origen,
        extract(year from d.periodo)::integer)
      = case when year_filter ~ '^[0-9]{4}$' then year_filter::integer
          when year_filter ~ '^origen:[0-9]{4}$' then substring(year_filter from 8)::integer
        end
    ))
 ), page as (
  select * from matched order by exact_match desc,kardex desc limit least(greatest(page_limit,1),1000) offset greatest(page_offset,0)
 ), output as (
 select p.kardex,p.exact_match,to_jsonb(v)||jsonb_build_object('facturas_encontradas',
  case when i.q='' or exists(select 1 from exact_cargo) then
   to_jsonb(array_remove(array[
    nullif(btrim(split_part(translate(d.facturas,E';\n',',,'),',',1)),''),
    nullif(btrim(split_part(translate(d.facturas,E';\n',',,'),',',2)),''),
    nullif(btrim(split_part(translate(d.facturas,E';\n',',,'),',',3)),'')
   ],null))
  else coalesce(
   (select jsonb_agg(f.numero) from (
    select distinct btrim(raw) as numero
    from regexp_split_to_table(d.facturas,E'[,;\n]+') raw
    where btrim(raw)<>'' and strpos(private.kardex_normalize(raw),i.q)>0
      and (not invoice_exact or private.kardex_normalize(raw)=i.q)
    limit 10
   ) f),
   (select jsonb_agg(f.numero) from (
    select (hits.m)[1] as numero
    from regexp_matches(d.busqueda_facturas,'[a-z0-9]*'||i.q||'[a-z0-9]*','g') hits(m)
    where not invoice_exact or (hits.m)[1]=i.q
    limit 10
   ) f),
   '[]'::jsonb)
  end) as data
 from page p join public.documentos d on d.id=p.id
 join resumen v on v.id=p.id cross join input i
 )
 select jsonb_build_object('rows',coalesce((select jsonb_agg(data order by exact_match desc,kardex desc) from output),'[]'::jsonb),
  'total',(select count(*) from matched),'folios',(select coalesce(sum(folios),0) from matched),
  'folios_sin_dato',(select count(*) from matched where folios is null));
$function$;
