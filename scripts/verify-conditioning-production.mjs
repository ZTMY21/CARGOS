import {configuration,pickupDriveAllowed} from '../server/archive/security.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {readMasterDrive,readHistoryDrive} from '../server/im-master-drive.js';
import {appendReceivedBoxes} from '../server/reception-workbook.js';
import {readHistoryBoxes} from '../server/im-history-workbook.js';
import {updateConditioningWorkbooks} from '../server/conditioning-workbooks.js';
import {createExistenciasSourcesReader} from '../api/existencias-sources.js';

const env=process.env;
try{
  if(env.VERCEL_ENV!=='production'||env.SUPABASE_URL!=='https://uhjwhamzjxhjqlrhgxho.supabase.co'||
    !/^[a-f0-9]{64}$/.test(env.KARDEX_RECEPCION_PROD_SECRET||'')||!configuration(env).enabled)
    throw Error('PRODUCTION_CONFIGURATION_NOT_READY');
  const client=new DriveClient(env);
  await client.checkRoot();
  if(env.KARDEX_PICKUP_WORKFLOW_ENABLED==='true'){
    if(!pickupDriveAllowed(env))throw Error('PICKUP_CONFIGURATION_NOT_READY');
    await client.folder('scans');
    console.log('Avisos de recojo: carpeta de sustentos y acceso de escritura verificados.');
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
