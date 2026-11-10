import {REQ_TYPES} from './rules.js';

// Destinatarios exclusivos de solicitud de cajas, confirmados por el usuario.
// No cambia la configuración del aviso de recojo.
export const REQUEST_MAIL_TO = Object.freeze([
  'joramos@farmaciasperuanas.pe',
  'alopezv@farmaciasperuanas.pe',
  'bsalvador@farmaciasperuanas.pe'
]);
export const REQUEST_MAIL_CC = Object.freeze(['fp-qs-liquidaciones@intercorpretail.pe']);

const clean=value=>String(value??'').replace(/[\r\n\x00-\x1f\x7f]/g,' ').trim();
const validEmail=value=>/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean(value));
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const b64=value=>{
  const bytes=new TextEncoder().encode(value);
  let encoded='';
  for(let i=0;i<bytes.length;i+=8192)encoded+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(encoded).replace(/.{1,76}/g,'$&\r\n').trimEnd();
};

export function composeRequirementsMail(row,boxes=[],config={},options={}){
  const simulation=options.simulation===true;
  const supply=row?.tipo===REQ_TYPES[0];
  if(!row || (!supply&&row.tipo!==REQ_TYPES[1]))throw Error('Selecciona un requerimiento válido.');
  // Iron Mountain identifica las cajas por su código, no por los cargos ni los
  // documentos que contienen. Usar solo códigos reales y omitir repetidos.
  const loanCodes=supply?[]:[...new Map(boxes.map(box=>{
    const code=clean(box?.codigo||box?.code);
    return [code.toUpperCase(),code];
  }).filter(([key])=>key)).values()];
  const count=supply?Number(row.cantidadCajas):loanCodes.length;
  if(!Number.isSafeInteger(count)||count<1||(supply&&count>100))
    throw Error(supply?'La solicitud debe tener entre 1 y 100 cajas.':'No hay códigos de caja registrados en esta solicitud a IM.');
  const preview=options.preview===true;
  const sender=simulation?'remitente@example.invalid':clean(config.sender)||(preview?'remitente@example.invalid':'');
  const to=simulation?['destinatario@example.invalid']:[...REQUEST_MAIL_TO];
  const cc=simulation?[]:[...REQUEST_MAIL_CC];
  if(!validEmail(sender)||!to.every(validEmail)||!cc.every(validEmail))
    throw Error('El remitente de Aviso de recojo no está configurado.');
  const name=clean(config.name);
  const company=clean(config.company);
  if(!preview&&!simulation&&(!name||!company))throw Error('La firma de Aviso de recojo está incompleta.');
  const number=clean(row.numero)||'SIN NÚMERO';
  const subject=supply
    ?'Solicitud de '+count+' '+(count===1?'caja nueva':'cajas nuevas')+' a IM | CD Santa Anita |'
    :'Solicitud de '+count+' '+(count===1?'caja':'cajas')+' a IM | CD Santa Anita |';
  const greeting='Buenas tardes, estimados:';
  const intro=supply
    ?'Por medio del presente, solicitamos '+count+' '+(count===1?'caja nueva':'cajas nuevas')+' para el acondicionamiento de documentos en el CD Santa Anita.'
    :'Por medio del presente, solicitamos a Iron Mountain el préstamo de '+count+' '+(count===1?'caja':'cajas')+' identificadas por los siguientes códigos:';
  // El correo no incluye metadatos del requerimiento ni un renglón de cantidad.
  // La cantidad solicitada ya figura en el asunto y en el mensaje principal.
  const details=supply?[]:loanCodes;
  const request=supply
    ?'Agradeceremos confirmar la disponibilidad y la fecha programada de entrega.'
    :'Agradeceremos confirmar la disponibilidad y la fecha programada de entrega de estas cajas.';
  // Si no hay una firma auténtica configurada, no se muestra ningún marcador
  // provisional ni la empresa aislada como firma.
  const sign=name&&company?[name,config.position,config.area,company,config.contact].map(clean).filter(Boolean):[];
  const text=[greeting,'',intro,...(details.length?['',...details]:[]),'',request,'',
    'Quedamos atentos a su confirmación.','',...(sign.length?['Saludos cordiales,',...sign]:['Saludos cordiales.'])].join('\r\n');
  const signatureHtml=sign.map(escapeHtml).join('<br>');
  const html='<!doctype html><html lang="es"><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;background:#f5f7f9;color:#172033;padding:20px">'+
    '<table role="presentation" style="max-width:640px;width:100%;margin:auto;background:white;border:1px solid #dce2e9;border-top:4px solid #b50917;border-collapse:collapse"><tr><td style="padding:24px;font-size:14px;line-height:1.6">'+
    '<p>'+escapeHtml(greeting)+'</p><p>'+escapeHtml(intro)+'</p>'+
    (details.length?'<ul>'+details.map(line=>'<li>'+escapeHtml(line)+'</li>').join('')+'</ul>':'')+
    '<p>'+escapeHtml(request)+'</p><p>Quedamos atentos a su confirmación.</p>'+
    (sign.length?'<p>Saludos cordiales,</p><p style="border-top:1px solid #dce2e9;padding-top:12px">'+signatureHtml+'</p>':'<p>Saludos cordiales.</p>')+
    '</td></tr></table></body></html>';
  const boundary='kardex-solicitud-'+clean(row.id||'demo').replace(/[^a-z0-9-]/gi,'').slice(0,32);
  const subjectEncoded='=?UTF-8?B?'+btoa(String.fromCharCode(...new TextEncoder().encode((simulation?'SIMULACIÓN · ':'')+subject)))+'?=';
  const eml=['X-Unsent: 1','From: '+sender,'To: '+to.join(', '),
    ...(cc.length?['Cc: '+cc.join(', ')]:[]),'Subject: '+subjectEncoded,
    'MIME-Version: 1.0','Content-Type: multipart/alternative; boundary="'+boundary+'"',
    '','--'+boundary,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',b64(text),
    '--'+boundary,'Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',b64(html),
    '--'+boundary+'--',''].join('\r\n');
  return {subject,text,html,eml,from:sender,to,cc,count,kind:supply?'nuevas':'prestamo',
    senderConfigured:validEmail(clean(config.sender)),
    filename:'solicitud_cajas_'+number.replace(/[^a-z0-9-]/gi,'').slice(0,24)+(simulation?'_PRUEBA':'')+'.eml'};
}
