import ExcelJS from 'exceljs';
import {computeDocEstado, fmtDate, limaDate, monthsBetween} from './rules.js';
import {cargoYear, sourceRecords} from './cargo-details.js';
import {cargoExpiryGroups} from './cargo-expiry.js';

export const REPORT_YEARS = [2023, 2024, 2025, 2026];
export const DETAIL_COLUMNS = ['Fecha','Cargo','Grupo','Codigo','Archivo_Principal','PDF',
  'Total_Paginas','Tipo','Fuente','Observaciones','ESTADO_REGULARIZADO'];
const CARGO_COLUMNS = ['Número de Kardex','Fecha de registro','Tipo de documento','Período contable',
  'Ubicación','Cantidad de folios','Cantidad de registros','Cantidad de códigos','Número de cargo',
  'Fecha de envío','Centro de guía','Estado','Antigüedad en meses','Usuario de registro','Observaciones'];

const code = value => String(value??'').trim().replace(/\.0+$/,'').replace(/^0+(?=\d)/,'').toUpperCase();
const identity = (year, cargo) => `${year}:${code(cargo)}`;
function cargoGroups(docs) {
  const groups=new Map();
  for(const doc of docs) for(const cargo of doc.cargos||[]) {
    if(!code(cargo))continue;
    const key=identity(cargoYear(doc),cargo);
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(doc);
  }
  return groups;
}
function header(sheet,labels) {
  const row=sheet.addRow(labels);row.height=30;
  row.eachCell(cell=>{
    cell.font={name:'Arial',size:10,bold:true,color:{argb:'FFFFFFFF'}};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1F4E78'}};
    cell.alignment={wrapText:true,vertical:'middle'};
  });
  sheet.views=[{state:'frozen',ySplit:1}];
  sheet.autoFilter={from:'A1',to:{row:Math.max(2,sheet.rowCount),column:labels.length}};
}
function reportStatus(doc,now) {
  return computeDocEstado(doc,now).estado==='Enviado a Iron Mountain'?'Enviado':'Pendiente de envío';
}
function reportLocation(doc,now) {
  return reportStatus(doc,now)==='Enviado' || /^(?:Iron Mountain|Aeromontain)$/i.test(doc.ubicacion||'')
    ? 'Aeromontain' : 'Santa Anita';
}
function age(doc,now) {
  const iso=doc.periodo||doc.fechaOrigen||doc.fechaRegistro;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso||''))return '';
  return Math.max(0,monthsBetween(new Date(`${iso}T00:00:00`),new Date(`${limaDate(now)}T00:00:00`)));
}
const display = (n,folios) => `${n} (${folios.toLocaleString('en-US')} folios)`;
const sum = rows => rows.reduce((n,d)=>n+(Number(d.folios)||0),0);

