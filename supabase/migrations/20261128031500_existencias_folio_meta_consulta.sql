-- Metadatos mínimos de folios para cuentas autorizadas de consulta.
-- La exportación completa conserva su permiso exclusivo de administrador.
create or replace function public.kardex_existencias_folio_meta()
returns jsonb language plpgsql stable security definer
set search_path='' as $$
begin
  if not private.kardex_has_access(false) then
    raise exception 'Cuenta sin acceso a Existencias' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',d.id,
      'cantidad_registros',nullif(d.datos_origen->>'cantidad_registros','')::integer
    )) from public.documentos d
  ),'[]'::jsonb);
end $$;
revoke all on function public.kardex_existencias_folio_meta() from public,anon;
grant execute on function public.kardex_existencias_folio_meta() to authenticated;
