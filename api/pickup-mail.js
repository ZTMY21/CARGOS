import {ArchiveError} from '../server/archive/security.js';
import {authorize} from '../server/archive/repository.js';
import {composePickupMail} from '../src/pickup-mail-template.js';
export const config={maxDuration:30};

async function rpc(env,req,fetcher,name,params){
 const response=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/'+name,{
  method:'POST',
  headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:req.headers.authorization,
   'Content-Type':'application/json'},
  body:JSON.stringify(params),signal:AbortSignal.timeout(15000),redirect:'error'
 });
 if(!response.ok)throw new ArchiveError('PICKUP_MAIL_DB_ERROR',503);
 return response.json();
}
const json=(res,status,data)=>{
 res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('Cache-Control','private, no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.end(JSON.stringify(data));
};
export function createPickupMailHandler({env=process.env,fetcher=fetch}={}){
 return async(req,res)=>{
  try{
   if(req.method!=='POST')throw new ArchiveError('METHOD_NOT_ALLOWED',405);
   if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)
     throw new ArchiveError('ORIGIN_NOT_ALLOWED',403);
   const raw=typeof req.body==='string'?JSON.parse(req.body):req.body;
   if(Buffer.byteLength(JSON.stringify(raw||{}))>1000)throw new ArchiveError('REQUEST_TOO_LARGE',413);
   if(!['preview','download'].includes(raw?.action)||!/^[-a-f0-9]{36}$/i.test(raw?.id||''))
     throw new ArchiveError('INVALID_REQUEST',400);
   await authorize(req,env,{admin:true,fetcher});
   const detail=await rpc(env,req,fetcher,'kardex_pickup_mail_detail',{p_id:raw.id});
   let prepared;
   try{prepared=composePickupMail(detail);}
   catch{throw new ArchiveError('PICKUP_MAIL_INCOMPLETE',409);}
   if(raw.action==='preview'){
     return json(res,200,{id:detail.id,status:detail.status,subject:prepared.subject,
       text:prepared.text,html:prepared.html,to:detail.to,cc:detail.cc,from:detail.sender,
       boxes:detail.boxes.length});
   }
   if(env.VERCEL_ENV!=='production')throw new ArchiveError('PREVIEW_WRITE_DISABLED',403);
   if(detail.status==='CONFIRMADO')throw new ArchiveError('ALREADY_CONFIRMED',409);
   await rpc(env,req,fetcher,'kardex_pickup_mail_mark',{p_id:detail.id,p_action:'PREPARADO'});
   res.statusCode=200;
   res.setHeader('Content-Type','message/rfc822; charset=utf-8');
   res.setHeader('Content-Disposition','attachment; filename="'+prepared.filename+'"');
   res.setHeader('Cache-Control','private, no-store');
   res.setHeader('X-Content-Type-Options','nosniff');
   return res.end(prepared.eml);
  }catch(error){
   if(!(error instanceof ArchiveError))console.error(JSON.stringify({event:'pickup_mail_error',code:'PICKUP_MAIL_ERROR'}));
   const known=error instanceof ArchiveError;
   return json(res,known?error.status:503,{error:known?error.code:'PICKUP_MAIL_ERROR'});
  }
 };
}
export default createPickupMailHandler();
