// Excel libraries are downloaded only when import/export is requested.
export async function buildWorkbook(...args) {
  return (await import('./excel.js')).buildWorkbook(...args);
}
export async function buildCargoWorkbook(...args) {
  return (await import('./cargo-export.js')).buildCargoWorkbook(...args);
}
export async function buildExistenciasReport(...args) {
  return (await import('./existencias-report.js')).buildExistenciasReport(...args);
}
export async function buildAnnualCargoReport(...args) {
  return (await import('./existencias-report.js')).buildAnnualCargoReport(...args);
}
export async function parseWorkbook(...args) {
  const buffer=args[0];
  if(typeof Worker==='undefined')return (await import('./import-parser.js')).parseImport(buffer);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./import-worker.js',import.meta.url),{type:'module'});
    worker.onmessage=event=>{worker.terminate();event.data.error?reject(new Error(event.data.error)):resolve(event.data.result);};
    worker.onerror=event=>{worker.terminate();reject(new Error(event.message||'No se pudo procesar el archivo.'));};
    worker.postMessage(buffer,[buffer]);
  });
}
