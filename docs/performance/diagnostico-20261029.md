# Diagnóstico de rendimiento — 29 de octubre de 2026

**Estado:** correcciones preparadas para revisión. No se aplicaron definiciones SQL, migraciones, índices, cambios de datos ni configuraciones globales a Supabase. No se desplegó producción.

Rama: `fix/performance-supabase-20261029`, creada desde `preview/menu-lateral-20261027` en `0e59e69aec6a3e11d945fe3e9a0af5b5a1ea8332`. Durante el trabajo, el equipo paralelo añadió dos commits. Se incorporó su estado `fe7a79c2209f83804e327a1496ea111977a7f746` únicamente a esta rama de reparación, sin conflictos; el diff del PR conserva solo los cambios de rendimiento. La rama de origen permanece intacta. Los cambios de interfaz y Dashboard de Vencimientos quedan fuera de este PR.

## Evidencia del incidente

En la ventana de 24 horas consultada durante el diagnóstico:

| RPC | Solicitudes | HTTP 500 | Mediana HTTP | P95 HTTP |
|---|---:|---:|---:|---:|
| kardex_previous_cargos | 278 | 266 (95,68 %) | 8.364 ms | 10.188 ms |
| kardex_snapshot | 335 | 15 (4,48 %) | 2.018 ms | 9.201 ms |

Los registros Postgres y la cabecera `PostgREST; error=57014` confirman cancelaciones por `statement_timeout`. Vercel no registró errores de funciones en su consulta de 24 horas: las llamadas fallidas llegan directamente del navegador a PostgREST.

La base contiene 3.408 documentos y 2.781.113 tokens documentales, unos 40,1 millones de caracteres normalizados. Las estadísticas acumuladas desde el 14/10 muestran 5.983 ejecuciones exitosas del snapshot para `authenticated`, con media de 748,30 ms y máximo de 7.994,03 ms. Los timeouts no quedan necesariamente incluidos en esas ejecuciones exitosas.

En la muestra de salud hubo 30 conexiones de 60 disponibles, 2 activas, ninguna esperando un lock y ningún bloqueo. No se encontró evidencia de bloqueo o agotamiento de conexiones en esa muestra; no equivale a una serie histórica de CPU o I/O.

## Causas observadas

1. **Cargos anteriores:** el plan de `authenticated` usa un Nested Loop sobre el catálogo materializado y evalúa `string_to_array(...) @> ARRAY[code]` repetidamente. No usa el índice GIN de códigos exactos en ese plan. La estimación de pocos tokens no representa las decenas de miles que puede traer una página. Probar solo como `postgres` ocultaba el costo del plan sujeto a RLS: incluso selecciones de un documento y de diez superaron 8 segundos bajo `authenticated`.
2. **Carga del resumen:** la vista realiza cruces de envíos y preparación y normaliza códigos dentro de una consulta lateral repetida por documento. Se mantienen tanto las coincidencias exactas como la regla de códigos cortos y ceros iniciales.
3. **Cliente:** cada refresco borraba la caché de relaciones, renderizar una tabla oculta disparaba una consulta de hasta 100 IDs, la suscripción inicial repetía el snapshot y eventos `SIGNED_IN` podían recargar una sesión ya cargada. La renovación de token también provocaba una lectura completa.

No se atribuye el incidente a un cambio de Vercel. La presión simultánea de las consultas es una explicación posible de los picos del snapshot, pero no se midió una serie de CPU para demostrar esa relación.

## Correcciones

### Código del aplicativo

