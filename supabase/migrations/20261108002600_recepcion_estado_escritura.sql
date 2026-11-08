-- Informa a Control de cajas si producción tiene autorizada la escritura en el Maestro.
do $$
declare
  definition text:=pg_get_functiondef('private.recepcion_estado(uuid)'::regprocedure);
  anchor text:=$p$'id',r.id,'numero',r.numero$p$;
begin
  if position(anchor in definition)=0 then raise exception 'Versión de recepción no reconocida'; end if;
  execute replace(definition,anchor,$p$'escritura_habilitada',exists(
      select 1 from private.recepcion_maestro_produccion where id and habilitada
    ),'id',r.id,'numero',r.numero$p$);
end;
$$;
