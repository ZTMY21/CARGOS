import {ArchiveError} from './archive/security.js';
import {DriveClient} from './archive/drive-client.js';
import {readHistoryDrive,writeMasterDrive} from './im-master-drive.js';
import {
 IM_HISTORY_FILE_ID,
 mergeIronMountainHistory
} from './im-history-workbook.js';

const failureCode=e=>{
  const msg=String(e?.code||e?.message||'IM_HISTORY_PENDING');
  return /^IM_HISTORY_[A-Z0-9_]+$/.test(msg)?msg:'IM_HISTORY_PENDING';
};
async function guard(fetcher,env,bearer,action,token=null,result={}){
  const r=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/kardex_im_history_guard',{
    method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,
      Authorization:bearer,'Content-Type':'application/json'},
    body:JSON.stringify({p_action:action,p_token:token,p_result:result}),
    signal:AbortSignal.timeout(10000),redirect:'error'
  });
  if(!r.ok)throw new ArchiveError('IM_HISTORY_LOCK_UNAVAILABLE',503);
  return r.json();
}
export async function syncIronMountainHistory({env,fetcher=fetch,client=null,bearer,masterRows}){
  if(!Array.isArray(masterRows)||typeof bearer!=='string')throw Error('IM_HISTORY_INVALID_SOURCE');
  client ||= new DriveClient(env,{fetcher});
  const claim=await guard(fetcher,env,bearer,'acquire');
  if(claim.status==='BUSY')return {status:'BUSY',pending:true,
    message:'Otro registro histórico está en curso; se volverá a comprobar.'};
  if(claim.status!=='ACQUIRED'||!claim.token)throw Error('IM_HISTORY_LOCK_NOT_ACQUIRED');
  try{
    const source=await readHistoryDrive(client);
    const merged=await mergeIronMountainHistory(source.bytes,masterRows);
    if(merged.changed)await writeMasterDrive(client,source,merged.bytes);
    const hasReviews=merged.reviewRequired>0;
    const result={
      status:hasReviews?(merged.changed?'SINCRONIZACION_PARCIAL':'REQUIERE_REVISION'):
        merged.changed?'SINCRONIZADO':'SIN CAMBIOS',
      added:merged.added,updated:merged.updated,
      alreadyRegistered:merged.alreadyRegistered,totalSent:merged.totalSent,
      reviewRequired:merged.reviewRequired,
      // Los casos dudosos se registran para revisión, sin tocar sus filas.
      reviews:(merged.reviews||[]).slice(0,25),
      verified:!hasReviews,pending:hasReviews,
      historyFileId:IM_HISTORY_FILE_ID,updatedAt:new Date().toISOString()
    };
    await guard(fetcher,env,bearer,'release',claim.token,result);
    return result;
  }catch(error){
    const code=failureCode(error);
    try{await guard(fetcher,env,bearer,'error',claim.token,
      {status:'PENDIENTE',error:code,at:new Date().toISOString()});}catch{/* Expirará la reserva. */}
    return {status:'PENDIENTE',pending:true,added:0,
      code,message:'El Maestro está actualizado; el guardado en histórico está pendiente de reintento.'};
  }
}
