// Registro de lectura de consulta (Control de cajas) en el Google Sheets original.
// El acondicionamiento utiliza un escáner separado y no recibe estos eventos.
export function attachBoxScanSheets({supabase,isAdmin,appReady,isPreview,requestSheet=null}){
 const status=document.getElementById('boxSheetsStatus');
 let queue=Promise.resolve();
 const send=requestSheet||(async code=>{
  const {data,error}=await supabase.auth.getSession();
  if(error||!data?.session?.access_token)throw Error('Sesión no disponible.');
  const response=await fetch('/api/box-sheets',{
   method:'POST',credentials:'same-origin',
   headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},
   body:JSON.stringify({action:'scan',code})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result.googleVerified!==true)throw Error('Google Sheets no confirmó la lectura.');
  return result;
 });
 return {
  scan({scan}={}){
   if(!scan?.ok||!appReady()||!isAdmin())return;
   if(isPreview()){status.textContent='Modo Preview: consulta local, sin escribir en Google Sheets.';return;}
   status.textContent='Registrando lectura en Google Sheets…';
   const job=queue.catch(()=>{}).then(()=>send(scan.original));
   queue=job;
   void job.then(()=>{
    status.textContent='Lectura registrada en CONTROL DE CAJAS (Google Drive).';
   }).catch(()=>{
    status.textContent='Lectura no confirmada por Google Sheets. Verifica la hoja antes de reintentar.';
   });
  },
  reset(){
   status.textContent='Destino: Google Sheets del Drive · CONTROL DE CAJAS';
  }
 };
}
