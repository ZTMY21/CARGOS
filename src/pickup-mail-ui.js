// Bandeja de recojos: preparación y confirmación manual, sin envío real.
import {renderPickupSample,pickupMailSubject,PICKUP_TO,PICKUP_CC} from './pickup-mail-demo.js';
export function attachPickupMail({supabase,isAdmin,appReady,isPreview,mailRequest=null}){
 const el=id=>document.getElementById(id);
 const status=el('pickupMailStatus'),counts=el('pickupMailCounts'),
  batches=el('pickupMailBatches'),preview=el('pickupMailPreview'),
  previewMeta=el('pickupMailPreviewMeta'),
  previewDetails=el('pickupPreviewDetails'),
  previewEmpty=el('pickupMailPreviewEmpty');
 const input={sender:el('pickupSender'),to:el('pickupTo'),cc:el('pickupCc'),
  name:el('pickupName'),position:el('pickupPosition'),area:el('pickupArea'),
  company:el('pickupCompany'),contact:el('pickupContact'),
  subject:el('pickupSubject'),greeting:el('pickupGreeting'),
  introduction:el('pickupIntroduction'),request:el('pickupRequest'),
  closing:el('pickupClosing')};
 const logoFile=el('pickupLogoFile'),logoPreview=el('pickupLogoPreview'),
  logoStatus=el('pickupLogoStatus'),logoClear=el('pickupLogoClear');
 let logoData='';
 const defaultCopy={
  subject:pickupMailSubject(),
  greeting:'Estimados(as),',
  introduction:'Se comunica que tenemos {{cantidad}} cajas nuevas acondicionadas y listas para recojo en {{sede}}.',
  request:'Agradeceremos gestionar la solicitud de recojo ante Iron Mountain y confirmar la fecha estimada de atención.',
  closing:'Quedamos atentos a la confirmación de la coordinación.'
 };
 const showLogo=()=>{
  logoPreview.hidden=!logoData;
  if(logoData)logoPreview.src='data:image/png;base64,'+logoData;
  else logoPreview.removeAttribute('src');
  logoStatus.textContent=logoData?'Logotipo PNG cargado para el correo.':'Sin logotipo. Selecciona un PNG para incrustarlo en Outlook.';
 };
 logoFile.addEventListener('change',async()=>{
  const file=logoFile.files?.[0];
  if(!file)return;
  if(file.type!=='image/png'||file.size>120000){
   logoFile.value='';
   return notify('El logotipo debe ser PNG de máximo 120 KB.',true);
  }
  const bytes=new Uint8Array(await file.arrayBuffer());
  const prefix=[137,80,78,71,13,10,26,10];
  if(!prefix.every((v,i)=>bytes[i]===v)){
   logoFile.value='';
   return notify('Archivo PNG inválido.',true);
  }
  let raw='';
  for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
  logoData=btoa(raw);showLogo();notify('Logo preparado. Guarda la configuración cuando esté revisada.');
 });
 logoClear.addEventListener('click',()=>{
  logoFile.value='';logoData='';showLogo();notify('Logo quitado del formulario. Guarda para aplicar el cambio.');
 });
 let active=false,busy=false,selected=null,items=[],lastReady=null;
 const allowed=()=>appReady()&&isAdmin();
 const notify=(text,error=false)=>{
  status.textContent=text;status.style.color=error?'var(--red)':'var(--muted)';
 };
 // Un correo simulado se presenta al usuario sin guardar ni enviar mensajes.
 // El acordeón estaba fuera de pantalla: abrirlo no basta, también hay que llevar al usuario.
 const showPreview=(html,meta,notice)=>{
  if(typeof html!=='string'||!html.trim())throw Error('No se pudo generar la vista previa del correo.');
  preview.srcdoc=html;
  preview.hidden=false;
  if(previewEmpty)previewEmpty.hidden=true;
  previewMeta.textContent=meta;
  if(previewDetails){
   previewDetails.open=true;
   const reveal=()=>previewDetails.scrollIntoView?.({behavior:'smooth',block:'start'});
   if(typeof window!=='undefined'&&typeof window.requestAnimationFrame==='function')
    window.requestAnimationFrame(reveal);
   else reveal();
  }
  notify(notice);
 };
 const toArray=s=>String(s||'').split(/[;,\n]/).map(x=>x.trim()).filter(Boolean);
 const callApi=mailRequest||(async(action,id)=>{
  const {data,error}=await supabase.auth.getSession();
  if(error||!data?.session?.access_token)throw Error('La sesión expiró.');
  const r=await fetch('/api/pickup-mail',{
   method:'POST',credentials:'same-origin',
   headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},
   body:JSON.stringify({action,id})
  });
  if(action==='download'&&r.ok){
   const blob=await r.blob();return {blob};
  }
  const result=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(result.error||'No se pudo preparar el correo.');
  return result;
 });
 const render=()=>{
  batches.replaceChildren();
  for(const batch of items){
   const article=document.createElement('div');article.className='prepared-im-box';
   const h=document.createElement('p');
   h.textContent=(batch.subject||'Aviso de recojo')+
     ' · '+(batch.status==='CONFIRMADO'?'Envío confirmado':batch.status==='PREPARADO'?'Preparado para Outlook':'Pendiente')+
     ' · '+new Date(batch.created_at).toLocaleString('es-PE');
   article.append(h);
   const actions=document.createElement('div');actions.className='actions';
   const addButton=(label,action)=>{
    const button=document.createElement('button');button.type='button';
    button.className='secondary';button.textContent=label;
    button.disabled=busy||!allowed()||(action!=='preview'&&isPreview())||
      (action==='confirm'&&batch.status!=='PREPARADO')||
      (action==='download'&&batch.status==='CONFIRMADO');
    button.addEventListener('click',()=>{void perform(action,batch.id);});
    actions.append(button);
   };
   addButton('Vista previa','preview');
   addButton('Descargar para Outlook','download');
   if(batch.status!=='CONFIRMADO')addButton('Confirmar envío','confirm');
   article.append(actions);batches.append(article);
  }
  if(!items.length)batches.textContent='Sin correos preparados.';
  el('pickupPrepare').disabled=busy||!allowed()||isPreview()||!(lastReady>=30);
  el('pickupSaveConfig').disabled=busy||!allowed()||isPreview();
 };
 const read=async()=>{
  if(!allowed()||!active)return;
  try{
   const {data,error}=await supabase.rpc('kardex_pickup_mail_state');
   if(error)throw error;
   if(!active)return;
   lastReady=Number(data.ready)||0;
   counts.textContent=lastReady+' cajas nuevas listas sin comunicar · '+
     (lastReady>=30?'Puedes preparar un aviso.':'Faltan '+Math.max(0,30-lastReady)+' para el aviso.');
   let brand={};
   try{
    const result=await supabase.rpc('kardex_pickup_mail_brand_state');
    if(!result.error)brand=result.data||{};
   }catch{ /* En Preview antiguo la migración aún puede no estar aplicada. */ }
   const cfg=data.config||{};
   input.sender.value=cfg.sender||'';
   input.to.value=(cfg.to?.length?cfg.to:PICKUP_TO).join('; ');
   input.cc.value=(cfg.cc?.length?cfg.cc:PICKUP_CC).join('; ');
   input.name.value=cfg.name||'';
   input.position.value=cfg.position||'';
   input.area.value=cfg.area||'';
   input.company.value=cfg.company||'';
   input.contact.value=cfg.contact||'';
   for(const [field,defaultValue] of Object.entries(defaultCopy)){
    input[field].value=field==='subject'&&isPreview()?pickupMailSubject():brand[field]||defaultValue;
   }
   logoData=brand.logo||'';showLogo();
   items=Array.isArray(data.batches)?data.batches:[];
   render();
  }catch{
   if(isPreview()){
    // La base aislada de esta preview aún no tiene los RPC de avisos.
    // Ofrecer solamente una demostración local, nunca fabricar lotes ni escribir.
    lastReady=null;items=[];
    counts.textContent='Sin datos reales de cajas en esta preview · simulación disponible';
    input.to.value=PICKUP_TO.join('; ');
    input.cc.value=PICKUP_CC.join('; ');
    input.subject.value=pickupMailSubject();
    for(const field of ['greeting','introduction','request','closing'])
     input[field].value=defaultCopy[field];
    render();
    notify('Preview de formato: utiliza Simular correo sin enviar. Preparar correo real continúa deshabilitado.');
   }else notify('No se pudo consultar avisos. Actualiza la bandeja.',true);
  }
 };
 const act=async fn=>{
  if(busy||!allowed()||isPreview())return;
  busy=true;render();
  try{await fn();await read();}catch(e){notify(e?.message||'La operación no se completó.',true);}
  finally{busy=false;render();}
 };
 const save=()=>act(async()=>{
  const args={
   p_sender:input.sender.value.trim(),
   p_recipients:toArray(input.to.value),p_copies:toArray(input.cc.value),
   p_name:input.name.value.trim(),p_position:input.position.value.trim(),
   p_area:input.area.value.trim(),p_company:input.company.value.trim(),
   p_contact:input.contact.value.trim(),
   p_subject:input.subject.value.trim(),
   p_greeting:input.greeting.value.trim(),
   p_introduction:input.introduction.value.trim(),
   p_request:input.request.value.trim(),
   p_closing:input.closing.value.trim(),
   p_logo:logoData
  };
  const {error}=await supabase.rpc('kardex_pickup_mail_configure_v2',args);
  if(error)throw error;
  notify('Configuración guardada. Se aplicará a los próximos avisos.');
 });
 const prepare=()=>act(async()=>{
  if(!confirm('¿Preparar un aviso para 30 cajas nuevas listas? No se enviará ningún correo.'))return;
  const {data,error}=await supabase.rpc('kardex_pickup_mail_prepare');
  if(error)throw error;
  notify('Aviso creado para '+data.count+' cajas. Revisa la vista previa antes de descargarlo.');
 });
 const perform=async(action,id)=>{
  if(!allowed()||busy||!id)return;
  if(action==='confirm'&&isPreview())return;
  if(action==='confirm'&&!confirm('Confirma solo si ya enviaste este correo desde Outlook. ¿Se envió realmente?'))return;
  busy=true;render();
  try{
   if(action==='confirm'){
    const {error}=await supabase.rpc('kardex_pickup_mail_mark',{p_id:id,p_action:'CONFIRMADO'});
    if(error)throw error;
    notify('Envío confirmado manualmente. No implica recepción por el destinatario.');
   }else if(action==='preview'){
    const data=await callApi('preview',id);
    showPreview(data.previewHtml||data.html,
      'Vista previa · '+data.boxes+' cajas · Para: '+data.to.join('; ')+
        (data.cc?.length?' · CC: '+data.cc.join('; '):''),
      'Correo preparado para revisión. Aún no se ha enviado.');
    selected=id;
   }else if(action==='download'&&!isPreview()){
    const result=await callApi('download',id);
    const blob=result.blob;
    const url=URL.createObjectURL(blob);
    try{
     const a=document.createElement('a');a.href=url;
     a.download='recojo_30_cajas_'+id.slice(0,8)+'.eml';
     document.body.append(a);a.click();a.remove();
    }finally{setTimeout(()=>URL.revokeObjectURL(url),3000);}
    notify('Archivo EML descargado. Ábrelo en Outlook, revísalo y envíalo tú.');
   }
   await read();
  }catch(e){notify(e?.message||'No se pudo completar la operación.',true);}
  finally{busy=false;render();}
 };
 el('pickupSaveConfig').addEventListener('click',save);
 const simulate=()=>{
  const values=Object.fromEntries(Object.entries(input).map(([k,v])=>[k,v.value]));
  values.logo=logoData;
  showPreview(renderPickupSample(values),
    'SIMULACIÓN · '+pickupMailSubject()+' · Para: '+PICKUP_TO.join('; ')+
      ' · CC: '+PICKUP_CC.join('; ')+' · Sin guardar ni enviar.',
    'Ejemplo visible abajo: 30 cajas ficticias. No se ha registrado ni enviado un correo.');
 };
 el('pickupSample').addEventListener('click',simulate);
 el('pickupPreviewTrySample')?.addEventListener('click',simulate);
 el('pickupPrepare').addEventListener('click',prepare);
 el('pickupReload').addEventListener('click',()=>{void read();});
 showLogo();render();
 return {
  activate(){active=true;void read();},
  deactivate(){active=false;},
  reset(){
   active=false;busy=false;items=[];selected=null;lastReady=null;
   preview.srcdoc='';preview.hidden=true;
   if(previewEmpty)previewEmpty.hidden=false;
   if(previewDetails)previewDetails.open=false;
   previewMeta.textContent='Selecciona un aviso preparado o simula un correo para revisar su formato.';
   for(const x of Object.values(input))x.value='';
   logoData='';logoFile.value='';showLogo();
   counts.textContent='Sin consultar';notify('');render();
  },
  refresh:read
 };
}
