// Mejoras de experiencia visual exclusivamente en la intervención.
// Nunca simula registros, crea cajas, envía correos ni llama a Supabase.
// Los datos y eventos pertenecen a las funciones operativas existentes.
export function attachInterventionExperience({doc=document}={}){
 const byId=id=>doc.getElementById(id);
 const observers=[];
 const Mutation=doc.defaultView?.MutationObserver||globalThis.MutationObserver;
 const watch=(element,callback)=>{
  if(!element||!Mutation)return;
  const observer=new Mutation(callback);
  observer.observe(element,{childList:true,characterData:true,subtree:true});
  observers.push(observer);
 };
 const file=byId('scanFile'),drop=byId('ivDropzone');
 const summary=byId('scanSummary'),status=byId('scanStatus');
 const fileStatus=byId('ivFileStatus'),fileName=byId('scanFileName');
 const empty=byId('ivScanEmpty');
 function renderFile(){
  if(!file||!summary||!empty)return;
  const chosen=file.files?.length>0;
  const pasted=Boolean(byId('scanPaste')?.value.trim());
  const selected=chosen||pasted;
  const validated=!summary.hidden;
  empty.hidden=validated;
  byId('ivStepSelect')?.classList.toggle('active',selected);
  byId('ivStepValidate')?.classList.toggle('active',validated);
  byId('ivStepSave')?.classList.toggle('active',!byId('scanSave')?.disabled);
  if(fileStatus){
   const message=status?.textContent||'';
   fileStatus.textContent=!selected?'Esperando archivo Excel':
    validated?'Validación realizada · '+(message||'Revisa los resultados'):
    chosen?'Archivo detectado · Listo para validar':'Datos pegados · Listos para validar';
  }
 }
 if(file&&drop){
  file.addEventListener('change',renderFile);
  byId('scanPaste')?.addEventListener('input',renderFile);
  drop.tabIndex=0;
  drop.setAttribute('role','button');
  drop.setAttribute('aria-label','Seleccionar o soltar un archivo Excel para validar');
  drop.addEventListener('click',event=>{
   if(event.target.closest('label,input,button'))return;
   file.click();
  });
  drop.addEventListener('keydown',event=>{
   if(event.target!==drop)return;
   if(event.key==='Enter'||event.key===' '){event.preventDefault();file.click();}
  });
  drop.addEventListener('dragover',event=>{
   event.preventDefault();drop.classList.add('is-dragging');
  });
  drop.addEventListener('dragleave',event=>{
   if(!drop.contains(event.relatedTarget))drop.classList.remove('is-dragging');
  });
  drop.addEventListener('drop',event=>{
   event.preventDefault();drop.classList.remove('is-dragging');
   const files=event.dataTransfer?.files;
   if(!files?.length)return;
   if(!/\.(xlsx|xlsm)$/i.test(files[0].name)){
    if(fileStatus)fileStatus.textContent='Selecciona un archivo Excel .xlsx o .xlsm.';
    return;
   }
   try{
    file.files=files;
    file.dispatchEvent(new doc.defaultView.Event('change',{bubbles:true}));
   }catch{
    // El navegador puede restringir el intercambio de FileList.
    // Nunca simulamos que se cargó un archivo que no llegó al input original.
    if(fileStatus)fileStatus.textContent='Usa Seleccionar archivo para cargar el Excel.';
   }
  });
  watch(status,renderFile);
  watch(fileName,renderFile);
  watch(byId('scanStage'),renderFile);
  const validate=byId('scanValidate'),save=byId('scanSave');
  validate?.addEventListener('click',()=>{
   byId('ivStepValidate')?.classList.add('active');
   // Al completarse la validación, los indicadores se llenan desde el módulo real.
  });
  save?.addEventListener('click',()=>{
   if(!save.disabled)byId('ivStepSave')?.classList.add('active');
  });
  renderFile();
 }
 let boxPulse=0,conditionPulse=0;
 const shortPulse=(target,which)=>{
  if(!target)return;
  target.classList.add('is-reading');
  if(which==='box')boxPulse++;
  else conditionPulse++;
  const current=which==='box'?boxPulse:conditionPulse;
  // Visual solamente: no inicia ninguna lectura ni confirma resultados.
  setTimeout(()=>{
   if((which==='box'?boxPulse:conditionPulse)===current)
    target.classList.remove('is-reading');
  },800);
 };
 const scanStatus=byId('boxScannerStatus'),boxResult=byId('boxScanResult'),
  scanner=byId('ivScannerVisual'),boxChip=byId('ivBoxMatch'),
  boxEmpty=byId('ivBoxEmpty'),caption=byId('ivScannerCaption');
 const renderBox=()=>{
  if(!boxResult||!boxEmpty||!boxChip)return;
  const present=boxResult.children.length>0;
  boxEmpty.hidden=present;
  if(!present){
   boxChip.textContent='Sin consultar';
   boxChip.dataset.state='';
   if(caption)caption.textContent='ESPERANDO UN CÓDIGO DE CAJA';
   scanner?.classList.remove('has-read');
   return;
  }
  const content=boxResult.textContent||'';
  const found=content.includes('Clasificación:')&&content.includes('Cargos:');
  boxChip.textContent=found?'Caja identificada':'Por verificar';
  boxChip.dataset.state=found?'success':'warning';
  scanner?.classList.toggle('has-read',found);
  if(caption)caption.textContent=found?'CÓDIGO RECIBIDO · CAJA LOCALIZADA':'CÓDIGO RECIBIDO · VERIFICAR ESTADO';
 };
 const boxInput=byId('boxScanInput');
 boxInput?.addEventListener('input',()=>{
  shortPulse(scanner,'box');
  if(caption)caption.textContent='LEYENDO CÓDIGO…';
 });
 watch(boxResult,renderBox);
 // Modelo de lector solo lo confirma el módulo real. Animación no equivale a conexión.
 watch(scanStatus,()=>{
  if(scanStatus.textContent==='Código recibido' && caption && !boxResult?.children.length)
   caption.textContent='CÓDIGO RECIBIDO';
 });
 renderBox();

 const condInput=byId('conditionScanInput'),condDetails=byId('conditionDetail'),
  condCode=byId('conditionCode'),condState=byId('ivConditionState'),
  condVisual=byId('ivConditionScannerVisual'),condProgress=byId('ivConditionProgress'),
  condTrack=byId('ivConditionProgressTrack');
 const flow=['ivFlowScan','ivFlowStart','ivFlowReview','ivFlowReady'].map(byId);
 const renderCondition=()=>{
  if(!condDetails||!condCode||!condState)return;
  const hasCode=!!condCode.value.trim();
  const txt=condDetails.textContent||'';
  const observed=/Observada|Incidencia:/i.test(txt);
  const ready=/Lista para recojo/i.test(txt);
  const started=/En acondicionamiento/i.test(txt);
  const progress=!hasCode?0:ready?100:started||observed?65:25;
  condState.textContent=!hasCode?'Sin caja':ready?'Lista para recojo':observed?'Observada':started?'En preparación':'Identificada';
  condState.dataset.state=ready?'success':observed?'warning':'';
  if(condProgress)condProgress.style.width=progress+'%';
  if(condTrack)condTrack.setAttribute('aria-valuenow',String(progress));
  flow.forEach((n,i)=>{
   if(!n)return;
   n.classList.toggle('is-done',i<(ready?4:hasCode?(started||observed?2:1):0));
   n.classList.toggle('is-warning',observed&&i===2);
  });
  condVisual?.classList.toggle('has-read',hasCode);
 };
 condInput?.addEventListener('input',()=>shortPulse(condVisual,'condition'));
 watch(condDetails,renderCondition);
 watch(byId('conditionMessage'),renderCondition);
 renderCondition();

 const mailCount=byId('pickupMailCounts'),visualCount=byId('ivMailCount'),
  mailProgress=byId('ivMailProgress'),mailTrack=byId('ivMailProgressTrack'),
  mailHelp=byId('ivMailHelp'),mailChip=byId('ivMailChip');
 function renderMail(){
  if(!mailCount||!visualCount)return;
  const text=mailCount.textContent||'';
  const match=text.match(/(\d+)\s+cajas nuevas listas/i);
  if(!match){
   visualCount.textContent='—';
   mailHelp.textContent='Consultando las cajas listas…';
   mailChip.textContent='Consultando';
   mailChip.dataset.state='';
   mailProgress.style.width='0%';
   mailTrack.setAttribute('aria-valuenow','0');
   return;
  }
  const amount=Math.max(0,Number(match[1])||0),filled=Math.min(30,amount);
  visualCount.textContent=String(amount);
  mailProgress.style.width=(filled/30*100)+'%';
  mailTrack.setAttribute('aria-valuenow',String(filled));
  const ready=amount>=30;
  mailChip.textContent=ready?'Meta alcanzada':'En progreso';
  mailChip.dataset.state=ready?'success':'';
  mailHelp.textContent=ready?
   'Hay suficientes cajas nuevas para preparar un aviso de recojo.':
   'Faltan '+(30-amount)+' cajas nuevas listas para el siguiente aviso.';
 }
 watch(mailCount,renderMail);
 byId('ivMailSimShortcut')?.addEventListener('click',()=>byId('pickupSample')?.click());
 renderMail();
 return {
  refresh(){renderFile();renderBox();renderCondition();renderMail();},
  disconnect(){for(const ob of observers)ob.disconnect();}
 };
}
