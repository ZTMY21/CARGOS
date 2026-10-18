import { createClient } from '@supabase/supabase-js';
import { computeReqEstado as reqEstado, computeDocEstado as docEstado, fmtDate, escapeHtml, limaDate } from './rules.js';
import { KardexRepository, reqFromDb, docFromDb } from './repository.js';
import { buildCargoWorkbook, parseWorkbook } from './excel-api.js';
import { highlightMatch, filterDocuments, filterRequirements, invoiceSearchPresentation } from './search.js';
import './connection.css';
import { createIdleSession } from './idle-session.js';
import { cargoYear, locationLabel, groupsForCodes } from './cargo-details.js';
import { cargoExpiryGroups, formatCargoDuration } from './cargo-expiry.js';

const configuration = { url: __SUPABASE_URL__, key: __SUPABASE_ANON_KEY__ };
// Capture recovery mode before the client consumes the email callback fragment.
let passwordRecovery = new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery';
const supabase = configuration.url && configuration.key ? createClient(configuration.url, configuration.key) : null;
const repository = supabase ? new KardexRepository(supabase) : null;
const idleSession = createIdleSession({window, onExpire: async()=>{
  // Lock the interface immediately, including when the network is unavailable.
  await handleSession(null);
  message('authMessage','Tu sesión se cerró por una hora de inactividad. Vuelve a ingresar.');
  try { await supabase.auth.signOut({scope:'local'}); } catch { /* The expired local deadline keeps the app locked. */ }
}});
let googleSyncEnabled=true;
let appReady = false, isAdmin = false, mutationBusy = false, channelReady = false;
let dataReady = false, realtimeChannel = null, refreshTimer = null, refreshPromise = null;
let refreshRequested = false;
let authGeneration = 0, currentUserId = null;
let pendingReqId = null, pendingDocId = null;
let queryResults = null, queryError = '', searchEpoch = 0, searchController = null;
let currentPage = 0;
let expiryGroups = {today:'', overdue:[], upcoming:[], unknown:[]};
let activeExpiryGroup = null, expiryPage = 0, expiryReturnButton = '';
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
  document.getElementById('connectionStatus').textContent = value;
  document.getElementById('connectionDot').className = `connection-dot ${state}`;
}
function setAvailability() {
  if (!appReady || !isAdmin) closeCargoExpiry();
  document.getElementById('btnExportar').hidden=true;
  document.getElementById('appShell').classList.toggle('read-only', !isAdmin);
  ['googleSyncPanel','grp-resumen','grp-requerimientos','grp-documentos','btnImportar','btnReset'].forEach(id=>document.getElementById(id).hidden=!isAdmin);
  document.getElementById('readOnlyNotice').hidden=!appReady||isAdmin;
  document.getElementById('existenciasSubtitulo').textContent = isAdmin
    ? 'Consulta, búsqueda, exportación e importación de documentos'
    : 'Consulta, búsqueda y exportación de documentos';

  document.querySelectorAll('.group button').forEach(b => b.disabled = !appReady || mutationBusy);
  ['btnReset','btnImportar','btnGuardar','btnGuardarReq'].forEach(id => document.getElementById(id).disabled = !appReady || !isAdmin || mutationBusy);
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
      populateYearOptions();
      renderReqs(); renderDocs();
      if(isAdmin) void refreshGoogleSync();
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
  return {'Pendiente de Envío':'b-pendiente','En Proceso de Acondicionamiento':'b-proceso','Enviado a Iron Mountain':'b-enviado'}[estado]||'';
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
      const cargo=String(value??'').trim().replace(/\\.0+$/,'').replace(/^0+(?=\\d)/,'');
      if(!cargo)continue;
      todos.add(cargo);
      if(origen.startsWith('google-live|')) nuevos.add(cargo);
      else historicos.add(cargo);
    }
  }
  return {total:todos.size,historicos:historicos.size,
    nuevos:[...nuevos].filter(c=>!historicos.has(c)).length};
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
  const grupoPorVencer = expiryGroups.upcoming;
  const grupoVencidos = expiryGroups.overdue;
  const cargosPorVencer = cargosDe(grupoPorVencer), foliosPorVencer = foliosDe(grupoPorVencer);
  const cargosVencidos = cargosDe(grupoVencidos), foliosVencidos = foliosDe(grupoVencidos);
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
  const notaOrigen = cargosPorAnio.has('2026')
    ? `<div class="periodo-nota">2026 se actualiza desde Google Sheets · Cargos Actuales — ${fmtNum(conteo2026.historicos)} del Excel base + ${fmtNum(conteo2026.nuevos)} nuevos = ${fmtNum(conteo2026.total)} cargos</div>`
    : '';

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
    ${expiryGroups.unknown.length ? `<p class="expiry-note">${fmtNum(cargosDe(expiryGroups.unknown))} cargos de 2025/2026 sin fecha válida para calcular el vencimiento; no se incluyen en estas alertas.</p>` : ''}
    <section class="year-section periodo-box" aria-labelledby="year-summary-heading">
      <h3 class="year-heading" id="year-summary-heading">Cargos por Año</h3>
      <div class="year-grid" aria-live="polite">${porPeriodoHtml}</div>
      ${notaOrigen}
    </section>
  `;
  if (activeExpiryGroup) renderCargoExpiry();

  let filtered=queryResults?.rows?.map(d=>({...d,...computeDocEstado(d)}))
    ?? filterDocuments(docs,reqs,filters).sort(showRandomCargos(filters)?randomCargoOrder:(a,b)=>b.kardex.localeCompare(a.kardex));
  lastFiltered=filtered;
  const pendingCargo=docs.filter(d=>!d.cargos?.length).length;
  const total=queryResults?.total??filtered.length;
  const folios=queryResults?.folios??filtered.reduce((sum,d)=>sum+(Number(d.folios)||0),0);
  // Cargo searches and the initial random cargo list omit the entire Ubicación column.
  const showLocationColumn=!!search && !(filtered.length>0 &&
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
      const alertaTxt = (typeof d.antiguedad === 'number') ? d.antiguedad : d.antiguedad;
      const alertaClass = (typeof d.antiguedad === 'number' && d.antiguedad > 6) ? 'alerta-neg'
        : (typeof d.antiguedad === 'number' && d.antiguedad >= 5) ? 'alerta-warn' : 'alerta-pos';
      const req = reqs.find(r=>r.id===d.cajaAsignada);
      const cajaTxt = d.imConfirmado ? d.imCodigoCaja : (req ? req.numero : '—');
      const fechaEnvioTxt = d.imConfirmado ? d.imFechaEnvio : d.fEnvio;
      const responsableOrigen = d.imConfirmado ? d.imResponsable : d.usuario;
      const responsableTxt = !String(responsableOrigen||'').trim() || /^importaci[oó]n excel$/i.test(String(responsableOrigen).trim())
        ? 'Sin Responsable' : responsableOrigen;
      const estadoTxt = d.imConfirmado ? 'Enviado' : d.estado;
      const invoiceView=invoiceSearchPresentation(d,search);
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
        <td class="${alertaClass}">${alertaTxt}</td>
        <td>${highlightMatch(responsableTxt||'',search)}</td>
        <td>
          <button class="secondary" data-export-cargo="${d.id}" ${!d.cargos?.length?'disabled title="Este registro no tiene cargo asignado"':''}>Exportar este cargo</button>
          ${isAdmin ? `<button class="link" data-edit="${d.id}">Editar</button>
          <button class="danger" data-id="${d.id}">Eliminar</button>` : 'Solo consulta'}
        </td>
      </tr>`;
    }).join('');
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
  if (!file || !isAdmin || !appReady) { input.value = ''; return; }
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
  document.getElementById('appShell').hidden=true;
  document.getElementById('appShell').inert=true;
}
function showAuthPage(visible) {
  document.getElementById('sessionLoading').hidden=true;
  document.getElementById('authOverlay').hidden = !visible;
  document.getElementById('appShell').hidden = visible;
  document.getElementById('appShell').inert = visible;
}
function showRecoveryForm(recovering) {
  document.getElementById('btnRegister').hidden=recovering;
  document.getElementById('registerHelp').hidden=recovering;
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
    appReady = isAdmin = dataReady = false;
    reqs = []; docs = []; renderReqs(); renderDocs(); setAvailability();
    showSessionLoading();
  }
  if (!user) {
    idleSession.stop();
    showAuthPage(true);
    if (passwordRecovery) message('authMessage','El enlace de recuperación no es válido. Solicita uno nuevo.',true);
    passwordRecovery = false;
    showRecoveryForm(false);
    currentUserId = null; appReady = isAdmin = dataReady = channelReady = false;
    clearTimeout(refreshTimer);
    if (realtimeChannel) { await supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
    queryResults=null;queryError='';searchController?.abort();currentPage=0;
    reqs = []; docs = []; cancelarEdicionDoc(); cancelarEdicionReq(); renderReqs(); renderDocs();
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
    await refreshData();
    if (generation !== authGeneration) return;
    appReady = true;
    if(isAdmin) refreshGoogleSync();
    showAuthPage(false);
    message('authMessage','');
    document.getElementById('sessionUser').textContent = user.email || '';
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
  ev.preventDefault();if(!supabase || !passwordRecovery)return;
  const password=document.getElementById('newPassword').value;
  if(password.length<8){message('authMessage','Usa al menos 8 caracteres.',true);return;}
  if(password!==document.getElementById('confirmPassword').value){message('authMessage','Las contraseñas no coinciden.',true);return;}
  const button=document.getElementById('btnUpdatePassword');button.disabled=true;
  try{
    const {error}=await supabase.auth.updateUser({password});if(error)throw error;
    passwordRecovery=false;document.getElementById('resetPasswordForm').reset();
    showRecoveryForm(false);message('authMessage','Contraseña actualizada. Cargando tu aplicativo…');
    const {data,error:sessionError}=await supabase.auth.getSession();if(sessionError)throw sessionError;
    await handleSession(data.session);
  }catch(error){message('authMessage',readableError(error),true);}
  finally{button.disabled=false;}
});
async function signOut() {
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
window.addEventListener('offline',()=>{channelReady=false;setStatus('Sin conexión — Los cambios requieren conexión en línea','error');});
window.addEventListener('online',()=>{if(currentUserId){subscribeRealtime();scheduleRefresh();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden && currentUserId && appReady)scheduleRefresh();});
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
    if (event === 'PASSWORD_RECOVERY') passwordRecovery = true;
    if (event === 'TOKEN_REFRESHED' && currentUserId === session?.user?.id) { if(idleSession.check())scheduleRefresh(); return; }
    setTimeout(()=>handleSession(session),0);
  });
  try {
    const {data,error} = await supabase.auth.getSession();
    if(error)throw error;
    if(!currentUserId)await handleSession(data.session);
  }catch(error){showAuthPage(true);message('authMessage',readableError(error),true);}
}

