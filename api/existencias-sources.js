import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {DriveClient} from '../server/archive/drive-client.js';
import {authorize} from '../server/archive/repository.js';
import {ArchiveError} from '../server/archive/security.js';
import {MASTERS} from '../server/cargo-excel-book.js';
import {IM_HISTORY_FILE_ID,IM_HISTORY_FILE_NAME,IM_HISTORY_PARENT_ID} from '../server/im-history-workbook.js';
import {IM_MASTER_FILE_ID,IM_MASTER_PARENT_ID} from '../server/im-master-workbook.js';
import {readExistenciasMaster,reconcileExistenciasMasters} from '../server/existencias-masters.js';
import {readExistenciasHistory} from '../server/existencias-history.js';
import {summarizeExistenciasFolios} from '../src/existencias-data.js';

export const config={maxDuration:60};
const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const xlsm='application/vnd.ms-excel.sheet.macroenabled.12';
const sources=[
  {...MASTERS.original,max:100*1024**2},
  {...MASTERS.depurado,max:150*1024**2},
  {id:IM_HISTORY_FILE_ID,name:IM_HISTORY_FILE_NAME,parent:IM_HISTORY_PARENT_ID,mime:xlsx,max:20*1024**2},
  {id:IM_MASTER_FILE_ID,name:/^CARGOS_ENVIADOS_IRON_MOUNTAIN_MAESTRO\.xls(?:m|x)$/i,parent:IM_MASTER_PARENT_ID,max:10*1024**2}
];
const prefix='https://www.googleapis.com/drive/v3/files/';
const fields=encodeURIComponent('id,name,mimeType,size,version,headRevisionId,md5Checksum,trashed,parents,capabilities(canDownload)');
const revision=file=>[file.version,file.headRevisionId,file.md5Checksum,file.size].join(':');
async function metadata(client,source){
  const file=await (await client.request(prefix+source.id+'?supportsAllDrives=true&fields='+fields)).json();
  const matchesName=typeof source.name==='string'?file.name===source.name:source.name.test(file.name);
  if(file.id!==source.id||!matchesName||file.trashed||file.capabilities?.canDownload!==true||
    (source.parent&&!file.parents?.includes(source.parent))||
    (source.mime?file.mimeType!==source.mime:![xlsx,xlsm].includes(file.mimeType))||
    !file.version||!file.headRevisionId||!/^\d+$/.test(file.size)||Number(file.size)<500||
    Number(file.size)>source.max||!/^[a-f0-9]{32}$/i.test(file.md5Checksum||''))
    throw new ArchiveError('No se pudo verificar la identidad o el acceso a '+file.name+'.',409);
  return file;
}
async function bytesFor(client,file){
  const url=prefix+file.id+'?alt=media&supportsAllDrives=true';
  const size=Number(file.size),partSize=4*1024**2;
  let buffer;
  if(size<=partSize){
    const response=await client.request(url);
    buffer=Buffer.from(await response.arrayBuffer());
  }else{
    buffer=Buffer.alloc(size);
    const offsets=Array.from({length:Math.ceil(size/partSize)},(_,i)=>i*partSize);
    let cursor=0;
    await Promise.all(Array.from({length:4},async()=>{
      while(cursor<offsets.length){
        const start=offsets[cursor++],end=Math.min(start+partSize,size)-1;
        const response=await client.request(url,{headers:{Range:'bytes='+start+'-'+end}});
        if(response.status!==206||response.headers.get('content-range')!=='bytes '+start+'-'+end+'/'+size){
          await response.body?.cancel();
          throw new ArchiveError('Drive no devolvió el tramo solicitado de '+file.name+'.',502);
        }
        const part=Buffer.from(await response.arrayBuffer());
        if(part.length!==end-start+1)throw new ArchiveError('La lectura de '+file.name+' está incompleta.',502);
        part.copy(buffer,start);
      }
    }));
  }
  if(buffer.byteLength!==Number(file.size)||createHash('md5').update(buffer).digest('hex')!==file.md5Checksum.toLowerCase())
    throw new ArchiveError('Un Excel de Drive cambió durante la lectura. Vuelve a generar el reporte.',409);
  return buffer;
}
function* responseChunks(rows,metadata){
  yield JSON.stringify(metadata).slice(0,-1)+',"rows":[';
  for(let i=0;i<rows.length;i+=512){
    yield (i?',':'')+rows.slice(i,i+512).map(row=>JSON.stringify(row)).join(',');
  }
  yield ']}';
}
export function createExistenciasSourcesReader(client){
  let cache,inFlight;
  async function masters(){
    const before=await Promise.all(sources.slice(0,2).map(source=>metadata(client,source)));
    const key=before.map(revision).join('|');
    if(cache?.key===key)return cache;
    if(inFlight?.key===key)return inFlight.promise;
    const promise=(async()=>{
      const original=await readExistenciasMaster(await bytesFor(client,before[0]));
      const clean=await readExistenciasMaster(await bytesFor(client,before[1]));
      const rows=reconcileExistenciasMasters(original,clean);
      const after=await Promise.all(sources.slice(0,2).map(source=>metadata(client,source)));
      if(after.map(revision).join('|')!==key)
        throw new ArchiveError('Un Excel de Drive cambió durante la lectura. Vuelve a generar el reporte.',409);
      return cache={key,rows,folios:summarizeExistenciasFolios(rows)};
    })();
    inFlight={key,promise};
    try{return await promise;}
    finally{if(inFlight?.promise===promise)inFlight=null;}
  }
  return async({foliosOnly=false}={})=>{
    const {key,rows,folios}=await masters();
    if(foliosOnly)return {folios};
    const before=await Promise.all(sources.slice(2).map(source=>metadata(client,source)));
    const versions=before.map(revision);
    const [historical,shipments]=await Promise.all(before.map(file=>bytesFor(client,file)));
    const historySources=await readExistenciasHistory(historical,shipments);
    const after=await Promise.all(sources.map(source=>metadata(client,source)));
    if(after.slice(0,2).map(revision).join('|')!==key||after.slice(2).some((file,i)=>revision(file)!==versions[i]))
      throw new ArchiveError('Un Excel de Drive cambió durante la lectura. Vuelve a generar el reporte.',409);
    return {rows,folios,...historySources};
  };
}

