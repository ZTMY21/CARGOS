import {createHash} from 'node:crypto';
import {ArchiveError} from './archive/security.js';
import {DriveClient} from './archive/drive-client.js';
import {
 IM_HISTORY_FILE_ID,IM_HISTORY_PARENT_ID,IM_HISTORY_FILE_NAME,
 mergeIronMountainHistory
} from './im-history-workbook.js';

const DRIVE='https://www.googleapis.com/drive/v3/files/';
const HIST_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_BYTES=20*1024*1024;
const failureCode=e=>{
  const msg=String(e?.code||e?.message||'IM_HISTORY_PENDING');
  return /^IM_HISTORY_[A-Z0-9_]+$/.test(msg)?msg:'IM_HISTORY_PENDING';
};
async function metadata(client){
  const fields='id,name,mimeType,size,parents,trashed,md5Checksum,modifiedTime';
  const r=await client.request(DRIVE+IM_HISTORY_FILE_ID+
     '?fields='+encodeURIComponent(fields)+'&supportsAllDrives=true');
  const f=await r.json();
  if(f.id!==IM_HISTORY_FILE_ID || f.name!==IM_HISTORY_FILE_NAME ||
     f.mimeType!==HIST_MIME || f.trashed ||
     !f.parents?.includes(IM_HISTORY_PARENT_ID) ||
     Number(f.size)<1000 || Number(f.size)>MAX_BYTES)
    throw new ArchiveError('IM_HISTORY_DESTINATION_INVALID',409);
  return f;
}
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
  let result=null,failed=null;
  try{
    const before=await metadata(client);
    const file=await client.request(DRIVE+IM_HISTORY_FILE_ID+'?alt=media&supportsAllDrives=true');
    const oldBytes=Buffer.from(await file.arrayBuffer());
    if(oldBytes.length!==Number(before.size))throw Error('IM_HISTORY_READ_INCOMPLETE');
    const merged=await mergeIronMountainHistory(oldBytes,masterRows);
    const refreshed=await metadata(client);
    if(refreshed.size!==before.size || refreshed.modifiedTime!==before.modifiedTime ||
       refreshed.md5Checksum!==before.md5Checksum)
       throw Error('IM_HISTORY_EDIT_IN_PROGRESS');
    if(merged.changed){
      const response=await client.request(
        'https://www.googleapis.com/upload/drive/v3/files/'+IM_HISTORY_FILE_ID+
        '?uploadType=media&fields=id,size,md5Checksum,modifiedTime&supportsAllDrives=true',{
          method:'PATCH',headers:{'Content-Type':HIST_MIME},
          body:merged.bytes
        });
      const proof=await response.json();
      const expectedMD5=createHash('md5').update(merged.bytes).digest('hex');
      if(proof.id!==IM_HISTORY_FILE_ID || Number(proof.size)!==merged.bytes.length ||
         proof.md5Checksum!==expectedMD5)throw Error('IM_HISTORY_WRITE_UNVERIFIED');
      const verify=await metadata(client);
      if(verify.md5Checksum!==expectedMD5)throw Error('IM_HISTORY_READBACK_UNVERIFIED');
    }
    const hasReviews=merged.reviewRequired>0;
    result={
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
    failed=error;
    const code=failureCode(error);
    try{await guard(fetcher,env,bearer,'error',claim.token,
      {status:'PENDIENTE',error:code,at:new Date().toISOString()});}catch{/* Expirará la reserva. */}
    return {status:'PENDIENTE',pending:true,added:0,
      code,message:'El Maestro está actualizado; el guardado en histórico está pendiente de reintento.'};
  }
}