- Carga de sesión compartida entre llamadas simultáneas; eventos repetidos del mismo usuario no reinician la aplicación. El botón Reconectar conserva la comprobación explícita de acceso.
- Suscripción Realtime antes de la primera lectura; se conserva la conciliación cuando llega un evento o se restablece una conexión después de tener datos.
- Los eventos durante una lectura solicitan una conciliación posterior; las llamadas concurrentes normales comparten la lectura.
- Un solo render de los documentos al terminar la carga inicial.
- Cargos anteriores se consultan cuando Existencias está visible para el administrador; los invitados conservan la consulta en su tabla.
- Caché conservada si el conjunto de IDs y `updated_at` no cambió. Cambiar, añadir o eliminar cualquier documento invalida las relaciones, porque puede afectar a otros cargos.
- Cola compartida para serializar peticiones de páginas diferentes, límite de 100 IDs por RPC y cancelación al cerrar sesión o abandonar Existencias.
- Los resultados parciales correctos se conservan. Un error no se registra como ausencia de relaciones y tiene un intervalo de 30 segundos antes de volver a intentar al renderizar.

**Reducir lotes no resolvió el timeout de la función actual y se descartó como solución. El código conserva páginas de hasta 100 IDs, que la consulta SQL propuesta procesó en aproximadamente dos segundos. El PR de cliente por sí solo no corrige la función que sigue instalada.**

### SQL propuesto, pendiente de autorización

Archivo: [performance-20261029.sql](../../db/proposals/performance-20261029.sql).

- La consulta de cargos anteriores materializa una sola lectura del catálogo sujeto a RLS y expande sus códigos una vez; cruza por igualdad exacta con los códigos solicitados.
- Se conserva `SECURITY INVOKER`, la comprobación de acceso, el límite de entrada, las reglas cronológicas, todos los cargos por documento, el agrupamiento, los códigos que justifican cada coincidencia y el orden de salida.
- La vista resumen materializa los cruces de envíos y preparación una vez y calcula las normalizaciones una vez por código. Su proyección no carga facturas completas, imágenes ni JSON de origen.
- Se mantienen las columnas, propietario, permisos y comportamiento de seguridad de la vista existente. No se añaden funciones `SECURITY DEFINER` ni se cambian políticas RLS.
- Se conserva el ajuste local ya existente `enable_nestloop=off` del snapshot y de la búsqueda. No se aumentan timeouts.
- El SQL está fuera de `supabase/migrations`: no existe un paso automático que lo aplique.
- [Rollback de definiciones](../../db/proposals/performance-20261029-rollback.sql), también sujeto a autorización. No restaura ni modifica registros.

## Mediciones comparables

Se usaron transacciones `READ ONLY`, un límite **local** de 8 segundos y consultas SELECT equivalentes. El rol `authenticated` se reprodujo con una identidad existente y una reclamación local a la transacción, sin crear usuarios ni sesiones. Esto comprueba el plan con RLS, no un inicio de sesión real por contraseña.

| Caso | Antes | Después, 3 ejecuciones | Mediana después |
|---|---:|---|---:|
| 100 cargos anteriores, authenticated | timeout > 8.000 ms | 2.137,773 / 1.774,245 / 1.930,188 ms | 1.930,188 ms |
| Snapshot, postgres | 809,629 / 680,525 / 692,842 ms | 467,475 / 326,420 / 321,561 ms | 326,420 ms |

La mediana del snapshot pasó de **692,842 a 326,420 ms**, una reducción del **52,9 %**. Para cargos anteriores el descenso es de **al menos 75,9 %** frente al umbral de cancelación, no frente a una duración completa conocida.

El snapshot pasó de 32.702 a 11.291 bloques compartidos accedidos; el caso propuesto no escribió bloques temporales en esas tres mediciones. La consulta histórica nueva sigue expandiendo todo el catálogo y escribió 9.787 bloques temporales (~76,5 MiB) por ejecución. La cola del cliente reduce solapamientos dentro de una sesión; estas medidas no prueban capacidad con muchos usuarios simultáneos.

**Integridad comprobada con datos actuales:**

- Los 100 resultados históricos coinciden exactamente con el resultado de la función original ejecutada en sublotes de diez como `postgres`: mismo digest JSON canónico, `2bc58ad8c45fd7fefb62a98d31747731`.
- La vista propuesta devuelve exactamente los mismos 3.408 registros y todos sus campos.
- La búsqueda de un código documental real devolvió un registro con igualdad completa de la respuesta antes/después al sustituir únicamente la vista por el SELECT propuesto.
- No se descargaron los registros históricos al repositorio; la evidencia contiene métricas y planes.

