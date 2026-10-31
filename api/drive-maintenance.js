import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {DriveClient} from '../server/archive/drive-client.js';
import {gateway} from '../server/archive/runtime.js';
export const config={maxDuration:60};
const out=(res,status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
function authorize(req,env){
 const required=env.KARDEX_HISTORY_MIGRATION_TOKEN||'';
 const incoming=(req.headers.authorization||'').replace(/^Bearer /,'');
 if(required.length!==64||incoming.length!==required.length||
    !timingSafeEqual(Buffer.from(required),Buffer.from(incoming)))return false;
 return env.VERCEL_ENV==='production';
}
async function uploadVerified(drive,category,name,source){
 const sha=createHash('sha256').update(source).digest('hex');
 await drive.checkRoot();
 const folder=await drive.folder(category);
 const mime=category==='history'?'application/gzip':'application/json';
 const boundary='kardex-'+randomUUID();
 const metadata={name,mimeType:mime,parents:[folder],appProperties:{kardexKey:sha,kardexArchive:'1',sha256:sha}};
 const prefix=Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: '+mime+'\r\n\r\n');
 const payload=Buffer.concat([prefix,source,Buffer.from('\r\n--'+boundary+'--\r\n')]);
 const response=await drive.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true',{
   method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body:payload
 });
 const file=await response.json();
 if(!/^[\w-]{10,200}$/.test(file.id||''))throw new Error('DRIVE_UPLOAD_MISSING_ID');
 const result=await drive.verify({driveFileId:file.id,name,mime,size:source.length,sha256:sha,key:sha,category});
 return {id:file.id,revisionId:result.revisionId,sha256:sha,bytes:source.length};
}
export default async function handler(req,res){
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='POST')return out(res,405,{error:'METHOD_NOT_ALLOWED'});
 const env=process.env;
 if(!authorize(req,env))return out(res,403,{error:'FORBIDDEN'});
 let input=req.body;
 try{if(typeof input==='string')input=JSON.parse(input);if(!input||typeof input!=='object')return out(res,400,{error:'INVALID_REQUEST'});
  const drive=new DriveClient(env);
  if(input.action==='canary'){
    const bytes=Buffer.from(JSON.stringify({kind:'KARDEX_DRIVE_WRITE_CANARY',id:randomUUID(),createdAt:new Date().toISOString()}));
    const result=await uploadVerified(drive,'manifests','kardex-drive-write-canary-'+Date.now()+'.json',bytes);
    return out(res,200,{verified:true,kind:'backend-canary',driveFileId:result.id,sha256:result.sha256,bytes:result.bytes});
  }
  if(input.action==='manifest'){
    const manifest=await gateway(env,{operation:'history-manifest'});
    if(!manifest||manifest.fileCount<1||!Array.isArray(manifest.files)||
      manifest.files.length!==manifest.fileCount)throw new Error('MANIFEST_EMPTY');
    const source=Buffer.from(JSON.stringify({...manifest,exportedAt:new Date().toISOString()}));
    const result=await uploadVerified(drive,'manifests','kardex-history-verified-manifest-'+Date.now()+'.json',source);
    return out(res,200,{verified:true,fileCount:manifest.fileCount,rowCount:manifest.rows,
      driveFileId:result.id,sha256:result.sha256,bytes:result.bytes});
  }
  if(input.action!=='archive')return out(res,400,{error:'INVALID_ACTION'});
  const {start,end}=input;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end-start>499)
    return out(res,400,{error:'INVALID_RANGE'});
  let after=start-1,rows=[];
  while(true){
    const page=await gateway(env,{operation:'history-page',start,end,after,limit:10});
    if(!Array.isArray(page))throw new Error('INVALID_HISTORY_PAGE');
    if(!page.length)break;
    for(const row of page){if(!Number.isSafeInteger(row.id)||row.id<=after||row.id>end)throw new Error('HISTORY_SEQUENCE_INVALID');after=row.id;rows.push(row);}
    if(rows.length>500)throw new Error('HISTORY_LIMIT_EXCEEDED');
    if(page.length<10)break;
  }
  if(rows.length===0)return out(res,200,{empty:true,start,end});
  const ndjson=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
  const source=gzipSync(Buffer.from(ndjson),{level:9});
  const name='kardex-historial-'+String(start).padStart(6,'0')+'-'+String(end).padStart(6,'0')+'.jsonl.gz';
  const uploaded=await uploadVerified(drive,'history',name,source);
  const record=await gateway(env,{operation:'history-record',start,end,count:rows.length,
    sha256:uploaded.sha256,fileId:uploaded.id,revisionId:uploaded.revisionId,bytes:uploaded.bytes});
  if(!record?.recorded)throw new Error('HISTORY_MANIFEST_NOT_RECORDED');
  return out(res,200,{verified:true,start,end,count:rows.length,driveFileId:uploaded.id,
    revisionId:uploaded.revisionId,sha256:uploaded.sha256,compressedBytes:uploaded.bytes});
 }catch(e){
   const message=String(e?.code||e?.message||'ARCHIVE_FAILED');
   const code=/^[A-Z][A-Z0-9_]{4,80}$/.test(message)?message:'ARCHIVE_FAILED';
   return out(res,503,{error:code});
 }
}