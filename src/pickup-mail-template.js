// Mensajes de recojo. Compatible con Outlook; jamás realiza envíos.
// Plantilla basada en la estructura visual EML de Inspecciones, no en su contenido.
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const compact=s=>String(s??'').replace(/[\r\n\x00-\x1f\x7f]/g,' ').trim();
const email=x=>/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(compact(x));
const recipients=value=>Array.isArray(value)&&value.length>0&&value.every(email);
const encodedHeader=s=>'=?UTF-8?B?'+Buffer.from(compact(s),'utf8').toString('base64')+'?=';
const folded64=s=>(Buffer.from(s,'utf8').toString('base64').match(/.{1,76}/g)||[]).join('\r\n');
const foldedBase64=b=>(b.match(/.{1,76}/g)||[]).join('\r\n');
const DEFAULT={
 greeting:'Estimados(as),',
 introduction:'Se comunica que tenemos {{cantidad}} cajas nuevas acondicionadas y listas para recojo en {{sede}}.',
 request:'Agradeceremos gestionar la solicitud de recojo ante Iron Mountain y confirmar la fecha estimada de atención.',
 closing:'Quedamos atentos a la confirmación de la coordinación.'
};
const dateInLima=value=>{
 const date=new Date(value||Date.now());
 if(Number.isNaN(date.valueOf()))return '';
 return new Intl.DateTimeFormat('es-PE',{
   timeZone:'America/Lima',day:'2-digit',month:'2-digit',year:'numeric'
 }).format(date);
};
const fill=(value,detail)=>{
 const sede=compact(detail.signature?.sede||'CD Santa Anita');
 return String(value??'')
   .replaceAll('{{cantidad}}','30')
   .replaceAll('{{sede}}',sede)
   .replaceAll('{{fecha}}',dateInLima(detail.created_at))
   .trim();
};
export function composePickupMail(detail){
 if(!detail||!Array.isArray(detail.boxes)||detail.boxes.length!==30)
  throw new Error('Se requiere un lote confirmado de exactamente 30 cajas.');
 if(!recipients(detail.to)||!Array.isArray(detail.cc)||!detail.cc.every(email)||!email(detail.sender))
  throw new Error('Configura un remitente, destinatarios y copias válidos.');
 const signature=detail.signature||{};
 if(!compact(signature.name)||!compact(signature.company))
  throw new Error('La firma debe tener nombre y empresa configurados.');
 if(detail.boxes.some(x=>!x.code||!Array.isArray(x.cargos)||!x.cargos.length||
   !/^(?:TD|T|P)?[\d-]{5,40}$/i.test(x.code)))throw new Error('Datos incompletos de caja.');
 const subject=compact(detail.subject);
 if(!subject)throw new Error('Falta asunto del correo.');
 const chosen={
  greeting:fill(signature.greeting||DEFAULT.greeting,detail),
  introduction:fill(signature.introduction||DEFAULT.introduction,detail),
  request:fill(signature.request||DEFAULT.request,detail),
  closing:fill(signature.closing||DEFAULT.closing,detail)
 };
 const signParts=[signature.name,signature.position,signature.area,signature.company,
  signature.contact].map(compact).filter(Boolean);
 const plain=[
  chosen.greeting,'',chosen.introduction,chosen.request,'',
  'DETALLE DE CAJAS LISTAS PARA RECOJO:',
  ...detail.boxes.map((b,i)=>String(i+1).padStart(2,'0')+'. '+compact(b.code)+
    ' — Cargos: '+b.cargos.map(compact).join(', ')),
  '',chosen.closing,'','Saludos cordiales,',...signParts
 ].join('\r\n');
 const rows=detail.boxes.map((b,i)=>
  '<tr><td style="border-bottom:1px solid #dce2e9;padding:9px 8px;text-align:left">'+(i+1)+'</td>'+
  '<td style="border-bottom:1px solid #dce2e9;padding:9px 8px;font-weight:bold">'+esc(compact(b.code))+'</td>'+
  '<td style="border-bottom:1px solid #dce2e9;padding:9px 8px">'+esc(b.cargos.map(compact).join(', '))+'</td></tr>'
 ).join('');
 const logo=compact(signature.logo_png_base64);
 if(logo&&(logo.length>170000||!/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(logo)||
    Buffer.from(logo,'base64').length>120000))
  throw new Error('El logotipo PNG es inválido.');
 const logoSrc=logo?'cid:farmacias-peruanas-logo':null;
 const brand=logoSrc?
  '<img src="'+logoSrc+'" alt="Farmacias Peruanas" width="48" height="48" style="display:block;width:48px;height:48px;object-fit:contain;border:0">':
  '<span style="display:block;width:48px;height:48px;background:#f6f8fb;border-radius:8px"></span>';
 const signHtml=signParts.map((part,i)=>i===0?
  '<strong style="font-size:15px">'+esc(part)+'</strong>':esc(part)).join('<br>');
 const html='<!doctype html><html lang="es"><head><meta charset="utf-8"></head>'+
  '<body style="margin:0;background:#f5f7f9;padding:16px;font-family:Arial,Helvetica,sans-serif;color:#172033">'+
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">'+
  '<tr><td align="center">'+
  '<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;border-collapse:collapse;background:#fff;border:1px solid #dce2e9">'+
  '<tr><td style="border-top:4px solid #b50917;padding:24px;font-size:14px;line-height:1.55">'+
  '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse">'+
  '<tr><td style="padding:0 12px 0 0" valign="middle">'+brand+'</td>'+
  '<td valign="middle"><p style="margin:0;font-weight:bold;font-size:17px">Farmacias Peruanas</p>'+
  '<p style="margin:2px 0 0;color:#526071;font-size:12px">Gestión documental · CD Santa Anita</p>'+
  '</td></tr></table>'+
  '<h1 style="font-size:21px;color:#172033;margin:0 0 14px">Solicitud de recojo de cajas</h1>'+
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fb;border-collapse:collapse;margin-bottom:18px">'+
  '<tr><td style="padding:12px;font-size:13px"><strong>Sede:</strong> '+esc(compact(signature.sede||'CD Santa Anita'))+
  '<br><strong>Cajas nuevas listas:</strong> 30'+
  '<br><strong>Fecha de preparación del aviso:</strong> '+esc(dateInLima(detail.created_at))+'</td></tr></table>'+
  '<p>'+esc(chosen.greeting)+'</p>'+
  '<p>'+esc(chosen.introduction)+'</p>'+
  '<p>'+esc(chosen.request)+'</p>'+
  '<h2 style="font-size:16px;color:#18599b;margin:18px 0 10px">DETALLE DE CAJAS LISTAS: 30</h2>'+
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px">'+
  '<thead><tr style="background:#f6f8fb"><th align="left" style="padding:9px 8px">N.º</th>'+
  '<th align="left" style="padding:9px 8px">Código de caja</th>'+
  '<th align="left" style="padding:9px 8px">Cargos</th></tr></thead><tbody>'+rows+'</tbody></table>'+
  '<p style="margin-top:18px">'+esc(chosen.closing)+'</p><p>Saludos cordiales,</p>'+
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #dce2e9;border-collapse:collapse;margin-top:18px">'+
  '<tr><td style="padding-top:12px;font-size:13px">'+signHtml+'</td></tr></table>'+
  '</td></tr></table></td></tr></table></body></html>';
 const boundary='kardex-'+String(detail.id||'').replace(/[^a-zA-Z0-9-]/g,'').slice(0,36);
 if(boundary==='kardex-')throw new Error('Lote sin identificador.');
 const baseHeaders=[
  'X-Unsent: 1',
  'From: '+compact(detail.sender),
  'To: '+detail.to.map(compact).join(', '),
  ...(detail.cc.length?['Cc: '+detail.cc.map(compact).join(', ')]:[]),
  'Subject: '+encodedHeader(subject),'MIME-Version: 1.0',
  'X-Kardex-Batch: '+compact(detail.id)
 ];
 const textPart='Content-Type: text/plain; charset=UTF-8\r\n'+
  'Content-Transfer-Encoding: base64\r\n\r\n'+folded64(plain)+'\r\n';
 const htmlPart='Content-Type: text/html; charset=UTF-8\r\n'+
  'Content-Transfer-Encoding: base64\r\n\r\n'+folded64(html)+'\r\n';
 let eml;
 if(logo){
  const related=boundary+'-related';
  eml=baseHeaders.concat(['Content-Type: multipart/alternative; boundary="'+boundary+'"'])
   .join('\r\n')+'\r\n\r\n'+
   '--'+boundary+'\r\n'+textPart+
   '--'+boundary+'\r\nContent-Type: multipart/related; boundary="'+related+'"\r\n\r\n'+
   '--'+related+'\r\n'+htmlPart+
   '--'+related+'\r\nContent-Type: image/png\r\nContent-ID: <farmacias-peruanas-logo>\r\n'+
   'Content-Disposition: inline; filename="farmacias-peruanas.png"\r\n'+
   'Content-Transfer-Encoding: base64\r\n\r\n'+foldedBase64(logo)+'\r\n'+
   '--'+related+'--\r\n--'+boundary+'--\r\n';
 }else{
  eml=baseHeaders.concat(['Content-Type: multipart/alternative; boundary="'+boundary+'"'])
   .join('\r\n')+'\r\n\r\n'+
   '--'+boundary+'\r\n'+textPart+'--'+boundary+'\r\n'+htmlPart+
   '--'+boundary+'--\r\n';
 }
 return {
  subject,text:plain,html,
  previewHtml:logo?html.replace('cid:farmacias-peruanas-logo',
    'data:image/png;base64,'+logo):html,
  eml,filename:'recojo_30_cajas_'+compact(detail.id).slice(0,8)+'.eml'
 };
}
