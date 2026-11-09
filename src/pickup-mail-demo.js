// Ejemplo ilustrativo dentro del panel EXISTENTE "Ver correo generado".
// No accede a datos reales, no prepara lotes, no adjunta archivos y no envía mensajes.
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const PICKUP_TO=Object.freeze([
 'joramos@farmaciasperuanas.pe',
 'alopezv@farmaciasperuanas.pe',
 'bsalvador@farmaciasperuanas.pe'
]);
export const PICKUP_CC=Object.freeze(['fp-qs-liquidaciones@intercorpretail.pe']);
export function pickupMailSubject(date=new Date()){
 const parts=new Intl.DateTimeFormat('en-GB',{
  timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'
 }).formatToParts(date);
 const part=key=>parts.find(x=>x.type===key)?.value||'';
 return 'IM-'+part('year')+part('month')+part('day')+
  ' II INGRESO DE CAJAS A IRON MOUNTAIN';
}
export function pickupMailGreeting(date=new Date()){
 const hour=Number(new Intl.DateTimeFormat('en-GB',{
  timeZone:'America/Lima',hour:'2-digit',hourCycle:'h23'
 }).format(date));
 return hour<12?'Buenos días':hour<19?'Buenas tardes':'Buenas noches';
}
export function renderPickupSample(config={},at=new Date()){
 const subject=pickupMailSubject(at),greeting=pickupMailGreeting(at);
 const rows=Array.from({length:30},(_,i)=>{
  const code='TD-DEMO-'+String(i+1).padStart(3,'0');
  return '<tr><td style="padding:9px;border-bottom:1px solid #dce2e9">'+(i+1)+
   '</td><td style="padding:9px;border-bottom:1px solid #dce2e9">'+code+
   '</td><td style="padding:9px;border-bottom:1px solid #dce2e9">Cargo de ejemplo '+(i+1)+'</td></tr>';
 }).join('');
 const logo=String(config.logo||'');
 const hasLogo=/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(logo)&&logo.length<=170000;
 const logomark=hasLogo
  ? '<img width="42" height="42" alt="Farmacias Peruanas" src="data:image/png;base64,'+logo+'" style="object-fit:contain">'
  : '<span style="display:block;width:42px;height:42px;background:#eef1f5;border-radius:7px"></span>';
 const signature=[config.name,config.position,config.area,config.company,config.contact]
  .map(x=>String(x||'').trim()).filter(Boolean).map(esc).join('<br>');
 const sign=signature?'<p>'+signature+'</p>':'';
 return '<!doctype html><html lang="es"><head><meta charset="utf-8"></head>'+
 '<body style="margin:0;background:#f5f7f9;padding:16px;font-family:Arial,Helvetica,sans-serif;color:#172033">'+
 '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:740px;margin:auto;background:#fff;border:1px solid #dce2e9;border-collapse:collapse">'+
 '<tr><td style="padding:18px;font-size:14px;line-height:1.6">'+
 '<div style="background:#fff4dc;border:1px solid #e1bb62;padding:8px;margin-bottom:15px;text-align:center;font-size:12px;font-weight:bold">SIMULACIÓN INTERNA · NO ENVIAR · DATOS DE EJEMPLO</div>'+
 '<table role="presentation" width="100%" style="border-collapse:collapse;font-size:12px;table-layout:fixed">'+
 '<tr><td style="width:63px;padding:7px;border-bottom:1px solid #edf1f5;color:#526071">De</td><td style="padding:7px;border-bottom:1px solid #edf1f5;overflow-wrap:anywhere">Cuenta corporativa autorizada de Outlook (por integrar)</td></tr>'+
 '<tr><td style="padding:7px;border-bottom:1px solid #edf1f5;color:#526071">Para</td><td style="padding:7px;border-bottom:1px solid #edf1f5;overflow-wrap:anywhere">'+esc(PICKUP_TO.join('; '))+'</td></tr>'+
 '<tr><td style="padding:7px;border-bottom:1px solid #edf1f5;color:#526071">CC</td><td style="padding:7px;border-bottom:1px solid #edf1f5;overflow-wrap:anywhere">'+esc(PICKUP_CC.join('; '))+'</td></tr>'+
 '<tr><td style="padding:7px;border-bottom:1px solid #edf1f5;color:#526071">Asunto</td><td style="padding:7px;border-bottom:1px solid #edf1f5;overflow-wrap:anywhere"><strong>'+esc(subject)+'</strong></td></tr></table>'+
 '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 12px;border-collapse:collapse"><tr>'+
 '<td style="padding-right:12px">'+logomark+'</td><td><strong>Farmacias Peruanas</strong><div style="color:#526071;font-size:12px">Gestión documental · CD Santa Anita</div></td></tr></table>'+
 '<p>Estimado Jorge Ramos:<br>'+esc(greeting)+'.</p>'+
 '<p>Tu apoyo con la siguiente solicitud para Iron Mountain:</p>'+
 '<ul style="margin:9px 0 17px;padding-left:24px"><li>30 cajas nuevas para almacenamiento en Iron Mountain.</li>'+
 '<li>30 cajas de retorno para rearchivamiento en Iron Mountain.</li></ul>'+
 '<p>Adjunto las relaciones correspondientes a ambos tipos de cajas para su programación de recojo.</p>'+
 '<div style="margin:15px 0 8px;font-size:12px;color:#526071"><strong>Adjuntos previstos (no generados ni adjuntados en esta simulación)</strong></div>'+
 '<div style="border:1px solid #dce2e9;background:#f6f8fb;padding:9px;font-size:12px">📄 Formato IM-DYT (NUEVAS).xlsx</div>'+
 '<div style="border:1px solid #dce2e9;border-top:0;background:#f6f8fb;padding:9px;font-size:12px">📄 Formato IM-DYT (DEVOLUCIONES).xlsx</div>'+
 '<p>Quedo atento a la confirmación de la fecha de recojo.</p><p>Saludos cordiales,</p>'+
 '<div style="border-left:3px solid #c5d3df;background:#f5f8fb;padding:10px 12px;color:#56697b;font-size:12px">La firma corporativa se agregará desde Outlook cuando se configure la integración.'+sign+'</div>'+
 '<details style="margin-top:17px"><summary style="cursor:pointer;color:#18599b;font-size:12px">Ver relación ficticia de las 30 cajas nuevas</summary>'+
 '<table role="presentation" width="100%" style="border-collapse:collapse;font-size:12px"><thead><tr style="background:#f6f8fb"><th align="left" style="padding:9px">N.°</th><th align="left" style="padding:9px">Caja</th><th align="left" style="padding:9px">Cargos</th></tr></thead><tbody>'+rows+'</tbody></table></details>'+
 '<p style="font-size:11px;color:#637384">No se han preparado lotes reales ni enviado correos. La lista de devoluciones será la que corresponda a los registros confirmados al efectuar el aviso real.</p>'+
 '</td></tr></table></body></html>';
}
