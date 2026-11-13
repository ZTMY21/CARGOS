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
  let file;
  try{
    file=await (await client.request(prefix+source.id+'?fields='+fields+'&supportsAllDrives=true')).json();
  }catch(error){
    if(error.code==='DRIVE_NETWORK_ERROR')throw new ArchiveError('EXISTENCIAS_DRIVE_METADATA_TIMEOUT',503);
    throw error;
  }
  const matchesName=typeof source.name==='string'?file.name===source.name:source.name.test(file.name);
  if(file.id!==source.id||!matchesName||file.trashed||file.capabilities?.canDownload!==true||
    (source.parent&&!file.parents?.includes(source.parent))||
    (source.mime?file.mimeType!==source.mime:![xlsx,xlsm].includes(file.mimeType))||
    !file.version||!file.headRevisionId||!/^\d+$/.test(file.size)||Number(file.size)<500||
    Number(file.size)>source.max||!/^[a-f0-9]{32}$/i.test(file.md5Checksum||''))
    throw new ArchiveError('No se pudo verificar la identidad o el acceso a '+file.name+'.',409);
  return file;
}
function providerMediaUrl(value){
  const url=new URL(value);
  const host=url.hostname;
  const trusted=host==='www.googleapis.com'||host==='drive.google.com'||host==='drive.usercontent.google.com'
    ||host==='googleusercontent.com'||host.endsWith('.googleusercontent.com');
  if(!trusted||url.protocol!=='https:'||url.username||url.password||url.port)
    throw new ArchiveError('EXISTENCIAS_DRIVE_DOWNLOAD_LINK_INVALID',502);
  return url;
}

async function readMedia(client,address,signal){
  let url=providerMediaUrl(address);
  const token=await client.token();
  for(let hops=0;hops<4;hops++){
    const sendToken=url.hostname==='www.googleapis.com'||url.hostname==='drive.google.com'
      ||url.hostname==='drive.usercontent.google.com';
    const response=await client.fetch(url.href,{
      headers:sendToken?{Authorization:'Bearer '+token}:{},signal,redirect:'manual'
    });
    if([301,302,303,307,308].includes(response.status)){
      const destination=response.headers.get('location');
      await response.body?.cancel();
      if(!destination)break;
      url=providerMediaUrl(new URL(destination,url).href);
      continue;
    }
    if(!response.ok){
      await response.body?.cancel();
      throw new ArchiveError('EXISTENCIAS_DRIVE_DOWNLOAD_HTTP_'+response.status,502);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new ArchiveError('EXISTENCIAS_DRIVE_DOWNLOAD_LINK_INVALID',502);
}

async function downloadAddress(client,file){
  const endpoint=prefix+file.id+'/download?revisionId='+encodeURIComponent(file.headRevisionId);
  const open=async(url,method)=>(await (await client.request(url,{method})).json());
  let operation=await open(endpoint,'POST');
  for(let wait=0;!operation.done&&wait<3;wait++){
    const name=String(operation.name||'').replace(/^operations\//,'');
    if(!/^[a-zA-Z0-9._~=%+-]+$/.test(name))break;
    await client.sleep(1000*2**wait);
    operation=await open('https://www.googleapis.com/drive/v3/operations/'+encodeURIComponent(name),'GET');
  }
  if(!operation.done||!operation.response?.downloadUri)
    throw new ArchiveError('EXISTENCIAS_DRIVE_DOWNLOAD_OPERATION_UNAVAILABLE',503);
  return operation.response.downloadUri;
}

async function bytesFor(client,file){
  const url=prefix+file.id+'?alt=media';
  let buffer;
  try{
    const large=Number(file.size)>4*1024**2;
    if(large){
      // Drive can prepare a version-specific download link for large binary files.
      const address=await downloadAddress(client,file).catch(()=>url);
      buffer=await readMedia(client,address,AbortSignal.timeout(45000));
    }else buffer=await readMedia(client,url,AbortSignal.timeout(15000));
  }catch(error){
    if(error instanceof ArchiveError)throw error;
    const cause=String(error?.cause?.code||error?.code||error?.name||'NETWORK_ERROR').toUpperCase();
    const safe=/^[A-Z0-9_]{3,40}$/.test(cause)?cause:'NETWORK_ERROR';
    throw new ArchiveError('EXISTENCIAS_DRIVE_MEDIA_'+safe,503);
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
      const [originalBytes,cleanBytes]=await Promise.all(before.map(file=>bytesFor(client,file)));
      const original=await readExistenciasMaster(originalBytes);
      const clean=await readExistenciasMaster(cleanBytes);
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
        EXISTENCIAS_DRIVE_METADATA_TIMEOUT:'Google Drive no respondió al verificar los archivos maestros.',
        EXISTENCIAS_DRIVE_MEDIA_TIMEOUTERROR:'Google Drive demoró en entregar los archivos maestros. Vuelve a intentar.',
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
