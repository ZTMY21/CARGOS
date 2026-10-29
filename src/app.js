import { createClient } from '@supabase/supabase-js';
import { computeReqEstado as reqEstado, computeDocEstado as docEstado, fmtDate, escapeHtml, limaDate } from './rules.js';
import { KardexRepository, reqFromDb, docFromDb } from './repository.js';
import { buildCargoWorkbook, parseWorkbook } from './excel-api.js';
import { highlightMatch, normalizeSearch, filterDocuments, filterRequirements, invoiceSearchPresentation, assignedBoxCode } from './search.js';
import './connection.css';
import { createIdleSession } from './idle-session.js';
import { cargoYear, locationLabel, groupsForCodes } from './cargo-details.js';
import { summarizeCreatedCargos } from './monthly-created-summary.js';
import { renderCargoLineChart } from './cargo-line-chart.js';
import { createCreatedDashboard } from './created-dashboard.js';
import { summarizeShippedBoxes } from './im-shipped-summary.js';
import { renderImBarChart } from './im-bar-chart.js';
import { cargoExpiryGroups, formatCargoDuration } from './cargo-expiry.js';
import { requestedIMBoxes, countRequestedCargos, summarizePreparedIm } from './im-requests.js';

const configuration = { url: __SUPABASE_URL__, key: __SUPABASE_ANON_KEY__ };
// Capture recovery mode before the client consumes the email callback fragment.
let passwordRecovery = new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery';
let passwordRecoveryCompleted = false;
const supabase = configuration.url && configuration.key ? createClient(configuration.url, configuration.key) : null;
const repository = supabase ? new KardexRepository(supabase) : null;
const idleSession = createIdleSession({window, onExpire: async()=>{
  // Lock the interface immediately, including when the network is unavailable.
  await handleSession(null);
  message('authMessage','Tu sesión se cerró por una hora de inactividad. Vuelve a ingresar.');
  try { await supabase.auth.signOut({scope:'local'}); } catch { /* The expired local deadline keeps the app locked. */ }
}});
let googleSyncEnabled=true;
let activeWorkspaceTab='resumen';
let activeSidebarAction='';
const renderCreatedDashboard = createCreatedDashboard();
let appReady = false, isAdmin = false, mutationBusy = false, channelReady = false;
let adminRequestStatus = null;
let adminRequestsTimer = null, adminRequestsEpoch = 0;
let adminEmailLinkReviewed = false;
let dataReady = false, realtimeChannel = null, refreshTimer = null, refreshPromise = null;
let refreshRequested = false;
let authGeneration = 0, currentUserId = null;
let pendingReqId = null, pendingDocId = null;
let queryResults = null, queryError = '', searchEpoch = 0, searchController = null;

const previousCargoCache=new Map(),previousCargoPending=new Map();
let previousCargoEpoch=0;
function clearPreviousCargoCache(){
  previousCargoCache.clear();previousCargoPending.clear();previousCargoEpoch++;
}
function previousCargoSignature(doc){
  return [doc.id,doc.updatedAt||'',doc.fechaOrigen||'',(doc.cargos||[]).join('|')].join('~');
}
function previousCargoMarkup(items,invoiceCodes=[]){
  const matched=new Set(invoiceCodes.map(normalizeSearch).filter(Boolean));
  if(!Array.isArray(items)||!items.length)return '<span class="previous-cargo-none">—</span>';
  const seen=new Set(),data=[];
  for(const row of items){
    const cargo=String(row?.cargo??'').trim(),year=Number(row?.anio);
    if(!cargo||cargo.length>80)continue;
    if(matched.size && !(row?.codigos||[]).some(code=>matched.has(normalizeSearch(code))))continue;
    const anio=Number.isInteger(year)&&year>=1900&&year<=2200?year:null;
    const key=cargo+'|'+String(anio||'');
    if(seen.has(key))continue;
    seen.add(key);
    data.push({cargo,anio,count:Math.max(0,Number(row?.coincidencias)||0)});
  }
  if(!data.length)return '<span class="previous-cargo-none">—</span>';
  const title=data.map(x=>x.cargo+(x.anio?' ('+x.anio+')':'')).join(', ');
  const list=data.slice(0,3).map(x=>
    '<span class="previous-cargo-id" title="'+escapeHtml(x.count+' documento(s) coincidente(s)')+'">'
    +escapeHtml(x.cargo)+(x.anio?'<small> ('+x.anio+')</small>':'')+'</span>').join('');
  return '<span class="previous-cargo-tags" title="'+escapeHtml('Cargos anteriores: '+title)+'">'
    +list+(data.length>3?'<span class="previous-cargo-more" title="'+escapeHtml(title)+'">+'+(data.length-3)+' más</span>':'')+'</span>';
}
function fetchPreviousCargos(rows){
  if(!repository?.previousCargos||!currentUserId||!rows.length)return;
  const pending=rows.filter(d=>previousCargoCache.get(d.id)?.signature!==previousCargoSignature(d)
    && !previousCargoPending.has(d.id)).slice(0,100);
  if(!pending.length)return;
  const epoch=previousCargoEpoch,generation=authGeneration;
  const ids=pending.map(d=>d.id),signatures=new Map(pending.map(d=>[d.id,previousCargoSignature(d)]));
  ids.forEach(id=>previousCargoPending.set(id,epoch));
  void Promise.resolve().then(()=>repository.previousCargos(ids)).then(data=>{
    if(epoch!==previousCargoEpoch||generation!==authGeneration||!currentUserId)return;
    const result=data&&typeof data==='object'&&!Array.isArray(data)?data:{};
    for(const d of pending)previousCargoCache.set(d.id,{
      signature:signatures.get(d.id),items:Array.isArray(result[d.id])?result[d.id]:[]
    });
    document.querySelectorAll('[data-previous-cargo-id]').forEach(cell=>{
      const id=cell.dataset.previousCargoId;
      if(signatures.has(id)&&previousCargoCache.get(id)?.signature===signatures.get(id))
        cell.innerHTML=previousCargoMarkup(previousCargoCache.get(id).items,
          (cell.dataset.matchedInvoiceCodes||'').split(',').filter(Boolean));
    });
  }).catch(()=>{
    if(epoch!==previousCargoEpoch||generation!==authGeneration)return;
    document.querySelectorAll('[data-previous-cargo-id]').forEach(cell=>{
      if(ids.includes(cell.dataset.previousCargoId))
        cell.innerHTML='<span class="previous-cargo-error">No disponible</span>';
    });
  }).finally(()=>ids.forEach(id=>{
    if(previousCargoPending.get(id)===epoch)previousCargoPending.delete(id);
  }));
}

let currentPage = 0;
let expiryGroups = {today:'', overdue:[], upcoming:[], unknown:[]};
let activeExpiryGroup = null, expiryPage = 0, expiryReturnButton = '';
// Filtros independientes del nuevo módulo; no alteran las búsquedas generales.
let expiryWorkspaceView='all', expiryWorkspacePage=0, expiryChartYear='2026', expiryChartMonth='all';
const EXPIRY_WORKSPACE_PAGE_SIZE=15;
let historySelectedYear='2026',historyPage=0;
const HISTORY_PAGE_SIZE=15;
let preparedImRows = [], preparedImFetchEpoch = 0;
let preparedImSummary = null, preparedImSummaryEpoch = 0;
let requestedIMRows = [], requestedIMData = [], requestedIMError = '', requestedIMFetchEpoch = 0;
let requestedIMLoaded = false;
const requestedDemo = new URLSearchParams(window.location.search).get('demo-solicitudes') === '1'
  && /-ztmy1\.vercel\.app$/i.test(window.location.hostname)
  && !['kardex-digital-santa-anita-ztmy1.vercel.app','kardex-digital-santa-anita-git-main-ztmy1.vercel.app'].includes(window.location.hostname);
