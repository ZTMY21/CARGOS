# Archivo documental — estado verificable del PR #53

La migración no está finalizada. Esta actualización continúa el trabajo existente y prepara la conexión real de Vercel, conserva las referencias y evita recopiarlas. La cuenta definitiva es **jaguliquidacion@gmail.com**. La autorización del solicitante para esa cuenta se acepta como declaración aportada por él; no se afirma haber verificado un documento institucional adicional.

## Estado de esta intervención, 31/10/2026

| Elemento | Estado |
| --- | --- |
| Producción y base de integración | `e8e29b0521b88be1236e7919e7d881355f3bb353` |
| Rama del PR | `preview/drive-archive-20261031` |
| PR al iniciar | `247f4389cce62e4327d037ca3d4a832572682314`, borrador |
| Archivos nuevos transferidos / verificados por backend | 0 / 0 |
| Documentos / auditoría / referencias | 3.411 / 13.314 / 2 |
| Referencias existentes | `uploaded`; verificación externa previa, backend pendiente |
| PostgreSQL al iniciar | 413.210.291 bytes |
| PostgreSQL tras preparar metadatos, 18:26 UTC | 413.357.747 bytes |
| Storage antes y después | 32.082.853 bytes |
| Nuevo espacio liberado | 0 bytes, 0 % de cuota liberada |
| Índice exacto de facturas | 179.929.088 bytes; conservado |
| CARGOS: filas comparadas en ambas hojas | 1.426 con cabecera, idénticas |
| Iron Mountain: filas comparadas | 50 con cabecera, idénticas |
| Fuentes nuevas / activadores | No activadas; ejecución y consentimiento pendientes |
| OAuth del backend | Falta el secreto del cliente y el consentimiento de Google |

El crecimiento de 147.456 bytes corresponde a preparación de metadatos. No hay eliminación de documentos, facturas, auditoría ni Storage. La cuota total contratada no se ha obtenido; no se inventa su porcentaje de ocupación.

El parser V10 de Iron Mountain se ejecutó localmente sobre los valores reales leídos de la hoja nueva: 49 cajas y 106 cargos. La huella del payload JSONB coincide exactamente con la última registrada por la fuente original: `4b546a7548d7ca1275177c78de2fbeec2cb78bb9bde8d479c6413a5e24c2fab9`. Esto prueba equivalencia de lectura, **no una sincronización nueva**. La última sincronización registrada de IM es del 22/10/2026; no se afirma que su automatización anterior estuviera funcionando recientemente.

[Baseline de esta intervención](activation-baseline-20261031.json). El informe `real-migration-20261031.json` es un corte histórico anterior y sus cifras de ahorro no son progreso de esta intervención.

## Archivos y ahorro anteriores

El Excel original (32.082.853 bytes) y el respaldo frío cifrado (26.479.484 bytes) ya existen en el destino definitivo: 58.562.337 bytes en dos archivos, descargados y comprobados externamente por SHA-256. La restauración aislada del respaldo frío conservó 3.485 filas, incluidas 115 ausentes de documentos actuales. Existe además copia redundante y un inventario de 28 archivos/hojas adicionales. Siete CSV de ese inventario se verificaron byte por byte; el resto no se presenta como verificado integralmente por SHA-256 en esta ejecución.

El retiro anterior de `private.kardex_documentos_backup_20261014` liberó 47.726.592 bytes brutos de esa relación (~45,52 MiB). PostgreSQL pasó anteriormente de 460.846.771 a aproximadamente 413,2 millones de bytes tras metadatos. **Ese ahorro es anterior y no se cuenta de nuevo.**

El [manifiesto vigente](manifiesto-destino-jagu-20261031.json) conserva IDs, nombres, versiones, relación de importación y checksums. No se deben volver a subir los archivos al conciliar.

## Carpetas definitivas, sin duplicados

Raíz: `15CIlN6SUjC4x5GAkwWKcA_vQap0_cN7W`.

| Categoría | ID |
| --- | --- |
| scans | `1oEgycvzLZTnsyOlHH4MvxwHZBD03H5EY` |
| originals | `1RiDq8y60McRRAqICAi6a-J_A5Gca0K4j` |
| backups | `1gLpExm1HXXxD6bVXK19gzdiBWaWmfT39` |
| history | `17lpnVEtrkLKcZw9epMrhmB0g8lKy5c9k` |
| manifests | `1ftLwJeD74iZdUNnkiWbxS2MWP8W-qinI` |

No se añaden permisos públicos. El backend comprueba propietario, raíz, padres, permisos y capacidad de escritura. Los archivos quedan privados; los clientes reciben contenido mediante la API con autorización de Kardex.

