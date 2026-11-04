create function private.req4_cargos_unicos(p_cargos text[]) returns text[]
language sql immutable set search_path='' as $$
  select coalesce(array_agg(codigo order by primer_orden),'{}')
  from (
    select coalesce(upper(private.req4_cargo(valor)),nullif(btrim(valor),'')) codigo,
      min(orden) primer_orden
    from unnest(p_cargos) with ordinality as c(valor,orden)
    group by 1
  ) cargos
  where codigo is not null;
$$;
revoke execute on function private.req4_cargos_unicos(text[]) from public, anon, authenticated;

-- Los cargos normalizados se usan tanto en la búsqueda como al guardar un préstamo.
alter function private.req4_buscar(text) rename to req4_buscar_fuente;
revoke execute on function private.req4_buscar_fuente(text) from public, anon, authenticated;

create function private.req4_buscar(p_query text) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(fila || jsonb_build_object('cargos',
    private.req4_cargos_unicos(array(select jsonb_array_elements_text(fila->'cargos')))
  ) order by orden),'[]'::jsonb)
  from jsonb_array_elements(private.req4_buscar_fuente(p_query)) with ordinality as r(fila,orden);
$$;
revoke execute on function private.req4_buscar(text) from public, anon;
grant execute on function private.req4_buscar(text) to authenticated;

create or replace function private.req4_detalle() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not private.kardex_has_access(true) then
    raise exception 'Solo administradores' using errcode='42501';
  end if;
  return jsonb_build_object(
    'cajas',coalesce((
      select jsonb_agg(to_jsonb(c) || jsonb_build_object('cargos',private.req4_cargos_unicos(c.cargos)) order by c.codigo)
      from private.req4_cajas c
    ),'[]'::jsonb),
    'movimientos',coalesce((select jsonb_agg(m order by m.registrado) from private.req4_movimientos m),'[]'::jsonb)
  );
end;
$$;
