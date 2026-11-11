-- Todos los administradores aprobados comparten la recepción de cajas nuevas.
-- Conserva los controles de administrador, solicitud válida, duplicados, límites,
-- bloqueo de Excel, recepción completa y trazabilidad del operador.
-- No modifica datos existentes ni las funciones de otros módulos.

CREATE OR REPLACE FUNCTION private.recepcion_solicitud(p_id uuid)
RETURNS public.requerimientos
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE r public.requerimientos;
BEGIN
  IF auth.uid() IS NULL OR NOT private.kardex_has_access(true) THEN
    RAISE EXCEPTION 'Solo administradores' USING errcode='42501';
  END IF;
  SELECT * INTO r FROM public.requerimientos
    WHERE id=p_id AND tipo='Cajas nuevas para acondicionar'
      AND cantidad_cajas BETWEEN 1 AND 100;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe una solicitud válida de cajas nuevas' USING errcode='42501';
  END IF;
  RETURN r;
END;
$function$;

CREATE OR REPLACE FUNCTION private.recepcion_operacion(
  p_accion text, p_id uuid, p_codigo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  r public.requerimientos;
  clave_caja text;
  existe private.recepcion_cajas;
BEGIN
  IF auth.uid() IS NULL OR NOT private.kardex_has_access(true) THEN
    RAISE EXCEPTION 'Solo administradores' USING errcode='42501';
  END IF;
  IF p_accion='estado' THEN
    IF p_id IS NULL THEN
      -- La solicitud activa pertenece al equipo, no al creador.
      SELECT id INTO p_id FROM public.requerimientos
      WHERE tipo='Cajas nuevas para acondicionar'
        AND cantidad_cajas BETWEEN 1 AND 100
        AND (fecha_recepcion IS NULL OR EXISTS(
          SELECT 1 FROM private.recepcion_cajas c
          WHERE c.requerimiento=requerimientos.id
        ))
      ORDER BY (fecha_recepcion IS NULL) DESC, created_at DESC
      LIMIT 1;
    END IF;
    IF p_id IS NULL THEN RETURN NULL; END IF;
    PERFORM private.recepcion_solicitud(p_id);
    RETURN private.recepcion_estado(p_id);
  END IF;
  IF p_accion IS DISTINCT FROM 'leer' THEN
    RAISE EXCEPTION 'Acción inválida';
  END IF;
  PERFORM pg_advisory_xact_lock(1170196,1);
  r:=private.recepcion_solicitud(p_id);
  IF NOT EXISTS(SELECT 1 FROM private.recepcion_maestro_prueba)
    AND NOT EXISTS(SELECT 1 FROM private.recepcion_maestro_produccion WHERE id AND habilitada) THEN
    RAISE EXCEPTION 'Recepción de prueba deshabilitada';
  END IF;
  IF r.fecha_recepcion IS NOT NULL THEN
    RAISE EXCEPTION 'La recepción ya está cerrada';
  END IF;
  IF p_codigo IS NULL OR p_codigo !~* '^(TD|T|P)?[0-9]{10}$' THEN
    RAISE EXCEPTION 'Código incompleto o inválido. Se esperan diez dígitos y un prefijo opcional T, TD o P';
  END IF;
  clave_caja:=regexp_replace(p_codigo,'[^0-9]','','g');
  SELECT * INTO existe FROM private.recepcion_cajas c WHERE c.clave=clave_caja;
  IF FOUND THEN
    IF existe.requerimiento=r.id THEN
      RETURN private.recepcion_estado(r.id) || jsonb_build_object('duplicada',true);
    END IF;
    RAISE EXCEPTION 'La caja pertenece a otro requerimiento' USING errcode='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM private.recepcion_maestro_prueba m WHERE m.codigos ? clave_caja)
    OR EXISTS(SELECT 1 FROM public.im_envios_cargos_live l WHERE private.req4_clave_suministro(l.codigo_caja)=clave_caja)
    OR EXISTS(SELECT 1 FROM private.box_conditioning b WHERE b.code=clave_caja)
    OR EXISTS(SELECT 1 FROM private.req4_cajas b WHERE b.clave=clave_caja) THEN
    RAISE EXCEPTION 'La caja ya está registrada en el Maestro o en otro proceso' USING errcode='23505';
  END IF;
  IF (SELECT COUNT(*) FROM private.recepcion_cajas c WHERE c.requerimiento=r.id)>=r.cantidad_cajas THEN
    RAISE EXCEPTION 'Ya se alcanzó la cantidad solicitada';
  END IF;
  INSERT INTO private.recepcion_cajas(clave,codigo,requerimiento,operador)
    VALUES(clave_caja,p_codigo,r.id,auth.uid());
  RETURN private.recepcion_estado(r.id);
END;
$function$;