// Rama de validación del menú: bloquear mutaciones aunque cambie el alias de Vercel.
const isPreview = true;
let appliedFilters = {query:'',state:'',type:'',location:'',year:'',invoiceExact:false};
const browseOrder = new Map();
function showRandomCargos(filters=appliedFilters) {
  return docs.length>0 && docs.every(d=>d.cargos?.length) &&
    !filters.query && !filters.state && !filters.type && !filters.location && !filters.year;
}
function randomCargoOrder(a,b) {
  for(const d of [a,b]) if(!browseOrder.has(d.id))browseOrder.set(d.id,Math.random());
  return browseOrder.get(a.id)-browseOrder.get(b.id);
}
function setupTableScrolling() {
  const top=document.getElementById('docsTopScroll');
  const bottom=document.getElementById('docsTableScroll');
  const table=document.getElementById('docsTable');
  const syncWidth=()=>{document.getElementById('docsTopScrollWidth').style.width=table.scrollWidth+'px';top.scrollLeft=bottom.scrollLeft;};
  top.addEventListener('scroll',()=>{if(bottom.scrollLeft!==top.scrollLeft)bottom.scrollLeft=top.scrollLeft;});
  bottom.addEventListener('scroll',()=>{if(top.scrollLeft!==bottom.scrollLeft)top.scrollLeft=bottom.scrollLeft;});
  if(typeof ResizeObserver!=='undefined') {const observer=new ResizeObserver(syncWidth);observer.observe(table);observer.observe(bottom);}
  window.addEventListener('resize',syncWidth);
  document.querySelectorAll('details').forEach(d=>d.addEventListener('toggle',syncWidth));
  new MutationObserver(syncWidth).observe(table,{childList:true,subtree:true});
  syncWidth();
}
setupTableScrolling();
const PAGE_SIZE = 100;
function currentFilters() {
  return {query:document.getElementById('buscar').value.trim(),state:document.getElementById('filtroEstado').value,
    type:document.getElementById('filtroTipo').value,location:document.getElementById('filtroUbicacion').value,
    year:document.getElementById('filtroAnio').value,invoiceExact:document.getElementById('filtroFactura').value==='exacta'};
}
function populateYearOptions() {
  const select=document.getElementById('filtroAnio'),previous=select.value;
  const years=[...new Set(docs.filter(d=>d.periodo).map(d=>d.periodo.slice(0,4)))].sort().reverse();
  const originYears=[...new Set(docs.filter(d=>d.anioOrigen).map(d=>String(d.anioOrigen)))].sort().reverse();
  select.innerHTML='<option value="">Todos los años / períodos</option>'
    + years.map(y=>`<option value="${y}">${y} — Período contable</option>`).join('')
    + originYears.map(y=>`<option value="origen:${y}">${y} — Año de origen</option>`).join('')
    + '<option value="sin-periodo">Sin período contable registrado</option>';
  select.value=previous;if(select.value!==previous)select.value='';
}
async function fetchSearchResults(render=true) {
  if(!repository?.search||!currentUserId) {queryResults=null;return;}
  const noOtherFilters = !appliedFilters.query && !appliedFilters.type &&
    !appliedFilters.location && !appliedFilters.year && !appliedFilters.invoiceExact;
  // When filtering only by Estado, use the complete synchronized snapshot.
  // This shares computeDocEstado with the red/green badges and avoids
  // mismatches between the table, the counts, and paginated SQL results.
  // Only the Buscar button changes appliedFilters; changing the select does nothing.
  if(noOtherFilters) {
    searchEpoch++;searchController?.abort();queryResults=null;queryError='';
    if(render){renderDocs();setAvailability();}
    return;
  }
  // Cargo y Caja asignada son búsquedas locales rápidas sobre el snapshot
  // sincronizado, sin coincidencias accidentales con facturas ni RPC costosas.
  if(['solo-cargos','solo-cajas'].includes(appliedFilters.type)) {
    searchEpoch++;searchController?.abort();queryResults=null;queryError='';
    if(render){renderDocs();setAvailability();}
    return;
  }
  const epoch=++searchEpoch;
  searchController?.abort();searchController=new AbortController();
  document.getElementById('conteoResultados').textContent='Buscando…';
  try {
    const result=await repository.search(appliedFilters,currentPage*PAGE_SIZE,PAGE_SIZE,searchController.signal);
    if(epoch!==searchEpoch)return;
    queryResults={...result,rows:result.rows.map(docFromDb)};queryError='';
    if(render) {renderDocs();setAvailability();}
  } catch(error) {
    if(epoch!==searchEpoch||searchController.signal.aborted)return;
    queryError=error?.code==='57014'
      ? 'La búsqueda demoró demasiado. Prueba con un código más completo y pulsa Buscar otra vez.'
      : 'No se pudo completar la búsqueda. Revisa tu conexión y vuelve a pulsar Buscar.';
    queryResults={rows:[],total:0,folios:0};
    if(render)renderDocs();
  }
}
function message(id, value, error = false) {
  const node = document.getElementById(id);
  node.textContent = value;
  node.style.color = error ? 'var(--red)' : 'var(--green)';
}
function setStatus(value, state = '') {
  const status=document.getElementById('connectionStatus');
  status.textContent=value;
  // Se conserva el mensaje completo de conexión aunque la cabecera sea compacta.
  status.title=value;
  document.getElementById('connectionDot').className = `connection-dot ${state}`;
}
// Navegación entre apartados sin desmontar formularios ni desconectar Supabase.
const WORKSPACE_SECTIONS={
  resumen:'grp-resumen',
  control:'grp-resumen',
  'control-detalle':'grp-resumen',
  iron:'grp-resumen',
  'iron-cajas':'grp-resumen',
  historicos:'grp-resumen',
  requerimientos:'grp-requerimientos',
  existencias:'grp-existencias',
  solicitudes:'grp-solicitudes',
  sync:'googleSyncPanel',
  reportes:'sidebarReportsPanel'
};
const SUMMARY_VIEWS = new Set(['resumen','control','control-detalle','iron','iron-cajas','historicos']);
const SECTION_COPY={
  control:['CONTROL DOCUMENTAL','Dashboard de Vencimientos','Indicadores de vencimientos documentales.'],
  'control-detalle':['CONTROL DOCUMENTAL','Detalle de Cargos Pendientes','Consulta, búsqueda y seguimiento de cargos.'],
  iron:['IRON MOUNTAIN','Dashboard de Envíos','Evolución de cajas enviadas a Iron Mountain por mes y año.'],
  'iron-cajas':['IRON MOUNTAIN','Gestión y seguimiento de cajas','Cajas preparadas, solicitadas e histórico de Iron Mountain.'],
  historicos:['HISTÓRICO DOCUMENTAL','Histórico documental','Consulta anual de cargos registrados entre 2020 y 2026.']
};
function setAdminRequestBadge(count) {
  const valid=Number.isSafeInteger(count) && count>=0;
  const total=valid?count:0;
  // El único contador visible es ahora el del botón superior.
  const quickButton=document.getElementById('btnTopAdminRequests');
  const quickCount=document.getElementById('topAdminRequestsCount');
  quickButton.dataset.status=!valid?'unknown':total>0?'pending':'empty';
  quickCount.textContent=valid?String(total):'—';
  quickButton.setAttribute('aria-label',valid
    ? `Solicitudes de Cuentas Adm.: ${total} ${total===1?'pendiente':'pendientes'}. Abrir solicitudes`
    : 'Solicitudes de Cuentas Adm. sin consultar. Abrir solicitudes');
}
function closeSidebarDrawer(){
  document.getElementById('appShell').classList.remove('sidebar-open');
  document.getElementById('sidebarScrim').hidden=true;
  document.getElementById('sidebarMenuToggle').setAttribute('aria-expanded','false');
}
function updateSidebarSelection(){
  const sidebar=document.getElementById('kardexSidebar');
  if(!sidebar)return;
  for(const button of sidebar.querySelectorAll('button[data-sidebar-view],button[data-sidebar-action]')){
    const selected=button.dataset.sidebarAction
      ? button.dataset.sidebarAction===activeSidebarAction
      : !activeSidebarAction && button.dataset.sidebarView===activeWorkspaceTab;
    if(selected)button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  }
}
function updateWorkspaceVisibility() {
  const adminReady=appReady && isAdmin;
  const showSync=adminReady && activeWorkspaceTab==='sync';
  document.getElementById('appShell').dataset.module=activeWorkspaceTab;
  document.getElementById('documentExpiryWorkspace').hidden=
    !adminReady || activeWorkspaceTab!=='control';
  document.getElementById('documentExpiryDetails').hidden=
    !adminReady || activeWorkspaceTab!=='control-detalle';
  document.getElementById('documentHistoryWorkspace').hidden=
    !adminReady || activeWorkspaceTab!=='historicos';
  document.getElementById('imShippingDashboard').hidden=
    !adminReady || activeWorkspaceTab!=='iron';
  document.getElementById('imBoxesWorkspace').hidden=
    !adminReady || activeWorkspaceTab!=='iron-cajas';
  // Miga de navegación informativa; sin modificar la sección seleccionada.
  const breadcrumbs={
    resumen:'Dashboard General',control:'Dashboard de Vencimientos',
    'control-detalle':'Detalle de Cargos Pendientes',
    historicos:'Histórico documental',iron:'Dashboard de Envíos',
    'iron-cajas':'Gestión y seguimiento de cajas',
    requerimientos:'Requerimientos',existencias:'Existencias',
    sync:'Actividad y sincronización',reportes:'Reportes y descargas',
    solicitudes:'Usuarios y accesos'
  };
  document.getElementById('executiveBreadcrumbRoot').textContent=
    adminReady?'Panel administrativo':'Consulta documental';
  document.getElementById('executiveBreadcrumbCurrent').textContent=
    adminReady?(breadcrumbs[activeWorkspaceTab]||'Dashboard General'):'Existencias';
  document.getElementById('executiveRole').textContent=
    adminReady?'Vista del administrador':'Vista de consulta';
  const heading=document.getElementById('sidebarSectionHeading');
  const copy=SECTION_COPY[activeWorkspaceTab];
  heading.hidden=!copy;
  if(copy){
    document.getElementById('sidebarSectionEyebrow').textContent=copy[0];
    document.getElementById('sidebarSectionTitle').textContent=copy[1];
    document.getElementById('sidebarSectionSubtitle').textContent=copy[2];
  }
  document.getElementById('appShell').classList.toggle('has-sidebar',adminReady);
  document.getElementById('kardexSidebar').hidden=!adminReady;
  document.getElementById('sidebarMenuToggle').hidden=!adminReady;
  if(!adminReady)closeSidebarDrawer();
  const adminRequestsButton=document.getElementById('btnTopAdminRequests');
  adminRequestsButton.setAttribute('aria-pressed',String(adminReady && activeWorkspaceTab==='solicitudes'));
  // La barra de pestañas permanece visible en todas las vistas administrativas.
  // Ocultar estos elementos es solo visual: los datos y los enlaces siguen cargados.
  document.getElementById('googleSyncContent').hidden=!showSync;
  document.getElementById('googleSyncPanel').classList.toggle('workspace-tabs-only',adminReady && !showSync);
  for(const [name,id] of Object.entries(WORKSPACE_SECTIONS)) {
    if(['control','control-detalle','iron','iron-cajas','historicos'].includes(name))continue;
    const section=document.getElementById(id);
    const active=adminReady && (name==='resumen'
      ? SUMMARY_VIEWS.has(activeWorkspaceTab) : activeWorkspaceTab===name);
    // Los invitados conservan su buscador, sin acceso a las vistas administrativas.
    section.hidden=adminReady ? !active : name!=='existencias';
    if(active && section.tagName==='DETAILS')section.open=true;
  }
  for(const button of document.querySelectorAll('#workspaceTabs [data-workspace]')) {
    const active=adminReady && button.dataset.workspace===activeWorkspaceTab;
    button.setAttribute('aria-selected',String(active));
    button.tabIndex=active?0:-1;
  }
  updateSidebarSelection();
}
function selectWorkspaceTab(tab,focus=false) {
  if(!appReady || !isAdmin || !Object.hasOwn(WORKSPACE_SECTIONS,tab))return;
  activeWorkspaceTab=tab;
  activeSidebarAction='';
  updateWorkspaceVisibility();
  if(focus)(document.querySelector(`#workspaceTabs [data-workspace="${tab}"]`)
    || (tab==='solicitudes'?document.getElementById('btnTopAdminRequests'):null))?.focus();
  if(tab==='solicitudes')void refreshAdminRequests();
  if(tab==='iron' && !monthlyShippedSummary)void reloadShippedBoxesSummary();
  if(tab==='iron-cajas')renderIMBoxWorkspace();
}
document.getElementById('btnTopAdminRequests').addEventListener('click',()=>{
  if(!appReady||!isAdmin)return;
  selectWorkspaceTab('solicitudes',true);
  document.getElementById('grp-solicitudes').scrollIntoView({behavior:'smooth',block:'start'});
});
const workspaceNav=document.getElementById('workspaceTabs');
workspaceNav.addEventListener('click',event=>{
  const tab=event.target.closest('button[data-workspace]');
  if(tab && workspaceNav.contains(tab))selectWorkspaceTab(tab.dataset.workspace);
});
workspaceNav.addEventListener('keydown',event=>{
  const current=event.target.closest('button[data-workspace]');
  if(!current || !workspaceNav.contains(current) || !isAdmin || !appReady)return;
  // El menú inferior solo recorre sus tres pestañas visibles.
  const names=[...workspaceNav.querySelectorAll('button[data-workspace]')].map(button=>button.dataset.workspace);
  const index=names.indexOf(current.dataset.workspace);
  if(index<0)return;
  let next=null;
  if(event.key==='ArrowRight')next=names[(index+1)%names.length];
  else if(event.key==='ArrowLeft')next=names[(index+names.length-1)%names.length];
  else if(event.key==='Home')next=names[0];
  else if(event.key==='End')next=names[names.length-1];
  if(next){event.preventDefault();selectWorkspaceTab(next,true);}
});
// Menú de cuenta accesible: cerrar sesión conserva el manejador existente.
const profileTrigger=document.getElementById('sessionProfile');
const profileMenu=document.getElementById('executiveProfileMenu');
function closeExecutiveProfileMenu(){
  profileMenu.hidden=true;
  profileTrigger.setAttribute('aria-expanded','false');
}
profileTrigger.addEventListener('click',()=>{
  if(profileTrigger.hidden)return;
  const willOpen=profileMenu.hidden;
  profileMenu.hidden=!willOpen;
  profileTrigger.setAttribute('aria-expanded',String(willOpen));
  if(willOpen)profileMenu.querySelector('#btnSignOut:not([hidden])')?.focus();
});
document.addEventListener('pointerdown',event=>{
  if(!event.target.closest('#executiveAccount'))closeExecutiveProfileMenu();
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!profileMenu.hidden){
    closeExecutiveProfileMenu();profileTrigger.focus();
  }
});
// La nueva barra lateral dirige a los mismos módulos y acciones existentes.
const sidebarNode=document.getElementById('kardexSidebar');
const sidebarCollapseButton=document.getElementById('sidebarCollapseButton');
function setSidebarCollapsed(collapsed){
  document.getElementById('appShell').classList.toggle('sidebar-collapsed',collapsed);
  sidebarCollapseButton.setAttribute('aria-expanded',String(!collapsed));
  const label=collapsed?'Expandir menú lateral':'Contraer menú lateral';
  sidebarCollapseButton.setAttribute('aria-label',label);
  sidebarCollapseButton.title=label;
}
sidebarCollapseButton.addEventListener('click',()=>{
  setSidebarCollapsed(!document.getElementById('appShell').classList.contains('sidebar-collapsed'));
});
// Desplegar el menú antes de abrir una subcategoría en modo compacto.
for(const summary of sidebarNode.querySelectorAll('.sidebar-category>summary')){
  summary.title=summary.textContent.trim().replace(/\s+/g,' ');
  summary.addEventListener('click',()=>{
    if(document.getElementById('appShell').classList.contains('sidebar-collapsed')){
      setSidebarCollapsed(false);
    }
  });
}
for(const link of sidebarNode.querySelectorAll('.sidebar-link')){
  link.title=link.textContent.trim().replace(/\s+/g,' ');
}
sidebarNode.addEventListener('click',event=>{
  const button=event.target.closest('button[data-sidebar-view],button[data-sidebar-action]');
  if(!button || !sidebarNode.contains(button) || !appReady || !isAdmin)return;
  const view=button.dataset.sidebarView;
  if(view){
    selectWorkspaceTab(view);
  }else{
    const action=button.dataset.sidebarAction;
    if(['expiry-upcoming','expiry-overdue'].includes(action)){
      selectWorkspaceTab('control');
      openCargoExpiry(action==='expiry-overdue'?'overdue':'upcoming');
    }else if(action==='im-requested'){
      selectWorkspaceTab('iron-cajas');
      document.getElementById('btnRequestedIMDetail').click();
    }else if(action==='im-prepared'){
      selectWorkspaceTab('iron-cajas');
      openPreparedIm();
    }else if(action==='im-sent'){
      selectWorkspaceTab('iron');
      document.getElementById('btnMonthlyShippedDetail').click();
    }else if(action==='im-historical'){
      selectWorkspaceTab('iron-cajas');
      document.getElementById('btnOpenIronMountainHistorical').click();
    }else if(action==='export-cargo'){
      selectWorkspaceTab('existencias');
      document.getElementById('buscar').focus();
    }else if(action==='admin-requests'){
      selectWorkspaceTab('solicitudes');
    }else return;
    activeSidebarAction=action;
    updateSidebarSelection();
  }
  closeSidebarDrawer();
});
document.getElementById('sidebarMenuToggle').addEventListener('click',()=>{
  const shell=document.getElementById('appShell');
  const open=!shell.classList.contains('sidebar-open');
  shell.classList.toggle('sidebar-open',open);
  document.getElementById('sidebarScrim').hidden=!open;
  document.getElementById('sidebarMenuToggle').setAttribute('aria-expanded',String(open));
  if(open)document.querySelector('#kardexSidebar [data-sidebar-view="resumen"]').focus();
});
document.getElementById('sidebarCloseMobile').addEventListener('click',()=>{
  closeSidebarDrawer();document.getElementById('sidebarMenuToggle').focus();
});
document.getElementById('sidebarScrim').addEventListener('click',closeSidebarDrawer);
document.getElementById('sidebarGoExistencias').addEventListener('click',()=>{
  selectWorkspaceTab('existencias');
  document.getElementById('buscar').focus();
});
// Comparación histórica integrada en la misma gráfica del Dashboard General.
document.addEventListener('keydown',event=>{
  if(event.key==='Escape' && document.getElementById('appShell').classList.contains('sidebar-open')){
    closeSidebarDrawer();
    document.getElementById('sidebarMenuToggle').focus();
  }
});
function setAvailability() {
  if (!appReady || !isAdmin) { closeCargoExpiry(); closePreparedIm(); closeRequestedIM(); }
  document.getElementById('btnExportar').hidden=true;
  document.getElementById('appShell').classList.toggle('read-only', !isAdmin);
  ['googleSyncPanel','btnImportar','btnReset'].forEach(id=>document.getElementById(id).hidden=!isAdmin);
  updateWorkspaceVisibility();
  // El formulario antiguo de «Documentos (Nuevos Ingresos)» queda oculto.
  // Se conservan sus nodos para no afectar los controles existentes del Kardex.
  document.getElementById('grp-documentos').hidden=true;
  document.getElementById('btnTopAdminRequests').hidden=!appReady||!isAdmin;
  document.getElementById('btnRefreshNewCargos').hidden=!isAdmin;
  document.getElementById('readOnlyNotice').hidden=!appReady||isAdmin;
  document.getElementById('existenciasSubtitulo').textContent = isAdmin
    ? 'Consulta, búsqueda, exportación e importación de documentos'
    : 'Consulta, búsqueda y exportación de documentos';

  document.querySelectorAll('.group button').forEach(b => b.disabled = !appReady || mutationBusy);
  ['btnReset','btnImportar','btnGuardar','btnGuardarReq'].forEach(id => document.getElementById(id).disabled = !appReady || !isAdmin || mutationBusy || isPreview);
  const total=queryResults?.total??lastFiltered.length;
  document.getElementById('btnPaginaAnterior').disabled=!appReady||mutationBusy||currentPage===0;
  document.getElementById('btnPaginaSiguiente').disabled=!appReady||mutationBusy||total<=(currentPage+1)*PAGE_SIZE;
}
function readableError(error) {
  const authErrors = {
    invalid_credentials: 'Correo o contraseña incorrectos. Revisa tus datos o pulsa «Olvidé mi contraseña».',
    email_not_confirmed: 'Confirma tu correo electrónico antes de ingresar.',
    email_address_invalid: 'Escribe un correo electrónico válido.',
    over_email_send_rate_limit: 'Se enviaron varios correos. Espera unos minutos antes de solicitar otro.',
    over_request_rate_limit: 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
    email_address_not_authorized: 'El servicio de correo no permite enviar a esta cuenta. Contacta al administrador.',
    otp_expired: 'El enlace venció o ya fue utilizado. Solicita uno nuevo.',
    same_password: 'Elige una contraseña diferente de la anterior.',
    weak_password: 'Elige una contraseña más segura, de al menos 8 caracteres.'
  };
  if (authErrors[error?.code]) return authErrors[error.code];
  if (error?.code === '42501') return 'Tu cuenta no tiene permisos para esta operación.';
  if (error?.code === '23505') return 'El identificador ya existe. Actualiza los datos y vuelve a intentarlo.';
  return error?.message || 'No se pudo conectar. Revisa tu conexión y vuelve a intentarlo.';
}
async function refreshData() {
  refreshRequested = true;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    do {
      refreshRequested = false;
      const generation = authGeneration;
      const snapshot = await repository.snapshot();
      if (generation !== authGeneration || !currentUserId) {
        if (currentUserId) refreshRequested = true;
        continue;
      }
      await loadReqs(snapshot);
      await loadDocs(snapshot);
      clearPreviousCargoCache();
      populateYearOptions();
      renderReqs(); renderDocs();
      if(isAdmin) {
        void refreshGoogleSync();
        if (document.getElementById('preparedImSheet').open) void reloadPreparedImDetail();
        if(appReady) {
          void reloadPreparedImSummary();
          void reloadRequestedIM();
          void reloadShippedBoxesSummary();
        }
      }
      const selected = document.getElementById('f_cajaAsignada').value;
      populateCajaAsignadaOptions(selected);
      dataReady = true;
      if (channelReady) setStatus('Conectado en línea — Sincronizado', 'online');
      else setStatus('Datos actualizados — Conectando en tiempo real');
      setAvailability();
    } while (refreshRequested && currentUserId);
  })();
  try { return await refreshPromise; }
  finally { refreshPromise = null; }
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try { await refreshData(); }
    catch (error) { dataReady = false; setStatus(`Sincronización pendiente: ${readableError(error)}`, 'error'); }
  }, 200);
}
async function runMutation(button, action, messageId = 'msgGuardado') {
  if (!appReady || !isAdmin || mutationBusy) return;
  if (isPreview) { alert('Esta es una vista previa. No se guardarán cambios hasta tu visto bueno.'); return; }
  mutationBusy = true;
  setAvailability();
  if (button) button.disabled = true;
  setStatus('Guardando en línea…');
  try {
    await action();
    try { await refreshData(); }
    catch { dataReady = false; setStatus('Guardado en línea — Actualización pendiente', 'error'); }
  } catch (error) {
    message(messageId, readableError(error), true);
    setStatus('No se pudo guardar — Revisa el mensaje del formulario', 'error');
  } finally {
    mutationBusy = false;
    setAvailability();
  }
}

let reqs = [];
let editingReqId = null;
let editingReqVersion = null;

let docs = [];
let editingDocId = null;
let editingDocVersion = null;
let currentSustentoImagen = '';
let lastFiltered = [];

const fmtNum = n => (Number(n)||0).toLocaleString('es-PE');
const computeReqEstado = r => reqEstado(r, docs);
const computeDocEstado = d => docEstado(d);
// ================= REQUERIMIENTOS =================
function cajasUsadas(reqId){ return docs.filter(d=>d.cajaAsignada===reqId).length; }

function updateReqCondFields(){
  const tipo = document.getElementById('rq_tipo').value;
  const esCajasNuevas = tipo === 'Cajas nuevas para acondicionar';
  const esPrestamo = tipo === 'Préstamo de Cajas (búsqueda de documentos)';
  document.getElementById('rq_wrap_cantidad').hidden = !esCajasNuevas;
  document.getElementById('rq_wrap_cargos').hidden = esCajasNuevas;
  document.getElementById('rq_wrap_devolucion').hidden = !esPrestamo;
}
document.getElementById('rq_tipo').addEventListener('change', updateReqCondFields);

function reqBadgeClass(estado){
  return {'Solicitado':'b-solicitado','Recibido':'b-recibido','Completado':'b-completado','Prestado':'b-prestado','Devuelto':'b-completado'}[estado]||'';
}

async function loadReqs(snapshot){
  const data = snapshot || await repository.snapshot();
  reqs = data.requerimientos.map(reqFromDb);
}
function renderReqs(){
  const query=document.getElementById('buscarReq').value;
  const filtered=filterRequirements(reqs,docs,query);
  document.getElementById('conteoReq').textContent=`${filtered.length} de ${reqs.length} requerimientos`;
  const enriched = filtered.map(r => ({...r, estado: computeReqEstado(r), usadas: cajasUsadas(r.id)}));
  const tbody = document.getElementById('tbodyReq');
  if(enriched.length === 0){
    tbody.innerHTML = `<tr><td colspan="10" class="empty">Sin requerimientos registrados.</td></tr>`;
  } else {
    tbody.innerHTML = enriched.sort((a,b)=>b.numero.localeCompare(a.numero)).map(r=>{
      const esCajasNuevas = r.tipo === 'Cajas nuevas para acondicionar';
      const cantCargosTxt = esCajasNuevas ? (r.cantidadCajas||'') : (r.numerosCargo||'');
      const usadasTxt = esCajasNuevas ? (r.usadas + (r.cantidadCajas?(' / '+r.cantidadCajas):'')) : '—';
      return `<tr>
        <td>${highlightMatch(r.numero,query)}</td>
        <td>${escapeHtml(r.tipo)}</td>
        <td>${fmtDate(r.fechaSolicitud)}</td>
        <td>${escapeHtml(cantCargosTxt)}</td>
        <td>${fmtDate(r.fechaRecepcion)}</td>
        <td>${fmtDate(r.fechaDevolucion)}</td>
        <td>${usadasTxt}</td>
        <td><span class="badge ${reqBadgeClass(r.estado)}">${r.estado}</span></td>
        <td>${escapeHtml(r.usuario||'')}</td>
        <td>
          ${isAdmin ? `<button class="link" data-edit="${r.id}">Editar</button>
          <button class="danger" data-id="${r.id}">Eliminar</button>` : 'Solo consulta'}
        </td>
      </tr>`;
    }).join('');
  }
  tbody.querySelectorAll('button.danger').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const enUso = docs.some(d => d.cajaAsignada === btn.dataset.id);
      const question = enUso ? 'Este requerimiento tiene documentos asignados. Si lo eliminas, esos documentos quedarán sin asignar. ¿Continuar?' : '¿Eliminar este requerimiento?';
      if(!confirm(question)) return;
      await runMutation(btn, async ()=>{
        const current = reqs.find(r=>r.id===btn.dataset.id);
        await repository.remove('requerimientos', current);
        if(editingReqId === current.id) cancelarEdicionReq();
      }, 'msgReq');
    });
  });
  tbody.querySelectorAll('button.link[data-edit]').forEach(btn=>{
    btn.addEventListener('click', ()=> cargarReqParaEditar(btn.dataset.edit));
  });
}

function cargarReqParaEditar(id){
  const r = reqs.find(x=>x.id===id);
  if(!r) return;
  editingReqId = id;
  editingReqVersion = r.updatedAt;
  document.getElementById('rq_tipo').value = r.tipo;
  document.getElementById('rq_fechaSolicitud').value = r.fechaSolicitud || '';
  document.getElementById('rq_cantidadCajas').value = r.cantidadCajas || '';
  document.getElementById('rq_numerosCargo').value = r.numerosCargo || '';
  document.getElementById('rq_fechaRecepcion').value = r.fechaRecepcion || '';
  document.getElementById('rq_fechaDevolucion').value = r.fechaDevolucion || '';
  document.getElementById('rq_usuario').value = r.usuario || '';
  updateReqCondFields();
  document.getElementById('reqFormTitle').textContent = 'Editar Requerimiento';
  document.getElementById('reqEditingBanner').style.display = 'block';
  document.getElementById('reqEditingNumero').textContent = r.numero;
  document.getElementById('btnGuardarReq').textContent = 'Guardar cambios';
  document.getElementById('btnCancelarReq').style.display = 'inline-block';
  document.getElementById('grp-requerimientos').open = true;
  document.getElementById('reqFormTitle').scrollIntoView({behavior:'smooth', block:'start'});
}
function cancelarEdicionReq(){
  editingReqId = null;
  editingReqVersion = null;
  document.getElementById('reqFormTitle').textContent = 'Nuevo Requerimiento';
  document.getElementById('reqEditingBanner').style.display = 'none';
  document.getElementById('btnGuardarReq').textContent = 'Guardar requerimiento';
  document.getElementById('btnCancelarReq').style.display = 'none';
  limpiarFormReq();
}
function limpiarFormReq(){
  ['rq_fechaSolicitud','rq_cantidadCajas','rq_numerosCargo','rq_fechaRecepcion','rq_fechaDevolucion'].forEach(id=> document.getElementById(id).value = '');
  document.getElementById('rq_tipo').value = 'Cajas nuevas para acondicionar';
  document.getElementById('rq_usuario').value = '';
  updateReqCondFields();
}
document.getElementById('btnCancelarReq').addEventListener('click', cancelarEdicionReq);

