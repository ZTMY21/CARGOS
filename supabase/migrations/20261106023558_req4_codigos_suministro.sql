create function private.req4_clave_suministro(codigo text) returns text
language sql immutable set search_path='' as $$
  select case when regexp_replace(trim(coalesce(codigo,'')),'[[:space:]]','','g') ~* '^(TD?|P|A)?[0-9][0-9-]*$'
    and length(regexp_replace(codigo,'[^0-9]','','g')) between 5 and 35
    then regexp_replace(codigo,'[^0-9]','','g') end;
$$;
revoke all on function private.req4_clave_suministro(text) from public,anon,authenticated;

-- Conserva la validación y los permisos del balance. Solo amplía los códigos
-- de suministro a las longitudes que ya admite Control de cajas.
do $$
declare definition text := pg_get_functiondef('private.req4_suministro_estado()'::regprocedure);
begin
  if position('private.req4_clave(' in definition)=0 then
    raise exception 'La función de suministro no tiene la versión esperada';
  end if;
  execute replace(definition,'private.req4_clave(','private.req4_clave_suministro(');
end;
$$;
