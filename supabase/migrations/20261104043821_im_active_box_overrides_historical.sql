-- La caja vigente reemplaza la presentación histórica y conserva la auditoría.
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
    CASE WHEN h.decision = 'historico' AND live.codigo_caja IS NOT NULL
         THEN NULL ELSE h.decision END AS im_historical_decision,
    CASE WHEN h.decision IS NOT NULL AND live.fecha_envio IS NOT NULL
         THEN live.responsable_entrega END AS im_live_responsable_entrega
FROM public.documentos d
LEFT JOIN private.im_envios_confirmados m ON m.documento_id = d.id
LEFT JOIN private.im_cajas_preparadas p ON p.documento_id = d.id
LEFT JOIN private.kardex_im_historical_audit h
  ON h.documento_id = d.id AND h.revoked_at IS NULL
  AND coalesce(extract(year from d.fecha_origen)::integer, d.anio_origen,
               extract(year from d.periodo)::integer) BETWEEN 2020 AND 2024
LEFT JOIN LATERAL (
  SELECT l.codigo_caja, l.clasificacion_caja, l.fecha_envio, l.responsable_entrega
  FROM public.im_envios_cargos_live l
  WHERE (
    l.codigo_cargo = ANY (d.cargos)
    OR (
      length(l.codigo_cargo) <= 3
      AND regexp_replace(upper(l.codigo_cargo), '^0+(?=[0-9])', '', 'g')
          = regexp_replace(upper(d.cargos[1]), '^0+(?=[0-9])', '', 'g')
    )
  )
  -- Un código ambiguo del Excel no debe retirar el estado histórico de otro cargo.
  AND (
    h.decision IS DISTINCT FROM 'historico'
    OR NOT EXISTS (
      SELECT 1 FROM public.documentos other
      WHERE other.id <> d.id AND (
        l.codigo_cargo = ANY (other.cargos)
        OR (
          NOT (l.codigo_cargo = ANY (d.cargos)) AND length(l.codigo_cargo) <= 3
          AND regexp_replace(upper(l.codigo_cargo), '^0+(?=[0-9])', '', 'g')
              = regexp_replace(upper(other.cargos[1]), '^0+(?=[0-9])', '', 'g')
        )
      )
    )
  )
  ORDER BY (l.fecha_envio IS NULL) DESC, l.updated_at DESC
  LIMIT 1
) live ON true;
