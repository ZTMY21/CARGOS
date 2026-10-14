# Validación

Fecha: 14 de octubre de 2026.

## Resultado local

- 23 pruebas automatizadas aprobadas con Node, PGlite, JSDOM, ExcelJS y SheetJS.
- Las dos migraciones se ejecutaron en PostgreSQL embebido con roles y esquemas de autenticación y Storage de prueba.
- RLS, membresía confirmada, correlativos, asignación y capacidad de cajas, liberación por clave foránea, restablecimiento y edición simultánea comprobados.
- Importación por lotes: exige el respaldo original, no expone datos mientras se prepara, revierte lotes incompletos o referencias inválidas, conserva identidades y vínculos, y actualiza sin eliminar registros ajenos a la importación.
- Reimportación histórica: conserva los datos operativos editados. La actualización desde un Kardex permite corregirlos y mantiene la procedencia original. Identificadores que apuntan a documentos diferentes se rechazan.
- Búsqueda SQL exacta y parcial, acentos, múltiples campos, filtros combinados, año de origen, resultados paginados e índices comprobados. La respuesta no incluye la lista íntegra de facturas ni el JSON de origen.
- Historial privado de campos modificados y bucket de respaldos privado comprobados.
- CSS original y logo Base64 comparados por SHA-256 con coincidencia exacta; cuatro bloques desplegables conservados.
- Estados, límites de antigüedad, campos condicionales, resaltado seguro y eventos Realtime simulados comprobados.
- Excel exportado y leído de vuelta: cuatro hojas, fórmulas, cargos, vínculos, facturas, observaciones e imágenes conservados. Listas y procedencia histórica mayores de 32.767 caracteres también se conservan.
- Compilación Vite de producción comprobada con valores públicos ficticios, solo para verificar la compilación local. Esos valores no se guardan ni se despliegan.
- El build rechaza configuración ausente, claves secretas y JWT de `service_role`.
- `npm audit`: cero vulnerabilidades reportadas en las dependencias verificadas.

## Verificación externa pendiente

La integración Supabase no muestra proyectos disponibles y las operaciones de cotización y confirmación de creación no están disponibles en su servidor. El panel del navegador solicita iniciar sesión. No se han aplicado migraciones ni importado registros en un proyecto real.

La integración Vercel devuelve 403 al acceder al espacio de la cuenta identificado. No hay credenciales CLI alternativas en este entorno. No se ha desplegado una instalación de producción.

GitHub permite acceder al repositorio vinculado y publicar el código. Los datos del Excel se conservan fuera del repositorio.

Los resultados locales no sustituyen la comprobación del acceso real, Storage, Realtime entre dos computadoras, rendimiento sobre la base completa, ni la ejecución de fórmulas dentro de Microsoft Excel. Estas comprobaciones deben completarse una vez disponibles los recursos reales.
