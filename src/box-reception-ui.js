import {parseReceptionScan} from './box-scanner.js';
import {escapeHtml as html} from './rules.js';

const lima = new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',dateStyle:'short',timeStyle:'short'});
export const receptionTime = value => value ? lima.format(new Date(value))+' (Lima)' : '—';
export const receptionStatus = state => state.confirmada ? 'Recepción completa' :
  Number(state.leidas??state.lecturas?.length) ? 'Recepción en proceso' : 'Solicitud pendiente';

export function attachBoxReception({repository,refresh}) {
  const el = id => document.getElementById(id);
  const mode = el('boxReceptionMode'), input = el('boxScanInput'), progress = el('boxReceptionProgress');
  const save = el('boxReceptionSave'), confirm = el('boxReceptionConfirm'), download = el('boxReceptionDownload');
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
    const full=!!total&&readings.length===total;
    mode.disabled=!total||full||complete;
    if (mode.disabled) mode.checked=false;
    progress.hidden=!total;
    card.hidden=!total||documentMode;
    card.parentElement.dataset.receptionView=String(!card.hidden);
    save.disabled=running>0||!total||readings.length===saved||complete;
    confirm.disabled=running>0||!full||complete;
    download.disabled=!state||saved===0;
    el('boxReceptionCount').textContent=readings.length+'/'+total+' cajas recepcionadas';
    el('boxReceptionBadge').textContent=state ? receptionStatus(state) : 'Sin solicitud activa';
    progress.dataset.state=full?'complete':'pending';
    const bar=el('boxReceptionBar');
    bar.max=total||100;bar.value=readings.length;
    el('boxReceptionPending').textContent=complete
      ? 'Confirmada el '+receptionTime(state.confirmada)+'. El acondicionamiento se registra por separado.'
      : saved+' guardadas en el Maestro de prueba · '+(readings.length-saved)+' pendientes de consolidar';
    el('boxSheetsStatus').textContent=state ? 'Destino: Maestro de prueba · CARGOS ENVIADOS' :
      'Solicita cajas nuevas en Requerimientos para iniciar la recepción.';
    el('boxScanHint').textContent=mode.checked ?
      'Escanea códigos completos de 10 dígitos. Se registran automáticamente con o sin Enter.' :
      'Usa Consultar caja para buscar documentos, o activa la recepción para registrar códigos nuevos.';
    el('boxScanCount').textContent=String(readings.length);
    if (!state) {card.replaceChildren();return;}
    const last=readings.at(-1);
    card.innerHTML='<strong>'+html(state.numero)+' · '+total+' cajas nuevas</strong>'+
      '<p>'+html(receptionStatus(state))+' · '+html(state.solicitante)+'</p>'+
      '<p>Solicitada el '+html(receptionTime(state.creada))+'</p>'+
      (last?'<p>Último código <strong>'+html(last.codigo)+'</strong> · '+html(receptionTime(last.leido))+'</p>':'');
    if (documentMode) return;
    el('boxScanHistoryTitle').textContent='Últimos códigos escaneados';
    history.innerHTML=[...readings].reverse().map(row=>'<li><strong>'+html(row.codigo)+'</strong><span>'+
      html(receptionTime(row.leido))+'</span><span class="reception-read-state">'+
      (complete?'Confirmada':row.guardado?'Guardada en Maestro':'Pendiente de consolidar')+'</span></li>').join('');
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
      next.lecturas.filter(row=>row.guardado).length+'/'+next.cantidad+' cajas verificadas en el Maestro de prueba.')?.then(refreshSummary);
  });
  confirm.addEventListener('click',()=>{
    if (confirm.disabled) return;
    void enqueue(id=>repository.receptionExcel('completa',id),next=>
      'Recepción completa: '+next.cantidad+'/'+next.cantidad+' · '+receptionTime(next.confirmada))?.then(refreshSummary);
  });
  download.addEventListener('click',async()=>{
    if (!state) return;
    try {
      const blob=await repository.receptionExcel('descargar',state.id);
      const url=URL.createObjectURL(blob), a=document.createElement('a');
      a.href=url;a.download='Maestro_Recepcion_Prueba.xlsx';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(error) {notify(error.message,true);}
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
