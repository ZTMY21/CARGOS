# Validación

Fecha: 14 de octubre de 2026.

## Resultado local

- 23 pruebas automatizadas aprobadas con Node, PGlite, JSDOM, ExcelJS y SheetJS.
- Las migraciones se ejecutaron en PostgreSQL embebido con roles y esquemas de autenticación y Storage de prueba.
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

## Verificación en producción

Las migraciones están aplicadas en el proyecto Supabase dedicado. Se comprobó la importación completa del histórico, su respaldo original privado, SHA-256, conteos, identidad de los registros y correlativos. La importación fue confirmada en una transacción y sus lotes temporales quedaron eliminados.

La búsqueda exacta sobre un código real devolvió el Kardex y cargo correctos. La consulta devuelve metadatos y coincidencias sin enviar al navegador todas las facturas o el JSON de origen. La conexión anónima a la tabla de documentos devuelve HTTP 401.

RLS está habilitado y ambas tablas, junto con los eventos pequeños de invalidación, están publicadas para Realtime. Las tablas privadas de miembros, contadores e historial tienen RLS sin políticas de cliente: su acceso permanece cerrado intencionalmente. Se revocó la ejecución de cliente de la función interna de RLS automático del proveedor y se verificaron sus permisos.

Vercel confirmó el despliegue de producción como READY, desde la rama main del repositorio vinculado. La página se abrió en el navegador con el logo y estructura previstos. Supabase Auth tiene la URL del sitio y un retorno exacto configurados para la aplicación de producción. Solo se configuraron claves públicas de Supabase.

La asignación del primer administrador de la aplicación sigue pendiente de aprobación explícita del propietario: la revisión automática bloqueó esa asignación. No se han creado contraseñas ni enviado invitaciones a otros usuarios. Hasta habilitar una identidad confirmada, los documentos permanecen inaccesibles desde el cliente web.

El flujo de una identidad autorizada y Realtime entre dos computadoras aún deben verificarse después de aprobar el acceso. La ejecución de fórmulas dentro de Microsoft Excel también permanece pendiente; el ciclo de exportación e importación sí está verificado con ExcelJS y SheetJS.
