import {composeImRequestMail,imRequestCodes,imRequestMailto} from './im-request-mail.js';

// Aparece después de "Solicitar" en su pestaña. Sin envío automático ni Excel.
export function setupImRequestMail(root,{context}){
  const doc=root.ownerDocument;
  let draft=null,viewer=null;
  const isPreview=()=>context().mailPreviewMode!==false;
  const allowed=()=>Boolean(context().mailAccess);

  root.innerHTML=
    '<section class="req4-im-mail-card" aria-labelledby="req4ImMailTitle">'+
      '<div class="req4-im-mail-title"><div>'+
        '<h3 id="req4ImMailTitle">Correo generado · Solicitudes a IM</h3>'+
        '<p>Se incluyen únicamente los códigos de caja de la solicitud registrada.</p>'+
      '</div><span id="req4ImMailBadge" class="req4-mail-stage">No enviado</span></div>'+
      '<dl class="req4-mail-fields">'+
        '<dt>De</dt><dd>Cuenta activa de Outlook al redactar</dd>'+
        '<dt>Para</dt><dd id="req4ImMailTo"></dd>'+
        '<dt>CC</dt><dd id="req4ImMailCc"></dd>'+
        '<dt>Asunto</dt><dd id="req4ImMailSubject"></dd>'+
      '</dl>'+
      '<div class="req4-mail-content"><pre id="req4ImMailBody"></pre></div>'+
      '<div class="req4-im-mail-footer">'+
        '<p id="req4ImMailStatus" role="status" aria-live="polite"></p>'+
        '<button id="req4ImMailOutlook" type="button">Abrir correo en Outlook</button>'+
      '</div>'+
    '</section>';
  const el=suffix=>root.querySelector('#req4ImMail'+suffix);

  function render(){
    // La tarjeta solo aparece después de guardar una solicitud a IM.
    root.hidden=!draft||!allowed();
    if(root.hidden)return;
    const {mail,demo}=draft;
    el('To').textContent=mail.to.join('; ');
    el('Cc').textContent=mail.cc.join('; ');
    el('Subject').textContent=mail.subject;
    el('Body').textContent=mail.text;
    el('Badge').textContent=demo?'Demostración · no enviado':'Solicitud registrada · no enviado';
    el('Status').textContent=demo
      ?'Simulación con códigos ficticios. No se registró la solicitud ni se envió un correo.'
      :isPreview()
        ?'Vista previa: el correo no se enviará ni generará registros reales.'
        :'Revisa los destinatarios y envía el mensaje manualmente desde Outlook.';
    el('Outlook').disabled=isPreview()||demo;
  }

  function selectionChanged(boxes){
    if(!draft)return;
    // Invalida el correo anterior cuando se inicia una nueva selección de cajas.
    if(imRequestCodes(boxes).length)draft=null;
    render();
  }
  function showSaved(row,codes){
    if(!allowed()||!row?.id)return;
    draft={mail:composeImRequestMail(codes),demo:false,requestId:row.id};
    render();
    root.scrollIntoView?.({behavior:'smooth',block:'nearest'});
  }
  function reset(){draft=null;render();}
  function update(){
    const id=context().id;
    if(viewer!==id){viewer=id;reset();return;}
    render();
  }
  function openOutlook(){
    if(!allowed()||isPreview()||!draft||draft.demo)return;
    const a=doc.createElement('a');
    a.href=imRequestMailto(draft.mail);
    doc.body.append(a);a.click();a.remove();
    el('Status').textContent='Borrador abierto. Verifica la cuenta remitente y envíalo manualmente.';
  }
  el('Outlook').addEventListener('click',openOutlook);
  update();
  return {update,selectionChanged,showSaved,reset};
}