## Conexión del backend

Se reemplaza la necesidad de una `SUPABASE_SERVICE_ROLE_KEY` amplia en Vercel por una capacidad aleatoria exclusiva del módulo. Su hash se conserva en `private.kardex_drive_runtime`; la Edge Function `kardex-drive-metadata` usa la credencial de plataforma dentro de Supabase y solo admite metadatos/leases del archivo y sesiones OAuth. No permite consultar o modificar documentos, facturas o historial.

`/api/drive-connect` utiliza redirect estricto, PKCE, estado de un solo uso durante diez minutos y cookie HttpOnly/Secure. El intercambio de código ocurre en el backend. Comprueba la identidad `jaguliquidacion@gmail.com` y las cinco carpetas. Guarda el refresh token cifrado con AES-256-GCM; no hace falta pegar `GOOGLE_DRIVE_REFRESH_TOKEN` en Vercel ni enviarlo al chat. La clave de cifrado y la capacidad están en variables sensibles de Preview. OAuth solo se habilita en producción tras validación y configuración de la publicación.

Falta guardar **GOOGLE_DRIVE_CLIENT_SECRET** como variable sensible de Preview para esta rama. Usar el cliente existente `537251247027-6qp2bp5pq65tuk8mhn4c2farq490bjtv.apps.googleusercontent.com`, no otro creado sin comprobar el actual. Google solo muestra el secreto al crearlo; si no se conservó, el propietario debe crear un secreto adicional desde Google Cloud y guardarlo privadamente en Vercel.

Redirect requerido:

`https://kardex-digital-santa-anita-git-preview-drive-archi-adff9e-ztmy1.vercel.app/api/drive-connect`

Antes de producción se debe resolver el modo de prueba del consentimiento: Google limita a siete días los refresh tokens con alcance Drive en aplicaciones externas Testing. El alcance `drive.file` no permite leer automáticamente las copias históricas creadas por otro cliente OAuth: requiere selección explícita mediante Picker o cambios de propiedad de aplicación. Para la integración existente se conserva `drive` y se limita el acceso del backend a las carpetas autorizadas. No se ha aceptado consentimiento ni cambiado el modo de publicación sin la intervención específica del propietario.

## Consistencia de archivos

`adopt` registra el mismo ID existente y comprueba nombre, MIME, tamaño, carpeta, revisión y SHA-256 mediante lectura real. No sube otra copia ni cambia su contenido o ACL. Retiene la revisión binaria mediante `keepForever=true`, requisito de Google para descargar una revisión específica. Esta operación de retención sí modifica metadatos del archivo. Fallos de lectura, corrupción o retención no se marcan como completados.

La descarga requiere `status=verified` **y** `backendVerified=true`. El checksum de un conector anterior no habilita una descarga de la aplicación. El lease, el ID de Drive persistido antes de cargar, los offsets comprobados y la clave de idempotencia permiten reanudar sin crear otro archivo. Los administradores cargan; los invitados autorizados consultan cargos permitidos; respaldos globales requieren el permiso adicional de operador.

## Transición de las fuentes

| Fuente | Original activo | Copia preparada |
| --- | --- | --- |
| CARGOS NUEVOS | `18TbKWiVUWKfkJOXvR0kGEMb5eVKTDCfoXAUtD5rCxts` | `14GzTxs9-hk3_vPTI7AYLc3jiqLAaAC5q7y910wo8Jh0` |
| Iron Mountain | `1aWqIoj5UXAeyKhNN1paoYnTa4jdfN8LhDEcdH_lQ4mk` | `1VWmKFmE8UcXV6ukG8k-wqKqCzuJbPGYOf9RFowojhSw` |

Las Edge Functions aceptan ambas identidades autorizadas; el secreto de cada hoja se valida antes de mapear la identidad nueva a la identidad canónica histórica. Esto conserva claves de origen, relaciones y correlativos. El alta de una fuente nueva siempre es **inactiva** y no puede reemplazar credenciales de una fuente activa.

Los scripts V10 conservan el parser y la lógica documental existente. Generan sus secretos dentro de ScriptProperties y envían únicamente su hash al enrolamiento, autenticado por Google como propietario. IM utiliza la Edge Function en vez de una clave de servicio. Los manifiestos Apps Script declaran scopes explícitos; todavía requieren el consentimiento del propietario y comprobación de ejecución.

Orden de activación pendiente:

