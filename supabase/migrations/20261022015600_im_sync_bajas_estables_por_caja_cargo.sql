-- Sincroniza altas, ediciones y bajas aunque las filas de Google Sheets se reordenen.
-- Mantiene bloqueo de más de 35 bajas reales, según caja numérica + cargo exacto.
-- No modifica ni elimina los cargos históricos.
CREATE OR REPLACE FUNCTION public.im_sync_new_shipments(p_sheet_id text, p_secret text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
 item jsonb;
 cargo_code text;
 arr jsonb;
 nuevo_sha text;
 previo_sha text;
 previous_count integer:=0;
 next_count integer:=0;
 deleted_count integer:=0;
 row_nr integer;
 prep date;
 shipment_date date;
 caja text;
 raw_cargos text;
 result jsonb;
BEGIN
 IF current_setting('role',true)<>'service_role'
 OR length(coalesce(p_secret,''))<40
 OR NOT EXISTS (
   SELECT 1 FROM private.im_envios_live_config c
   WHERE c.sheet_id=p_sheet_id AND c.active
     AND c.token_sha256=encode(extensions.digest(convert_to(p_secret,'UTF8'),'sha256'),'hex')
 )
 THEN RAISE EXCEPTION 'Sincronización de envíos no autorizada' USING errcode='42501'; END IF;
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>1200
 THEN RAISE EXCEPTION 'La hoja tiene más de 1200 filas o es inválida'; END IF;

 PERFORM pg_catalog.pg_advisory_xact_lock(1170196,3);
 nuevo_sha:=encode(extensions.digest(convert_to(p_rows::text,'UTF8'),'sha256'),'hex');
 SELECT payload_sha256 INTO previo_sha FROM private.im_envios_live_control
 WHERE sheet_id=p_sheet_id FOR UPDATE;
 IF previo_sha=nuevo_sha THEN
   RETURN jsonb_build_object('estado','SIN CAMBIOS','cargos',(
     SELECT count(*) FROM public.im_envios_cargos_live WHERE sheet_id=p_sheet_id),
     'enviados',(SELECT count(*) FROM public.im_envios_cargos_live
                  WHERE sheet_id=p_sheet_id AND fecha_envio IS NOT NULL),
     'preparados',(SELECT count(DISTINCT codigo_caja) FROM public.im_envios_cargos_live
                   WHERE sheet_id=p_sheet_id AND fecha_envio IS NULL),
     'verificado',true,'hora',now());
 END IF;
 -- Validate the entire snapshot before deleting anything.
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF coalesce(item->>'row','') !~ '^[0-9]{1,6}$'
   OR (item->>'row')::integer<2
   OR jsonb_typeof(item->'cargos')<>'array'
   OR jsonb_array_length(item->'cargos') NOT BETWEEN 1 AND 60
   OR (coalesce(item->>'envio','')<>'' AND coalesce(item->>'envio','') !~ '^20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]$')
   OR length(trim(coalesce(item->>'caja','')))=0
   OR length(item->>'caja')>100
   OR length(coalesce(item->>'responsable',''))>150
   OR length(coalesce(item->>'entrega',''))>150
   OR length(coalesce(item->>'recibe',''))>150
   OR length(coalesce(item->>'placa',''))>40
   OR length(coalesce(item->>'celda',''))>450
   OR length(coalesce(item->>'clasificacion',''))>100
  THEN RAISE EXCEPTION 'Fila de envío incompleta o inválida; se conservan los registros existentes' USING errcode='22023'; END IF;
  shipment_date:=nullif(item->>'envio','')::date;
  IF shipment_date IS NOT NULL AND (shipment_date<'2025-06-27' OR shipment_date>current_date+interval '2 years')
  THEN RAISE EXCEPTION 'Fecha de envío fuera del período editable'; END IF;
  IF coalesce(item->>'preparacion','')<>'' THEN
    IF (item->>'preparacion') !~ '^20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]$'
    THEN RAISE EXCEPTION 'Fecha de preparación inválida'; END IF;
    prep:=(item->>'preparacion')::date;
  END IF;
  FOR cargo_code IN SELECT value FROM jsonb_array_elements_text(item->'cargos') LOOP
     IF cargo_code !~ '^[0-9]{1,7}A?$'
     THEN RAISE EXCEPTION 'Código de cargo inválido: %',left(cargo_code,30); END IF;
  END LOOP;
 END LOOP;

 SELECT count(*) INTO previous_count FROM public.im_envios_cargos_live WHERE sheet_id=p_sheet_id;
 SELECT coalesce(sum(jsonb_array_length(value->'cargos')),0)::integer INTO next_count
 FROM jsonb_array_elements(p_rows);
 -- Comparar por la identidad estable caja + cargo, NUNCA por sheet_row.
 -- Borrar una fila desplaza las posteriores sin borrar sus cargos.
 -- Los prefijos de las cajas no cambian su identidad física.
 WITH previous AS (
   SELECT regexp_replace(coalesce(codigo_caja,''),'[^0-9]','','g') AS caja_num,
          codigo_cargo, count(*)::int AS cantidad
   FROM public.im_envios_cargos_live
   WHERE sheet_id=p_sheet_id
   GROUP BY 1,2
 ), incoming AS (
   SELECT regexp_replace(coalesce(j.value->>'caja',''),'[^0-9]','','g') AS caja_num,
          code.value AS codigo_cargo, count(*)::int AS cantidad
   FROM jsonb_array_elements(p_rows) j(value)
   JOIN LATERAL jsonb_array_elements_text(j.value->'cargos') code ON true
   GROUP BY 1,2
 )
 SELECT coalesce(sum(greatest(p.cantidad-coalesce(i.cantidad,0),0)),0)::int
 INTO deleted_count
 FROM previous p
 LEFT JOIN incoming i ON i.caja_num=p.caja_num AND i.codigo_cargo=p.codigo_cargo;
 -- Prevent accidental mass deletion if the sheet is temporarily unreadable.
 IF deleted_count>35 THEN
  RAISE EXCEPTION 'Se bloquearon % bajas simultáneas. Revisión administrativa requerida.',deleted_count USING errcode='22023';
 END IF;
 DELETE FROM public.im_envios_cargos_live WHERE sheet_id=p_sheet_id;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  prep:=null;
  IF coalesce(item->>'preparacion','')<>'' THEN prep:=(item->>'preparacion')::date; END IF;
  row_nr:=(item->>'row')::int;
  caja:=trim(item->>'caja');
  shipment_date:=nullif(item->>'envio','')::date;
  raw_cargos:=coalesce(item->>'celda','');
  FOR cargo_code IN SELECT value FROM jsonb_array_elements_text(item->'cargos') LOOP
    INSERT INTO public.im_envios_cargos_live (
      sheet_id,sheet_row,numero,fecha_preparacion,responsable_preparacion,
      codigo_caja,fuente_celda,codigo_cargo,fecha_envio,responsable_entrega,responsable_recibe,placa_transporte,clasificacion_caja
    ) VALUES (
      p_sheet_id,row_nr,coalesce(item->>'numero',''),prep,
      coalesce(item->>'responsable',''),caja,raw_cargos,cargo_code,shipment_date,
      coalesce(item->>'entrega',''),coalesce(item->>'recibe',''),coalesce(item->>'placa',''),trim(coalesce(item->>'clasificacion',''))
    );
  END LOOP;
 END LOOP;
 result:=jsonb_build_object('estado','SINCRONIZADO','cargos',next_count,
   'enviados',(SELECT count(*) FROM public.im_envios_cargos_live
                WHERE sheet_id=p_sheet_id AND fecha_envio IS NOT NULL),
   'preparados',(SELECT count(DISTINCT codigo_caja) FROM public.im_envios_cargos_live
                 WHERE sheet_id=p_sheet_id AND fecha_envio IS NULL),
   'filas',jsonb_array_length(p_rows),'cargos_antes',previous_count,
   'eliminados',deleted_count,'verificado',true,'hora',now());
 INSERT INTO private.im_envios_live_control(sheet_id,payload_sha256,last_synced_at,last_result)
 VALUES(p_sheet_id,nuevo_sha,now(),result)
 ON CONFLICT (sheet_id) DO UPDATE SET
  payload_sha256=excluded.payload_sha256,last_synced_at=excluded.last_synced_at,
  last_result=excluded.last_result;
 RETURN result;
END;
$function$
;
