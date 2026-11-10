import {REQUEST_MAIL_TO,REQUEST_MAIL_CC} from './requirements-mail-template.js';

// Iron Mountain identifica las cajas por código; nunca adjuntar cargos ni
// referencias de los documentos al correo de "Solicitudes a IM".
export function imMailCodes(items=[]){
  const seen=new Set(),codes=[];
  for(const item of Array.isArray(items)?items:[]){
    const code=String(typeof item==='string'?item:(item?.codigo??item?.code??''))
      .replace(/[\x00-\x1f\x7f]/g,'').trim();
    if(!code||seen.has(code.toUpperCase()))continue;
    seen.add(code.toUpperCase());codes.push(code);
  }
  return codes;
}
export function composeImMail(items=[]){
  const codes=imMailCodes(items);
  if(!codes.length)throw Error('Esta solicitud no tiene códigos de cajas registrados en IM.');
  const qty=codes.length;
  const subject='Solicitud de '+qty+' '+(qty===1?'caja':'cajas')+' a IM | CD Santa Anita |';
  const text=[
    'Buenas tardes, estimados:',
    '',
    'Por medio del presente, solicitamos a Iron Mountain el préstamo de '+
      qty+' '+(qty===1?'caja identificada':'cajas identificadas')+' por los siguientes códigos:',
    '',
    ...codes,
    '',
    'Agradeceremos confirmar la disponibilidad y la fecha programada de entrega.',
    '',
    'Quedamos atentos a su confirmación.',
    '',
    'Saludos cordiales.'
  ].join('\r\n');
  return {codes,count:qty,subject,text,to:[...REQUEST_MAIL_TO],cc:[...REQUEST_MAIL_CC]};
}
export function imMailto(mail){
  // mailto usa %20; URLSearchParams produce '+' que Outlook muestra literalmente.
  return 'mailto:'+mail.to.join(',')+
    '?cc='+encodeURIComponent(mail.cc.join(','))+
    '&subject='+encodeURIComponent(mail.subject)+
    '&body='+encodeURIComponent(mail.text.replace(/\r?\n/g,'\r\n'));
}
