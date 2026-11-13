import ExcelJS from 'exceljs';
import {computeDocEstado, computeReqEstado, REQ_TYPES, fmtDate, limaDate, monthsBetween, isSentIm, historicalShipmentDetails} from './rules.js';
import {cargoYear} from './cargo-details.js';
import {cargoExpiryGroups} from './cargo-expiry.js';
import {physicalBoxKey} from './search.js';
import {ORIGINAL_COLUMNS,reportCargoCode as code} from './existencias-data.js';
export {ORIGINAL_COLUMNS};

export const REPORT_YEARS=[2020,2021,2022,2023,2024,2025,2026];
export const CARGO_COLUMNS=['Kardex Nº','Fecha Registro','Tipo de Documento','Período Contable',
  'Ubicación','Cantidad Folios','Nº Cargo','Fecha de Envío','Estado','Antigüedad (Meses)','Usuario Registro','Código de caja'];
export const DETAIL_COLUMNS=['Kardex Nº','Fecha Registro','Tipo de Documento','Período Contable',
  'Ubicación','Cantidad Folios','Nº Cargo','Nº de Facturas'];
export const REQ_COLUMNS=['Nº Requerimiento','Tipo','Fecha Solicitud','Cantidad solicitada',
  'Cantidad recibida','Cantidad pendiente','Porcentaje de recepción','Estado','Fecha de recepción',
  'Fecha de devolución','Usuario','Códigos de cajas','Observaciones'];
export const IM_COLUMNS=['Origen','Estado','N°','Código de caja','Cargos','Fecha de preparación',
  'Responsable de preparación','Fecha de envío','Fecha de solicitud','Fecha de retorno a IM',
  'Placa de transporte','Responsable de entrega','Responsable de recepción','ID de movimiento',
  'ID de solicitud','Documento','Observaciones','Clasificación','Razón social','Importe'];
