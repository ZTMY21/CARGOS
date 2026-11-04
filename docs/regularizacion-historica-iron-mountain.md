# Regularización de envíos históricos a Iron Mountain

- Base de trabajo: `main` en `baaf703`.
- La vista `kardex_documentos_resumen` y el buscador `kardex_search` muestran la decisión activa de la auditoría privada. Los documentos, las facturas y las fuentes de sincronización se conservan.
- La conciliación distingue entre regularización administrativa, envío documentado que tenía una solicitud superpuesta y solicitud en revisión. Los envíos documentados conservan el código, la fecha y el responsable de la fuente aplicable.
- Existencias calcula la referencia de seis meses al mostrar el cargo. Las estadísticas de cajas enviadas siguen leyendo fechas efectivas. El Excel administrativo incluye los históricos en el total de enviados y conserva la columna de fecha efectiva.
- El resumen cuenta una vez cada cargo repetido desde 2026 y conserva las identidades históricas originales. Las cajas solicitadas o preparadas sin envío acreditado están incluidas en pendientes.
- Pruebas específicas en `tests/app.test.js` y `tests/existencias-report.test.js`. El diagnóstico comprobó la consulta con un administrador y un invitado, dentro de una transacción revertida. El lote operativo se registra en Supabase por separado de la migración de estructura.

## Reversión operativa

La bitácora `private.kardex_im_historical_audit` conserva el corte anterior, el motivo, el lote y el actor. Para revertir una decisión, un operador de base de datos registra `revoked_at`, `revoked_by` y `revocation_reason` en la entrada activa, usando el lote y el ID del documento revisados. La vista deja de exponer esa decisión y vuelve a resolver el estado desde las fuentes vigentes. Un cargo con evidencia insuficiente permanece en revisión hasta conciliar el envío.
