// Vista previa de Resumen: ventanas de consulta de cajas. No modifica otros módulos ni guarda datos.
import {escapeHtml as safe,fmtDate,REQ_TYPES} from './rules.js';
import {physicalBoxKey} from './search.js';
import {summarizeBoxPreparationBatch} from './conditioning-batch-summary.js';

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
const requestsOf=rows=>(rows||[]).filter(row=>row.tipo===REQ_TYPES[0]&&numeric(row.cantidadCajas)>0);
const requestCurrent=rows=>requestsOf(rows).at(-1)||null;
const dateValue=row=>row?.fechaSolicitud||row?.createdAt||'';
const readMovements=(tracking,id)=>(tracking?.movimientos||[]).filter(row=>String(row.requerimiento||'')===String(id||''));
const labelCard=(number,label)=>'<div class="summary-detail-stat"><strong>'+safe(String(number))+'</strong><span>'+safe(label)+'</span></div>';
const eventMarkup=(title,description,stamp,tone,label)=>{
  return '<li class="summary-detail-event '+tone+'"><span class="summary-event-marker" aria-hidden="true"></span>'+
    '<div class="summary-event-copy"><strong>'+safe(title)+'</strong><span>'+safe(description)+'</span></div>'+
    '<span class="summary-event-tag">'+safe(label)+'</span><time>'+safe(stamp)+'</time></li>';
};
function requestMarkup(rows) {
  const requests=requestsOf(rows);
  const current=requests.at(-1);
  const history=[...requests].reverse().map(row=>
    eventMarkup('Solicitud de cajas nuevas',formatNumber(row.cantidadCajas)+' cajas solicitadas'+
      ' · '+String(row.numero||'Requerimiento sin número'),
      dateOnly(dateValue(row)),'request','Solicitud')
  );
  return '<div class="summary-detail-stats">'+labelCard(current?formatNumber(current.cantidadCajas):'—','cajas de la solicitud vigente')+
    labelCard(formatNumber(requests.length),'solicitudes registradas')+'</div>'+
    '<h3 class="summary-detail-section-title">Historial de movimientos</h3>'+
    (history.length?'<ol class="summary-detail-timeline">'+history.join('')+'</ol>':
      '<p class="summary-detail-empty">Todavía no hay solicitudes de cajas nuevas registradas.</p>');
}
function receiptMarkup(state) {
  const request=requestCurrent(state.requests);
  if(!request)return '<p class="summary-detail-empty">No hay una solicitud de cajas nuevas para consultar.</p>';
  const total=numeric(request.cantidadCajas);
  const events=readMovements(state.tracking,request.id);
  const partial=events.filter(e=>['recepcion_parcial','recepcion_conciliada'].includes(e.tipo)&&Number.isFinite(Number(e.datos?.cantidad)));
  const complete=events.filter(e=>e.tipo==='recepcion_completa'&&numeric(e.datos?.cantidad)>=total);
  const currentTracking=state.tracking?.suministro?.solicitudes?.find(row=>String(row.id)===String(request.id));
  const batch=summarizeBoxPreparationBatch(request,state.tracking,state.reception,state.preparedRows);
  const fallback=partial.length?numeric(partial.at(-1).datos.cantidad):numeric(request.recibidoV4);
  const saved=Math.min(total,Math.max(0,numeric(batch?.registered??currentTracking?.leidas??currentTracking?.guardadas??fallback)));
  const fullyReceived=!!complete.length || !!currentTracking?.confirmada || !!request.fechaRecepcion;
  const pending=Math.max(0,total-saved);
  const percentage=total?Math.round(saved/total*100):0;
  const timeline=partial.map(e=>eventMarkup('Guardado parcial de recepción',
    formatNumber(e.datos.cantidad)+' de '+formatNumber(total)+' cajas registradas en el Excel',
    dateTime(e.registrado), 'partial', 'Parcial'));
  if(complete.length)for(const e of complete)timeline.push(eventMarkup('Recepción completa',
    formatNumber(total)+' de '+formatNumber(total)+' cajas registradas en el Excel',
    dateTime(e.registrado),'complete','Completa'));
  if(!timeline.length && saved)timeline.push(eventMarkup(
    'Avance registrado',formatNumber(saved)+' de '+formatNumber(total)+' cajas registradas',
    'Sin fecha de guardado disponible','partial','Avance'));
  return '<div class="summary-detail-stats">'+
    labelCard(formatNumber(total),'cajas solicitadas')+
    labelCard(formatNumber(saved),'cajas registradas')+
    labelCard(formatNumber(pending),'pendientes de registrar')+
    '</div><div class="summary-reception-strip"><div><strong>'+
    safe(formatNumber(saved)+' de '+formatNumber(total)+' cajas registradas')+
    '</strong><span>'+safe(request.numero||'Requerimiento')+' · Solicitada el '+safe(dateOnly(dateValue(request)))+
    '</span></div><span class="summary-reception-state '+(fullyReceived?'complete':'partial')+'">'+
    (fullyReceived?'Recepción completa':'Recepción parcial')+'</span></div>'+
    '<progress class="summary-detail-progress" value="'+saved+'" max="'+Math.max(total,1)+'" aria-label="Avance de recepción de cajas"></progress>'+
    '<p class="summary-detail-helper">'+percentage+'% registradas · '+formatNumber(pending)+' cajas pendientes</p>'+
    '<h3 class="summary-detail-section-title">Historial de recepción</h3>'+
    (timeline.length?'<ol class="summary-detail-timeline">'+timeline.join('')+'</ol>':
       '<p class="summary-detail-empty">Todavía no existen movimientos de guardado parcial para este requerimiento.</p>');
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
    '<td>'+person+'</td><td><span class="summary-process-status">Caja acondicionada</span></td>'+
    '<td><details class="summary-process-details"><summary>Ver cargos</summary><span>'+cargoText+'</span></details></td></tr>';
}
function processMarkup(rows,request,reception) {
  if(!request)return '<p class="summary-detail-empty">Todavía no se ha registrado un requerimiento de cajas nuevas.</p>';
  const total=numeric(request.cantidadCajas);
  const key=String(request.id||'');
  const readings=String(reception?.id||'')===String(request.id) && Array.isArray(reception?.lecturas)
    ? reception.lecturas : [];
  const receptionCodes=new Set(readings.map(r=>physicalBoxKey(r.codigo)).filter(Boolean));
  const valid=new Map();
  for(const row of rows){
    if(row?.origen!=='nueva'||!row.preparada)continue;
    const code=physicalBoxKey(row.codigo||row.clave);
    if(!code)continue;
    const linked=String(row.solicitud||'')===key||
      (!row.solicitud&&receptionCodes.has(code));
    if(!linked||!cargoList(row).length)continue; // No incluir cajas con solo código.
    if(!valid.has(code)||String(row.preparada)>String(valid.get(code).preparada))valid.set(code,row);
  }
  const prepared=[...valid.values()].sort((a,b)=>String(b.preparada).localeCompare(String(a.preparada)));
  const count=prepared.length;
  const pct=total?Math.round(100*count/total):0;
  return '<div class="summary-detail-stats">'+labelCard(formatNumber(total),'cajas solicitadas')+
    labelCard(formatNumber(count),'cajas acondicionadas con cargos')+
    labelCard(formatNumber(Math.max(0,total-count)),'aún no acondicionadas')+'</div>'+
    '<div class="summary-reception-strip"><div><strong>Avance de acondicionamiento · '+formatNumber(count)+
    ' / '+formatNumber(total)+'</strong><span>Requerimiento '+safe(request.numero||'vigente')+
    '</span></div><span class="summary-reception-state complete">'+pct+'%</span></div>'+
    '<progress class="summary-detail-progress process" value="'+Math.min(count,total)+'" max="'+Math.max(total,1)+'" aria-label="Avance de cajas acondicionadas"></progress>'+
    '<p class="summary-detail-helper">Solo cajas nuevas de la solicitud vigente, con cargos asociados y preparación registrada.</p>'+
    '<h3 class="summary-detail-section-title">Relación de cajas acondicionadas</h3>'+
    (prepared.length?'<div class="summary-process-toolbar"><label for="summaryProcessSearch">Buscar por caja, cargo o responsable</label>'+
      '<input id="summaryProcessSearch" type="search" autocomplete="off" placeholder="Código de caja, cargo o responsable"></div>'+
      '<div class="summary-process-table-wrap"><table class="summary-process-table"><thead><tr>'+
      '<th>Código de caja</th><th>N.° de cargos</th><th>Fecha de preparación</th><th>Responsable</th>'+
      '<th>Estado</th><th>Cargos asociados</th></tr></thead><tbody>'+
      prepared.map(processRowMarkup).join('')+'</tbody></table></div>'+
      '<p id="summaryProcessEmptyFilter" class="summary-detail-empty" hidden>No se encontraron cajas con ese filtro.</p>'+
      '<p class="summary-detail-helper">Puedes desplegar «Ver cargos» para conocer los números asociados a cada caja.</p>'
      :'<p class="summary-detail-empty">No hay cajas nuevas con preparación confirmada y cargos asociados para este requerimiento.</p>');
}
export function attachResumenBoxDetails({repository,getState}) {
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
  let active='',currentRequest=null,returnTo=null,version=0;
  const titles={solicitudes:['Cajas solicitadas','Historial de solicitudes de cajas nuevas'],
    recepcion:['Cajas para acondicionar','Recepción y registro de cajas nuevas'],
    acondicionamiento:['En proceso de acondicionamiento','Cajas nuevas acondicionadas de la solicitud vigente']};
  function applyProcessFilter() {
    const field=content.querySelector('#summaryProcessSearch');
    if(!field)return;
    const term=field.value.trim().toLowerCase();
    let count=0;
    content.querySelectorAll('[data-summary-process-item]').forEach(row=>{
      row.hidden=!!term&&!row.dataset.search.includes(term);
      if(!row.hidden)count++;
    });
    const empty=content.querySelector('#summaryProcessEmptyFilter');
    if(empty)empty.hidden=count>0;
  }
  content.addEventListener('input',event=>{if(event.target.id==='summaryProcessSearch')applyProcessFilter();});
  modal.querySelector('.summary-detail-close').addEventListener('click',()=>modal.close());
  modal.addEventListener('close',()=>{version++; active='';returnTo?.focus?.();});
  async function loadProcess(call) {
    const state=getState(),request=requestCurrent(state.requests);
    content.innerHTML='<p class="summary-detail-empty">Consultando cajas acondicionadas de la solicitud vigente…</p>';
    try{
      const [live,reception]=await Promise.all([repository.conditioning('listar'),repository.reception().catch(()=>state.reception)]);
      if(call!==version||!modal.open||active!=='acondicionamiento')return;
      if(!Array.isArray(live?.listado))throw Error('Sin listado de acondicionamiento disponible');
      content.innerHTML=processMarkup(live.listado,request,reception||state.reception);
    }catch(error){
      if(call!==version||!modal.open)return;
      content.innerHTML='<p class="summary-detail-empty">No se pudo consultar el listado de acondicionamiento. '+safe(error.message||'Revisa la conexión e inténtalo otra vez.')+'</p>'+
        '<button type="button" class="summary-detail-retry">Reintentar consulta</button>';
      content.querySelector('.summary-detail-retry')?.addEventListener('click',()=>void loadProcess(++version));
    }
  }
  function open(type,trigger=null) {
    if(!Object.hasOwn(titles,type) || !getState().allowed)return;
    returnTo=trigger||document.activeElement;
    active=type;
    const [title,subtitle]=titles[type];
    modal.querySelector('#summaryBoxDetailTitle').textContent=title;
    modal.querySelector('#summaryBoxDetailSubtitle').textContent=subtitle;
    if(!modal.open)modal.showModal();
    const state=getState();
    if(type==='solicitudes')content.innerHTML=requestMarkup(state.requests);
    if(type==='recepcion')content.innerHTML=receiptMarkup(state);
    if(type==='acondicionamiento')void loadProcess(++version);
  }
  return {open};
}
