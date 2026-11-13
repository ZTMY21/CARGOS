import {randomUUID} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {ArchiveError,configuration,pickupDriveAllowed,sha256} from '../server/archive/security.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {readMasterDrive,readHistoryDrive} from '../server/im-master-drive.js';
import {appendReceivedBoxes} from '../server/reception-workbook.js';
import {readHistoryBoxes} from '../server/im-history-workbook.js';
import {updateConditioningWorkbooks} from '../server/conditioning-workbooks.js';
import {createExistenciasSourcesReader} from '../api/existencias-sources.js';

const env=process.env;

async function verifyPickupUpload(client){
  const pdf=await PDFDocument.create();
  pdf.addPage();
  const bytes=Buffer.from(await pdf.save());
  const id=randomUUID();
  const job={id,key:sha256(id),name:'Validacion_temporal_recojo_'+id+'.pdf',
    mime:'application/pdf',category:'scans',size:bytes.length,sha256:sha256(bytes),
    driveFileId:await client.allocate()};
  const session=await client.initiate(job);
  try{
    if(await client.progress(session,job.size)!==0||
      await client.progress(session,job.size,bytes,0)!==job.size)
      throw Error('PICKUP_UPLOAD_NOT_COMPLETED');
    await client.verify(job);
  }finally{
    const file=await client.metadata(job.driveFileId).catch(error=>{
      if(error instanceof ArchiveError&&error.code==='DRIVE_FILE_MISSING')return null;
      throw error;
    });
    if(file){
      if(file.appProperties?.kardexKey!==job.key)throw Error('PICKUP_TEST_FILE_MISMATCH');
      const response=await client.request('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(job.driveFileId)+'?supportsAllDrives=true',{
        method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({trashed:true})
      });
      await response.body?.cancel();
    }
  }
}

try{
  if(env.VERCEL_ENV!=='production'||env.SUPABASE_URL!=='https://uhjwhamzjxhjqlrhgxho.supabase.co'||
    !/^[a-f0-9]{64}$/.test(env.KARDEX_RECEPCION_PROD_SECRET||'')||!configuration(env).enabled)
    throw Error('PRODUCTION_CONFIGURATION_NOT_READY');
  const client=new DriveClient(env);
  await client.checkRoot();
  if(env.KARDEX_PICKUP_WORKFLOW_ENABLED==='true'){
    if(!pickupDriveAllowed(env))throw Error('PICKUP_CONFIGURATION_NOT_READY');
    await verifyPickupUpload(client);
    console.log('Avisos de recojo: carga reanudable y lectura del PDF verificadas en la carpeta de sustentos.');
  }
  const [master,history]=await Promise.all([readMasterDrive(client),readHistoryDrive(client)]);
  const historyRows=await readHistoryBoxes(history.bytes);
  const sample=historyRows.find(row=>row.envio&&row.cargos.length>0&&
    historyRows.filter(other=>other.clave===row.clave).length===1);
  if(!sample||historyRows.length<100)throw Error('HISTORY_SOURCE_NOT_VERIFIED');
  // Exercise the exact real file formats in memory. No upload is performed.
  const testCode='TD9900009898';
  const received=await appendReceivedBoxes(master.bytes,[{clave:'9900009898',codigo:testCode}]);
  const common={preparada:'2026-11-08',enviada:'2026-11-08',responsable:'Validación de publicación'};
  const jobs=[
    {...common,origen:'nueva',codigo:testCode,cargos:['9898989']},
    {...common,origen:'solicitada',codigo:sample.codigo,cargos:sample.cargos,id:'validacion-local',
      solicitud:'solicitud-local',solicitada:'2026-11-07'}
  ];
  const first=await updateConditioningWorkbooks(received.bytes,history.bytes,jobs);
  const second=await updateConditioningWorkbooks(first.maestro,first.historico,jobs);
  if(!first.maestro.equals(second.maestro)||!first.historico.equals(second.historico))
    throw Error('PRODUCTION_FILE_RETRY_NOT_IDEMPOTENT');
  console.log('Acondicionamiento: permisos, revisiones y escritura simulada del Maestro e Histórico verificados.');
  const started=Date.now();
  const {folios,rows}=await createExistenciasSourcesReader(client)();
  if(!folios.length||!rows.length)throw Error('EXISTENCIAS_DRIVE_SOURCE_EMPTY');
  console.log('Reporte de Existencias: lectura de Drive verificada para '+folios.length+' cargos en '+
    Math.round((Date.now()-started)/1000)+' s.');
}catch(error){
  const code=String(error.code||error.message||'').match(/^[A-Z0-9_]{3,100}$/)?.[0]||'PRODUCTION_WORKBOOK_CHECK_FAILED';
  console.error('Acondicionamiento: '+code);
  process.exitCode=1;
}