// Connected save handlers are registered below.

// ================= DOCUMENTOS =================
function docBadgeClass(estado){
  return {'Pendiente de Envío':'b-pendiente','En Proceso de Acondicionamiento':'b-proceso','Enviado a Iron Mountain':'b-enviado','Caja solicitada':'b-caja-solicitada','Caja preparada para envío':'b-proceso'}[estado]||'';
}

function populateCajaAsignadaOptions(currentValue){
  const sel = document.getElementById('f_cajaAsignada');
  const disponibles = reqs.filter(r => r.tipo === 'Cajas nuevas para acondicionar'
    && (computeReqEstado(r) === 'Recibido' || r.id === currentValue));
  sel.innerHTML = '<option value="">Sin asignar</option>' + disponibles.map(r=>
    `<option value="${r.id}">${escapeHtml(r.numero)} — ${computeReqEstado(r)} (${cajasUsadas(r.id)}/${r.cantidadCajas||'?'})</option>`
  ).join('');
  sel.value = currentValue || '';
}

async function loadDocs(snapshot){
  const data = snapshot || await repository.snapshot();
  docs = data.documentos.map(docFromDb);
}
// Total 2026 = cargos históricos del Excel + nuevos de la hoja nativa.
// Una factura adicional para el mismo cargo no aumenta el contador.
function cargoTotals2026(){
  const todos=new Set(),historicos=new Set(),nuevos=new Set();
  for(const d of docs) {
    if(cargoYear(d)!=='2026') continue;
    const origen=String(d.claveOrigen||'');
    for(const value of d.cargos||[]){
      const cargo=String(value??'').trim().replace(/\.0+$/,'').replace(/^0+(?=\d)/,'');
      if(!cargo)continue;
      todos.add(cargo);
      if(origen.startsWith('google-live|')) nuevos.add(cargo);
      else historicos.add(cargo);
    }
  }
  return {total:todos.size,historicos:historicos.size,
    nuevos:[...nuevos].filter(c=>!historicos.has(c)).length};
}

let monthlyCreatedSummary=null;
let monthlyCreatedView='months';
let monthlyComparedYears=null;
const monthlyCompareColors={
  2020:'#7e8999',2021:'#9464c9',2022:'#cb8832',
  2023:'#d96673',2024:'#a3a04c',2025:'#149b76',2026:'#2b7bdc'
};
function monthlyComparisonColor(year){
  return monthlyCompareColors[year]||['#c256b0','#169bb1','#9b7b36'][year%3];
}
function renderMonthlyYearChecks(summary){
  const control=document.getElementById('monthlyCreatedComparisonControls');
  const checks=document.getElementById('monthlyCreatedYearChecks');
  const years=summary.comparison.map(row=>row.year);
  if(monthlyComparedYears===null)monthlyComparedYears=new Set(years.slice(-2));
  monthlyComparedYears=new Set([...monthlyComparedYears].filter(year=>years.includes(year)));
  const identity=years.join(',');
  if(checks.dataset.years!==identity){
    checks.dataset.years=identity;
    checks.replaceChildren();
    for(const year of years.slice().reverse()){
      const label=document.createElement('label');
      label.className='monthly-created-compare-check';
      label.style.setProperty('--year-color',monthlyComparisonColor(year));
      const input=document.createElement('input');
      input.type='checkbox';input.value=String(year);
      input.checked=monthlyComparedYears.has(year);
      input.setAttribute('aria-label','Mostrar año '+year);
      const dot=document.createElement('span');dot.className='monthly-created-compare-swatch';dot.setAttribute('aria-hidden','true');
      const name=document.createElement('span');name.textContent=String(year);
      label.append(input,dot,name);
      checks.append(label);
    }
  }
  for(const input of checks.querySelectorAll('input')){
    input.checked=monthlyComparedYears.has(Number(input.value));
  }
  control.hidden=monthlyCreatedView!=='comparison';
}