const DARK='FF1F2937',BLUE='FF1F4E78',RED='FFC00000',WHITE='FFFFFFFF';
const BORDER={top:{style:'thin'},bottom:{style:'thin'},left:{style:'thin'},right:{style:'thin'}};
function cargoGroups(docs){
  const groups=new Map();
  for(const doc of docs)for(const [index,cargo] of (doc.cargos||[]).entries()){
    if(!code(cargo))continue;
    const year=cargoYear(doc);
    const key=Number(year)>=2026?year+':'+code(cargo)
      :year+':'+code(cargo)+'|'+(doc.id||doc.kardex)+'|'+index;
    if(!groups.has(key))groups.set(key,{cargo,entries:[]});
    groups.get(key).entries.push(doc);
  }
  return groups;
}
function allSourceCargos(docs){
  // El listado general no omite ningún Kardex del Excel principal, incluso
  // si dos registros históricos o sincronizados tienen el mismo Nº Cargo.
  return docs.flatMap((doc,i)=>(doc.cargos||[]).filter(cargo=>code(cargo))
    .map((cargo,j)=>({key:String(i)+':'+String(j),cargo,doc})));
}
function sentInSummary(doc,now){
  const state=computeDocEstado(doc,now).estado;
  return isSentIm(state)||(state==='Caja solicitada'&&/^Cargos enviados 20(?:20|21|22|23|24|25)$/i.test(
    String(doc.hojaOrigen||'').trim())&&/hoja de origen declara cargos enviados/i.test(doc.estadoOrigen||''));
}
function selected(docs,now){
  return [...cargoGroups(docs)].map(([key,{cargo,entries}])=>({
    key,cargo,doc:entries.find(d=>sentInSummary(d,now))||entries[0]
  })).sort((a,b)=>b.key.localeCompare(a.key,'es',{numeric:true}));
}
function status(doc,now){
  const {estado}=computeDocEstado(doc,now);
  return estado==='Enviado a Iron Mountain' ? 'Enviado' : estado;
}
function location(doc,now){
  return isSentIm(computeDocEstado(doc,now).estado)||/^(?:Iron Mountain|Aeromontain)$/i.test(doc.ubicacion||'')
    ?'Iron Mountain':'Santa Anita';
}
function age(doc,now){
  const iso=doc.periodo||doc.fechaOrigen||doc.fechaRegistro;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso||''))return '';
  return Math.max(0,monthsBetween(new Date(iso+'T00:00:00'),new Date(limaDate(now)+'T00:00:00')));
}
const itemFolios=({doc,cargo})=>doc.foliosPorCargo?.[code(cargo)]??(Number(doc.folios)||0);
const folios=items=>items.reduce((n,item)=>n+itemFolios(item),0);
const display=items=>items.length+' ('+folios(items).toLocaleString('en-US')+' folios)';
const compareNumbered=(a,b)=>String(a??'').localeCompare(String(b??''),'es',{numeric:true,sensitivity:'base'});
const compareGeneral=(a,b)=>compareNumbered(a.doc.kardex,b.doc.kardex)||compareNumbered(a.cargo,b.cargo)||compareNumbered(a.key,b.key);
const compareAnnual=(a,b)=>compareNumbered(a.cargo,b.cargo)||compareGeneral(a,b);
function style(cell,kind='data',size=11){
  cell.font={name:'Arial',size,bold:kind!=='data',color:{argb:kind==='head'?WHITE:DARK}};
  if(kind==='head')cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:BLUE}};
  if(kind==='red')cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:RED}};
  if(kind==='red')cell.font.color={argb:WHITE};
  cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
  cell.border=BORDER;
}
function header(sheet,columns,widths,height=30){
  sheet.views=[{showGridLines:false,state:'frozen',ySplit:1}];
  columns.forEach((label,i)=>{
    sheet.getColumn(i+1).width=widths[i];
    const cell=sheet.getCell(1,i+1);cell.value=label;style(cell,'head');
  });
  sheet.getRow(1).height=height;
}
function rowStyle(row,columns){
  for(let i=1;i<=columns;i++)style(row.getCell(i));
}
function registeredName(value){
  const name=String(value??'').trim();
  return /^(?:importaci[oó]n excel|no identificado|sin responsable|[—–-])$/i.test(name)?'':name;
}
function indexShipmentUsers(rows){
  const index=new Map();
  for(const row of rows){
    const box=physicalBoxKey(row.box),name=registeredName(row.name);
    if(!box||!row.date||!name)continue;
    for(const cargo of row.cargos.map(code).filter(Boolean)){
      const key=JSON.stringify([box,row.date,cargo]);
      if(!index.has(key))index.set(key,new Map());
      index.get(key).set(name.replace(/\s+/g,' ').toUpperCase(),name);
    }
  }
  return index;
}
function shipmentUser(index,key){
  const names=index.get(key);
  return names?.size===1?names.values().next().value:'';
}
function cargoValues(item,now,masterUsers,registeredUsers){
  const {doc,cargo}=item,state=status(doc,now);
  const shipment=doc.acondicionamiento?.enviada?{
    box:doc.acondicionamiento.codigo,realDate:doc.acondicionamiento.enviada,responsible:doc.acondicionamiento.entrega
  }:historicalShipmentDetails(doc);
  const date=state==='Enviado'||state==='Histórico'?shipment.realDate:'';
  let user=registeredName(doc.usuario);
  if(state==='Enviado'){
    const key=JSON.stringify([physicalBoxKey(shipment.box),shipment.realDate,code(cargo)]);
    user=shipmentUser(masterUsers,key)||shipmentUser(registeredUsers,key)||
      registeredName(shipment.responsible)||user;
  }
  return [doc.kardex,fmtDate(doc.fechaOrigen||doc.fechaRegistro),doc.tipoDoc||'',
    fmtDate(doc.periodo),location(doc,now),itemFolios(item),cargo,
    fmtDate(date),
    state,age(doc,now),user||(state==='Histórico'?'No identificado':''),
    doc.acondicionamiento?.codigo||doc.imLiveCodigoCaja||doc.imCodigoCaja||doc.imCajaPreparada||''];
}
function addCargoSheet(workbook,items,now,masterUsers,registeredUsers){
  const sheet=workbook.addWorksheet('Cargos');
  header(sheet,CARGO_COLUMNS,[14,13,18,14,13,15,13,15,30,15,24,20]);
  for(const item of [...items].sort(compareGeneral))
    rowStyle(sheet.addRow(cargoValues(item,now,masterUsers,registeredUsers)),CARGO_COLUMNS.length);
  sheet.autoFilter={from:'A1',to:'L'+Math.max(2,sheet.rowCount)};
}
function addYearSheet(workbook,year,items){
  // El detalle original se incorpora en flujo, sin millones de celdas ExcelJS.
  const sheet=workbook.addWorksheet('Cargos '+year);
  header(sheet,ORIGINAL_COLUMNS,[14,12,11,24,40,30,17,20,17,40,26],30);
  rowStyle(sheet.addRow(Array(ORIGINAL_COLUMNS.length).fill('')),ORIGINAL_COLUMNS.length);
  const expected=items.reduce((n,item)=>n+Math.max(1,Number(item.doc.cantidadRegistros)||1),0);
  sheet.autoFilter={from:'A1',to:'K'+Math.min(1048576,Math.max(2,expected+1))};
  return sheet;
}
function addHistorySheet(workbook,history){
  const sheet=workbook.addWorksheet('Histórico IM');
  header(sheet,IM_COLUMNS,[24,22,10,18,25,16,24,16,16,16,16,22,22,24,24,24,40,24,25,14],36);
  for(const values of history)rowStyle(sheet.addRow(values),IM_COLUMNS.length);
  sheet.autoFilter='A1:T'+Math.max(2,sheet.rowCount);
}
function addReqSheet(workbook,reqs,tracking){
  const sheet=workbook.addWorksheet('Cajas solicitadas');
  header(sheet,REQ_COLUMNS,[18,34,16,16,16,16,16,24,16,16,21,55,44],35);
  const sorted=reqs.filter(req=>REQ_TYPES.slice(0,2).includes(req.tipo))
    .sort((a,b)=>REQ_TYPES.indexOf(a.tipo)-REQ_TYPES.indexOf(b.tipo)||compareNumbered(a.fechaSolicitud,b.fechaSolicitud));
  for(const req of sorted){
    const supply=req.tipo===REQ_TYPES[0];
    const receipts=tracking.receptions?.[req.id]?.lecturas||[];
    const boxes=(tracking.cajas||[]).filter(box=>box.requerimiento===req.id);
    const count=Number(req.cantidadCajas)||0;
    const reported=tracking.suministro?.solicitudes?.find(row=>row.id===req.id);
    const received=req.fechaRecepcion?count:Math.min(count,supply
      ?Number(reported?.guardadas??req.recibidoV4)||0
      :Math.max(boxes.filter(box=>box.recepcion).length,Number(req.recibidoV4)||0));
    const codes=(supply?receipts.filter(box=>box.guardado):boxes).map(box=>box.codigo).filter(Boolean);
    const notes=(tracking.movimientos||[]).filter(m=>m.requerimiento===req.id)
      .map(m=>m.datos?.observaciones||m.datos?.observacion).filter(Boolean);
    const row=sheet.addRow([req.numero,req.tipo,fmtDate(req.fechaSolicitud),count,received,
      count-received,count?received/count:null,computeReqEstado(req),fmtDate(req.fechaRecepcion),
      fmtDate(req.fechaDevolucion),req.usuario||'',codes.join(', '),[...new Set(notes)].join(' | ')]);
    rowStyle(row,REQ_COLUMNS.length);
    row.getCell(7).numFmt='0%';
    if(codes.length>4)row.height=Math.min(240,15*Math.ceil(codes.length/4));
  }
  sheet.autoFilter='A1:M'+Math.max(2,sheet.rowCount);
}
function redHeader(sheet,row,labels){
  labels.forEach((value,i)=>{const cell=sheet.getCell(row,i+2);cell.value=value;style(cell,'red');});
}
export function buildExistenciasReport(docs,now=new Date(),reqs=[],{history=[],tracking={},masterUsers=[],registeredUsers=[]}={}){
  const wb=new ExcelJS.Workbook(),items=selected(docs,now);
  wb.views=[{activeTab:0,firstSheet:0}];
  const sheet=wb.addWorksheet('Resumen');
  sheet.views=[{showGridLines:false}];
  [3,26,26,30,26].forEach((width,i)=>sheet.getColumn(i+1).width=width);
  sheet.getCell('B2').value='Reporte de Existencias — CD Santa Anita';
  sheet.getCell('B2').font={name:'Arial',size:16,bold:true,color:{argb:BLUE}};
  sheet.getCell('B3').value='Actualizado el '+limaDate(now);
  sheet.getCell('B3').font={name:'Arial',size:10,italic:true,color:{argb:'FF808080'}};
  for(const [address,label,target] of [
    ['B4','Cargos',"#'Cargos'!A1"],
    ['C4','Histórico IM',"#'Histórico IM'!A1"],
    ['D4','Cajas solicitadas',"#'Cajas solicitadas'!A1"]
  ]){
    const cell=sheet.getCell(address);
    cell.value={text:label,hyperlink:target};
    cell.font={name:'Arial',size:10,bold:true,color:{argb:BLUE},underline:true};
  }
  const years=REPORT_YEARS.slice().reverse().map(String);
  const cargos=allSourceCargos(docs);
  if(cargos.some(({doc})=>!years.includes(cargoYear(doc))))throw Error('Hay cargos fuera del período 2020–2026.');
  addCargoSheet(wb,cargos,now,indexShipmentUsers(masterUsers),indexShipmentUsers(registeredUsers));
  for(const year of years)addYearSheet(wb,year,cargos.filter(x=>cargoYear(x.doc)===year));
  addHistorySheet(wb,history);
  addReqSheet(wb,reqs,tracking);
  wb._existenciasDocs=docs;
  wb._existenciasYears=years;
  redHeader(sheet,6,['Total Cargos','Enviado a Iron Mountain','Pendientes de Envío IM']);
  sheet.getRow(6).height=34;
  const sent=items.filter(({doc})=>sentInSummary(doc,now));
  const expiry=cargoExpiryGroups(items.map(item=>({...item.doc,cargos:[item.cargo],folios:itemFolios(item)})),now);
  const pending=[...expiry.upcoming,...expiry.overdue].map(doc=>({doc,cargo:doc.cargos[0]}));
  [items,sent,pending].forEach((group,i)=>{
    const col='BCD'[i];const value=sheet.getCell(col+'7');value.value=display(group);style(value);
    value.font={name:'Arial',size:12,bold:true,color:{argb:DARK}};
    const percent=sheet.getCell(col+'8');percent.value=i===0?1:items.length?group.length/items.length:0;
    percent.numFmt='0%';style(percent,'data');
  });
  sheet.getRow(7).height=30;sheet.getRow(8).height=20;
  sheet.getCell('B11').value='Alerta que cuenta sólo lo que está por enviar';
  sheet.getCell('B11').font={name:'Arial',size:11,bold:true,color:{argb:DARK}};
  redHeader(sheet,12,['Cargos por Vencer','Cargos Vencidos']);
  sheet.getRow(12).height=24;
  // Coincide con las tarjetas del aplicativo: Nº cargos por documento de 2025/2026
  // aún sin envío, no porcentaje sobre el Kardex general ni sobre otras épocas.
  const countCargos=group=>group.reduce((n,d)=>n+(d.cargos||[]).length,0);
  const countFolios=group=>group.reduce((n,d)=>n+(Number(d.folios)||0),0);
  const upcomingCount=countCargos(expiry.upcoming),overdueCount=countCargos(expiry.overdue);
  const alertTotal=upcomingCount+overdueCount;
  // Porcentajes enteros complementarios para mostrar 100% en todos los casos.
  const upcomingPercentage=alertTotal?Math.round(upcomingCount*100/alertTotal):0;
  for(const [i,group] of [expiry.upcoming,expiry.overdue].entries()){
    const col='BC'[i];
    const value=sheet.getCell(col+'13');
    value.value=countCargos(group)+' ('+countFolios(group).toLocaleString('en-US')+' folios)';
    style(value);
    value.font={name:'Arial',size:12,bold:true,color:{argb:DARK}};
    const percent=sheet.getCell(col+'14');
    percent.value=alertTotal?(i===0?upcomingPercentage:100-upcomingPercentage)/100:0;
    percent.numFmt='0%';style(percent);
  }
  sheet.getRow(13).height=24;
  sheet.getCell('B17').value='Cargos por Período';
  sheet.getCell('B17').font={name:'Arial',size:11,bold:true,color:{argb:DARK}};
  redHeader(sheet,18,['Período','Cantidad de Cargos']);
  for(const [i,year] of years.entries()){
    const row=19+i,group=items.filter(x=>String(cargoYear(x.doc))===year);
    const yearCell=sheet.getCell('B'+row);
    yearCell.value=/^\d{4}$/.test(year)?Number(year):year;
    style(yearCell);
    yearCell.font={name:'Arial',size:12,bold:true,color:{argb:DARK}};
    const count=sheet.getCell('C'+row);
    count.value={text:String(group.length),hyperlink:"#'Cargos "+year+"'!A1",
      tooltip:'Abrir la hoja de cargos de '+year+' en este Excel'};
    style(count);
    count.font={name:'Arial',size:12,bold:true,color:{argb:'FF0563C1'},underline:true};
    sheet.getRow(row).height=15.75;
  }
  const noteRow=Math.max(29,22+years.length);
  sheet.mergeCells('B'+noteRow+':E'+(noteRow+2));
  const note=sheet.getCell('B'+noteRow);
  note.value='Haz clic en la cantidad de un período para abrir la hoja Cargos de ese año; Cargos abre el Kardex completo, de menor a mayor.';
  note.font={name:'Arial',size:8,italic:true,color:{argb:'FF808080'}};
  note.alignment={wrapText:true,vertical:'middle'};
  for(const target of [wb.getWorksheet('Cargos'),
    ...years.map(year=>wb.getWorksheet('Cargos '+year)),wb.getWorksheet('Histórico IM'),wb.getWorksheet('Cajas solicitadas')]){
    const col=target.name==='Histórico IM'?'V':target.name==='Cajas solicitadas'?'O':'Q';
    const back=target.getCell(col+'1');
    back.value={text:'← Resumen',hyperlink:"#'Resumen'!B2"};
    back.font={name:'Arial',size:10,bold:true,color:{argb:BLUE},underline:true};
    target.getColumn(col).width=15;
  }
  return wb;
}
export async function serializeExistenciasReport(workbook,getOriginalSource,progress){
  const {serializeOriginalAnnualReport}=await import('./existencias-stream.js');
  return serializeOriginalAnnualReport(workbook,getOriginalSource,progress);
}
export function buildAnnualCargoReport(docs,year,now=new Date()){
  if(!REPORT_YEARS.includes(Number(year)))throw new Error('Año de cargos no disponible.');
  const wb=new ExcelJS.Workbook();
  const sheet=wb.addWorksheet('Detalle de Cargo '+year);
  header(sheet,DETAIL_COLUMNS,[14,13,18,14,13,12,13,90]);
  for(const item of selected(docs,now).filter(x=>x.key.startsWith(year+':'))){
    const {doc}=item;
    rowStyle(sheet.addRow([doc.kardex,fmtDate(doc.fechaOrigen||doc.fechaRegistro),
      doc.tipoDoc||'',fmtDate(doc.periodo),location(doc,now),Number(doc.folios)||0,
      item.cargo,Number(doc.cantidadFacturas)||0]),DETAIL_COLUMNS.length);
  }
  sheet.autoFilter={from:'A1',to:'H'+Math.max(2,sheet.rowCount)};
  return wb;
}
