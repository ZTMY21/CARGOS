import {pickupBoxKey,pickupDate,pickupGroups} from '../server/pickup-workbook.js';

const names={NUEVAS:'Nuevas',DEVOLUCION:'Devolución'};
const groupNames={NUEVAS:'Cajas nuevas',DEVOLUCION:'Cajas para devolución'};
const displayDate=date=>String(date||'').split('-').reverse().join('/');
const countType=(boxes,type)=>boxes.filter(box=>box.type===type).length;
const countsLabel=boxes=>pickupGroups.filter(type=>countType(boxes,type))
  .map(type=>countType(boxes,type)+' '+names[type].toLowerCase()).join(' + ');
const reference=batch=>'AV-'+batch.id.slice(0,8).toUpperCase();
const create=(tag,text,className)=>{
  const node=document.createElement(tag);
  if(text)node.textContent=text;
  if(className)node.className=className;
  return node;
};
const button=(label,action,disabled=false)=>{
  const node=create('button',label,'secondary');
  node.type='button';node.disabled=disabled;
  node.addEventListener('click',action);
  return node;
};
function download(blob,name){
  const url=URL.createObjectURL(blob);
  const a=create('a');a.href=url;a.download=name;
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}

export function attachPickupWorkflow({workflow,showPreview,notify}){
  const el=id=>document.getElementById(id);
  const panel=el('pickupSelections'),history=el('pickupMailBatches'),search=el('pickupHistorySearch');
  const dialog=el('pickupDialog'),prepare=el('pickupPrepare'),draftCard=el('pickupDraftCard');
  const selectionSummary=el('pickupSelectionSummary');
  const register=el('pickupRegisterSent');
  const chosen=new Set(),expanded=new Set();
  let state={available:[],batches:[]},active=false,busy=false,requestId,requestKeys,draftId,loaded=false,loading=false,sourcePending=false;
  async function refresh(){
    if(!active)return;
    if(loading)return;
    loading=true;
    if(!loaded)render();
    try{
      await readState();
      if(workflow.refreshMaster){
        render();
        try{
          await workflow.refreshMaster();
          await readState();
          sourcePending=false;
        }catch{sourcePending=true;}
      }
    }finally{loading=false;render();}
  }
  async function readState(){
    state=await workflow.state();
    loaded=true;
    const keys=new Set(state.available.map(box=>box.key));
    for(const key of chosen)if(!keys.has(key))chosen.delete(key);
  }
  async function act(task,{refreshAfter=true}={}){
    if(busy||!active)return;
    busy=true;render();
    try{await task();}
    catch(error){notify(error.message||'No se pudo completar la operación.',true);}
    finally{
      busy=false;
      if(refreshAfter){
        try{await refresh();}catch{notify('No se pudo actualizar el seguimiento.',true);}
      }else render();
    }
  }
  function open(title){
    const h=create('h3',title,'iv-panel-title');h.id='pickupDialogTitle';
    dialog.replaceChildren(h);
    if(!dialog.open)dialog.showModal();
  }
  const close=()=>dialog.close();
  function chooser(type){
    open('Seleccionar cajas para un aviso de recojo');
    const intro=create('p','Puedes seleccionar solo nuevas, solo devolución, o ambas en el mismo correo. Máximo 30 por tipo.','hint');
    const grid=create('div',null,'pickup-columns');
    const draft=new Set(chosen);
    const summary=create('p',null,'pickup-callout');
    function updateSummary(){
      const boxes=state.available.filter(box=>draft.has(box.key));
      const types=pickupGroups.filter(group=>countType(boxes,group)).length;
      summary.textContent=boxes.length?'Resumen: '+countsLabel(boxes)+' = '+boxes.length+' cajas · 1 correo · '+types+' Excel':
        'Resumen: selecciona las cajas para el aviso.';
      next.disabled=!boxes.length;
    }
    const next=button('Continuar a un solo correo',()=>{
      chosen.clear();for(const key of draft)chosen.add(key);
      close();render();
    });
    next.classList.add('pickup-primary');
    for(const group of pickupGroups){
      const all=state.available.filter(box=>box.type===group);
      const card=create('section',null,'pickup-stage-card');
      const count=create('span',null,'pickup-badge');
      const top=create('div',null,'pickup-stage-heading');
      top.append(create('h4',groupNames[group]),count);
      const field=create('input');field.type='search';field.placeholder='Buscar código de caja';
      field.setAttribute('aria-label','Buscar código de '+groupNames[group].toLowerCase());
      if(group===type)field.autofocus=true;
      const list=create('div',null,'pickup-list');
      const bulk=create('input');bulk.type='checkbox';
      const bulkLabel=create('label');bulkLabel.append(bulk,document.createTextNode('Seleccionar disponibles (hasta 30)'));
      const filtered=()=>all.filter(box=>{
        const query=field.value.trim().toLowerCase(),key=pickupBoxKey(query);
        return !query||box.code.toLowerCase().includes(query)||(key&&box.key.includes(key));
      });
      const update=()=>{
        const visible=filtered(),selected=all.filter(box=>draft.has(box.key)).length;
        count.textContent=selected+'/30';
        const eligible=visible.slice(0,30);
        bulk.disabled=!eligible.length;
        bulk.checked=eligible.length>0&&eligible.every(box=>draft.has(box.key));
        bulk.indeterminate=!bulk.checked&&visible.some(box=>draft.has(box.key));
        list.replaceChildren(...visible.map(box=>{
          const label=create('label',null,'pickup-box-row');
          const cb=create('input');cb.type='checkbox';cb.checked=draft.has(box.key);
          cb.disabled=selected>=30&&!cb.checked;
          cb.onchange=()=>{
            cb.checked?draft.add(box.key):draft.delete(box.key);
            const total=all.filter(item=>draft.has(item.key)).length;
            count.textContent=total+'/30';
            for(const item of list.querySelectorAll('input'))item.disabled=total>=30&&!item.checked;
            bulk.checked=eligible.length>0&&eligible.every(item=>draft.has(item.key));
            bulk.indeterminate=!bulk.checked&&visible.some(item=>draft.has(item.key));
            updateSummary();
          };
          label.append(cb,create('strong',box.code),create('small','Lista · '+displayDate(box.prepared_at)));
          return label;
        }));
        if(!visible.length)list.textContent='Sin cajas disponibles para esa búsqueda.';
        updateSummary();
      };
      bulk.onchange=()=>{
        let selected=all.filter(box=>draft.has(box.key)).length;
        for(const box of filtered()){
          if(!bulk.checked)draft.delete(box.key);
          else if(selected<30&&!draft.has(box.key)){draft.add(box.key);selected++;}
        }
        update();
      };
      field.oninput=update;
      card.append(top,field,bulkLabel,list);
      grid.append(card);update();
    }
    const bottom=create('div',null,'actions pickup-footer');
    bottom.append(button('Cancelar',close),next);
    dialog.append(intro,grid,summary,bottom);
  }
  async function showMail(batch,action){
    const data=await workflow.mail(action,batch.id);
    if(action==='download'){
      download(data.blob,'recojo_'+batch.id.slice(0,8)+'.eml');
      return;
    }
    renderMail(batch,data);
  }
  function renderMail(batch,data){
    const simulation=Boolean(batch.simulation);
    draftCard.hidden=false;
    draftId=batch.id;
    const status=simulation?'Simulación':batch.status==='CONFIRMADO'?'Correo enviado':batch.status==='CANCELADO'?'Cancelado':'No enviado';
    const header=create('div',null,'pickup-stage-heading');
    const statusBadge=create('span',status,'pickup-badge pickup-wait');
    statusBadge.id='pickupDraftState';
    header.append(create('h3','Borrador de Outlook · Solicitud de recojo','iv-panel-title'),statusBadge);
    const fields=create('dl',null,'pickup-mail-fields');
    for(const [label,value] of [['De',data.from],['Para',data.to.join('; ')],['CC',data.cc?.join('; ')||'—'],['Asunto',data.subject||batch.subject||'Solicitud de recojo']]){
      if(value)fields.append(create('dt',label),create('dd',value));
    }
    draftCard.replaceChildren(header,fields);
    const draftFooter=el('pickupDraftFooter');
    const attachments=create('div',null,'pickup-attachments');
    (data.attachments||[]).forEach((file,index)=>{
      const label='Excel '+(index+1)+' · '+file;
      const bytes=data.attachmentFiles?.[index]?.bytes;
      const item=bytes?button(label,()=>download(new Blob([bytes],{
        type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }),file)):create('span',label,'pickup-badge');
      item.classList.add('pickup-done');
      attachments.append(item);
    });
    const actions=create('div',null,'actions pickup-footer');
    const openDraft=button('Abrir borrador',()=>simulation
      ?download(data.blob,'simulacion-recojo-im.eml'):act(()=>showMail(batch,'download')));
    openDraft.classList.add('pickup-primary');
    actions.append(create('p',simulation?'El EML de prueba usa un destinatario ficticio.':
      'Descarga el EML para revisarlo y enviarlo manualmente en Outlook.','hint'));
    if(batch.status!=='CANCELADO')actions.append(openDraft);
    draftFooter.replaceChildren(attachments,actions);draftFooter.hidden=false;
    const boxes=data.boxDetails||batch.boxes||[];
    if(boxes.length){
      const detail=create('section',null,'pickup-mail-boxes');
      detail.append(create('h4','Cajas incluidas en los Excel · '+boxes.length));
      for(const type of pickupGroups){
        const group=boxes.filter(box=>box.type===type);
        if(!group.length)continue;
        const list=create('ul');
        list.append(...group.map(box=>create('li',box.code,'pickup-badge')));
        detail.append(create('h5',groupNames[type]+' · '+group.length),list);
      }
      draftFooter.append(detail);
    }
    showPreview(data.text,(simulation?'Simulación con cajas ficticias':'Vista previa')+
      ' · Un correo con '+(data.attachments?.length||0)+' Excel adjuntos',
      'Borrador listo para revisar.');
  }
  function schedule(batch){
    const scheduled=Object.values(batch.schedule||{}).some(Boolean);
    open('Correos y seguimiento · '+(scheduled?'Reprogramar recojo':'Registrar programación'));
    const heading=create('div',null,'pickup-stage-heading');
    heading.append(create('h4','Aviso '+reference(batch)+' · '+countsLabel(batch.boxes)),
      create('span',scheduled?'Recojo programado':'Esperando fecha','pickup-badge '+(scheduled?'':'pickup-wait')));
    dialog.append(heading,create('p','Registra las fechas confirmadas por Iron Mountain después de su respuesta por correo.','hint'));
    const form=create('form');
    const inputs={};
    const withdrawn=new Set(batch.visits.flatMap(visit=>visit.codes));
    const types=pickupGroups.filter(type=>batch.boxes.some(box=>box.type===type));
    for(const type of types){
      const card=create('section',null,'pickup-stage-card');
      const label=create('label','Fecha confirmada');
      const field=create('input');field.type='date';field.value=batch.schedule?.[type]||'';
      field.disabled=batch.boxes.filter(box=>box.type===type).every(box=>withdrawn.has(box.code));
      const change=button('Cambiar fecha',()=>{if(field.disabled)return; if(field.showPicker)field.showPicker();else field.focus();},field.disabled);
      const dateRow=create('div',null,'pickup-stage-heading');
      inputs[type]=field;label.append(field);
      dateRow.append(label,change);
      card.append(create('h4',groupNames[type]+' · '+countType(batch.boxes,type)),dateRow);
      form.append(card);
    }
    if(types.length===2&&!Object.values(inputs).some(field=>field.disabled)){
      const label=create('label');const same=create('input');same.type='checkbox';
      const apply=()=>{inputs.DEVOLUCION.disabled=same.checked;
        if(same.checked)inputs.DEVOLUCION.value=inputs.NUEVAS.value;};
      same.onchange=apply;inputs.NUEVAS.oninput=apply;
      label.append(same,document.createTextNode('Ambas se recogerán el mismo día (opcional)'));form.append(label);
    }
    const actions=create('div',null,'actions');
    const submit=create('button','Guardar programación','pickup-primary');submit.type='submit';
    actions.classList.add('pickup-footer');
    actions.append(button('Cancelar',close),submit);
    form.append(create('p','Si Iron Mountain cambia la fecha, usa Reprogramar en el mismo aviso.','pickup-callout'),actions);
    form.onsubmit=event=>{
      event.preventDefault();
      void act(async()=>{
        await workflow.schedule(batch.id,Object.fromEntries(Object.entries(inputs).map(([type,field])=>[type,field.value])));
        close();notify('Programación guardada.');
      });
    };
    dialog.append(form);
  }
  function pickup(batch){
    open('Recojo realizado · Sustento firmado e historial');
    const grid=create('div',null,'pickup-columns');
    const form=create('form',null,'pickup-stage-card');
    const date=create('input');date.type='date';date.required=true;date.max=pickupDate(new Date());
    const dateLabel=create('label','Fecha real del recojo');dateLabel.append(date);
    const file=create('input');file.type='file';file.accept='application/pdf,.pdf';file.required=true;
    const fileLabel=create('label','Adjuntar constancia firmada PDF','pickup-file');fileLabel.append(file);
    const list=create('div',null,'pickup-list');
    const withdrawn=new Set(batch.visits.flatMap(visit=>visit.codes));
    const pending=batch.boxes.filter(box=>batch.schedule?.[box.type]&&!withdrawn.has(box.code));
    const groups=create('div'), groupInputs=[];
    for(const type of pickupGroups){
      const boxes=pending.filter(box=>box.type===type);
      if(!boxes.length)continue;
      const all=create('input');all.type='checkbox';all.value=type;
      const label=create('label');label.append(all,document.createTextNode(boxes.length+' '+groupNames[type].toLowerCase()));
      groups.append(label);groupInputs.push(all);
      for(const box of boxes){
        const row=create('label',null,'pickup-box-row');
        const input=create('input');input.type='checkbox';input.value=box.code;
        row.append(input,create('strong',box.code),create('small',names[box.type]));list.append(row);
      }
    }
    const partial=create('input');partial.type='checkbox';
    const partialLabel=create('label');partialLabel.append(partial,document.createTextNode('Recojo parcial (seleccionar códigos)'));
    list.hidden=true;
    partial.onchange=()=>{list.hidden=!partial.checked;groups.hidden=partial.checked;};
    const verified=create('input');verified.type='checkbox';verified.required=true;
    const checked=create('label');checked.append(verified,document.createTextNode('He verificado cajas y sustento.'));
    const actions=create('div',null,'actions pickup-footer');
    const submit=create('button','Confirmar recojo','pickup-primary');submit.type='submit';
    actions.append(button('Cancelar',close),submit);
    form.append(create('h4','Confirmar retiro físico · '+reference(batch)),dateLabel,create('h4','¿Qué se llevaron?'),
      groups,partialLabel,list,fileLabel,create('p','1–2 páginas · Recomendado hasta 2 MB · Máximo 5 MB','hint'),checked,actions);
    if(state.simulation)fileLabel.after(create('p','Usa el PDF ficticio disponible al comienzo de la vista previa.','hint'));
    const log=create('section',null,'pickup-stage-card');
    log.append(create('h4','Historial de recojos'),create('p',state.simulation?
      'Sustentos del ensayo disponibles en esta sesión.':'Sustentos guardados en 01_Escaneados.','hint'));
    renderVisits(log,state.batches);
    grid.append(form,log);
    const visitId=crypto.randomUUID();
    form.onsubmit=event=>{
      event.preventDefault();submit.disabled=true;
      void act(async()=>{
        try{
          const codes=partial.checked?[...list.querySelectorAll(':checked')].map(input=>input.value):
            pending.filter(box=>groupInputs.some(input=>input.checked&&input.value===box.type)).map(box=>box.code);
          const result=await workflow.confirm(batch.id,{visitId,codes,date:date.value,file:file.files[0]});
          close();notify(result?.verified?'Recojo confirmado · Sincronizado.':'Recojo confirmado · Sincronización pendiente.');
        }catch(error){
          const current=await workflow.state();
          if(current.batches.some(item=>item.id===batch.id&&item.visits.some(visit=>visit.id===visitId)))close();
          throw error;
        }finally{submit.disabled=false;}
      });
    };
    dialog.append(grid);
  }
  function render(){
    panel.hidden=false;search.hidden=!loaded;
    if(!loaded){
      panel.replaceChildren(create('p',loading?'Consultando cajas preparadas…':'No se pudo cargar la bandeja. Pulsa Actualizar.','hint'));
      prepare.disabled=true;
      return;
    }
    panel.replaceChildren(...pickupGroups.map(type=>{
      const row=create('div',null,'pickup-group'),head=create('div',null,'pickup-stage-heading');
      const available=state.available.filter(box=>box.type===type);
      const progress=create('progress');progress.max=30;progress.value=Math.min(30,available.length);
      progress.setAttribute('aria-label',groupNames[type]+' listas para este aviso');
      head.append(create('strong',groupNames[type]),create('span','Máx. 30','pickup-badge'));
      const controls=create('div',null,'pickup-group-controls');
      const info=create('div');
      info.append(create('p',Math.min(available.length,30)+' / 30 listas','pickup-counter'),progress);
      if(available.length>30)info.append(create('small',available.length+' disponibles en total','hint'));
      const select=button('Seleccionar',()=>chooser(type),busy||!available.length);
      select.setAttribute('aria-label','Seleccionar '+groupNames[type].toLowerCase());
      controls.append(info,select);
      row.append(head,controls);
      return row;
    }));
    if(sourcePending)panel.append(create('p','Se muestran las cajas del último corte verificado del Maestro. Usa Actualizar para volver a consultar Drive.','hint'));
    const selected=state.available.filter(box=>chosen.has(box.key));
    const attachments=pickupGroups.filter(type=>countType(selected,type)).length;
    selectionSummary.hidden=false;
    selectionSummary.textContent=selected.length?'Seleccionadas: '+countsLabel(selected):'Seleccionadas: 0 cajas';
    prepare.disabled=busy||!selected.length;
    if(register){
      register.hidden=!workflow.registerSent;
      register.disabled=busy||!selected.length;
    }
    prepare.classList.add('pickup-primary');
    prepare.textContent=attachments?'Generar 1 correo · '+attachments+' Excel '+(attachments===1?'adjunto':'adjuntos'):'Generar correo';
    const draftStatus=state.batches.find(batch=>batch.id===draftId)?.status;
    const draftBadge=el('pickupDraftState');
    if(draftBadge&&draftStatus==='CONFIRMADO')draftBadge.textContent='Correo enviado';
    if(draftBadge&&draftStatus==='CANCELADO'){
      draftBadge.textContent='Cancelado';
      el('pickupDraftFooter').hidden=true;
    }
    history.replaceChildren();
    const key=pickupBoxKey(search.value);
    for(const batch of state.batches.filter(item=>!search.value||(key&&item.boxes.some(box=>pickupBoxKey(box.code).includes(key))))){
      const article=create('div',null,'prepared-im-box');
      const withdrawals=batch.visits.reduce((total,visit)=>total+visit.codes.length,0);
      const counts=countsLabel(batch.boxes);
      const label=batch.status==='CONFIRMADO'?(withdrawals===batch.boxes.length?'Recojo confirmado':withdrawals?'Recojo parcial':Object.values(batch.schedule||{}).some(Boolean)?'Recojo programado':'Esperando fecha'):batch.status==='PREPARADO'?'Preparado para Outlook':
        batch.status==='CANCELADO'?'Cancelado':'Borrador';
      const head=create('div',null,'pickup-stage-heading');
      head.append(create('strong',reference(batch)+' · '+counts),
        create('span',label,'pickup-badge '+(label==='Esperando fecha'?'pickup-wait':label==='Recojo confirmado'?'pickup-done':'')));
      article.append(head);
      if(batch.workflow!==false&&batch.status==='CONFIRMADO'){
        article.append(create('p',pickupGroups.filter(type=>batch.boxes.some(box=>box.type===type))
          .map(type=>names[type]+': '+(batch.schedule?.[type]?displayDate(batch.schedule[type]):'Esperando fecha')).join(' · '),'hint'));
        article.append(create('p',withdrawals===batch.boxes.length?'Recojo confirmado':
          withdrawals?'Retiro parcial · '+withdrawals+' de '+batch.boxes.length+' cajas retiradas':'Retiro pendiente','hint'));
      }
      const actions=create('div',null,'actions');
      if(batch.external_mail)article.append(create('p','Solicitud enviada fuera del aplicativo.','hint'));
      else actions.append(button('Ver correo generado',()=>act(()=>showMail(batch,'preview')),busy));
      if(batch.workflow===false&&batch.status!=='CANCELADO'&&batch.status!=='CONFIRMADO')actions.append(button('Abrir borrador',()=>act(()=>showMail(batch,'download')),busy));
      if(batch.status==='PREPARADO')actions.append(button(state.simulation?'Simular correo enviado':'Registrar correo enviado',()=>act(async()=>{
        if(state.simulation||confirm('¿Ya enviaste este correo desde Outlook?'))await workflow.mark(batch.id,'CONFIRMADO');
      }),busy));
      if(batch.workflow!==false&&['PREPARADO','PENDIENTE'].includes(batch.status))actions.append(button('Cancelar aviso',()=>act(async()=>{
        if(confirm('¿Cancelar el aviso y liberar las cajas?'))await workflow.mark(batch.id,'CANCELADO');
      }),busy));
      if(batch.workflow!==false&&batch.status==='CONFIRMADO'&&withdrawals<batch.boxes.length){
        actions.append(button(Object.values(batch.schedule||{}).some(Boolean)?'Reprogramar':'Registrar fecha de recojo',()=>schedule(batch),busy));
        const removed=new Set(batch.visits.flatMap(visit=>visit.codes));
        if(batch.boxes.some(box=>batch.schedule?.[box.type]&&!removed.has(box.code)))
          actions.append(button('Adjuntar sustento PDF',()=>pickup(batch),busy));
      }
      article.append(actions);
      if(batch.events?.length){
        const audit=create('details');audit.append(create('summary','Historial de programación'));
        for(const event of batch.events)audit.append(create('p',event.date+' · '+event.actor+' · '+
          pickupGroups.filter(type=>event.next[type]).map(type=>names[type]+' '+event.next[type]).join(' · '),'hint'));
        article.append(audit);
      }
      history.append(article);
    }
    if(!history.children.length)history.textContent=search.value?'Sin avisos para ese código.':'Sin correos preparados.';
    const log=el('pickupVisitHistory');
    log.hidden=false;
    log.replaceChildren(create('h4','Historial de recojos'));
    renderVisits(log,state.batches.filter(item=>!search.value||(key&&item.boxes.some(box=>pickupBoxKey(box.code).includes(key)))));
    for(const file of workflow.excel?.()||[]){
      log.append(button('Descargar '+file.name,()=>{
        const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));
        download(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),file.name);
      },busy));
    }
  }
  function renderVisits(target,batches){
    if(!batches.some(batch=>batch.visits.length)){
      target.append(create('p','Aún no hay retiros confirmados.','hint'));
      return;
    }
    for(const batch of batches){
      for(const visit of batch.visits){
        const row=create('article',null,'pickup-visit');
        const item=create('details');
        item.open=expanded.has(visit.id);
        item.ontoggle=()=>{if(item.open)expanded.add(visit.id);else expanded.delete(visit.id);};
        item.append(create('summary',reference(batch)+' · '+displayDate(visit.date)+' · '+countsLabel(batch.boxes.filter(box=>visit.codes.includes(box.code)))),
          create('p',visit.codes.join(', '),'hint'),create('p','Confirmó '+visit.actor,'hint'),
          create('p','Registro en Excel: '+(visit.synced?'Sincronizado':'Pendiente de sincronización'),'hint'));
        if(!state.simulation)item.append(create('p',
          'Maestro: '+(visit.master?'verificado':'pendiente')+' · Registro de envíos: '+(visit.history?'verificado':'pendiente'),'hint'));
        if(visit.error)item.append(create('p',visit.error,'hint'));
        const pdfButton=button('Ver PDF',async()=>{
          try{
            const pdf=await workflow.pdf(batch.id,visit.id);
            if(typeof pdf==='string')window.open(pdf,'_blank','noopener,noreferrer');
            else if(pdf)download(pdf,visit.name);
          }catch(error){notify(error.message,true);}
        },busy);
        pdfButton.classList.add('pickup-done');
        row.append(item,pdfButton);
        if(!visit.synced)item.append(button('Reintentar sincronización',()=>act(async()=>{
          const result=await workflow.retry(batch.id,visit.id);
          notify(result?.verified?'Recojo confirmado · Sincronizado.':'Recojo confirmado · Sincronización pendiente.');
        }),busy));
        target.append(row);
      }
    }
  }
  const prepareBatch=(external=false)=>act(async()=>{
    const keys=[...chosen].sort();
    if(!keys.length)return;
    if(external&&!confirm('¿Ya se solicitó por correo el recojo de estas cajas? Se registrarán para seguimiento.'))return;
    const fingerprint=external+'|'+keys.join(',');
    if(requestKeys!==fingerprint){requestId=crypto.randomUUID();requestKeys=fingerprint;}
    const batch=external ? await workflow.registerSent({keys,requestId})
      : await workflow.prepare({keys,requestId});
    requestId=requestKeys=undefined;
    chosen.clear();
    if(external)notify('Solicitud registrada. En Correos y seguimiento puedes registrar la fecha de recojo.');
    else await showMail(batch,'preview');
  });
  register?.addEventListener('click',()=>prepareBatch(true));
  search.oninput=render;
  return {async activate(){active=true;await refresh();},deactivate(){active=false;},
    reset(){active=false;loaded=false;state={available:[],batches:[]};chosen.clear();expanded.clear();search.value='';if(dialog.open)close();},
    refresh,prepare:()=>prepareBatch(),
    simulate(){
      if(workflow.sample)return act(async()=>renderMail({simulation:true},await workflow.sample()),{refreshAfter:false});
      if(!state.simulation||busy||!loaded)return;
      if(!chosen.size){
        for(const type of pickupGroups){
          for(const box of state.available.filter(box=>box.type===type).slice(0,30))chosen.add(box.key);
        }
      }
      if(chosen.size)return prepareBatch();
      notify('Selecciona un aviso de prueba en Correos y seguimiento.');
    }};
}