export function buildExistenciasReport(docs,now=new Date(),appUrl='') {
  const wb=new ExcelJS.Workbook();
  const groups=cargoGroups(docs), chosen=[];
  for(const [key,entries] of groups) {
    const doc=entries.find(d=>reportStatus(d,now)==='Enviado')||entries[0];
    chosen.push({key,doc,entries,cargo:(doc.cargos||[]).find(c=>identity(cargoYear(doc),c)===key)});
  }
  chosen.sort((a,b)=>b.key.localeCompare(a.key,'es',{numeric:true}));
  const sheet=wb.addWorksheet('Resumen');sheet.views=[{showGridLines:false}];
  [3,32,32,33,31].forEach((width,i)=>sheet.getColumn(i+1).width=width);
  sheet.getCell('B2').value='Reporte de Existencias — CD Santa Anita';
  sheet.getCell('B2').font={name:'Arial',size:16,bold:true,color:{argb:'FF1F4E78'}};
  sheet.getCell('B3').value=`Actualizado el ${limaDate(now)} · Cifras del aplicativo`;
  ['Total Cargos','Enviado a Aeromontain','En proceso de conocimiento','Pendientes de envío a Aeromontain']
    .forEach((label,i)=>sheet.getCell(6,i+2).value=label);
  const stateOf=item=>computeDocEstado(item.doc,now).estado;
  const sentRows=chosen.filter(item=>stateOf(item)==='Enviado a Iron Mountain');
  const processRows=chosen.filter(item=>stateOf(item)==='En Proceso de Acondicionamiento');
  const pendingRows=chosen.filter(item=>!['Enviado a Iron Mountain','En Proceso de Acondicionamiento'].includes(stateOf(item)));
  const groupsByStatus=[chosen,sentRows,processRows,pendingRows];
  const counts=groupsByStatus.map(group=>group.length),total=chosen.length;
  const last=chosen.length+1;
  for(let i=0;i<4;i++) {
    const col='BCDE'[i],n=counts[i],folios=sum(groupsByStatus[i].map(x=>x.doc));
    const formula=i===0?`COUNTA(Cargos!A2:A${last})&" ("&TEXT(SUM(Cargos!F2:F${last}),"#,##0")&" folios)"`
      :`COUNTIF(Cargos!P2:P${last},"${['','Enviado a Iron Mountain','En Proceso de Acondicionamiento','Pendiente de Envío'][i]}")&" ("&TEXT(SUMIF(Cargos!P2:P${last},"${['','Enviado a Iron Mountain','En Proceso de Acondicionamiento','Pendiente de Envío'][i]}",Cargos!F2:F${last}),"#,##0")&" folios)"`;
    sheet.getCell(`${col}7`).value={formula,result:display(n,folios)};
    sheet.getCell(`${col}8`).value=total?n/total:0;
    sheet.getCell(`${col}8`).numFmt='0%';
  }
  sheet.getCell('B11').value='Alertas de cuentas pendientes';
  sheet.getCell('B12').value='Cargos por vencer';sheet.getCell('C12').value='Cargos vencidos';
  sheet.getCell('D12').value='Cuentas por enviar';
  const unsentRows=[...processRows,...pendingRows];
  sheet.getCell('D13').value=display(unsentRows.length,sum(unsentRows.map(item=>item.doc)));
  sheet.getCell('D14').value=total?unsentRows.length/total:0;
  sheet.getCell('D14').numFmt='0%';
  const expiry=cargoExpiryGroups(docs,now);
  for(const [i,arr] of [expiry.upcoming,expiry.overdue].entries()) {
    const col='BC'[i],unique=new Map();
    for(const doc of arr)for(const cargo of doc.cargos||[])unique.set(identity(cargoYear(doc),cargo),doc);
    const rows=[...unique.values()];sheet.getCell(`${col}13`).value=display(unique.size,sum(rows));
    sheet.getCell(`${col}14`).value=unique.size/Math.max(1,expiry.upcoming.length+expiry.overdue.length);
    sheet.getCell(`${col}14`).numFmt='0%';
  }
  sheet.getCell('B17').value='Cargos por período';
  sheet.getCell('B18').value='Período';sheet.getCell('C18').value='Cantidad de cargos';
  for(const [i,year] of REPORT_YEARS.entries()) {
    const row=i+19,number=chosen.filter(item=>item.key.startsWith(`${year}:`)).length;
    sheet.getCell(`B${row}`).value=year;
    const cell=sheet.getCell(`C${row}`);cell.value=number;
    if(appUrl) {
      cell.value={text:String(number),hyperlink:`${appUrl}?detalleCargo=${year}`};
      cell.font={color:{argb:'FF0563C1'},underline:true,bold:true};
    }
  }
  sheet.getCell('B23').value='Pulsa una cantidad para descargar el detalle de ese año desde el aplicativo.';
  for(const row of [6,12,18])sheet.getRow(row).eachCell(cell=>{
    cell.font={bold:true,color:{argb:'FFFFFFFF'}};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFC00000'}};
    cell.alignment={wrapText:true,vertical:'middle'};
  });
  const cargos=wb.addWorksheet('Cargos');
  [18,18,21,18,17,19,21,19,18,18,16,21,20,21,40,20].forEach((w,i)=>cargos.getColumn(i+1).width=w);
  header(cargos,CARGO_COLUMNS);
  for(const item of chosen) {
    const {doc,entries,cargo}=item,status=reportStatus(doc,now);
    const origin=doc.datosOrigen||{};
    const registerCount=Number(origin.cantidad_registros)||Number(doc.cantidadFacturas)||0;
    const codeCount=Number(doc.cantidadFacturas)||Object.keys(origin.grupos_por_codigo||{}).length||0;
    const sentDate=doc.imLiveFechaEnvio||doc.imFechaEnvio||doc.fEnvio||'';
    const row=cargos.addRow([doc.kardex,fmtDate(doc.fechaOrigen||doc.fechaRegistro),doc.tipoDoc||'',
      fmtDate(doc.periodo),reportLocation(doc,now),Number(doc.folios)||0,registerCount,codeCount,
      cargo,fmtDate(status==='Enviado'?sentDate:''),'',status,age(doc,now),status==='Enviado'?doc.usuario||'':'',doc.obs||'']);
    const operational=computeDocEstado(doc,now).estado;
    row.getCell(16).value=operational==='Enviado a Iron Mountain'||operational==='En Proceso de Acondicionamiento'
      ? operational : 'Pendiente de Envío';
    cargos.getColumn(16).hidden=true;
  }
  wb.addWorksheet('Requerimientos');
  wb.calcProperties.fullCalcOnLoad=true;
  return wb;
}

export async function buildYearDetailReport(docs,year) {
  if(!REPORT_YEARS.includes(Number(year)))throw new Error('Año de cargo fuera del período del reporte.');
  const wb=new ExcelJS.Workbook(),sheet=wb.addWorksheet(`Detalle de Cargo ${year}`);
  DETAIL_COLUMNS.forEach((_,i)=>sheet.getColumn(i+1).width=i===3?28:20);
  header(sheet,DETAIL_COLUMNS);
  const seen=new Set();
  for(const doc of docs) {
    if(cargoYear(doc)!==String(year))continue;
    const rows=await sourceRecords(doc.datosOrigen||{});
    for(const source of rows) {
      const row=DETAIL_COLUMNS.map(name=>source[name]??'');
      if(!row[0]&&doc.fechaOrigen)row[0]=doc.fechaOrigen;
      if(!row[1])row[1]=(doc.cargos||[])[0]||'';
      const key=[code(row[1]),...row.map(v=>String(v??''))].join('\u001f');
      if(seen.has(key))continue;
      seen.add(key);sheet.addRow(row);
    }
    // Older imported cargos without source rows retain their available codes.
    if(!rows.length)for(const raw of String(doc.facturas||'').split(/[,;\n]/).filter(Boolean)) {
      const row=[doc.fechaOrigen||'',(doc.cargos||[])[0]||'','',raw.trim(),'','','','','','',''];
      const key=[code(row[1]),...row].join('\u001f');
      if(!seen.has(key)){seen.add(key);sheet.addRow(row);}
    }
  }
  sheet.autoFilter={from:'A1',to:`K${Math.max(2,sheet.rowCount)}`};
  return wb;
}
