# CARGOS NUEVOS — Corrección de sincronización y limpieza segura (29/10/2026)

## Estado real

- **Supabase — aplicado:** `kardex_live_ingest` comprueba documento, año, cargo, código normalizado y grupo antes de devolver `YA REGISTRADO`. Una marca técnica sin respaldo real se reprocesa sin eliminar documentos. Si se reutiliza una fila para otro cargo sin archivarla, devuelve `REVISAR`.
- **Supabase — aplicado:** `kardex_live_archive` bloquea cualquier retiro de filas técnicas si faltan originales A:N en `private.kardex_cargo_detalle_original`, aunque el CSV exista. También compara los códigos guardados con la lista enviada. Se mantienen `public.documentos` y duplicados legítimos entre cargos.
- **Google Sheets — aplicado:** instrucciones corregidas en la pestaña `INSTRUCCIONES`. El 27/10 constaban cero filas retiradas, así que no se afirmó que la limpieza hubiese sido ejecutada.
- **Apps Script — V9 preparada, NO desplegada desde este entorno:** código en `scripts/apps-script/Cargos_Nuevos_V9_Correcciones_Seguras.gs`. No hay acceso a los activadores ni al editor Apps Script desde los conectores actuales.

## Instalar V9 sin perder la configuración existente

1. Abrir el **Google Sheets original CARGOS NUEVOS** y seleccionar **Extensiones > Apps Script**.
2. Hacer una copia del código de `Código.gs` como respaldo. No eliminar las propiedades seguras del proyecto, especialmente `CARGOS_WEBHOOK_TOKEN`. Nunca copiar el token a GitHub ni a celdas.
3. Sustituir **el código V8 completo**, no añadirlo al lado, por el contenido completo de `Cargos_Nuevos_V9_Correcciones_Seguras.gs`. V8 y V9 definen los mismos nombres y no pueden convivir en el mismo proyecto.
4. Guardar, seleccionar `instalarTiempoReal`, pulsar **Ejecutar** y autorizar. La instalación sustituye los activadores de `alEditarCargos`, `alEliminarFilas`, `sincronizarCargosPeriodico`, `archivarCargosDiarios` y `conciliarCargosSeguros_` y retira el antiguo `ejecutarLimpiezaKardex20h` si existe.
5. Revisar los activadores y `INSTRUCCIONES!D5:E7` después de las 20:00, horario `America/Lima`. Apps Script revisa cada 5 minutos; no garantiza ejecución al segundo exacto.

## Qué protege la V9

- Los registros `CAMBIO PENDIENTE` se reenvían al receptor; una fila corregida en `REVISAR` vuelve a cola, pero el receptor impide reemplazar registros ajenos por accidente.
- Soporta grupos no contiguos del mismo cargo y limita la cantidad por operación. Registra todas las columnas A:N y crea CSV con los nombres de archivo y PDF originales.
- Requiere 20 minutos de tranquilidad, archivo CSV verificable, confirmación de respaldo de filas originales en Supabase y cotejo de códigos **antes** de retirar las filas del Google Sheet temporal.
- El histórico `.xlsm` **no se reescribe automáticamente**. Supabase conserva los documentos y el detalle original; Drive conserva un CSV por cargo. Para actualizar el archivo Excel histórico se requiere una conciliación separada que respete sus macros y estructura.
- Esta instalación **no se ha ejecutado aún desde este entorno**. No confundir el código preparado en GitHub con un activador de Google ya instalado.

## Verificación que ya se realizó

Cargo 939 (2026): 491 filas técnicas en `kardex_live_ingresos`, las 491 vinculadas a documento real, 489 códigos distintos y ninguna asociación faltante. Al momento de comprobación, no había comenzado el archivo de originales A:N de ese cargo: 0 filas archivadas. Por seguridad, el servidor rechazaría retirar las filas sin completar el respaldo.
