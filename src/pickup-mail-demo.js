// Vista ficticia: nunca solicita datos reales ni escribe en Supabase/Google Drive/Outlook.
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fill=x=>String(x??'').replaceAll('{{cantidad}}','30')
 .replaceAll('{{sede}}','CD Santa Anita').replaceAll('{{fecha}}','01/11/2026');
export function renderPickupSample(config={}){
 const rows=Array.from({length:30},(_,i)=>{
   const code='TD-DEMO-'+String(i+1).padStart(3,'0');
   return '<tr><td style="padding:9px;border-bottom:1px solid #dce2e9">'+(i+1)+
     '</td><td style="padding:9px;border-bottom:1px solid #dce2e9">'+code+
     '</td><td style="padding:9px;border-bottom:1px solid #dce2e9">Cargo de ejemplo '+(i+1)+'</td></tr>';
 }).join('');
 const content=(key,fallback)=>esc(fill(config[key]||fallback));
 const logo=String(config.logo||'');
 const hasLogo=/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(logo)&&logo.length<=170000;
 const logomark=hasLogo?'<img width="48" height="48" alt="Farmacias Peruanas" src="data:image/png;base64,'+logo+'" style="width:48px;height:48px;object-fit:contain">':
 '<span style="display:block;width:48px;height:48px;border-radius:8px;background:#f6f8fb"></span>';
 const sign=[config.name,config.position,config.area,config.company,config.contact]
  .map(x=>String(x||'').trim()).filter(Boolean).map(esc).join('<br>')||
  '<em>La firma se completará con los datos del remitente autorizado</em>';
 return '<!doctype html><html lang="es"><meta charset="utf-8">'+
 '<body style="margin:0;padding:16px;background:#f5f7f9;color:#172033;font-family:Arial,sans-serif">'+
 '<table width="640" role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;margin:0 auto;background:#fff;border:1px solid #dce2e9;border-top:4px solid #b50917;border-collapse:collapse">'+
 '<tr><td style="padding:24px;line-height:1.55;font-size:14px">'+
 '<div style="background:#fff4dc;border:1px solid #e1bb62;padding:7px;margin-bottom:16px;text-align:center;font-size:12px;font-weight:bold">SIMULACIÓN INTERNA · NO ENVIAR</div>'+
 '<table role="presentation"><tr><td style="padding-right:12px">'+logomark+'</td>'+
 '<td><strong style="font-size:17px">Farmacias Peruanas</strong><div style="color:#526071;font-size:12px">Gestión documental · CD Santa Anita</div></td></tr></table>'+
 '<h1 style="font-size:21px;margin-bottom:10px">Solicitud de recojo de cajas</h1>'+
 '<p><strong>Asunto:</strong> '+content('subject','Solicitud de recojo | {{cantidad}} cajas nuevas | {{sede}} | {{fecha}}')+'</p>'+
 '<div style="background:#f6f8fb;padding:12px"><strong>Sede:</strong> CD Santa Anita<br>'+
 '<strong>Cajas nuevas listas:</strong> 30 <em>(datos de ejemplo)</em></div>'+
 '<p>'+content('greeting','Estimados(as),')+'</p>'+
 '<p>'+content('introduction','Se comunica que tenemos {{cantidad}} cajas nuevas acondicionadas y listas para recojo en {{sede}}.')+'</p>'+
 '<p>'+content('request','Agradeceremos gestionar la solicitud de recojo ante Iron Mountain y confirmar la fecha estimada de atención.')+'</p>'+
 '<h2 style="font-size:16px;color:#18599b">DETALLE DE CAJAS LISTAS: 30</h2>'+
 '<table width="100%" style="border-collapse:collapse;font-size:12px"><thead><tr style="background:#f6f8fb">'+
 '<th align="left" style="padding:9px">N.º</th><th align="left" style="padding:9px">Caja</th>'+
 '<th align="left" style="padding:9px">Cargos</th></tr></thead><tbody>'+rows+'</tbody></table>'+
 '<p>'+content('closing','Quedamos atentos a la confirmación de la coordinación.')+'</p>'+
 '<p>Saludos cordiales,</p>'+
 '<p style="border-top:1px solid #dce2e9;padding-top:12px">'+sign+'</p>'+
 '<div style="font-size:11px;color:#5f6b76">Esta visualización no crea avisos ni escribe datos.</div>'+
 '</td></tr></table></body></html>';
}
