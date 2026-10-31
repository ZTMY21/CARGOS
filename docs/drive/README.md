# Archivo documental en Google Drive — preparación segura

Fecha de auditoría: 31 de octubre de 2026. **No se ha ejecutado una migración real.**

## Estado comprobado

- Producción efectiva y main: `e8e29b0521b88be1236e7919e7d881355f3bb353`, deployment `dpl_12SShFkjaUdp9KoXbkATiWhyWwWu`, READY.
- Preview de partida: `89ace69cf31bf02be4c201282d70490159eac815`.
- Rama técnica aislada: `preview/drive-archive-20261031`, derivada de la rama solicitada. PR hacia `preview/ui-integrada-produccion-20261029`; main no se modifica.
- Supabase: ACTIVE_HEALTHY, PostgreSQL 17.11.0.003. Solo SELECT/EXPLAIN en la base real.
- Carpeta destino: `1GfQ2dyRghO_hg4Vb0NRaf-Um5hRKdJs0`, vacía al revisar, propiedad del Gmail personal indicado. El permiso de propietario en Drive **no acredita autorización institucional**.
- No se encontró una autorización institucional en la búsqueda dirigida de documentos de Kardex. No se transfirió documentación empresarial.
- Vercel solo tiene `SUPABASE_URL` y `SUPABASE_ANON_KEY`. No hay credenciales de Drive ni clave de servicio del backend configuradas. No se solicitaron secretos por chat.

## Espacio y alcance real del ahorro

| Componente | Bytes observados | MiB aproximados | Decisión |
| --- | ---: | ---: | --- |
| PostgreSQL completo | 460.846.771 | 439,50 | Sin modificaciones |
| public.documentos, **incluye índices** | 306.241.536 | 292,05 | Conservar |
| Índice exacto, **incluido en la fila anterior** | 179.929.088 | 171,59 | Conservar |
| private.kardex_historial | 81.993.728 | 78,20 | Evaluar retención y archivo externo |
| private.kardex_documentos_backup_20261014 | 47.726.592 | 45,52 | Candidato frío; requiere respaldo restaurado y autorización |
| private.kardex_documentos_resguardos | 5.357.568 | 5,11 | Conservar protección contra pérdida |
| Objeto Excel en Storage | 32.082.853 | 30,60 | Copia pendiente de autorización |

La base contiene 3.411 documentos, 2.782.529 códigos declarados y 3.411 relaciones de cargos. Hay 13.314 filas de historial, 3.485 filas en el respaldo de 20261014 y 282 resguardos. La suma física observada de datos_origen es 27.071.014 bytes; sustento_imagen suma **0 bytes**. Por tanto, no hay una colección grande de escaneos embebidos que por sí sola explique el consumo actual.

No sumar 171,59 MiB de índice a 292,05 MiB de documentos: el índice ya está incluido. Storage y PostgreSQL son conceptos separados; copiar el Excel de Storage a Drive no reduce PostgreSQL. No se calculó un porcentaje de cuota sin verificar el denominador del plan.

**Ahorro por esta ejecución: 0 bytes. Archivos reales trasladados/verificados: 0/0.** Crear copias no libera espacio. El retiro futuro de versiones frías podría evitar crecimiento y permitir reutilizar páginas; recuperar cuota física exige medir cada operación aprobada. DELETE/VACUUM normal no garantiza devolver archivos al sistema operativo. No se ejecutó limpieza, TRUNCATE, DROP, REINDEX, CLUSTER ni VACUUM FULL.

## Dependencias que impiden retirar datos a ciegas

El inventario completo de tablas, tamaños, índices, claves foráneas, triggers, funciones y huellas está en `baseline-20261031.json`.

- `src/repository.js`: fetchDoc/fetchImage, importFile, search y reportOriginalRows consumen originales, grupos y archivos de Storage.
- `src/cargo-details.js`, `src/cargo-export.js`, `src/existencias-report.js` y `src/existencias-stream.js`: descompresión de datos originales, ubicación de códigos, exportación individual y hojas anuales. No se cambian.
- `kardex_search`, `kardex_previous_cargos`, `kardex_snapshot` y `kardex_documentos_resumen`: búsqueda/relaciones/lectura operativa. El índice exacto registra 325.294 recorridos en las estadísticas consultadas. EXPLAIN ANALYZE confirmó Bitmap Index Scan en una consulta de coincidencia (9,265 ms totales, una fila). Es una muestra, no una garantía para todas las cargas ni una prueba de sustitución del índice.
- Triggers de documentos: auditoría, normalización, notificación, exclusión de escrituras, caché de exportación y resguardo antes de pérdida. Siguen intactos.
- V9 de Apps Script: ingestión, conciliación, resguardo de filas y archivo diario; conserva sus procesos y destinos actuales. No se editaron Sheets ni el script.
- `kardex_live_guardar_detalle`, `kardex_live_archive` y `kardex_detalle_original_exportar`: necesitan las filas originales antes de archivar y al reconstruir Excel. No se sustituyen por un enlace sin recuperación.
- `public.importaciones.storage_path` y `kardex_begin_import`: siguen esperando el respaldo en Storage. Una migración posterior debe adaptar ese contrato antes de retirar el objeto.

