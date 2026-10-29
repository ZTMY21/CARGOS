# Validación UI — Kardex Digital CD Santa Anita
Fecha: 29 de octubre de 2026. Estado: Preview de revisión; no autorizada para producción.

## Base y aislamiento
- Producción efectiva verificada al cierre: main e8e29b0521b88be1236e7919e7d881355f3bb353.
- Despliegue efectivo: dpl_12SShFkjaUdp9KoXbkATiWhyWwWu, READY, target production.
- Fuente visual: preview/menu-lateral-20261027, c67ff83a1f09dafaea683246a3e1727d1a01f535.
- Rama independiente: preview/ui-integrada-produccion-20261029, creada desde producción actual.
- Integración inicial publicada: f8958cd3347ac628a197d2b8d67edb325266083c. El PR identifica el commit final y su despliegue Preview.
- Divergencia revisada: 39 commits exclusivos de main y 103 exclusivos de la Preview original.
- No se modificaron main ni la rama Preview original. No se promovió ningún despliegue ni se cambiaron dominios, configuraciones o variables de producción.

## Diagnóstico y corrección
La cabecera reutilizada contenía un calendario SVG sin dimensiones explícitas. Una regla más específica para sus span sobrescribía la regla que ocultaba el símbolo decorativo. La combinación revelaba el SVG y le permitía ocupar una superficie desproporcionada.

Se retiraron el símbolo decorativo y las reglas antiguas de cabecera. Las once vistas comparten una única cabecera fuera de las secciones de contenido, con clases propias kd-module-header y descendientes directos. El componente no contiene SVG. Sus estilos no seleccionan gráficas, diálogos o SVG arbitrarios. Los íconos del menú tienen dimensiones explícitas.

Se unificaron jerarquía tipográfica, márgenes, tarjetas, tablas, botones y formularios con blanco, azul oscuro, grises y rojo institucional. Los estados de vencimiento conservan sus colores y cálculos. Se conservaron los grupos estáticos del menú y su desplazamiento sin barra visible. Cambiar módulo vuelve al inicio del contenido.

Se acortaron descripciones y se agruparon instrucciones extensas en desplegables. Se recuperó la visibilidad de información de sincronización y resguardo que el CSS anterior ocultaba. El módulo Reportes enlaza con el reporte completo existente de producción y la exportación individual existente.

## Comparación con producción
| Área | Resultado |
| --- | --- |
| src/repository.js | Idéntico a producción; conserva reportDocs, reportOriginalRows y cargoSafetyStatus |
| Búsqueda, reglas y vencimientos | src/search.js, src/rules.js y src/cargo-expiry.js idénticos |
| Excel y documentos originales | src/excel.js, src/excel-api.js, src/cargo-export.js, src/existencias-report.js y src/existencias-stream.js idénticos |
| Dependencias y configuración npm | package.json, package-lock.json y .npmrc idénticos |
| Apps Script V9 y SQL | scripts/, supabase/ y db/ sin diferencias; no ejecutados |
| src/app.js | Navegación, presentación, nuevas vistas visuales y bloqueos de escritura de Preview; conserva los flujos de datos de producción |
| src/created-dashboard.js y src/cargo-line-chart.js | Integración visual desde Preview |
| index.html y src/admin-ui.css | Cabecera única, estilos y estructura visual |
| vite.config.js | Constante de Preview según VERCEL_ENV; host terminal.local permitido solo en desarrollo |
| Pruebas | Harness compatible con gráficas y nuevas pruebas de rutas, reporte completo y modo Preview |

La constante de Preview evita que el bloqueo temporal de escrituras se convierta en una eliminación de funciones en una futura compilación de producción autorizada. En Preview se bloquean guardados, importación, restablecimiento, permisos, creación/cambio de cuentas y cambios de sincronización; lectura y exportaciones siguen disponibles. Es una protección de la interfaz, no un reemplazo de RLS ni un entorno de datos independiente.

## Datos
Solo se efectuaron consultas SELECT a Supabase. No hubo escrituras ni migraciones de nuestra parte y no se editaron Google Sheets.
Lectura inicial: 3.409 documentos, 2.781.602 códigos de factura declarados, 3.409 relaciones de cargos, años 2020–2026, 0 requerimientos y 282 versiones resguardadas. Última actualización documental observada: 2026-10-29 17:05:22.390941+00.
Estos agregados no equivalen a una copia de respaldo ni a una prueba de identidad de todos los registros. Otro equipo puede actualizar el sistema durante el trabajo.

