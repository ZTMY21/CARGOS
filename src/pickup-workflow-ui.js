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
  const viewFilters=el('pickupViewFilters'),pdfDialog=el('pickupPdfViewDialog');
  let viewFilter='TODOS',showAllAvisos=false,pdfObjectUrl=null;
  function releasePdf(){
    el('pickupPdfFrame')?.removeAttribute('src');
    if(pdfObjectUrl){URL.revokeObjectURL(pdfObjectUrl);pdfObjectUrl=null;}
    pdfDialog?.classList.remove('pickup-pdf-expanded');
    if(el('pickupPdfZoom'))el('pickupPdfZoom').textContent='Ampliar vista';
  }
  if(pdfDialog){
    el('pickupPdfClose')?.addEventListener('click',()=>pdfDialog.close());
    pdfDialog.addEventListener('close',releasePdf);
    el('pickupPdfZoom')?.addEventListener('click',()=>{
      const big=pdfDialog.classList.toggle('pickup-pdf-expanded');
      el('pickupPdfZoom').textContent=big?'Reducir vista':'Ampliar vista';
    });
  }
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
    const status=create('p',null,'hint');status.setAttribute('aria-live','polite');
    const actions=create('div',null,'actions pickup-footer');
    const submit=create('button','Confirmar recojo','pickup-primary');submit.type='submit';
    const cancel=button('Cancelar',close);
    actions.append(cancel,submit);
    form.append(create('h4','Confirmar retiro físico · '+reference(batch)),dateLabel,create('h4','¿Qué se llevaron?'),
      groups,partialLabel,list,fileLabel,create('p','1–2 páginas · Recomendado hasta 2 MB · Máximo 5 MB','hint'),checked,status,actions);
    if(state.simulation)fileLabel.after(create('p','Usa el PDF ficticio disponible al comienzo de la vista previa.','hint'));
    const log=create('section',null,'pickup-stage-card');
    log.append(create('h4','Historial de recojos'),create('p',state.simulation?
      'Sustentos del ensayo disponibles en esta sesión.':'Sustentos guardados en 01_Escaneados.','hint'));
    renderVisits(log,state.batches);
    grid.append(form,log);
    const visitId=crypto.randomUUID();
    form.onsubmit=event=>{
      event.preventDefault();
      if(busy||!active)return;
      void act(async()=>{
        const fields=[...form.elements];
        const preventClose=event=>event.preventDefault();
        dialog.addEventListener('cancel',preventClose);
        for(const field of fields)field.disabled=true;
        status.textContent='Guardando el PDF y registrando el recojo…';
        try{
          const codes=partial.checked?[...list.querySelectorAll(':checked')].map(input=>input.value):
            pending.filter(box=>groupInputs.some(input=>input.checked&&input.value===box.type)).map(box=>box.code);
          const result=await workflow.confirm(batch.id,{visitId,codes,date:date.value,file:file.files[0]});
          close();notify(result?.verified?'Recojo confirmado · Sincronizado.':'Recojo confirmado · Sincronización pendiente.');
        }catch(error){
          const current=await workflow.state().catch(()=>null);
          const saved=current?.batches.find(item=>item.id===batch.id)?.visits.find(visit=>visit.id===visitId);
          if(saved){
            close();notify(saved.synced?'Recojo confirmado · Sincronizado.':'Recojo confirmado · Sincronización pendiente.');
          }else status.textContent=error.message||'No se pudo confirmar el recojo. Reintenta.';
        }finally{
          dialog.removeEventListener('cancel',preventClose);
          for(const field of fields)field.disabled=false;
        }
      });
    };
    dialog.append(grid);
  }

  // Proyección visual por tipo; jamás modifica el aviso ni sus funciones operativas.
  const boxesOf=(batch,type)=>batch.boxes.filter(box=>box.type===type);
  const visitsOf=(batch,type)=>{
    const codes=new Set(boxesOf(batch,type).map(box=>box.code));
    return batch.visits.filter(visit=>visit.codes.some(code=>codes.has(code)));
  };
  function typeProgress(batch,type){
    const boxes=boxesOf(batch,type),withdrawn=new Set(batch.visits.flatMap(visit=>visit.codes));
    const done=boxes.filter(box=>withdrawn.has(box.code)).length;
    if(batch.status==='CONFIRMADO'){
      if(done===boxes.length)return {label:'Recojo confirmado',kind:'done',priority:3,done};
      if(done>0)return {label:'Recojo parcial',kind:'programmed',priority:1,done};
      if(batch.schedule?.[type])return {label:'Recojo programado',kind:'programmed',priority:1,done};
      return {label:'Retiro pendiente',kind:'pending',priority:0,done};
    }
    if(batch.status==='PREPARADO')return {label:'Correo generado',kind:'pending',priority:0,done};
    if(batch.status==='CANCELADO')return {label:'Cancelado',kind:'pending',priority:2,done};
    return {label:'Borrador',kind:'pending',priority:0,done};
  }
  function filterMatches(batch,term,key){
    return !term||reference(batch).toLowerCase().includes(term)||
      Boolean(key&&batch.boxes.some(box=>pickupBoxKey(box.code).includes(key)))||
      batch.boxes.some(box=>box.code.toLowerCase().includes(term));
  }
  function detailOf(batch,type){
    open('Detalle del aviso '+reference(batch)+' · '+groupNames[type]);
    const progress=typeProgress(batch,type);
    const grid=create('div',null,'pickup-columns');
    const info=create('section',null,'pickup-stage-card');
    info.append(create('h4',groupNames[type]+' · '+boxesOf(batch,type).length+' cajas'),
      create('p','Estado: '+progress.label,'hint'),
      create('p','Fecha programada: '+(batch.schedule?.[type]?displayDate(batch.schedule[type]):'No registrada'),'hint'),
      create('p','Retiradas: '+progress.done+' de '+boxesOf(batch,type).length,'hint'));
    const proofs=visitsOf(batch,type);
    for(const visit of proofs){
      const row=create('p',displayDate(visit.date)+' · '+visit.codes.filter(code=>boxesOf(batch,type).some(box=>box.code===code)).length+
        ' cajas · PDF '+(visit.synced?'sincronizado':'pendiente'),'hint');
      info.append(row,button('Ver PDF',()=>{void showPdf(batch,visit);}));
    }
    if(!proofs.length)info.append(create('p','No hay constancia PDF registrada todavía para este tipo de cajas.','hint'));
    const codes=create('section',null,'pickup-stage-card');
    codes.append(create('h4','Códigos del aviso · '+boxesOf(batch,type).length));
    const list=create('ul',null,'pickup-detail-codes');
    for(const box of boxesOf(batch,type))list.append(create('li',box.code));
    codes.append(list);grid.append(info,codes);
    dialog.append(grid,button('Cerrar detalle',close));
  }
  function showScheduleHistory(batch,type){
    open('Historial de programación · '+reference(batch)+' · '+groupNames[type]);
    const events=(batch.events||[]).filter(event=>
      event.next?.[type]||event.previous?.[type]);
    if(!events.length)dialog.append(create('p','Todavía no hay cambios de programación registrados para este tipo de cajas.','hint'));
    for(const event of events){
      const card=create('section',null,'pickup-stage-card');
      const date=event.date?new Date(event.date).toLocaleString('es-PE',{timeZone:'America/Lima'}):'Sin fecha';
      card.append(create('h4',event.previous?.[type]?'Reprogramación':'Programación inicial'),
        create('p','Registrado: '+date,'hint'),
        create('p','Fecha anterior: '+(event.previous?.[type]?displayDate(event.previous[type]):'Sin registrar'),'hint'),
        create('p','Fecha registrada: '+(event.next?.[type]?displayDate(event.next[type]):'Sin registrar'),'hint'));
      if(event.actor)card.append(create('p','Responsable: '+event.actor,'hint'));
      dialog.append(card);
    }
    dialog.append(button('Cerrar',close));
  }
  function showEmailRecords(){
    open('Ver correos registrados');
    const batches=[...state.batches].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    if(!batches.length)dialog.append(create('p','No existen correos registrados.','hint'));
    for(const batch of batches){
      const card=create('section',null,'pickup-stage-card');
      const status=batch.status==='CONFIRMADO'?'Correo enviado':batch.status==='PREPARADO'?'Correo generado':'Borrador';
      card.append(create('h4',reference(batch)+' · '+countsLabel(batch.boxes)),
        create('p','Estado: '+status,'hint'),
        create('p','Asunto: '+(batch.subject||'Solicitud de recojo'),'hint'));
      if(!batch.external_mail)card.append(button('Ver correo generado',()=>{
        close();void act(()=>showMail(batch,'preview'));
      },busy));
      else card.append(create('p','Solicitud enviada fuera del aplicativo.','hint'));
      dialog.append(card);
    }
    dialog.append(button('Cerrar',close));
  }
  async function showPdf(batch,visit){
    if(!pdfDialog)return;
    const title=reference(batch)+' · '+displayDate(visit.date);
    el('pickupPdfViewTitle').textContent='Vista previa del PDF · '+title;
    el('pickupPdfMeta').textContent='Sustento del recojo · '+countsLabel(batch.boxes.filter(box=>
      visit.codes.includes(box.code)))+' · '+(visit.name||'PDF firmado');
    try{
      const pdf=await workflow.pdf(batch.id,visit.id);
      if(!pdf)throw Error('No se pudo abrir el archivo PDF.');
      releasePdf();
      let previewUrl,originalUrl;
      if(typeof pdf==='string'){
        const parsed=new URL(pdf);
        if(parsed.protocol!=='https:')throw Error('El enlace del sustento no es seguro.');
        originalUrl=pdf;
        const drive=pdf.match(/^https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/view/);
        previewUrl=drive?'https://drive.google.com/file/d/'+drive[1]+'/preview':pdf;
      }else{
        const blob=pdf.type==='application/pdf'?pdf:new Blob([pdf],{type:'application/pdf'});
        pdfObjectUrl=URL.createObjectURL(blob);
        previewUrl=pdfObjectUrl;
        originalUrl=pdfObjectUrl;
      }
      const openLink=el('pickupPdfOpen'),downLink=el('pickupPdfDownload');
      openLink.href=originalUrl;downLink.href=originalUrl;
      downLink.download=visit.name||'sustento_recojo.pdf';
      el('pickupPdfFrame').src=previewUrl;
      if(typeof pdfDialog.showModal==='function'){
        if(!pdfDialog.open)pdfDialog.showModal();
      }else pdfDialog.setAttribute('open','');
    }catch(error){notify(error.message||'No se pudo mostrar el PDF.',true);}
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
    const term=search.value.trim().toLowerCase(),key=pickupBoxKey(search.value);
    const visibleBatches=state.batches.filter(batch=>filterMatches(batch,term,key));
    const cards=visibleBatches.flatMap(batch=>pickupGroups.filter(type=>boxesOf(batch,type).length)
      .map(type=>({batch,type,progress:typeProgress(batch,type)})))
      .filter(item=>viewFilter==='TODOS'||item.type===viewFilter||
        viewFilter==='PROGRAMADOS'&&item.progress.kind==='programmed');
    cards.sort((a,b)=>a.progress.priority-b.progress.priority||
      new Date(b.batch.created_at)-new Date(a.batch.created_at)||
      pickupGroups.indexOf(a.type)-pickupGroups.indexOf(b.type));
    if(viewFilters){
      viewFilters.replaceChildren(...[['TODOS','Todos'],['NUEVAS','Nuevas'],['DEVOLUCION','Devolución'],
        ['PROGRAMADOS','Programados']].map(([value,label])=>{
        const filter=button(label,()=>{viewFilter=value;showAllAvisos=false;render();});
        filter.setAttribute('aria-pressed',String(viewFilter===value));
        return filter;
      }));
    }
    const limited=showAllAvisos?cards:cards.slice(0,5);
    for(const {batch,type,progress} of limited){
      const article=create('article',null,'prepared-im-box pickup-card-'+progress.kind);
      const heading=create('div',null,'pickup-stage-heading');
      heading.append(create('strong',reference(batch)+' · '+boxesOf(batch,type).length+' '+names[type].toLowerCase()),
        create('span',progress.label,'pickup-badge '+
          (progress.kind==='done'?'pickup-done':progress.kind==='pending'?'pickup-pending':'pickup-programmed')));
      article.append(heading);
      article.append(create('p','Programación: '+(batch.schedule?.[type]?displayDate(batch.schedule[type]):'Sin fecha')+
        ' · Recojo físico: '+(visitsOf(batch,type).length?visitsOf(batch,type).map(visit=>displayDate(visit.date)).join(', '):'Pendiente'),'pickup-card-meta'));
      const note=batch.status==='CONFIRMADO'?'Correo registrado como enviado':
        batch.status==='PREPARADO'?'Correo preparado para Outlook':'Estado del correo: '+batch.status.toLowerCase();
      article.append(create('p',note+' · '+progress.done+' / '+boxesOf(batch,type).length+' cajas retiradas','pickup-card-status'));
      const actions=create('div',null,'actions');
      actions.append(button('Ver detalle',()=>detailOf(batch,type),busy));
      if(batch.external_mail)article.append(create('p','Solicitud enviada fuera del aplicativo.','hint'));
      else actions.append(button('Ver correo generado',()=>act(()=>showMail(batch,'preview')),busy));
      if(batch.workflow===false&&batch.status!=='CANCELADO'&&batch.status!=='CONFIRMADO'&&type===pickupGroups.find(x=>boxesOf(batch,x).length))
        actions.append(button('Abrir borrador',()=>act(()=>showMail(batch,'download')),busy));
      const primary=type===pickupGroups.find(x=>boxesOf(batch,x).length);
      if(primary&&batch.status==='PREPARADO')actions.append(button(state.simulation?'Simular correo enviado':'Registrar correo enviado',()=>act(async()=>{
        if(state.simulation||confirm('¿Ya enviaste este correo desde Outlook?'))await workflow.mark(batch.id,'CONFIRMADO');
      }),busy));
      if(primary&&batch.workflow!==false&&['PREPARADO','PENDIENTE'].includes(batch.status))
        actions.append(button('Cancelar aviso',()=>act(async()=>{
          if(confirm('¿Cancelar el aviso y liberar las cajas?'))await workflow.mark(batch.id,'CANCELADO');
        }),busy));
      if(batch.workflow!==false&&batch.status==='CONFIRMADO'&&progress.done<boxesOf(batch,type).length){
        actions.append(button(batch.schedule?.[type]?'Reprogramar':'Registrar fecha de recojo',
          ()=>schedule(batch),busy));
        if(boxesOf(batch,type).some(box=>batch.schedule?.[type]&&
          !batch.visits.some(visit=>visit.codes.includes(box.code))))
          actions.append(button('Adjuntar sustento PDF',()=>pickup(batch),busy));
      }
      for(const visit of visitsOf(batch,type))
        actions.append(button('Ver PDF',()=>{void showPdf(batch,visit);},busy));
      actions.append(button('Historial de programación',()=>showScheduleHistory(batch,type),busy));
      article.append(actions);
      history.append(article);
    }
    if(cards.length>5){
      const more=button(showAllAvisos?'Ver menos avisos':'Ver más avisos ('+(cards.length-5)+')',
        ()=>{showAllAvisos=!showAllAvisos;render();});
      more.classList.add('pickup-more-button');
      history.append(more);
    }
    if(!cards.length)history.textContent=term?'Sin avisos para esa búsqueda.':'Sin correos preparados.';
    const log=el('pickupVisitHistory');
    log.hidden=false;
    log.replaceChildren(create('h4','Historial de sustentos'));
    renderVisits(log,visibleBatches);
    for(const file of workflow.excel?.()||[]){
      log.append(button('Descargar '+file.name,()=>{
        const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));
        download(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),file.name);
      },busy));
    }
  }
  function renderVisits(target,batches){
    const pairs=batches.flatMap(batch=>batch.visits.map(visit=>({batch,visit})))
      .sort((a,b)=>String(b.visit.date).localeCompare(String(a.visit.date)));
    if(!pairs.length){
      target.append(create('p','Aún no hay retiros confirmados.','hint pickup-history-empty'));
      return;
    }
    for(const {batch,visit} of pairs){
      const row=create('article',null,'pickup-visit');
      const item=create('details');
      item.open=expanded.has(visit.id);
      item.ontoggle=()=>{if(item.open)expanded.add(visit.id);else expanded.delete(visit.id);};
      const taken=batch.boxes.filter(box=>visit.codes.includes(box.code));
      item.append(create('summary',reference(batch)+' · '+displayDate(visit.date)+' · '+countsLabel(taken)));
      item.append(create('small','PDF de sustento · '+(visit.synced?'Sincronizado':'Sincronización pendiente')));
      item.append(create('p',visit.codes.join(', '),'hint'),
        create('p','Confirmó '+visit.actor,'hint'),
        create('p','Registro en Excel: '+(visit.synced?'Sincronizado':'Pendiente de sincronización'),'hint'));
      if(!state.simulation)item.append(create('p',
        'Maestro: '+(visit.master?'verificado':'pendiente')+
        ' · Registro de envíos: '+(visit.history?'verificado':'pendiente'),'hint'));
      if(visit.error)item.append(create('p',visit.error,'hint'));
      const actions=create('div',null,'pickup-file-actions');
      const pdfButton=button('Ver PDF',()=>{void showPdf(batch,visit);},busy);
      pdfButton.classList.add('pickup-done');
      actions.append(pdfButton);
      if(!visit.synced)actions.append(button('Reintentar sincronización',()=>act(async()=>{
        const result=await workflow.retry(batch.id,visit.id);
        notify(result?.verified?'Recojo confirmado · Sincronizado.':'Recojo confirmado · Sincronización pendiente.');
      }),busy));
      row.append(item,actions);
      target.append(row);
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
  el('pickupViewEmails')?.addEventListener('click',showEmailRecords);
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
