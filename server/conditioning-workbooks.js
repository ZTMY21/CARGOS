import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {readMasterRows} from './im-master-workbook.js';
import {appendPreparedBoxToMaster} from './im-master-write.js';
import {mergeIronMountainHistory} from './im-history-workbook.js';
import {checkHeaders,displayExcelDate,writeWorksheetCells} from './workbook-cells.js';

const headers={
  K:'ID DE MOVIMIENTO',L:'ID DE SOLICITUD',M:'CÓDIGO DE CAJA DEL MOVIMIENTO',
  N:'CARGOS DEL MOVIMIENTO',O:'CLASIFICACIÓN DEL MOVIMIENTO',P:'FECHA DE PREPARACIÓN DEL MOVIMIENTO',
  Q:'RESPONSABLE DE PREPARACIÓN DEL MOVIMIENTO',R:'FECHA REAL DE RETORNO',S:'PLACA DEL RETORNO',
  T:'RESPONSABLE DE ENTREGA DEL RETORNO',U:'RESPONSABLE DE RECEPCIÓN DEL RETORNO'
};
const sheetPath='xl/worksheets/sheet1.xml';
const options={minimumBoxes:1};
const cellText=value=>String(value?.text??value??'');

async function editMaster(bytes,update){
  const book=new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const sheet=book.worksheets[0];
  const zip=await JSZip.loadAsync(bytes);
  const file=zip.file(sheetPath);
  if(!file)throw Error('IM_MASTER_WORKSHEET_MISSING');
  const {xml,row,fields}=update(sheet,await file.async('string'));
  if(!xml)return bytes;
  zip.file(sheetPath,xml);
  const next=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const proof=new ExcelJS.Workbook();
  await proof.xlsx.load(next);
  for(const [col,value] of Object.entries(fields)){
    if(cellText(proof.worksheets[0].getCell(col+row).value)!==value)
      throw Error('IM_MASTER_MOVEMENT_NOT_VERIFIED');
  }
  return next;
}

function writeRequestedMovement(bytes,item){
  return editMaster(bytes,(sheet,xml)=>{
    checkHeaders(sheet,headers);
    let row=2;
    while(sheet.getCell('K'+row).value && sheet.getCell('K'+row).value!==item.id)row++;
    const same=sheet.getCell('K'+row).value===item.id;
    if(same&&(sheet.getCell('L'+row).value!==item.solicitud || cellText(sheet.getCell('M'+row).value)!==item.codigo ||
       sheet.getCell('N'+row).value!==item.cargos.join('-') ||
       (sheet.getCell('R'+row).value&&sheet.getCell('R'+row).value!==displayExcelDate(item.enviada))))
      throw Error('IM_MASTER_MOVEMENT_CONFLICT');
    if(!same&&Object.keys(headers).some(col=>sheet.getCell(col+row).value!=null))
      throw Error('IM_MASTER_MOVEMENT_ROW_OCCUPIED');
    const fields={K:item.id,L:item.solicitud,M:item.codigo,N:item.cargos.join('-'),O:'POR SOLICITUD',
      P:displayExcelDate(item.preparada),Q:item.responsable,R:displayExcelDate(item.enviada),S:item.placa||'',
      T:item.entrega||'',U:item.recibe||''};
    if(same&&Object.entries(fields).every(([col,value])=>cellText(sheet.getCell(col+row).value)===value))
      return {row,fields};
    return {row,fields,xml:writeWorksheetCells(writeWorksheetCells(xml,1,headers),row,fields)};
  });
}

async function writeMasterBox(bytes,item){
  const rows=await readMasterRows(bytes,options);
  const prior=rows.find(row=>row.caja===item.codigo);
  if(!prior)throw Error('IM_MASTER_RECEIPT_NOT_VERIFIED');
  if(prior.envio&&prior.envio!==item.enviada)throw Error('IM_MASTER_EXISTING_SHIPMENT_CONFLICT');
  if(prior.receivedOnly && !item.master_prepared){
    const prepared=await appendPreparedBoxToMaster(bytes,{
      original_code:item.codigo,cargos:item.cargos,classification:'Cajas Nuevas'
    },{preparacion:item.preparada,responsable:item.responsable,...options});
    bytes=prepared.bytes;
  }else if(prior.celda!==item.cargos.join('-')||prior.preparacion!==item.preparada||
    prior.responsable!==item.responsable||prior.clasificacion!==
    (item.origen==='solicitada'?'POR SOLICITUD':'Cajas Nuevas')){
    throw Error('IM_MASTER_EXISTING_BOX_CONFLICT');
  }
  if(!item.enviada)return bytes;
  if(prior.envio===item.enviada){
    if(prior.entrega!==(item.entrega||'')||prior.recibe!==(item.recibe||'')||prior.placa!==(item.placa||''))
      throw Error('IM_MASTER_EXISTING_SHIPMENT_CONFLICT');
    return bytes;
  }
  const row=prior.row;
  const fields={G:displayExcelDate(item.enviada),H:item.entrega||'',I:item.recibe||'',J:item.placa||''};
  const next=await editMaster(bytes,(_sheet,xml)=>({row,fields,xml:writeWorksheetCells(xml,row,fields)}));
  const sent=(await readMasterRows(next,options)).find(row=>row.caja===item.codigo);
  if(sent?.envio!==item.enviada)throw Error('IM_MASTER_SHIPMENT_NOT_VERIFIED');
  return next;
}

export async function updateConditioningWorkbooks(maestro,historico,lote,{target="both"}={}){
  const shipments=[];
  for(const item of lote){
    if(target!=='history')maestro=item.origen==='solicitada'&&!item.master_prepared
      ?await writeRequestedMovement(maestro,item):await writeMasterBox(maestro,item);
    if(target==='master'||!item.enviada)continue;
    shipments.push({
      caja:item.codigo,celda:item.cargos.join('-'),cargos:item.cargos,preparacion:item.preparada,
      responsable:item.responsable,envio:item.enviada,clasificacion:item.origen==='solicitada'?'POR SOLICITUD':'Cajas Nuevas',
      movementId:item.id,masterPrepared:item.master_prepared,requestId:item.solicitud,requestDate:item.solicitada,
      placa:item.placa,entrega:item.entrega,recibe:item.recibe
    });
  }
  if(shipments.length){
    const merged=await mergeIronMountainHistory(historico,shipments);
    if(merged.reviewRequired)throw Error('IM_HISTORY_MOVEMENT_REQUIRES_REVIEW');
    historico=merged.bytes;
  }
  return {maestro,historico};
}
