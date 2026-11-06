// Punto de entrada antiguo, retirado al migrar CARGOS ENVIADOS a un solo Excel Maestro.
// El archivo se conserva como ruta 410 para clientes con caché: jamás escribe en Sheets.
export const config = {maxDuration: 5};
export function createBoxSheetsHandler() {
  return async function retired(_req,res){
    res.statusCode=410;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.end(JSON.stringify({
      error:'IM_LEGACY_GOOGLE_SHEETS_RETIRED',
      message:'El registro de cajas ahora utiliza exclusivamente el Excel Maestro de Iron Mountain. Actualiza el aplicativo.'
    }));
  };
}
export default createBoxSheetsHandler();
