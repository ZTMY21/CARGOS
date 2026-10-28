-- Return only the two fields absent from the synchronized snapshot. Never send
-- the compressed historical invoice records during an inventory export.
create or replace function public.kardex_existencias_export_meta()
returns jsonb language plpgsql stable security definer
set search_path='' as $$
begin
  if not private.kardex_has_access(true) then
    raise exception 'Solo administradores pueden exportar existencias' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',d.id,
      'cantidad_registros',nullif(d.datos_origen->>'cantidad_registros','')::integer,
      'responsable_entrega',live.responsable_entrega
    ))
    from public.documentos d
    left join lateral (
      select l.responsable_entrega
      from public.im_envios_cargos_live l
      where l.codigo_cargo=any(d.cargos) and l.fecha_envio is not null
      order by l.updated_at desc limit 1
    ) live on true
  ),'[]'::jsonb);
end $$;
revoke all on function public.kardex_existencias_export_meta() from public,anon;
grant execute on function public.kardex_existencias_export_meta() to authenticated;
