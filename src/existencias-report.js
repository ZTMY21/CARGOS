import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {computeDocEstado, fmtDate, limaDate, monthsBetween} from './rules.js';
import {cargoYear} from './cargo-details.js';
import {cargoExpiryGroups} from './cargo-expiry.js';

export const REPORT_YEARS=[2021,2022,2023,2024,2025,2026];
export const CARGO_COLUMNS=['Kardex Nº','Fecha Registro','Tipo de Documento','Período Contable',
  'Ubicación','Cantidad Folios','Cantidad Registros','Cantidad Códigos','Nº Cargo',
  'Requerimiento Asignado','Fecha de Envío','Sustento (Guía de Traslado)',
  'Estado','Antigüedad (Meses)','Usuario Registro','Observaciones'];
export const DETAIL_COLUMNS=['Kardex Nº','Fecha Registro','Tipo de Documento','Período Contable',
  'Ubicación','Cantidad Folios','Nº Cargo','Nº de Facturas'];
export const REQ_COLUMNS=['Nº Requerimiento','Tipo','Fecha Solicitud','Cantidad Cajas',
  'Números de Cargo','Fecha Recepción','Fecha Devolución','Cajas Usadas','Estado','Usuario'];
const DARK='FF1F2937',BLUE='FF1F4E78',RED='FFC00000',WHITE='FFFFFFFF';
const BORDER={top:{style:'thin'},bottom:{style:'thin'},left:{style:'thin'},right:{style:'thin'}};
const code=value=>String(value??'').trim().replace(/\.0+$/,'').replace(/^0+(?=\d)/,'').toUpperCase();
function cargoGroups(docs){
  const groups=new Map();
  for(const doc of docs)for(const [index,cargo] of (doc.cargos||[]).entries()){
    if(!code(cargo))continue;
    const year=cargoYear(doc);
    const key=year==='2026'?year+':'+code(cargo)
      :year+':'+code(cargo)+'|'+(doc.id||doc.kardex)+'|'+index;
    if(!groups.has(key))groups.set(key,{cargo,entries:[]});
    groups.get(key).entries.push(doc);
  }
  return groups;
}
function selected(docs,now){
  return [...cargoGroups(docs)].map(([key,{cargo,entries}])=>({
    key,cargo,doc:entries.find(d=>computeDocEstado(d,now).estado==='Enviado a Iron Mountain')||entries[0]
  })).sort((a,b)=>b.key.localeCompare(a.key,'es',{numeric:true}));
}
function status(doc,now){
  return computeDocEstado(doc,now).estado==='Enviado a Iron Mountain'?'Enviado':'Pendiente de Envío';
}
function location(doc,now){
  return status(doc,now)==='Enviado'||/^(?:Iron Mountain|Aeromontain)$/i.test(doc.ubicacion||'')
    ?'Iron Mountain':'Santa Anita';
}
function age(doc,now){
  const iso=doc.periodo||doc.fechaOrigen||doc.fechaRegistro;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso||''))return '';
  return Math.max(0,monthsBetween(new Date(iso+'T00:00:00'),new Date(limaDate(now)+'T00:00:00')));
}
const folios=items=>items.reduce((n,item)=>n+(Number(item.doc.folios)||0),0);
const display=items=>items.length+' ('+folios(items).toLocaleString('en-US')+' folios)';
const compareNumbered=(a,b)=>String(a??'').localeCompare(String(b??''),'es',{numeric:true,sensitivity:'base'});
const compareGeneral=(a,b)=>compareNumbered(a.doc.kardex,b.doc.kardex)||compareNumbered(a.cargo,b.cargo)||compareNumbered(a.key,b.key);
const compareAnnual=(a,b)=>compareNumbered(cargoYear(a.doc),cargoYear(b.doc))||
  compareNumbered(a.cargo,b.cargo)||compareGeneral(a,b);
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
function cargoValues(item,now,reqNumbers){
  const {doc,cargo}=item,sent=status(doc,now)==='Enviado';
  const delivery=doc.imLiveFechaEnvio?doc.imLiveResponsableEntrega:doc.imResponsable;
  return [doc.kardex,fmtDate(doc.fechaOrigen||doc.fechaRegistro),doc.tipoDoc||'',
    fmtDate(doc.periodo),location(doc,now),Number(doc.folios)||0,
    Number(doc.cantidadRegistros??doc.datosOrigen?.cantidad_registros??doc.cantidadFacturas)||0,
    Number(doc.cantidadFacturas)||0,cargo,reqNumbers.get(doc.cajaAsignada)||'',
    fmtDate(sent?(doc.imLiveFechaEnvio||doc.imFechaEnvio||doc.fEnvio):''),'',
    status(doc,now),age(doc,now),sent?delivery||'':'',''];
}
function addCargoSheet(workbook,items,now,reqNumbers){
  const sheet=workbook.addWorksheet('Cargos');
  header(sheet,CARGO_COLUMNS,[14,13,18,14,13,12,17,16,13,16,13,20,26,14,16,22]);
  for(const item of [...items].sort(compareGeneral))
    rowStyle(sheet.addRow(cargoValues(item,now,reqNumbers)),CARGO_COLUMNS.length);
  sheet.autoFilter={from:'A1',to:'P'+Math.max(2,sheet.rowCount)};
}
function addAnnualSheet(workbook,items,now,reqNumbers){
  // Una sola hoja para los años, con las mismas 16 columnas del listado principal.
  const sheet=workbook.addWorksheet('Cargos por Año');
  header(sheet,CARGO_COLUMNS,[14,13,18,14,13,12,17,16,13,16,13,20,26,14,16,22]);
  const firstRowByYear=new Map();
  for(const item of [...items].sort(compareAnnual)){
    const year=String(cargoYear(item.doc));
    const row=sheet.addRow(cargoValues(item,now,reqNumbers));
    rowStyle(row,CARGO_COLUMNS.length);
    if(!firstRowByYear.has(year)){
      firstRowByYear.set(year,row.number);
      const marker=sheet.getCell('Q'+row.number);
      marker.value='Año '+year;
      marker.font={name:'Arial',size:10,bold:true,color:{argb:BLUE}};
    }
  }
  sheet.autoFilter={from:'A1',to:'P'+Math.max(2,sheet.rowCount)};
  return firstRowByYear;
}
function addReqSheet(workbook){
  const sheet=workbook.addWorksheet('Requerimientos');
  header(sheet,REQ_COLUMNS,[16,30,14,13,26,14,13,12,14,16],24);
}
function redHeader(sheet,row,labels){
  labels.forEach((value,i)=>{const cell=sheet.getCell(row,i+2);cell.value=value;style(cell,'red');});
}
export function buildExistenciasReport(docs,now=new Date(),reqs=[]){
  const wb=new ExcelJS.Workbook(),items=selected(docs,now);
  // Navegación mediante enlaces internos, sin pestañas anuales visibles.
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
    ['C4','Requerimientos',"#'Requerimientos'!A1"]
  ]){
    const cell=sheet.getCell(address);
    cell.value={text:label,hyperlink:target};
    cell.font={name:'Arial',size:10,bold:true,color:{argb:BLUE},underline:true};
  }
  const reqNumbers=new Map(reqs.map(r=>[r.id,r.numero]));
  addCargoSheet(wb,items,now,reqNumbers);
  const annualStartRows=addAnnualSheet(wb,items,now,reqNumbers);
  addReqSheet(wb);
  redHeader(sheet,6,['Total Cargos','Enviado a Iron Mountain',
    'En Proceso de Acondicionamiento','Pendientes de Envío IM']);
  sheet.getRow(6).height=34;
  const sent=items.filter(item=>computeDocEstado(item.doc,now).estado==='Enviado a Iron Mountain');
  const process=items.filter(item=>computeDocEstado(item.doc,now).estado==='En Proceso de Acondicionamiento');
  const pending=items.filter(item=>!sent.includes(item)&&!process.includes(item));
  [items,sent,process,pending].forEach((group,i)=>{
    const col='BCDE'[i];const value=sheet.getCell(col+'7');value.value=display(group);style(value);
    value.font={name:'Arial',size:12,bold:true,color:{argb:DARK}};
    const percent=sheet.getCell(col+'8');percent.value=items.length?group.length/items.length:0;
    percent.numFmt='0%';style(percent,'data');
  });
  sheet.getRow(7).height=30;sheet.getRow(8).height=20;
  sheet.getCell('B11').value='Alerta que cuenta sólo lo que está por enviar';
  sheet.getCell('B11').font={name:'Arial',size:11,bold:true,color:{argb:DARK}};
  redHeader(sheet,12,['Cargos por Vencer','Cargos Vencidos']);
  sheet.getRow(12).height=24;
  const expiry=cargoExpiryGroups(docs,now);
  for(const [i,group] of [expiry.upcoming,expiry.overdue].entries()){
    const ids=new Set(group.map(d=>d.id||d.kardex));
    const list=items.filter(x=>ids.has(x.doc.id||x.doc.kardex)),col='BC'[i];
    const value=sheet.getCell(col+'13');value.value=display(list);style(value);
    value.font={name:'Arial',size:12,bold:true,color:{argb:DARK}};
    const percent=sheet.getCell(col+'14');percent.value=items.length?list.length/items.length:0;
    percent.numFmt='0%';style(percent);
  }
  sheet.getRow(13).height=24;
  sheet.getCell('B17').value='Cargos por Período';
  sheet.getCell('B17').font={name:'Arial',size:11,bold:true,color:{argb:DARK}};
  redHeader(sheet,18,['Período','Cantidad de Cargos']);
  const years=[...new Set([...REPORT_YEARS.map(String),...items.map(x=>String(cargoYear(x.doc)))])]
    .sort(compareNumbered);
  for(const [i,year] of years.entries()){
    const row=19+i,group=items.filter(x=>String(cargoYear(x.doc))===year);
    const yearCell=sheet.getCell('B'+row);
    yearCell.value=/^\d{4}$/.test(year)?Number(year):year;
    style(yearCell);
    yearCell.font={name:'Arial',size:12,bold:true,color:{argb:DARK}};
    const count=sheet.getCell('C'+row);
    count.value={text:String(group.length),hyperlink:"#'Cargos por Año'!A"+(annualStartRows.get(year)||1),
      tooltip:'Ver los '+group.length+' cargos de '+year+' en el mismo Excel'};
    style(count);
    count.font={name:'Arial',size:12,bold:true,color:{argb:'FF0563C1'},underline:true};
    sheet.getRow(row).height=15.75;
  }
  const noteRow=Math.max(29,22+years.length);
  sheet.mergeCells('B'+noteRow+':E'+(noteRow+2));
  const note=sheet.getCell('B'+noteRow);
  note.value='Pulsa la cantidad de un año para abrir sus cargos. Pulsa Cargos para ver todos los Kardex, desde el primero hasta el último.';
  note.font={name:'Arial',size:8,italic:true,color:{argb:'FF808080'}};
  note.alignment={wrapText:true,vertical:'middle'};
  for(const target of [wb.getWorksheet('Cargos'),wb.getWorksheet('Cargos por Año'),
    wb.getWorksheet('Requerimientos')]){
    const col=target.name==='Requerimientos'?'K':'Q';
    const back=target.getCell(col+'1');
    back.value={text:'← Resumen',hyperlink:"#'Resumen'!B2"};
    back.font={name:'Arial',size:10,bold:true,color:{argb:BLUE},underline:true};
    target.getColumn(col).width=15;
  }
  return wb;
}
export async function serializeExistenciasReport(workbook){
  const zip=await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const part=zip.file('xl/workbook.xml');
  if(!part)throw new Error('No se pudo preparar la navegación del Excel.');
  const xml=await part.async('string');
  let found=false;
  const updated=xml.replace(/<workbookView\b([^>]*)\/>/,(_,attributes)=>{
    found=true;
    return '<workbookView'+attributes.replace(/\s+showSheetTabs="[^"]*"/,'')+' showSheetTabs="0"/>';
  });
  if(!found)throw new Error('No se pudo ocultar la barra de pestañas del Excel.');
  zip.file('xl/workbook.xml',updated);
  // ExcelJS attaches a relationship marked External even to in-workbook
  // hyperlinks. Emit native OOXML locations without external relationships.
  for(const name of Object.keys(zip.files).filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n))){
    const xml=await zip.file(name).async('string');
    const internal=xml.replace(/<hyperlink\b[^>]*\blocation="#[^"]*"[^>]*\/>/g,tag=>
      tag.replace(/\s+r:id="[^"]*"/,'').replace(/\blocation="#/,'location="'));
    if(internal===xml)continue;
    zip.file(name,internal);
    const rels=name.replace('/worksheets/','/worksheets/_rels/')+'.rels';
    const relPart=zip.file(rels);
    if(relPart){
      const relXml=await relPart.async('string');
      zip.file(rels,relXml.replace(/<Relationship\b(?=[^>]*\bTarget="#)[^>]*\/>/g,''));
    }
  }
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:3}});
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
