-- 2026-10-31: Safe compact GIN index for invoice matching.
-- Original matching remains exact; 32-bit hashes are only candidate prefilters.
CREATE OR REPLACE FUNCTION public.kardex_invoice_hashes(p_search text)
RETURNS integer[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=''
AS $$
  SELECT array(
    SELECT pg_catalog.hashtext(t.code)
    FROM pg_catalog.unnest(pg_catalog.string_to_array(p_search,',')) AS t(code)
  );
$$;
COMMENT ON FUNCTION public.kardex_invoice_hashes(text) IS
  'Compact prefilter only. Always check the original exact invoice text to exclude hash collisions.';

CREATE INDEX IF NOT EXISTS documentos_facturas_hash_compacto_idx
  ON public.documentos USING gin (public.kardex_invoice_hashes(busqueda_facturas));

DO $compact_index$
DECLARE
  definition text;
  old_predicate text;
  safe_predicate text;
  index_valid boolean;
BEGIN
  SELECT i.indisvalid AND i.indisready INTO index_valid
  FROM pg_catalog.pg_index i
  WHERE i.indexrelid='public.documentos_facturas_hash_compacto_idx'::pg_catalog.regclass;
  IF NOT COALESCE(index_valid,false) THEN
    RAISE EXCEPTION 'Compact index is not valid; preserve old index';
  END IF;
  definition := pg_catalog.pg_get_functiondef('public.kardex_previous_cargos(uuid[])'::pg_catalog.regprocedure);
  old_predicate := $old$pg_catalog.string_to_array(p.busqueda_facturas,',') @> array[c.code]$old$;
  safe_predicate := $safe$public.kardex_invoice_hashes(p.busqueda_facturas) @> array[pg_catalog.hashtext(c.code)]
    and pg_catalog.string_to_array(p.busqueda_facturas,',') @> array[c.code]$safe$;
  IF pg_catalog.strpos(definition,'public.kardex_invoice_hashes(p.busqueda_facturas)')=0 THEN
    IF pg_catalog.strpos(definition,old_predicate)=0 THEN
      RAISE EXCEPTION 'Unknown previous-cargo function; refusing to discard old index';
    END IF;
    EXECUTE pg_catalog.replace(definition,old_predicate,safe_predicate);
  END IF;
  IF pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.kardex_previous_cargos(uuid[])'::pg_catalog.regprocedure),
       'pg_catalog.string_to_array(p.busqueda_facturas')=0 THEN
       RAISE EXCEPTION 'Exact text verification missing; refusing to discard old index';
  END IF;
END $compact_index$;

DROP INDEX IF EXISTS public.documentos_facturas_codigos_exactos_idx;