const monthlyCreatedNames=['Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
function renderMonthlyCreatedDetail(){
  const sheet=document.getElementById('monthlyCreatedSheet');
  if(!sheet.open || !monthlyCreatedSummary)return;
  const data=monthlyCreatedSummary;
  const months=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const palette=['#778396','#338ae2','#e99a23','#10a999','#935ac9','#e25979','#be283c'];
  const color=year=>palette[(year-2020)%palette.length];
  const view=monthlyCreatedView;
  const compareControls=document.getElementById('monthlyCreatedComparisonControls');
  compareControls.hidden=view!=='comparison';
  if(view==='comparison')renderMonthlyYearChecks(data);
  for(const button of document.querySelectorAll('#monthlyCreatedSheet [data-detail-view]')){
    button.setAttribute('aria-selected',String(button.dataset.detailView===view));
  }
  const label=document.getElementById('monthlyCreatedSummaryLabel');
  const value=document.getElementById('monthlyCreatedSummaryValue');
  const heading=document.getElementById('monthlyCreatedChartTitle');
  const explanation=document.getElementById('monthlyCreatedExplanation');
  const surface=document.getElementById('monthlyCreatedChartSurface');
  const legend=document.getElementById('monthlyCreatedChartLegend');
  const lastYear=data.currentYear;
  let categories,lines,showLabels=false;
  if(view==='months'){
    categories=months.slice(0,data.currentMonth);
    lines=[{label:String(lastYear),color:color(lastYear),values:data.monthly.map(row=>row.count)}];
    showLabels=true;
    label.textContent=`Cargos realizados de enero a ${monthlyCreatedNames[data.currentMonth-1].toLowerCase()} de ${lastYear}`;
    value.textContent=fmtNum(data.monthlyTotal);
    heading.textContent=`Evolución mensual · ${lastYear}`;
    explanation.textContent=`Cada punto representa cargos únicos realizados en ese mes. Los meses futuros no aparecen. ${data.undatedInCurrentYear} cargos atribuidos a ${lastYear} no tienen una fecha original válida de ese mismo año y se muestran solo en el detalle anual.`;
  } else if(view==='years'){
    categories=data.annual.map(row=>String(row.year));
    lines=[{label:'Cargos por año',color:'#237fba',values:data.annual.map(row=>row.count)}];
    showLabels=true;
    label.textContent=`Cargos registrados de 2020 a ${lastYear}`;
    value.textContent=fmtNum(data.annualTotal);
    heading.textContent=`Evolución histórica · 2020–${lastYear}`;
    explanation.textContent='Cada punto muestra el total de cargos únicos por año de cargo. Los cargos sin fecha de mes válida siguen contándose en su año, igual que en el resumen anual.';
  } else {
    categories=months;
    lines=data.comparison
      .filter(row=>monthlyComparedYears.has(row.year))
      .map(row=>({label:String(row.year),color:monthlyComparisonColor(row.year),values:row.values}));
    label.textContent=`Comparación mensual · 2020 a ${lastYear}`;
    value.textContent=`${lines.length} de ${data.comparison.length} años`;
    heading.textContent=lines.length
      ? `Comparando: ${lines.map(row=>row.label).join(' y ')}`
      : 'Selecciona un año para visualizar';
    explanation.textContent='Cada color representa un año seleccionado. Pasa el cursor o pulsa un punto para ver los cargos exactos. Los meses futuros del año actual no se dibujan; los cargos sin fecha mensual válida solo figuran en el total anual.';
    if(lines.length===0){
      surface.replaceChildren();
      legend.replaceChildren();
      const empty=document.createElement('div');
      empty.className='monthly-created-compare-empty';
      const strong=document.createElement('strong');strong.textContent='No hay años seleccionados';
      const hint=document.createElement('span');hint.textContent='Marca uno o varios años para mostrar sus líneas.';
      empty.append(strong,hint);surface.append(empty);
      return;
    }
  }
  renderCargoLineChart(surface,legend,categories,lines,{showLabels});
}
document.getElementById('monthlyCreatedYearChecks').addEventListener('change',event=>{
  if(!event.target.matches('input[type="checkbox"]'))return;
  const year=Number(event.target.value);
  if(!Number.isInteger(year))return;
  if(event.target.checked)monthlyComparedYears.add(year);
  else monthlyComparedYears.delete(year);
  renderMonthlyCreatedDetail();
});
document.getElementById('monthlyCreatedRestoreYears').addEventListener('click',()=>{
  if(!monthlyCreatedSummary)return;
  monthlyComparedYears=new Set(monthlyCreatedSummary.comparison.slice(-2).map(row=>row.year));
  renderMonthlyCreatedDetail();
});
document.getElementById('btnMonthlyCreatedDetail').addEventListener('click',()=>{
  if(!appReady||!isAdmin)return;
  const sheet=document.getElementById('monthlyCreatedSheet');
  monthlyCreatedView='months';
  sheet.showModal();
  renderMonthlyCreatedDetail();
});
document.getElementById('btnCloseMonthlyCreated').addEventListener('click',()=>{
  document.getElementById('monthlyCreatedSheet').close();
});
for(const button of document.querySelectorAll('#monthlyCreatedSheet [data-detail-view]')){
  button.addEventListener('click',()=>{
    monthlyCreatedView=button.dataset.detailView;
    renderMonthlyCreatedDetail();
  });
}
document.getElementById('monthlyCreatedSheet').addEventListener('click',event=>{
  const sheet=event.currentTarget;
  if(event.target===sheet)sheet.close();
});

let monthlyShippedSummary=null;
let monthlyShippedFetchEpoch=0;
let monthlyShippedError='';
let monthlyShippedSelectedYear=null;
let imDashboardChartView='monthly',imDashboardYear=null;
function renderMonthlyShippedDetail(){
  const sheet=document.getElementById('monthlyShippedSheet');
  if(!sheet.open)return;
  const loadStatus=document.getElementById('imShippedLoadStatus');
  if(!monthlyShippedSummary){
    loadStatus.hidden=false;
    loadStatus.textContent=monthlyShippedError ||
      'Cargando el historial de cajas enviadas por mes y año…';
    document.getElementById('imShippedMonthChart').replaceChildren();
    document.getElementById('imShippedYearChart').replaceChildren();
    document.getElementById('imShippedTotalValue').textContent='—';
    document.getElementById('imShippedAverage').textContent='—';
    document.getElementById('imShippedLast').textContent='—';
    return;
  }
  loadStatus.hidden=true;
  const stats=monthlyShippedSummary;
  const yearSelect=document.getElementById('imShippedYearSelect');
  const allowedYears=stats.annual.filter(row=>row.count>0||row.year===stats.currentYear).map(row=>row.year);
  if(!allowedYears.includes(monthlyShippedSelectedYear))
    monthlyShippedSelectedYear=stats.annual.filter(item=>item.count>0).at(-1)?.year
      ?? stats.currentYear;
  const yearsKey=allowedYears.join(',');
  if(yearSelect.dataset.years!==yearsKey){
    yearSelect.replaceChildren();
    for(const year of allowedYears.slice().reverse()){
      const option=document.createElement('option');
      option.value=String(year);option.textContent=String(year);yearSelect.append(option);
    }
    yearSelect.dataset.years=yearsKey;
  }
  yearSelect.value=String(monthlyShippedSelectedYear);
  const row=stats.annual.find(item=>item.year===monthlyShippedSelectedYear);
  if(!row)return;
  const names=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const current=row.year===stats.currentYear;
  const monthlyLabels=names.slice(0,current?stats.currentMonth:12);
  document.getElementById('imShippedMonthTitle').textContent='Cajas enviadas por mes ('+row.year+')';
  renderImBarChart(document.getElementById('imShippedMonthChart'),monthlyLabels,
    row.months.slice(0,monthlyLabels.length),
    {accent:'#2da66b',emptyLabel:'Sin envíos IM registrados en '+row.year});
  document.getElementById('imShippedYearTitle').textContent=
    'Cajas enviadas por año (2020–'+stats.currentYear+')';
  renderImBarChart(document.getElementById('imShippedYearChart'),
    stats.annual.map(item=>String(item.year)),stats.annual.map(item=>item.count),
    {accent:'#3b9b62',emptyLabel:'No hay envíos IM con fecha registrada'});
  document.getElementById('imShippedTotalLabel').textContent='Total del año ('+row.year+')';
  document.getElementById('imShippedTotalValue').textContent=fmtNum(row.count);
  const periods=current?stats.currentMonth:12;
  const mean=periods?row.count/periods:0;
  document.getElementById('imShippedAverage').textContent=
    mean.toLocaleString('es-PE',{maximumFractionDigits:1});
  document.getElementById('imShippedAverageNote').textContent=
    'Cajas por mes ('+row.year+')';
  const last=row.latest?new Date(row.latest+'T12:00:00Z').toLocaleDateString('es-PE',
    {timeZone:'America/Lima',day:'numeric',month:'short',year:'numeric'}):'—';
  document.getElementById('imShippedLast').textContent=last;
  document.getElementById('imShippedLastNote').textContent=
    row.latest?'Última fecha de envío registrada':'Sin envíos registrados';
  document.getElementById('imShippedMethodNote').textContent=
    'Se cuenta una caja física única por mes de envío a Iron Mountain, no sus cargos. '+
    'Se incluyen envíos históricos y envíos actuales de Google Sheets. Prefijos T, TD y P no duplican una caja. '+
    'Las cajas sin fecha de envío no suman y los datos se recalculan tras sincronizar la hoja.';
}
document.getElementById('btnMonthlyShippedDetail').addEventListener('click',()=>{
  if(!appReady||!isAdmin)return;
  monthlyShippedSelectedYear=monthlyShippedSummary?.annual.filter(item=>item.count>0).at(-1)?.year
    ?? monthlyShippedSummary?.currentYear??null;
  document.getElementById('monthlyShippedSheet').showModal();
  renderMonthlyShippedDetail();
  // Leer el historial al abrir también, sin depender de que haya terminado
  // de cargar en segundo plano durante el inicio de sesión.
  void reloadShippedBoxesSummary();
});
document.getElementById('btnCloseMonthlyShipped').addEventListener('click',()=>{
  document.getElementById('monthlyShippedSheet').close();
});
document.getElementById('monthlyShippedSheet').addEventListener('click',event=>{
  if(event.target===event.currentTarget)event.currentTarget.close();
});
document.getElementById('imShippedYearSelect').addEventListener('change',event=>{
  monthlyShippedSelectedYear=Number(event.target.value);
  renderMonthlyShippedDetail();
});

// Dashboard de Envíos: la fuente autoritativa es la agregación de
// cajas físicas con fecha efectiva de envío; no se suman cargos.
function renderIMShippingDashboard(){
  const chart=document.getElementById('imDashChart');
  const note=document.getElementById('imDashChartNote');
  const yearSelect=document.getElementById('imDashYear');
  for(const button of document.querySelectorAll('[data-im-chart-view]')){
    button.setAttribute('aria-pressed',
      String(button.dataset.imChartView===imDashboardChartView));
  }
  document.getElementById('imDashYearWrap').hidden=imDashboardChartView!=='monthly';
  const stats=monthlyShippedSummary;
  const yearCount=document.getElementById('imDashYearCount');
  const currentCount=document.getElementById('imDashThisMonth');
  const totalCount=document.getElementById('imDashAllCount');
  if(!stats){
    currentCount.textContent='—';
    yearCount.textContent='—';
    totalCount.textContent='—';
    chart.replaceChildren();
    note.textContent=monthlyShippedError
      ||'Consultando envíos de cajas desde la base sincronizada…';
    return;
  }
  const years=stats.annual.map(item=>item.year);
  if(!years.includes(imDashboardYear))imDashboardYear=stats.currentYear;
  const optionsKey=years.join(',');
  if(yearSelect.dataset.years!==optionsKey){
    yearSelect.replaceChildren();
    for(const year of years.slice().reverse()){
      yearSelect.add(new Option(String(year),String(year)));
    }
    yearSelect.dataset.years=optionsKey;
  }
  yearSelect.value=String(imDashboardYear);
  const row=stats.annual.find(item=>item.year===imDashboardYear);
  if(!row)return;
  document.getElementById('imDashSelectedYearLabel').textContent=String(imDashboardYear);
  currentCount.textContent=fmtNum(stats.currentCount);
  yearCount.textContent=fmtNum(row.count);
  totalCount.textContent=fmtNum(stats.total);
  const months=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const monthly=imDashboardChartView==='monthly';
  document.getElementById('imDashChartTitle').textContent=
    monthly?'Cajas enviadas por mes · '+imDashboardYear:
      'Cajas enviadas por año';
  if(monthly){
    const length=imDashboardYear===stats.currentYear?stats.currentMonth:12;
    renderImBarChart(chart,months.slice(0,length),row.months.slice(0,length),
      {accent:'#c72c43',emptyLabel:'Sin envíos confirmados en '+imDashboardYear});
    note.textContent='Total '+imDashboardYear+': '+fmtNum(row.count)+
      ' cajas. Solo cuentan cajas con fecha efectiva de envío.';
  } else {
    renderImBarChart(chart,stats.annual.map(item=>String(item.year)),
      stats.annual.map(item=>item.count),
      {accent:'#c72c43',emptyLabel:'Sin envíos confirmados'});
    note.textContent='Histórico de '+fmtNum(stats.total)+
      ' cajas enviadas. Cada año corresponde a la fecha de salida de la caja.';
  }
}
document.getElementById('imDashYear').addEventListener('change',event=>{
  imDashboardYear=Number(event.target.value);
  renderIMShippingDashboard();
});
document.getElementById('imShippingDashboard').addEventListener('click',event=>{
  const button=event.target.closest('button[data-im-chart-view]');
  if(!button)return;
  imDashboardChartView=button.dataset.imChartView;
  renderIMShippingDashboard();
});
function renderIMBoxWorkspace(){
  const prepared=document.getElementById('imBoxesPrepared');
  const requested=document.getElementById('imBoxesRequested');
  prepared.textContent=preparedImSummary?fmtNum(preparedImSummary.cajas):'—';
  // No presentar registros de demostración como si fueran cajas reales.
  requested.textContent=requestedIMLoaded && !requestedIMError && !requestedDemo
    ?fmtNum(requestedIMData.length):'—';
}
document.getElementById('imBoxesOpenPrepared').addEventListener('click',openPreparedIm);
document.getElementById('imBoxesOpenRequested').addEventListener('click',()=>{
  document.getElementById('btnRequestedIMDetail').click();
});
document.getElementById('imBoxesOpenStats').addEventListener('click',()=>{
  document.getElementById('btnMonthlyShippedDetail').click();
});
document.getElementById('imBoxesOpenHistory').addEventListener('click',()=>{
  document.getElementById('btnOpenIronMountainHistorical').click();
});

async function reloadShippedBoxesSummary(){
  if(!isAdmin||!appReady||!currentUserId)return;
  const epoch=++monthlyShippedFetchEpoch,generation=authGeneration;
  try{
    const rows=await repository.shippedIMBoxesMonthly();
    if(epoch!==monthlyShippedFetchEpoch||generation!==authGeneration||!appReady||!isAdmin)return;
    if(!Array.isArray(rows))throw new Error('Respuesta inválida de envíos mensuales IM');
    monthlyShippedSummary=summarizeShippedBoxes(rows,new Date());
    monthlyShippedError='';
  }catch(error){
    if(epoch!==monthlyShippedFetchEpoch||generation!==authGeneration||!appReady||!isAdmin)return;
    monthlyShippedSummary=null; // No confundir una lectura fallida con cero envíos.
    monthlyShippedError='No se pudo cargar el historial IM: '+readableError(error)+
      '. Vuelve a abrir «Ver detalle» para reintentar.';
  }
  renderMonthlyCargoStats();
  renderIMShippingDashboard();
}
function renderMonthlyCargoStats(){
  if(!isAdmin)return;
  const month=limaDate(new Date()).slice(0,7);
  const monthOf=value=>{
    const raw=String(value||'').trim();
    if(/^\d{4}-\d{2}-\d{2}/.test(raw))return raw.slice(0,7);
    const parts=raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    return parts ? `${parts[3]}-${parts[2].padStart(2,'0')}` : '';
  };
  const created=new Set(),requested=new Set();
  const addCargos=(bucket,d)=>{
    for(const raw of d.cargos||[]){
      const code=String(raw||'').trim().replace(/\.0+$/,'').replace(/^0+(?=\d)/,'').toUpperCase();
      if(code)bucket.add(`${cargoYear(d)}:${code}`);
    }
  };
  for(const d of docs){
    if(monthOf(d.fechaOrigen)===month || monthOf(d.fechaRegistro)===month)
      addCargos(created,d);
  }
  for(const r of reqs){
    if(monthOf(r.fechaSolicitud)!==month)continue;
    for(const code of String(r.numerosCargo||'').match(/\d+[A-Za-z]?/g)||[])
      requested.add(code.replace(/^0+(?=\d)/,'').toUpperCase());
  }
  const periodNode=document.getElementById('monthlyCargoPeriod');
  periodNode.dataset.month=month;
  periodNode.textContent=
    new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',month:'long',year:'numeric'}).format(new Date());
  monthlyCreatedSummary=summarizeCreatedCargos(docs,new Date());
  renderCreatedDashboard(monthlyCreatedSummary);
  document.getElementById('monthlyCargosCreated').textContent=fmtNum(monthlyCreatedSummary.currentCount);
  document.getElementById('monthlyCreatedNote').textContent=`Durante el mes (${monthlyCreatedNames[monthlyCreatedSummary.currentMonth-1].toLowerCase()})`;
  renderMonthlyCreatedDetail();
  document.getElementById('monthlyCargosShipped').textContent=monthlyShippedSummary
    ? fmtNum(monthlyShippedSummary.currentCount):'—';
  renderMonthlyShippedDetail();
  document.getElementById('monthlyCargosRequested').textContent=
    requestedIMLoaded && !requestedIMError ? fmtNum(requestedIMData.length):'—';
  document.getElementById('requestedIMNote').textContent=requestedDemo?'Datos de ejemplo · No son registros reales':
    requestedIMError?'No se pudo actualizar desde Google Sheets':
      requestedIMLoaded ? fmtNum(countRequestedCargos(requestedIMData))+' cargos'
        :'Consultando cajas y cargos pendientes…';
  renderIMShippingDashboard();
  renderIMBoxWorkspace();
}
function renderDocs(){
  const filters=appliedFilters;
  const search=filters.query;
  const enriched = docs.map(d => ({...d, ...computeDocEstado(d)}));

  const cargosDe = arr => arr.reduce((s,d)=> s + (d.cargos||[]).length, 0);
  const foliosDe = arr => arr.reduce((s,d)=> s + (parseInt(d.folios,10)||0), 0);

  const totalCargos = cargosDe(enriched);
  const totalFolios = foliosDe(enriched);
  const grupoEnviado = enriched.filter(d=>d.estado==='Enviado a Iron Mountain');
  const grupoProceso = enriched.filter(d=>d.estado==='En Proceso de Acondicionamiento');
  const grupoPendiente = enriched.filter(d=>d.estado==='Pendiente de Envío');
  const cargosEnviados = cargosDe(grupoEnviado);
  const cargosEnProceso = cargosDe(grupoProceso);
  const cargosPendientes = cargosDe(grupoPendiente), foliosPendientes = foliosDe(grupoPendiente);

  expiryGroups = cargoExpiryGroups(docs, new Date());
  renderDocumentExpiryWorkspace();
  renderHistoricalWorkspace();
  const grupoPorVencer = expiryGroups.upcoming;
  const grupoVencidos = expiryGroups.overdue;
  const cargosPorVencer = cargosDe(grupoPorVencer), foliosPorVencer = foliosDe(grupoPorVencer);
  const cargosVencidos = cargosDe(grupoVencidos), foliosVencidos = foliosDe(grupoVencidos);
  // Coincide exactamente con el detalle de cajas pendientes en la hoja IM.
  // El histórico de documentos no es la fuente de este indicador.
  const cajasPreparadas=preparedImSummary?.cajas;
  const cargosPreparados=preparedImSummary?.cargos;
  const baseAlerta = cargosPorVencer + cargosVencidos;

  const pct = (n, base) => base > 0 ? Math.round((n/base)*100) + '%' : '0%';

  // Historical Excel rows use anioOrigen rather than periodo; current 2026
  // rows are kept up to date in documentos by Google Sheets synchronization.
  const cargosPorAnio = new Map();
  enriched.forEach(d=>{
    const cantidad = (d.cargos||[]).length;
    if(!cantidad) return;
    const anioOrigen = cargoYear(d);
    const anio = /^\d{4}$/.test(anioOrigen) ? anioOrigen : 'Sin año';
    cargosPorAnio.set(anio, (cargosPorAnio.get(anio)||0) + cantidad);
  });
  // Mismos envíos confirmados que el KPI superior "Enviado Iron Mountain".
  // El agrupador es el año del cargo, no la fecha de su envío.
  const aniosEnviados=Array.from({length:7},(_,i)=>String(2020+i));
  const enviadosPorAnio=new Map(aniosEnviados.map(anio=>[anio,0]));
  for(const doc of grupoEnviado) {
    const year=cargoYear(doc);
    if(enviadosPorAnio.has(year))
      enviadosPorAnio.set(year,enviadosPorAnio.get(year)+(doc.cargos||[]).length);
  }
  const enviadosPorAnioHtml=aniosEnviados.map(anio=>
    `<div class="periodo-fila ${anio==='2026'?'year-current':''}">
      <span class="year-label">${anio}</span>
      <span class="year-value">${fmtNum(enviadosPorAnio.get(anio))} <span class="year-unit">cargos</span></span>
    </div>`
  ).join('');
  const conteo2026=cargoTotals2026();
  if(cargosPorAnio.has('2026')) cargosPorAnio.set('2026',conteo2026.total);
  const aniosOrdenados = [...cargosPorAnio.keys()].sort((a,b)=>
    a==='Sin año' ? 1 : b==='Sin año' ? -1 : Number(a)-Number(b));
  const porPeriodoHtml = aniosOrdenados.length
    ? aniosOrdenados.map(a=>`<div class="periodo-fila ${a==='2026'?'year-current':''}">
         <span class="year-label">${escapeHtml(a)}</span>
         <span class="year-value">${fmtNum(cargosPorAnio.get(a))} <span class="year-unit">cargos</span></span>
       </div>`).join('')
    : '<div class="year-empty">Sin cargos registrados</div>';

  document.getElementById('resumenTablas').innerHTML = `
    <div class="kpis" aria-label="Estado de todos los cargos">
      <div class="kpi kpi-color kpi-summary-total">
        <div class="l">Total de Cargos</div>
        <div class="n">${fmtNum(totalCargos)}<span class="folios-inline"> (${fmtNum(totalFolios)} folios)</span></div>
        <div class="pct-txt">${pct(totalCargos,totalCargos)}</div>
      </div>
      <div class="kpi kpi-color kpi-summary-sent">
        <div class="l">Enviado Iron Mountain</div>
        <div class="n">${fmtNum(cargosEnviados)}</div>
        <div class="pct-txt">${pct(cargosEnviados,totalCargos)}</div>
      </div>
      <div class="kpi kpi-color kpi-summary-process">
        <div class="l">En Proceso de Acondicionamiento</div>
        <div class="n">${fmtNum(cargosEnProceso)}</div>
        <div class="pct-txt">${pct(cargosEnProceso,totalCargos)}</div>
      </div>
      <div class="kpi kpi-color kpi-summary-pending">
        <div class="l">Pendiente de Envío a IM</div>
        <div class="n">${fmtNum(cargosPendientes)}<span class="folios-inline"> (${fmtNum(foliosPendientes)} folios)</span></div>
        <div class="pct-txt">${pct(cargosPendientes,totalCargos)}</div>
      </div>
    </div>
    <div class="resumen-titulo-alerta">Cargos de 2025 y 2026 pendientes de envío · Plazo de 6 meses</div>
    <div class="alerta-row">
      <div class="kpis" aria-label="Alertas de cargos pendientes">
        <div class="kpi kpi-color kpi-summary-expiring">
          <div class="expiry-card-heading"><div class="l">Cargos por Vencer</div><button id="btnCargosPorVencer" type="button" class="expiry-detail-button" data-expiry="upcoming" aria-label="Ver detalle de cargos por vencer" aria-haspopup="dialog" aria-controls="cargoExpirySheet">Ver detalle</button></div>
          <div class="n">${fmtNum(cargosPorVencer)}<span class="folios-inline"> (${fmtNum(foliosPorVencer)} folios)</span></div>
          <div class="pct-txt">${pct(cargosPorVencer,baseAlerta)}</div>
        </div>
        <div class="kpi kpi-color kpi-summary-overdue">
          <div class="expiry-card-heading"><div class="l">Cargos Vencidos</div><button id="btnCargosVencidos" type="button" class="expiry-detail-button" data-expiry="overdue" aria-label="Ver detalle de cargos vencidos" aria-haspopup="dialog" aria-controls="cargoExpirySheet">Ver detalle</button></div>
          <div class="n">${fmtNum(cargosVencidos)}<span class="folios-inline"> (${fmtNum(foliosVencidos)} folios)</span></div>
          <div class="pct-txt">${pct(cargosVencidos,baseAlerta)}</div>
        </div>
      </div>
    </div>
    <div class="prepared-row">
      <div class="kpi kpi-color kpi-summary-prepared" aria-label="Cajas preparadas para envío a Iron Mountain">
        <div class="expiry-card-heading">
          <div class="l">Caja preparada para envío</div>
          <button id="btnPreparedImDetail" type="button" class="expiry-detail-button" data-prepared-im="detail" aria-label="Ver detalle de cajas preparadas para envío" aria-haspopup="dialog" aria-controls="preparedImSheet">Ver detalle</button>
        </div>
        <div class="n" id="preparedImSummaryMetric">${cajasPreparadas == null?'—':fmtNum(cajasPreparadas)}<span class="folios-inline"> (${cargosPreparados == null?'—':fmtNum(cargosPreparados)} cargos)</span></div>
        <div class="pct-txt">Sin fecha de envío · todavía pendientes de Iron Mountain</div>
      </div>
    </div>
    ${expiryGroups.unknown.length ? `<p class="expiry-note">${fmtNum(cargosDe(expiryGroups.unknown))} cargos de 2025/2026 sin fecha válida para calcular el vencimiento; no se incluyen en estas alertas.</p>` : ''}
    <section class="year-section periodo-box" aria-labelledby="year-summary-heading">
      <h3 class="year-heading" id="year-summary-heading">Cargos por Año</h3>
      <div class="year-grid" id="yearSummaryGrid" aria-live="polite">${porPeriodoHtml}</div>
    </section>
    <section class="year-section periodo-box im-year-section" aria-labelledby="im-year-summary-heading">
      <h3 class="year-heading" id="im-year-summary-heading">Cargos Enviados a Iron Mountain por Año</h3>
      <div class="year-grid" id="imYearSummaryGrid" aria-live="polite">${enviadosPorAnioHtml}</div>
    </section>
  `;
  renderMonthlyCargoStats();
  if (activeExpiryGroup) renderCargoExpiry();

  let filtered=queryResults?.rows?.map(d=>({...d,...computeDocEstado(d)}))
    ?? filterDocuments(docs,reqs,filters).sort(showRandomCargos(filters)?randomCargoOrder:(a,b)=>b.kardex.localeCompare(a.kardex));
  lastFiltered=filtered;
  const pendingCargo=docs.filter(d=>!d.cargos?.length).length;
  const total=queryResults?.total??filtered.length;
  const folios=queryResults?.folios??filtered.reduce((sum,d)=>sum+(Number(d.folios)||0),0);
  // Solo cargos, Caja asignada y la lista inicial no muestran Ubicación.
  const showLocationColumn=!['solo-cargos','solo-cajas'].includes(filters.type) && !!search && !(filtered.length>0 &&
    filtered.every(d=>invoiceSearchPresentation(d,search).kind==='cargo'));
  const tableHead=document.querySelector('#docsTable thead tr');
  const existingLocationHead=document.getElementById('ubicacionHeader');
  if(showLocationColumn && !existingLocationHead){
    const locationHead=document.createElement('th');
    locationHead.id='ubicacionHeader';
    locationHead.textContent='Ubicación';
    tableHead.insertBefore(locationHead,tableHead.children[4]);
  } else if(!showLocationColumn && existingLocationHead){
    existingLocationHead.remove();
  }
  document.getElementById('conteoResultados').textContent=queryError
    || `${showRandomCargos(filters)?'Cargos aleatorios · ':''}${fmtNum(total)} registros${pendingCargo?` · ${fmtNum(pendingCargo)} registros pendientes de cargo`:''} · ${fmtNum(folios)} folios registrados`;
  document.getElementById('paginaActual').textContent=`Página ${currentPage+1} de ${Math.max(1,Math.ceil(total/PAGE_SIZE))}`;
  if(!queryResults)filtered=filtered.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE);

  const tbody = document.getElementById('tbody');
  if(filtered.length === 0){
    tbody.innerHTML = `<tr><td colspan="${showLocationColumn?13:12}" class="empty">${escapeHtml(queryError||'Sin registros que coincidan con la consulta actual.')}</td></tr>`;
  } else {
    tbody.innerHTML = filtered.map(d=>{
      const cajaTxt = d.imLiveCodigoCaja || assignedBoxCode(d,reqs) || '—';
      const fechaEnvioTxt = d.imLiveCodigoCaja ? d.imLiveFechaEnvio
        : d.imConfirmado ? d.imFechaEnvio : d.fEnvio;
      const responsableOrigen = d.imConfirmado ? d.imResponsable
        : d.imPreparado && d.imResponsablePreparacion ? d.imResponsablePreparacion : d.usuario;
      const responsableTxt = !String(responsableOrigen||'').trim() || /^importaci[oó]n excel$/i.test(String(responsableOrigen).trim())
        ? 'Sin Responsable' : responsableOrigen;
      const estadoTxt = d.estado==='Caja solicitada' ? 'Caja solicitada'
        : d.estado==='Caja preparada para envío' ? 'Caja preparada para envío'
        : d.imLiveFechaEnvio || d.imConfirmado ? 'Enviado'
        : d.imPreparado ? d.estado+' · Caja preparada' : d.estado;
      const invoiceView=['solo-cargos','solo-cajas'].includes(filters.type)
        ? {...invoiceSearchPresentation(d,''),kind:'cargo',codes:[]}
        : invoiceSearchPresentation(d,search);
      const matchedInvoiceCodes=invoiceView.kind==='invoice'?invoiceView.codes.map(normalizeSearch):[];
      const cachedPrevious=previousCargoCache.get(d.id);
      const previousCargoHtml=cachedPrevious?.signature===previousCargoSignature(d)
        ? previousCargoMarkup(cachedPrevious.items,matchedInvoiceCodes)
        : repository?.previousCargos ? '<span class="previous-cargo-pending">Consultando…</span>'
        : '<span class="previous-cargo-none">—</span>';
      // Do not calculate group locations unless the document-code column is visible.
      const groupLocation=showLocationColumn && invoiceView.kind!=='cargo'
        ? (d.ubicacionesCodigo
          ? locationLabel(groupsForCodes(d.ubicacionesCodigo,
              invoiceView.kind==='invoice'?invoiceView.codes:Object.keys(d.ubicacionesCodigo)))
          : d.errorUbicacion || 'Consultando grupo…')
        : '';
      const invoiceCell=invoiceView.kind==='invoice'
        ? invoiceView.codes.map(code=>`<div>${highlightMatch(code,search)}</div>`).join('')
        : invoiceView.kind==='browse'
          ? invoiceView.codes.map(code=>`<div>${escapeHtml(code)}</div>`).join('')
            + (invoiceView.total ? `<span class="origin-label">${fmtNum(invoiceView.total)} códigos en este registro</span>` : '')
          : `<span class="invoice-count">${fmtNum(invoiceView.total)} códigos en este registro</span>`;
      return `<tr>
        <td>${highlightMatch(d.kardex,search)}</td>
        <td>${fmtDate(d.fechaRegistro)}</td>
        <td>${escapeHtml(d.tipoDoc||'')}</td>
        <td>${escapeHtml(cargoYear(d))}</td>
        ${showLocationColumn ? `<td>${escapeHtml(groupLocation)}</td>` : ''}
        <td>${highlightMatch((d.cargos||[]).join(', ')||'Sin cargo asignado',search)}</td>
        <td class="invoice-results">${invoiceCell}</td>
        <td>${highlightMatch(cajaTxt,search)}</td>
        <td>${fmtDate(fechaEnvioTxt)}</td>
        <td><span class="badge ${docBadgeClass(d.estado)}">${escapeHtml(estadoTxt)}</span></td>
        <td class="previous-cargo-cell" data-previous-cargo-id="${escapeHtml(d.id)}" data-matched-invoice-codes="${escapeHtml(matchedInvoiceCodes.join(','))}">${previousCargoHtml}</td>
        <td>${highlightMatch(responsableTxt||'',search)}</td>
        <td>
          <button class="secondary" data-export-cargo="${d.id}" ${!d.cargos?.length?'disabled title="Este registro no tiene cargo asignado"':''}>Exportar este cargo</button>
          ${isAdmin ? `<button class="link" data-edit="${d.id}">Editar</button>
          <button class="danger" data-id="${d.id}">Eliminar</button>` : 'Solo consulta'}
        </td>
      </tr>`;
    }).join('');
    fetchPreviousCargos(filtered);
  }

  tbody.querySelectorAll('button.danger').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if(!confirm('¿Eliminar el registro ' + docs.find(d=>d.id===btn.dataset.id).kardex + '?')) return;
      await runMutation(btn, async ()=>{
        const current = docs.find(d=>d.id===btn.dataset.id);
        await repository.remove('documentos', current);
        if(editingDocId === current.id) cancelarEdicionDoc();
      });
    });
  });
  tbody.querySelectorAll('button.link[data-edit]').forEach(btn=>{
    btn.addEventListener('click', ()=> cargarDocParaEditar(btn.dataset.edit));
  });
  tbody.querySelectorAll('[data-export-cargo]').forEach(button=>{
    button.addEventListener('click',()=>exportCargo(button.dataset.exportCargo,button));
  });
  tbody.querySelectorAll('button.link[data-image]').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      btn.disabled=true;
      try {
        const d=docs.find(x=>x.id===btn.dataset.image);
        const image=d?.sustentoImagen||await repository.fetchImage(btn.dataset.image);
        if(!image)throw new Error('La imagen de sustento ya no está disponible.');
        document.getElementById('sustentoViewerImage').src=image;
        document.getElementById('sustentoViewer').showModal();
      } catch(error){document.getElementById('conteoResultados').textContent=readableError(error);}
      finally{btn.disabled=false;}
    });
  });
}


