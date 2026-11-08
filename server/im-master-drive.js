import {createHash,randomUUID} from 'node:crypto';
import {ArchiveError} from './archive/security.js';
import {IM_MASTER_FILE_ID,IM_MASTER_PARENT_ID,readMasterRows} from './im-master-workbook.js';
import {appendReceivedBoxes,createReceptionFixture} from './reception-workbook.js';

const drive='https://www.googleapis.com/drive';
const fields='id,name,mimeType,size,parents,trashed,md5Checksum,headRevisionId,capabilities(canModifyContent)';
const masterName=/^CARGOS_ENVIADOS_IRON_MOUNTAIN_MAESTRO\.(?:xlsm|xlsx)$/i;
const excelMime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const macroMime='application/vnd.ms-excel.sheet.macroenabled.12';
const md5=bytes=>createHash('md5').update(bytes).digest('hex');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function readMasterDrive(client,{id=IM_MASTER_FILE_ID,parent=IM_MASTER_PARENT_ID,
  name=masterName,minimumBoxes=49}={}) {
  const uri=drive+'/v3/files/'+encodeURIComponent(id);
  const metadata=async()=>await (await client.request(uri+'?supportsAllDrives=true&fields='+encodeURIComponent(fields))).json();
  const file=await metadata();
  if(file.id!==id || !name.test(file.name) || !file.parents?.includes(parent) || file.trashed ||
    ![excelMime,macroMime].includes(file.mimeType) || !file.capabilities?.canModifyContent ||
    !file.headRevisionId || !/^[a-f0-9]{32}$/.test(file.md5Checksum||'') ||
    Number(file.size)<500 || Number(file.size)>10*1024*1024)
    throw new ArchiveError('El Excel Maestro no tiene permisos de escritura o no coincide con el archivo autorizado.',409);
  const metadataV2=await (await client.request(drive+'/v2/files/'+encodeURIComponent(id)+
    '?supportsAllDrives=true&fields=id,etag,md5Checksum,headRevisionId')).json();
  if(metadataV2.id!==id || metadataV2.md5Checksum!==file.md5Checksum || metadataV2.headRevisionId!==file.headRevisionId ||
    !/^"[^"\r\n]+"$/.test(metadataV2.etag||''))
    throw new ArchiveError('Drive no entregó una revisión válida para proteger el Excel. Reintenta.',409);
  const data=await client.request(uri+'?alt=media&supportsAllDrives=true');
  const bytes=Buffer.from(await data.arrayBuffer());
  const after=await metadata();
  if(bytes.length!==Number(file.size)||md5(bytes)!==file.md5Checksum||
    after.headRevisionId!==file.headRevisionId||after.md5Checksum!==file.md5Checksum)
    throw new ArchiveError('El Excel cambió mientras se estaba leyendo. Reintenta.',409);
  return {file,etag:metadataV2.etag,bytes,rows:await readMasterRows(bytes,{minimumBoxes}),parent,name,minimumBoxes};
}

async function conditionalUpload(client,id,mime,etag,bytes) {
  // A single attempt. If the response is lost, reconcile from a fresh read before uploading again.
  return client.fetch('https://www.googleapis.com/upload/drive/v2/files/'+encodeURIComponent(id)+
    '?uploadType=media&newRevision=true&supportsAllDrives=true&fields=id,headRevisionId,md5Checksum,fileSize',{
      method:'PUT',headers:{Authorization:'Bearer '+await client.token(),'Content-Type':mime,'If-Match':etag},
      body:bytes,signal:AbortSignal.timeout(15000),redirect:'error'
    });
}

export async function writeMasterDrive(client,source,bytes) {
  const result=await conditionalUpload(client,source.file.id,source.file.mimeType,source.etag,bytes);
  if(!result.ok){
    await result.body?.cancel();
    throw new ArchiveError(result.status===412
      ? 'Otra persona actualizó el Excel Maestro. Reintenta para conservar ambos cambios.'
      : 'Drive no confirmó el guardado. Reintenta para comprobar si las cajas ya quedaron registradas.',
    result.status===412?409:503);
  }
  const revision=await result.json();
  const proof=await readMasterDrive(client,{id:source.file.id,parent:source.parent,
    name:source.name,minimumBoxes:source.minimumBoxes});
  if(revision.id!==source.file.id || !revision.headRevisionId || revision.md5Checksum!==md5(bytes) ||
    Number(revision.fileSize)!==bytes.length || proof.file.headRevisionId!==revision.headRevisionId ||
    sha(proof.bytes)!==sha(bytes))
    throw new ArchiveError('La versión que devolvió Drive no coincide con el guardado. Reintenta.',409);
  return proof;
}

export async function withMasterDriveLock(rpc,action) {
  const lease=await rpc('kardex_im_master_lock',{p_accion:'tomar',p_token:null});
  if(!lease?.token)throw new ArchiveError('El Excel Maestro está en uso. Espera unos segundos y reintenta.',409);
  try { return await action(lease.token); }
  finally { await rpc('kardex_im_master_lock',{p_accion:'liberar',p_token:lease.token}).catch(()=>{}); }
}

export async function probeMasterDrive(client) {
  const real=await readMasterDrive(client);
  const parent=await client.folder('backups');
  const filename='Kardex_validacion_temporal_'+randomUUID()+'.xlsx';
  const boundary='kardex_'+randomUUID();
  const fixture=await createReceptionFixture();
  const meta=Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+
    JSON.stringify({name:filename,parents:[parent],mimeType:excelMime})+
    '\r\n--'+boundary+'\r\nContent-Type: '+excelMime+'\r\n\r\n');
  const response=await client.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',{
    method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},
    body:Buffer.concat([meta,fixture.bytes,Buffer.from('\r\n--'+boundary+'--')])
  });
  const {id}=await response.json();
  if(!id || id===IM_MASTER_FILE_ID)throw Error('IM_MASTER_PROBE_FILE_INVALID');
  try{
    const options={id,parent,name:/^Kardex_validacion_temporal_[0-9a-f-]+\.xlsx$/,minimumBoxes:1};
    const copy=await readMasterDrive(client,options);
    const row={clave:'9900000999',codigo:'T9900000999'};
    const appended=await appendReceivedBoxes(copy.bytes,[row],{minimumBoxes:1});
    const proof=await writeMasterDrive(client,copy,appended.bytes);
    const stale=await conditionalUpload(client,id,copy.file.mimeType,copy.etag,copy.bytes);
    await stale.body?.cancel();
    if(stale.status!==412)throw new ArchiveError('IM_MASTER_DRIVE_PRECONDITION_UNSUPPORTED',409);
    await appendReceivedBoxes(proof.bytes,[{...row,guardado:true,correlativo:appended.added[row.clave]}],{minimumBoxes:1});
    return {masterReadable:true,masterRows:real.rows.length,masterSha256:sha(real.bytes),masterRevision:real.file.headRevisionId,writeVerified:true,staleRevisionRejected:true};
  }finally{
    await client.request(drive+'/v3/files/'+encodeURIComponent(id)+'?supportsAllDrives=true',{
      method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({trashed:true})
    });
  }
}
