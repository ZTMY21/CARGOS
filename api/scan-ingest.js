import {ArchiveError,configuration} from '../server/archive/security.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {authorize} from '../server/archive/repository.js';
import {SCAN_SHEET_ID,SCAN_HEADERS,validateScanRows,compareScanRows} from '../src/scan-rows.js';
export const config={maxDuration:60};
const encode=range=>encodeURIComponent("'CARGOS NUEVOS'!"+range);
const sheetsBase='https://sheets.googleapis.com/v4/spreadsheets/';
async function jsonBody(req){
  if(req.body!==undefined){
    const value=typeof req.body==='string'?JSON.parse(req.body):req.body;
    if(Buffer.byteLength(JSON.stringify(value))>1800000)throw new ArchiveError('LOTE_DEMASIADO_GRANDE',413);
    return value;
  }
  const chunks=[];let total=0;
  for await(const chunk of req){total+=chunk.length;if(total>1800000)throw new ArchiveError('LOTE_DEMASIADO_GRANDE',413);chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const output=(res,status,data)=>{res.statusCode=status;res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(data));};
export function createScanHandler({env=process.env,fetcher=fetch}={}){
  return async(req,res)=>{
    try{
      if(req.method!=='GET'&&req.method!=='POST')throw new ArchiveError('METHOD_NOT_ALLOWED',405);
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new ArchiveError('ORIGIN_NOT_ALLOWED',403);
      // La autenticación es obligatoria y el permiso de administrador se comprueba en Supabase.
      await authorize(req,env,{admin:true,fetcher});
      if(env.KARDEX_SCAN_SHEET_ID&&env.KARDEX_SCAN_SHEET_ID!==SCAN_SHEET_ID)throw new ArchiveError('SCAN_SOURCE_MISMATCH',503);
      const cfg=configuration(env);
      if(!cfg.enabled)throw new ArchiveError('DRIVE_NOT_READY',503);
      const client=new DriveClient(env,{fetcher});
      const metadata=await(await client.request('https://www.googleapis.com/drive/v3/files/'+SCAN_SHEET_ID+'?fields=id,name,mimeType,trashed,capabilities(canEdit)&supportsAllDrives=true')).json();
      if(metadata.id!==SCAN_SHEET_ID||metadata.trashed||metadata.mimeType!=='application/vnd.google-apps.spreadsheet'||metadata.capabilities?.canEdit!==true)throw new ArchiveError('SCAN_SOURCE_NOT_WRITABLE',503);
      const values=async(range)=>{const response=await client.request(sheetsBase+SCAN_SHEET_ID+'/values/'+encode(range)+'?valueRenderOption=FORMATTED_VALUE');const result=await response.json();return result.values||[];};
      const headers=(await values('A1:K1'))[0]||[];
      if(SCAN_HEADERS.some((h,i)=>String(headers[i]??'').trim().toLowerCase()!==h.toLowerCase()))throw new ArchiveError('SCAN_HEADERS_CHANGED',409);
      if(req.method==='GET')return output(res,200,{ready:true,source:'CARGOS NUEVOS',production:env.VERCEL_ENV==='production',limit:500});
      const body=await jsonBody(req);
      if(body?.action!=='preview'&&body?.action!=='commit')throw new ArchiveError('INVALID_ACTION',400);
      let validation;
      try{validation=validateScanRows(body.rows,body.action==='preview'?3000:500);}catch(e){throw new ArchiveError(/máxim|máxima|entre 1/.test(e.message)?'INVALID_BATCH_SIZE':'INVALID_ROWS',400);}
      if(validation.errors.length)return output(res,422,{error:'FILAS_INVALIDAS',errors:validation.errors.slice(0,100),invalid:validation.errors.length});
      // Siempre consultar la hoja actual antes de aceptar o insertar. No sustituir líneas históricas.
      const existing=await values('A2:D50000');
      const comparison=compareScanRows(validation.ready,existing);
      const summary={accepted:comparison.newRows.length,duplicates:comparison.duplicates,otherCargos:comparison.otherCargos,source:'CARGOS NUEVOS'};
      if(body.action==='preview')return output(res,200,{...summary,preview:true});
      if(env.VERCEL_ENV!=='production')throw new ArchiveError('PREVIEW_WRITE_DISABLED',403);
      if(comparison.newRows.length===0)return output(res,200,{...summary,saved:0,alreadyRegistered:true,googleVerified:true,sync:'No hay nuevas filas'});
      const valuesToSave=comparison.newRows.map(item=>item.values);
      // Una sola solicitud de append, SIN reintento automático de POST: evita duplicaciones ante un timeout ambiguo.
      const uri=sheetsBase+SCAN_SHEET_ID+'/values/'+encode('A:K')+':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=true&responseValueRenderOption=UNFORMATTED_VALUE';
      const response=await fetcher(uri,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+await client.token()},
        body:JSON.stringify({majorDimension:'ROWS',values:valuesToSave}),signal:AbortSignal.timeout(25000),redirect:'error'});
      if(!response.ok){
        // No afirmar que no se guardó: Google podría haber aplicado la operación antes de la respuesta.
        return output(res,503,{error:'ESCRITURA_POR_VERIFICAR',message:'Comprueba la hoja antes de reintentar; la operación pudo haberse aplicado.'});
      }
      const result=await response.json(),updated=result.updates||{},returned=updated.updatedData?.values||[];
      const recorded=Number(updated.updatedRows)||0;
      const same=recorded===valuesToSave.length&&returned.length===valuesToSave.length&&returned.every((row,i)=>valuesToSave[i].every((v,j)=>String(row[j]??'')===String(v)));
      if(!same)return output(res,503,{error:'CONCILIACION_PENDIENTE',message:'Google respondió, pero el resultado necesita verificación manual antes de reintentar.',updatedRange:updated.updatedRange||null});
      return output(res,200,{...summary,saved:recorded,updatedRange:updated.updatedRange,
        googleVerified:true,sync:'Guardado en Sheets. La confirmación en Kárdex depende del proceso periódico existente.'});
    }catch(error){
      const known=error instanceof ArchiveError;
      if(!known)console.error(JSON.stringify({event:'scan_ingest_error',code:'SCAN_UNAVAILABLE'}));
      return output(res,known?error.status:503,{error:known?error.code:'SCAN_UNAVAILABLE'});
    }
  };
}
export default createScanHandler();
