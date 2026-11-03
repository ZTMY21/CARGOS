import {createHash} from 'node:crypto';
import {ArchiveError,configuration} from '../server/archive/security.js';
import {authorize} from '../server/archive/repository.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {MASTERS,inspectMaster,appendMasterCargo,cargoFingerprint} from '../server/cargo-excel-book.js';
import {validateScanRows,normalizeInvoice} from '../src/scan-rows.js';

// Un archivo de entrada de 500 MB NUNCA se envía a Vercel: solo llegan las filas nuevas.
export const config={maxDuration:60};
const prefix='https://www.googleapis.com/drive/v3/files/';
const uploadBase='https://www.googleapis.com/upload/drive/v3/files/';
const output=(res,status,body)=>{
  res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.end(JSON.stringify(body));
};
async function jsonInput(req,max=3500000){
  if(req.body!==undefined){
    const value=typeof req.body==='string'?JSON.parse(req.body):req.body;
    if(Buffer.byteLength(JSON.stringify(value))>max)throw new ArchiveError('CARGO_DEMASIADO_GRANDE',413);
    return value;
  }
  const chunks=[];let n=0;
  for await(const chunk of req){n+=chunk.length;if(n>max)throw new ArchiveError('CARGO_DEMASIADO_GRANDE',413);chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function validateCargo(body){
  const cargo=Number(body?.cargo),rows=body?.rows;
  if(!Number.isSafeInteger(cargo)||cargo<942||cargo>9999999)throw new ArchiveError('CARGO_INVALIDO',422);
  if(!Array.isArray(rows)||rows.length===0||rows.length>15000)throw new ArchiveError('FILAS_INVALIDAS',422);
  const checked=validateScanRows(rows,15000);
  if(checked.errors.length||checked.ready.length!==rows.length)
    throw new ArchiveError('FILAS_INVALIDAS',422);
  if(checked.ready.some(r=>r.iso.slice(0,4)!=='2026'||Number(r.cargo)!==cargo))
    throw new ArchiveError('CARGO_Y_ANIO_NO_COINCIDEN',422);
  const dates=new Set(checked.ready.map(r=>r.iso));
  if(dates.size!==1)throw new ArchiveError('FECHAS_DE_CARGO_DISTINTAS',422);
  return {cargo,rows:checked.ready.map(r=>r.values),date:[...dates][0],
    codes:new Set(checked.ready.map(r=>normalizeInvoice(r.codigo))).size};
}
const hex=bytes=>createHash('md5').update(bytes).digest('hex');
export function createCargoExcelHandler({env=process.env,fetcher=fetch}={}){
  return async(req,res)=>{
    try{
      if(!['GET','POST'].includes(req.method))throw new ArchiveError('METODO_NO_ADMITIDO',405);
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new ArchiveError('ORIGEN_NO_ADMITIDO',403);
      await authorize(req,env,{admin:true,fetcher});
      if(!configuration(env).enabled)throw new ArchiveError('DRIVE_NO_PREPARADO',503);
      const client=new DriveClient(env,{fetcher});
      const originalsId=await client.folder('originals');
      const request=async(id,fields)=>await(await client.request(prefix+id+'?fields='+encodeURIComponent(fields)+'&supportsAllDrives=true')).json();
      const meta=async target=>{
        const f=MASTERS[target];
        if(!f)throw new ArchiveError('MAESTRO_NO_VALIDO',400);
        const m=await request(f.id,'id,name,size,mimeType,parents,trashed,md5Checksum,headRevisionId,capabilities(canEdit)');
        if(m.trashed||m.name!==f.name||m.mimeType!==f.mime||
          !m.parents?.includes(originalsId)||m.capabilities?.canEdit===false||Number(m.size)<100000)
          throw new ArchiveError('MAESTRO_MODIFICADO_O_NO_DISPONIBLE',409);
        return m;
      };
      const media=async(target,m)=>{
        const r=await fetcher(prefix+MASTERS[target].id+'?alt=media',{headers:{Authorization:'Bearer '+await client.token()},
          signal:AbortSignal.timeout(45000),redirect:'error'});
        if(!r.ok)throw new ArchiveError('ERROR_AL_DESCARGAR_MAESTRO',503);
        const buf=Buffer.from(await r.arrayBuffer());
        if(buf.byteLength!==Number(m.size)||m.md5Checksum&&hex(buf)!==m.md5Checksum)
          throw new ArchiveError('REVISION_MAESTRA_INCONSISTENTE',409);
        return buf;
      };
      const read=async target=>{
        const m=await meta(target),buf=await media(target,m);
        return {m,buf,info:await inspectMaster(buf,target)};
      };
      const short=({m,info})=>({name:m.name,lastCargo:info.lastCargo,cargos:info.cargos,
        counts:info.counts,distinctCodes:info.distinctCodes,revision:m.headRevisionId,rows:info.rows});
      if(req.method==='GET'){
        const index=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/kardex_excel_estado',{
          method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:req.headers.authorization,'Content-Type':'application/json'},
          body:'{}',signal:AbortSignal.timeout(15000),redirect:'error'});
        if(!index.ok)throw new ArchiveError('INDICE_KARDEX_NO_DISPONIBLE',503);
        const current=await index.json();
        const [original,depurado]=await Promise.all([read('original'),read('depurado')]);
        return output(res,200,{ready:true,year:2026,original:short(original),depurado:short(depurado),
          indexedCargos:current.indexedCargos||[],indexedLastCargo:current.indexedLastCargo??941,
          writesEnabled:env.VERCEL_ENV==='production'});
      }
      const body=await jsonInput(req),action=body?.action;
      if(action!=='commit'&&action!=='finalize')throw new ArchiveError('ACCION_INVALIDA',400);
      const {cargo,rows,date,codes}=validateCargo(body);
      if(env.VERCEL_ENV!=='production')throw new ArchiveError('PREVIEW_SIN_ESCRITURA',403);
      if(action==='commit'){
        const target=body.target;if(!MASTERS[target])throw new ArchiveError('MAESTRO_NO_VALIDO',400);
        const leaseReq=async(path,data)=>{
          const result=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/'+path,{
            method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:req.headers.authorization,'Content-Type':'application/json'},
            body:JSON.stringify(data),signal:AbortSignal.timeout(15000),redirect:'error'
          });
          if(!result.ok)throw new ArchiveError('OTRA_CARGA_DEL_MISMO_EXCEL_EN_CURSO',423);
          return result.json();
        };
        const lease=await leaseReq('kardex_excel_tomar_lease',{p_destino:target,p_cargo:cargo});
        try{
        const current=await read(target);
        const before=current.info;
        if(before.cargos.includes(cargo)){
          if(before.counts[cargo]!==rows.length||before.distinctCodes[cargo]!==codes||before.fingerprints[cargo]!==cargoFingerprint(rows))
            throw new ArchiveError('CONFLICTO_CARGO_EXISTENTE_EN_MAESTRO',409);
          return output(res,200,{target,cargo,verified:true,alreadyPresent:true,saved:0});
        }
        if(before.lastCargo!==cargo-1)
          throw new ArchiveError('CORRELATIVO_DESCONTINUADO_SIGUIENTE_'+(before.lastCargo+1),409);
        // Verifica el respaldo del libro antes de sobrescribirlo.
        const backupsId=await client.folder('backups');
        const day=new Date().toISOString().slice(0,10);
        const backupName='PREVIO_FACTURAS_'+target+'_'+day+'_'+MASTERS[target].name;
        const q='name = '+String.fromCharCode(39)+backupName+String.fromCharCode(39)+
          ' and '+String.fromCharCode(39)+backupsId+String.fromCharCode(39)+' in parents and trashed = false';
        const found=await(await client.request(prefix+'?q='+encodeURIComponent(q)+'&fields=files(id,name,size,parents)&pageSize=10')).json();
        if(!(found.files||[]).some(f=>Number(f.size)>100000)){
          const copied=await(await client.request(prefix+MASTERS[target].id+'/copy?fields=id,size,name,parents',
            {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:backupName,parents:[backupsId]})})).json();
          if(!copied.id||Number(copied.size)<100000)throw new ArchiveError('RESPALDO_PREVIO_NO_CONFIRMADO',503);
        }
        const updated=await appendMasterCargo(current.buf,target,cargo,rows);
        if(!updated.bytes||updated.rowsAdded!==rows.length)throw new ArchiveError('ERROR_AL_GENERAR_EXCEL',503);
        // Evitar sobrescribir modificaciones realizadas entre la descarga y la escritura.
        const again=await meta(target);
        if(again.headRevisionId!==current.m.headRevisionId||again.md5Checksum!==current.m.md5Checksum)
          throw new ArchiveError('EL_EXCEL_CAMBIO_DURANTE_LA_CARGA',409);
        const upload=await fetcher(uploadBase+MASTERS[target].id+'?uploadType=media&fields='+encodeURIComponent('id,size,md5Checksum'),
          {method:'PATCH',headers:{Authorization:'Bearer '+await client.token(),'Content-Type':MASTERS[target].mime},
            body:updated.bytes,signal:AbortSignal.timeout(45000),redirect:'error'}).catch(()=>null);
        if(!upload?.ok)throw new ArchiveError('ESCRITURA_PENDIENTE_DE_VERIFICACION',503);
        const after=await meta(target);
        if(Number(after.size)!==updated.newSize||after.md5Checksum!==hex(updated.bytes))
          throw new ArchiveError('ESCRITURA_PENDIENTE_DE_VERIFICACION',503);
        return output(res,200,{target,cargo,verified:true,alreadyPresent:false,saved:rows.length,
          revision:after.headRevisionId});
        }finally{
          try{await leaseReq('kardex_excel_liberar_lease',{p_destino:target,p_token:lease});}
          catch{console.error(JSON.stringify({event:'excel_lease_release_failed',target}));}
        }
      }
      // Solo índice ligero en PostgreSQL y únicamente después de verificar AMBOS libros.
      const [one,two]=await Promise.all([read('original'),read('depurado')]);
      if([one,two].some(x=>x.info.counts[cargo]!==rows.length||x.info.distinctCodes[cargo]!==codes||x.info.fingerprints[cargo]!==cargoFingerprint(rows)))
        throw new ArchiveError('LOS_DOS_EXCEL_NO_ESTAN_CONCILIADOS',409);
      const groups={};
      for(const r of rows){
        const code=normalizeInvoice(r[3]),group=String(r[2]);
        if(!groups[code])groups[code]=[];
        if(!groups[code].includes(group))groups[code].push(group);
      }
      const bearer=req.headers.authorization;
      const rpc=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/kardex_excel_finalizar',{
        method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:bearer,'Content-Type':'application/json'},
        body:JSON.stringify({p_anio:2026,p_cargo:String(cargo),p_fecha:date,p_filas:rows.length,
          p_grupos_por_codigo:groups}),signal:AbortSignal.timeout(15000),redirect:'error'});
      if(!rpc.ok)throw new ArchiveError('EXCEL_CONFIRMADO_INDICE_PENDIENTE',503);
      const indexed=await rpc.json();
      return output(res,200,{cargo,verified:true,indexed:true,saved:rows.length,codes,
        documentId:indexed.documento_id||indexed.id||null,
        detail:'Los dos Excel se verificaron y el índice del Kárdex fue actualizado.'});
    }catch(error){
      const known=error instanceof ArchiveError;
      if(!known)console.error(JSON.stringify({event:'cargo_excel_error',code:'EXCEL_DUAL_UNAVAILABLE'}));
      return output(res,known?error.status:503,{error:known?error.code:'EXCEL_DUAL_UNAVAILABLE',
        message:known&&error.code==='ESCRITURA_PENDIENTE_DE_VERIFICACION'
          ?'El intento pudo haberse guardado. Vuelve a validar ambos Excel antes de reintentar; nunca repitas a ciegas.':null});
    }
  };
}
export default createCargoExcelHandler();
