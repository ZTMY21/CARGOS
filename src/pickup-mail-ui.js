// Bandeja de recojos: preparación y confirmación manual, sin envío real.
import {attachPickupWorkflow} from './pickup-workflow-ui.js';
import {renderPickupSample} from './pickup-mail-demo.js';
export function attachPickupMail({supabase,isAdmin,appReady,isPreview,mailRequest=null,workflow=null}){
 const el=id=>document.getElementById(id);
 const status=el('pickupMailStatus'),counts=el('pickupMailCounts'),
  batches=el('pickupMailBatches'),preview=el('pickupMailPreview'),
  previewMeta=el('pickupMailPreviewMeta'),
  previewDetails=el('pickupPreviewDetails'),
  previewEmpty=el('pickupMailPreviewEmpty');
 let active=false,busy=false,items=[],lastReady=null,flow=null;
 const allowed=()=>appReady()&&isAdmin();
 const notify=(text,error=false)=>{
  status.textContent=text;status.style.color=error?'var(--red)':'var(--muted)';
 };
 // Un correo simulado se presenta al usuario sin guardar ni enviar mensajes.
 // El acordeón estaba fuera de pantalla: abrirlo no basta, también hay que llevar al usuario.
 const showPreview=(message,meta,notice)=>{
  if(typeof message!=='string'||!message.trim())throw Error('No se pudo generar la vista previa del correo.');
  preview.textContent=message;
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
  if(!r.ok)throw Error(result.message||result.error||'No se pudo preparar el correo.');
  return result;
 });
 const render=()=>{
  if(flow)return;
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
 };
 const read=async()=>{
  if(flow)return flow.refresh();
  if(!allowed()||!active)return;
  try{
   const {data,error}=await supabase.rpc('kardex_pickup_mail_state');
   if(error)throw error;
   if(!active)return;
   lastReady=Number(data.ready)||0;
   counts.textContent=lastReady+' cajas nuevas listas sin comunicar · '+
     (lastReady>=30?'Puedes preparar un aviso.':'Faltan '+Math.max(0,30-lastReady)+' para el aviso.');
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
    showPreview(data.text,
      'Vista previa · '+data.boxes+' cajas · Para: '+data.to.join('; ')+
        (data.cc?.length?' · CC: '+data.cc.join('; '):''),
      'Correo preparado para revisión. Aún no se ha enviado.');
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
 const simulate=()=>{
  for(const id of ['pickupDraftCard','pickupDraftFooter'])if(el(id))el(id).hidden=true;
  const sample=document.createElement('template');
  sample.innerHTML=renderPickupSample();
  showPreview(Array.from(sample.content.querySelectorAll('h1,p,div'),node=>node.textContent).join('\n\n'),
    'SIMULACIÓN · 30 cajas ficticias · Sin guardar ni enviar.',
    'Ejemplo visible abajo: 30 cajas ficticias. No se ha registrado ni enviado un correo.');
 };
 el('pickupPreviewTrySample')?.addEventListener('click',()=>flow?flow.simulate():simulate());
 el('pickupPrepare').addEventListener('click',()=>flow?flow.prepare():prepare());
 el('pickupReload').addEventListener('click',()=>{
  if(flow)void flow.refresh().catch(e=>notify(e.message,true));
  else void read();
 });
 if(workflow){
  for(const id of ['ivMailChip','ivMailCount','ivMailProgressTrack','ivMailHelp','pickupMailCounts'])el(id).hidden=true;
  el('ivMailCount').parentElement.hidden=true;
  flow=attachPickupWorkflow({workflow,showPreview,notify});
 }
 render();
 return {
  activate(){
   if(!allowed())return;
   active=true;
   if(flow)void flow.activate().catch(e=>notify(e.message,true));
   else void read();
  },
  deactivate(){active=false;flow?.deactivate();},
  reset(){
   flow?.reset();active=false;busy=false;items=[];lastReady=null;
   preview.textContent='';preview.hidden=true;
   for(const id of ['pickupDraftCard','pickupDraftFooter'])if(el(id))el(id).hidden=true;
   if(previewEmpty)previewEmpty.hidden=false;
   if(previewDetails)previewDetails.open=false;
   previewMeta.textContent='Selecciona un aviso preparado o simula un correo para revisar su formato.';
   counts.textContent='Sin consultar';notify('');render();
  },
  refresh:read,
  simulate:()=>flow?flow.simulate():simulate()
 };
}
