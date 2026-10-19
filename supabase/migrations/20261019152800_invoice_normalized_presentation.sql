-- Compara factura normalizada sin guiones y devuelve los codigos tal como estan almacenados.
-- La consulta por ultimos digitos tambien retorna el codigo original con su puntuacion.
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
   where i.q<>'' and not exists (select 1 from exact_cargo) and (private.kardex_normalize(m.im_codigo_caja) like '%'||i.terms[1]||'%' or private.kardex_normalize(m.im_responsable) like '%'||i.terms[1]||'%')
 ), matched as materialized (
  select d.id,d.folios,d.kardex,
   (d.busqueda_facturas ~ ('(^|[,;\n])'||i.q||'([,;\n]|$)') and i.q<>'') as exact_match
  from candidates c join public.documentos d on d.id=c.id left join public.requerimientos r on r.id=d.caja_asignada left join resumen m on m.id=d.id cross join input i
  where (not invoice_exact or exists(select 1 from exact_cargo) or i.q='' or d.busqueda_facturas ~ ('(^|[,;\n])'||i.q||'([,;\n]|$)'))
   and not exists(select 1 from unnest(i.terms) t where not (
    d.busqueda_meta like '%'||t||'%' or d.busqueda_facturas like '%'||t||'%'
    or private.kardex_normalize(r.numero) like '%'||t||'%' or private.kardex_normalize(m.im_codigo_caja) like '%'||t||'%' or private.kardex_normalize(m.im_responsable) like '%'||t||'%'))
   and (estado_filter='' or estado_filter=case
    when coalesce(m.im_confirmado,false) or (d.f_envio is not null and (d.sustento<>'' or d.sustento_imagen<>'')) then 'Enviado a Iron Mountain'
    when d.caja_asignada is not null then 'En Proceso de Acondicionamiento' else 'Pendiente de Envío' end)
   and (tipo_filter='' or d.tipo_doc=tipo_filter)
   and (ubicacion_filter='' or d.ubicacion=ubicacion_filter or (ubicacion_filter='sin-dato' and d.ubicacion is null))
   and (year_filter='' or (year_filter='sin-periodo' and d.periodo is null)
    or (year_filter~'^origen:[0-9]{4}$' and d.anio_origen=case when year_filter~'^origen:[0-9]{4}$' then substring(year_filter from 8)::integer end)
    or (year_filter~'^[0-9]{4}$' and extract(year from d.periodo)::integer=case when year_filter~'^[0-9]{4}$' then year_filter::integer end))
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
$function$
;