1. Completar OAuth y comprobar lectura privada, conciliación de los dos IDs existentes, descarga protegida y carga/recuperación controlada.
2. Guardar ambos scripts/manifiestos y ejecutar preparación con el consentimiento de Google. Comprobar build, hash de valores, propietario y estado inactivo en `private.kardex_source_preparation`.
3. Releer originales y copias antes del cambio; resolver cualquier diferencia por ID/fila sin borrar ni duplicar registros.
4. Instalar activadores de las copias con la bandera de ejecución desactivada. Revisar el antiguo KL20; no activar su rutina de limpieza en la copia.
5. Cambiar las configuraciones activas en una transacción; conservar la identidad canónica anterior. Habilitar ejecución V10 y verificar ingestión, conciliación y ausencia de duplicados. Verificar los 5 activadores de CARGOS y 3 de IM.
6. Desactivar los activadores antiguos solo tras confirmar la nueva sincronización. La limpieza desde las 20:00 de Lima conserva el requisito de CSV recuperable y confirmación exacta del Kardex antes de retirar filas.

Hasta completar estas comprobaciones, los originales siguen configurados como activos y no se ejecuta limpieza en las copias.

## SQL y funciones realmente aplicados

- `20261031173042_drive_archive_scoped_backend_runtime.sql`: almacén privado cifrado/capacidad y sesiones OAuth de un uso.
- `20261031180855_prepare_authenticated_source_cutover_preserve_canonical_ids.sql`: alias canónicos, enrolamiento inactivo, sonda autenticada y adaptación de cinco funciones existentes después de autenticar la fuente.
- Edge Functions: `kardex-drive-metadata` v1, `kardex-source-enroll` v1, `cargos-nuevos-onedit` v5, `im-envios-live` v2.

RLS activa y tablas privadas sin permisos directos para anon/authenticated/service_role; acceso mediante funciones específicas. Las Edge Functions usan autenticación propia de capacidad, Google o secreto de hoja; desactivar la comprobación JWT de plataforma no elimina esas comprobaciones. No se cambió configuración global ni índices.

## Validación y límites

La compilación funciona. Las pruebas nuevas cubren SQL/ACL, OAuth ligado a cookie y un solo uso, cifrado, contrato de receptores, identidades canónicas, adopción, corrupción, idempotencia, roles y descargas. La suite completa de integración se compara con el commit e8e29b0: los 19 fallos heredados permanecen y no se presentan como suite verde.

Quedan pendientes pruebas reales desde Vercel con OAuth, inicio de sesión de admin/invitado, búsqueda y Cargo anterior, descargas, exportaciones y ejecución/activadores de las fuentes. Una comparación de código o un test local no reemplaza estas pruebas.

El linter de Supabase informa avisos previos de vista SECURITY DEFINER, funciones administrativas ejecutables y protección contra contraseñas filtradas desactivada. Las tablas privadas sin políticas tienen denegación directa intencionada. No se cambian permisos ajenos a esta migración para silenciar avisos. Referencia: https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view

## Recuperación y publicación

Producción permanece en e8e29b0 hasta cumplir los criterios críticos del encargo. La integración parte del árbol de main actual y traslada solo el módulo documental y la preparación de fuentes: conserva `src/app.js`, `src/repository.js`, dependencias, búsquedas, dashboards y exportadores de producción. No se mezcla íntegramente la antigua rama UI.

Mientras las fuentes nuevas estén inactivas, revertir consiste en mantener `KARDEX_DRIVE_ENABLED=false` y no activar las copias. Se conservan los originales, referencias, archivos y claves. Si fuera necesario revertir las funciones de fuente, están las definiciones previas y las Edge Functions v4/v1 en `supabase/recovery/`; aplicar únicamente ese cambio funcional, sin eliminar tablas ni registros de archivo. Tras un futuro cambio de fuente, suspender primero los activadores nuevos, restaurar atómicamente las configuraciones anteriores y comprobar la sonda antes de reanudar los antiguos. Las identidades canónicas compartidas evitan duplicar documentos al revertir.

La publicación web tiene como reversión el deployment de producción e8e29b0. No borrar referencias o backups al revertir el frontend. La clave del respaldo cifrado debe mantenerse en el gestor de secretos.

El respaldo frío fue restaurado y comprobado. **No se dispone aún de una prueba de restauración completa de toda la base**; `scripts/archive/backup.mjs` y `restore.mjs` están preparados para pg_dump/pg_restore con una conexión entregada por gestor seguro. No se realizan nuevas retiradas de datos ni Storage con ese paso pendiente. El Excel de Storage conserva dependencias del contrato de importación; el historial y el índice de facturas permanecen íntegros.
