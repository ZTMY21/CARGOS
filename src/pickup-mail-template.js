import {groupPickupBoxes,pickupGroups} from '../server/pickup-workbook.js';
import {pickupBrandLogo} from './pickup-brand-logo.js';
import {pickupNoticeCopy,pickupNoticeLine} from './pickup-notice-format.js';
// Mensajes de recojo. Compatible con Outlook; jamás realiza envíos.
// Plantilla basada en la estructura visual EML de Inspecciones, no en su contenido.
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const compact=s=>String(s??'').replace(/[\r\n\x00-\x1f\x7f]/g,' ').trim();
const email=x=>/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(compact(x));
const recipients=value=>Array.isArray(value)&&value.length>0&&value.every(email);
const bytes64=bytes=>{
 let binary='';
 for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(binary);
};
const encode=s=>bytes64(new TextEncoder().encode(s));
const encodedHeader=s=>'=?UTF-8?B?'+encode(compact(s))+'?=';
const foldedBase64=b=>(b.match(/.{1,76}/g)||[]).join('\r\n');
const folded64=s=>foldedBase64(encode(s));
const DEFAULT={
 greeting:'Buenas tardes, estimado:',
 introduction:'Se envía la siguiente solicitud de recojo de cajas en {{sede}}.',
 request:'Adjuntamos el detalle en los formatos Excel correspondientes. Agradeceremos confirmar la fecha de atención.',
 closing:'Quedamos atentos a la confirmación de la coordinación.'
};
const dateInLima=value=>{
 const date=new Date(value||Date.now());
 if(Number.isNaN(date.valueOf()))return '';
 return new Intl.DateTimeFormat('es-PE',{
   timeZone:'America/Lima',day:'2-digit',month:'2-digit',year:'numeric'
 }).format(date);
};
const fill=(value,detail,groups)=>{
 const sede=compact(detail.signature?.sede||'CD Santa Anita');
 return String(value??'')
   .replaceAll('{{cantidad}}',String(detail.boxes.length))
   .replaceAll('{{nuevas}}',String(groups.NUEVAS.length))
   .replaceAll('{{devoluciones}}',String(groups.DEVOLUCION.length))
   .replaceAll('{{sede}}',sede)
   .replaceAll('{{fecha}}',dateInLima(detail.created_at))
   .trim();
};
export function composePickupMail(detail,attachments=[],{noticeAt,simulation=false}={}){
 const notice=noticeAt?pickupNoticeCopy(noticeAt):null;
 if(notice)detail={...detail,subject:notice.subject};
 if(simulation)detail={...detail,sender:'remitente@example.invalid',to:['destinatario@example.invalid'],cc:[]};
 const groups=groupPickupBoxes(detail?.boxes);
 const quantities=pickupGroups.filter(type=>groups[type].length).map(type=>{
  const count=groups[type].length;
  if(notice)return pickupNoticeLine(type,count);
  return count+' '+(count===1?'caja ':'cajas ')+(type==='NUEVAS'?(count===1?'nueva':'nuevas'):'para devolución');
 });
 if(!recipients(detail.to)||!Array.isArray(detail.cc)||!detail.cc.every(email)||!email(detail.sender))
  throw new Error('Configura un remitente, destinatarios y copias válidos.');
 const signature=detail.signature||{};
 if(!notice&&(!compact(signature.name)||!compact(signature.company)))
  throw new Error('La firma debe tener nombre y empresa configurados.');
 const subject=compact(fill(detail.subject,detail,groups));
 if(!subject)throw new Error('Falta asunto del correo.');
 // Preserve customized copy while replacing defaults from older saved templates.
 const defaults={
  greeting:'Estimados(as),',
  introduction:'Se comunica que tenemos {{cantidad}} cajas nuevas acondicionadas y listas para recojo en {{sede}}.',
  request:'Agradeceremos gestionar la solicitud de recojo ante Iron Mountain y confirmar la fecha estimada de atención.'
 };
 const copy=key=>notice?notice[key]:fill(signature[key]&&signature[key]!==defaults[key]?signature[key]:DEFAULT[key],detail,groups);
 const signParts=notice?[]:[signature.name,signature.position,signature.area,
  signature.company,signature.contact,signature.address].map(compact).filter(Boolean);
 const plain=[
  copy('greeting'),'',copy('introduction'),'',...quantities.map(line=>notice?'• '+line:line),
  ...(notice?[]:['',copy('request'),copy('closing'),'','Saludos cordiales,',...signParts])
 ].join('\r\n');
 const logo=compact(signature.logo_png_base64)||pickupBrandLogo;
 if(logo&&(logo.length>170000||!/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(logo)||
    atob(logo).length>120000))
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
  (notice?'':'<h1 style="font-size:21px;color:#172033;margin:0 0 14px">Solicitud de recojo de cajas</h1>')+
  '<p>'+esc(copy('greeting'))+'</p>'+
  '<p>'+esc(copy('introduction'))+'</p>'+
  (notice?'<ul style="padding-left:24px">'+quantities.map(line=>'<li>'+esc(line)+'</li>').join('')+'</ul>':
    '<p>'+quantities.map(esc).join('<br>')+'</p><p>'+esc(copy('request'))+'</p>'+
    '<p>'+esc(copy('closing'))+'</p><p>Saludos cordiales,</p>'+
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #dce2e9;border-collapse:collapse;margin-top:18px">'+
    '<tr><td style="padding-top:12px;font-size:13px">'+signHtml+'</td></tr></table>')+
  '</td></tr></table></td></tr></table></body></html>';
 const boundary='kardex-'+String(detail.id||'').replace(/[^a-zA-Z0-9-]/g,'').slice(0,36);
 if(boundary==='kardex-')throw new Error('Lote sin identificador.');
 const baseHeaders=[
  'X-Unsent: 1',
  'From: '+compact(detail.sender),
  'To: '+detail.to.map(compact).join(', '),
  ...(detail.cc.length?['Cc: '+detail.cc.map(compact).join(', ')]:[]),
  'Subject: '+encodedHeader(simulation?'SIMULACIÓN · '+subject:subject),'MIME-Version: 1.0',
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
 if(attachments.length){
  const mixedBoundary=boundary+'-files';
  const body=eml.slice(eml.indexOf('Content-Type: multipart/alternative'));
  eml=[...baseHeaders,'Content-Type: multipart/mixed; boundary="'+mixedBoundary+'"','',
    '--'+mixedBoundary,body.trimEnd(),
    ...attachments.flatMap(({filename,bytes})=>[
      '--'+mixedBoundary,
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition: attachment; filename="'+compact(filename)+'"',
      'Content-Transfer-Encoding: base64','',foldedBase64(bytes64(bytes))
    ]),'--'+mixedBoundary+'--',''].join('\r\n');
 }
 return {
  subject,text:plain,html,to:detail.to,cc:detail.cc,from:detail.sender,
  previewHtml:logo?html.replace('cid:farmacias-peruanas-logo',
    'data:image/png;base64,'+logo):html,
  eml,filename:'recojo_'+compact(detail.id).slice(0,8)+'.eml'
 };
}
