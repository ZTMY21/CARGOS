// Vista previa de Resumen: ventanas de consulta de cajas. No modifica otros módulos ni guarda datos.
import {escapeHtml as safe,fmtDate,REQ_TYPES} from './rules.js';
import {physicalBoxKey} from './search.js';
import {boxSupplyRequests,combineBoxPreparationBatches,summarizeBoxPreparationBatch} from './conditioning-batch-summary.js';

const formatNumber=value=>new Intl.NumberFormat('es-PE').format(Number(value)||0);
const numeric=value=>Number.isFinite(Number(value))?Number(value):0;
const dateOnly=value=>{
  if(!value)return 'Fecha no registrada';
  const text=String(value);
  if(/^\d{4}-\d{2}-\d{2}/.test(text))return fmtDate(text.slice(0,10));
  const date=new Date(text);
  return Number.isNaN(date.getTime())?'Fecha no registrada':
    new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit',year:'numeric'}).format(date);
};
const dateTime=value=>{
  if(!value)return 'Fecha y hora no registradas';
  const str=String(value);
  if(/^\d{4}-\d{2}-\d{2}$/.test(str))return dateOnly(str)+' (Lima)';
  const date=new Date(str);
  return Number.isNaN(date.getTime())?'Fecha y hora no registradas':
    new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',dateStyle:'short',timeStyle:'short'}).format(date)+' (Lima)';
};
const requestsOf=state=>boxSupplyRequests(state.requests||[]);
const dateValue=row=>row?.fechaSolicitud||row?.createdAt||'';
const readMovements=(tracking,id)=>(tracking?.movimientos||[]).filter(row=>String(row.requerimiento||'')===String(id||''));
const labelCard=(number,label)=>'<div class="summary-detail-stat"><strong>'+safe(String(number))+'</strong><span>'+safe(label)+'</span></div>';
const eventMarkup=(title,description,stamp,tone,label)=>{
  return '<li class="summary-detail-event '+tone+'"><span class="summary-event-marker" aria-hidden="true"></span>'+
    '<div class="summary-event-copy"><strong>'+safe(title)+'</strong><span>'+safe(description)+'</span></div>'+
    '<span class="summary-event-tag">'+safe(label)+'</span><time>'+safe(stamp)+'</time></li>';
};
function requestMarkup(rows) {
  const requests=boxSupplyRequests(rows||[]);
  const total=requests.reduce((sum,row)=>sum+numeric(row.cantidadCajas),0);
  const history=[...requests].reverse().map(row=>
    eventMarkup('Solicitud de cajas nuevas',formatNumber(row.cantidadCajas)+' cajas solicitadas'+
      ' · '+String(row.numero||'Requerimiento sin número'),
      dateOnly(dateValue(row)),'request','Solicitud')
  );
  return '<div class="summary-detail-stats">'+labelCard(formatNumber(total),'cajas nuevas solicitadas')+
    labelCard(formatNumber(requests.length),'solicitudes registradas')+'</div>'+
    '<h3 class="summary-detail-section-title">Historial de movimientos</h3>'+
    (history.length?'<ol class="summary-detail-timeline">'+history.join('')+'</ol>':
      '<p class="summary-detail-empty">Todavía no hay solicitudes de cajas nuevas registradas.</p>');
}
function loanMarkup(state) {
  const loans=(state.requests||[]).filter(row=>row.tipo===REQ_TYPES[1]);
  const active=loans.filter(row=>row.estadoV4!=='Devuelto'&&!row.fechaDevolucion);
  const boxes=state.tracking?.cajas;
  const pending=Array.isArray(boxes)?boxes.filter(box=>!box.devolucion):null;
  const keys=new Set((pending||[]).map(box=>physicalBoxKey(box.codigo||box.clave)).filter(Boolean));
  const total=pending==null?'—':formatNumber(keys.size);
  const items=[...loans].reverse().map(row=>{
    const associated=(boxes||[]).filter(box=>String(box.requerimiento||'')===String(row.id));
    const codes=[...new Set(associated.map(box=>box.codigo).filter(Boolean))];
    const returned=row.estadoV4==='Devuelto'||!!row.fechaDevolucion;
    const detail=codes.length?codes.join(' · '):'Consulta de cajas sin códigos disponibles';
    return eventMarkup('Solicitud a Iron Mountain · '+String(row.numero||'Sin número'),
      detail,dateOnly(dateValue(row)),
      returned?'complete':'request',returned?'Devuelta':'Solicitud');
  });
  return '<div class="summary-detail-stats">'+labelCard(total,'cajas con solicitud activa')+
    labelCard(formatNumber(active.length),'solicitudes activas')+
    labelCard(formatNumber(loans.length),'solicitudes registradas')+'</div>'+
    '<p class="summary-detail-helper">Se consideran únicamente las solicitudes a Iron Mountain para búsqueda o préstamo de cajas, no los pedidos de cajas nuevas.</p>'+
    '<h3 class="summary-detail-section-title">Historial de solicitudes a Iron Mountain</h3>'+
    (items.length?'<ol class="summary-detail-timeline">'+items.join('')+'</ol>':
      '<p class="summary-detail-empty">No hay solicitudes a Iron Mountain registradas.</p>');
}
const batchOf=(state,request)=>state.batches?.get(request.id)||summarizeBoxPreparationBatch(request,state.tracking);
const receptionComplete=batch=>batch.registered===batch.total&&!!batch.confirmed;
const receptionLabel=batch=>receptionComplete(batch)?'Recepción completa':
  batch.registered===batch.total?'Pendiente de confirmación':
    (batch.registered||batch.scanned)?'Recepción parcial':'Pendiente de recepción';

