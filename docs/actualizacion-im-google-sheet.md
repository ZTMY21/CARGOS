# Integración pendiente tras el visto bueno — clasificación de caja IM

La vista previa del aplicativo no se publica a producción y el SQL propuesto no se ha ejecutado. El Google Sheet oficial ya tiene 10 columnas; solo se añadió F, desplazando F:I a G:J. La plantilla de Excel original y las fórmulas existentes no se sustituyen.

## Orden actual de «CARGOS ENVIADOS»

A N° · B Fecha preparación · C Responsable · D Código de barras de cajas · E Número de cargos · **F Clasificación de caja** · G Fecha de envío IM · H Responsable en entregar · I Responsable en recibir · J Placa.

## Ajuste preciso para Apps Script V2

No es posible editar el proyecto vinculado de Apps Script desde la integración disponible, por lo que **antes de pegar datos nuevos** debe modificarse su lector de columnas. En el lector que envía la hoja completa a la RPC \`im_sync_new_shipments\`:

- Ampliar el ancho de lectura de A:I (9 columnas) a **A:J (10 columnas)**.
- Los índices de arrays de Google Apps Script empiezan en cero. Conservar A-E como estaban.
- Mapear \`clasificacion: String(fila[5] ?? '').trim()\` desde F.
- Cambiar el mapeo existente de \`envio\` del índice 5 al **6** (G), manteniendo su función actual de conversión de fechas a YYYY-MM-DD.
- Desplazar \`entrega\` a \`fila[7]\`, \`recibe\` a \`fila[8]\` y \`placa\` a \`fila[9]\`.
- Conservar intacto el parseo actual de cargos E: 933, 933-934 y 933-934 (A), la autenticación, los tokens, los disparadores y el mecanismo de bajas.

El contrato JSON por cada fila pasará a incluir \`clasificacion\`:
\`\`\`json
{"row":2,"numero":"1","preparacion":"2026-10-20","responsable":"Ejemplo","caja":"TD990000001","celda":"933-934","cargos":["933","934"],"clasificacion":"Por solicitud","envio":"","entrega":"","recibe":"","placa":""}
\`\`\`

No copiar credenciales reales al repositorio. Activar la migración propuesta de Supabase y actualizar Apps Script en una ventana coordinada, luego probar primero una fila de ejemplo, confirmar la lectura del estado en el app y revisar bajas/duplicidades antes de habilitar su uso normal.

La fila de ejemplo es **ficticia** y no debe añadirse a la base de datos de producción como registro real.
