import {authorize} from '../server/archive/repository.js';
import {ArchiveError,isReceptionPreviewBranch} from '../server/archive/security.js';
import {updateConditioningWorkbooks} from '../server/conditioning-workbooks.js';

export const config={maxDuration:60};

export function createBoxConditioningHandler({env=process.env,fetcher=fetch}={}){
  return async (req,res)=>{
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    const json=(status,data)=>{
      res.statusCode=status;
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify(data));
    };
    try{
      if(env.VERCEL_ENV!=='preview'||!isReceptionPreviewBranch(env)||
         env.SUPABASE_URL!=='https://qpbzfzcobkkfnoioqytb.supabase.co'||
         !/^[a-f0-9]{64}$/.test(env.KARDEX_RECEPCION_PRUEBA_SECRET||''))
        throw new ArchiveError('PREVIEW_AISLADA_REQUERIDA',403);
      if(req.method!=='POST')throw new ArchiveError('METHOD_NOT_ALLOWED',405);
      if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host)
        throw new ArchiveError('ORIGIN_DENIED',403);
      const action=req.body?.action;
      if(!['sincronizar','maestro','historico'].includes(action))throw new ArchiveError('INVALID_ACTION',400);
      await authorize(req,env,{admin:true,fetcher});
      const rpc=async (accion,args={})=>{
        const response=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/kardex_acondicionamiento_excel',{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
          headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:req.headers.authorization,'Content-Type':'application/json'},
          body:JSON.stringify({p_accion:accion,p_secreto:env.KARDEX_RECEPCION_PRUEBA_SECRET,...args})
        });
        const result=await response.json();
        if(!response.ok)throw new ArchiveError(result.code==='40001'?'REVISION_CAMBIO':'EXCEL_NO_DISPONIBLE',409);
        return result;
      };
      const data=await rpc('leer');
      if(action!=='sincronizar'){
        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition','attachment; filename="'+action+'_acondicionamiento_preview.xlsx"');
        return res.end(Buffer.from(data[action],'base64'));
      }
      if(!data.lote.length)return json(200,{verified:true,count:0});
      const updated=await updateConditioningWorkbooks(Buffer.from(data.maestro,'base64'),
        Buffer.from(data.historico,'base64'),data.lote);
      const proof=await rpc('confirmar',{
        p_revision:data.revision,p_lote:data.lote,
        p_maestro:updated.maestro.toString('base64'),p_historico:updated.historico.toString('base64')
      });
      if(!proof.verificado)throw Error('EXCEL_NOT_VERIFIED');
      return json(200,{verified:true,count:data.lote.length});
    }catch(error){
      return json(error instanceof ArchiveError?error.status:503,{
        error:error instanceof ArchiveError?error.code:'SINCRONIZACION_PENDIENTE'
      });
    }
  };
}
export default createBoxConditioningHandler();
