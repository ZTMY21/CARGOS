import {ArchiveError,configuration} from './archive/security.js';
import {DriveClient} from './archive/drive-client.js';
import {readHistoryDrive,readMasterDrive,withMasterDriveLock,writeMasterDrive} from './im-master-drive.js';
import {IM_MASTER_FILE_ID} from './im-master-workbook.js';
import {updateConditioningWorkbooks} from './conditioning-workbooks.js';

export async function conditioningDrive({env,fetcher,rpc,action}){
  if(!configuration(env).enabled)throw new ArchiveError('DRIVE_NOT_READY',503);
  const client=new DriveClient(env,{fetcher});
  await client.checkRoot();
  if(action==='maestro')return readMasterDrive(client);
  if(action==='historico')return readHistoryDrive(client);
  return withMasterDriveLock(rpc,async token=>{
    const call=(accion,lote)=>rpc('kardex_acondicionamiento_excel_real',{
      p_accion:accion,p_secreto:env.KARDEX_RECEPCION_PROD_SECRET,p_token:token,p_lote:lote??null
    });
    const {lote}=await call('leer');
    if(!lote.length)return {verified:true,count:0};
    const master=await readMasterDrive(client);
    const history=lote.some(item=>item.enviada)?await readHistoryDrive(client):null;
    const next=await updateConditioningWorkbooks(master.bytes,history?.bytes??null,lote);
    const proof=next.maestro.equals(master.bytes)?master:await writeMasterDrive(client,master,next.maestro);
    if(history&&!next.historico.equals(history.bytes))await writeMasterDrive(client,history,next.historico);
    if(lote.some(item=>item.origen==='nueva')){
      const current=await rpc('kardex_im_master_sync',{
        p_file_id:IM_MASTER_FILE_ID,p_rows:proof.rows.filter(row=>!row.receivedOnly)
      });
      if(!current?.verificado)throw new ArchiveError('IM_MASTER_NOT_VERIFIED',503);
    }
    const result=await call('confirmar',lote.map(({id,revision})=>({id,revision})));
    if(!result.verificado)throw new ArchiveError('SINCRONIZACION_PENDIENTE',503);
    return {verified:true,count:lote.length};
  });
}
