import {REQ_TYPES} from './rules.js';
import {composeImMail,imMailCodes,imMailto} from './requirements-im-mail.js';

// Panel hermano del correo de Cajas nuevas. Está en la misma pantalla de
// Requerimientos y solo aparece al elegir la pestaña "Solicitudes a IM".
export function setupRequirementsImMail(root,{repository,context}){
  const doc=root.ownerDocument,win=doc.defaultView;
  const preview=()=>context().mailPreviewMode!==false;
  const accessible=()=>Boolean(context().mailAccess);
  const exampleCodes=['T00045','TD00046','P00078'];
  let rows=[],tracking=null,selectedId='',draft=null,busy=false,viewer=null,epoch=0,demoStarted=false;
  let overrideCodes=new Map();

  root.innerHTML=
    '<section class="req4-mail-panel" aria-labelledby="req4ImMailTitle">'+
      '<div class="req4-mail-heading"><div class="req4-mail-icon" aria-hidden="true">✉</div>'+
      '<div><h3 id="req4ImMailTitle">Correo de solicitud a IM</h3>'+
      '<p>Genera el correo de las solicitudes registradas en Iron Mountain. Solo incluye los códigos de las cajas.</p></div>'+
      '<span id="req4ImMailPreviewBadge" class="req4-mail-preview-badge">PREVIEW</span></div>'+
      '<div class="req4-mail-controls"><label for="req4ImMailSelect">Solicitud a IM registrada'+
      '<select id="req4ImMailSelect"></select></label></div>'+
      '<div class="req4-mail-buttons">'+
      '<button id="req4ImMailGenerate" type="button">Generar correo de solicitud</button>'+
      '<button id="req4ImMailViewTop" class="secondary" type="button">Ver correo generado</button>'+
      '<button id="req4ImMailExample" class="secondary" type="button">Simular 3 cajas a IM</button>'+
      '</div>'+
      '<p id="req4ImMailStatus" class="req4-mail-status" role="status" aria-live="polite"></p>'+
      '<div id="req4ImMailResult" class="req4-mail-result" hidden>'+
        '<div class="req4-mail-result-head"><h4>Correo generado · Solicitudes a IM</h4>'+
        '<span id="req4ImMailBadge" class="req4-mail-stage">No enviado</span></div>'+
        '<dl class="req4-mail-fields">'+
          '<dt>De</dt><dd>Cuenta activa de Outlook al redactar</dd>'+
          '<dt>Para</dt><dd id="req4ImMailTo"></dd>'+
          '<dt>CC</dt><dd id="req4ImMailCc"></dd>'+
          '<dt>Asunto</dt><dd id="req4ImMailSubject"></dd>'+
        '</dl>'+
        '<div class="req4-mail-content"><pre id="req4ImMailBody"></pre></div>'+
        '<p class="req4-mail-info">No se genera Excel ni se envía ningún correo automáticamente.</p>'+
        '<div class="req4-mail-footer">'+
          '<button id="req4ImMailOutlook" type="button">Abrir correo en Outlook</button>'+
          '<button id="req4ImMailMark" class="secondary" type="button">Registrar correo enviado</button>'+
        '</div>'+
      '</div>'+
    '</section>';
  const el=suffix=>root.querySelector('#req4ImMail'+suffix);
  const available=()=>rows.filter(row=>row.tipo===REQ_TYPES[1]);
  function status(message='',error=false){
    el('Status').textContent=message;
    el('Status').classList.toggle('is-error',error);
  }
  function codesFor(row){
    const saved=(tracking?.cajas||[])
      .filter(box=>box.requerimiento===row.id).map(box=>box.codigo);
    return imMailCodes(saved.length?saved:(overrideCodes.get(row.id)||[]));
  }
  function renderRows(){
    const select=el('Select');
    const availableRows=available();
    if(selectedId&&!availableRows.some(row=>row.id===selectedId))selectedId='';
    if(!selectedId&&availableRows.length)selectedId=availableRows.at(-1).id;
    select.replaceChildren();
    if(!availableRows.length){
      const option=doc.createElement('option');option.value='';
      option.textContent='Sin solicitudes a IM registradas';
      select.append(option);
    }
    for(const row of [...availableRows].reverse()){
      const option=doc.createElement('option');
      option.value=row.id;
      option.textContent=(row.numero||'Solicitud')+' · '+Number(row.cantidadCajas||codesFor(row).length)+' cajas';
      select.append(option);
    }
    select.value=selectedId;
    select.disabled=busy||!availableRows.length;
    el('Generate').disabled=busy||!selectedId;
    el('Example').hidden=!preview();
    el('Example').disabled=busy||!accessible();
    el('PreviewBadge').hidden=!preview();
    el('ViewTop').disabled=busy||!draft;
  }
  function renderDraft(){
    el('Result').hidden=!draft;
    if(!draft){
      for(const f of ['To','Cc','Subject','Body'])el(f).textContent='';
      return;
    }
    const {mail,sent,example}=draft;
    el('To').textContent=mail.to.join('; ');
    el('Cc').textContent=mail.cc.join('; ');
    el('Subject').textContent=mail.subject;
    el('Body').textContent=mail.text;
    el('Badge').textContent=sent?'Correo enviado · registrado':example?'Simulación · no enviado':'No enviado';
    el('Outlook').disabled=busy||sent||preview();
    el('Mark').hidden=preview();
    el('Mark').disabled=busy||sent;
  }
  async function generate({example=false,scroll=true}={}){
    if(!accessible()||busy||example&&!preview())return;
    const row=example?null:available().find(row=>row.id===selectedId);
    if(!example&&!row){status('Selecciona una solicitud registrada a IM.',true);return;}
    const codes=example?exampleCodes:codesFor(row);
    if(!codes.length){
      draft=null;renderDraft();
      status('No hay códigos de caja registrados para esta solicitud a IM.',true);
      return;
    }
    const current=++epoch,actor=context().id;
    busy=true;renderRows();status('Preparando correo con los códigos de caja…');
    try{
      const mail=composeImMail(codes);
      const response=example||preview()||typeof repository?.requirementsMail!=='function'
        ?null:await repository.requirementsMail('estado',row.id);
      if(current!==epoch||actor!==context().id||!accessible())return;
      const sent=response?.estado==='ENVIADO';
      draft={mail,row,example,sent};
      renderDraft();
      status(sent?'Esta solicitud ya tiene correo registrado como enviado.':example
        ?'Simulación con códigos ficticios: no se ha enviado ni registrado un correo.'
        :'Correo generado. Revisa los códigos y destinatarios antes de enviarlo desde Outlook.');
      if(scroll)el('Result').scrollIntoView?.({behavior:'smooth',block:'nearest'});
    }catch(error){
      if(current===epoch&&actor===context().id){
        draft=null;renderDraft();status(error?.message||'No se pudo generar el correo.',true);
      }
    }finally{busy=false;renderRows();renderDraft();}
  }
  async function selectRequest(id,{codes,generate:autoGenerate=false}={}){
    if(!accessible()||!available().some(row=>row.id===id))return;
    if(Array.isArray(codes))overrideCodes.set(id,imMailCodes(codes));
    ++epoch;selectedId=id;draft=null;renderRows();renderDraft();status('');
    if(autoGenerate)await generate();
  }
  async function markSent(){
    if(!accessible()||preview()||busy||!draft||draft.example||draft.sent)return;
    if(!win.confirm('Confirma únicamente si ya enviaste el correo desde Outlook. ¿Fue enviado?'))return;
    const current=epoch,actor=context().id,currentDraft=draft;
    busy=true;renderRows();renderDraft();status('Registrando confirmación…');
    try{
      const response=await repository.requirementsMail('confirmar',currentDraft.row.id,currentDraft.mail.subject);
      if(current!==epoch||actor!==context().id||draft!==currentDraft||!accessible())return;
      if(response?.estado!=='ENVIADO')throw Error('No se pudo confirmar el envío.');
      currentDraft.sent=true;
      status('Correo registrado como enviado manualmente. La entrega al destinatario no ha sido comprobada.');
    }catch(error){if(current===epoch&&actor===context().id)status(error?.message||'Error al confirmar.',true);}
    finally{busy=false;renderRows();renderDraft();}
  }
  function openOutlook(){
    if(!accessible()||preview()||busy||!draft||draft.example||draft.sent)return;
    const link=doc.createElement('a');
    link.href=imMailto(draft.mail);
    doc.body.append(link);link.click();link.remove();
    status('Borrador abierto para Outlook. Revisa los códigos y envíalo manualmente.');
  }
  el('Generate').addEventListener('click',()=>void generate());
  el('Example').addEventListener('click',()=>void generate({example:true}));
  el('ViewTop').addEventListener('click',()=>{
    if(draft){renderDraft();el('Result').scrollIntoView?.({behavior:'smooth',block:'nearest'});}
  });
  el('Outlook').addEventListener('click',openOutlook);
  el('Mark').addEventListener('click',()=>void markSent());
  el('Select').addEventListener('change',()=>{
    ++epoch;selectedId=el('Select').value;draft=null;renderRows();renderDraft();status('');
  });
  return {
    update(records=[],detail=null){
      if(viewer!==context().id){
        ++epoch;viewer=context().id;selectedId='';draft=null;demoStarted=false;overrideCodes.clear();status('');
      }
      rows=records;tracking=detail;
      renderRows();renderDraft();
      if(preview()&&!demoStarted&&accessible()&&new URLSearchParams(win.location.search).get('reqMail')==='im'){
        demoStarted=true;
        // El enlace demo abre el panel en su pestaña, sin borrar las solicitudes existentes.
        void generate({example:true,scroll:false});
      }
    },
    selectRequest
  };
}
