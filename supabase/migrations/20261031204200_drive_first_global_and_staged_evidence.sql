-- Expand only the metadata integrity CHECK to support two protected Drive-first workflows.
-- Historical references, searches, records, RLS, permissions, and production code remain intact.
ALTER TABLE public.kardex_drive_jobs
  DROP CONSTRAINT kardex_drive_jobs_check;

ALTER TABLE public.kardex_drive_jobs
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
  );

COMMENT ON CONSTRAINT kardex_drive_jobs_check ON public.kardex_drive_jobs IS
  'Allows existing document references, backups and import originals; plus authorized Drive-first Excel imports and staged private evidence before the Kardex row exists.';
