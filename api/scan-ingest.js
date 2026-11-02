import {ArchiveError,configuration} from '../server/archive/security.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {authorize} from '../server/archive/repository.js';
import {SCAN_SHEET_ID,SCAN_HEADERS,validateScanRows,compareScanRows,normalizeInvoice,normalizeDate} from '../src/scan-rows.js';
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
// Nunca dar por nuevo un código solo porque la hoja temporal ya fue limpiada.
// Si aparece en el Kárdex histórico, se remite a revisión; la información del
// archivo escaneado no existe en public.documentos para desambiguar por sí sola.
async function historicalConflicts(rows,existingSheet,env,fetcher){
  const exists=new Set(existingSheet.filter(r=>Array.isArray(r)&&r.length>=4)
    .map(r=>[normalizeDate(r[0])?.iso||'',String(r[1]??'').trim(),
      String(r[2]??'').trim(),normalizeInvoice(r[3])].join('|')));
  const shouldCheck=rows.filter(r=>!exists.has(r.key));
  if(!shouldCheck.length)return {accepted:rows,conflicts:[]};
  if(!env.SUPABASE_SERVICE_ROLE_KEY)throw new ArchiveError('HISTORICO_NO_VERIFICABLE',503);
  const groups=new Map();
  for(const row of shouldCheck){
    const key=row.cargo;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  }
  if(groups.size>60)throw new ArchiveError('DEMASIADOS_CARGOS_PARA_CONCILIAR',413);
  const history=new Map();
  for(const [cargo] of groups){
    const matches=new Set();
    for(let offset=0;;offset+=1000){
      // Un SELECT paginado sin escrituras; fallar cerrado ante errores o truncamiento.
      const url=env.SUPABASE_URL+'/rest/v1/documentos?select=anio_origen,periodo,cargos,facturas'
        +'&cargos=cs.'+encodeURIComponent('{'+cargo+'}')+'&limit=1000&offset='+offset;
      const response=await fetcher(url,{headers:{
        apikey:env.SUPABASE_SERVICE_ROLE_KEY,
        ...(env.SUPABASE_SERVICE_ROLE_KEY.startsWith('eyJ')?{Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY}:{})
      },signal:AbortSignal.timeout(12000),redirect:'error'});
      if(!response.ok)throw new ArchiveError('HISTORICO_NO_VERIFICABLE',503);
      const docs=await response.json();
      if(!Array.isArray(docs))throw new ArchiveError('HISTORICO_NO_VERIFICABLE',503);
      for(const doc of docs)for(const code of String(doc.facturas||'').split(/[,;\n]+/)){
        const norm=normalizeInvoice(code);
        if(norm)matches.add(norm);
      }
      if(docs.length<1000)break;
      if(offset>=9000)throw new ArchiveError('HISTORICO_DEMASIADO_GRANDE',503);
    }
    history.set(cargo,matches);
  }
  const conflicts=[],blocked=new Set();
  for(const row of shouldCheck){
    if(history.get(row.cargo)?.has(normalizeInvoice(row.codigo))){
      blocked.add(row);
      conflicts.push({line:row.line,reason:'El código ya figura en el Kárdex histórico del cargo; revisar el archivo antes de registrar otro.'});
    }
  }
  return {accepted:rows.filter(r=>!blocked.has(r)),conflicts};
}
const userCell=value=>({userEnteredValue:{stringValue:String(value??'')}});
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
      // Siempre conciliar A:K, incluidos los nombres de archivos digitalizados.
      // El rango fijo exige una guarda para no omitir filas después de la 50000.
      const existing=await values('A2:K50000');
      if(existing.length>=49999)throw new ArchiveError('RANGO_DE_HOJA_AGOTADO',503);
      const comparison=compareScanRows(validation.ready,existing);
      const history=await historicalConflicts(comparison.newRows,existing,env,fetcher);
      const changes=history.accepted;
      const allConflicts=[...comparison.conflicts,...history.conflicts];
      const summary={accepted:changes.length,updates:comparison.updates.length,
        updateCells:comparison.updates.reduce((n,u)=>n+u.patches.length,0),
        duplicates:comparison.duplicates,conflicts:allConflicts,
        otherCargos:comparison.otherCargos,source:'CARGOS NUEVOS'};
      if(body.action==='preview')return output(res,200,{...summary,preview:true,
        changes:comparison.updates.slice(0,30).map(u=>({line:u.line,rowNumber:u.rowNumber,fields:u.patches.map(p=>p.field)}))});
      if(env.VERCEL_ENV!=='production')throw new ArchiveError('PREVIEW_WRITE_DISABLED',403);
      if(!changes.length&&!comparison.updates.length)return output(res,200,{
        ...summary,saved:0,updated:0,alreadyRegistered:true,googleVerified:true});
      // Protección frente a cambios entre la validación y la confirmación.
      const snapshot=await values('A2:K50000');
      if(JSON.stringify(snapshot)!==JSON.stringify(existing))
        throw new ArchiveError('HOJA_CAMBIO_REVALIDAR',409);
      // Una sola operación batchUpdate: actualizar celdas vacías + añadir nuevas
      // filas + auditar, sin borrar celdas, filas, fórmulas ni datos de otros cargos.
      const sheetsResponse=await client.request(sheetsBase+SCAN_SHEET_ID
        +'?fields=sheets(properties(sheetId,title))');
      const sheetInfo=(await sheetsResponse.json()).sheets||[];
      const target=sheetInfo.find(x=>x.properties?.title==='CARGOS NUEVOS')?.properties?.sheetId;
      if(!Number.isInteger(target))throw new ArchiveError('HOJA_DESTINO_NO_ENCONTRADA',503);
      const auditTitle='AUDITORIA CARGA';
      let auditId=sheetInfo.find(x=>x.properties?.title===auditTitle)?.properties?.sheetId;
      const requests=[];
      if(!Number.isInteger(auditId)){
        auditId=2401102;
        if(sheetInfo.some(x=>x.properties?.sheetId===auditId))throw new ArchiveError('AUDITORIA_ID_OCUPADO',503);
        requests.push({addSheet:{properties:{sheetId:auditId,title:auditTitle,gridProperties:{columnCount:8}}}});
      }
      const audit=[];
      const timestamp=new Date().toISOString();
      const actor='Carga de digitalización (administrador)';
      for(const u of comparison.updates)for(const patch of u.patches){
        // Se toca la celda concreta; nunca una fila completa.
        requests.push({updateCells:{
          range:{sheetId:target,startRowIndex:u.rowNumber-1,endRowIndex:u.rowNumber,
            startColumnIndex:patch.column,endColumnIndex:patch.column+1},
          rows:[{values:[userCell(patch.to)]}],fields:'userEnteredValue'}});
        audit.push([timestamp,actor,'COMPLETAR',u.key,String(u.rowNumber),
          patch.field,patch.from,patch.to]);
      }
      if(changes.length){
        requests.push({appendCells:{sheetId:target,
          rows:changes.map(row=>({values:row.values.map(userCell)})),fields:'userEnteredValue'}});
        for(const row of changes) audit.push([timestamp,actor,'AGREGAR',row.key,'','Registro','','Nuevo archivo']);
      }
      if(audit.length)requests.push({appendCells:{sheetId:auditId,
        rows:audit.map(row=>({values:row.map(userCell)})),fields:'userEnteredValue'}});
      const response=await fetcher(sheetsBase+SCAN_SHEET_ID+':batchUpdate',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+await client.token()},
        body:JSON.stringify({requests}),signal:AbortSignal.timeout(25000),redirect:'error'});
      if(!response.ok)return output(res,503,{error:'ESCRITURA_POR_VERIFICAR',
        message:'Google podría haber aplicado cambios; revisa antes de reintentar.'});
      // Comprobar de nuevo los datos realmente visibles después de la operación.
      const after=await values('A2:K50000');
      const post=compareScanRows(validation.ready,after);
      if(post.newRows.length||post.updates.length)
        return output(res,503,{error:'CONCILIACION_PENDIENTE',
          message:'Google respondió, pero hay filas sin confirmar. Revalida antes de repetir.'});
      return output(res,200,{...summary,saved:changes.length,updated:comparison.updates.length,
        updatedCells:summary.updateCells,googleVerified:true,
        sync:'Nuevas filas y celdas completadas. Sin sobreescribir valores existentes.'});
    }catch(error){
      const known=error instanceof ArchiveError;
      if(!known)console.error(JSON.stringify({event:'scan_ingest_error',code:'SCAN_UNAVAILABLE'}));
      return output(res,known?error.status:503,{error:known?error.code:'SCAN_UNAVAILABLE'});
    }
  };
}
export default createScanHandler();
