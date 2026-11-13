import {loadHistoryWorkbook,normalizedCargoSet} from './im-history-workbook.js';
import {readMasterRows} from './im-master-workbook.js';

const valueOf=value=>{
  if(value instanceof Date)return value.toISOString().slice(0,10);
  if(value&&typeof value==='object'){
    if('result' in value)return valueOf(value.result);
    if('text' in value)return value.text;
    if(Array.isArray(value.richText))return value.richText.map(part=>part.text).join('');
  }
  return value??'';
};
const dateKey=value=>{
  const text=String(value??'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text;
  const parts=text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return parts?parts[3]+'-'+parts[2].padStart(2,'0')+'-'+parts[1].padStart(2,'0'):text;
};
const movementKey=(box,cargos,date)=>{
  const code=String(box??'').replace(/\D/g,''),set=normalizedCargoSet(cargos),day=dateKey(date);
  return code&&set&&day?JSON.stringify([code,set,day]):null;
};

export async function readExistenciasHistory(historyBytes,imBytes){
  const history=await loadHistoryWorkbook(historyBytes);
  const main=history.getWorksheet('REGISTRO');
  if(!main||!String(valueOf(main.getCell('D1').value)).includes('CODIGO DE BARRAS'))
    throw Error('La hoja REGISTRO del Histórico IM no tiene los encabezados esperados.');
  const shipments=[],returns=[],notes=[],registeredUsers=[];
  for(let i=2;i<=main.rowCount;i++){
    const row=main.getRow(i),v=Array.from({length:20},(_,j)=>valueOf(row.getCell(j+1).value));
    if(v.slice(0,11).some(x=>x!=='')){
      const [number,prepared,by,box,cargos,date,delivery,received,plate,requested,lastReturn]=v;
      shipments.push(['Histórico IM',date?'Enviado':'',number,box,cargos,prepared,by,date,requested,
        lastReturn,plate,delivery,received,'','','','','']);
      if(date&&by)registeredUsers.push({box,date:dateKey(date),cargos:normalizedCargoSet(cargos).split('|'),name:by});
    }
    if(v.slice(11).some(x=>x!=='')){
      const [id,box,requestId,requested,returned,plate,delivery,received,cargos]=v.slice(11);
      returns.push(['Histórico IM','Retorno a IM','',box,cargos,'','','',requested,
        returned,plate,delivery,received,id,requestId,'','','']);
    }
  }
  const secondary=history.getWorksheet('Hoja1');
  if(secondary&&/factura/i.test(String(valueOf(secondary.getCell('B1').value)))){
    for(let i=2;i<=secondary.rowCount;i++){
      const row=secondary.getRow(i),v=Array.from({length:6},(_,j)=>valueOf(row.getCell(j+1).value));
      if(!v.some(x=>x!==''))continue;
      const [company,invoice,amount,observation,cargo,detail]=v;
      notes.push(['Histórico IM','Observación documental','','',cargo,'','','','','','','','','','',
        invoice,[observation,detail].filter(Boolean).join(' | '),'',company,amount]);
    }
  }
  const seen=new Set([
    ...shipments.map(r=>movementKey(r[3],r[4],r[7])),
    ...returns.map(r=>movementKey(r[3],r[4],r[9]))
  ].filter(Boolean));
  const masterUsers=[];
  for(const row of await readMasterRows(imBytes)){
    if(!row.envio)continue;
    if(row.responsable)masterUsers.push({box:row.caja,date:row.envio,cargos:row.cargos,name:row.responsable});
    const key=movementKey(row.caja,row.celda,row.envio);
    if(key&&seen.has(key))continue;
    const returned=/por\s+solicitud/i.test(row.clasificacion);
    shipments.push(['Maestro de envíos IM',returned?'Retorno a IM':'Enviado',row.numero,
      row.caja,row.celda,row.preparacion,row.responsable,returned?'':row.envio,'',returned?row.envio:'',
      row.placa,row.entrega,row.recibe,'','','','',row.clasificacion]);
  }
  return {history:[...shipments,...returns,...notes],registeredUsers,masterUsers};
}