function closePreparedIm() {
  const dialog=document.getElementById('preparedImSheet');
  preparedImFetchEpoch++;
  preparedImRows=[];
  if (dialog.open) dialog.close();
  document.getElementById('preparedImSearch').value='';
  document.getElementById('preparedImList').textContent='';
  document.getElementById('preparedImCount').textContent='';
}
function renderPreparedImDetail() {
  const dialog=document.getElementById('preparedImSheet');
  if(!dialog.open || !isAdmin) return;
  const input=document.getElementById('preparedImSearch');
  const filter=input.value.trim().toLocaleLowerCase('es-PE');
  const rows=preparedImRows.filter(b=>!filter || [
    b.codigo_caja,b.numeros_cargos,b.clasificacion_caja,...(b.cargos||[]),b.responsable_preparacion,
    b.responsable_entrega,b.responsable_recibe,b.placa_transporte
  ].some(x=>String(x||'').toLocaleLowerCase('es-PE').includes(filter)));
  const totalCargos=new Set(rows.flatMap(b=>(b.cargos||[]).map(c=>String(c)))).size;
  const totalCajas=new Set(rows.map(b=>String(b.codigo_caja||'').trim()).filter(Boolean)).size;
  document.getElementById('preparedImCount').textContent=
    `${fmtNum(totalCajas)} cajas · ${fmtNum(totalCargos)} cargos sin envío${filter?' · Filtro aplicado':''}`;
  const field=(name,value,fallback='Pendiente')=>
    `<div><dt>${name}</dt><dd>${String(value||'').trim()
      ?escapeHtml(String(value)):`<span class="prepared-im-empty">${fallback}</span>`}</dd></div>`;
  document.getElementById('preparedImList').innerHTML=rows.length?rows.map(b=>{
    const row=Number(b.sheet_row);
    const url=Number.isSafeInteger(row)&&row>=2?
      `https://docs.google.com/spreadsheets/d/1aWqIoj5UXAeyKhNN1paoYnTa4jdfN8LhDEcdH_lQ4mk/edit#gid=434059467&range=A${row}:J${row}`:
      'https://docs.google.com/spreadsheets/d/1aWqIoj5UXAeyKhNN1paoYnTa4jdfN8LhDEcdH_lQ4mk/edit';
    return `<article class="prepared-im-box">
      <div class="prepared-im-head">
        <div><strong>Caja ${escapeHtml(b.codigo_caja||'Sin código')}</strong>
          <div class="prepared-im-sub">Cargos: ${escapeHtml((b.cargos||[]).join(', ')||b.numeros_cargos||'Sin cargos')}</div></div>
        <span class="prepared-im-state">${/por\s+solicitud/i.test(String(b.clasificacion_caja||''))?'Caja solicitada':'Pendiente de envío'}</span>
      </div>
      <dl class="prepared-im-fields">
        ${field('N°',b.numero,'Sin número')}
        ${field('Fecha de preparación de cajas',b.fecha_preparacion?fmtDate(b.fecha_preparacion):'')}
        ${field('Responsable de preparación',b.responsable_preparacion)}
        ${field('Código de barras de cajas',b.codigo_caja)}
        ${field('Número de cargos',b.numeros_cargos||(b.cargos||[]).join('-'))}
        ${field('Clasificación de caja',b.clasificacion_caja,'Sin clasificar')}
        ${field('Fecha de envío a Iron Mountain',b.fecha_envio?fmtDate(b.fecha_envio):'','Sin registrar')}
        ${field('Responsable en entregar',b.responsable_entrega)}
        ${field('Responsable en recibir de I. M.',b.responsable_recibe)}
        ${field('Placa de unidad de transporte',b.placa_transporte)}
      </dl>
      <div class="prepared-im-actions">
        <a class="excel-link-button" href="${url}" target="_blank" rel="noopener noreferrer">Abrir fila ${Number.isSafeInteger(row)&&row>=2?row:'en Excel'} para completar envío</a>
      </div>
    </article>`;
  }).join(''):'<p class="prepared-im-message">No hay cajas preparadas que coincidan con esta búsqueda.</p>';
}
// Refresca el KPI usando la misma consulta que alimenta «Ver detalle».
// Así los envíos con fecha dejan de contarse aunque no aparezcan en el Kardex histórico.
async function reloadPreparedImSummary() {
  if(!appReady || !isAdmin)return;
  const epoch=++preparedImSummaryEpoch, generation=authGeneration;
  try {
    const rows=await repository.preparedImDetails();
    if(epoch!==preparedImSummaryEpoch || generation!==authGeneration || !appReady || !isAdmin)return;
    preparedImSummary=summarizePreparedIm(Array.isArray(rows)?rows:[]);
  } catch(error) {
    if(epoch!==preparedImSummaryEpoch || generation!==authGeneration || !appReady || !isAdmin)return;
    preparedImSummary=null; // No presentar una cantidad anterior como actual.
  }
  const metric=document.getElementById('preparedImSummaryMetric');
  if(metric)metric.innerHTML=
    `${preparedImSummary?fmtNum(preparedImSummary.cajas):'—'}`+
    `<span class="folios-inline"> (${preparedImSummary?fmtNum(preparedImSummary.cargos):'—'} cargos)</span>`;
  renderIMBoxWorkspace();
}
async function reloadPreparedImDetail() {
  const dialog=document.getElementById('preparedImSheet');
  if(!dialog.open || !appReady || !isAdmin) return;
  const epoch=++preparedImFetchEpoch;
  document.getElementById('preparedImCount').textContent='Consultando registros sin fecha de envío…';
  try{
    const raw=await repository.preparedImDetails();
    if(epoch!==preparedImFetchEpoch || !dialog.open || !appReady || !isAdmin) return;
    preparedImRows=Array.isArray(raw)?raw:[];
    renderPreparedImDetail();
  }catch(error){
    if(epoch!==preparedImFetchEpoch || !dialog.open) return;
    document.getElementById('preparedImCount').textContent='';
    document.getElementById('preparedImList').textContent='No se pudo consultar el detalle: '+readableError(error);
  }
}
function openPreparedIm() {
  if(!appReady || !isAdmin) return;
  const dialog=document.getElementById('preparedImSheet');
  if(!dialog.open)dialog.showModal();
  document.getElementById('preparedImList').textContent='Consultando cajas preparadas…';
  void reloadPreparedImDetail();
}
function closeRequestedIM(){
  ++requestedIMFetchEpoch;
  const modal=document.getElementById('requestedIMSheet');
  if(modal.open)modal.close();
}
function renderRequestedIM(){
  const panel=document.getElementById('requestedIMList');
  if(!isAdmin)return;
  const count=countRequestedCargos(requestedIMData);
  document.getElementById('requestedIMCount').textContent=
    requestedIMData.length+' cajas · '+count+' cargos distintos'+(requestedDemo?' · DEMO / DATOS DE EJEMPLO':'');
  document.getElementById('requestedIMRule').textContent=requestedDemo
    ? 'Vista de ejemplo. No son registros reales ni se modifica Google Sheets.'
    : 'Clasificación «Por solicitud» registrada en Google Sheets, comparada con los cargos del Kardex.';
  panel.innerHTML=requestedIMData.length?requestedIMData.map(box=>'<article class="prepared-im-box">'+
    '<div class="prepared-im-head"><div><strong>Caja '+escapeHtml(box.codigo)+'</strong>'+
    '<div class="prepared-im-sub">'+box.cargos.length+' cargos · '+box.coincidencias+
      ' coincidencias con Kardex · '+box.revisar+' por revisar</div></div>'+
    '<span class="prepared-im-state">Caja solicitada</span></div>'+
    '<details><summary>Ver cargos asociados ('+box.cargos.length+')</summary>'+
    '<div class="prepared-im-sub">'+box.cargos.map(c=>'<div>Cargo <strong>'+escapeHtml(c.cargo)+
      '</strong> · '+(c.match?'Coincide con Kardex '+escapeHtml(c.kardex):'Revisar: '+escapeHtml(c.issue))+
      '</div>').join('')+'</div></details></article>').join('')
    :'<p class="prepared-im-message">'+(requestedIMError?
      'La lectura de clasificación aún no está habilitada: '+escapeHtml(requestedIMError):
      'No hay cajas «Por solicitud» pendientes de envío en la información sincronizada.')+'</p>';
}
async function reloadRequestedIM(){
  if(!isAdmin||!appReady)return;
  const epoch=++requestedIMFetchEpoch;
  try{
    requestedIMError='';
    requestedIMRows=requestedDemo?[
      {codigo_caja:'T990000001',codigo_cargo:'0933',clasificacion_caja:'Por solicitud'},
      {codigo_caja:'TD990000001',codigo_cargo:'0934',clasificacion_caja:'Por solicitud'},
      {codigo_caja:'P990000002',codigo_cargo:'0935',clasificacion_caja:'Por solicitud'}
    ]:await repository.requestedIMDetails();
    if(epoch!==requestedIMFetchEpoch||!isAdmin)return;
    requestedIMData=requestedIMBoxes(requestedIMRows,docs);
    requestedIMLoaded=true;
  }catch(error){
    if(epoch!==requestedIMFetchEpoch)return;
    requestedIMRows=[];requestedIMData=[];requestedIMLoaded=false;
    requestedIMError='Se necesita activar la actualización de Supabase y Apps Script para la nueva columna.';
  }
  renderMonthlyCargoStats();
  if(document.getElementById('requestedIMSheet').open)renderRequestedIM();
}
document.getElementById('btnRequestedIMDetail').addEventListener('click',()=>{
  if(!isAdmin||!appReady)return;
  const modal=document.getElementById('requestedIMSheet');
  if(!modal.open)modal.showModal();
  document.getElementById('requestedIMCount').textContent='Consultando solicitudes actualizadas…';
  document.getElementById('requestedIMList').textContent='Actualizando registros de Google Sheets…';
  void reloadRequestedIM();
});
document.getElementById('btnRefreshRequestedIM').addEventListener('click',()=>{
  requestedIMError='';void reloadRequestedIM();
});
document.getElementById('btnCloseRequestedIM').addEventListener('click',closeRequestedIM);
document.getElementById('btnClosePreparedIm').addEventListener('click',closePreparedIm);
document.getElementById('preparedImSheet').addEventListener('close',()=>{
  preparedImFetchEpoch++;
  preparedImRows=[];
  document.getElementById('preparedImSearch').value='';
  document.getElementById('preparedImList').textContent='';
  if(appReady && isAdmin) document.getElementById('btnPreparedImDetail')?.focus();
});
document.getElementById('preparedImSearch').addEventListener('input',renderPreparedImDetail);
document.getElementById('btnPreparedImRefresh').addEventListener('click',()=>void reloadPreparedImDetail());

