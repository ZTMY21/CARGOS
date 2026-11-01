// Bandeja de recojos: preparación y confirmación manual, sin envío real.
export function attachPickupMail({supabase,isAdmin,appReady,isPreview,mailRequest=null}){
 const el=id=>document.getElementById(id);
 const status=el('pickupMailStatus'),counts=el('pickupMailCounts'),
  batches=el('pickupMailBatches'),preview=el('pickupMailPreview'),
  previewMeta=el('pickupMailPreviewMeta');
 const input={sender:el('pickupSender'),to:el('pickupTo'),cc:el('pickupCc'),
  name:el('pickupName'),position:el('pickupPosition'),area:el('pickupArea'),
  company:el('pickupCompany'),contact:el('pickupContact')};
 let active=false,busy=false,selected=null,items=[],lastReady=null;
 const allowed=()=>appReady()&&isAdmin();
 const notify=(text,error=false)=>{
  status.textContent=text;status.style.color=error?'var(--red)':'var(--muted)';
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
   const cfg=data.config||{};
   input.sender.value=cfg.sender||'';
   input.to.value=(cfg.to||[]).join('; ');
   input.cc.value=(cfg.cc||[]).join('; ');
   input.name.value=cfg.name||'';
   input.position.value=cfg.position||'';
   input.area.value=cfg.area||'';
   input.company.value=cfg.company||'';
   input.contact.value=cfg.contact||'';
   items=Array.isArray(data.batches)?data.batches:[];
   render();
  }catch{
   notify('No se pudo consultar avisos. Actualiza la bandeja.',true);
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
   p_contact:input.contact.value.trim()
  };
  const {error}=await supabase.rpc('kardex_pickup_mail_configure',args);
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
    previewMeta.textContent='Vista previa · '+data.boxes+' cajas · Para: '+data.to.join('; ')+
      (data.cc?.length?' · CC: '+data.cc.join('; '):'');
    preview.srcdoc=data.html;
    selected=id;
    notify('Correo preparado para revisión. Aún no se ha enviado.');
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
 el('pickupPrepare').addEventListener('click',prepare);
 el('pickupReload').addEventListener('click',()=>{void read();});
 render();
 return {
  activate(){active=true;void read();},
  deactivate(){active=false;},
  reset(){
   active=false;busy=false;items=[];selected=null;lastReady=null;
   preview.srcdoc='';previewMeta.textContent='';
   for(const x of Object.values(input))x.value='';
   counts.textContent='Sin consultar';notify('');render();
  },
  refresh:read
 };
}
