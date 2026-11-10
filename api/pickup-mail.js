import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {pickupVisit} from '../server/pickup-drive.js';
import {readFile} from 'node:fs/promises';
import {pickupAttachments,pickupType} from '../server/pickup-workbook.js';
import {writeDemoPickupWorkbooks} from '../server/pickup-demo-workbooks.js';
import {ArchiveError} from '../server/archive/security.js';
import {authorize} from '../server/archive/repository.js';
import {composePickupMail} from '../src/pickup-mail-template.js';
import {demoPickupBoxes} from '../src/pickup-workflow-demo.js';
export const config={maxDuration:60};

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
const loadAttachments=detail=>pickupAttachments(detail,type=>readFile(type==='NUEVAS'
  ?new URL('../server/templates/pickup-nuevas.xlsx',import.meta.url)
  :new URL('../server/templates/pickup-devolucion.xlsx',import.meta.url)));
const boxDetails=boxes=>boxes.map(box=>({code:box.code,type:pickupType(box)}));
export function createPickupMailHandler({env=process.env,fetcher=fetch}={}){
 return async(req,res)=>{
  try{
   if(req.method!=='POST')throw new ArchiveError('METHOD_NOT_ALLOWED',405);
   if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)
     throw new ArchiveError('ORIGIN_NOT_ALLOWED',403);
   const raw=typeof req.body==='string'?JSON.parse(req.body):req.body;
   if(raw?.action==='demoExcel'&&env.VERCEL_ENV==='preview'&&env.VERCEL_GIT_COMMIT_REF==='preview/avisos-recojo-iron-mountain'){
    if(Buffer.byteLength(JSON.stringify(raw))>16000)throw new ArchiveError('REQUEST_TOO_LARGE',413);
    try{return json(res,200,await writeDemoPickupWorkbooks(raw.visits));}
    catch{return json(res,409,{error:'Los Excel de prueba quedaron pendientes de conciliación.'});}
   }
   if(['confirm','retry','pdf'].includes(raw?.action)){
    if(env.VERCEL_ENV!=='production')throw new ArchiveError('PREVIEW_WRITE_DISABLED',403);
    if(Buffer.byteLength(JSON.stringify(raw))>8000||!/^[-a-f0-9]{36}$/i.test(raw.id||''))throw new ArchiveError('INVALID_REQUEST',400);
    const actor=await authorize(req,env,{admin:true,fetcher});
    const result=await pickupVisit({env,fetcher,raw,actor,rpc:(name,args)=>rpc(env,req,fetcher,name,args)});
    if(!result.file)return json(res,200,result);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(result.name));
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    return await pipeline(Readable.fromWeb(result.file.body),res);
   }
   if(Buffer.byteLength(JSON.stringify(raw||{}))>1000)throw new ArchiveError('REQUEST_TOO_LARGE',413);
   if(raw?.action==='sample'){
    await authorize(req,env,{admin:true,fetcher});
    const now=new Date();
    const detail={id:'simulacion-im',created_at:now.toISOString(),
      boxes:[...demoPickupBoxes.filter(box=>box.type==='NUEVAS').slice(0,30),
        ...demoPickupBoxes.filter(box=>box.type==='DEVOLUCION')]};
    const attachments=await loadAttachments(detail);
    const {subject,text,previewHtml,to,cc,from,eml}=composePickupMail(detail,attachments,{noticeAt:now,simulation:true});
    return json(res,200,{subject,text,previewHtml,to,cc,from,eml,boxDetails:boxDetails(detail.boxes),
      attachments:attachments.map(file=>file.filename),
      attachmentBase64:attachments.map(file=>Buffer.from(file.bytes).toString('base64'))});
   }
   if(!['preview','download'].includes(raw?.action)||!/^[-a-f0-9]{36}$/i.test(raw?.id||''))
     throw new ArchiveError('INVALID_REQUEST',400);
   await authorize(req,env,{admin:true,fetcher});
   const detail=await rpc(env,req,fetcher,'kardex_pickup_mail_detail',{p_id:raw.id});
   let prepared;
   let attachments=[];
   try{
    const pending=detail.status==='PENDIENTE'||detail.status==='PREPARADO';
    const official=/^IM-\d{8} II INGRESO DE CAJAS A IRON MOUNTAIN$/.test(detail.subject);
    const noticeAt=detail.workflow&&(pending||official)
      ?(pending?new Date():new Date(detail.created_at)):undefined;
    attachments=await loadAttachments(detail);
    prepared=composePickupMail(detail,attachments,{noticeAt});
   }
   catch{throw new ArchiveError('PICKUP_MAIL_INCOMPLETE',409);}
   if(raw.action==='preview'){
     return json(res,200,{id:detail.id,status:detail.status,subject:prepared.subject,
       text:prepared.text,html:prepared.html,previewHtml:prepared.previewHtml,to:prepared.to,cc:prepared.cc,from:prepared.from,
       boxes:detail.boxes.length,boxDetails:boxDetails(detail.boxes),attachments:attachments.map(item=>item.filename)});
   }
   if(env.VERCEL_ENV!=='production')throw new ArchiveError('PREVIEW_WRITE_DISABLED',403);
   if(detail.status==='CANCELADO')throw new ArchiveError('AVISO_CANCELADO',409);
   if(!detail.workflow&&detail.status==='CONFIRMADO')throw new ArchiveError('ALREADY_CONFIRMED',409);
   if(detail.status!=='CONFIRMADO')await rpc(env,req,fetcher,'kardex_pickup_mail_mark',{p_id:detail.id,p_action:'PREPARADO'});
   res.statusCode=200;
   res.setHeader('Content-Type','message/rfc822; charset=utf-8');
   res.setHeader('Content-Disposition','attachment; filename="'+prepared.filename+'"');
   res.setHeader('Cache-Control','private, no-store');
   res.setHeader('X-Content-Type-Options','nosniff');
   return res.end(prepared.eml);
  }catch(error){
   if(res.headersSent){res.destroy();return;}
   if(!(error instanceof ArchiveError))console.error(JSON.stringify({event:'pickup_mail_error',code:'PICKUP_MAIL_ERROR'}));
   const known=error instanceof ArchiveError;
   const code=known?error.code:'PICKUP_MAIL_ERROR';
   const message=code==='PICKUP_MAIL_INCOMPLETE'
     ?'El borrador está incompleto. Revisa los datos del correo y de las cajas incluidas.'
     :undefined;
   return json(res,known?error.status:503,{error:code,message});
  }
 };
}
export default createPickupMailHandler();