function closeCargoExpiry() {
  const sheet = document.getElementById('cargoExpirySheet');
  if (sheet.open) sheet.close();
  activeExpiryGroup = null;
  expiryPage = 0;
  document.getElementById('cargoExpiryBody').textContent = '';
  document.getElementById('cargoExpiryCount').textContent = '';
  document.getElementById('cargoExpiryUnknown').textContent = '';
}
function renderCargoExpiry() {
  if (!isAdmin || !activeExpiryGroup) return;
  const overdue = activeExpiryGroup === 'overdue';
  const count = rows => rows.reduce((sum,doc) => sum + doc.cargos.length, 0);
  const rows = expiryGroups[activeExpiryGroup].flatMap(doc => doc.cargos.map(cargo => ({doc, cargo})));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  expiryPage = Math.min(expiryPage, pages - 1);
  document.getElementById('cargoExpiryTitle').textContent = overdue ? 'Cargos Vencidos' : 'Cargos por Vencer';
  document.getElementById('cargoExpiryTimeHeading').textContent = overdue ? 'Tiempo vencido' : 'Falta para vencer';
  document.getElementById('cargoExpiryLegend').hidden = overdue;
  const start = expiryPage * PAGE_SIZE;
  const selected = rows.slice(start, start + PAGE_SIZE);
  document.getElementById('cargoExpiryCount').textContent = `Al ${fmtDate(expiryGroups.today)} · ${fmtNum(rows.length)} cargos${rows.length ? ` · Mostrando ${fmtNum(start + 1)}–${fmtNum(start + selected.length)}` : ''} · Ordenados por fecha de vencimiento`;
  document.getElementById('cargoExpiryBody').innerHTML = selected.length ? selected.map(({doc, cargo}) => {
    const expiry = doc.expiry;
    const remaining = !overdue && expiry.dueDate === expiryGroups.today ? '0 meses · Cumple 6 meses hoy' : formatCargoDuration(expiry.time);
    const signal = overdue ? 'Vencido' : {green:'Hasta 3 meses',yellow:'Más de 3 meses',red:'Últimos 7 días'}[expiry.color];
    return `<tr>
      <td class="expiry-cargo">${escapeHtml(cargo)}</td><td>${escapeHtml(expiry.year)}</td><td>${escapeHtml(doc.kardex)}</td>
      <td>${fmtDate(expiry.baseDate)}</td><td>${fmtDate(expiry.dueDate)}</td><td>${formatCargoDuration(expiry.age)}</td>
      <td><span class="expiry-status expiry-${expiry.color}">${remaining}<small>${signal}</small></span></td>
      <td><span class="badge ${docBadgeClass(doc.estado)}">${escapeHtml(doc.estado)}</span></td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="empty">No hay cargos ${overdue ? 'vencidos' : 'por vencer'} de 2025 y 2026 pendientes de envío.</td></tr>`;
  const unknown = document.getElementById('cargoExpiryUnknown');
  unknown.hidden = !expiryGroups.unknown.length;
  unknown.textContent = expiryGroups.unknown.length
    ? `${fmtNum(count(expiryGroups.unknown))} cargos sin fecha válida no se incluyen en el cálculo. Cargos: ${expiryGroups.unknown.map(doc => `${doc.cargos.join(', ')} (${cargoYear(doc)})`).join('; ')}.` : '';
  document.getElementById('cargoExpiryPage').textContent = `Página ${expiryPage + 1} de ${pages}`;
  document.getElementById('btnExpiryPrevious').disabled = expiryPage === 0;
  document.getElementById('btnExpiryNext').disabled = expiryPage >= pages - 1;
}
// HISTÓRICO DOCUMENTAL · Consulta por año, sin inventar ubicaciones.
// Los documentos pueden proceder del archivo histórico y de la hoja viva.
// La unidad histórica es el registro Kardex/cargo. Dos Kardex distintos
// pueden tener el mismo código de cargo (p. ej. 0028 y 28 en 2024):
// se conservan ambos y no se borran registros de origen.
// Para un mismo Kardex y cargo se privilegia el dato sincronizado.
function historicalRows() {
  const selected=new Map();
  const reqNumbers=new Map(reqs.map(req=>[req.id,req.numero]));
  for(const doc of docs){
    const year=cargoYear(doc);
    if(!/^(202[0-6])$/.test(year))continue;
    const estado=computeDocEstado(doc).estado;
    const live=!!doc.imLiveCodigoCaja;
    const sent=estado==='Enviado a Iron Mountain';
    const box=assignedBoxCode(doc,reqNumbers);
    // La fuente viva tiene prioridad frente a duplicados históricos
    // para no marcar como enviados cargos solicitados o preparados.
    const rank=(live?10:0)+(sent?2:0)+(box?1:0);
    for(const rawCargo of doc.cargos||[]){
      const cargo=String(rawCargo??'').trim();
      const canonical=cargo.replace(/\.0+$/,'').replace(/^0+(?=\d)/,'');
      if(!canonical)continue;
      const key=year+'|'+String(doc.id||doc.kardex||'')+'|'+canonical;
      const record={year,cargo,canonical,doc,estado,sent,box,rank};
      const previous=selected.get(key);
      if(!previous || record.rank>previous.rank ||
        (record.rank===previous.rank &&
         String(record.doc.updatedAt||'')>String(previous.doc.updatedAt||''))){
        selected.set(key,record);
      }
    }
  }
  return [...selected.values()].sort((a,b)=>
    Number(b.year)-Number(a.year)
    ||String(a.doc.kardex||'').localeCompare(String(b.doc.kardex||''),'es',{numeric:true})
    ||a.cargo.localeCompare(b.cargo,'es',{numeric:true})
  );
}
function renderHistoricalWorkspace() {
  const root=document.getElementById('documentHistoryWorkspace');
  if(!root)return;
  const allRows=historicalRows();
  // Una sola selección de año; conservar cifras y cálculo original.
  const yearSelector=document.getElementById('historyYearSelect');
  yearSelector.value=historySelectedYear;
  const yearRows=allRows.filter(row=>row.year===historySelectedYear);
  document.getElementById('historyAllCount').textContent=fmtNum(allRows.length);
  document.getElementById('historySelectedYearLabel').textContent=historySelectedYear;
  document.getElementById('historyYearCount').textContent=fmtNum(yearRows.length);
  document.getElementById('historyDetailYear').textContent=historySelectedYear;
  const sentCount=yearRows.filter(r=>r.sent).length;
  const pendingCount=yearRows.length-sentCount;
  document.getElementById('historySentCount').textContent=fmtNum(sentCount);
  document.getElementById('historyPendingCount').textContent=fmtNum(pendingCount);
  // El micrográfico usa exactamente los mismos totales que las tarjetas.
  const percentage=yearRows.length ? (100*sentCount/yearRows.length) : 0;
  document.getElementById('historyShippingBar').style.width=percentage.toFixed(2)+'%';
  document.getElementById('historyShippingProgress').setAttribute('aria-label',
    'Enviados a Iron Mountain: '+fmtNum(sentCount)+' de '+fmtNum(yearRows.length)
    +' cargos ('+percentage.toFixed(1)+' %). Pendientes: '+fmtNum(pendingCount));
  const query=normalizeSearch(document.getElementById('historyQuery').value.trim());
  const status=document.getElementById('historyStatusFilter').value;
  const rows=yearRows.filter(row=>
    (!query || normalizeSearch(row.cargo).includes(query)
      || normalizeSearch(row.doc.kardex||'').includes(query))
    &&(status==='all'||(status==='sent')===row.sent)
  );
  const pages=Math.max(1,Math.ceil(rows.length/HISTORY_PAGE_SIZE));
  historyPage=Math.min(historyPage,pages-1);
  const first=historyPage*HISTORY_PAGE_SIZE;
  const visible=rows.slice(first,first+HISTORY_PAGE_SIZE);
  document.getElementById('historyTableBody').innerHTML=visible.length?visible.map(row=>{
    const {doc,cargo,box,sent}=row;
    const originalDate=/^\d{4}-\d{2}-\d{2}$/.test(doc.fechaOrigen||'')?fmtDate(doc.fechaOrigen):'—';
    const docType=String(doc.tipoDoc||'No registrado');
    return '<tr><td class="history-cargo-id">'+escapeHtml(cargo)+'</td>'
      +'<td>'+escapeHtml(String(doc.kardex||'—'))+'</td>'
      +'<td>'+escapeHtml(originalDate)+'</td>'
      +'<td>'+escapeHtml(docType)+'</td>'
      +'<td>'+escapeHtml(box||'No registrada')+'</td>'
      +'<td><span class="history-status'+(sent?' sent':'')+'">'+
        (sent?'Enviado IM':'Pendiente IM')+'</span></td>'
      +'<td><button type="button" class="history-open" data-history-cargo="'+
        escapeHtml(cargo)+'">Ver cargo</button></td></tr>';
  }).join(''):'<tr><td colspan="7" class="history-empty">No se encontraron cargos para la consulta seleccionada.</td></tr>';
  document.getElementById('historyListCount').textContent=rows.length
    ? 'Mostrando '+fmtNum(first+1)+'–'+fmtNum(first+visible.length)+' de '+fmtNum(rows.length)+' cargos'
    : '0 cargos encontrados';
  document.getElementById('historyPageLabel').textContent='Página '+(historyPage+1)+' de '+pages;
  document.getElementById('historyPreviousPage').disabled=historyPage===0;
  document.getElementById('historyNextPage').disabled=historyPage>=pages-1;
}
const historyRoot=document.getElementById('documentHistoryWorkspace');
historyRoot.addEventListener('click',event=>{
  const cargoButton=event.target.closest('button[data-history-cargo]');
  if(cargoButton){
    const cargo=cargoButton.dataset.historyCargo;
    selectWorkspaceTab('existencias');
    document.getElementById('btnLimpiarFiltros').click();
    document.getElementById('filtroTipo').value='solo-cargos';
    document.getElementById('buscar').value=cargo;
    searchNow();
    document.getElementById('grp-existencias').scrollIntoView({block:'start'});
  }
});
document.getElementById('historyYearSelect').addEventListener('change',event=>{
  historySelectedYear=event.currentTarget.value;
  historyPage=0;
  document.getElementById('historyQuery').value='';
  document.getElementById('historyStatusFilter').value='all';
  renderHistoricalWorkspace();
});
document.getElementById('historyQuery').addEventListener('input',()=>{
  historyPage=0;renderHistoricalWorkspace();
});
document.getElementById('historyStatusFilter').addEventListener('change',()=>{
  historyPage=0;renderHistoricalWorkspace();
});
document.getElementById('historyClearFilters').addEventListener('click',()=>{
  document.getElementById('historyQuery').value='';
  document.getElementById('historyStatusFilter').value='all';
  historyPage=0;renderHistoricalWorkspace();
});
document.getElementById('historyPreviousPage').addEventListener('click',()=>{
  historyPage=Math.max(0,historyPage-1);renderHistoricalWorkspace();
});
document.getElementById('historyNextPage').addEventListener('click',()=>{
  historyPage++;renderHistoricalWorkspace();
});

// Vista unificada de vencimientos. Usa la misma fuente del detalle heredado;
// 30 días es un subconjunto de los cargos que aún NO han superado 6 meses.
function documentExpiryRows() {
  const rows=[];
  const collect=(group,category)=>{
    for(const doc of group){
      for(const cargo of doc.cargos||[]){
        if(!String(cargo??'').trim())continue;
        const year=doc.expiry?.year || cargoYear(doc);
        rows.push({doc,cargo:String(cargo),year,category});
      }
    }
  };
  collect(expiryGroups.overdue,'overdue');
  collect(expiryGroups.upcoming.filter(d=>d.expiry.daysRemaining<=30),'soon');
  collect(expiryGroups.upcoming.filter(d=>d.expiry.daysRemaining>30),'valid');
  collect(expiryGroups.unknown,'unknown');
  return rows;
}
// Gráfica de vencimientos YA OCURRIDOS por año calendario de fecha límite.
// No confundir año de vencimiento con año de origen de cada cargo.
function renderMonthlyExpiryChart(yearRows,selectedRows) {
  const year=expiryChartYear;
  const names=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const monthKeys=names.map((_,i)=>year+'-'+String(i+1).padStart(2,'0'));
  const monthSelect=document.getElementById('expiryMonthChartMonth');
  if(monthSelect.dataset.year!==year){
    monthSelect.replaceChildren();
    monthSelect.add(new Option('Todos los meses','all'));
    monthKeys.forEach((key,i)=>monthSelect.add(new Option(names[i]+' '+year,key)));
    monthSelect.dataset.year=year;
  }
  monthSelect.value=expiryChartMonth;
  document.getElementById('expiryMonthChartYear').value=year;
  // Filtros del submenú: comparten el mismo año y mes del Dashboard.
  const detailMonth=document.getElementById('docExpiryDetailMonth');
  if(detailMonth.dataset.year!==year){
    detailMonth.replaceChildren();
    detailMonth.add(new Option('Todos los meses','all'));
    monthKeys.forEach((key,i)=>detailMonth.add(new Option(names[i]+' '+year,key)));
    detailMonth.dataset.year=year;
  }
  detailMonth.value=expiryChartMonth;
  document.getElementById('docExpiryDetailYear').value=year;
  // Solo vencidos: nunca proyectar cargos que se vencerán en meses futuros.
  const monthCounts=new Map();
  for(const row of yearRows){
    if(row.category!=='overdue')continue;
    const key=row.doc.expiry?.dueDate?.slice(0,7);
    if(!key)continue;
    monthCounts.set(key,(monthCounts.get(key)||0)+1);
  }
  const values=monthKeys.map(key=>monthCounts.get(key)||0);
  const labels=monthKeys.map((_,i)=>names[i]+' '+year.slice(2));
  const chart=document.getElementById('expiryMonthChartSurface');
  const legend=document.getElementById('expiryMonthChartLegend');
  // Ajustar el SVG al espacio real del panel, incluso con Chrome al 75%.
  const chartWidth=Math.max(760,Math.round(chart.getBoundingClientRect().width||930));
  const chartHeight=Math.max(380,Math.min(465,Math.round(chartWidth*0.29)));
  const chartFontSize=Math.max(13,Math.min(16,Math.round(chartWidth/105)));
  renderCargoLineChart(chart,legend,labels,[{
    label:'Cargos vencidos · '+year,color:'#c52540',values,width:3.4
  }],{
    width:chartWidth,
    height:chartHeight,fontSize:chartFontSize,compactLayout:true,showLabels:'positive',
    highlightIndex:expiryChartMonth==='all'?null:monthKeys.indexOf(expiryChartMonth),
    onPointSelect:index=>{
      expiryChartMonth=monthKeys[index-1];
      expiryWorkspaceView='all';expiryWorkspacePage=0;
      renderDocumentExpiryWorkspace();
      // La gráfica sigue siendo interactiva: abrir el listado en su submenú.
      selectWorkspaceTab('control-detalle');
    }
  });

}
// Volver a calcular el tamaño al cambiar el ancho de pantalla o el zoom
// del navegador. No realiza consultas a Supabase ni altera los filtros.
const expiryChartSurface=document.getElementById('expiryMonthChartSurface');
if(typeof ResizeObserver!=='undefined'){
  let lastWidth=0, resizeScheduled=false;
  const expiryChartObserver=new ResizeObserver(entries=>{
    const width=Math.round(entries[0]?.contentRect?.width||0);
    if(width<1||Math.abs(width-lastWidth)<2)return;
    lastWidth=width;
    if(!appReady||document.getElementById('documentExpiryWorkspace').hidden||resizeScheduled)return;
    resizeScheduled=true;
    requestAnimationFrame(()=>{
      resizeScheduled=false;
      if(appReady&&!document.getElementById('documentExpiryWorkspace').hidden)
        renderDocumentExpiryWorkspace();
    });
  });
  expiryChartObserver.observe(expiryChartSurface);
}
document.getElementById('expiryMonthChartYear').addEventListener('change',event=>{
  expiryChartYear=event.target.value;
  expiryChartMonth='all';
  expiryWorkspaceView='all';expiryWorkspacePage=0;
  renderDocumentExpiryWorkspace();
});
document.getElementById('expiryMonthChartMonth').addEventListener('change',event=>{
  expiryChartMonth=event.target.value;
  expiryWorkspaceView='all';expiryWorkspacePage=0;
  renderDocumentExpiryWorkspace();
});
document.getElementById('docExpiryDetailYear').addEventListener('change',event=>{
  expiryChartYear=event.target.value;
  expiryChartMonth='all';expiryWorkspaceView='all';expiryWorkspacePage=0;
  renderDocumentExpiryWorkspace();
});
document.getElementById('docExpiryDetailMonth').addEventListener('change',event=>{
  expiryChartMonth=event.target.value;
  expiryWorkspaceView='all';expiryWorkspacePage=0;
  renderDocumentExpiryWorkspace();
});

function renderDocumentExpiryWorkspace() {
  const root=document.getElementById('documentExpiryWorkspace');
  if(!root)return;
  const allRows=documentExpiryRows();
  const query=document.getElementById('docExpirySearch').value.trim().toLowerCase();
  // Año del vencimiento, independiente del año original del cargo.
  // Los registros sin fecha solo aparecen en «Todos los meses» de su año de origen.
  const yearRows=allRows.filter(row=>{
    const dueYear=row.doc.expiry?.dueDate?.slice(0,4);
    const belongs=row.category==='unknown'
      ? row.year===expiryChartYear : dueYear===expiryChartYear;
    if(!belongs)return false;
    if(!query)return true;
    return String(row.cargo).toLowerCase().includes(query) ||
      String(row.doc.kardex||'').toLowerCase().includes(query);
  });
  // Al escoger un mes, consultar únicamente vencimientos YA ocurridos.
  // «Todos los meses» preserva los cuatro indicadores anuales.
  const scoped=expiryChartMonth==='all' ? yearRows : yearRows.filter(row=>
    row.category==='overdue' &&
    row.doc.expiry?.dueDate?.slice(0,7)===expiryChartMonth);
  const counts={valid:0,soon:0,overdue:0,unknown:0};
  scoped.forEach(row=>{counts[row.category]++});
  renderMonthlyExpiryChart(yearRows,scoped);
  for(const key of Object.keys(counts)){
    const id={valid:'docExpiryValidCount',soon:'docExpirySoonCount',
      overdue:'docExpiryOverdueCount',unknown:'docExpiryUnknownCount'}[key];
    document.getElementById(id).textContent=fmtNum(counts[key]);
  }
  document.getElementById('docExpiryAsOf').textContent=
    'Actualizado al '+fmtDate(expiryGroups.today);
  for(const button of document.querySelectorAll('#documentExpiryWorkspace [data-expiry-view], #documentExpiryDetails [data-expiry-view]')){
    button.setAttribute('aria-pressed',String(button.dataset.expiryView===expiryWorkspaceView));
  }
  const filtered=scoped.filter(row=>
    expiryWorkspaceView==='all' || row.category===expiryWorkspaceView
  );
  const totalPages=Math.max(1,Math.ceil(filtered.length/EXPIRY_WORKSPACE_PAGE_SIZE));
  expiryWorkspacePage=Math.max(0,Math.min(expiryWorkspacePage,totalPages-1));
  const start=expiryWorkspacePage*EXPIRY_WORKSPACE_PAGE_SIZE;
  const visible=filtered.slice(start,start+EXPIRY_WORKSPACE_PAGE_SIZE);
  const html=visible.map(row=>{
    const {doc,cargo,year,category}=row;
    const exp=doc.expiry;
    const base=exp?.baseDate?fmtDate(exp.baseDate):'—';
    const due=exp?.dueDate?fmtDate(exp.dueDate):'—';
    const durationText=!exp?'Sin fecha para calcular':
      category==='overdue'?'Vencido '+formatCargoDuration(exp.time):
      exp.daysRemaining===0?'Cumple 6 meses hoy':
      'Faltan '+formatCargoDuration(exp.time);
    const statusLabel={
      valid:'Vigente',soon:'Por vencer',overdue:'Vencido',unknown:'Fecha por validar'
    }[category];
    return '<tr>'
      +'<td class="doc-expiry-cargo-number">'+escapeHtml(cargo)+'</td>'
      +'<td>'+escapeHtml(year)+'</td>'
      +'<td>'+escapeHtml(String(doc.kardex||'—'))+'</td>'
      +'<td>'+escapeHtml(base)+'</td>'
      +'<td>'+escapeHtml(due)+'</td>'
      +'<td>'+escapeHtml(durationText)+'</td>'
      +'<td><span class="doc-expiry-status '+category+'">'+statusLabel+'</span></td>'
      +'<td><button type="button" class="doc-expiry-open" data-doc-expiry-cargo="'
      +escapeHtml(cargo)+'">Ver cargo</button></td>'
      +'</tr>';
  }).join('');
  document.getElementById('docExpiryTableBody').innerHTML=
    html||'<tr><td colspan="8" class="doc-expiry-empty">No hay cargos para los filtros seleccionados.</td></tr>';
  document.getElementById('docExpiryTableCount').textContent=filtered.length
    ? 'Mostrando '+fmtNum(start+1)+'–'+fmtNum(start+visible.length)
      +' de '+fmtNum(filtered.length)+' cargos'
    : '0 cargos encontrados';
  document.getElementById('docExpiryPage').textContent=
    'Página '+(expiryWorkspacePage+1)+' de '+totalPages;
  document.getElementById('docExpiryPrevious').disabled=expiryWorkspacePage===0;
  document.getElementById('docExpiryNext').disabled=expiryWorkspacePage>=totalPages-1;
}
const expiryWorkspaceElement=document.getElementById('documentExpiryWorkspace');
const expiryDetailsElement=document.getElementById('documentExpiryDetails');
for(const section of [expiryWorkspaceElement,expiryDetailsElement]){
  section.addEventListener('click',event=>{
    const selector=event.target.closest('button[data-expiry-view]');
    if(selector){
      expiryWorkspaceView=selector.dataset.expiryView;
      expiryWorkspacePage=0;
      renderDocumentExpiryWorkspace();
      // Las tarjetas de la vista ejecutiva llevan a los datos, no los insertan en el Dashboard.
      if(section===expiryWorkspaceElement)selectWorkspaceTab('control-detalle');
      return;
    }
    const openButton=event.target.closest('button[data-doc-expiry-cargo]');
    if(openButton){
      const cargo=openButton.dataset.docExpiryCargo;
      selectWorkspaceTab('existencias');
      document.getElementById('btnLimpiarFiltros').click();
      document.getElementById('buscar').value=cargo;
      searchNow();
      document.getElementById('grp-existencias').scrollIntoView({block:'start'});
    }
  });
}
document.getElementById('docExpirySearch').addEventListener('input',()=>{
  expiryWorkspacePage=0;renderDocumentExpiryWorkspace();
});
document.getElementById('docExpiryReset').addEventListener('click',()=>{
  expiryWorkspaceView='all';expiryWorkspacePage=0;
  expiryChartYear='2026';
  expiryChartMonth='all';
  document.getElementById('docExpirySearch').value='';
  renderDocumentExpiryWorkspace();
});
document.getElementById('docExpiryPrevious').addEventListener('click',()=>{
  if(expiryWorkspacePage>0)expiryWorkspacePage--;
  renderDocumentExpiryWorkspace();
});
document.getElementById('docExpiryNext').addEventListener('click',()=>{
  expiryWorkspacePage++;
  renderDocumentExpiryWorkspace();
});

function openCargoExpiry(group) {
  if (!appReady || !isAdmin || !['overdue','upcoming'].includes(group)) return;
  activeExpiryGroup = group;
  expiryPage = 0;
  renderDocs();
  const sheet = document.getElementById('cargoExpirySheet');
  if (!sheet.open) {
    expiryReturnButton = group === 'overdue' ? 'btnCargosVencidos' : 'btnCargosPorVencer';
    sheet.showModal();
  }
  sheet.querySelector('.expiry-table-wrap').scrollTop = 0;
}
document.getElementById('resumenTablas').addEventListener('click', event => {
  const button = event.target.closest('button[data-expiry]');
  if (button) openCargoExpiry(button.dataset.expiry);
  if(event.target.closest('button[data-prepared-im]')) openPreparedIm();
});
document.getElementById('btnCloseCargoExpiry').addEventListener('click', closeCargoExpiry);
document.getElementById('cargoExpirySheet').addEventListener('close', () => {
  const buttonId = expiryReturnButton;
  expiryReturnButton = '';
  closeCargoExpiry();
  if (appReady && isAdmin) document.getElementById(buttonId)?.focus();
});
for (const [id, delta] of [['btnExpiryPrevious',-1], ['btnExpiryNext',1]]) {
  document.getElementById(id).addEventListener('click', () => {
    if (!appReady || !isAdmin || !activeExpiryGroup) return;
    expiryPage = Math.max(0, expiryPage + delta);
    renderCargoExpiry();
    document.querySelector('#cargoExpirySheet .expiry-table-wrap').scrollTop = 0;
  });
}

async function cargarDocParaEditar(id){
  let d = docs.find(x=>x.id===id)||queryResults?.rows?.find(x=>x.id===id);
  if(d&&!d.completo&&repository?.fetchDoc) {
    try {d=await repository.fetchDoc(id);}catch(error){message('msgGuardado',readableError(error),true);return;}
  }
  if(!d) return;
  editingDocId = id;
  editingDocVersion = d.updatedAt;
  document.getElementById('f_tipoDoc').value = d.tipoDoc || 'Facturas-Guia';
  document.getElementById('f_periodo').value = d.periodo || '';
  document.getElementById('f_ubicacion').value = d.ubicacion || '';
  document.getElementById('f_folios').value = d.folios || '';
  const cargos = d.cargos || [];
  document.getElementById('f_cargo1').value = cargos.join(', ');
  populateCajaAsignadaOptions(d.cajaAsignada);
  document.getElementById('f_fEnvio').value = d.fEnvio || '';
  document.getElementById('f_sustento').value = d.sustento || '';
  currentSustentoImagen = d.sustentoImagen || '';
  renderPreviewSustento();
  document.getElementById('f_usuario').value = d.usuario || '';
  document.getElementById('f_facturas').value = d.facturas || '';
  document.getElementById('f_obs').value = d.obs || '';

  document.getElementById('docFormTitle').textContent = 'Editar registro';
  document.getElementById('docEditingBanner').style.display = 'block';
  document.getElementById('docEditingKardex').textContent = d.kardex;
  document.getElementById('btnGuardar').textContent = 'Guardar cambios';
  document.getElementById('btnCancelarEdicion').style.display = 'inline-block';
  document.getElementById('grp-documentos').open = true;
  document.getElementById('docFormTitle').scrollIntoView({behavior:'smooth', block:'start'});
}
function cancelarEdicionDoc(){
  editingDocId = null;
  editingDocVersion = null;
  document.getElementById('docFormTitle').textContent = 'Nuevo registro de Documento';
  document.getElementById('docEditingBanner').style.display = 'none';
  document.getElementById('btnGuardar').textContent = 'Guardar registro';
  document.getElementById('btnCancelarEdicion').style.display = 'none';
  limpiarFormDoc();
}
function limpiarFormDoc(){
  ['f_periodo','f_folios','f_cargo1','f_fEnvio','f_sustento','f_facturas','f_obs'].forEach(id=> document.getElementById(id).value = '');
  populateCajaAsignadaOptions('');
  currentSustentoImagen = '';
  renderPreviewSustento();
}
document.getElementById('btnCancelarEdicion').addEventListener('click', cancelarEdicionDoc);

// ---------- Imagen de Sustento ----------
function renderPreviewSustento(){
  const box = document.getElementById('previewSustento');
  if(currentSustentoImagen){
    box.innerHTML = `<div style="display:flex;align-items:center;gap:8px">
      <img src="${currentSustentoImagen}" style="height:48px;border-radius:6px;border:1px solid var(--border)">
      <button type="button" class="danger" id="btnQuitarImagen">Quitar</button>
    </div>`;
    document.getElementById('btnQuitarImagen').addEventListener('click', ()=>{
      currentSustentoImagen = '';
      renderPreviewSustento();
    });
  } else {
    box.innerHTML = '';
  }
}
document.getElementById('btnSubirImagen').addEventListener('click', ()=> document.getElementById('f_sustentoImagen').click());
document.getElementById('f_sustentoImagen').addEventListener('change', (ev)=>{
  const file = ev.target.files[0];
  if(!file) return;
  const img = new Image();
  const reader = new FileReader();
  reader.onload = (e)=>{
    img.onload = ()=>{
      const maxW = 900;
      const scale = Math.min(1, maxW / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      currentSustentoImagen = canvas.toDataURL('image/jpeg', 0.7);
      renderPreviewSustento();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
});


// Every write targets Supabase; the in-memory arrays only render confirmed records.
document.getElementById('btnGuardarReq').addEventListener('click', async ev => {
  const usuario = document.getElementById('rq_usuario').value.trim();
  const fechaSolicitud = document.getElementById('rq_fechaSolicitud').value;
  const tipo = document.getElementById('rq_tipo').value;
  const esCajasNuevas = tipo === 'Cajas nuevas para acondicionar';
  const cantidadCajas = document.getElementById('rq_cantidadCajas').value;
  const numerosCargo = document.getElementById('rq_numerosCargo').value.trim();
  if (!usuario || !fechaSolicitud || (esCajasNuevas && cantidadCajas === '') || (!esCajasNuevas && !numerosCargo)) {
    message('msgReq', esCajasNuevas ? 'Completa Usuario, Fecha de Solicitud y Cantidad de Cajas.'
      : 'Completa Usuario, Fecha de Solicitud y los Números de Cargo.', true);
    return;
  }
  if (esCajasNuevas && (!Number.isInteger(Number(cantidadCajas)) || Number(cantidadCajas) < 0)) {
    message('msgReq', 'La cantidad de cajas debe ser un número entero desde cero.', true); return;
  }
  const data = {
    tipo, fechaSolicitud, cantidadCajas: esCajasNuevas ? Number(cantidadCajas) : '',
    numerosCargo: esCajasNuevas ? '' : numerosCargo,
    fechaRecepcion: document.getElementById('rq_fechaRecepcion').value,
    fechaDevolucion: tipo === 'Préstamo de Cajas (búsqueda de documentos)' ? document.getElementById('rq_fechaDevolucion').value : '',
    usuario
  };
  const editing = editingReqId ? {id: editingReqId, updatedAt: editingReqVersion} : null;
  if (!editing) data.id = pendingReqId ||= crypto.randomUUID();
  await runMutation(ev.currentTarget, async () => {
    const saved = await repository.saveReq(data, editing);
    if (editing) cancelarEdicionReq(); else limpiarFormReq();
    pendingReqId = null;
    message('msgReq', `Requerimiento ${saved.numero} ${editing ? 'actualizado' : 'guardado'}.`);
  }, 'msgReq');
});

document.getElementById('btnGuardar').addEventListener('click', async ev => {
  const usuario = document.getElementById('f_usuario').value.trim();
  const periodo = document.getElementById('f_periodo').value;
  const historical = editingDocId && docs.find(d=>d.id===editingDocId)?.claveOrigen;
  if (!usuario || (!periodo && !historical)) {
    message('msgGuardado', 'Completa al menos Usuario Registro y Período Contable.', true); return;
  }
  const folios = document.getElementById('f_folios').value;
  if (folios !== '' && (!Number.isInteger(Number(folios)) || Number(folios) < 0)) {
    message('msgGuardado', 'La cantidad de folios debe ser un número entero desde cero.', true); return;
  }
  const data = {
    tipoDoc: document.getElementById('f_tipoDoc').value, periodo,
    ubicacion: document.getElementById('f_ubicacion').value, folios,
    cargos: document.getElementById('f_cargo1').value.split(/[,;\n]/).map(s=>s.trim()).filter(Boolean),
    cajaAsignada: document.getElementById('f_cajaAsignada').value,
    fEnvio: document.getElementById('f_fEnvio').value,
    sustento: document.getElementById('f_sustento').value.trim(), sustentoImagen: currentSustentoImagen,
    usuario, facturas: document.getElementById('f_facturas').value.trim(), obs: document.getElementById('f_obs').value.trim()
  };
  const editing = editingDocId ? {id: editingDocId, updatedAt: editingDocVersion} : null;
  if (!editing) data.id = pendingDocId ||= crypto.randomUUID();
  await runMutation(ev.currentTarget, async () => {
    const saved = await repository.saveDoc(data, editing);
    if (editing) cancelarEdicionDoc(); else limpiarFormDoc();
    pendingDocId = null;
    message('msgGuardado', `Registro ${saved.kardex} ${editing ? 'actualizado' : 'guardado'}.`);
  });
});

document.getElementById('btnReset').addEventListener('click', async ev => {
  if (!isAdmin || !confirm('¿Borrar TODOS los documentos y requerimientos de la base de datos compartida y reiniciar sus correlativos? Afectará a todas las computadoras. Esta acción no se puede deshacer.')) return;
  await runMutation(ev.currentTarget, async () => {
    await repository.reset();
    pendingReqId = pendingDocId = null;
    cancelarEdicionDoc(); cancelarEdicionReq();
    message('msgGuardado', 'Datos compartidos restablecidos.');
  });
});

async function exportCargo(id,button) {
  if(!appReady)return;
  button.disabled=true;
  try {
    // Fetch the complete selected record, not the truncated search result or the full catalog.
    const cargo=await repository.fetchDoc(id);
    if(!cargo.cargos?.length)throw new Error('Este registro no tiene cargo asignado.');
    const wb=await buildCargoWorkbook(cargo);
    const buffer=await wb.xlsx.writeBuffer();
    const url=URL.createObjectURL(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    const a=document.createElement('a');a.href=url;
    a.download=`Cargo_${cargo.cargos.join('_')}_${cargo.kardex}.xlsx`.replace(/[\\/:*?"<>|]/g,'_');
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){alert(`No se pudo exportar el cargo: ${readableError(error)}`);}
  finally{button.disabled=false;}
}
document.getElementById('btnImportar').addEventListener('click', ()=>document.getElementById('fileImportar').click());
document.getElementById('fileImportar').addEventListener('change', async ev => {
  const input = ev.target, file = input.files[0];
  if (!file || !isAdmin || !appReady || isPreview) { input.value = ''; return; }
  const button = document.getElementById('btnImportar');
  button.disabled = true;
  try {
    document.getElementById('importProgress').textContent='Leyendo el archivo Excel…';
    const imported = await parseWorkbook(await file.arrayBuffer());
    if (!confirm(`Se agregarán o actualizarán ${imported.reqs.length} requerimientos y ${imported.docs.length} documentos. Los registros que no figuran en el archivo se conservarán. Se guardará una copia privada del Excel original. ¿Importar?`)) return;
    await runMutation(button, async () => {
      const result = await repository.importFile(file,imported,value=>document.getElementById('importProgress').textContent=value);
      if (result.requerimientos !== imported.reqs.length || result.documentos !== imported.docs.length) {
        throw new Error('La confirmación de la base de datos no coincide. Actualiza los datos.');
      }
      pendingReqId = pendingDocId = null;
      cancelarEdicionReq(); cancelarEdicionDoc();
      alert(`Importación completa y verificada: ${result.requerimientos} requerimientos y ${result.documentos} documentos guardados en línea.`);
    });
  } catch (error) { alert(`No se pudo importar. ${readableError(error)}`); }
  finally { input.value = ''; document.getElementById('importProgress').textContent=''; setAvailability(); }
});
function searchNow(){
  appliedFilters=currentFilters();currentPage=0;
  if(!repository?.search){queryResults=null;renderDocs();return;}
  void fetchSearchResults();
}
document.getElementById('btnBuscar').addEventListener('click',searchNow);
document.getElementById('buscarReq').addEventListener('input',renderReqs);
document.getElementById('btnLimpiarFiltros').addEventListener('click',()=>{
 document.getElementById('buscar').value='';
 ['filtroEstado','filtroTipo','filtroUbicacion','filtroAnio','filtroFactura'].forEach(id=>document.getElementById(id).value='');
 // Reset the local listing without launching a search request.
 appliedFilters=currentFilters();currentPage=0;searchEpoch++;searchController?.abort();
 queryResults=null;queryError='';renderDocs();setAvailability();
});
document.getElementById('btnPaginaAnterior').addEventListener('click',()=>{if(currentPage>0){currentPage--;fetchSearchResults();}});
document.getElementById('btnPaginaSiguiente').addEventListener('click',()=>{currentPage++;fetchSearchResults();});

async function subscribeRealtime() {
  if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
  channelReady = false;
  realtimeChannel = supabase.channel('kardex-santa-anita')
    .on('postgres_changes', {event:'*',schema:'public',table:'kardex_eventos'}, scheduleRefresh)
    .subscribe(status => {
      channelReady = status === 'SUBSCRIBED';
      if (channelReady) scheduleRefresh();
      else if (['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status)) {
        setStatus('Conexión en tiempo real interrumpida — Reconectando', 'error');
      }
    });
}
function showSessionLoading(){
  document.getElementById('sessionLoading').hidden=false;
  document.getElementById('authOverlay').hidden=true;
  document.getElementById('registerOverlay').hidden=true;
  document.getElementById('appShell').hidden=true;
  document.getElementById('appShell').inert=true;
}
function showAuthPage(visible) {
  document.getElementById('sessionLoading').hidden=true;
  document.getElementById('authOverlay').hidden = !visible;
  document.getElementById('registerOverlay').hidden = true;
  document.getElementById('appShell').hidden = visible;
  document.getElementById('appShell').inert = visible;
}
// El enlace de Supabase puede conservar #type=recovery después de cambiar
// la contraseña. Al actualizar la página ese fragmento volvía a abrir
// indebidamente «Crear nueva contraseña» aunque la actualización fue exitosa.
function clearCompletedPasswordRecoveryLink() {
  const url=new URL(window.location.href);
  const fragment=new URLSearchParams(url.hash.slice(1));
  if(fragment.get('type')==='recovery')url.hash='';
  if(url.searchParams.get('type')==='recovery') {
    for(const key of ['type','token_hash','token','code'])url.searchParams.delete(key);
  }
  if(url.href!==window.location.href) {
    window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);
  }
}
function showRecoveryForm(recovering) {
  document.getElementById('btnRegister').hidden=recovering;
  document.getElementById('authForm').hidden = recovering;
  document.getElementById('resetPasswordForm').hidden = !recovering;
  document.getElementById('btnForgotPassword').hidden = recovering;
  document.getElementById('btnMagicLink').hidden = recovering;
  document.getElementById('authTitle').textContent = recovering ? 'Crear nueva contraseña' : 'Iniciar sesión';
  document.getElementById('authDescription').textContent = recovering
    ? 'Elige una nueva contraseña de al menos 8 caracteres para volver al Kardex.'
    : 'Ingresa a Kardex Digital con tu correo electrónico y contraseña.';
}
async function handleSession(session) {
  const generation = ++authGeneration;
  const user = session?.user;
  showRecoveryForm(passwordRecovery && !!user);
  if (passwordRecovery && user) {
    appReady = isAdmin = dataReady = false;
    showAuthPage(true);
    document.getElementById('btnAuthSignOut').hidden = false;
    setAvailability(); return;
  }
  if (user && currentUserId !== user.id) {
    clearPreviousCargoCache();
    clearInterval(adminRequestsTimer);adminRequestsTimer=null;adminRequestsEpoch++;setAdminRequestBadge(null);
    appReady = isAdmin = dataReady = false;
    reqs = []; docs = []; preparedImSummary=null; ++preparedImSummaryEpoch;
    monthlyShippedSummary=null;monthlyShippedError=''; ++monthlyShippedFetchEpoch;
    requestedIMRows=[];requestedIMData=[];requestedIMLoaded=false;requestedIMError=''; ++requestedIMFetchEpoch;
    renderReqs(); renderDocs(); setAvailability();
    showSessionLoading();
  }
  if (!user) {
    clearPreviousCargoCache();
    clearInterval(adminRequestsTimer);adminRequestsTimer=null;adminRequestsEpoch++;setAdminRequestBadge(null);
    document.getElementById('adminRequestsPanel').hidden=true;
    idleSession.stop();
    showAuthPage(true);
    if (passwordRecovery) message('authMessage','El enlace de recuperación no es válido. Solicita uno nuevo.',true);
    passwordRecovery = false;
    showRecoveryForm(false);
    currentUserId = null; appReady = isAdmin = dataReady = channelReady = false;
    activeWorkspaceTab='resumen';activeSidebarAction='';
    clearTimeout(refreshTimer);
    if (realtimeChannel) { await supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
    queryResults=null;queryError='';searchController?.abort();currentPage=0;
    reqs = []; docs = []; preparedImSummary=null; ++preparedImSummaryEpoch;
    monthlyShippedSummary=null;monthlyShippedError=''; ++monthlyShippedFetchEpoch;
    requestedIMRows=[];requestedIMData=[];requestedIMLoaded=false;requestedIMError=''; ++requestedIMFetchEpoch;
    cancelarEdicionDoc(); cancelarEdicionReq(); renderReqs(); renderDocs();
    showAuthPage(true);
    document.getElementById('sessionUser').textContent = '';
    document.getElementById('sessionProfile').hidden = true;
    document.getElementById('btnSignOut').hidden = true;
    document.getElementById('btnAuthSignOut').hidden = true;
    setStatus('Inicia sesión para conectar'); setAvailability(); return;
  }
  if(!idleSession.start(session))return;
  currentUserId = user.id;
  document.getElementById('btnAuthSignOut').hidden = false;
  try {
    const access = await repository.access();
    if (generation !== authGeneration) return;
    if (!access.allowed) {
      appReady = false; isAdmin = false;
      message('authMessage','Esta cuenta no está autorizada todavía. Confirma tu correo electrónico para ingresar como invitado.',true);
      showAuthPage(true);
      setStatus('Cuenta sin autorización','error'); setAvailability(); return;
    }
    isAdmin = access.is_admin;
    adminRequestStatus=null;
    // Un correo confirmado con código de solicitud no crea un administrador:
    // primero registra la petición y espera una aprobación de la cuenta principal.
    if (!isPreview && !isAdmin && user.user_metadata?.kardex_admin_request_code && repository.requestAdminAccess) {
      try {
        const r=await repository.requestAdminAccess();
        adminRequestStatus=r?.estado || null;
      } catch(error) {
        adminRequestStatus='error';
      }
    }
    await refreshData();
    if (generation !== authGeneration) return;
    appReady = true;
    if(isAdmin) {
      void reloadPreparedImSummary();
      void reloadRequestedIM();
      void reloadShippedBoxesSummary();
      refreshGoogleSync();void refreshAdminRequests();
      clearInterval(adminRequestsTimer);
      adminRequestsTimer=setInterval(()=>{
        if(appReady && isAdmin && currentUserId && !document.hidden)void refreshAdminRequests();
      },60000);
    }
    showAuthPage(false);
    if(!isAdmin && adminRequestStatus) {
      document.getElementById('readOnlyNotice').textContent=adminRequestStatus==='pendiente'
        ? 'Invitado · Solicitud de administrativo pendiente de aprobación por la cuenta principal'
        : 'Invitado · Acceso administrativo todavía no autorizado';
    } else document.getElementById('readOnlyNotice').textContent='Invitado · Solo consulta de cargos y facturas';
    message('authMessage','');
    document.getElementById('sessionUser').textContent = (typeof user.user_metadata?.kardex_username === 'string' && user.user_metadata.kardex_username.trim()) || user.email || '';
    document.getElementById('sessionProfile').hidden = !user.email;
    document.getElementById('btnSignOut').hidden = false;
    await subscribeRealtime(); setAvailability();
  } catch (error) {
    appReady = false; setAvailability();
    showAuthPage(true);
    message('authMessage',readableError(error),true);
    setStatus('No se pudo cargar la información','error');
  }
}
document.getElementById('authForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (!supabase) return;
  const button = document.getElementById('btnLogin'); button.disabled = true;
  message('authMessage','Validando cuenta…');
  try {
    const {error} = await supabase.auth.signInWithPassword({
      email:document.getElementById('authEmail').value.trim().toLowerCase(), password:document.getElementById('authPassword').value
    });
    document.getElementById('authPassword').value = '';
    if (error) throw error;
    message('authMessage','Cargando tu aplicativo…');
  } catch (error) { message('authMessage',readableError(error),true); }
  finally { button.disabled = false; }
});
document.getElementById('btnMagicLink').addEventListener('click', async ev => {
  if(isPreview){message('authMessage','En esta Preview no se envían correos de acceso.',true);return;}
  const email = document.getElementById('authEmail').value.trim().toLowerCase();
  if (!supabase || !document.getElementById('authEmail').reportValidity()) return;
  const button = ev.currentTarget; button.disabled = true;
  try {
    const {error} = await supabase.auth.signInWithOtp({email,options:{emailRedirectTo:window.location.origin+'/',shouldCreateUser:false}});
    if (error) throw error;
    message('authMessage','Revisa tu correo y abre el enlace de acceso en esta computadora.');
  } catch(error) { message('authMessage',readableError(error),true); }
  finally { button.disabled = false; }
});
document.getElementById('btnForgotPassword').addEventListener('click',async ev=>{
  if(isPreview){message('authMessage','La recuperación de contraseñas está deshabilitada en esta Preview.',true);return;}
  const input=document.getElementById('authEmail');
  if(!supabase || !input.reportValidity()) return;
  const button=ev.currentTarget;button.disabled=true;
  message('authMessage','Solicitando recuperación…');
  try {
    const {error}=await supabase.auth.resetPasswordForEmail(input.value.trim().toLowerCase(),{redirectTo:window.location.origin+'/'});
    if(error)throw error;
    message('authMessage','Si el correo está registrado, recibirás un enlace para crear una nueva contraseña. Revisa también Spam.');
  }catch(error){message('authMessage',readableError(error),true);}
  finally{button.disabled=false;}
});
document.getElementById('resetPasswordForm').addEventListener('submit',async ev=>{
  ev.preventDefault();if(isPreview){message('authMessage','No se cambian contraseñas desde la Preview.',true);return;}
  if(!supabase || !passwordRecovery)return;
  const password=document.getElementById('newPassword').value;
  if(password.length<8){message('authMessage','Usa al menos 8 caracteres.',true);return;}
  if(password!==document.getElementById('confirmPassword').value){message('authMessage','Las contraseñas no coinciden.',true);return;}
  const button=document.getElementById('btnUpdatePassword');button.disabled=true;
  try{
    const {error}=await supabase.auth.updateUser({password});if(error)throw error;
    passwordRecovery=false;
    passwordRecoveryCompleted=true;
    clearCompletedPasswordRecoveryLink();
    document.getElementById('resetPasswordForm').reset();
    showRecoveryForm(false);message('authMessage','Contraseña actualizada. Cargando tu aplicativo…');
    const {data,error:sessionError}=await supabase.auth.getSession();if(sessionError)throw sessionError;
    await handleSession(data.session);
  }catch(error){message('authMessage',readableError(error),true);}
  finally{button.disabled=false;}
});
async function signOut() {
  closeExecutiveProfileMenu();
  const {error} = await supabase.auth.signOut({scope:'local'});
  if (error) message('authMessage',readableError(error),true);
  else message('authMessage','');
}
document.getElementById('btnSignOut').addEventListener('click',signOut);
document.getElementById('btnAuthSignOut').addEventListener('click',signOut);
document.getElementById('btnReconnect').addEventListener('click',async ()=>{
  if (!supabase) return;
  try {
    const {data,error} = await supabase.auth.getSession();
    if (error) throw error;
    await handleSession(data.session);
  } catch(error) { setStatus(readableError(error),'error'); }
});
document.getElementById('btnRefreshNewCargos').addEventListener('click',async event=>{
  if(!appReady||!isAdmin||!currentUserId||!repository)return;
  const button=event.currentTarget;
  button.disabled=true;
  button.title='Refrescando cargos…';
  button.setAttribute('aria-label','Refrescando cargos…');
  button.dataset.busy='true';
  const previous=cargoTotals2026().total;
  try {
    await refreshData();
    const filters=appliedFilters;
    if(repository.search && (filters.query||filters.state||filters.type||filters.location||filters.year||filters.invoiceExact))
      await fetchSearchResults();
    const current=cargoTotals2026().total;
    await refreshGoogleSync();
    setStatus(current===previous
      ? `Cargos verificados: ${fmtNum(current)} de 2026. Si falta una factura, revisa el resultado de envío en Google Sheets.`
      : `Cargos 2026 actualizados: ${fmtNum(previous)} → ${fmtNum(current)}.`, 'online');
  } catch(error) {
    setStatus('No se pudo refrescar: '+readableError(error),'error');
  } finally {
    button.disabled=false;
    button.dataset.busy='false';
    button.title='Refrescar cargos nuevos';
    button.setAttribute('aria-label','Refrescar cargos nuevos');
  }
});
window.addEventListener('offline',()=>{channelReady=false;setStatus('Sin conexión — Los cambios requieren conexión en línea','error');});
window.addEventListener('online',()=>{if(currentUserId){subscribeRealtime();scheduleRefresh();if(isAdmin)void refreshAdminRequests();}});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden && currentUserId && appReady) {
    scheduleRefresh();
    if(isAdmin)void refreshAdminRequests();
  }
});
updateReqCondFields(); renderReqs(); renderDocs(); setAvailability();
if (!supabase) {
  showAuthPage(true);
  document.getElementById('authForm').hidden = true;
  document.getElementById('btnMagicLink').hidden = true;
  document.getElementById('btnForgotPassword').hidden = true;
  message('authMessage','La conexión de esta instalación está pendiente de configuración.',true);
  setStatus('Configuración pendiente','error');
} else {
  // Do not await other Supabase calls inside an auth callback (the auth lock is held).
  supabase.auth.onAuthStateChange((event,session)=>{
    if (event === 'INITIAL_SESSION') return;
    if (event === 'PASSWORD_RECOVERY' && !passwordRecoveryCompleted) passwordRecovery = true;
    if (event === 'TOKEN_REFRESHED' && currentUserId === session?.user?.id) { if(idleSession.check())scheduleRefresh(); return; }
    setTimeout(()=>handleSession(session),0);
  });
  try {
    const {data,error} = await supabase.auth.getSession();
    if(error)throw error;
    if(!currentUserId)await handleSession(data.session);
  }catch(error){showAuthPage(true);message('authMessage',readableError(error),true);}
}


function passwordVisibility(inputId,buttonId) {
  const input=document.getElementById(inputId),button=document.getElementById(buttonId);
  button.addEventListener('click',()=>{
    const visible=input.type==='password';
    input.type=visible?'text':'password';
    button.setAttribute('aria-label',visible?'Ocultar contraseña':'Mostrar contraseña');
    button.setAttribute('aria-pressed',String(visible));
    button.title=visible?'Ocultar contraseña':'Mostrar contraseña';
    input.focus();
  });
}
passwordVisibility('authPassword','toggleAuthPassword');

passwordVisibility('registerPassword','toggleRegisterPassword');
function showRegistrationPage(visible) {
  // Registro y acceso son pantallas separadas; nunca se muestra el Kardex al registrarse.
  showAuthPage(true);
  document.getElementById('authOverlay').hidden=visible;
  document.getElementById('registerOverlay').hidden=!visible;
  document.getElementById('appShell').hidden=true;
  document.getElementById('appShell').inert=true;
  message('registerMessage','');
  if(visible)document.getElementById('registerUsername').focus();
}
document.getElementById('btnRegister').addEventListener('click',()=>showRegistrationPage(true));
document.getElementById('btnBackLogin').addEventListener('click',()=>{
  document.getElementById('registerForm').reset();
  document.getElementById('registerPassword').type='password';
  showRegistrationPage(false);
});
document.getElementById('registerForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.currentTarget;
  if(!form.reportValidity() || !supabase)return;
  const username=document.getElementById('registerUsername').value.trim().replace(/\s+/g,' ');
  const email=document.getElementById('registerEmail').value.trim().toLowerCase();
  const password=document.getElementById('registerPassword').value;
  const confirmation=document.getElementById('registerConfirmPassword').value;
  const wantsAdmin=document.getElementById('registerRole').value==='admin';
  if(username.length<3 || username.length>60){message('registerMessage','Ingresa un nombre de usuario entre 3 y 60 caracteres.',true);return;}
  if(password.length<8){message('registerMessage','La contraseña debe tener al menos 8 caracteres.',true);return;}
  if(password!==confirmation){message('registerMessage','Las contraseñas no coinciden.',true);return;}
  if(isPreview){message('registerMessage','Esta es una vista previa de diseño. No se crean cuentas reales hasta publicar los cambios.',true);return;}
  const button=document.getElementById('btnCreateAccount');
  button.disabled=true;
  message('registerMessage','Creando cuenta y enviando enlace de verificación…');
  try {
    // Compatibilidad con la solicitud existente: el código sólo identifica el trámite.
    // No concede acceso administrativo; la cuenta principal debe aprobarlo.
    const data={kardex_username:username};
    if(wantsAdmin)data.kardex_admin_request_code='FPCARGOS';
    const {error}=await supabase.auth.signUp({
      email,password,options:{emailRedirectTo:window.location.origin+'/',data}
    });
    if(error)throw error;
    document.getElementById('registerPassword').value='';
    document.getElementById('registerConfirmPassword').value='';
    message('registerMessage',wantsAdmin
      ? 'Revisa tu correo y abre el enlace para verificar tu cuenta. Ingresarás como invitado hasta que la cuenta principal apruebe tu solicitud administrativa.'
      : 'Revisa tu correo y abre el enlace para verificar tu cuenta. Después podrás ingresar como invitado con tu nombre de usuario.');
  }catch(error){message('registerMessage',readableError(error),true);}
  finally{button.disabled=false;}
});
async function refreshAdminRequests() {
  const panel=document.getElementById('adminRequestsPanel');
  const epoch=++adminRequestsEpoch,generation=authGeneration;
  if(!isAdmin || !currentUserId || !repository?.pendingAdminRequests){
    panel.hidden=true;setAdminRequestBadge(null);return;
  }
  try {
    const rows=await repository.pendingAdminRequests();
    // Si se cerró la sesión o se inició otra consulta, descartar la respuesta antigua.
    if(epoch!==adminRequestsEpoch || generation!==authGeneration || !isAdmin || !currentUserId)return;
    const pending=Array.isArray(rows)?rows:[];
    setAdminRequestBadge(pending.length);
    panel.hidden=false;
    const list=document.getElementById('adminRequestsList');
    list.innerHTML=pending.length ? pending.map(request=>
      `<div class="admin-request-item">
        <div><strong>${escapeHtml(request.email)}</strong>
        <div class="desc">Correo verificado · Esperando tu autorización</div></div>
        <div class="admin-request-actions">
          <button type="button" data-admin-approve="${escapeHtml(request.id)}">Aprobar</button>
          <button type="button" class="secondary" data-admin-reject="${escapeHtml(request.id)}">Rechazar</button>
        </div>
      </div>`).join('')
      : '<p class="desc">No hay solicitudes administrativas pendientes.</p>';

    // Enlaces de aprobación desde Gmail: nunca mutan datos al abrir la URL.
    // Solo después de iniciar sesión como propietario y confirmar el diálogo
    // se invoca la RPC de aprobación; el correo por sí mismo no tiene permisos.
    const query=new URLSearchParams(window.location.search);
    const id=query.get('solicitud_admin'),accion=query.get('accion');
    if(!adminEmailLinkReviewed && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id||'')
        && (accion==='aprobar'||accion==='rechazar')) {
      adminEmailLinkReviewed=true;
      const request=(rows||[]).find(item=>item.id===id);
      if(request) {
        const approved=accion==='aprobar';
        const selected=confirm(approved
          ? '¿Aprobar a '+request.email+' como administrador con permisos completos?'
          : '¿Rechazar la solicitud administrativa de '+request.email+'?');
        if(selected) {
          try {
            if(isPreview)throw new Error('Vista previa: no se puede aprobar ni rechazar solicitudes.');
            await repository.reviewAdminRequest(id,approved);
            alert(approved
              ? 'Cuenta administrativa aprobada. La persona podrá entrar con permisos administrativos al volver a iniciar sesión.'
              : 'Solicitud administrativa rechazada.');
            await refreshAdminRequests();
          } catch(error) {
            alert('No se pudo procesar la aprobación: '+readableError(error));
          }
        }
      } else {
        alert('La solicitud del correo ya no está pendiente. Revisa la lista de solicitudes administrativas.');
      }
      query.delete('solicitud_admin');query.delete('accion');
      const updated=window.location.pathname+(query.size?'?'+query.toString():'')+window.location.hash;
      window.history.replaceState(null,'',updated);
    }
  }catch(_error){
    if(epoch!==adminRequestsEpoch || generation!==authGeneration || !isAdmin)return;
    setAdminRequestBadge(null);
    panel.hidden=false;
    document.getElementById('adminRequestsList').textContent=
      'No se pudieron consultar las solicitudes. Pulsa Actualizar solicitudes para intentar nuevamente.';
  }
}
document.getElementById('btnAdminRequestsRefresh').addEventListener('click',()=>void refreshAdminRequests());
document.getElementById('adminRequestsList').addEventListener('click',async event=>{
  const button=event.target.closest('[data-admin-approve],[data-admin-reject]');
  if(!button || !isAdmin || !repository?.reviewAdminRequest)return;
  const approved=!!button.dataset.adminApprove;
  const id=approved?button.dataset.adminApprove:button.dataset.adminReject;
  if(!confirm(approved
    ? '¿Aprobar a esta persona como administrador con permisos completos?'
    : '¿Rechazar esta solicitud?'))return;
  button.disabled=true;
  try {
    if(isPreview)throw new Error('Vista previa: no se pueden modificar permisos.');
    await repository.reviewAdminRequest(id,approved);
    await refreshAdminRequests();
    alert(approved?'Acceso administrativo autorizado. La persona deberá volver a iniciar sesión.':'Solicitud rechazada.');
  } catch(error){alert('No se pudo revisar la solicitud: '+readableError(error));}
  finally{button.disabled=false;}
});

function syncMetric(value) {
  // Missing readings are unknown, not zero; do not hardcode dashboard totals.
  if(value === null || value === undefined || value === '') return '—';
  const parsed=Number(value);
  return Number.isFinite(parsed) && parsed>=0 ? parsed.toLocaleString('es-PE') : '—';
}
async function refreshGoogleSync(){
  if(!appReady||!isAdmin)return;
  const button=document.getElementById('btnToggleGoogleSync');
  button.disabled=true;
  try{
    const {data,error}=await supabase.from('kardex_google_sync').select().eq('id',true).single();
    if(error)throw error;
    googleSyncEnabled=!!data.enabled;
    button.textContent=data.enabled?'Pausar sincronización':'Activar sincronización';
    const badge=document.getElementById('googleSyncBadge');
    badge.dataset.status=data.enabled?'active':'paused';
    document.getElementById('googleSyncBadgeText').textContent=data.enabled?'ACTIVA':'PAUSADA';

    const result=data.last_result||{};
    const onEditMode=result.mode==='onedit';
    if(onEditMode) {
      const altas=!!data.enabled && result.verified===true;
      const bajas=altas && result.delete_verified===true;
      badge.dataset.status=!data.enabled?'paused':bajas?'active':'loading';
      document.getElementById('googleSyncBadgeText').textContent=!data.enabled?'PAUSADA':bajas?'ALTAS Y BAJAS ACTIVAS':altas?'BAJAS POR ACTIVAR':'POR ACTIVAR';
    }
    const conteo2026=cargoTotals2026();
    const groups=syncMetric(onEditMode?conteo2026.total:result.groups);
    const pending=syncMetric(result.pending_rows);
    const conflicts=syncMetric(result.conflictos);
    document.getElementById('googleSyncRegistered').textContent=groups;
    document.getElementById('googleSyncPending').textContent=pending;
    document.getElementById('googleSyncConflicts').textContent=conflicts;
    const checkedAt=data.last_checked_at ? new Date(data.last_checked_at) : null;
    const last=checkedAt && Number.isFinite(checkedAt.getTime())
      ? checkedAt.toLocaleString('es-PE',{timeZone:'America/Lima'})
      : 'Pendiente';
    document.getElementById('googleSyncLastReview').textContent=onEditMode
      ? (result.verified?'Último cargo recibido: '+last+' (Lima)':'Aguardando primera edición autorizada en Apps Script')
      : 'Última revisión: '+last+' (Lima)';
    document.getElementById('googleSyncStatus').textContent=onEditMode && result.delete_verified!==true && !!data.enabled
      ? 'Las altas funcionan, pero NO se ha confirmado el control automático de bajas. Abre Google Sheets → Extensiones → Apps Script, pega la versión V4 y ejecuta instalarTiempoReal; revisa INSTRUCCIONES D2.'
      : data.status||'Sin estado informado';
    document.getElementById('googleSyncDetails').textContent=onEditMode
      ? `Cargos de 2026: ${fmtNum(conteo2026.historicos)} del Excel base + ${fmtNum(conteo2026.nuevos)} incorporados desde Google Sheets = ${groups} cargos únicos. Los errores se registran en las columnas técnicas ocultas de la hoja.`
      : `Último procesamiento: ${groups} cargos revisados; ${syncMetric(result.cargos_nuevos)} nuevos; ${syncMetric(result.cargos_actualizados)} actualizados; ${pending} filas pendientes; ${conflicts} conflictos.`;
  }catch(error){
    document.getElementById('googleSyncBadge').dataset.status='error';
    document.getElementById('googleSyncBadgeText').textContent='SIN CONEXIÓN';
    document.getElementById('googleSyncStatus').textContent='No se pudo consultar el estado: '+readableError(error);
  }
  finally{button.disabled=!appReady||!isAdmin;}
}
setInterval(()=>{
  if(!document.hidden) {
    refreshGoogleSync();
    if(appReady && isAdmin && currentUserId && !mutationBusy){
      void reloadPreparedImSummary();
      void reloadRequestedIM();
      void reloadShippedBoxesSummary();
    }
    if(appReady && isAdmin && expiryGroups.today !== limaDate(new Date())) renderDocs();
    else if(appReady && isAdmin &&
      document.getElementById('monthlyCargoPeriod').dataset.month !== limaDate(new Date()).slice(0,7))
      renderMonthlyCargoStats();
  }
},60000);
// Conciliación de seguridad para cambios de Sheets que lleguen sin notificación
// Realtime. No modifica datos y reutiliza la misma lectura del Kardex.
setInterval(()=>{
  if(appReady && isAdmin && currentUserId && !document.hidden && !mutationBusy)
    scheduleRefresh();
},300000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshGoogleSync();});
document.getElementById('btnToggleGoogleSync').addEventListener('click',async ev=>{
  if(!appReady||!isAdmin||isPreview)return;
  ev.currentTarget.disabled=true;
  try{
    const {error}=await supabase.from('kardex_google_sync').update({enabled:!googleSyncEnabled}).eq('id',true);
    if(error)throw error;await refreshGoogleSync();
  }catch(error){document.getElementById('googleSyncStatus').textContent=readableError(error);ev.currentTarget.disabled=false;}
});
