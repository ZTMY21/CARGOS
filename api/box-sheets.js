import {ArchiveError,configuration} from '../server/archive/security.js';
import {authorize} from '../server/archive/repository.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {parseBoxScan} from '../src/box-scanner.js';
import {
 BOX_SHEET_ID,BOX_CONTROL_TAB,BOX_SOURCE_TAB,BOX_HEADERS,verifyBoxSourceHeader,
 matchBoxRow,buildBoxControlValues,validateSourceBox,boxSourceRow
} from '../src/box-sheet-sync.js';

export const config={maxDuration:60};
const BASE='https://sheets.googleapis.com/v4/spreadsheets/';
const respond=(res,status,data)=>{
 res.statusCode=status;
 res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('Cache-Control','no-store, private');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.end(JSON.stringify(data));
};
const range=(tab,a1)=>encodeURIComponent("'"+tab+"'!"+a1);
const readOnlyHeaders=async(client)=>{
 const m=await(await client.request(BASE+BOX_SHEET_ID+'?fields=spreadsheetId,sheets(properties(sheetId,title))')).json();
 if(m.spreadsheetId!==BOX_SHEET_ID||!m.sheets?.some(s=>s.properties?.title===BOX_SOURCE_TAB))
   throw new ArchiveError('IM_SHEET_MISMATCH',503);
 return m;
};
const getValues=async(client,tab,a1)=>{
 const r=await client.request(BASE+BOX_SHEET_ID+'/values/'+range(tab,a1)+'?valueRenderOption=FORMATTED_VALUE');
 return (await r.json()).values||[];
};
const update=async(client,tab,a1,rows)=>{
 const r=await client.request(BASE+BOX_SHEET_ID+'/values/'+range(tab,a1)+'?valueInputOption=RAW&includeValuesInResponse=true',{
  method:'PUT',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({majorDimension:'ROWS',values:rows})
 });
 const d=await r.json();
 if(Number(d.updatedRows)!==rows.length)throw new ArchiveError('SHEETS_WRITE_UNVERIFIED',503);
 return d;
};
// Appends are deliberately not retried automatically: a network failure can occur AFTER Google applied the rows.
const append=async(client,fetcher,tab,a1,rows)=>{
 const url=BASE+BOX_SHEET_ID+'/values/'+range(tab,a1)+
  ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=true&responseValueRenderOption=UNFORMATTED_VALUE';
 let r;
 try{r=await fetcher(url,{method:'POST',headers:{
  Authorization:'Bearer '+await client.token(),'Content-Type':'application/json'
 },body:JSON.stringify({majorDimension:'ROWS',values:rows}),
 signal:AbortSignal.timeout(25000),redirect:'error'});}
 catch{throw new ArchiveError('SHEETS_APPEND_VERIFY_REQUIRED',503);}
 if(!r.ok){await r.body?.cancel();throw new ArchiveError('SHEETS_APPEND_VERIFY_REQUIRED',503);}
 const d=await r.json();
 const echo=d.updates?.updatedData?.values||[];
 if(Number(d.updates?.updatedRows)!==rows.length ||
   echo.length!==rows.length ||
   rows.some((row,i)=>row.some((val,j)=>String(echo[i]?.[j]??'')!==String(val))))
  throw new ArchiveError('SHEETS_APPEND_VERIFY_REQUIRED',503);
 return d;
};
async function ensureControl(client,fetcher,metadata){
 if(!metadata.sheets.some(s=>s.properties?.title===BOX_CONTROL_TAB)){
  // Only adds an internal control tab inside the PREEXISTING official Drive workbook.
  const body={requests:[{addSheet:{properties:{title:BOX_CONTROL_TAB,gridProperties:{frozenRowCount:1}}}}]};
  try{
   const r=await fetcher(BASE+BOX_SHEET_ID+':batchUpdate',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await client.token()},
    body:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});
   if(!r.ok)await r.body?.cancel();
  }catch{ /* A concurrent request may have created it; verify below. */ }
  metadata=await readOnlyHeaders(client);
  if(!metadata.sheets.some(s=>s.properties?.title===BOX_CONTROL_TAB))
   throw new ArchiveError('CONTROL_TAB_NOT_CREATED',503);
 }
 const row=(await getValues(client,BOX_CONTROL_TAB,'A1:K1'))[0]||[];
 if(row.length===0){
  // A partial prior setup can leave a blank header. Do not overwrite populated content.
  const below=await getValues(client,BOX_CONTROL_TAB,'A2:B3');
  if(below.some(r=>r.some(x=>String(x).trim())))throw new ArchiveError('CONTROL_TAB_HEADERS_CHANGED',409);
  await update(client,BOX_CONTROL_TAB,'A1:K1',[BOX_HEADERS]);
 }else if(BOX_HEADERS.some((h,i)=>String(row[i]??'').trim()!==h)){
  throw new ArchiveError('CONTROL_TAB_HEADERS_CHANGED',409);
 }
}
async function identity(fetcher,env,req){
 const token=req.headers.authorization;
 const r=await fetcher(env.SUPABASE_URL+'/auth/v1/user',{headers:{
   apikey:env.SUPABASE_ANON_KEY,Authorization:token
 },signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!r.ok)throw new ArchiveError('SESSION_INVALID',401);
 const data=await r.json();
 if(!data.id)throw new ArchiveError('SESSION_INVALID',401);
 return data;
}
async function actualConditionRecord(fetcher,env,req,code){
 const token=req.headers.authorization;
 const r=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/kardex_box_conditioning_list',{
  method:'POST',headers:{
   apikey:env.SUPABASE_ANON_KEY,Authorization:token,'Content-Type':'application/json'
  },body:'{}',signal:AbortSignal.timeout(15000),redirect:'error'
 });
 if(!r.ok)throw new ArchiveError('CONDITIONING_READ_FAILED',503);
 const rows=await r.json();
 return Array.isArray(rows)?rows.find(x=>x.code===code):null;
}
const lima=()=>{
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Lima',year:'numeric',month:'2-digit',
  day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
 const d=Object.fromEntries(parts.map(p=>[p.type,p.value]));
 return d.day+'/'+d.month+'/'+d.year+' '+d.hour+':'+d.minute+':'+d.second;
};
export function createBoxSheetsHandler({env=process.env,fetcher=fetch}={}){
 return async(req,res)=>{
  try{
   if(req.method!=='POST')throw new ArchiveError('METHOD_NOT_ALLOWED',405);
   if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new ArchiveError('ORIGIN_DENIED',403);
   const data=typeof req.body==='string'?JSON.parse(req.body):req.body;
   if(Buffer.byteLength(JSON.stringify(data||{}))>1600)throw new ArchiveError('REQUEST_TOO_LARGE',413);
   if(!['scan','sync','check'].includes(data?.action))throw new ArchiveError('INVALID_ACTION',400);
   const code=parseBoxScan(data.code||'');
   if(data.action!=='check'&&!code.ok)throw new ArchiveError('INVALID_BOX_CODE',400);
   await authorize(req,env,{admin:true,fetcher});
   if(env.VERCEL_ENV!=='production'&&data.action!=='check')
    throw new ArchiveError('PREVIEW_WRITE_DISABLED',403);
   const configurationState=configuration(env);
   if(!configurationState.enabled)throw new ArchiveError('DRIVE_NOT_READY',503);
   if(env.KARDEX_IM_SHEET_ID&&env.KARDEX_IM_SHEET_ID!==BOX_SHEET_ID)
    throw new ArchiveError('IM_SHEET_MISMATCH',503);
   const client=new DriveClient(env,{fetcher});
   const meta=await readOnlyHeaders(client);
   const sourceHeader=await getValues(client,BOX_SOURCE_TAB,'A1:J1');
   if(!verifyBoxSourceHeader(sourceHeader))throw new ArchiveError('IM_HEADERS_CHANGED',409);
   if(data.action==='check')return respond(res,200,{ready:true,destination:'Google Drive',facturas:'CARGOS NUEVOS',cajas:'CARGOS ENVIADOS'});
   const who=await identity(fetcher,env,req);
   const when=lima();
   await ensureControl(client,fetcher,meta);
   const keys=await getValues(client,BOX_CONTROL_TAB,'A1:B20000');
   let matching=matchBoxRow(keys,code.original,1);
   if(matching.matches.length>1)throw new ArchiveError('DUPLICATE_BOX_CONTROL',409);
   const currentRow=matching.matches[0]?.row;
   const old=currentRow?(await getValues(client,BOX_CONTROL_TAB,'A'+currentRow+':K'+currentRow))[0]:null;
   if(data.action==='scan'){
    if(currentRow){
     await update(client,BOX_CONTROL_TAB,'J'+currentRow+':K'+currentRow,[[when,when]]);
    }else{
     // Only ONE row per normalized physical box; repeated scans update its last-read timestamp.
     const row=[code.original,code.normalized,'ESCANEADA','','','','',who.email||who.id,'',when,when];
     await append(client,fetcher,BOX_CONTROL_TAB,'A:K',[row]);
    }
    const verify=matchBoxRow(await getValues(client,BOX_CONTROL_TAB,'A1:B20000'),code.original,1);
    if(verify.matches.length!==1)throw new ArchiveError('SHEETS_RECONCILE_REQUIRED',503);
    return respond(res,200,{googleVerified:true,tab:BOX_CONTROL_TAB,code:code.normalized,
      message:'Lectura registrada en Google Sheets'});
   }
   const record=await actualConditionRecord(fetcher,env,req,code.normalized);
   if(!record)throw new ArchiveError('BOX_CONDITIONING_NOT_FOUND',404);
   const row=buildBoxControlValues(record,old,when,who.email||who.id);
   if(currentRow)await update(client,BOX_CONTROL_TAB,'A'+currentRow+':K'+currentRow,[row]);
   else await append(client,fetcher,BOX_CONTROL_TAB,'A:K',[row]);
   // Reflect completed preparation in the existing official CARGOS ENVIADOS tab.
   // Never edit existing original A:J rows or dates G:J.
   let source='not_ready';
   if(record.status==='LISTA'){
    const origin=await getValues(client,BOX_SOURCE_TAB,'A1:J5000');
    if(!verifyBoxSourceHeader(origin))throw new ArchiveError('IM_HEADERS_CHANGED',409);
    const same=matchBoxRow(origin,code.original,3);
    if(same.matches.length>1)throw new ArchiveError('IM_SOURCE_DUPLICATED',409);
    const validated=validateSourceBox(record,same.matches[0]);
    if(validated.status==='conflict'){
     return respond(res,409,{error:'IM_SOURCE_CONFLICT',controlSaved:true,sourceSynced:false,detail:validated.reason});
    }
    if(validated.status==='existing')source='existing';
    else{
     const nums=origin.slice(1).map(r=>Number(String(r?.[0]||'').trim())).filter(Number.isSafeInteger);
     const next=(nums.length?Math.max(...nums):0)+1;
     const prepared=boxSourceRow(record,next,who.email||who.id,when.split(' ')[0]);
     await append(client,fetcher,BOX_SOURCE_TAB,'A:F',[prepared]);
     source='appended';
    }
   }
   const confirmation=matchBoxRow(await getValues(client,BOX_CONTROL_TAB,'A1:B20000'),code.original,1);
   if(confirmation.matches.length!==1)throw new ArchiveError('SHEETS_RECONCILE_REQUIRED',503);
   return respond(res,200,{googleVerified:true,code:code.normalized,controlSynced:true,
    sourceSynced:record.status==='LISTA',source,
    message:record.status==='LISTA'
      ?'Acondicionamiento reflejado en Google Drive; no indica envío a Iron Mountain.'
      :'Acondicionamiento sincronizado con Google Sheets'});
  }catch(e){
   const known=e instanceof ArchiveError;
   if(!known)console.error(JSON.stringify({event:'box_sheets_error',code:'BOX_SHEETS_UNAVAILABLE'}));
   return respond(res,known?e.status:503,{error:known?e.code:'BOX_SHEETS_UNAVAILABLE',
    message:'No se pudo confirmar la sincronización. Revisa Google Sheets antes de reintentar.'});
  }
 };
}
export default createBoxSheetsHandler();