Mover datos_origen o el historial requiere primero una ruta de lectura y restauración probada para cada consumidor. Esta entrega agrega una capa para **nuevos archivos**, sin vaciar campos antiguos ni cambiar los contratos existentes.

## Implementación preparada

- `api/drive-archive.js`: backend de carga, consulta, conciliación, manifiesto y descarga autenticada.
- `server/archive/`: cliente OAuth de Drive, repositorio, validaciones y máquina de estados.
- `db/proposals/drive-archive.sql`: tabla de referencias y leases. **Propuesta, no aplicada en Supabase real.** Se ejecutó solo en PostgreSQL/PGlite aislado durante pruebas.
- `drive-archive.html`: módulo adicional enlazado desde Reportes, con demostración ficticia y transferencia real deshabilitada.
- `scripts/archive/`: backup cifrado, restauración local y preparación de carpetas.

No se usan las credenciales de ChatGPT para autenticar Vercel. El backend necesita su propia autorización OAuth y secretos gestionados. Ninguna credencial de servicio, refresh token ni URL de carga de Drive se entrega al navegador. Las capacidades de carga se cifran en PostgreSQL con AES-256-GCM. Los archivos reales se leen desde Drive por el backend y se entregan como adjuntos privados, sin enlaces públicos.

### Flujo de archivo

1. Resolver un Kardex existente mediante RLS; validar nombre, MIME, tamaño, origen, versión y SHA-256.
2. Registrar metadatos sin cuerpo del archivo. La clave idempotente incluye cargo, origen, versión, categoría y checksum; no colapsa relaciones legítimas entre cargos.
3. Reservar un ID de Drive y conservarlo antes de cargar. Adquirir un lease de PostgreSQL para evitar escritores simultáneos.
4. Subir bloques de hasta 1 MiB con protocolo resumible. Los bloques intermedios respetan múltiplos de 256 KiB; el límite de la interfaz es 100 MiB por archivo. No se incrementa el timeout de SQL.
5. Consultar la posición real de Drive ante reintentos. Una sesión expirada se reinicia manteniendo la referencia lógica.
6. Recuperar una revisión concreta, calcular SHA-256 en el backend y comparar tamaño, carpeta y relación. Solo entonces marcar `verified`.
7. Una referencia incompleta o corrupta no permite descargar. Si desaparece una copia verificada, se marca `attention` para conciliación. No existe una ruta de borrado de origen.

Los respaldos globales pueden registrarse sin inventar un cargo: `documentId: null` solo se admite para respaldos/manifiestos y exige un operador incluido en `KARDEX_DRIVE_BACKUP_OPERATOR_IDS`, además de permisos administrativos. Los invitados no pueden acceder a esos respaldos. Los documentos asociados a cargos siguen la autorización del Kardex existente. Los manifiestos se exportan por streaming NDJSON y recorren todas las páginas de referencias.

### Organización prevista de Drive

- 01_Escaneados
- 02_Excel_originales
- 03_Respaldos
- 04_Historico
- 05_Manifiestos

La herramienta conectada permite leer esta carpeta, pero su acción de creación no admite carpetas. Se preparó `provision-folders.mjs` para crear/verificar los cinco destinos secuencialmente con las credenciales propias del backend, después de la autorización. Sus IDs se configuran explícitamente: la aplicación no crea carpetas duplicadas bajo concurrencia ni cambia permisos.

## Activación pendiente — sin secretos por chat

