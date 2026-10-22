-- Vincular cargos del Google Sheets de Iron Mountain con el Kardex
-- aunque el original lleve ceros iniciales (ej. 0203 ↔ 203, 0007 ↔ 7).
-- No altera envíos históricos ni códigos originales; el estado vigente se
-- determina por clasificación y fecha del registro live.
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
     LEFT JOIN LATERAL ( SELECT l.codigo_caja,
            l.clasificacion_caja,
            l.fecha_envio
           FROM im_envios_cargos_live l
          WHERE (l.codigo_cargo = ANY (d.cargos)) OR length(l.codigo_cargo) <= 3 AND regexp_replace(upper(l.codigo_cargo), '^0+(?=[0-9])'::text, ''::text, 'g'::text) = regexp_replace(upper(d.cargos[1]), '^0+(?=[0-9])'::text, ''::text, 'g'::text)
          ORDER BY (l.fecha_envio IS NULL) DESC, l.updated_at DESC
         LIMIT 1) live ON true;
