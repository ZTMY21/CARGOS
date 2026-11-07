import {parseBoxScan,findPreparedBox} from './box-scanner.js';
import {parseCargoCell} from './im-requests.js';

const states={EN_PREPARACION:'En acondicionamiento',OBSERVADA:'Observada',LISTA:'Lista para recojo'};
export function attachBoxConditioning({supabase,repository,isAdmin,appReady,isPreview,sheetRequest=null,isolatedReception=false,onChanged=()=>{}}){
 const el=id=>document.getElementById(id);
 const code=el('conditionCode'),classification=el('conditionClass'),cargos=el('conditionCargos'),
   issue=el('conditionIssue'),message=el('conditionMessage'),detail=el('conditionDetail'),
   summary=el('conditionSummary'),driveStatus=el('conditionSheetsStatus'),retry=el('conditionRetryDrive'),
   scanInput=el('conditionScanInput'),scanNotice=el('conditionScanFeedback');
 const buttons={iniciar:el('conditionStart'),observar:el('conditionObserve'),
   resolver:el('conditionResolve'),finalizar:el('conditionFinish')};
 let active=false,busy=false,entries=new Map(),selected='',originKnown=false,queue=Promise.resolve();
 let sourceRows=[],sourceLoaded=false,sourceLoading=false,scanTimer=null,sourceEpoch=0;
 const clearScanTimer=()=>{
   if(scanTimer!==null){clearTimeout(scanTimer);scanTimer=null;}
 };
 const refreshSource=async()=>{
   if(!active||!appReady()||!isAdmin()||sourceLoading||!repository?.preparedImDetails)return;
   sourceLoading=true;
   const version=++sourceEpoch;
   scanNotice.textContent='Consultando cargos y cajas pendientes…';
   try{
     const rows=await repository.preparedImDetails();
     if(version!==sourceEpoch||!active)return;
     if(!Array.isArray(rows))throw Error('Lista de cajas inválida');
     sourceRows=rows;sourceLoaded=true;
     scanNotice.textContent='Consulta de cajas disponible. Escanea para iniciar.';
   }catch{
     if(version===sourceEpoch){
       sourceLoaded=false;sourceRows=[];
       scanNotice.textContent='No se pudo actualizar los cargos. Puedes consultar manualmente.';
     }
   }finally{sourceLoading=false;}
 };
 const processScan=()=>{
   clearScanTimer();
   if(!active||!appReady()||!isAdmin()||busy)return;
   const scanCode=parseBoxScan(scanInput.value);
   if(!scanCode.ok){scanNotice.textContent=scanCode.reason;return;}
   scanInput.value='';
   const found=findPreparedBox(sourceLoaded?sourceRows:[],scanCode.original);
   scanNotice.textContent=!sourceLoaded?
    'Caja recibida. La fuente de cargos aún no está disponible; verifica los datos antes de registrar.':
    found.found?'Caja localizada. Revisa los cargos antes de guardar.':
    'Caja no encontrada entre pendientes. Verifica los cargos y la clasificación.';
   scan({scan:scanCode,found});
   scanInput.focus();
 };
 el('conditionScanSubmit').addEventListener('click',processScan);
 el('conditionScanRefresh').addEventListener('click',()=>{void refreshSource();});
 scanInput.addEventListener('keydown',event=>{
   if(!active)return;
   if(event.key==='Enter'||(event.key==='Tab'&&parseBoxScan(scanInput.value).ok)){
     event.preventDefault();processScan();
   }
 });
 scanInput.addEventListener('input',()=>{
   clearScanTimer();
   if(!active||busy||!appReady()||!isAdmin())return;
   const typed=scanInput.value;
   if(!parseBoxScan(typed).ok)return;
   scanTimer=setTimeout(()=>{
     scanTimer=null;
     if(active&&!busy&&scanInput.value===typed&&parseBoxScan(typed).ok)processScan();
   },650);
 });
 const requestSheet=sheetRequest||(async(action,box)=>{
   if(isolatedReception){
     const state=await repository.reception();
     const code=parseBoxScan(box).normalized;
     if(!state?.confirmada||!state.lecturas.some(row=>row.clave===code))throw Error('La caja no pertenece a una recepción confirmada.');
     return repository.receptionExcel('acondicionar',state.id,code);
   }
   const {data,error}=await supabase.auth.getSession();
   if(error||!data?.session?.access_token)throw Error('Inicia sesión para guardar en Google Drive.');
   const response=await fetch('/api/box-excel',{
     method:'POST',credentials:'same-origin',
     headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},
     body:JSON.stringify({action,code:box})
   });
   const result=await response.json().catch(()=>({}));
   if(!response.ok||result.verified!==true){
     throw Error(result.error==='IM_SOURCE_CONFLICT'?
       'La caja ya existe en el Excel Maestro con cargos o clasificación diferentes. Revisa CARGOS ENVIADOS.':
       'El Excel Maestro no confirmó el registro. Revisa la única hoja antes de reintentar.');
   }
   return result;
 });
 const enqueue=(action,box)=>{
   const job=queue.catch(()=>{}).then(()=>requestSheet(action,box));
   queue=job;return job;
 };
 const syncSheet=async(box)=>{
   driveStatus.textContent='Sincronizando acondicionamiento con Google Drive…';
   try{
     const result=await enqueue('sync',box);
     driveStatus.textContent=result.sourceSynced
       ? (isolatedReception?'Maestro de prueba actualizado: CARGOS ENVIADOS.':'Excel Maestro actualizado: CARGOS ENVIADOS.')
       :'Acondicionamiento registrado en Kárdex. Se reflejará en el Excel Maestro al estar lista la caja.';
     retry.disabled=true;
     return true;
   }catch{
     driveStatus.textContent='Guardado en Kárdex; Excel Maestro pendiente. Verifica el archivo y usa Reintentar.';
     retry.disabled=false;
     return false;
   }
 };
 const admin=()=>appReady()&&isAdmin();
 const renderStatus=(msg,error=false)=>{message.textContent=msg;message.style.color=error?'var(--red)':'var(--muted)';};
 const setButtons=()=>{
  const item=entries.get(selected);
  const mutable=admin()&&(!isPreview()||isolatedReception)&&!busy&&!!selected;
  buttons.iniciar.disabled=!mutable||!!item;
  retry.disabled=!mutable||!item;
  buttons.observar.disabled=!mutable||!item||item.status==='LISTA';
  buttons.resolver.disabled=!mutable||!item||item.status!=='OBSERVADA';
  buttons.finalizar.disabled=!mutable||!item||item.status!=='EN_PREPARACION';
  // Once started, the source of truth is the server; no retroactive editing of cargo links.
  classification.disabled=!mutable||!!item||originKnown;
  cargos.disabled=!mutable||!!item||originKnown;
  issue.disabled=!mutable||!item||item.status==='LISTA';
 };
 const renderSummary=()=>{
  let started=0,observed=0,ready=0;
  for(const item of entries.values()){
    if(item.status==='EN_PREPARACION')started++;
    else if(item.status==='OBSERVADA')observed++;
    else if(item.status==='LISTA')ready++;
  }
  summary.textContent=started+' en preparación · '+observed+' observadas · '+ready+' listas para recojo';
  const stats=[['conditionKpiPreparing',started],['conditionKpiObserved',observed],['conditionKpiReady',ready]];
  for(const [id,count] of stats){const target=el(id);if(target)target.textContent=String(count);}
 };
 const renderSelected=()=>{
  detail.replaceChildren();
  const item=entries.get(selected);
  if(!selected){detail.textContent='Escanea una caja para registrar su acondicionamiento.';}
  else if(!item){detail.textContent='Caja '+code.value+': acondicionamiento sin iniciar.';}
  else{
    const p=document.createElement('p');p.textContent=states[item.status]||item.status;detail.append(p);
    const meta=document.createElement('p');
    meta.textContent='Cargos: '+(item.cargos||[]).join(', ')+
      ' · '+item.classification+
      ' · Inicio: '+new Date(item.started_at).toLocaleString('es-PE');
    detail.append(meta);
    if(item.status==='LISTA'&&item.finished_at){
      const duration=Math.max(0,Math.round((new Date(item.finished_at)-new Date(item.started_at))/60000));
      const t=document.createElement('p');t.textContent='Preparación terminada · '+duration+' min';detail.append(t);
    }
    if(item.status==='OBSERVADA'&&item.observation){
      const p=document.createElement('p');p.textContent='Incidencia: '+item.observation;detail.append(p);
    }
  }
  setButtons();renderSummary();
 };
 const load=async()=>{
  if(!admin()||!active||busy)return;
  try{
    const {data,error}=await supabase.rpc('kardex_box_conditioning_list');
    if(error)throw error;
    if(!active||busy)return;
    const found=new Map();
    for(const record of Array.isArray(data)?data:[]){
      if(record&&typeof record.code==='string')found.set(record.code,record);
    }
    entries=found;renderSelected();
  }catch{
    renderStatus('No se pudo consultar acondicionamientos. Usa Actualizar.',true);
  }
 };
 const scan=({scan,found})=>{
  if(!active||!admin()||!scan?.ok)return;
  if(busy){renderStatus('Termina el registro actual antes de acondicionar otra caja.');return;}
  if(!isPreview()){
    driveStatus.textContent='Verificando lectura en el aplicativo…';
    void enqueue('scan',scan.original).then(()=>{
      if(selected===scan.normalized)driveStatus.textContent='Lectura verificada. El Excel Maestro no cambia hasta finalizar la preparación.';
    }).catch(()=>{
      if(selected===scan.normalized)driveStatus.textContent=
        'No se pudo verificar la lectura. Revisa la conexión antes de continuar.';
    });
  }else{driveStatus.textContent='Vista previa: no se modifica el Excel Maestro.';}
  selected=scan.normalized;
  code.value=scan.original;
  originKnown=Boolean(found?.found);
  const item=entries.get(selected);
  if(item){
    classification.value=item.classification;
    cargos.value=(item.cargos||[]).join(', ');
    issue.value=item.status==='OBSERVADA'?item.observation:'';
  }else{
    let cl=(found?.clasificaciones||[]).find(x=>/solicitud/i.test(x))?'POR SOLICITUD':
      (found?.clasificaciones||[]).some(x=>/reparaci/i.test(x))?'Reparación':'Cajas Nuevas';
    classification.value=cl;
    cargos.value=(found?.cargos||[]).join(', ');
    issue.value='';
  }
  renderStatus('');renderSelected();
 };
 const execute=async action=>{
  if(!admin()||(isPreview()&&!isolatedReception)||busy||!selected)return;
  const target=selected;
  const payload={p_action:action,p_box:code.value,p_cargos:[],
    p_classification:classification.value,p_observation:issue.value.trim()};
  if(action==='iniciar'){
    payload.p_cargos=parseCargoCell(cargos.value);
    if(!payload.p_cargos.length)return renderStatus('Indica los cargos de la caja.',true);
    if(!confirm('¿Registrar el inicio del acondicionamiento de '+code.value+'?'))return;
  }
  if(action==='observar'&&!issue.value.trim())return renderStatus('Describe la incidencia.',true);
  if(action==='finalizar'&&!confirm('¿La caja está revisada y lista para recojo? Esto no registra su envío a Iron Mountain.'))return;
  if(action==='resolver'&&!confirm('¿La incidencia fue resuelta?'))return;
  busy=true;setButtons();renderStatus('Guardando '+code.value+'…');
  try{
    const {data,error}=await supabase.rpc('kardex_box_conditioning_write',payload);
    if(error)throw error;
    if(data?.code!==target)throw Error('No se confirmó el código de caja.');
    entries.set(data.code,data);
    if(action==='iniciar'){originKnown=true;classification.value=data.classification;cargos.value=(data.cargos||[]).join(', ');}
    if(action==='resolver')issue.value='';
    renderStatus(action==='finalizar'?'Caja lista para recojo. No se ha registrado su envío a Iron Mountain.':
      action==='iniciar'?'Acondicionamiento iniciado.':
      action==='observar'?'Incidencia registrada.':'Incidencia resuelta.');
    if(!isolatedReception||action==='finalizar')await syncSheet(data.original_code||code.value);
    if(isolatedReception)await onChanged();
  }catch(e){renderStatus(e?.message||'No se pudo guardar. Revisa el estado de la caja.',true);}
  finally{busy=false;renderSelected();}
 };
 for(const [action,button] of Object.entries(buttons))button.addEventListener('click',()=>{void execute(action);});
 el('conditionReload').addEventListener('click',()=>{void load();});
 retry.addEventListener('click',async()=>{
   if(!admin()||(isPreview()&&!isolatedReception)||!selected||busy||!entries.has(selected))return;
   const box=code.value;busy=true;setButtons();
   await syncSheet(box);
   busy=false;setButtons();
 });
 renderSelected();
 return {
  scan,
  activate(){
    active=true;
    if(admin()){void load();if(!sourceLoaded)void refreshSource();scanInput.focus();}
  },
  deactivate(){active=false;clearScanTimer();sourceEpoch++;sourceLoading=false;},
  reset(){
    active=false;sourceEpoch++;sourceLoading=false;clearScanTimer();
    sourceRows=[];sourceLoaded=false;entries=new Map();selected='';originKnown=false;
    code.value='';cargos.value='';issue.value='';scanInput.value='';
    scanNotice.textContent='Sin lecturas de acondicionamiento';
    renderStatus('');driveStatus.textContent='Destino: Excel Maestro de Iron Mountain';retry.disabled=true;renderSelected();
  }
 };
}
