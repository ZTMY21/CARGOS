-- Cajas por solicitud: estado y conteo pendientes, envíos y bajas.
-- No altera cargos/documentos históricos.
CREATE INDEX IF NOT EXISTS im_live_codigo_cargo_idx ON public.im_envios_cargos_live (codigo_cargo,updated_at DESC);
CREATE OR REPLACE VIEW public.kardex_documentos_resumen AS
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
    d.sustento_imagen <> ''::text AS tiene_sustento_imagen,
    d.cantidad_facturas,
    m.codigo_caja AS im_codigo_caja,
    m.fecha_envio AS im_fecha_envio,
    m.responsable AS im_responsable,
    m.documento_id IS NOT NULL AS im_confirmado,
    p.documento_id IS NOT NULL AND m.documento_id IS NULL AS im_preparado,
    p.codigo_caja AS im_caja_preparada,
    p.responsable AS im_responsable_preparacion,
    live.codigo_caja AS im_live_codigo_caja,
    live.clasificacion_caja AS im_live_clasificacion,
    live.fecha_envio AS im_live_fecha_envio
   FROM documentos d
     LEFT JOIN private.im_envios_confirmados m ON m.documento_id = d.id
     LEFT JOIN private.im_cajas_preparadas p ON p.documento_id = d.id
     LEFT JOIN LATERAL (
       SELECT l.codigo_caja,l.clasificacion_caja,l.fecha_envio
       FROM public.im_envios_cargos_live l
       WHERE l.codigo_cargo=ANY(d.cargos)
       ORDER BY (l.fecha_envio IS NULL) DESC,l.updated_at DESC
       LIMIT 1
     ) live ON true;

CREATE OR REPLACE FUNCTION public.kardex_prepared_im_detail()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET enable_nestloop TO 'off'
AS $function$
BEGIN
 IF NOT private.kardex_has_access(true) THEN
   RAISE EXCEPTION 'Solo administradores pueden revisar cajas preparadas'
     USING errcode='42501';
 END IF;
 RETURN coalesce((
   SELECT jsonb_agg(jsonb_build_object(
     'sheet_id',b.sheet_id,
     'sheet_row',b.sheet_row,
     'clasificacion_caja',b.clasificacion_caja,
     'numero',b.numero,
     'fecha_preparacion',b.fecha_preparacion,
     'responsable_preparacion',b.responsable_preparacion,
     'codigo_caja',b.codigo_caja,
     'numeros_cargos',b.numeros_cargos,
     'cargos',b.cargos,
     'fecha_envio',b.fecha_envio,
     'responsable_entrega',b.responsable_entrega,
     'responsable_recibe',b.responsable_recibe,
     'placa_transporte',b.placa_transporte
   ) ORDER BY b.sheet_row,b.codigo_caja)
   FROM (
     SELECT l.sheet_id,l.sheet_row,l.codigo_caja,
       min(l.numero) AS numero,
       min(l.fecha_preparacion) AS fecha_preparacion,
       min(l.responsable_preparacion) AS responsable_preparacion,
       min(l.fuente_celda) AS numeros_cargos,
       min(l.clasificacion_caja) AS clasificacion_caja,
       array_agg(DISTINCT l.codigo_cargo ORDER BY l.codigo_cargo) AS cargos,
       min(l.fecha_envio) AS fecha_envio,
       min(l.responsable_entrega) AS responsable_entrega,
       min(l.responsable_recibe) AS responsable_recibe,
       min(l.placa_transporte) AS placa_transporte
     FROM public.im_envios_cargos_live l
     WHERE l.fecha_envio IS NULL
      
     GROUP BY l.sheet_id,l.sheet_row,l.codigo_caja
   ) b
 ),'[]'::jsonb);
END
$function$

CREATE OR REPLACE FUNCTION public.kardex_requested_im_detail()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT private.kardex_has_access(true) THEN
    RAISE EXCEPTION 'Solo administradores pueden consultar solicitudes IM'
      USING errcode='42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'sheet_row',sheet_row,
      'codigo_caja',codigo_caja,
      'codigo_cargo',codigo_cargo,
      'clasificacion_caja',clasificacion_caja,
      'fecha_envio',fecha_envio
    ) ORDER BY sheet_row,codigo_caja,codigo_cargo)
    FROM public.im_envios_cargos_live
    WHERE regexp_replace(lower(coalesce(clasificacion_caja,'')),'[[:space:]]+',' ','g')
      LIKE '%por solicitud%' AND fecha_envio IS NULL
  ),'[]'::jsonb);
END;
$function$
