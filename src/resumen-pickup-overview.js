// Consulta visual, solo lectura, del seguimiento de avisos y recojos dentro de Resumen.
const names={NUEVAS:'Cajas nuevas',DEVOLUCION:'Cajas por devolución'};
const fmt=n=>Number.isFinite(n)?new Intl.NumberFormat('es-PE').format(n):'—';
function dateLima(value){
  if(!value)return 'Sin fecha programada';
  const raw=String(value);
  if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw.slice(8,10)+'/'+raw.slice(5,7)+'/'+raw.slice(0,4);
  const d=new Date(raw);
  return Number.isNaN(d.valueOf())?'Sin fecha programada':
    new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',dateStyle:'medium'}).format(d);
}
const cleanCode=value=>String(value??'').trim().toUpperCase().replace(/^[A-Z\s]+/,'').replace(/\D/g,'').replace(/^0+(?=\d)/,'');
const el=(tag,cls,text)=>{
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined)node.textContent=String(text);
  return node;
};
const uniqueBoxes=boxes=>new Set(boxes.map(row=>cleanCode(typeof row==='string'?row:row?.code)).filter(Boolean)).size;
function gather(state,type){
  if(!state || !Array.isArray(state.available)||!Array.isArray(state.batches))
    return {available:null,scheduled:null,withdrawn:null,unprogrammed:null,unsynced:null,events:[]};
  const available=state.available.filter(box=>box.type===type);
  const scheduleCodes=new Set(),removedCodes=new Set(),pendingCodes=new Set(),syncPendingCodes=new Set();
  const events=[];
  for(const batch of state.batches){
    if(!batch||batch.status==='CANCELADO')continue;
    const batchBoxes=Array.isArray(batch.boxes)?batch.boxes.filter(box=>box.type===type):[];
    if(!batchBoxes.length)continue;
    const withdrawn=new Map();
    for(const visit of Array.isArray(batch.visits)?batch.visits:[]){
      for(const code of Array.isArray(visit.codes)?visit.codes:[]){
        const key=cleanCode(code);
        if(key)withdrawn.set(key,visit);
      }
    }
    const schedule=batch.schedule?.[type]||'';
    for(const box of batchBoxes){
      const code=cleanCode(box.code);
      if(!code)continue;
      const visit=withdrawn.get(code);
      if(visit){
        removedCodes.add(code);
        if(visit.synced!==true)syncPendingCodes.add(code);
      } else if(batch.status==='CONFIRMADO'&&schedule)scheduleCodes.add(code);
      else if(batch.status==='CONFIRMADO')pendingCodes.add(code);
    }
    events.push({reference:'AV-'+String(batch.id||'').slice(0,8).toUpperCase(),
      scheduled:schedule,withdrawn:[...withdrawn.keys()].filter(code=>batchBoxes.some(box=>cleanCode(box.code)===code)).length,
      total:uniqueBoxes(batchBoxes),status:batch.status,
      visits:(Array.isArray(batch.visits)?batch.visits:[]).filter(visit=>
        (visit.codes||[]).some(code=>batchBoxes.some(box=>cleanCode(box.code)===cleanCode(code))))
        .map(visit=>({date:visit.date,codes:(visit.codes||[]).filter(code=>batchBoxes.some(box=>cleanCode(box.code)===cleanCode(code))),
          synced:visit.synced===true}))});
  }
  for(const code of removedCodes){scheduleCodes.delete(code);pendingCodes.delete(code);}
  return {available:uniqueBoxes(available),scheduled:scheduleCodes.size,withdrawn:removedCodes.size,
    unprogrammed:pendingCodes.size,unsynced:syncPendingCodes.size,events};
}
function stat(n,label){
  const box=el('div','summary-pickup-stat');
  box.append(el('strong','',fmt(n)),el('span','',label));
  return box;
}
export function attachResumenPickupOverview({client,allowed,enabled}){
  const id=n=>document.getElementById(n);
  const dialog=el('dialog','summary-detail-dialog summary-pickup-dialog');
  dialog.id='summaryPickupDialog';
  dialog.setAttribute('aria-labelledby','summaryPickupTitle');
  const header=el('div','summary-detail-head');
  const identity=el('div','summary-detail-identity');
  identity.append(el('span','summary-detail-icon','▤'));
  const heading=el('div');
  heading.append(el('h2','', 'Seguimiento de recojo a Iron Mountain'),
    el('p','','Estado de cajas nuevas y cajas por devolución, sin modificar los envíos'));
  identity.append(heading);
  const close=el('button','summary-detail-close','Cerrar');close.type='button';
  close.onclick=()=>dialog.close();
  header.append(identity,close);
  const body=el('div','summary-detail-content');
  dialog.append(header,body);document.body.append(dialog);
  let state=null,legacy=null,status='pending',lastError='',request=null,returnButton=null,selectedType='NUEVAS';
  const summary=type=>status==='ready'?
    enabled?gather(state,type):
      {available:type==='NUEVAS'?Number(legacy?.ready):null,scheduled:null,withdrawn:null,unprogrammed:null,unsynced:null,events:[]}
    :gather(null,type);
  function paint(){
    for(const type of ['NUEVAS','DEVOLUCION']){
      const data=summary(type),suffix=type==='NUEVAS'?'New':'Return';
      for(const [field,node] of [['available','Available'],['scheduled','Scheduled'],['withdrawn','Withdrawn']]){
        const target=id('summaryPickup'+suffix+node);
        if(target)target.textContent=fmt(data[field]);
      }
    }
    const info=id('summaryPickupSourceNote');
    if(info)info.textContent=status==='error'?'Seguimiento no disponible: revisa la conexión.':
      status==='pending'?'Consultando avisos y recojos…':
      enabled?'Fuente: Aviso de recojo · Últimos registros confirmados.':'El seguimiento completo no está habilitado en esta vista previa.';
    if(dialog.open)paintDetail();
  }
  function detailType(type){
    const data=summary(type);
    const intro=el('p','summary-detail-helper',
      'Este panel consulta los avisos existentes. No programa retiros ni confirma envíos.');
    body.append(intro);
    const metrics=el('div','summary-detail-stats');
    metrics.append(stat(data.available,'Disponibles para aviso'),stat(data.scheduled,'Con recojo programado'),
      stat(data.withdrawn,'Retiradas con sustento'));
    body.append(metrics);
    if(status==='error')body.append(el('p','summary-detail-empty','No fue posible consultar los estados de recojo. '+lastError));
    if(status==='pending')body.append(el('p','summary-detail-empty','Consultando la información de avisos de recojo…'));
    if(status==='ready'&&!enabled)body.append(el('p','summary-detail-empty',
      'El desglose de programación y PDF firmado no está disponible en este despliegue. No se presentan cifras estimadas.'));
    if(status!=='ready'||!enabled)return;
    const caption=el('h3','summary-detail-section-title','Avisos registrados · '+names[type]);
    body.append(caption);
    const events=data.events.filter(item=>item.status!=='CANCELADO');
    if(!events.length){
      body.append(el('p','summary-detail-empty','No existen avisos de recojo registrados para este tipo de caja.'));
      return;
    }
    const list=el('div','summary-pickup-history');
    for(const item of events.slice(0,40)){
      const article=el('article','summary-pickup-history-item');
      const top=el('div','summary-pickup-history-head');
      top.append(el('strong','',item.reference+' · '+fmt(item.total)+' cajas'),
        el('span','summary-pickup-state',item.withdrawn>=item.total&&item.total>0?'Retiro registrado':
          item.scheduled?'Programado':item.status==='CONFIRMADO'?'Esperando programación':'Borrador'));
      article.append(top);
      article.append(el('p','',item.scheduled?'Fecha programada: '+dateLima(item.scheduled):
        'Fecha programada: pendiente'));
      if(item.visits.length)for(const visit of item.visits)
        article.append(el('p','',fmt(visit.codes.length)+' cajas retiradas el '+dateLima(visit.date)+
          ' · '+(visit.synced?'Registro sincronizado':'Sincronización pendiente')));
      else article.append(el('p','','Sin retiro físico confirmado'));
      list.append(article);
    }
    body.append(list);
    if(events.length>40)body.append(el('p','summary-detail-helper','Mostrando los 40 avisos más recientes de la consulta.'));
    if(data.unsynced>0)body.append(el('p','summary-detail-empty',fmt(data.unsynced)+
      ' cajas con retiro registrado y sincronización pendiente.'));
  }
  function paintDetail(){
    if(!dialog.open)return;
    body.replaceChildren();
    const tabs=el('div','summary-pickup-tabs');
    for(const type of ['NUEVAS','DEVOLUCION']){
      const tab=el('button',selectedType===type?'active':'',names[type]);
      tab.type='button';
      tab.setAttribute('aria-pressed',String(selectedType===type));
      tab.onclick=()=>{selectedType=type;paintDetail();};
      tabs.append(tab);
    }
    body.append(tabs);
    detailType(selectedType);
  }
  async function refresh(){
    if(!allowed())return;
    if(request)return request;
    status='pending';paint();
    request=(async()=>{
      try{
        const action=enabled?client.rpc('kardex_pickup_workflow',{p_action:'state',p_id:null,p_data:{}})
          :client.rpc('kardex_pickup_mail_state');
        const {data,error}=await action;
        if(error)throw error;
        if(enabled){
          if(!data||!Array.isArray(data.available)||!Array.isArray(data.batches))
            throw Error('El seguimiento no devolvió el estado esperado.');
          state=data;
        }else legacy=data;
        status='ready';lastError='';
      }catch(error){status='error';lastError=String(error?.message||'Consulta no disponible.');}
      finally{request=null;paint();}
    })();
    return request;
  }
  function open(type,button){
    if(!allowed()||!names[type])return;
    selectedType=type;
    returnButton=button||document.activeElement;
    if(!dialog.open)dialog.showModal();
    paintDetail();
    void refresh();
  }
  dialog.addEventListener('close',()=>returnButton?.focus?.());
  return {open,refresh};
}