document.getElementById('btnRegister').addEventListener('click',async ev=>{
  if(!supabase)return;
  const input=document.getElementById('authEmail'),password=document.getElementById('authPassword').value;
  if(!input.reportValidity())return;
  if(password.length<8){message('authMessage','Escribe una contraseña de al menos 8 caracteres para crear tu cuenta.',true);return;}
  const button=ev.currentTarget;button.disabled=true;
  try {
    const {error}=await supabase.auth.signUp({email:input.value.trim().toLowerCase(),password,options:{emailRedirectTo:window.location.origin+'/'}});
    if(error)throw error;
    document.getElementById('authPassword').value='';
    message('authMessage','Revisa tu correo y confirma tu cuenta. Al abrir el enlace entrarás automáticamente como invitado de solo consulta.');
  }catch(error){message('authMessage',readableError(error),true);}
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
      const activated=!!data.enabled && result.verified===true;
      badge.dataset.status=!data.enabled?'paused':activated?'active':'loading';
      document.getElementById('googleSyncBadgeText').textContent=!data.enabled?'PAUSADA':activated?'EN TIEMPO REAL':'POR ACTIVAR';
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
    document.getElementById('googleSyncStatus').textContent=data.status||'Sin estado informado';
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
    if(appReady && isAdmin && expiryGroups.today !== limaDate(new Date())) renderDocs();
  }
},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshGoogleSync();});
document.getElementById('btnToggleGoogleSync').addEventListener('click',async ev=>{
  if(!appReady||!isAdmin)return;
  ev.currentTarget.disabled=true;
  try{
    const {error}=await supabase.from('kardex_google_sync').update({enabled:!googleSyncEnabled}).eq('id',true);
    if(error)throw error;await refreshGoogleSync();
  }catch(error){document.getElementById('googleSyncStatus').textContent=readableError(error);ev.currentTarget.disabled=false;}
});
