-- El archivo de cargo requiere respaldo CSV verificado y detalle original A:N por fila.
-- Solo se instala en el módulo de sincronización en vivo; no borra documentos.
DO $live_archive_guard$
BEGIN
 IF pg_catalog.to_regclass('private.kardex_cargo_detalle_original') IS NOT NULL
    AND pg_catalog.to_regprocedure('public.kardex_live_archive(text,text,integer,text,jsonb,text,integer)') IS NOT NULL THEN
   EXECUTE $live_archive_sql$
CREATE OR REPLACE FUNCTION public.kardex_live_archive(p_sheet_id text, p_secret text, p_anio integer, p_cargo text, p_codes jsonb, p_backup_id text, p_rows integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  target public.documentos%ROWTYPE;
  incoming_count integer;
  stored_count integer;
  retired_count integer;
  diff_count integer;
  original_count integer;
BEGIN
  IF coalesce(length(p_secret),0)<30 OR NOT EXISTS (
    SELECT 1 FROM private.kardex_live_sheet_config c
    WHERE c.sheet_id=p_sheet_id AND c.active
      AND c.token_sha256=encode(extensions.digest(convert_to(p_secret,'UTF8'),'sha256'),'hex')
  ) THEN RAISE EXCEPTION 'Credencial no válida' USING errcode='42501'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.kardex_google_sync s
    WHERE s.id=true AND s.enabled=true AND s.file_id=p_sheet_id
  ) THEN RAISE EXCEPTION 'Fuente de sincronización inactiva'; END IF;
  IF p_anio NOT BETWEEN 2026 AND 2100 OR p_cargo !~ '^[0-9]{1,7}A?$'
  THEN RAISE EXCEPTION 'Cargo o año inválido'; END IF;
  IF coalesce(length(p_backup_id),0)<15 OR length(p_backup_id)>255
  THEN RAISE EXCEPTION 'Debe existir un respaldo CSV en Google Drive'; END IF;
  IF p_rows IS NULL OR p_rows<1 OR p_rows>100000
  THEN RAISE EXCEPTION 'Cantidad de filas inválida'; END IF;
  IF p_codes IS NULL OR jsonb_typeof(p_codes)<>'array'
    OR jsonb_array_length(p_codes)<1 OR jsonb_array_length(p_codes)>100000
  THEN RAISE EXCEPTION 'Códigos inválidos o ausentes'; END IF;
  PERFORM private.kardex_set_live_context(p_sheet_id,p_secret);
  PERFORM pg_catalog.pg_advisory_xact_lock(1170196,2);
  SELECT d.* INTO target FROM public.documentos d
    WHERE d.anio_origen=p_anio
      AND d.cargos @> ARRAY[p_cargo]::text[]
      AND (
        d.clave_origen = 'google-live|'||p_sheet_id||'|'||p_anio||'|'||p_cargo
        OR d.clave_origen = 'google-drive|'||p_sheet_id||'|'||p_anio||'|'||p_cargo
      );
  IF NOT FOUND THEN RAISE EXCEPTION 'No se encontró un cargo originado en esta hoja'; END IF;
  WITH incoming AS (
    SELECT DISTINCT private.kardex_normalize(value) AS code
    FROM jsonb_array_elements_text(p_codes)
  ),
  stored AS (
    SELECT DISTINCT private.kardex_normalize(rawcode) AS code
    FROM regexp_split_to_table(coalesce(target.facturas,''),'[,;\\n]+') AS rawcode
  ),
  differences AS (
    (SELECT code FROM incoming EXCEPT SELECT code FROM stored)
    UNION ALL
    (SELECT code FROM stored EXCEPT SELECT code FROM incoming)
  )
  SELECT (SELECT count(*) FROM incoming), (SELECT count(*) FROM stored),
         (SELECT count(*) FROM differences)
  INTO incoming_count,stored_count,diff_count;
  IF incoming_count=0 OR incoming_count<>stored_count OR diff_count<>0
  THEN RAISE EXCEPTION 'ARCHIVO BLOQUEADO: los códigos de Google Sheets no coinciden exactamente con la base de datos'; END IF;
  -- Un CSV no basta para declarar el archivo seguro: conservar cada una de
  -- las 14 columnas de la hoja dentro de Supabase antes de retirar filas.
  SELECT count(*) INTO original_count
  FROM private.kardex_cargo_detalle_original f
  WHERE f.sheet_id=p_sheet_id AND f.anio=p_anio AND f.cargo=p_cargo;
  IF original_count<>p_rows THEN
    RAISE EXCEPTION 'ARCHIVO BLOQUEADO: faltan filas originales A:N en el respaldo permanente de Supabase';
  END IF;
  WITH expected AS (
     SELECT DISTINCT private.kardex_normalize(v.value) AS code
     FROM jsonb_array_elements_text(p_codes) AS v(value)
  ), archived AS (
     SELECT DISTINCT private.kardex_normalize(f.valores->>3) AS code
     FROM private.kardex_cargo_detalle_original f
     WHERE f.sheet_id=p_sheet_id AND f.anio=p_anio AND f.cargo=p_cargo
  ), mismatches AS (
     (SELECT code FROM expected EXCEPT SELECT code FROM archived)
     UNION ALL
     (SELECT code FROM archived EXCEPT SELECT code FROM expected)
  )
  SELECT count(*) INTO diff_count FROM mismatches;
  IF diff_count>0 THEN
    RAISE EXCEPTION 'ARCHIVO BLOQUEADO: códigos del respaldo original no coinciden con los del Kardex';
  END IF;
  DELETE FROM public.kardex_live_ingresos l
  WHERE l.sheet_id=p_sheet_id AND l.anio=p_anio AND l.cargo=p_cargo;
  GET DIAGNOSTICS retired_count = ROW_COUNT;
  INSERT INTO private.kardex_cargo_archivos(
    sheet_id,anio,cargo,backup_file_id,cantidad_filas,codigos_unicos,archived_at
  ) VALUES (p_sheet_id,p_anio,p_cargo,p_backup_id,p_rows,incoming_count,now())
  ON CONFLICT (sheet_id,anio,cargo) DO UPDATE
  SET backup_file_id=EXCLUDED.backup_file_id,
      cantidad_filas=EXCLUDED.cantidad_filas,
      codigos_unicos=EXCLUDED.codigos_unicos,
      archived_at=now();
  RETURN jsonb_build_object('archivado',true,'cargo',p_cargo,'anio',p_anio,
    'codigos_verificados',incoming_count,'filas_respaldo',p_rows,
    'registros_tecnicos_retirados',retired_count,
    'documento_id',target.id,'backup_file_id',p_backup_id);
END;
$function$

$live_archive_sql$;
 END IF;
END;
$live_archive_guard$;
