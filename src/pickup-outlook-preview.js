// Propuesta de presentación: no envía correos ni consulta cajas reales.
export const OUTLOOK_PICKUP_RECIPIENTS=Object.freeze({
 to:['joramos@farmaciasperuanas.pe','alopezv@farmaciasperuanas.pe','bsalvador@farmaciasperuanas.pe'],
 cc:['fp-qs-liquidaciones@intercorpretail.pe']
});
export function pickupLimaGreeting(date=new Date()){
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Lima',hour:'2-digit',hourCycle:'h23'}).format(date));
 return hour<12?'Buenos días':hour<19?'Buenas tardes':'Buenas noches';
}
export function pickupSampleContent(date=new Date()){
 const fecha=new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit',year:'numeric'}).format(date);
 const sello=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'})
  .formatToParts(date);
 const parte=tipo=>sello.find(p=>p.type===tipo)?.value||'';
 const fechaAsunto=parte('year')+parte('month')+parte('day');
 const saludo=pickupLimaGreeting(date);
 return {
  subject:'IM-'+fechaAsunto+' II INGRESO DE CAJAS A IRON MOUNTAIN',
  body:'Estimado Jorge Ramos:\n'+saludo+'.\n\n'+
   'Tu apoyo con la siguiente solicitud para Iron Mountain:\n\n'+
   '• 30 cajas nuevas para almacenamiento en Iron Mountain.\n'+
   '• 30 cajas de retorno para rearchivamiento en Iron Mountain.\n\n'+
   'Adjunto las relaciones correspondientes a ambos tipos de cajas para su programación de recojo.\n\n'+
   'Quedo atento a la confirmación de la fecha de recojo.\n\n'+
   'Saludos cordiales,',
  fecha,saludo
 };
}
export function attachPickupOutlookPreview(root=document){
 const el=id=>root.getElementById(id);
 const section=el('pickupOutlookProposal');
 if(!section)return;
 const paint=()=>{
  const content=pickupSampleContent();
  el('pickupOutlookTo').textContent=OUTLOOK_PICKUP_RECIPIENTS.to.join('; ');
  el('pickupOutlookCc').textContent=OUTLOOK_PICKUP_RECIPIENTS.cc.join('; ');
  el('pickupOutlookSubject').textContent=content.subject;
  el('pickupOutlookBody').textContent=content.body;
  el('pickupOutlookGreetingTime').textContent=content.saludo+' · '+content.fecha;
 };
 paint();
 el('pickupOutlookRefresh')?.addEventListener('click',paint);
 el('pickupOutlookCopy')?.addEventListener('click',async()=>{
  const content=pickupSampleContent();
  const message='Para: '+OUTLOOK_PICKUP_RECIPIENTS.to.join('; ')+
   '\nCC: '+OUTLOOK_PICKUP_RECIPIENTS.cc.join('; ')+
   '\nAsunto: '+content.subject+'\n\n'+content.body;
  try{
   await navigator.clipboard.writeText(message);
   el('pickupOutlookCopyStatus').textContent='Texto y destinatarios copiados. No se envió ningún correo.';
  }catch{
   el('pickupOutlookCopyStatus').textContent='No se pudo copiar; puedes seleccionar el texto del ejemplo.';
  }
 });
}
