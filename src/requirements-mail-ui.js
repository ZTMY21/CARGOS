import {REQ_TYPES,limaDate} from './rules.js';
import {composeRequirementsMail} from './requirements-mail-template.js';

// La preview no hace escrituras: descargará EML con destinatarios ficticios.
// En producción, solo una confirmación manual registra el envío, nunca lo realiza.
export function setupRequirementsMail(root,{repository,context}){
  let rows=[],tracking=null,selectedId='',currentDraft=null,busy=false,userId=null,generationEpoch=0,previewAutoloaded=false;
  const example={
    id:'ejemplo-sin-guardar',numero:'SIMULACIÓN-100',tipo:REQ_TYPES[0],
    cantidadCajas:100,fechaSolicitud:limaDate(),usuario:'Personal de CD Santa Anita'
  };
  root.innerHTML=
    '<section class="req4-mail-panel" aria-labelledby="req4MailTitle">'+
    '<div class="req4-mail-heading"><div class="req4-mail-icon" aria-hidden="true">✉</div>'+
    '<div><h3 id="req4MailTitle">Correo de solicitud de cajas</h3>'+
    '<p>Genera la solicitud con destinatarios definidos para cajas y reutiliza la firma disponible. Sin Excel ni adjuntos.</p></div>'+
    '<span id="req4MailPreviewBadge" class="req4-mail-preview-badge">PREVIEW</span></div>'+
    '<div class="req4-mail-controls">'+
    '<label for="req4MailSelect">Solicitud registrada<select id="req4MailSelect"></select></label>'+
    '<div class="req4-mail-buttons"><button id="req4MailGenerate" type="button">Generar correo de solicitud</button>'+ 
    '<button id="req4MailViewTop" class="secondary" type="button">Ver correo generado</button>'+
    '<button id="req4MailExample" class="secondary" type="button">Simular con 100 cajas</button></div></div>'+
    '<p id="req4MailInfo" class="req4-mail-info">La vista previa permite revisar el mensaje y descargar un borrador de prueba para Outlook con destinatarios ficticios. No registra ni envía correos.</p>'+
    '<p id="req4MailStatus" class="req4-mail-status" role="status" aria-live="polite"></p>'+
    '<div id="req4MailResult" class="req4-mail-result" hidden>'+
    '<div class="req4-mail-result-head"><h4>Borrador de Outlook · Solicitud de cajas</h4>'+
    '<span id="req4MailBadge" class="req4-mail-stage">No enviado</span></div>'+
    '<dl class="req4-mail-fields"><dt>De</dt><dd id="req4MailFrom"></dd>'+
    '<dt>Para</dt><dd id="req4MailTo"></dd><dt>CC</dt><dd id="req4MailCc"></dd>'+
    '<dt>Asunto</dt><dd id="req4MailSubject"></dd></dl>'+
    '<div class="req4-mail-content"><div class="req4-mail-brand"><strong>Farmacias Peruanas</strong>'+
    '<small>Gestión documental · CD Santa Anita</small></div>'+
    '<pre id="req4MailBody"></pre></div>'+
    '<p id="req4MailSafety" class="req4-mail-info">No se adjunta ningún Excel. El borrador de prueba utiliza direcciones ficticias para evitar envíos involuntarios.</p>'+
    '<div class="req4-mail-footer"><button id="req4MailView" type="button" class="secondary">Ver correo generado</button>'+
    '<button id="req4MailOutlook" type="button">Descargar borrador de prueba para Outlook</button>'+
    '<button id="req4MailMark" type="button" class="secondary">Simular correo enviado</button></div>'+
    '</div></section>';
  const doc=root.ownerDocument,win=doc.defaultView;
  const el=name=>root.querySelector('#req4Mail'+name);
  const select=el('Select'),status=el('Status'),result=el('Result');
  const previewMode=()=>context().mailPreviewMode!==false;
  function renderMode(){
    const preview=previewMode();
    el('PreviewBadge').hidden=!preview;
    el('Example').hidden=!preview;
    el('Info').textContent=preview
      ?'El correo se muestra en esta pantalla con los destinatarios indicados y la cantidad solicitada. La descarga de prueba no envía ni registra correos.'
      :'Genera un borrador de Outlook con los destinatarios indicados para solicitudes de cajas. El envío se realiza manualmente.';
    el('Safety').textContent=preview
      ?'No se genera ningún Excel. El borrador de prueba contiene direcciones ficticias.'
      :'Sin Excel ni adjuntos. Descarga el EML, envíalo desde Outlook y solo después confirma el envío en el aplicativo.';
    el('Outlook').textContent=preview?'Descargar borrador de prueba para Outlook':'Descargar borrador para Outlook';
    el('Mark').textContent=preview?'Simular correo enviado':'Registrar correo enviado';
  }
  const available=()=>rows.filter(row=>[REQ_TYPES[0],REQ_TYPES[1]].includes(row.tipo));
  const setStatus=(message,isError=false)=>{
    status.textContent=message;
    status.classList.toggle('is-error',isError);
  };
  function renderRows(){
    const possible=available();
    const options=possible.slice().reverse();
    select.replaceChildren();
    if(!options.length){
      const option=doc.createElement('option');
      option.value='';option.textContent=previewMode()?'Sin solicitudes registradas · Usa la simulación':'Sin solicitudes registradas';
      select.append(option);
      select.disabled=true;
    }else{
      for(const row of options){
        const option=doc.createElement('option');
        const loan=row.tipo===REQ_TYPES[1];
        option.value=row.id;
        option.textContent=(row.numero||'Solicitud')+' · '+(loan?'Préstamo':'Cajas nuevas')+
          ' · '+(loan?(tracking?.cajas||[]).filter(box=>box.requerimiento===row.id).length:Number(row.cantidadCajas)||0)+' cajas';
        select.append(option);
      }
      select.disabled=false;
      if(!options.some(row=>row.id===selectedId))selectedId=options[0].id;
      select.value=selectedId;
    }
    el('Generate').disabled=busy||!select.value;
    el('Example').disabled=busy||!previewMode();
  }
  const requestBoxes=row=>(tracking?.cajas||[]).filter(box=>box.requerimiento===row.id)
    .map(box=>({codigo:box.codigo,cargos:box.cargos}));
  function renderDraft(){
    result.hidden=!currentDraft;
    if(!currentDraft){
      for(const field of ['From','To','Cc','Subject','Body'])el(field).textContent='';
      return;
    }
    const {mail,simulation,sent}=currentDraft;
    el('From').textContent=mail.senderConfigured?mail.from:'Pendiente de confirmar (sin remitente configurado)';
    el('To').textContent=mail.to.join('; ');
    el('Cc').textContent=mail.cc.join('; ')||'—';
    el('Subject').textContent=mail.subject;
    el('Body').textContent=mail.text;
    el('Badge').textContent=sent?(previewMode()?'Envío simulado':'Correo enviado · registrado'):
      simulation?'Simulación · no enviado':'No enviado';
    el('Mark').disabled=sent||busy;
    el('Outlook').disabled=sent||busy;
  }
  async function generate(sample=false,{scroll=true}={}){
    if(!context().mailAccess||busy||(sample&&!previewMode()))return;
    const row=sample?example:available().find(r=>r.id===select.value);
    if(!row){setStatus('Selecciona una solicitud registrada.',true);return;}
    const boxes=sample?[]:requestBoxes(row);
    const epoch=++generationEpoch,actor=context().id;
    busy=true;renderRows();setStatus('Recuperando destinatarios y preparando el correo…');
    try{
      // Solo reutiliza el remitente y firma, si existen; los destinatarios
      // fueron definidos explícitamente para este correo de solicitudes.
      const preview=previewMode();
      // La vista previa aparece de inmediato: nunca espera a la conexión de
      // Aviso de recojo para mostrar el asunto y los destinatarios confirmados.
      const config=preview?{}:await repository.pickupMailConfig();
      if(epoch!==generationEpoch||!context().mailAccess||context().id!==actor)return;
      const mail=composeRequirementsMail(row,boxes,config||{},{preview});
      const state=preview?null:await repository.requirementsMail('estado',row.id);
      if(epoch!==generationEpoch||!context().mailAccess||context().id!==actor)return;
      const sent=state?.estado==='ENVIADO';
      const draft={row,boxes,config:config||{},mail,simulation:sample,sent};
      currentDraft=draft;
      renderDraft();
      setStatus(sent
        ?'Esta solicitud ya tiene un correo registrado como enviado. No se descargará otro borrador para evitar duplicados.'
        :!mail.senderConfigured?'Correo generado con los destinatarios indicados. Falta confirmar el remitente; no se ha enviado ningún mensaje.'
        :'Correo generado y listo para revisión. No se ha enviado ni registrado ningún mensaje.');
      if(scroll)result.scrollIntoView?.({behavior:'smooth',block:'nearest'});
      if(preview&&typeof repository.pickupMailConfig==='function'){
        void Promise.resolve().then(()=>repository.pickupMailConfig()).then(settings=>{
          if(epoch!==generationEpoch||context().id!==actor||!context().mailAccess||currentDraft!==draft)return;
          const configured=composeRequirementsMail(row,boxes,settings||{},{preview:true});
          draft.config=settings||{};draft.mail=configured;
          renderDraft();
          if(configured.senderConfigured)
            setStatus('Correo generado con remitente y firma recuperados. No se ha enviado ningún mensaje.');
        }).catch(()=>{/* El correo ya se muestra aun sin configuración remota. */});
      }
    }catch(error){
      if(epoch!==generationEpoch||!context().mailAccess||context().id!==actor)return;
      if(!sample){
        currentDraft=null;renderDraft();
        setStatus(error?.message||'No se pudo generar el correo.',true);
      }else{
        currentDraft=null;renderDraft();
        setStatus(error?.message||'No se pudo generar la vista previa de las 100 cajas.',true);
      }
    }finally{busy=false;renderRows();renderDraft();}
  }
  function download(){
    if(!context().mailAccess||!currentDraft||currentDraft.sent||busy)return;
    const safe=previewMode()
      ?composeRequirementsMail(currentDraft.row,currentDraft.boxes,currentDraft.config,{simulation:true})
      :currentDraft.mail;
    const blob=new Blob([safe.eml],{type:'message/rfc822;charset=utf-8'});
    const url=win.URL.createObjectURL(blob),link=doc.createElement('a');
    link.href=url;link.download=safe.filename;
    doc.body.append(link);link.click();link.remove();
    setTimeout(()=>win.URL.revokeObjectURL(url),10000);
    setStatus(previewMode()
      ?'Borrador de prueba descargado. Puedes abrirlo en Outlook; no contiene destinatarios reales.'
      :'Borrador descargado. Ábrelo en Outlook, verifica los destinatarios y envíalo manualmente.');
  }
  el('Generate').addEventListener('click',()=>void generate(false));
  el('ViewTop').addEventListener('click',()=>{
    if(!currentDraft){void generate(!select.value);return;}
    renderDraft();result.scrollIntoView?.({behavior:'smooth',block:'start'});
  });
  el('Example').addEventListener('click',()=>void generate(true));
  el('View').addEventListener('click',()=>{if(currentDraft){renderDraft();result.scrollIntoView?.({behavior:'smooth',block:'nearest'});}});
  el('Outlook').addEventListener('click',download);
  el('Mark').addEventListener('click',()=>{void markSent();});
  async function markSent(){
    if(!currentDraft||currentDraft.sent||busy||!context().mailAccess)return;
    if(previewMode()){
      currentDraft.sent=true;
      renderDraft();
      setStatus('Envío simulado correctamente. No se ha registrado ni enviado un correo real.');
      return;
    }
    if(!win.confirm('Confirma solo si ya enviaste este correo desde Outlook. ¿Lo enviaste realmente?'))return;
    const actor=context().id,epoch=generationEpoch,draft=currentDraft;
    busy=true;renderRows();renderDraft();setStatus('Registrando confirmación de envío…');
    try{
      const response=await repository.requirementsMail('confirmar',draft.row.id,draft.mail.subject);
      if(actor!==context().id||epoch!==generationEpoch||currentDraft!==draft||!context().mailAccess)return;
      if(response?.estado!=='ENVIADO')throw Error('El envío no quedó confirmado en el aplicativo.');
      draft.sent=true;
      setStatus(response.ya_registrado
        ?'Este envío ya estaba registrado. No se creó un duplicado.'
        :'Correo registrado como enviado manualmente. Esto no acredita la recepción del destinatario.');
    }catch(error){
      if(actor===context().id&&epoch===generationEpoch)setStatus(error?.message||'No se pudo confirmar el envío.',true);
    }finally{busy=false;renderRows();renderDraft();}
  }
  select.addEventListener('change',()=>{
    generationEpoch++;selectedId=select.value;currentDraft=null;result.hidden=true;setStatus('');
    if(previewMode()&&select.value)void generate(false,{scroll:false});
  });
  async function selectRequest(id,{generate:autoGenerate=false}={}){
    if(!available().some(row=>row.id===id)||!context().mailAccess)return;
    generationEpoch++;selectedId=id;currentDraft=null;result.hidden=true;setStatus('');
    renderRows();root.scrollIntoView?.({behavior:'smooth',block:'start'});
    if(autoGenerate)await generate();
  }
  return {
    update(records,detail){
      if(userId!==context().id){generationEpoch++;userId=context().id;selectedId='';currentDraft=null;result.hidden=true;setStatus('');previewAutoloaded=false;}
      rows=records;tracking=detail;
      root.hidden=!context().mailAccess;
      if(!root.hidden){
        renderMode();renderRows();renderDraft();
        if(previewMode()&&!previewAutoloaded){
          previewAutoloaded=true;
          void generate(!select.value,{scroll:false});
        }
      }
    },
    selectRequest
  };
}
