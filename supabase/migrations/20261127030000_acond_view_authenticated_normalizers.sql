-- La vista pública de Existencias llama a estos normalizadores al cargar el
-- Kardex. Son funciones puras que no leen ni modifican registros.
-- Sin EXECUTE para authenticated, kardex_snapshot falla con 42501 en el login.
grant execute on function private.acond_clave(text) to authenticated;
grant execute on function private.acond_cargo_clave(text) to authenticated;
grant execute on function private.acond_cargos_claves(text[]) to authenticated;
grant execute on function private.req4_cargo(text) to authenticated;
