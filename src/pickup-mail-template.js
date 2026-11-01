// Generación determinista de correo de recojo. No envía correos.
// Se utiliza únicamente con datos de un lote persistido y su firma autorizada.
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const compact=s=>String(s??'').replace(/[\r\n\x00-\x1f\x7f]/g,' ').trim();
const mail=x=>/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(compact(x));
const recipients=value=>Array.isArray(value)&&value.length>0&&value.every(mail);
const encodedHeader=s=>'=?UTF-8?B?'+Buffer.from(compact(s),'utf8').toString('base64')+'?=';
const folded64=x=>(Buffer.from(x,'utf8').toString('base64').match(/.{1,76}/g)||[]).join('\r\n');
export function composePickupMail(detail){
 if(!detail||!Array.isArray(detail.boxes)||detail.boxes.length!==30)
   throw new Error('Se requiere un lote confirmado de exactamente 30 cajas.');
 if(!recipients(detail.to)||!Array.isArray(detail.cc)||!detail.cc.every(mail)||!mail(detail.sender))
   throw new Error('Configura un remitente, destinatarios y copias válidos.');
 const signature=detail.signature||{};
 if(!compact(signature.name)||!compact(signature.company))
   throw new Error('La firma debe tener nombre y empresa configurados.');
 if(detail.boxes.some(x=>!x.code||!Array.isArray(x.cargos)||!x.cargos.length||
   !/^(?:TD|T|P)?[\d-]{5,40}$/i.test(x.code)))throw new Error('Datos incompletos de caja.');
 const subject=compact(detail.subject);
 if(!subject)throw new Error('Falta asunto del correo.');
 const lines=detail.boxes.map((b,i)=>{
  const cargo=b.cargos.map(compact).join(', ');
  return String(i+1).padStart(2,'0')+'. '+compact(b.code)+' — Cargos: '+cargo;
 });
 const signatureParts=[signature.name,signature.position,signature.area,
  signature.company,signature.contact].map(compact).filter(Boolean);
 const plain=[
  'Buenas tardes:',
  '',
  'Se informa que se encuentran listas para recojo 30 cajas nuevas acondicionadas en el CD Santa Anita.',
  'Agradeceré gestionar la solicitud de recojo ante Iron Mountain y confirmar la fecha de atención.',
  '',
  'Detalle de cajas:',
  ...lines,
  '',
  'Quedo atento(a) a la confirmación de la coordinación.',
  '',
  'Saludos cordiales,',
  ...signatureParts
 ].join('\r\n');
 const rows=detail.boxes.map((b,i)=>'<tr><td style="padding:7px 10px;border-bottom:1px solid #dde3e8">'+
  (i+1)+'</td><td style="padding:7px 10px;border-bottom:1px solid #dde3e8">'+esc(compact(b.code))+
  '</td><td style="padding:7px 10px;border-bottom:1px solid #dde3e8">'+
  esc(b.cargos.map(compact).join(', '))+'</td></tr>').join('');
 const sign=signatureParts.map(esc).join('<br>');
 const html='<!doctype html><html lang="es"><head><meta charset="utf-8"></head><body style="margin:0;background:#f1f3f5;font-family:Arial,Helvetica,sans-serif;color:#243142">'+
  '<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;margin:20px auto;background:#fff;border-collapse:collapse">'+
  '<tr><td style="background:#1f4e78;padding:20px;color:#fff;font-weight:bold;font-size:19px">Coordinación de recojo · CD Santa Anita</td></tr>'+
  '<tr><td style="padding:24px;line-height:1.55;font-size:14px"><p>Buenas tardes:</p>'+
  '<p>Se informa que se encuentran <strong>30 cajas nuevas acondicionadas listas para recojo</strong> en el CD Santa Anita.</p>'+
  '<p>Agradeceré gestionar la solicitud de recojo ante Iron Mountain y confirmar la fecha de atención.</p>'+
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">'+
  '<thead><tr style="background:#e7f0f8;color:#12324d"><th align="left" style="padding:8px">N.º</th><th align="left" style="padding:8px">Caja</th><th align="left" style="padding:8px">Cargos</th></tr></thead><tbody>'+rows+'</tbody></table>'+
  '<p>Quedo atento(a) a la confirmación de la coordinación.</p>'+
  '<p>Saludos cordiales,</p><p style="border-left:3px solid #c0504d;padding-left:12px">'+sign+'</p>'+
  '</td></tr></table></body></html>';
 const boundary='kardex-'+String(detail.id||'').replace(/[^a-zA-Z0-9-]/g,'').slice(0,36);
 if(!boundary||boundary==='kardex-')throw new Error('Lote sin identificador.');
 const headers=[
  'From: '+compact(detail.sender),'To: '+detail.to.map(compact).join(', '),
  ...(detail.cc.length?['Cc: '+detail.cc.map(compact).join(', ')]:[]),
  'Subject: '+encodedHeader(subject),
  'MIME-Version: 1.0',
  'X-Kardex-Batch: '+compact(detail.id),
  'Content-Type: multipart/alternative; boundary="'+boundary+'"'
 ];
 const eml=headers.join('\r\n')+'\r\n\r\n'+
  '--'+boundary+'\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+
  folded64(plain)+'\r\n'+
  '--'+boundary+'\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+
  folded64(html)+'\r\n--'+boundary+'--\r\n';
 return {subject,text:plain,html,eml,filename:'recojo_30_cajas_'+compact(detail.id).slice(0,8)+'.eml'};
}
