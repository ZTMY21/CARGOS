ALTER TABLE public.kardex_drive_jobs
  DROP CONSTRAINT kardex_drive_jobs_check,
  ADD CONSTRAINT kardex_drive_jobs_check CHECK (
    document_id IS NOT NULL
    OR (data->>'category') IN ('backups','manifests')
    OR (import_id IS NOT NULL AND data->>'category'='originals')
    OR (
      document_id IS NULL AND import_id IS NULL
      AND data->>'category'='originals'
      AND data->>'sourceKey' ~ '^excel-import:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-f0-9]{64}$'
    )
    OR (
      document_id IS NULL AND import_id IS NULL
      AND data->>'category'='scans'
      AND data->>'sourceKey' ~ '^sustento:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    OR (
      document_id IS NULL AND import_id IS NULL
      AND data->>'category'='scans'
      AND coalesce(data->>'mime','')='application/pdf'
      AND data->>'sourceKey' ~* '^pickup(:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}){3}$'
    )
  );

COMMENT ON CONSTRAINT kardex_drive_jobs_check ON public.kardex_drive_jobs IS
  'Allows document archives, backups, manifests, Excel imports, staged evidence, and pickup PDFs bound to an aviso, visit and actor.';
