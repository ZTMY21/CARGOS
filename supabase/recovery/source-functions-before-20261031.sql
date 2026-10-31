CREATE OR REPLACE FUNCTION public.kardex_live_ingest(p_sheet_id text, p_secret text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  item jsonb; r integer; fecha date; yr integer; cargo text; numcargo integer; codigo text; grupo text; norm text;
  existing public.kardex_live_ingresos%ROWTYPE;
  docid uuid; candidates integer; code_conflict boolean;
  old_codes text; oldgroups jsonb; merged_groups jsonb; d public.documentos%ROWTYPE;
  results jsonb:='[]'::jsonb; inserted integer:=0; updated integer:=0; duplicate integer:=0; rejected integer:=0;
BEGIN
  IF coalesce(length(p_secret),0)<30 OR NOT EXISTS (
      SELECT 1 FROM private.kardex_live_sheet_config c
      WHERE c.sheet_id=p_sheet_id AND c.active
      AND c.token_sha256=encode(extensions.digest(convert_to(p_secret,'UTF8'),'sha256'),'hex')
  ) THEN RAISE EXCEPTION 'Credencial de integración no válida' USING errcode='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kardex_google_sync WHERE id=true AND enabled AND file_id=p_sheet_id) THEN RAISE EXCEPTION 'Sincronización pausada o fuente incorrecta'; END IF;
  IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100 THEN
     RAISE EXCEPTION 'El lote debe tener 1 a 100 filas';
  END IF;
  PERFORM private.kardex_set_live_context(p_sheet_id,p_secret);
  PERFORM pg_catalog.pg_advisory_xact_lock(1170196,2);
  FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    r:=NULL;
    BEGIN
      r:=(item->>'row')::integer;
      IF r<2 OR r>100000 THEN RAISE EXCEPTION 'Fila inválida'; END IF;
      IF coalesce(item->>'fecha','') !~ '^20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]$' THEN
         RAISE EXCEPTION 'Fecha inválida: use dd/mm/aaaa';
      END IF;
      fecha:=(item->>'fecha')::date; yr:=EXTRACT(YEAR FROM fecha)::integer;
      cargo:=trim(coalesce(item->>'cargo',''));
      IF cargo !~ '^[0-9]{1,7}A?$' THEN RAISE EXCEPTION 'Cargo inválido'; END IF;
      numcargo:=(regexp_replace(cargo,'A$',''))::integer;
      IF (yr=2026 AND numcargo<933) OR yr<2026 THEN
          RAISE EXCEPTION 'Cargo histórico: no se vuelve a cargar';
      END IF;
      codigo:=trim(coalesce(item->>'codigo',''));
      grupo:=trim(coalesce(item->>'grupo',''));
      IF codigo='' OR length(codigo)>150 OR codigo !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' THEN
           RAISE EXCEPTION 'Código de factura/guía vacío o inválido';
      END IF;
      IF length(grupo)>30 THEN RAISE EXCEPTION 'Grupo demasiado largo'; END IF;
      norm:=private.kardex_normalize(codigo);
      IF norm='' THEN RAISE EXCEPTION 'Código vacío al normalizar'; END IF;

      SELECT * INTO existing FROM public.kardex_live_ingresos
      WHERE sheet_id=p_sheet_id AND row_number=r;
      IF FOUND AND existing.estado='registrado' THEN
         IF existing.anio=yr AND existing.cargo=cargo AND existing.codigo=codigo AND existing.grupo=grupo THEN
            -- No confiar solamente en el marcador técnico de la fila.
            -- Confirmar documento, cargo, código normalizado y grupo real en Supabase.
            SELECT EXISTS (
               SELECT 1 FROM public.documentos validado
               WHERE validado.id=existing.documento_id
                 AND coalesce(validado.anio_origen,extract(year from validado.periodo)::integer)=yr
                 AND cargo=ANY(validado.cargos)
                 AND EXISTS (
                    SELECT 1 FROM regexp_split_to_table(coalesce(validado.facturas,''),'[,;\n]+') as f(codigo)
                    WHERE private.kardex_normalize(f.codigo)=norm
                 )
                 AND (
                    grupo=''
                    OR coalesce(validado.datos_origen->'grupos_por_codigo'->norm,'[]'::jsonb) ? grupo
                 )
            ) INTO code_conflict;
            IF code_conflict THEN
               duplicate:=duplicate+1;
               results:=results || jsonb_build_array(jsonb_build_object(
                  'row',r,'estado','YA REGISTRADO',
                  'detalle','Verificado en Supabase: cargo, código y grupo'));
               CONTINUE;
            END IF;
            -- Si la marca de fila está obsoleta, pasar al flujo seguro de alta/actualización.
            -- Ningún documento se elimina y las facturas repetidas entre cargos se conservan.
         ELSE
            rejected:=rejected+1;
            results:=results || jsonb_build_array(jsonb_build_object(
               'row',r,'estado','REVISAR',
               'detalle','La posición pertenece a otra fila previamente registrada. Revisar o archivar antes de reutilizar.'));
            CONTINUE;
         END IF;
      END IF;

      SELECT count(*),min(id::text)::uuid INTO candidates,docid
      FROM public.documentos x
      WHERE coalesce(x.anio_origen,extract(year from x.periodo)::integer)=yr
      AND EXISTS (
         SELECT 1 FROM unnest(x.cargos) c
         WHERE ltrim(regexp_replace(c,'[.]0+$','','g'),'0') = ltrim(cargo,'0')
      );
      IF candidates>1 THEN RAISE EXCEPTION 'Cargo duplicado en Kardex: requiere revisión'; END IF;

      -- El mismo documento puede estar presente en múltiples cargos.
      -- No comparar el código contra otros documentos: conservar ambas asociaciones.
      -- La deduplicación se mantiene únicamente dentro del cargo actual.

      IF docid IS NULL THEN
        INSERT INTO public.documentos
          (tipo_doc,periodo,ubicacion,cargos,usuario,facturas,clave_origen,hoja_origen,anio_origen,fecha_origen,datos_origen)
        VALUES
          ('Fact / GR / BV',NULL,NULL,ARRAY[cargo],'Registro inmediato Google Sheets',codigo,
           'google-live|'||p_sheet_id||'|'||yr||'|'||cargo,
           'CARGOS NUEVOS',yr,fecha,
           jsonb_build_object('google_sheet_file',p_sheet_id,'grupos_por_codigo',
              CASE WHEN grupo='' THEN '{}'::jsonb ELSE jsonb_build_object(norm,jsonb_build_array(grupo)) END))
        RETURNING id INTO docid;
        inserted:=inserted+1;
      ELSE
        SELECT * INTO d FROM public.documentos WHERE id=docid FOR UPDATE;
        SELECT EXISTS (
           SELECT 1 FROM regexp_split_to_table(d.facturas,'[,;\n]+') code
              WHERE private.kardex_normalize(code)=norm
        ) INTO code_conflict;
        oldgroups:=coalesce(d.datos_origen->'grupos_por_codigo','{}'::jsonb);
        merged_groups:=oldgroups;
        IF grupo<>'' THEN
          merged_groups:=jsonb_set(oldgroups,ARRAY[norm],
            CASE WHEN coalesce(oldgroups->norm,'[]'::jsonb) ? grupo
                  THEN coalesce(oldgroups->norm,'[]'::jsonb)
                  ELSE coalesce(oldgroups->norm,'[]'::jsonb)||jsonb_build_array(grupo)
            END,true);
        END IF;
        UPDATE public.documentos SET
          facturas=CASE WHEN code_conflict THEN facturas
              ELSE concat_ws(', ',nullif(facturas,''),codigo) END,
          datos_origen=jsonb_set(coalesce(datos_origen,'{}'::jsonb),
                  '{grupos_por_codigo}',merged_groups,true)
        WHERE id=docid;
        updated:=updated+1;
      END IF;

      INSERT INTO public.kardex_live_ingresos(sheet_id,row_number,anio,cargo,codigo,grupo,documento_id,estado,observacion)
      VALUES(p_sheet_id,r,yr,cargo,codigo,grupo,docid,'registrado','')
      ON CONFLICT(sheet_id,row_number) DO UPDATE SET
          anio=EXCLUDED.anio,cargo=EXCLUDED.cargo,codigo=EXCLUDED.codigo,grupo=EXCLUDED.grupo,
          documento_id=EXCLUDED.documento_id,estado='registrado',observacion='',registrado_at=now();
      results:=results || jsonb_build_array(jsonb_build_object('row',r,'estado','REGISTRADO','detalle','Sincronizado con Kardex'));
    EXCEPTION WHEN OTHERS THEN
      rejected:=rejected+1;
      results:=results || jsonb_build_array(jsonb_build_object('row',coalesce(r,0),'estado','REVISAR','detalle',left(SQLERRM,180)));
    END;
  END LOOP;
  RETURN jsonb_build_object('nuevos',inserted,'actualizados',updated,'duplicados',duplicate,'pendientes',rejected,'resultados',results);
END;$function$;

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
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.kardex_live_guardar_detalle(p_sheet_id text, p_secret text, p_anio integer, p_cargo text, p_filas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE item jsonb; saved integer:=0; target_id uuid;
BEGIN
 PERFORM private.kardex_set_live_context(p_sheet_id,p_secret);
 IF p_anio<2026 OR p_anio>2100 OR p_cargo !~ '^[0-9]{1,7}A?$'
 THEN RAISE EXCEPTION 'Año o cargo inválido'; END IF;
 IF jsonb_typeof(p_filas)<>'array' OR jsonb_array_length(p_filas) NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'Lote de respaldo debe contener de 1 a 100 filas'; END IF;
 SELECT d.id INTO target_id FROM public.documentos d
 WHERE d.anio_origen=p_anio AND d.cargos @> ARRAY[p_cargo]::text[]
 AND d.clave_origen IN (
   'google-live|'||p_sheet_id||'|'||p_anio||'|'||p_cargo,
   'google-drive|'||p_sheet_id||'|'||p_anio||'|'||p_cargo
 )
 LIMIT 1;
 IF target_id IS NULL THEN RAISE EXCEPTION 'Cargo inexistente o no autorizado para respaldo'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_filas) LOOP
   IF coalesce(item->>'fila','') !~ '^[0-9]{1,6}$'
     OR (item->>'fila')::integer<2 OR (item->>'fila')::integer>1000000
     OR jsonb_typeof(item->'valores')<>'array'
     OR jsonb_array_length(item->'valores')<>14
     OR coalesce(item->'valores'->>1,'')<>p_cargo
     OR coalesce(item->'valores'->>3,'')=''
     OR length(item::text)>30000
   THEN RAISE EXCEPTION 'Fila original inválida o no corresponde a este cargo'; END IF;
   INSERT INTO private.kardex_cargo_detalle_original(sheet_id,anio,cargo,fila_origen,valores)
   VALUES (p_sheet_id,p_anio,p_cargo,(item->>'fila')::integer,item->'valores')
   ON CONFLICT(sheet_id,anio,cargo,fila_origen)
   DO UPDATE SET valores=EXCLUDED.valores,guardado_en=now();
   saved:=saved+1;
 END LOOP;
 RETURN jsonb_build_object('filas_resguardadas',saved,'cargo',p_cargo,'anio',p_anio);
END;$function$;

CREATE OR REPLACE FUNCTION public.kardex_live_reconcile(p_sheet_id text, p_secret text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE row_item jsonb;
  pending_count integer:=0;
  resolved_count integer:=0;
  live_count integer:=0;
BEGIN
  PERFORM private.kardex_set_live_context(p_sheet_id,p_secret);
  IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array'
    OR jsonb_array_length(p_rows)>1200 THEN
    RAISE EXCEPTION 'Conciliación segura: requiere una hoja completa de máximo 1200 filas'
    USING errcode='22023';
  END IF;
  FOR row_item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF coalesce(row_item->>'row','') !~ '^[0-9]{1,6}$'
       OR (row_item->>'row')::integer<2
       OR coalesce(row_item->>'cargo','') !~ '^[0-9]{1,7}A?$'
       OR coalesce(row_item->>'codigo','') !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
       OR coalesce(row_item->>'fecha','') !~ '^20[2-9][0-9]-[0-1][0-9]-[0-3][0-9]$'
       OR length(coalesce(row_item->>'grupo',''))>30 THEN
      RAISE EXCEPTION 'Hay filas incompletas; no se propone ni ejecuta ninguna baja';
    END IF;
  END LOOP;
  SELECT count(*) INTO live_count
  FROM public.kardex_live_ingresos l
  WHERE l.sheet_id=p_sheet_id AND l.estado='registrado';
  -- Prohibir una supuesta hoja vacía si todavía quedan registros técnicos;
  -- evitar falsos positivos ante errores de lectura de Sheets.
  IF jsonb_array_length(p_rows)=0 AND live_count>0 THEN
    RAISE EXCEPTION 'Lectura vacía con cargos activos: no se procesa borrado masivo';
  END IF;

  -- Restaurar propuestas si reapareció la misma factura en la hoja.
  UPDATE private.kardex_conciliaciones_pendientes q
  SET estado='RESUELTO',revisado_en=now()
  WHERE q.sheet_id=p_sheet_id AND q.estado='PENDIENTE'
    AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_rows) j
      WHERE q.anio=extract(year from (j->>'fecha')::date)::integer
      AND ltrim(q.cargo,'0')=ltrim(j->>'cargo','0')
      AND q.codigo_normalizado=private.kardex_normalize(j->>'codigo')
    );
  GET DIAGNOSTICS resolved_count=ROW_COUNT;

  INSERT INTO private.kardex_conciliaciones_pendientes(
    sheet_id,anio,cargo,codigo_normalizado,documento_id,codigo_original,estado
  )
  SELECT l.sheet_id,l.anio,l.cargo,private.kardex_normalize(l.codigo),l.documento_id,
    l.codigo,'PENDIENTE'
  FROM public.kardex_live_ingresos l
  WHERE l.sheet_id=p_sheet_id AND l.estado='registrado'
    AND NOT EXISTS(
      SELECT 1 FROM private.kardex_cargo_archivos a
      WHERE a.sheet_id=l.sheet_id AND a.anio=l.anio AND a.cargo=l.cargo
    )
    AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_rows) j
      WHERE l.anio=extract(year from (j->>'fecha')::date)::integer
      AND ltrim(l.cargo,'0')=ltrim(j->>'cargo','0')
      AND private.kardex_normalize(l.codigo)=private.kardex_normalize(j->>'codigo')
    )
  ON CONFLICT(sheet_id,anio,cargo,codigo_normalizado)
  DO UPDATE SET estado='PENDIENTE',revisado_en=now();
  GET DIAGNOSTICS pending_count=ROW_COUNT;

  RETURN jsonb_build_object(
    'modo','conciliacion_segura','eliminadas',0,
    'bajas_pendientes',pending_count,'restauradas',resolved_count,
    'mensaje','No se borraron documentos ni facturas del Kardex'
  );
END;
$function$;