Los SELECT del resumen se probaron con el ajuste local de planificación ya usado por las funciones. No se creó la vista propuesta en la base compartida.

## Revisión de índices

Ya existen `documentos_facturas_codigos_exactos_idx` (GIN sobre el array normalizado), índices trigram de búsqueda, la PK por ID y el índice único de Kardex. Añadir otro índice equivalente no resolvería el plan observado. **No se propone crear ni eliminar índices en este PR.**

Performance Advisor señaló dos claves foráneas sin índice: `documentos.importacion_id` y `kardex_live_ingresos.documento_id`. No se observó que participaran en estos timeouts; quedan como hallazgos para una revisión específica, sin DDL propuesto. No se eliminan índices señalados como “sin uso”.

Se consultaron los avisos de seguridad existentes y no se alteraron sus permisos ni políticas como parte de esta reparación.

## Pruebas y límites

- **15 pruebas específicas pasan:** sesión, búsqueda manual, exportación completa de un cargo, relaciones filtradas por factura, caché, reintentos, cola, cancelación y equivalencia SQL.
- La prueba SQL usa una base local PGlite con 125 documentos sintéticos: duplicados documentales, múltiples cargos, años diferentes, códigos cortos, fechas nulas, límites 0/1/10/11/100/101, permisos, RLS y rollback. El conteo y digest de todos los registros permanecen iguales.
- `npm run build` pasa con la clave pública y URL existentes, sin claves privilegiadas. Permanece la advertencia de tamaño de los módulos de exportación.
- Suite completa: **112 pasan y 25 fallan**. Los mismos 25 fallos de funcionalidad previa se reproducen en el commit base con el mismo arnés corregido; no hay fallos nuevos. Incluyen expectativas de escritura incompatibles con `isPreview=true`, textos o navegación antiguos y dependencias de migraciones de pruebas.
- El arnés de JSDOM se reparó para ejecutar los módulos de gráficos en su propio DOM y compartir los constructores Map/Set; antes detenía las pruebas con `createCreatedDashboard is not defined`. No se cambió código visual para resolverlo.
- No se realizó una prueba de navegador con credenciales reales ni un despliegue de producción. El inicio de sesión, búsqueda y descarga se verificaron con integración local; el acceso con RLS y las respuestas SQL se verificaron por separado en la base real.
- El SQL aún no está instalado: no se afirma que hayan desaparecido los HTTP 500 del servicio compartido.

Comandos:

```sh
npm ci
node --test --test-name-pattern='performance:|Cargo anterior|factura concreta|blank login|only Buscar|admin and guest export' tests/app.test.js tests/performance-repository.test.js tests/performance-sql.test.js
npm test
npm run build
```

## Integración propuesta

1. Revisar el PR contra la rama de trabajo, sin merge a producción.
2. Antes de aplicar SQL, volver a leer las definiciones de función y vista por si el equipo paralelo las cambió; comparar con el rollback incluido. Obtener autorización explícita para las dos definiciones.
3. Aplicar y probar primero en una base de pruebas autorizada. Repetir la igualdad de JSON, RLS, búsqueda, login y exportación mediante una cuenta de prueba. Medir el flujo HTTP y carga moderada en ese entorno.
4. Eliminar o actualizar los 25 fallos previos mediante trabajo separado; este PR sigue en borrador.
5. La publicación y cualquier modificación de la base compartida requieren autorización adicional. No hay merge, migración ni promoción automática en este trabajo.

Evidencia: [métricas](evidence-20261029.json) y [planes compactos](plans-20261029.json).

Referencias técnicas: [PostgreSQL 17 — WITH/MATERIALIZED](https://www.postgresql.org/docs/17/queries-with.html), [Supabase — Query performance](https://supabase.com/docs/guides/database/query-optimization), [Supabase — RLS performance](https://supabase.com/docs/guides/database/postgres/row-level-security-performance) y [Supabase — Performance Advisor](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).