1. Aportar referencia de la autorización institucional: responsable, cuenta/destino autorizados, tipos de documentos, retención y acceso. Hasta entonces no transferir documentación empresarial al Drive personal. Valorar una unidad compartida o cuenta institucional si esa es la política aprobada.
2. Configurar un cliente OAuth propio de la organización y los secretos de backend en Vercel. Usar alcance mínimo que permita acceder al destino aprobado; la carpeta creada por otro cliente OAuth puede requerir autorización específica. No ampliar scopes sin aprobarlo. Consultar la guía oficial de OAuth.
3. Proveer un proyecto Supabase **aislado** para pruebas, aplicar allí la propuesta SQL y configurar `KARDEX_DRIVE_SANDBOX_PROJECT_ID`. La Preview rechaza escrituras a `uhjwhamzjxhjqlrhgxho` aunque alguien active el interruptor.
4. Completar `.env.archive.example` mediante el gestor de secretos. No subir un .env con valores. Mantener `KARDEX_DRIVE_ENABLED=false` hasta comprobar permisos, carpetas y credenciales. Nunca habilitar producción por esta tarea.
5. Preparar los cinco destinos con `node scripts/archive/provision-folders.mjs` en un entorno seguro y registrar sus IDs. No se cambian ACL ni se crean enlaces públicos.
6. Copiar primero un archivo autorizado, comprobar descarga y SHA-256, registrar su manifiesto, simular fallo y conciliación. Repetir con el Excel de 32.082.853 bytes y validar restauración antes de cualquier retirada.
7. Para producción hacen falta revisión, autorización expresa, actualización de la comparación contra main vigente y el flag independiente de publicación aprobada. Esta entrega no autoriza producción.

## Respaldo y restauración

Se preparó un backup completo mediante pg_dump custom, cifrado en streaming con AES-256-GCM, SHA-256 de contenido y cifrado, permisos 0600 y manifiesto. No escribe un dump en claro y no sube datos a Drive automáticamente.

No se generó un dump completo de producción: faltan herramientas pg_dump/pg_restore y una conexión PostgreSQL de backup gestionada. Las claves públicas de Supabase no sustituyen esa conexión. Las huellas de auditoría son comprobaciones, **no respaldos**.

Con herramientas oficiales y conexión gestionada disponibles, el operador ejecuta `node scripts/archive/backup.mjs /ruta-segura/private-archive`. PGHOST/PGSERVICE y KARDEX_BACKUP_KEY se proporcionan por el gestor de secretos; nunca como argumentos que incluyan contraseñas.

`restore.mjs` acepta únicamente PGHOST local explícito y una base vacía llamada kardex_restore_*. No usa --clean, DROP ni TRUNCATE. El entorno de restauración debe tener preparados los roles de Supabase. La prueba debe completar restauración y comparar conteos, hashes, relaciones, originales y duplicados. El manifiesto no declara restauración verificada automáticamente.

El checksum registrado en la importación del Excel de Storage es `b8faad0ca271740afb5d32bd8f1a97d05c6741b5785a1e80ef75692e0202ee85`. Es un valor registrado; no se presenta como una nueva verificación byte a byte del objeto actual.

## Pruebas y límites

Se probaron recuperación, cifrado, corrupción, reintentos, pérdida de confirmación, sesiones expiradas, límites de bloques, duplicados, separación de relaciones, permisos, paginación y el flujo HTTP → repositorio SQL → adaptador Drive → descarga. También se respaldó/restauró una base PostgreSQL/PGlite con registros ficticios repetidos y clave foránea.

La prueba binaria de 32.082.853 bytes verifica transporte en 31 bloques y almacenamiento de metadatos pequeño; no es una copia del Excel real. El demo público utiliza dos archivos ficticios y ningún proveedor externo. Sus resultados no demuestran conectividad real de Google Drive.

Las pruebas originales de búsquedas, exportaciones, vencimientos, cajas y Sheets se mantienen. La suite de partida conserva 18 fallos conocidos; no se corrigen alterando reglas de negocio en esta migración. La validación final del PR detalla resultados de la ejecución actual. La disponibilidad real de Cargo anterior y su error 57014 sigue separada del almacenamiento.

Pendientes: OAuth real y su revocación/rotación, restauración completa del dump real, permisos con cuentas reales admin/invitado/operador, descarga del archivo autorizado, prueba de Sheets en staging y prueba de cuota después de una retirada aprobada. No se ejecutan altas/bajas reales para comprobar una interfaz.

## Reversión

Mientras siga desactivado, basta con descartar esta rama: producción, datos y procesos originales siguen siendo la fuente operativa.

Después de un piloto autorizado, desactivar nuevas transferencias y conservar los manifiestos. El origen sigue disponible; volver a la lectura original no necesita restaurar datos eliminados. No borrar las copias de Drive ni modificar permisos como parte automática de la reversión. Si hubo una retirada futura aprobada, restaurar desde el dump/archivo validado, conciliando por identificador y versión; no sobrescribir registros recientes indiscriminadamente.

## Fuentes técnicas consultadas

- https://developers.google.com/workspace/drive/api/guides/manage-uploads
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://supabase.com/changelog.md (revisadas las notas de TLS y PostgreSQL 17.11; no se cambió configuración)
- https://vercel.com/docs/functions/limitations
