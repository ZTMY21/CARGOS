import {composeImRequestMail,imRequestCodes,imRequestMailto} from './im-request-mail.js';

// Se monta solo dentro de la pestaña "Solicitudes a IM".
// No escribe en Supabase, no genera Excel y nunca envía el mensaje.
export function setupImRequestMail(root,{context}){
  const doc=root.ownerDocument;
  let selected=[],draft=null,viewer=null;
  const preview=()=>context().mailPreviewMode!==false;
  const accessible=()=>Boolean(context().allowed&&context().mailAccess);
  const exampleCodes=['T00045','TD00046','P00078'];
  root.innerHTML=
    '<section class="req4-mail-panel" aria-labelledby="req4ImMailTitle">'+
    '<div class="req4-mail-heading"><div class="req4-mail-icon" aria-hidden="true">✉</div>'+
    '<div><h3 id="req4ImMailTitle">Correo de solicitud a Iron Mountain</h3>'+
    '<p>Usa los códigos de las cajas seleccionadas arriba. No incluye cargos, facturas ni guías.</p></div>'+
    '<span id="req4ImMailPreviewBadge" class="req4-mail-preview-badge">PREVIEW</span></div>'+
    '<div class="req4-mail-buttons">'+
    '<button id="req4ImMailGenerate" type="button">Ver correo con cajas seleccionadas</button>'+
    '<button id="req4ImMailExample" class="secondary" type="button">Simular solicitud a IM</button>'+
    '</div>'+
    '<p id="req4ImMailStatus" class="req4-mail-info" role="status" aria-live="polite"></p>'+
    '<div id="req4ImMailResult" class="req4-mail-result" hidden>'+
    '<div class="req4-mail-result-head"><h4>Correo generado · Solicitudes a IM</h4>'+
    '<span id="req4ImMailBadge" class="req4-mail-stage">No enviado</span></div>'+
    '<dl class="req4-mail-fields"><dt>De</dt><dd>Cuenta activa de Outlook al redactar</dd>'+
    '<dt>Para</dt><dd id="req4ImMailTo"></dd><dt>CC</dt><dd id="req4ImMailCc"></dd>'+
    '<dt>Asunto</dt><dd id="req4ImMailSubject"></dd></dl>'+
    '<div class="req4-mail-content"><pre id="req4ImMailBody"></pre></div>'+
    '<p class="req4-mail-info" id="req4ImMailNote"></p>'+
    '<div class="req4-mail-footer"><button id="req4ImMailView" type="button" class="secondary">Ver correo generado</button>'+
    '<button id="req4ImMailOutlook" type="button">Abrir correo en Outlook</button></div>'+
    '</div></section>';
  const el=suffix=>root.querySelector('#req4ImMail'+suffix);
  function message(text,isError=false){
    const node=el('Status');
    node.textContent=text;
    node.classList.toggle('is-error',isError);
  }
  function render(){
    const isDemo=preview();
    const enabled=accessible();
    root.hidden=!enabled;
    el('PreviewBadge').hidden=!isDemo;
    el('Example').hidden=!isDemo;
    el('Generate').disabled=!enabled||!selected.length;
    el('Result').hidden=!draft||!enabled;
    if(!draft)return;
    const {mail,saved,demo}=draft;
    el('To').textContent=mail.to.join('; ');
    el('Cc').textContent=mail.cc.join('; ');
    el('Subject').textContent=mail.subject;
    el('Body').textContent=mail.text;
    el('Badge').textContent=demo?'Simulación · no enviado':saved?'Solicitud registrada · no enviado':'Pendiente de guardar';
    el('Note').textContent=demo
      ?'Ejemplo con códigos ficticios. No se registró ninguna solicitud ni se envió un correo.'
      :saved
        ?'Solicitud registrada. Abre Outlook y verifica el correo antes de enviarlo manualmente.'
        :'Primero guarda la solicitud desde el botón Solicitar. Este borrador aún no se puede enviar.';
    el('Outlook').disabled=!enabled||isDemo||!saved||demo;
  }
  function generate(){
    if(!accessible())return;
    if(!selected.length){message('Selecciona las cajas de Iron Mountain antes de generar el correo.',true);return;}
    draft={mail:composeImRequestMail(selected),saved:false,demo:false};
    message('Borrador preparado con los códigos seleccionados. Guarda la solicitud antes de abrir Outlook.');
    render();
    el('Result').scrollIntoView?.({behavior:'smooth',block:'nearest'});
  }
  function showDemo(){
    if(!accessible()||!preview())return;
    draft={mail:composeImRequestMail(exampleCodes),saved:false,demo:true};
    message('Simulación de Solicitudes a IM con tres códigos ficticios. No se enviará nada.');
    render();
    el('Result').scrollIntoView?.({behavior:'smooth',block:'nearest'});
  }
  function selectionChanged(boxes){
    const next=imRequestCodes(boxes);
    const changed=next.join('\u001f')!==selected.join('\u001f');
    selected=next;
    if(changed&&(next.length||!draft?.saved)){
      draft=null;
      message(next.length
        ?next.length+' '+(next.length===1?'caja seleccionada':'cajas seleccionadas')+' para la solicitud a IM.'
        :'Selecciona las cajas de la lista o revisa una simulación.');
    }
    render();
  }
  function showSaved(row,codes){
    if(!accessible()||!row?.id)return;
    draft={mail:composeImRequestMail(codes),saved:true,demo:false,requestId:row.id};
    message((row.numero||'Solicitud')+' registrada. Correo preparado con los códigos solicitados.');
    render();
    el('Result').scrollIntoView?.({behavior:'smooth',block:'nearest'});
  }
  function reset(){
    selected=[];draft=null;
    message('');
    render();
  }
  function update(){
    const id=context().id;
    if(viewer!==id){viewer=id;reset();return;}
    render();
  }
  function openOutlook(){
    if(!accessible()||preview()||!draft?.saved||draft.demo)return;
    const a=doc.createElement('a');
    a.href=imRequestMailto(draft.mail);
    doc.body.append(a);a.click();a.remove();
    message('Correo abierto para redactar en Outlook. Verifica el remitente y envíalo manualmente; el aplicativo no lo envía.');
  }
  el('Generate').addEventListener('click',generate);
  el('Example').addEventListener('click',showDemo);
  el('View').addEventListener('click',()=>{
    if(draft){render();el('Result').scrollIntoView?.({behavior:'smooth',block:'nearest'});}
  });
  el('Outlook').addEventListener('click',openOutlook);
  update();
  return {update,selectionChanged,showSaved,showDemo,reset};
}
