// Registrar el escaneo en el aplicativo. El Excel Maestro no se modifica
// al consultar una caja; solo se actualiza al finalizar un acondicionamiento.
export function attachBoxScanSheets({supabase,isAdmin,appReady,isPreview,requestSheet=null}){
 const status=document.getElementById('boxSheetsStatus');
 let queue=Promise.resolve();
 const send=requestSheet||(async code=>{
  const {data,error}=await supabase.auth.getSession();
  if(error||!data?.session?.access_token)throw Error('Sesión no disponible.');
  const response=await fetch('/api/box-excel',{
   method:'POST',credentials:'same-origin',
   headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},
   body:JSON.stringify({action:'scan',code})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result.verified!==true)throw Error('No se confirmó la lectura en el aplicativo.');
  return result;
 });
 return {
  scan({scan}={}){
   if(!scan?.ok||!appReady()||!isAdmin())return;
   if(isPreview()){status.textContent='Modo Preview: lectura local, sin escribir en el Excel Maestro.';return;}
   status.textContent='Verificando lectura en el aplicativo…';
   const job=queue.catch(()=>{}).then(()=>send(scan.original));
   queue=job;
   void job.then(()=>{
    status.textContent='Lectura confirmada; el Excel Maestro se actualiza al finalizar la preparación.';
   }).catch(()=>{
    status.textContent='Lectura no confirmada. Verifica la conexión antes de reintentar.';
   });
  },
  reset(){
   status.textContent='Destino de cajas confirmadas: Excel Maestro Iron Mountain · CARGOS ENVIADOS';
  }
 };
}
