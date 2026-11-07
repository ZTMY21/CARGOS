-- Las cajas conciliadas ya existían en el Maestro al registrar su solicitud.
-- Se incluyen en el avance por código sin atribuirles una lectura de pistola.
alter table private.recepcion_cajas add column origen text not null default 'escaneo'
  check (origen in ('escaneo','maestro'));

create or replace function private.recepcion_estado(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',r.id,'numero',r.numero,'cantidad',r.cantidad_cajas,'solicitante',r.usuario,
    'creada',r.created_at,'fecha_solicitud',r.fecha_solicitud,
    'recepcion_fisica',(
      select (m.datos->>'cantidad')::integer from private.req4_movimientos m
      where m.requerimiento=r.id and m.tipo='recepcion_fisica_informada' order by m.registrado desc limit 1
    ),
    'confirmada',(
      select m.registrado from private.req4_movimientos m
      where m.requerimiento=r.id and m.tipo='recepcion_completa' order by m.registrado limit 1
    ),
    'lecturas',coalesce((
      select jsonb_agg(jsonb_build_object('clave',c.clave,'codigo',c.codigo,'leido',c.leido,
        'guardado',c.guardado,'correlativo',c.correlativo,'operador',c.operador,'origen',c.origen) order by c.leido,c.clave)
      from private.recepcion_cajas c where c.requerimiento=r.id
    ),'[]'::jsonb))
  from public.requerimientos r where r.id=p_id;
$$;
