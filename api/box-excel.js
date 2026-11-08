import {DriveClient} from '../server/archive/drive-client.js';
import {ArchiveError,configuration} from '../server/archive/security.js';
import {authorize} from '../server/archive/repository.js';
import {parseBoxScan} from '../src/box-scanner.js';
import {IM_MASTER_FILE_ID} from '../server/im-master-workbook.js';
import {appendPreparedBoxToMaster} from '../server/im-master-write.js';
import {readMasterDrive,writeMasterDrive,withMasterDriveLock} from '../server/im-master-drive.js';

export const config={maxDuration:60};
const answer=(res,status,body)=>{
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.end(JSON.stringify(body));
};
async function rpc(fetcher,env,token,method,body){
  const r=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/'+method,{
    method:'POST',headers:{
      apikey:env.SUPABASE_ANON_KEY,Authorization:token,'Content-Type':'application/json'
    },body:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'
  });
  if(!r.ok)throw new ArchiveError('IM_MASTER_DB_UNAVAILABLE',503);
  return r.json();
}
function limaISO(value){
  const d=new Date(value||Date.now());
  if(Number.isNaN(d.getTime()))throw new ArchiveError('INVALID_DATE',400);
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
    timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(d).map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day;
}
export function createBoxExcelHandler({env=process.env,fetcher=fetch}={}){
  return async(req,res)=>{
    try{
      if(req.method!=='POST')throw new ArchiveError('METHOD_NOT_ALLOWED',405);
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)
        throw new ArchiveError('ORIGIN_DENIED',403);
      const data=typeof req.body==='string'?JSON.parse(req.body):req.body;
      if(Buffer.byteLength(JSON.stringify(data||{}))>1200)
        throw new ArchiveError('REQUEST_TOO_LARGE',413);
      if(!['scan','sync'].includes(data?.action))throw new ArchiveError('INVALID_ACTION',400);
      const parsed=parseBoxScan(data.code||'');
      if(!parsed.ok)throw new ArchiveError('INVALID_BOX_CODE',400);
      await authorize(req,env,{admin:true,fetcher});
      if(env.VERCEL_ENV!=='production')throw new ArchiveError('PREVIEW_WRITE_DISABLED',403);
      if(!configuration(env).enabled)throw new ArchiveError('DRIVE_NOT_READY',503);
      if(data.action==='scan')
        return answer(res,200,{verified:true,sourceSynced:false,
          message:'Lectura confirmada en el aplicativo. El Excel solo cambia al finalizar la preparación.'});

      const token=req.headers.authorization;
      const records=await rpc(fetcher,env,token,'kardex_box_conditioning_list',{});
      const record=Array.isArray(records)?records.find(r=>r.code===parsed.normalized):null;
      if(!record)throw new ArchiveError('CONDITIONING_NOT_FOUND',404);
      if(record.status!=='LISTA')return answer(res,200,{
        verified:true,sourceSynced:false,source:'Kárdex Digital',
        message:'Acondicionamiento guardado. Solo las cajas listas se registran en Excel Maestro.'
      });

      const client=new DriveClient(env,{fetcher});
      await client.checkRoot();
      const updated=await withMasterDriveLock(
        (method,body)=>rpc(fetcher,env,token,method,body),
        async ()=>{
          const source=await readMasterDrive(client);
          const userResp=await fetcher(env.SUPABASE_URL+'/auth/v1/user',{
            headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:token},
            signal:AbortSignal.timeout(12000),redirect:'error'
          });
          if(!userResp.ok)throw new ArchiveError('SESSION_INVALID',401);
          const user=await userResp.json();
          const who=String(user.user_metadata?.full_name||user.user_metadata?.nombre||user.email?.split('@')[0]||'Administrador').slice(0,150);
          const result=await appendPreparedBoxToMaster(source.bytes,record,{
            preparacion:limaISO(record.started_at),responsable:who
          });
          const proof=result.changed ? await writeMasterDrive(client,source,result.bytes) : source;
          const verified=await rpc(fetcher,env,token,'kardex_im_master_sync',{
            p_file_id:IM_MASTER_FILE_ID,p_rows:proof.rows.filter(row=>!row.receivedOnly)
          });
          if(verified?.verificado!==true)throw new ArchiveError('IM_MASTER_DB_NOT_VERIFIED',503);
          return result;
        });
      return answer(res,200,{verified:true,sourceSynced:true,
        source:updated.changed?'appended':'existing',
        message:'Caja verificada en el Excel Maestro y en el aplicativo.'});
    }catch(error){
      const known=error instanceof ArchiveError;
      const code=known?error.code:/^IM_MASTER_/.test(error?.message||'')?error.message:'IM_MASTER_WRITE_FAILED';
      return answer(res,known?error.status:503,{verified:false,error:code,
        message:'No se pudo confirmar el registro en Excel Maestro. El estado del Kárdex se conserva; revisa antes de reintentar.'});
    }
  };
}
export default createBoxExcelHandler();
