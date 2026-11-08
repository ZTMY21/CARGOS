import {parseReceptionScan} from './box-scanner.js';
import {escapeHtml as html,fmtDate,REQ_TYPES} from './rules.js';

const lima = new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',dateStyle:'short',timeStyle:'short'});
export const receptionTime = value => /^\d{4}-\d{2}-\d{2}$/.test(value||'') ? fmtDate(value)+' (Lima)' : value ? lima.format(new Date(value))+' (Lima)' : '—';
export const receptionStatus = state => state.confirmada ? (state.recepcion_fisica?'Registro de cajas completo':'Recepción completa') :
  state.recepcion_fisica ? 'Registro de cajas en proceso' :
    Number(state.leidas??state.lecturas?.length) ? 'Recepción en proceso' : 'Solicitud pendiente';

export function requestReception(row,tracking) {
  const receipt=tracking?.suministro?.solicitudes?.find(item=>item.id===row.id);
  const total=Number(row.cantidadCajas);
  const confirmada=receipt?.confirmada||row.fechaRecepcion||null;
  const leidas=receipt?.leidas??(row.estadoV4==='Recibido' ? total : row.recibidoV4??0);
  const fisica=tracking?.movimientos?.find(item=>item.requerimiento===row.id && item.tipo==='recepcion_fisica_informada');
  return {...receipt,confirmada,leidas,...(fisica?{recepcion_fisica:fisica.datos.cantidad}:{})};
}

export function renderReceptionOverview(root,rows,visible) {
  const el=id=>root.querySelector('#'+id);
  const progress=el('boxReceptionProgress');
  progress.hidden=!visible;
  if(!visible)return;
  const row=[...rows].reverse().find(item=>item.tipo===REQ_TYPES[0] && Number(item.cantidadCajas)>0 &&
    !item.fechaRecepcion && item.estadoV4!=='Recibido');
  const receipt=row&&requestReception(row);
  const bar=el('boxReceptionBar');
  bar.hidden=!row;
  bar.max=Number(row?.cantidadCajas)||100;
  bar.value=receipt?.leidas||0;
  el('boxReceptionCount').textContent=row
    ? row.numero+' · '+receipt.leidas+'/'+row.cantidadCajas+' cajas registradas'
    : 'Sin solicitud activa de cajas nuevas';
  el('boxReceptionBadge').textContent='Modo consulta';
  el('boxReceptionPending').textContent='El guardado de recepción está pendiente de la conciliación de cajas existentes con el Maestro de Iron Mountain.';
}

