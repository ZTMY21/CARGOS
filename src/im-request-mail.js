import {REQUEST_MAIL_TO,REQUEST_MAIL_CC} from './requirements-mail-template.js';

// Solo utiliza códigos de las cajas seleccionadas en "Solicitudes a IM".
export function imRequestCodes(selected=[]){
  const seen=new Set(),codes=[];
  for(const box of selected){
    const raw=typeof box==='string'?box:(box?.codigo??box?.code??'');
    const code=String(raw).replace(/[\x00-\x1f\x7f]/g,'').trim();
    const key=code.toUpperCase();
    if(!key||seen.has(key))continue;
    seen.add(key);codes.push(code);
  }
  return codes;
}

export function composeImRequestMail(selected=[]){
  const codes=imRequestCodes(selected);
  if(!codes.length)throw Error('Selecciona al menos una caja enviada a Iron Mountain.');
  const count=codes.length;
  const subject='Solicitud de '+count+' '+(count===1?'caja':'cajas')+' a IM | CD Santa Anita |';
  const text=[
    'Buenas tardes, estimados:',
    '',
    'Por medio del presente, solicitamos a Iron Mountain el préstamo de '+count+
      ' '+(count===1?'caja, identificada':'cajas, identificadas')+' por los siguientes códigos:',
    '',
    ...codes,
    '',
    'Agradeceremos confirmar la disponibilidad y la fecha programada de entrega de estas cajas.',
    '',
    'Quedamos atentos a su confirmación.',
    '',
    'Saludos cordiales.'
  ].join('\r\n');
  return {subject,text,codes,count,to:[...REQUEST_MAIL_TO],cc:[...REQUEST_MAIL_CC]};
}

// RFC 6068: encodeURIComponent usa %20 en lugar de '+' para los espacios.
export function imRequestMailto(mail){
  return 'mailto:'+mail.to.join(',')+
    '?cc='+encodeURIComponent(mail.cc.join(','))+
    '&subject='+encodeURIComponent(mail.subject)+
    '&body='+encodeURIComponent(mail.text.replace(/\r?\n/g,'\r\n'));
}
