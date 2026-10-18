# Kardex Digital — CD Santa Anita

Aplicación compartida de documentos contables con Supabase, construida a partir del HTML original. Conserva su CSS, logo Base64, cuatro bloques desplegables, reglas de estados, semáforos, indicadores y exportación de cuatro hojas.

La aplicación de producción está disponible en https://kardex-digital-santa-anita.vercel.app/. El acceso utiliza cuentas confirmadas e incluidas en la lista privada de miembros.

## Consulta e importación

- Búsqueda parcial o exacta de facturas, con coincidencias resaltadas y datos de Kardex, cargo, requerimiento, ubicación y estado.
- Búsqueda simultánea de Kardex, cargos, facturas, requerimiento asignado, sustento, observaciones y usuario. Normaliza acentos, mayúsculas y separadores.
- Filtros combinables por estado, tipo, ubicación y año contable o año del archivo de origen. Contador de registros y folios, limpieza de filtros y páginas de 100 registros.
- Consulta SQL con índices GIN de trigramas. Las pantallas cargan metadatos y coincidencias; las listas completas de facturas, imágenes y datos originales se solicitan al editar o exportar.
- Buscador rápido de requerimientos.
- Importación `.xlsx` de Requerimientos, Cargos/Documentos y Detalle por Cargo. Cruza todas las filas de detalle por Kardex y vincula requerimientos por `REQ-XXXXX`.
- Adaptador del histórico `.xlsm` con hojas de cargos por año. Agrupa códigos por cargo y fuente, conserva cada fila y su posición, y genera identidades estables para las siguientes importaciones. Los campos que no existen en el archivo quedan vacíos; las fechas y estados declarados en origen se conservan separados del período y estado operativo.
- Cada importación guarda el archivo original en el bucket privado `respaldos-excel`, registra su SHA-256 y prepara lotes. La confirmación final aplica los upserts en una transacción: agrega o actualiza, mantiene los IDs y correlativos, y no elimina registros ausentes del nuevo archivo.
- Reimportar un histórico conserva las asignaciones, ubicación, período, sustento y demás datos operativos editados en la web. Una exportación Kardex sí permite actualizar esos campos explícitos. Los cambios quedan en un historial privado.
- ExcelJS y SheetJS se cargan al importar o exportar. Las macros del archivo original no se ejecutan.

## Datos y acceso

El resumen administrativo calcula **Cargos por Vencer** y **Cargos Vencidos** únicamente para cargos de 2025 y 2026 pendientes de envío. Usa el período contable cuando está registrado y, en su defecto, la fecha de origen del cargo; la fecha de importación no sustituye una fecha faltante. El plazo es de seis meses calendario, ajustado al último día del mes cuando corresponde: el día en que se cumplen seis meses sigue en «por vencer» y al día siguiente pasa a «vencido», según la fecha de Lima.

Cada indicador abre una hoja dentro del aplicativo que muestra solo su categoría, con una fila por cargo, fechas, antigüedad y meses/días vencidos o restantes. Para ver la otra categoría se cierra el detalle y se usa su propio botón en el resumen. Los conteos y el detalle usan la misma información sincronizada, independientemente de los filtros de búsqueda. Los cargos sin fecha válida se identifican aparte y no se clasifican con una fecha supuesta.

El tiempo restante aparece en verde hasta cumplir tres meses, amarillo después de tres meses (incluido el quinto mes) y rojo cuando faltan siete días o menos para cumplir seis meses. Al superar el plazo, el cargo pasa automáticamente a Vencidos. Los cargos nuevos de «Cargos Actuales» reciben este cálculo cuando llegan mediante la sincronización existente, cuya revisión es cada hora. La aplicación recalcula los plazos al recibir cambios, al abrir el detalle y al cambiar de día en Lima, sin guardar fechas ni colores manuales.

Las tablas `requerimientos` y `documentos` usan RLS y una lista privada de miembros confirmados. No se permite consultar documentos de forma anónima. Los editores comparten consultas, creación, edición, eliminación y exportación; los administradores también importan y restablecen datos.

Los correlativos `REQ-XXXXX` y `SA-XXXXX` se asignan en PostgreSQL con un bloqueo transaccional que evita colisiones entre usuarios y protege las importaciones. La clave foránea de caja asignada utiliza `ON DELETE SET NULL`. Las ediciones y eliminaciones comprueban el `updated_at` leído para detectar cambios simultáneos.

Realtime está habilitado en ambas tablas y en una tabla de eventos pequeños. La aplicación escucha los eventos y vuelve a consultar los registros; no transmite millones de facturas por cada cambio. El indicador muestra «Conectado en línea — Sincronizado» cuando la consulta y la suscripción están disponibles.

El repositorio contiene código, migraciones y datos de prueba. Los archivos originales, registros contables y claves privadas no se publican aquí.

## Activación

1. Crear o seleccionar un proyecto Supabase dedicado. Aplicar una sola vez, en orden, las migraciones de `supabase/migrations`. No aplicarlas sobre tablas existentes sin revisar su compatibilidad.
2. Agregar privadamente el correo confirmado del propietario como miembro administrador. Para autorizar al equipo, agregar sus correos confirmados como editores:

   ```sql
   insert into private.kardex_miembros(email,rol)
   values ('propietario@empresa.com','admin'), ('colaborador@empresa.com','editor');
   ```

3. Obtener la URL y una clave pública activa de Supabase. Configurar `SUPABASE_URL` y `SUPABASE_ANON_KEY` en Vercel. El segundo nombre admite tanto una clave `anon` como una clave publishable moderna. El build rechaza claves secretas o `service_role`.
4. Vincular Vercel al repositorio y la rama `main`. `vercel.json` establece Vite, `npm ci`, `npm run build` y salida `dist`. Desplegar una vez configuradas las variables reales.
5. Configurar la URL de sitio y las redirecciones de Supabase Auth con la URL real de producción. El acceso permite contraseña o enlace por correo; configurar SMTP si se necesita enviar enlaces a los miembros del equipo.
6. Importar el Excel con una cuenta administradora. Comprobar los conteos y correlativos confirmados por PostgreSQL, el original en Storage y el flujo en dos sesiones. No publicar un build con credenciales ficticias como instalación de producción.

## Desarrollo

```bash
npm ci
cp .env.example .env.local
```

Completar las dos variables públicas del proyecto correcto antes de iniciar una conexión real.

```bash
npm test
npm run dev
npm run build
```

Para preparar un histórico grande desde la línea de comandos, con Python y lxml instalados, escribir la salida fuera del repositorio:

```bash
python tools/read_excel_rows.py /ruta/archivo.xlsm | node --max-old-space-size=8192 tools/stage-historical.mjs /ruta/privada/importacion.json
```

Ese JSON contiene información real del archivo y no debe agregarse a Git.

## Excel

La exportación conserva las hojas Resumen, Cargos, Detalle por Cargo y Requerimientos, sus estilos y las fórmulas `COUNTIF`, `SUMIF`, `COUNTIFS` y `SUMPRODUCT`. Las columnas ocultas fragmentan imágenes, listas largas de facturas y metadatos de origen para respetar el límite de texto por celda. Las fórmulas consultan las columnas correctas de estado y antigüedad, incluyen todos los cargos y exportaciones de más de 1.000 filas, y se recalculan al abrir en Excel.

Las imágenes no pueden recuperarse de exportaciones antiguas que solo guardaban la indicación de su existencia; las exportaciones de esta versión sí contienen los bytes JPEG.

Ver `VALIDACION.md` para los resultados y los límites de la verificación.
