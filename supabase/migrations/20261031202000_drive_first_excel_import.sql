-- Drive-first Excel imports. Additive: the existing Storage-backed kardex_begin_import
-- and production imports remain unchanged until a verified release.
CREATE OR REPLACE FUNCTION public.kardex_begin_drive_import(
  archivo_nombre text, archivo_file_id text, archivo_sha256 text, archivo_formato text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_import uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT private.kardex_has_access(true) THEN
    RAISE EXCEPTION 'Solo el administrador puede importar' USING errcode='42501';
  END IF;
  IF archivo_nombre IS NULL OR length(archivo_nombre) NOT BETWEEN 1 AND 180
     OR archivo_nombre !~* '\.(xlsx|xlsm)$'
     OR archivo_file_id IS NULL OR archivo_file_id !~ '^[a-zA-Z0-9_-]{10,200}$'
     OR archivo_sha256 IS NULL OR archivo_sha256 !~ '^[a-f0-9]{64}$'
     OR archivo_formato IS NULL OR archivo_formato NOT IN ('kardex','historico') THEN
    RAISE EXCEPTION 'Datos del archivo Excel inválidos';
  END IF;
  -- The backend must have read the exact Drive revision and verified SHA-256.
  -- Accept only an original uploaded by this signed-in administrator.
  IF NOT EXISTS (
    SELECT 1
      FROM public.kardex_drive_jobs j
     WHERE j.document_id IS NULL AND j.import_id IS NULL
       AND j.data->>'driveFileId'=archivo_file_id
       AND j.data->>'name'=archivo_nombre
       AND j.data->>'sha256'=archivo_sha256
       AND j.data->>'category'='originals'
       AND j.data->>'status'='verified'
       AND j.data->>'backendVerified'='true'
       AND coalesce(j.data->>'errorCode','')=''
       AND j.data->>'sourceKey'='excel-import:'||auth.uid()::text||':'||archivo_sha256
  ) THEN
    RAISE EXCEPTION 'Excel original no verificado por Google Drive';
  END IF;
  INSERT INTO public.importaciones(nombre_archivo,storage_path,sha256,formato)
  VALUES(archivo_nombre,'drive://'||archivo_file_id,archivo_sha256,archivo_formato)
  RETURNING id INTO v_import;
  RETURN v_import;
END;
$function$;

REVOKE ALL ON FUNCTION public.kardex_begin_drive_import(text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kardex_begin_drive_import(text,text,text,text) TO authenticated;
COMMENT ON FUNCTION public.kardex_begin_drive_import(text,text,text,text) IS
'Create an Excel import only if a private Drive original is verified by the archive backend and belongs to the calling administrator; no Storage copy.';
