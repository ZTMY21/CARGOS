import {ArchiveError,configuration,pickupDriveAllowed,pickupEvidenceKey} from './archive/security.js';
import {DriveClient} from './archive/drive-client.js';
import {ArchiveRepository} from './archive/repository.js';
import {validatePickupPdf} from '../src/pickup-workflow-demo.js';
import {readHistoryDrive,readMasterDrive,withMasterDriveLock,writeMasterDrive} from './im-master-drive.js';
import {updateConditioningWorkbooks} from './conditioning-workbooks.js';
import {linkPickupEvidence} from './pickup-workbook-evidence.js';
import {IM_MASTER_FILE_ID} from './im-master-workbook.js';
import {IM_HISTORY_FILE_ID} from './im-history-workbook.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export async function pickupVisit({env,fetcher,rpc,raw,actor}){
  if(!pickupDriveAllowed(env)||!configuration(env).enabled||!env.KARDEX_RECEPCION_PROD_SECRET)
    throw new ArchiveError('Integración con 01_Escaneados pendiente de habilitar.',503);
  if(!uuid.test(raw.visit||''))throw new ArchiveError('Visita inválida.',400);
  const visit=(action,data={})=>rpc('kardex_pickup_visit',{p_action:action,p_id:raw.id,
    p_visit:raw.visit,p_data:data,p_secret:env.KARDEX_RECEPCION_PROD_SECRET});
  const client=new DriveClient(env,{fetcher});
  if(raw.action==='pdf'){
    const proof=await visit('pdf');
    const file=await client.media(proof.fileId,proof.revision);
    return {file,name:proof.name};
  }
  if(raw.action==='confirm'){
    if(!uuid.test(raw.job||'')||!Array.isArray(raw.codes)||!raw.codes.length||raw.codes.length>60)
      throw new ArchiveError('Selecciona las cajas retiradas y adjunta el PDF.',400);
    const job=await new ArchiveRepository(env,{fetcher}).get(raw.job);
    const binding=pickupEvidenceKey.exec(job.sourceKey);
    if(!binding||binding[1]!==raw.id||binding[2]!==raw.visit||binding[3]!==actor.id||
      job.name!=='IM_RECOJO_'+raw.date+'_AV-'+raw.id.slice(0,8)+'_'+raw.visit+'.pdf'||
      job.category!=='scans'||job.status!=='verified'||!job.backendVerified||job.errorCode||job.size>5*1024**2)
      throw new ArchiveError('El PDF todavía no está verificado para esta visita.',409);
    await client.verify(job);
    const pdf=await client.media(job.driveFileId,job.revisionId);
    const bytes=new Uint8Array(await pdf.arrayBuffer());
    let pages;
    try{pages=await validatePickupPdf(bytes);}
    catch(error){throw new ArchiveError(error.message,400);}
    await visit('confirm',{date:raw.date,codes:raw.codes,fileId:job.driveFileId,revision:job.revisionId,
      name:job.name,size:job.size,sha256:job.sha256,pages,uploadedBy:actor.id});
  }
  const pending=await visit('status');
  if(pending.verified)return pending;
  try{
    return await withMasterDriveLock(rpc,async token=>{
      let proof=await visit('status');
      if(proof.verified)return proof;
      const master=await readMasterDrive(client);
      const pdf=await visit('pdf');
      const link={url:'https://drive.google.com/file/d/'+encodeURIComponent(pdf.fileId)+'/view',visit:raw.visit};
      const {maestro}=await updateConditioningWorkbooks(master.bytes,null,proof.lote,{target:'master'});
      const linkedMaster=await linkPickupEvidence(maestro,proof.lote,link);
      const history=IM_MASTER_FILE_ID!==IM_HISTORY_FILE_ID?await readHistoryDrive(client):null;
      let linkedHistory;
      if(history){
        const {historico}=await updateConditioningWorkbooks(null,history.bytes,proof.lote,{target:'history'});
        linkedHistory=await linkPickupEvidence(historico,proof.lote,{...link,historical:true});
      }
      const readback=linkedMaster.equals(master.bytes)?master:await writeMasterDrive(client,master,linkedMaster);
      await visit('progress',{destination:'master'});
      if(history&&!linkedHistory.equals(history.bytes))await writeMasterDrive(client,history,linkedHistory);
      await visit('progress',{destination:'history'});
      // El proyector vigente se actualiza solo con el Maestro reconciliado.
      if(proof.lote.some(item=>item.origen==='nueva'||item.master_prepared)){
        const result=await rpc('kardex_im_master_sync',{p_file_id:IM_MASTER_FILE_ID,
          p_rows:readback.rows.filter(row=>!row.receivedOnly)});
        if(!result.verificado)throw new ArchiveError('IM_MASTER_NOT_VERIFIED',503);
      }
      const movements=proof.lote.filter(item=>!item.master_prepared);
      for(let i=0;i<movements.length;i+=30){
        const result=await rpc('kardex_acondicionamiento_excel_real',{
          p_accion:'confirmar',p_secreto:env.KARDEX_RECEPCION_PROD_SECRET,p_token:token,
          p_lote:movements.slice(i,i+30).map(({id,revision})=>({id,revision}))
        });
        if(!result.verificado)throw new ArchiveError('SINCRONIZACION_PENDIENTE',503);
      }
      proof=await visit('progress',{destination:'projection'});
      return proof;
    });
  }catch(error){
    await visit('progress',{error:error instanceof ArchiveError?error.code:'SINCRONIZACION_PENDIENTE'}).catch(()=>{});
    return {id:raw.visit,verified:false};
  }
}
