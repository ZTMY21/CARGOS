-- Validación de marcas de filas en CARGOS NUEVOS, sin borrados ni cambio de permisos.
-- Solo devuelve YA REGISTRADO si el documento contiene cargo, código y grupo.
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
END;$function$

