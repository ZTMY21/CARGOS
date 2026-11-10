import {REQ_TYPES} from './rules.js';

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
  const count=supply?Number(row.cantidadCajas):boxes.length;
  if(!Number.isSafeInteger(count)||count<1||(supply&&count>100))
    throw Error(supply?'La solicitud debe tener entre 1 y 100 cajas.':'No hay cajas registradas en este préstamo.');
  const sender=simulation?'remitente@example.invalid':clean(config.sender);
  const to=simulation?['destinatario@example.invalid']:Array.isArray(config.to)?config.to.map(clean):[];
  const cc=simulation?[]:Array.isArray(config.cc)?config.cc.map(clean):[];
  if(!validEmail(sender)||!to.length||!to.every(validEmail)||!cc.every(validEmail))
    throw Error('No se pudieron recuperar los destinatarios de Aviso de recojo.');
  const name=clean(config.name)||(simulation?'Remitente de prueba':'');
  const company=clean(config.company)||(simulation?'Farmacias Peruanas':'');
  if(!name||!company)throw Error('La firma de Aviso de recojo está incompleta.');
  const number=clean(row.numero)||'SIN NÚMERO';
  const subject='Solicitud de '+count+' '+(supply?'cajas nuevas':'cajas en préstamo')+' | CD Santa Anita | '+number;
  const greeting='Buenas tardes, estimados:';
  const intro=supply
    ?'Por medio del presente, solicitamos '+count+' '+(count===1?'caja nueva':'cajas nuevas')+' para el acondicionamiento de documentos en el CD Santa Anita.'
    :'Por medio del presente, solicitamos el préstamo de '+count+' '+(count===1?'caja':'cajas')+' a Iron Mountain para la consulta de documentos del CD Santa Anita.';
  const summary=['Requerimiento: '+number,'Fecha de solicitud: '+clean(row.fechaSolicitud),'Solicitante: '+clean(row.usuario)];
  const details=supply?['Cantidad solicitada: '+count+' cajas']:boxes.map(box=>{
    const code=clean(box.codigo||box.code);
    const cargos=Array.isArray(box.cargos)?box.cargos.map(clean).filter(Boolean):[];
    return 'Caja '+code+(cargos.length?' · Cargos: '+cargos.join(' - '):'');
  });
  const request=supply
    ?'Agradeceremos confirmar la disponibilidad y la fecha programada de entrega.'
    :'Agradeceremos confirmar la disponibilidad y la fecha de atención de este préstamo.';
  const sign=[name,config.position,config.area,company,config.contact].map(clean).filter(Boolean);
  const text=[greeting,'',intro,'',...summary,'',...details,'',request,'','Quedamos atentos a su confirmación.','','Saludos cordiales,',...sign].join('\r\n');
  const signatureHtml=sign.map(escapeHtml).join('<br>');
  const html='<!doctype html><html lang="es"><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;background:#f5f7f9;color:#172033;padding:20px">'+
    '<table role="presentation" style="max-width:640px;width:100%;margin:auto;background:white;border:1px solid #dce2e9;border-top:4px solid #b50917;border-collapse:collapse"><tr><td style="padding:24px;font-size:14px;line-height:1.6">'+
    '<h2 style="margin:0;color:#172033">Farmacias Peruanas</h2><p style="margin:0 0 18px;color:#526071;font-size:12px">Gestión documental · CD Santa Anita</p>'+
    '<h3 style="margin:0 0 18px">'+escapeHtml(subject)+'</h3><p>'+escapeHtml(greeting)+'</p><p>'+escapeHtml(intro)+'</p>'+
    '<p>'+summary.map(escapeHtml).join('<br>')+'</p>'+
    '<ul>'+details.map(line=>'<li>'+escapeHtml(line)+'</li>').join('')+'</ul><p>'+escapeHtml(request)+'</p><p>Quedamos atentos a su confirmación.</p><p>Saludos cordiales,</p>'+
    '<p style="border-top:1px solid #dce2e9;padding-top:12px">'+signatureHtml+'</p></td></tr></table></body></html>';
  const boundary='kardex-solicitud-'+clean(row.id||'demo').replace(/[^a-z0-9-]/gi,'').slice(0,32);
  const subjectEncoded='=?UTF-8?B?'+btoa(String.fromCharCode(...new TextEncoder().encode((simulation?'SIMULACIÓN · ':'')+subject)))+'?=';
  const eml=['X-Unsent: 1','From: '+sender,'To: '+to.join(', '),
    ...(cc.length?['Cc: '+cc.join(', ')]:[]),'Subject: '+subjectEncoded,
    'MIME-Version: 1.0','Content-Type: multipart/alternative; boundary="'+boundary+'"',
    '','--'+boundary,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',b64(text),
    '--'+boundary,'Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',b64(html),
    '--'+boundary+'--',''].join('\r\n');
  return {subject,text,html,eml,from:sender,to,cc,count,kind:supply?'nuevas':'prestamo',
    filename:'solicitud_cajas_'+number.replace(/[^a-z0-9-]/gi,'').slice(0,24)+(simulation?'_PRUEBA':'')+'.eml'};
}
