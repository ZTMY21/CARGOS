import ExcelJS from 'exceljs';
import {demoPickupBoxes,validDate} from '../src/pickup-workflow-demo.js';
import {createReceptionFixture,appendReceivedBoxes} from './reception-workbook.js';
import {updateConditioningWorkbooks} from './conditioning-workbooks.js';
import {readMasterRows} from './im-master-workbook.js';
import {linkPickupEvidence} from './pickup-workbook-evidence.js';
import {readHistoryBoxes} from './im-history-workbook.js';

export async function writeDemoPickupWorkbooks(visits){
  if(!Array.isArray(visits)||!visits.length||visits.length>65)throw Error('Visitas inválidas.');
  const ids=new Set(),seen=new Set(),shipments=[];
  for(const {id,date,codes} of visits){
    if(!/^[0-9a-f-]{36}$/i.test(id)||ids.has(id)||!validDate(date)||!Array.isArray(codes)||!codes.length||codes.length>60)
      throw Error('Visita inválida.');
    ids.add(id);
    for(const code of codes){
      const box=demoPickupBoxes.find(item=>item.code===code);
      if(!box||seen.has(code)||date<box.prepared_at)throw Error('Caja de prueba inválida o duplicada.');
      seen.add(code);
      shipments.push({visit:id,id:id+':'+box.key,codigo:code,cargos:box.cargos,preparada:box.prepared_at,
        responsable:'Operador de prueba',enviada:date,origen:box.type==='NUEVAS'?'nueva':'solicitada',
        solicitud:'SOL-'+box.key,solicitada:'2026-11-06'});
    }
  }
  const fixture=await createReceptionFixture();
  const reception=await appendReceivedBoxes(fixture.bytes,shipments.filter(x=>x.origen==='nueva')
    .map(x=>({clave:x.codigo.replace(/\D/g,''),codigo:x.codigo})),{minimumBoxes:1});
  const history=new ExcelJS.Workbook(),sheet=history.addWorksheet('REGISTRO');
  sheet.addRow(['N°','FECHA DE PREPARACIÓN','RESPONSABLE','CÓDIGO DE BARRAS','CARGOS','FECHA DE ENVÍO','ENTREGA','RECIBE','PLACA']);
  for(const item of shipments.filter(x=>x.origen==='solicitada')){
    sheet.addRow([sheet.rowCount,'01/11/2025','Operador de prueba',item.codigo,item.cargos.join('-'),'01/11/2025']);
  }
  const base=await updateConditioningWorkbooks(reception.bytes,Buffer.from(await history.xlsx.writeBuffer()),shipments);
  async function linkAll(workbooks){
    for(const visit of visits){
      const items=shipments.filter(item=>item.visit===visit.id);
      const link={url:'https://example.invalid/sustentos/'+visit.id+'.pdf',visit:visit.id};
      workbooks.maestro=await linkPickupEvidence(workbooks.maestro,items,link);
      workbooks.historico=await linkPickupEvidence(workbooks.historico,items,{...link,historical:true});
    }
    return workbooks;
  }
  await linkAll(base);
  const retry=await linkAll(await updateConditioningWorkbooks(base.maestro,base.historico,shipments));
  if(!base.maestro.equals(retry.maestro)||!base.historico.equals(retry.historico))throw Error('El reintento modificó filas.');
  const master=await readMasterRows(base.maestro,{minimumBoxes:1});
  const historyRows=await readHistoryBoxes(base.historico);
  const proof=await new ExcelJS.Workbook().xlsx.load(base.maestro);
  const historyProof=await new ExcelJS.Workbook().xlsx.load(base.historico);
  for(const item of shipments){
    const date=item.enviada.split('-').reverse().join('/');
    if(item.origen==='nueva'&&(!master.some(row=>row.caja===item.codigo&&row.envio===item.enviada&&row.celda===item.cargos.join('-'))||
      !historyRows.some(row=>row.codigo===item.codigo&&row.envio===item.enviada)))throw Error('No concilia el envío.');
    if(item.origen==='solicitada'&&(!proof.worksheets[0].getColumn('K').values.some((value,index)=>value===item.id&&
      proof.worksheets[0].getCell('M'+index).text===item.codigo&&proof.worksheets[0].getCell('R'+index).value===date)||
      !historyProof.worksheets[0].getColumn('D').values.some((value,index)=>value===item.codigo&&
      historyProof.worksheets[0].getCell('K'+index).value===date)))throw Error('No concilia la devolución.');
  }
  return {verified:[...ids],count:shipments.length,files:[
    {name:'Maestro_IM_PRUEBA.xlsx',base64:base.maestro.toString('base64')},
    {name:'Registro_envios_IM_PRUEBA.xlsx',base64:base.historico.toString('base64')}
  ]};
}
