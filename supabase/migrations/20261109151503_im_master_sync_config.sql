-- El Maestro de Drive participa en la conciliación de Acondicionamiento.
-- El registro inactivo satisface la referencia de procedencia sin habilitar
-- el antiguo ingreso de envíos mediante token.
insert into private.im_envios_live_config (sheet_id, token_sha256, active)
values (
  '14tW2-XqukNYozn4P67A7lrhjFfPveAmv',
  encode(extensions.digest(convert_to(gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex'),
  false
)
on conflict (sheet_id) do nothing;