export function createExistenciasSourcesHandler({env=process.env,fetcher=fetch}={}){
  const readSources=createExistenciasSourcesReader(new DriveClient(env,{fetcher}));
  return async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    try{
      if(req.method!=='GET')throw new ArchiveError('Método no permitido.',405);
      await authorize(req,env,{admin:true,fetcher});
      const foliosOnly=new URL(req.url,'http://localhost').searchParams.get('view')==='folios';
      const {rows,...reportSources}=await readSources({foliosOnly});
      res.statusCode=200;
      if(foliosOnly){
        res.setHeader('Content-Type','application/json; charset=utf-8');
        res.end(JSON.stringify(reportSources));
        return;
      }
      res.setHeader('Content-Type','application/gzip');
      await pipeline(Readable.from(responseChunks(rows,reportSources)),createGzip({level:3}),res);
    }catch(error){
      if(res.headersSent||res.destroyed){res.destroy();return;}
      res.statusCode=error instanceof ArchiveError?error.status:503;
      res.setHeader('Content-Type','application/json; charset=utf-8');
      const messages={LOGIN_REQUIRED:'Inicia sesión para generar el reporte.',
        SESSION_INVALID:'Tu sesión venció. Vuelve a iniciar sesión.',
        ACCESS_DENIED:'Solo los administradores pueden generar el reporte.',
        DRIVE_FILE_MISSING:'La integración del aplicativo no puede leer uno de los Excel de Drive.',
        DRIVE_REAUTH_REQUIRED:'La conexión del aplicativo con Google Drive requiere autenticación.'};
      const message=messages[error.message]||error.message;
      // Return verified source diagnostics without exposing internal fetch errors.
      const safe=error instanceof ArchiveError||/^(El maestro|El detalle|La referencia|La hoja|Los encabezados|Los maestros|No se encontró|Orden de filas|Error de Excel|Faltan valores|Fórmula|Referencia de texto)/.test(message||'');
      if(!safe)console.error('existencias_sources_error',error?.name,error?.code||'');
      res.end(JSON.stringify({error:safe?message:'No se pudo consultar o procesar el detalle del reporte.'}));
    }
  };
}
export default createExistenciasSourcesHandler();
