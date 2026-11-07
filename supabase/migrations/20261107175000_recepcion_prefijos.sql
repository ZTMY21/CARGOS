-- El Maestro utiliza prefijos en mayúsculas y minúsculas. Conserva la lectura
-- literal en la fila D y sigue usando los diez dígitos como clave de unicidad.
do $$
declare
  definition text:=pg_get_functiondef('private.recepcion_operacion(text,uuid,text)'::regprocedure);
  prior text:=$pattern$p_codigo !~ '^(TD|T|P)?[0-9]{10}$'$pattern$;
begin
  if position(prior in definition)=0 then
    raise exception 'La validación de códigos no tiene la versión esperada';
  end if;
  execute replace(definition,prior,replace(prior,'!~','!~*'));
end;
$$;
