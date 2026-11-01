import {parseBoxScan} from './box-scanner.js';
import {parseCargoCell} from './im-requests.js';

const states={EN_PREPARACION:'En acondicionamiento',OBSERVADA:'Observada',LISTA:'Lista para recojo'};
export function attachBoxConditioning({supabase,isAdmin,appReady,isPreview,sheetRequest=null}){
 const el=id=>document.getElementById(id);
 const code=el('conditionCode'),classification=el('conditionClass'),cargos=el('conditionCargos'),
   issue=el('conditionIssue'),message=el('conditionMessage'),detail=el('conditionDetail'),
   summary=el('conditionSummary'),driveStatus=el('boxSheetsStatus'),retry=el('conditionRetryDrive');
 const buttons={iniciar:el('conditionStart'),observar:el('conditionObserve'),
   resolver:el('conditionResolve'),finalizar:el('conditionFinish')};
 let active=false,busy=false,entries=new Map(),selected='',originKnown=false,queue=Promise.resolve();
 const requestSheet=sheetRequest||(async(action,box)=>{
   const {data,error}=await supabase.auth.getSession();
   if(error||!data?.session?.access_token)throw Error('Inicia sesión para guardar en Google Drive.');
   const response=await fetch('/api/box-sheets',{
     method:'POST',credentials:'same-origin',
     headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},
     body:JSON.stringify({action,code:box})
   });
   const result=await response.json().catch(()=>({}));
   if(!response.ok||result.googleVerified!==true){
     throw Error(result.error==='IM_SOURCE_CONFLICT'?
       'La caja ya existe con cargos o clasificación diferentes. Revisa CARGOS ENVIADOS.':
       'Google Sheets no confirmó el registro. No repitas sin revisar primero la hoja.');
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
       ?'Google Sheets actualizado: CONTROL DE CAJAS y CARGOS ENVIADOS.'
       :'Google Sheets actualizado: CONTROL DE CAJAS.';
     retry.disabled=true;
     return true;
   }catch{
     driveStatus.textContent='Guardado en Kárdex; Google Sheets pendiente. Revisa la hoja y usa Reintentar Drive.';
     retry.disabled=false;
     return false;
   }
 };
 const admin=()=>appReady()&&isAdmin();
 const renderStatus=(msg,error=false)=>{message.textContent=msg;message.style.color=error?'var(--red)':'var(--muted)';};
 const setButtons=()=>{
  const item=entries.get(selected);
  const mutable=admin()&&!isPreview()&&!busy&&!!selected;
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
    driveStatus.textContent='Guardando lectura en Google Sheets…';
    void enqueue('scan',scan.original).then(()=>{
      if(selected===scan.normalized)driveStatus.textContent='Lectura registrada en Google Drive.';
    }).catch(()=>{
      if(selected===scan.normalized)driveStatus.textContent=
        'Lectura pendiente en Google Sheets. Revisa la conexión y vuelve a escanear.';
    });
  }else{driveStatus.textContent='Vista previa: no se modifica Google Sheets.';}
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
  if(!admin()||isPreview()||busy||!selected)return;
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
    await syncSheet(data.original_code||code.value);
  }catch(e){renderStatus(e?.message||'No se pudo guardar. Revisa el estado de la caja.',true);}
  finally{busy=false;renderSelected();}
 };
 for(const [action,button] of Object.entries(buttons))button.addEventListener('click',()=>{void execute(action);});
 el('conditionReload').addEventListener('click',()=>{void load();});
 retry.addEventListener('click',async()=>{
   if(!admin()||isPreview()||!selected||busy||!entries.has(selected))return;
   const box=code.value;busy=true;setButtons();
   await syncSheet(box);
   busy=false;setButtons();
 });
 renderSelected();
 return {
  scan,
  activate(){active=true;if(admin())void load();},
  deactivate(){active=false;},
  reset(){
    active=false;entries=new Map();selected='';originKnown=false;code.value='';cargos.value='';issue.value='';
    renderStatus('');driveStatus.textContent='Destino: Google Sheets del Drive';retry.disabled=true;renderSelected();
  }
 };
}