export function attachBoxReception({repository,refresh,live=false}) {
  const master=live?'Excel Maestro de Iron Mountain':'Maestro de prueba';
  const el = id => document.getElementById(id);
  const mode = el('boxReceptionMode'), input = el('boxScanInput'), progress = el('boxReceptionProgress');
  const save = el('boxReceptionSave'), confirm = el('boxReceptionConfirm');
  const card = el('boxReceptionCard'), history = el('boxScanHistory'), feedback = el('boxScanFeedback');
  let active=false, state=null, epoch=0, version=0, running=0, job=Promise.resolve(), poll=null, documentMode=false;
  const notify = (message,error=false) => {
    feedback.textContent=message;
    feedback.style.color=error?'var(--red)':'var(--muted)';
  };
  const refreshSummary=()=>refresh().catch(()=>{});
  const render = () => {
    const readings=state?.lecturas||[], total=state?.cantidad||0;
    const saved=readings.filter(row=>row.guardado).length;
    const complete=!!state?.confirmada;
    const physical=state?.recepcion_fisica;
    const matched=readings.filter(row=>row.origen==='maestro').length;
    const full=!!total&&readings.length===total;
    const readOnly=live&&state?.escritura_habilitada!==true;
    mode.disabled=readOnly||!total||full||complete;
    if (mode.disabled) mode.checked=false;
    progress.hidden=!total;
    card.hidden=!total||documentMode;
    card.parentElement.dataset.receptionView=String(!card.hidden);
    save.disabled=readOnly||running>0||!total||readings.length===saved||complete;
    confirm.disabled=readOnly||running>0||!full||complete;
    confirm.textContent=physical?'Confirmar registro de todas las cajas':'Confirmar recepción completa';
    el('boxReceptionCount').textContent=readings.length+'/'+total+(physical?' cajas registradas por código':' cajas recepcionadas');
    el('boxReceptionBadge').textContent=state ? (readOnly?'Modo consulta':receptionStatus(state)) : 'Sin solicitud activa';
    progress.dataset.state=full?'complete':'pending';
    const bar=el('boxReceptionBar');
    bar.max=total||100;bar.value=readings.length;
    el('boxReceptionPending').textContent=complete
      ? 'Confirmada el '+receptionTime(state.confirmada)+'. El acondicionamiento se registra por separado.'
      : readOnly ? 'El registro en el Excel Maestro está pendiente de habilitación.'
      : physical
        ? physical+' recibidas físicamente · '+matched+' conciliadas del Maestro · '+(readings.length-matched)+
          ' escaneadas aquí · '+(total-readings.length)+' por registrar'
        : saved+' guardadas en el '+master+' · '+(readings.length-saved)+' pendientes de consolidar';
    el('boxSheetsStatus').textContent=state ? 'Destino: '+master+' · CARGOS ENVIADOS' :
      'Solicita cajas nuevas en Requerimientos para iniciar la recepción.';
    el('boxScanHint').textContent=mode.checked ?
      'Escanea códigos completos de 10 dígitos. Se registran automáticamente con o sin Enter.' :
      'Usa Consultar caja para buscar documentos, o activa la recepción para registrar códigos nuevos.';
    el('boxScanCountLabel').textContent=physical?'Códigos únicos':'Lecturas únicas';
    el('boxScanCount').textContent=String(readings.length);
    if (!state) {card.replaceChildren();return;}
    const requested=total===1?'1 caja nueva solicitada':total+' cajas nuevas solicitadas';
    card.innerHTML='<strong>'+html(state.numero)+' · '+requested+'</strong>';
    if (documentMode) return;
    el('boxScanHistoryTitle').textContent=physical?'Códigos registrados':'Últimos códigos escaneados';
    history.innerHTML=[...readings].reverse().map(row=>'<li><strong>'+html(row.codigo)+'</strong><span>'+
      html(receptionTime(row.leido))+'</span><span class="reception-read-state">'+
      (row.origen==='maestro'?'Conciliada del Maestro':complete?'Confirmada':row.guardado?'Guardada en Maestro':'Pendiente de consolidar')+'</span></li>').join('');
  };
  const load = async () => {
    const call=epoch, revision=version;
    if (running||!active) return;
    try {
      const data=await repository.reception();
      if (!active||epoch!==call||revision!==version||running) return;
      if (state?.id!==data?.id) mode.checked=false;
      state=data;render();
    } catch {
      if (active&&epoch===call) notify('No se pudo consultar la recepción. Vuelve a abrir Control de cajas.',true);
    }
  };
  const enqueue = (operation,success) => {
    const call=epoch, id=state?.id;
    if (!id||!active) return;
    version++;running++;render();
    job=job.then(async()=>{
      try {
        if (epoch!==call) return;
        const next=await operation(id);
        if (epoch!==call) return;
        state=next;
        if (active) notify(success(next));
      } catch(error) {
        if (active&&epoch===call) notify(error.message,true);
      } finally {
        if (epoch===call) {
          running--;
          if (active) render();
        }
      }
    });
    return job;
  };
  mode.addEventListener('change',()=>{
    documentMode=!mode.checked;
    if (mode.checked) {
      input.value='';
      el('boxScanResult').replaceChildren();
      notify('Registro automático activado para '+state.numero+'.');
    }
    render();input.focus();
  });
  save.addEventListener('click',()=>{
    if (save.disabled) return;
    void enqueue(id=>repository.receptionExcel('parcial',id),next=>
      next.lecturas.filter(row=>row.guardado).length+'/'+next.cantidad+' cajas verificadas en el '+master+'.')?.then(refreshSummary);
  });
  confirm.addEventListener('click',()=>{
    if (confirm.disabled) return;
    void enqueue(id=>repository.receptionExcel('completa',id),next=>
      receptionStatus(next)+': '+next.cantidad+'/'+next.cantidad+' · '+receptionTime(next.confirmada))?.then(refreshSummary);
  });
  el('boxReceptionModeLabel').hidden=false;
  return {
    activate(){
      active=true;documentMode=false;
      void load();
      clearInterval(poll);poll=setInterval(load,5000);
    },
    deactivate(){active=false;mode.checked=false;clearInterval(poll);},
    reset(){active=false;state=null;running=0;epoch++;mode.checked=false;documentMode=false;clearInterval(poll);render();},
    stop(){
      if (!mode.checked && !state) return;
      mode.checked=false;documentMode=true;
      el('boxScanHistoryTitle').textContent='Historial de consultas';
      render();
    },
    showing(){return !!state&&!documentMode;},
    armed(){return active&&mode.checked&&!!state&&!state.confirmada;},
    scan(){
      const parsed=parseReceptionScan(input.value);
      input.value='';input.focus();
      el('ivScannerCaption').textContent='ESPERANDO UN CÓDIGO DE CAJA';
      if (!parsed.ok) {notify(parsed.reason,true);return;}
      documentMode=false;
      void enqueue(id=>repository.reception('leer',id,parsed.original),next=>next.duplicada ?
        'Caja repetida. La lectura no incrementó el contador.' : 'Caja '+parsed.original+' registrada en la solicitud.');
    }
  };
}
