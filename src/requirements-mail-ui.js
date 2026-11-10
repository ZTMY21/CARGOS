import {REQ_TYPES} from './rules.js';
import {composeRequirementsMail} from './requirements-mail-template.js';

// Preview aislada: solo lecturas de solicitudes y de la configuración del Aviso de recojo.
// Descargar un EML de prueba no prepara ni envía correo real.
export function setupRequirementsMail(root,{repository,context}){
  let rows=[],tracking=null,selectedId='',currentDraft=null,busy=false,userId=null;
  const example={
    id:'ejemplo-sin-guardar',numero:'EJEMPLO-100',tipo:REQ_TYPES[0],
    cantidadCajas:100,fechaSolicitud:'2026-11-10',usuario:'Personal de CD Santa Anita'
  };
  root.innerHTML=
    '<section class="req4-mail-panel" aria-labelledby="req4MailTitle">'+
    '<div class="req4-mail-heading"><div class="req4-mail-icon" aria-hidden="true">✉</div>'+
    '<div><h3 id="req4MailTitle">Correo de solicitud de cajas</h3>'+
    '<p>Prepara el mensaje con los destinatarios y la firma del Aviso de recojo. Sin Excel ni adjuntos.</p></div>'+
    '<span class="req4-mail-preview-badge">PREVIEW</span></div>'+
    '<div class="req4-mail-controls">'+
    '<label for="req4MailSelect">Solicitud registrada<select id="req4MailSelect"></select></label>'+
    '<div class="req4-mail-buttons"><button id="req4MailGenerate" type="button">Generar correo de solicitud</button>'+
    '<button id="req4MailExample" class="secondary" type="button">Simular con 100 cajas</button></div></div>'+
    '<p class="req4-mail-info">La vista previa permite revisar el mensaje y descargar un borrador de prueba para Outlook con destinatarios ficticios. No registra ni envía correos.</p>'+
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
    '<p class="req4-mail-info">No se adjunta ningún Excel. El borrador de prueba utiliza direcciones ficticias para evitar envíos involuntarios.</p>'+
    '<div class="req4-mail-footer"><button id="req4MailView" type="button" class="secondary">Ver correo generado</button>'+
    '<button id="req4MailOutlook" type="button">Descargar borrador de prueba para Outlook</button>'+
    '<button id="req4MailMark" type="button" class="secondary">Simular correo enviado</button></div>'+
    '</div></section>';
  const el=name=>root.querySelector('#req4Mail'+name);
  const select=el('Select'),status=el('Status'),result=el('Result');
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
      const option=document.createElement('option');
      option.value='';option.textContent='Sin solicitudes registradas · Usa la simulación';
      select.append(option);
      select.disabled=true;
    }else{
      for(const row of options){
        const option=document.createElement('option');
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
    el('Example').disabled=busy;
  }
  const requestBoxes=row=>(tracking?.cajas||[]).filter(box=>box.requerimiento===row.id)
    .map(box=>({codigo:box.codigo,cargos:box.cargos}));
  function renderDraft(){
    result.hidden=!currentDraft;
    if(!currentDraft)return;
    const {mail,simulation,sent}=currentDraft;
    el('From').textContent=mail.from;
    el('To').textContent=mail.to.join('; ');
    el('Cc').textContent=mail.cc.join('; ')||'—';
    el('Subject').textContent=mail.subject;
    el('Body').textContent=mail.text;
    el('Badge').textContent=sent?'Envío simulado':simulation?'Simulación · no enviado':'No enviado';
    el('Mark').disabled=sent;
  }
  async function generate(sample=false){
    if(!context().mailAccess||busy)return;
    const row=sample?example:available().find(r=>r.id===select.value);
    if(!row){setStatus('Selecciona una solicitud registrada.',true);return;}
    const boxes=sample?[]:requestBoxes(row);
    busy=true;renderRows();setStatus('Recuperando destinatarios y preparando el correo…');
    try{
      // Misma fuente que Avisos de recojo. No se cambia su configuración.
      const config=await repository.pickupMailConfig();
      if(!context().mailAccess) return;
      if(!config||!config.sender||!Array.isArray(config.to)||!config.to.length)
        throw Error('No hay destinatarios o remitente configurados en Aviso de recojo.');
      const mail=composeRequirementsMail(row,boxes,config,{simulation:false});
      currentDraft={row,boxes,config,mail,simulation:sample,sent:false};
      renderDraft();
      setStatus('Correo preparado para revisión. No se ha enviado ni guardado ningún correo.');
      result.scrollIntoView?.({behavior:'smooth',block:'nearest'});
    }catch(error){
      if(!sample){
        currentDraft=null;renderDraft();
        setStatus(error?.message||'No se pudo generar el correo.',true);
      }else{
        const fallback={sender:'remitente@example.invalid',to:['destinatario@example.invalid'],
          cc:[],name:'Remitente de prueba',company:'Farmacias Peruanas'};
        const mail=composeRequirementsMail(example,[],fallback,{simulation:true});
        currentDraft={row:example,boxes:[],config:fallback,mail,simulation:true,sent:false};
        renderDraft();
        setStatus('Simulación con datos ficticios. No se pudo recuperar la configuración real de Aviso de recojo.');
      }
    }finally{busy=false;renderRows();}
  }
  function download(){
    if(!context().mailAccess||!currentDraft)return;
    // Siempre EML ficticio en la preview, incluso cuando la vista muestra destinatarios reales.
    const safe=composeRequirementsMail(currentDraft.row,currentDraft.boxes,currentDraft.config,{simulation:true});
    const blob=new Blob([safe.eml],{type:'message/rfc822;charset=utf-8'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=safe.filename;
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    setStatus('Borrador de prueba descargado. Puedes abrirlo en Outlook; no contiene destinatarios reales.');
  }
  el('Generate').addEventListener('click',()=>void generate(false));
  el('Example').addEventListener('click',()=>void generate(true));
  el('View').addEventListener('click',()=>{if(currentDraft){renderDraft();result.scrollIntoView?.({behavior:'smooth',block:'nearest'});}});
  el('Outlook').addEventListener('click',download);
  el('Mark').addEventListener('click',()=>{
    if(!currentDraft||!context().mailAccess)return;
    currentDraft.sent=true;
    renderDraft();
    setStatus('Envío simulado correctamente. No se ha registrado ni enviado un correo real.');
  });
  select.addEventListener('change',()=>{selectedId=select.value;currentDraft=null;result.hidden=true;setStatus('');});
  return {
    update(records,detail){
      if(userId!==context().id){userId=context().id;selectedId='';currentDraft=null;result.hidden=true;setStatus('');}
      rows=records;tracking=detail;
      root.hidden=!context().mailAccess;
      if(!root.hidden)renderRows();
    }
  };
}
