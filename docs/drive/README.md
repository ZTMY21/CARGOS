> **Actualización operativa — destino definitivo confirmado:** el usuario autorizó `jaguliquidacion@gmail.com` como cuenta para Cardex Digital. Carpeta: [Cardex Digital (nuevo Drive)](https://drive.google.com/drive/folders/15CIlN6SUjC4x5GAkwWKcA_vQap0_cN7W). El Excel y el respaldo cifrado están copiados en este destino, descargados y comprobados por SHA-256; también existe una copia redundante privada y un manifiesto histórico copiado. El [nuevo manifiesto de conciliación](manifiesto-destino-jagu-20261031.json) registra los IDs correctos (el viejo conserva IDs de la cuenta personal). La tabla `private.kardex_documentos_backup_20261014` se archivó externamente y retiró de PostgreSQL: 460.846.771 → 413.120.179 bytes, reducción de 47.726.592 bytes; tras crear la tabla operativa de referencias `public.kardex_drive_jobs` (RLS activa y cero filas), la última medida fue 413.169.331 bytes. No se modificaron los 3.411 documentos, ni la auditoría de 13.314 registros, ni el índice de facturas. **OAuth del backend, operador y referencias activas todavía pendientes; producción conserva e8e29b0.** El resto de este documento conserva el corte histórico previo a estas operaciones.

# Archivo real de Kardex en Google Drive

Actualización del 31/10/2026, sobre el PR #53 y su commit inicial `b31ea919`. La migración **no está finalizada**: existen copias reales verificadas, pero el backend del aplicativo y el ahorro de cuota siguen pendientes.

## Resultado real

| Concepto | Resultado |
| --- | ---: |
| Archivos de datos/respaldo copiados | 2 |
| Descargas reales con SHA-256 coincidente | 2 |
| Bytes de esos dos archivos | 58.562.337 (55,85 MiB) |
| Manifiesto adicional verificado | 1, de 7.656 bytes |
| Total con manifiesto | 58.569.993 bytes |
| Filas de la tabla fría restauradas | 3.485 |
| PostgreSQL antes / después | 460.846.771 / 460.846.771 bytes |
| Storage antes / después | 32.082.853 / 32.082.853 bytes |
| Espacio liberado / porcentaje de cuota liberado | 0 bytes / 0 % |
| Referencias registradas en Supabase | 0; 2 pendientes |

Evidencia agregada, fecha del corte y conteos: [real-migration-20261031.json](real-migration-20261031.json). Los archivos y el manifiesto están en la carpeta privada Cardex Digital indicada por el solicitante; no se ampliaron permisos.

La declaración del solicitante se registró en [este comentario del PR](https://github.com/ZTMY21/CARGOS/pull/53#issuecomment-6543447924). Se acepta como información aportada por él; no se afirma haber verificado un documento institucional.

### Excel original

- Nombre conservado: Lista de Cargos 2021-2026(2).xlsm.
- Tamaño: 32.082.853 bytes.
- SHA-256: `b8faad0ca271740afb5d32bd8f1a97d05c6741b5785a1e80ef75692e0202ee85`.
- Procedencia de la copia: original aportado anteriormente por el usuario. Coincide con el checksum registrado en `public.importaciones`.
- Se descargó la copia de Drive y se recalculó SHA-256; también pasó la integridad ZIP del libro con macros, sin ejecutar macros.
- No se descargó de nuevo el objeto actual de Supabase Storage. La coincidencia comprobada es contra el original y el checksum de importación registrado.
- Su importación y fechas de origen constan en el manifiesto. El objeto de Storage sigue disponible.

### Respaldo del 14/10

- Tabla: `private.kardex_documentos_backup_20261014`, 3.485 filas y 27 columnas.
- Tiene **115 identificadores ausentes de documentos actuales**. No es una copia prescindible.
- Se extrajo por SELECT paginado y se conservaron todas las columnas, arrays, JSON, fechas y valores nulos.
- JSON canónico de las filas: 157.465.209 bytes, antes de saltos de línea y cabecera.
- Archivo gzip cifrado con AES-256-GCM: 26.479.484 bytes.
- SHA-256 del cifrado: `4e258ad59aaec84315243d4c5f3923d321253adfdcb1c4d16d8e414da4500c9f`.
- Huella de filas original, exportada y restaurada: `e4a3626d48690f40068cbc20a781ea4aba10fb7b8264ebba9828a6baf4bfb9f5`.
- Restauración real en PostgreSQL/PGlite aislado con tipos originales; coincidieron las 3.485 filas y su huella completa.
- La copia cifrada se descargó de Drive y coincidió byte a byte con el archivo restaurado.
- No se encontraron dependencias en vistas ni menciones en funciones public/private mediante el catálogo consultado. Esto no demuestra ausencia de consumidores externos.
- **Es un respaldo recuperable de esa tabla, no un dump completo del proyecto.**

La huella usa SHA256 de UTF-8 de las hojas `id:SHA256(to_jsonb(fila)::text)`, ordenadas por ID y separadas por LF sin LF final. Se comprobó de nuevo en Supabase al cerrar la extracción; coincide con la auditoría inicial. No fue una transacción única de toda la base.

## Configuración real preparada

Se reutilizaron las cinco carpetas existentes, sin crearlas otra vez:

| Categoría | Carpeta | ID |
| --- | --- | --- |
| scans | 01_Escaneados | 1QEqhDWaT716gBW3t6H9MXNytgGbdcj0O |
| originals | 02_Excel_originales | 1jfxbds5Y5u7pijiaZOoKkhFyHy_S6gfc |
| backups | 03_Respaldos | 1aKVNVo7W98NwdobqoMfgphc61I7iU0MZ |
| history | 04_Historico | 1XZ156Kp65OEZod7q_VByuMzB4rZGCJGo |
| manifests | 05_Manifiestos | 1zCOURrF0n3NDtZCa1aqoAJEBH5okDT4t |

En Vercel se configuraron raíz, propietario, IDs y referencia de la declaración, únicamente para `preview/drive-archive-20261031`. También se generaron claves independientes de backup y sesiones y se guardaron como secretos sensibles de esa rama. No se guardaron valores de secretos en Git, en el manifiesto ni en el navegador. La clave del backup debe conservarse para recuperarlo.

`KARDEX_DRIVE_ENABLED=false`. No se modificaron variables de producción.

La conexión de Drive utilizada para las copias **no autentica el backend de Vercel**. Se intentó abrir la configuración de Vercel; el inicio seguro con Google no se completó. No se intentaron métodos alternativos ni se pidieron contraseñas por chat.

## Correcciones de la integración

- `adopt` registra una copia existente después de verificar carpeta, nombre, MIME, tamaño, revisión y SHA-256 mediante el backend. No carga ni modifica ese archivo.
- Reintentar el mismo manifiesto conserva la referencia idempotente. Un ID de Drive distinto no puede reemplazar una referencia existente.
- Los Excel globales se relacionan con una importación existente mediante `import_id`, sin inventar un cargo. El SHA-256 debe coincidir con el de esa importación.
- Los respaldos/importaciones globales exigen administrador y el permiso separado de operador. Los invitados solo pueden consultar documentos a los que tengan acceso.
- El MIME de Excel se normaliza a minúsculas: Google devuelve `macroenabled.12`, que el código anterior podía rechazar.
- Se corrigió el bloqueo de interfaz que impedía consultar archivos de cargos a invitados autorizados.
- La Preview muestra el corte de copias reales y el espacio realmente liberado. La prueba ficticia queda como comprobación técnica adicional, sin contarse en la migración.
- `table-snapshot.mjs` empaqueta exportaciones verificadas sin sobrescribir un snapshot existente. Restaura únicamente en PostgreSQL embebido temporal; no acepta una conexión remota.

La propuesta SQL agrega solo la tabla nueva de referencias, sus restricciones, RLS y funciones de lease. **No se ha aplicado al proyecto real.** No se cambiaron las tablas operativas, sus registros, índices o configuraciones.

## Lo que falta para activar el aplicativo

1. Completar el acceso seguro a la configuración de Vercel/Google. Registrar/autorizar el cliente OAuth del backend y guardar sus secretos en Vercel; la conexión de ChatGPT no los reemplaza. Si se elige Vercel Connect, hay que crear y autorizar el conector y adaptar el proveedor de tokens; este PR mantiene el flujo OAuth de refresh ya implementado.
2. Proporcionar mediante un gestor seguro una conexión PostgreSQL de respaldo y la credencial backend de Supabase. El conector disponible no ofrece contraseña de PostgreSQL ni clave de servicio. No extraerlas con SQL ni enviarlas por chat.
3. Ejecutar el dump completo cifrado con `backup.mjs`, respaldar roles/configuración y Storage por separado según corresponda, restaurar en un destino local vacío con `restore.mjs` y comparar conteos, relaciones y exportaciones. El respaldo de una tabla no satisface este paso.
4. Revisar y autorizar expresamente `db/proposals/drive-archive.sql` para la base operativa. No se aplica esa migración mientras falte el respaldo completo y su revisión.
5. Configurar el operador real y aprobar el modo exclusivo de copias mediante `KARDEX_DRIVE_REAL_COPY_PROJECT_ID` y `KARDEX_DRIVE_REAL_COPY_APPROVAL_REF`. El código exige además entorno Preview y esta rama exacta. Producción tiene un bloqueo independiente.
6. Activar en Preview, cargar el manifiesto privado en “Conciliar copias existentes” y ejecutar la lectura/verificación real desde el backend. Las dos referencias pendientes se incorporan sin duplicar archivos.
7. Probar con cuentas reales admin/invitado las búsquedas, descargas, Cargo anterior, Excel de Existencias/cargos, cajas y Sheets en un entorno seguro. No se han declarado aprobadas esas pruebas reales en esta ejecución.

No hace falta crear otra carpeta ni volver a transferir estos dos archivos. Si una carga queda con resultado incierto, localizar la copia existente y verificarla antes de cualquier reintento.

## Espacio y retirada futura

Los 439,50 MiB de PostgreSQL incluyen los índices. El índice exacto de facturas de 171,59 MiB ya está incluido en los 292,05 MiB de documentos. Storage es independiente.

La tabla del 14/10 ocupa 47.726.592 bytes en PostgreSQL (45,52 MiB). Su copia externa ya es recuperable; una retirada futura requiere el dump completo, revisión de consumidores externos y autorización expresa. No se entrega ni ejecuta DROP, TRUNCATE o limpieza de registros.

El historial sigue con sus 13.314 filas. Su archivado debe hacerse por cortes de versiones con manifiestos, reanudación y lectura de recuperación, conservando trazabilidad y sin afectar los triggers activos. No se ha retirado ninguna versión.

El índice exacto se conserva: es una parte importante de las búsquedas y Cargo anterior. No se ha demostrado una sustitución equivalente y no se reconstruyó. Los datos originales siguen alimentando ubicación, búsqueda y Excel; no se vacían sin adaptar y verificar sus lectores.

Copiar archivos no disminuye `pg_database_size`. Tampoco se confunde espacio que una futura limpieza deje reutilizable con cuota efectivamente recuperada. El ahorro medido de esta ejecución es cero; la migración no se declara completada.

## Validación y reversión

- Dos archivos reales descargados de Drive, checksums coincidentes y acceso privado.
- Manifiesto adicional descargado, SHA-256 `4f4f1fff15358c1bde62e9adc92fd30ac448ad476928340c5468765821a9f245`, dos entradas completas.
- 3.485 filas reales restauradas con tipos originales y huella completa idéntica.
- 23 pruebas focalizadas aprobadas; incluyen adopción sin escrituras a Drive, rechazo de corrupción, permisos, idempotencia y aislamiento.
- Build correcto; permanece el aviso de tamaño de ExcelJS.
- La suite completa anterior conserva 18 fallos conocidos; las pruebas focalizadas no significan que toda la suite esté verde.
- Conteos sin cambios: 3.411 documentos, 2.782.529 códigos, 13.314 filas de historial, 3.485 filas de la tabla fría y 282 resguardos.
- No se modificaron búsqueda, cálculos, dashboards, exportadores operativos, dependencias, Apps Script ni Sheets. La incidencia previa de Cargo anterior sigue pendiente de validación/corrección; no se atribuye al almacenamiento.

Para revertir esta intervención, mantener el módulo desactivado y retirar únicamente los cambios de esta rama. Los originales continúan operativos, por lo que no hace falta restaurarlos. No eliminar las copias externas ni las claves de recuperación durante la reversión. Cualquier recuperación de datos debe conciliar IDs/versiones y evitar sobrescribir registros recientes.

## Referencias técnicas

- https://developers.google.com/workspace/drive/api/guides/manage-uploads
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://supabase.com/docs/guides/platform/backups
- https://vercel.com/docs/connect
