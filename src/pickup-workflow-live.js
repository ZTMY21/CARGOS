import {validatePickupPdf,validDate} from './pickup-workflow-demo.js';

const uploadMessages={
  ARCHIVE_GATEWAY_UNAVAILABLE:'No se pudo iniciar o continuar la carga del PDF. Pulsa Confirmar recojo para reintentar.',
  DRIVE_NETWORK_ERROR:'Se interrumpió la conexión con Google Drive. Pulsa Confirmar recojo para retomar la carga.',
  UPLOAD_SESSION_EXPIRED:'La sesión de carga del PDF venció. Pulsa Confirmar recojo para reiniciarla.',
  TRANSFER_BUSY:'El PDF todavía se está procesando. Espera unos segundos y pulsa Confirmar recojo.',
  PICKUP_EVIDENCE_CONFLICT:'Esta carga ya se inició con otra fecha o PDF. Usa los datos originales o cierra el formulario y vuelve a abrirlo.'
};

export function createLivePickupWorkflow(client,{onChanged,refreshMaster}={}){
  const rpc=async(name,args)=>{
    const {data,error}=await client.rpc(name,args);
    if(error)throw Object.assign(Error(error.message),{code:error.code});
    return data;
  };
  const workflow=(action,id,data)=>rpc('kardex_pickup_workflow',{p_action:action,p_id:id??null,p_data:data??{}});
  const session=async()=>{
    const {data,error}=await client.auth.getSession();
    if(error||!data?.session)throw Error('La sesión expiró.');
    return data.session;
  };
  async function request(path,{body,binary,blob=false,auth}={}){
    const credentials=auth||await session();
    const response=await fetch(path,{method:'POST',credentials:'same-origin',
      headers:{Authorization:'Bearer '+credentials.access_token,'Content-Type':binary?'application/octet-stream':'application/json'},
      body:binary||JSON.stringify(body||{})});
    if(response.ok&&blob)return response.blob();
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(Error(data.message||data.error||'No se pudo completar la operación.'),{
      code:data.code||data.error||data.message
    });
    return data;
  }
  const pickup=(action,id,data,blob)=>request('/api/pickup-mail',{body:{action,id,...data},blob});
  return {
    async state(){
      const state=await workflow('state');
      return {...state,
        batches:state.batches.map(batch=>({visits:[],events:[],schedule:{},...batch}))};
    },
    refreshMaster,
    prepare:({keys,requestId})=>workflow('prepare',requestId,{keys}),
    registerSent:({keys,requestId})=>workflow('register_sent',requestId,{keys}),
    async sample(){
      const data=await pickup('sample');
      return {...data,blob:new Blob([data.eml],{type:'message/rfc822'}),
        attachmentFiles:data.attachmentBase64.map(base64=>({bytes:Uint8Array.from(atob(base64),character=>character.charCodeAt(0))}))};
    },
    async mail(action,id){
      if(action==='download')return {blob:await pickup(action,id,{},true)};
      return pickup(action,id);
    },
    mark:(id,action)=>action==='CANCELADO'?workflow('cancel',id):
      rpc('kardex_pickup_mail_mark',{p_id:id,p_action:action}),
    schedule:(id,dates)=>workflow('schedule',id,dates),
    async confirm(id,{visitId,codes,date,file}){
      if(!validDate(date)||!codes.length||!file)throw Error('Indica fecha, códigos retirados y PDF firmado.');
      if(file.size>5*1024*1024)throw Error('El PDF supera 5 MB.');
      const bytes=new Uint8Array(await file.arrayBuffer());
      await validatePickupPdf(bytes);
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
      const auth=await session();
      const archive=async(action,{job,offset,body,binary}={})=>{
        const query=new URLSearchParams({action});
        if(job)query.set('id',job);
        if(offset!==undefined)query.set('offset',String(offset));
        try{return await request('/api/drive-archive?'+query,{body,binary,auth});}
        catch(error){
          if(Object.hasOwn(uploadMessages,error.code))error.message=uploadMessages[error.code];
          throw error;
        }
      };
      const sourceKey='pickup:'+id+':'+visitId+':'+auth.user.id;
      let job=await archive('start',{body:{documentId:null,sourceKey,sourceVersion:'sha256:'+sha256,
        name:'IM_RECOJO_'+date+'_AV-'+id.slice(0,8)+'_'+visitId+'.pdf',
        sha256,size:bytes.length,mime:'application/pdf',category:'scans'}});
      while(job.status!=='verified'&&job.offset<bytes.length){
        const offset=job.offset;
        try{job=await archive('chunk',{job:job.id,offset,binary:bytes.subarray(offset,offset+1024**2)});}
        catch(error){
          if(error.code!=='OFFSET_CONFLICT')throw error;
          job=await archive('reconcile',{job:job.id});
        }
        if(job.offset<=offset)throw Error('Google Drive no avanzó la carga. Reintenta.');
      }
      if(job.status!=='verified')job=await archive('finish',{job:job.id});
      if(job.status!=='verified'||!job.backendVerified||job.sha256!==sha256)
        throw Error('Google Drive todavía no verificó el PDF.');
      const result=await pickup('confirm',id,{visit:visitId,codes,date,job:job.id});
      await onChanged?.().catch(()=>{});
      return result;
    },
    async retry(id,visit){
      const result=await pickup('retry',id,{visit});
      await onChanged?.().catch(()=>{});
      return result;
    },
    pdf:(id,visit)=>pickup('pdf',id,{visit},true)
  };
}