## Pruebas ejecutadas
- npm ci --ignore-scripts --prefer-offline: correcto con el lock de producción.
- npm run build: correcto, 950 ms en la ejecución final local. Persiste advertencia de chunk ExcelJS superior a 500 kB.
- node --check src/app.js: correcto.
- HTML: identificadores únicos; una cabecera compartida; ningún símbolo decorativo de calendario.
- Cinco pruebas dirigidas: 5/5 correctas; cubren once rutas, ausencia de consultas de búsqueda al navegar, reporte completo aun con filtro sin coincidencias, bloqueo de mutaciones Preview y controles existentes de vencimientos/refresco.
- Seis pruebas dirigidas de login, búsqueda, exportación admin/invitado y repositorio: 6/6 correctas.
- Suite completa en producción e8e29b0: 136 pruebas, 117 correctas, 19 fallos.
- Suite completa integrada: 139 pruebas, 121 correctas, 18 fallos. Todos los nombres de pruebas fallidas también fallan en la línea base. La suite completa NO está verde.
- Se actualizaron dos expectativas de UI obsoletas: texto del botón reemplazado por su nombre accesible y foco en botones ocultos de la vista anterior. No se cambiaron reglas de negocio para satisfacerlas.

Los fallos previos incluyen expectativas de cuatro pestañas/contador antiguo, mensajes y cargas asíncronas de sincronización/IM, el hash CSS anterior, búsqueda exacta de caja y fixtures SQL que no incluyen m.im_codigo_caja. El archivo comparacion-validacion-20261029.json conserva el inventario. Requieren revisión antes de una autorización de producción.

## Navegador
Se recorrieron visualmente las once pantallas con 154 documentos ficticios y un cliente desconectado de Supabase/Sheets. El código de presentación y repositorio era el mismo; solo el cliente de datos se sustituyó para la prueba. Estos archivos de QA no se incluyen en la compilación ni en Git.

| Pantalla | 75 % emulado | 100 % |
| --- | --- | --- |
| Cargos realizados | Revisada | Revisada |
| Vencimientos | Revisada | Revisada |
| Cargos pendientes | Revisada | Revisada |
| Histórico documental | Revisada | Revisada |
| Envíos | Revisada | Revisada |
| Gestión y seguimiento de cajas | Revisada | Revisada |
| Requerimientos | Revisada | Revisada |
| Existencias | Revisada | Revisada |
| Actividad y sincronización | Revisada | Revisada |
| Reportes y descargas | Revisada | Revisada |
| Usuarios y accesos | Revisada | Revisada |

La API del navegador no permitió cambiar el zoom nativo. Se emuló 75 % con un iframe de viewport ampliado y escala 0,75 en Chrome. No se presenta esta prueba como zoom nativo confirmado.
Al 100 %, las once cabeceras midieron 119,5625 px de alto, sin SVG, y scrollWidth igual al ancho útil del documento (1.348 px). En 768 y 390 px se confirmó el menú adaptable, cierre al elegir módulo y ausencia de desbordamiento horizontal del documento (ancho útil 753 y 375 px). Las tablas mantienen desplazamiento dentro de su contenedor.

Se probaron filtros año/mes, comparación de años, paginación de Existencias (página 2 de 2), búsqueda parcial de factura con ubicación original y navegación de tarjeta de vencidos hacia Cargos pendientes. En móvil el estado de conexión se muestra completo.

## Limitaciones y aceptación pendiente
1. La Preview Vercel se abrió y renderizó el login; el acceso seguro con contraseña quedó cancelado. No se verificó el flujo completo con una cuenta real ni se alteraron cuentas para eludirlo.
2. Los eventos automatizados de descarga en Chrome no entregaron un archivo (timeout). Las pruebas de los generadores y handlers pasaron; la descarga completa en navegador con sesión real sigue pendiente. No se atribuye el timeout a una causa confirmada del aplicativo.
3. El navegador y el entorno local dejaron de estar disponibles al final. Las correcciones probadas se conservaron mediante GitHub; no se afirma una nueva ronda visual del despliegue final después de esa desconexión.
4. Debe repetirse la aceptación con Chrome nativo al 75 %, 100 %, sesión admin e invitado y descargas reales antes de cualquier aprobación de producción.
5. Las optimizaciones de Supabase del PR #51 permanecen separadas. Esta rama visual no aplica SQL ni asegura resolver el error 57014.

## Respaldo y reversión para una futura publicación
No se ejecuta ninguna de estas acciones en este encargo.
1. Volver a consultar main y el despliegue efectivo justo antes de publicar. Si avanzaron, integrar selectivamente sus correcciones y repetir la comparación de archivos críticos.
2. Registrar el SHA, deployment ID y alias efectivos; conservar el despliegue previo y el historial Git. La referencia actual es e8e29b0 / dpl_12SShFkjaUdp9KoXbkATiWhyWwWu.
3. Verificar disponibilidad/retención de respaldos de Supabase y copia/versionado de Sheets con el responsable; un respaldo adicional requiere autorización y destino seguro. No sobrescribir datos.
4. Completar login, búsqueda, filtros, documentos originales, IM, exportaciones y sincronización en lectura; resolver o aceptar explícitamente los fallos previos.
5. Publicar solo tras aprobación expresa. Ante regresión, restaurar el despliegue previo autorizado o revertir los commits de UI sobre la main vigente, conservando aportes paralelos.
6. Esta propuesta no requiere migraciones ni reversión de datos. No ejecutar SQL de limpieza o compensación.