function receiptBatchMarkup(state,request,batch) {
  const {total,registered,confirmed,prepared}=batch;
  const complete=receptionComplete(batch);
  const events=readMovements(state.tracking,request.id);
  const latest=events.findLast(event=>['recepcion_completa','recepcion_parcial','recepcion_conciliada'].includes(event.tipo));
  const date=dateTime(latest?.registrado||confirmed);
  const saved=formatNumber(registered)+'/'+formatNumber(total)+' cajas registradas';
  return '<article class="summary-reception-batch"><div class="summary-reception-strip">'+
    '<div><strong>'+safe(request.numero)+' · '+saved+'</strong>'+
    '<span>Solicitada el '+safe(dateOnly(dateValue(request)))+'</span></div>'+
    '<span class="summary-reception-state '+(complete?'complete':'partial')+'">'+receptionLabel(batch)+'</span></div>'+
    '<progress class="summary-detail-progress" value="'+registered+'" max="'+total+'" aria-label="Recepción de '+safe(request.numero)+'"></progress>'+
    '<p class="summary-detail-helper">'+batch.registeredPct+'% registradas · '+formatNumber(total-registered)+' por registrar'+
    (prepared===null?'':' · '+formatNumber(prepared)+' acondicionadas')+'</p>'+
    (latest||confirmed?'<p class="summary-detail-helper">Último movimiento de recepción: '+safe(date)+'</p>':
      '<p class="summary-detail-helper">Aún no hay registros de recepción.</p>')+'</article>';
}
function receiptMarkup(state) {
  const requests=requestsOf(state);
  if(!requests.length)return '<p class="summary-detail-empty">No hay solicitudes de cajas nuevas para consultar.</p>';
  const batches=requests.map(request=>batchOf(state,request));
  const {total,registered}=combineBoxPreparationBatches(batches);
  const pending=[],history=[];
  requests.forEach((request,index)=>{
    const batch=batches[index];
    (receptionComplete(batch)?history:pending).push(receiptBatchMarkup(state,request,batch));
  });
  return '<div class="summary-detail-stats">'+labelCard(formatNumber(total),'cajas solicitadas')+
    labelCard(formatNumber(registered),'cajas registradas')+
    labelCard(formatNumber(total-registered),'pendientes de registrar')+'</div>'+
    '<h3 class="summary-detail-section-title">Recepciones pendientes</h3>'+
    (pending.join('')||'<p class="summary-detail-empty">Todas las recepciones están completas.</p>')+
    '<h3 class="summary-detail-section-title">Historial de recepciones completas</h3>'+
    (history.join('')||'<p class="summary-detail-empty">Todavía no hay recepciones completas.</p>');
}
function cargoList(row) {
  if(Array.isArray(row.cargos))return row.cargos.map(x=>String(x||'').trim()).filter(Boolean);
  return String(row.cargos||row.numeros_cargos||'').split(/[\s,;-]+/).map(x=>x.trim()).filter(Boolean);
}
function processRowMarkup(row) {
  const cargos=cargoList(row);
  const code=safe(row.codigo||row.clave||'Sin código');
  const person=safe(row.responsable||'No registrado');
  const stamp=safe(dateOnly(row.preparada));
  const cargoText=safe(cargos.join(' - '));
  return '<tr data-summary-process-item data-search="'+safe([row.codigo,...cargos,row.responsable].join(' ').toLowerCase())+'">'+
    '<td><strong>'+code+'</strong></td><td>'+safe(String(cargos.length))+'</td><td>'+stamp+'</td>'+
    '<td>'+person+'</td><td><span class="summary-process-status">'+
    (row.enviada?'Enviada a Iron Mountain':'Caja acondicionada')+'</span></td>'+
    '<td><details class="summary-process-details"><summary>Ver cargos</summary><span>'+cargoText+'</span></details></td></tr>';
}
function processBatchMarkup(request,batch,expanded) {
  const {prepared,total,preparedPct,registered,boxes}=batch;
  const progress=prepared===null?'Avance no disponible':formatNumber(prepared)+'/'+formatNumber(total)+' acondicionadas';
  const countText=prepared===null?receptionLabel(batch):
    registered===0?receptionLabel(batch):
      formatNumber(Math.max(0,registered-prepared))+' cajas registradas por acondicionar'+
      (registered<total?' · '+formatNumber(total-registered)+' por registrar':'');
  const preparedBoxes=boxes?.slice().sort((a,b)=>String(b.preparada||'').localeCompare(String(a.preparada||'')));
  return '<details class="summary-process-batch"'+(expanded?' open':'')+'>'+
    '<summary><span><strong>'+safe(request.numero)+' · '+progress+'</strong><small>'+countText+'</small></span>'+
    '<span class="summary-reception-state '+(prepared===total?'complete':'partial')+'">'+
    (preparedPct===null?'—':preparedPct+'%')+'</span></summary>'+
    '<div class="summary-process-batch-body">'+
    (prepared===null?'': '<progress class="summary-detail-progress process" value="'+prepared+'" max="'+total+
      '" aria-label="Acondicionamiento de '+safe(request.numero)+'"></progress>')+
    (preparedBoxes?.length?
      '<label class="summary-process-toolbar">Buscar por caja, cargo o responsable'+
      '<input data-summary-process-search type="search" autocomplete="off" placeholder="Código de caja, cargo o responsable"></label>'+
      '<div class="summary-process-table-wrap"><table class="summary-process-table"><thead><tr>'+
      '<th>Código de caja</th><th>N.° de cargos</th><th>Fecha de preparación</th><th>Responsable</th>'+
      '<th>Estado</th><th>Cargos asociados</th></tr></thead><tbody>'+
      preparedBoxes.map(processRowMarkup).join('')+'</tbody></table></div>'+
      '<p data-summary-process-empty class="summary-detail-empty" hidden>No se encontraron cajas con ese filtro.</p>':
      '<p class="summary-detail-empty">'+(prepared===null?'Actualiza el Resumen para consultar las cajas de este requerimiento.':
        'Todavía no hay cajas acondicionadas para este requerimiento.')+'</p>')+'</div></details>';
}
function processMarkup(state) {
  const requests=requestsOf(state);
  if(!requests.length)return '<p class="summary-detail-empty">Todavía no se han registrado requerimientos de cajas nuevas.</p>';
  const batches=requests.map(request=>batchOf(state,request));
  const {total,registered,prepared}=combineBoxPreparationBatches(batches);
  const pending=[],finished=[];
  requests.forEach((request,index)=>{
    const batch=batches[index];
    const destination=batch.prepared===batch.total?finished:pending;
    destination.push(processBatchMarkup(request,batch,destination===pending&&!pending.length));
  });
  return '<div class="summary-detail-stats">'+labelCard(formatNumber(total),'cajas solicitadas')+
    labelCard(prepared===null?'—':formatNumber(prepared),'cajas acondicionadas')+
    labelCard(prepared===null?'—':formatNumber(Math.max(0,registered-prepared)),'registradas por acondicionar')+'</div>'+
    '<h3 class="summary-detail-section-title">Avance por requerimiento</h3>'+
    (pending.join('')||'<p class="summary-detail-empty">Todos los requerimientos están acondicionados.</p>')+
    (finished.length?'<h3 class="summary-detail-section-title">Historial de acondicionamiento completo</h3>'+finished.join(''):'');
}
export function attachResumenBoxDetails({getState}) {
  const modal=document.createElement('dialog');
  modal.id='summaryBoxDetailDialog';
  modal.className='summary-detail-dialog';
  modal.setAttribute('aria-labelledby','summaryBoxDetailTitle');
  modal.innerHTML='<div class="summary-detail-head"><div class="summary-detail-identity">'+
    '<span class="summary-detail-icon" aria-hidden="true">▤</span><div>'+
    '<h2 id="summaryBoxDetailTitle"></h2><p id="summaryBoxDetailSubtitle"></p></div></div>'+
    '<button type="button" class="summary-detail-close">Cerrar</button></div>'+
    '<div class="summary-detail-content" id="summaryBoxDetailContent" aria-live="polite"></div>';
  document.body.append(modal);
  const content=modal.querySelector('#summaryBoxDetailContent');
  let returnTo=null;
  const titles={solicitudes:['Cajas solicitadas','Historial de solicitudes de cajas nuevas'],
    recepcion:['Cajas para acondicionar','Recepción y registro de cajas nuevas'],
    solicitudesIM:['Solicitudes a Iron Mountain','Préstamos y búsquedas de cajas almacenadas en IM'],
    acondicionamiento:['En proceso de acondicionamiento','Cajas nuevas acondicionadas por requerimiento']};
  content.addEventListener('input',event=>{
    if(!event.target.matches('[data-summary-process-search]'))return;
    const batch=event.target.closest('.summary-process-batch');
    const term=event.target.value.trim().toLowerCase();
    let visible=0;
    batch.querySelectorAll('[data-summary-process-item]').forEach(row=>{
      row.hidden=!!term&&!row.dataset.search.includes(term);
      if(!row.hidden)visible++;
    });
    batch.querySelector('[data-summary-process-empty]').hidden=visible>0;
  });
  modal.querySelector('.summary-detail-close').addEventListener('click',()=>modal.close());
  modal.addEventListener('close',()=>returnTo?.focus?.());
  function open(type,trigger=null) {
    if(!Object.hasOwn(titles,type) || !getState().allowed)return;
    returnTo=trigger||document.activeElement;
    const [title,subtitle]=titles[type];
    modal.querySelector('#summaryBoxDetailTitle').textContent=title;
    modal.querySelector('#summaryBoxDetailSubtitle').textContent=subtitle;
    if(!modal.open)modal.showModal();
    const state=getState();
    if(type==='solicitudes')content.innerHTML=requestMarkup(state.requests);
    if(type==='recepcion')content.innerHTML=receiptMarkup(state);
    if(type==='solicitudesIM')content.innerHTML=loanMarkup(state);
    if(type==='acondicionamiento')content.innerHTML=processMarkup(state);
  }
  return {open};
}
