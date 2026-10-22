-- Corrige el timeout del gráfico IM (la vista private.im_envios_confirmados
-- tardaba ~13 segundos por cruces anidados de documentos).
-- Los envíos se extraen de las dos hojas fuentes: histórico y Sheet en vivo.
-- Cada código de barras físico se cuenta una vez por mes de fecha de envío.
CREATE OR REPLACE FUNCTION public.kardex_im_boxes_sent_monthly()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF NOT private.kardex_has_access(true) THEN
    RAISE EXCEPTION 'Solo administradores pueden consultar envíos mensuales de cajas a IM'
      USING errcode='42501';
  END IF;
  RETURN COALESCE((
    WITH movimientos AS (
      SELECT h.fecha_envio AS fecha,
        regexp_replace(coalesce(h.codigo_caja,''),'[^0-9]','','g') AS codigo_caja
      FROM public.im_envios_cargos h WHERE h.fecha_envio IS NOT NULL
      UNION ALL
      SELECT l.fecha_envio AS fecha,
        regexp_replace(coalesce(l.codigo_caja,''),'[^0-9]','','g') AS codigo_caja
      FROM public.im_envios_cargos_live l WHERE l.fecha_envio IS NOT NULL
    ),
    cajas_mes AS (
      SELECT date_trunc('month',fecha)::date AS periodo, codigo_caja, max(fecha) AS ultima_fecha
      FROM movimientos
      WHERE codigo_caja <> '' AND fecha <= (now() AT TIME ZONE 'America/Lima')::date
      GROUP BY date_trunc('month',fecha)::date,codigo_caja
    ),
    resumen AS (
      SELECT extract(year from periodo)::integer AS anio,
        extract(month from periodo)::integer AS mes, count(*)::integer AS cajas,
        max(ultima_fecha) AS ultima_fecha
      FROM cajas_mes GROUP BY periodo
    )
    SELECT jsonb_agg(jsonb_build_object('year',anio,'month',mes,'count',cajas,'latest',ultima_fecha)
      ORDER BY anio,mes)
    FROM resumen
  ),'[]'::jsonb);
END
$function$;
REVOKE ALL ON FUNCTION public.kardex_im_boxes_sent_monthly() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kardex_im_boxes_sent_monthly() TO authenticated;
