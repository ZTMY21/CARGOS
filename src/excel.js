import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { computeReqEstado, computeDocEstado, fmtDate, limaDate, REQ_TYPES, DOC_TYPES, LOCATIONS, safeImage } from './rules.js';
function headerStyle(cell, {bg, color}){
  cell.font = {name:'Arial', size:11, bold:true, color:{argb: color}};
  cell.fill = {type:'pattern', pattern:'solid', fgColor:{argb: bg}};
  cell.alignment = {horizontal:'center', vertical:'middle', wrapText:true};
  cell.border = {top:{style:'thin'},bottom:{style:'thin'},left:{style:'thin'},right:{style:'thin'}};
}
function dataCellStyle(cell, opts={}){
  cell.font = {name:'Arial', size:opts.size||11, bold:!!opts.bold, color:{argb: opts.color||'FF1F2937'}};
  cell.alignment = {horizontal:'center', vertical:'middle', wrapText:true};
  cell.border = {top:{style:'thin'},bottom:{style:'thin'},left:{style:'thin'},right:{style:'thin'}};
  if(opts.numFmt) cell.numFmt = opts.numFmt;
}


export function buildWorkbook(reqs, documents, allDocuments = documents, now = new Date()) {
  const lastFiltered = documents.map(d=>({...d,...computeDocEstado(d,now)}));
  const RESUMEN_LAST_ROW = Math.max(1000, lastFiltered.length + 1);
  const cajasUsadas = id => allDocuments.filter(d=>d.cajaAsignada===id).length;
  const reqEstado = r => computeReqEstado(r, allDocuments);
  const wb = new ExcelJS.Workbook();

  // ---------- Hoja Resumen ----------
  const res = wb.addWorksheet('Resumen');
  res.views = [{showGridLines:false}];
  [3,26,26,30,26].forEach((w,i)=> res.getColumn(i+1).width = w);

  res.getCell('B2').value = 'Reporte de Existencias — CD Santa Anita';
  res.getCell('B2').font = {name:'Arial', size:16, bold:true, color:{argb:'FF1F4E78'}};
  res.getCell('B3').value = "Se actualiza automáticamente con los datos de la hoja 'Cargos'";
  res.getCell('B3').font = {name:'Arial', size:10, italic:true, color:{argb:'FF808080'}};

  const t1Headers = ['Total Cargos','Enviado a Iron Mountain','En Proceso de Acondicionamiento','Pendientes de Envío IM'];
  const t1Cols = ['B','C','D','E'];
  t1Headers.forEach((h,i)=>{
    const c = res.getCell(`${t1Cols[i]}6`);
    c.value = h;
    headerStyle(c, {bg:'FFC00000', color:'FFFFFFFF'});
  });
  res.getRow(6).height = 34;

  res.getCell('B7').value = { formula: `COUNTIF(Cargos!A2:A${RESUMEN_LAST_ROW},"<>")&" ("&TEXT(SUM(Cargos!F2:F${RESUMEN_LAST_ROW}),"#,##0")&" folios)"` };
  res.getCell('B8').value = 1;
  res.getCell('C7').value = { formula: `COUNTIF(Cargos!L2:L${RESUMEN_LAST_ROW},"Enviado a Iron Mountain")&" ("&TEXT(SUMIF(Cargos!L2:L${RESUMEN_LAST_ROW},"Enviado a Iron Mountain",Cargos!F2:F${RESUMEN_LAST_ROW}),"#,##0")&" folios)"` };
  res.getCell('C8').value = { formula: `IFERROR(COUNTIF(Cargos!L2:L${RESUMEN_LAST_ROW},"Enviado a Iron Mountain")/COUNTIF(Cargos!A2:A${RESUMEN_LAST_ROW},"<>"),0)` };
  res.getCell('D7').value = { formula: `COUNTIF(Cargos!L2:L${RESUMEN_LAST_ROW},"En Proceso de Acondicionamiento")&" ("&TEXT(SUMIF(Cargos!L2:L${RESUMEN_LAST_ROW},"En Proceso de Acondicionamiento",Cargos!F2:F${RESUMEN_LAST_ROW}),"#,##0")&" folios)"` };
  res.getCell('D8').value = { formula: `IFERROR(COUNTIF(Cargos!L2:L${RESUMEN_LAST_ROW},"En Proceso de Acondicionamiento")/COUNTIF(Cargos!A2:A${RESUMEN_LAST_ROW},"<>"),0)` };
  res.getCell('E7').value = { formula: `COUNTIF(Cargos!L2:L${RESUMEN_LAST_ROW},"Pendiente de Envío")&" ("&TEXT(SUMIF(Cargos!L2:L${RESUMEN_LAST_ROW},"Pendiente de Envío",Cargos!F2:F${RESUMEN_LAST_ROW}),"#,##0")&" folios)"` };
  res.getCell('E8').value = { formula: `IFERROR(COUNTIF(Cargos!L2:L${RESUMEN_LAST_ROW},"Pendiente de Envío")/COUNTIF(Cargos!A2:A${RESUMEN_LAST_ROW},"<>"),0)` };
  t1Cols.forEach(col=>{
    dataCellStyle(res.getCell(`${col}7`), {size:12, bold:true});
    dataCellStyle(res.getCell(`${col}8`), {numFmt:'0%'});
  });
  res.getRow(7).height = 30;

  res.getCell('B11').value = 'Alerta que cuenta sólo lo que está por enviar';
  res.getCell('B11').font = {name:'Arial', size:11, bold:true, color:{argb:'FF1F2937'}};

  const t2Headers = ['Cargos por Vencer','Cargos Vencidos'];
  const t2Cols = ['B','C'];
  t2Headers.forEach((h,i)=>{
    const c = res.getCell(`${t2Cols[i]}12`);
    c.value = h;
    headerStyle(c, {bg:'FFC00000', color:'FFFFFFFF'});
  });
  res.getRow(12).height = 24;

  const baseNoEnviado = `COUNTIFS(Cargos!A2:A${RESUMEN_LAST_ROW},"<>",Cargos!L2:L${RESUMEN_LAST_ROW},"<>Enviado a Iron Mountain")`;
  res.getCell('B13').value = { formula: `COUNTIFS(Cargos!L2:L${RESUMEN_LAST_ROW},"<>Enviado a Iron Mountain",Cargos!M2:M${RESUMEN_LAST_ROW},"<=6")&" ("&TEXT(SUMIFS(Cargos!F2:F${RESUMEN_LAST_ROW},Cargos!L2:L${RESUMEN_LAST_ROW},"<>Enviado a Iron Mountain",Cargos!M2:M${RESUMEN_LAST_ROW},"<=6"),"#,##0")&")"` };
  res.getCell('C13').value = { formula: `COUNTIFS(Cargos!L2:L${RESUMEN_LAST_ROW},"<>Enviado a Iron Mountain",Cargos!M2:M${RESUMEN_LAST_ROW},">6")&" ("&TEXT(SUMIFS(Cargos!F2:F${RESUMEN_LAST_ROW},Cargos!L2:L${RESUMEN_LAST_ROW},"<>Enviado a Iron Mountain",Cargos!M2:M${RESUMEN_LAST_ROW},">6"),"#,##0")&")"` };
  res.getCell('B14').value = { formula: `IFERROR(COUNTIFS(Cargos!L2:L${RESUMEN_LAST_ROW},"<>Enviado a Iron Mountain",Cargos!M2:M${RESUMEN_LAST_ROW},"<=6")/${baseNoEnviado},0)` };
  res.getCell('C14').value = { formula: `IFERROR(COUNTIFS(Cargos!L2:L${RESUMEN_LAST_ROW},"<>Enviado a Iron Mountain",Cargos!M2:M${RESUMEN_LAST_ROW},">6")/${baseNoEnviado},0)` };
  t2Cols.forEach(col=>{
    dataCellStyle(res.getCell(`${col}13`), {size:12, bold:true});
    dataCellStyle(res.getCell(`${col}14`), {numFmt:'0%'});
  });
  res.getRow(13).height = 24;

  // ---------- Cargos por Período (debajo de la tabla de Alerta) ----------
  res.getCell('B17').value = 'Cargos por Período';
  res.getCell('B17').font = {name:'Arial', size:11, bold:true, color:{argb:'FF1F2937'}};
  res.getCell('B18').value = 'Período';
  res.getCell('C18').value = 'Cantidad de Cargos';
  headerStyle(res.getCell('B18'), {bg:'FFC00000', color:'FFFFFFFF'});
  headerStyle(res.getCell('C18'), {bg:'FFC00000', color:'FFFFFFFF'});
  const years = lastFiltered.filter(d=>d.periodo).map(d=>Number(d.periodo.slice(0,4)));
  const anioInicial = Math.min(2023,...years), anioFinal = Math.max(2030,...years);
  for(let y = anioInicial; y <= anioFinal; y++){
    const r = 19 + (y - anioInicial);
    res.getCell(`B${r}`).value = y;
    res.getCell(`C${r}`).value = { formula: `SUMPRODUCT((RIGHT(Cargos!$D$2:$D$${RESUMEN_LAST_ROW},4)="${y}")*1)` };
    dataCellStyle(res.getCell(`B${r}`), {size:12, bold:true});
    dataCellStyle(res.getCell(`C${r}`), {size:12, bold:true});
  }

  res.getCell(`B${19+anioFinal-anioInicial+3}`).value = "Nota: los % de la tabla superior son sobre el Total de Cargos; los % de la tabla de alerta son sobre los cargos que aún no han sido enviados.";
  res.getCell(`B${19+anioFinal-anioInicial+3}`).font = {name:'Arial', size:8, italic:true, color:{argb:'FF808080'}};
  res.getCell(`B${19+anioFinal-anioInicial+3}`).alignment = {wrapText:true};
  res.mergeCells(`B${19+anioFinal-anioInicial+3}:E${19+anioFinal-anioInicial+5}`);

  // ---------- Hoja Cargos (sin Nº de Facturas) ----------
  const cargosHeaders = ['Kardex Nº','Fecha Registro','Tipo de Documento','Período Contable','Ubicación','Cantidad Folios',
    'Nº Cargo','Requerimiento Asignado','Fecha de Envío','Sustento (Guía de Traslado)','Imagen de Sustento','Estado','Antigüedad (Meses)',
    'Usuario Registro','Observaciones'];
  const csheet = wb.addWorksheet('Cargos');
  [14,13,18,14,13,12,12,16,13,20,16,26,14,16,22].forEach((w,i)=> csheet.getColumn(i+1).width = w);
  const cHeaderRow = csheet.getRow(1);
  cargosHeaders.forEach((h,i)=>{ cHeaderRow.getCell(i+1).value = h; headerStyle(cHeaderRow.getCell(i+1), {bg:'FF1F4E78', color:'FFFFFFFF'}); });
  cHeaderRow.height = 30;
  lastFiltered.forEach((d,idx)=>{
    const req = reqs.find(r=>r.id===d.cajaAsignada);
    const row = csheet.getRow(idx+2);
    row.values = [
      d.kardex, fmtDate(d.fechaRegistro), d.tipoDoc||'', fmtDate(d.periodo), d.ubicacion||'',
      Number(d.folios)||0, (d.cargos||[])[0]||'', req?req.numero:'', fmtDate(d.fEnvio), d.sustento||'',
      d.sustentoImagen ? 'Sí (ver en la herramienta)' : 'No',
      d.estado, (typeof d.antiguedad==='number')?d.antiguedad:d.antiguedad, d.usuario||'', d.obs||''
    ];
    row.eachCell(c=> dataCellStyle(c));
  });

  // ---------- Hoja Detalle por Cargo (con Nº de Facturas, primeras columnas centradas) ----------
  const detHeaders = ['Kardex Nº','Fecha Registro','Tipo de Documento','Período Contable','Ubicación','Cantidad Folios',
    'Nº Cargo','Nº de Facturas'];
  const dsheet = wb.addWorksheet('Detalle por Cargo');
  [14,13,18,14,13,12,12,90].forEach((w,i)=> dsheet.getColumn(i+1).width = w);
  const dHeaderRow = dsheet.getRow(1);
  detHeaders.forEach((h,i)=>{ dHeaderRow.getCell(i+1).value = h; headerStyle(dHeaderRow.getCell(i+1), {bg:'FF1F4E78', color:'FFFFFFFF'}); });
  dHeaderRow.height = 30;
  lastFiltered.forEach((d,idx)=>{
    const row = dsheet.getRow(idx+2);
    row.values = [
      d.kardex, fmtDate(d.fechaRegistro), d.tipoDoc||'', fmtDate(d.periodo), d.ubicacion||'',
      Number(d.folios)||0, (d.cargos||[])[0]||'', d.facturas||''
    ];
    row.eachCell((c,colNum)=>{
      dataCellStyle(c);
      if(colNum === 8){
        c.alignment = {horizontal:'left', vertical:'top', wrapText:true};
      }
    });
  });

  // ---------- Hoja Requerimientos ----------
  const reqHeaders = ['Nº Requerimiento','Tipo','Fecha Solicitud','Cantidad Cajas','Números de Cargo',
    'Fecha Recepción','Fecha Devolución','Cajas Usadas','Estado','Usuario'];
  const rsheet = wb.addWorksheet('Requerimientos');
  [16,30,14,13,26,14,14,12,14,16].forEach((w,i)=> rsheet.getColumn(i+1).width = w);
  const rHeaderRow = rsheet.getRow(1);
  reqHeaders.forEach((h,i)=>{ rHeaderRow.getCell(i+1).value = h; headerStyle(rHeaderRow.getCell(i+1), {bg:'FF1F4E78', color:'FFFFFFFF'}); });
  rHeaderRow.height = 24;
  reqs.forEach((r,idx)=>{
    const row = rsheet.getRow(idx+2);
    row.values = [r.numero, r.tipo, fmtDate(r.fechaSolicitud), r.cantidadCajas === '' || r.cantidadCajas == null ? '' : Number(r.cantidadCajas), r.numerosCargo||'',
      fmtDate(r.fechaRecepcion), fmtDate(r.fechaDevolucion), cajasUsadas(r.id), reqEstado(r), r.usuario||''];
    row.eachCell(c=> dataCellStyle(c));
  });


  normalizeSummary(wb, lastFiltered, RESUMEN_LAST_ROW, anioInicial, anioFinal);
  preserveImageData(wb, lastFiltered);
  wb.calcProperties.fullCalcOnLoad = true;
  return wb;
}

// The visible columns keep the original positions: state L, age M.
// Hidden columns retain multi-cargo arrays and JPEGs without Excel's 32,767-character cell limit.
function preserveImageData(wb, docs) {
  const sheet = wb.getWorksheet('Cargos');
  const parts = Math.max(0,...docs.map(d=>Math.ceil((d.sustentoImagen||'').length/32000)));
  sheet.getCell(1,16).value = 'Cargos JSON'; sheet.getColumn(16).hidden = true;
  sheet.getCell(1,17).value = 'Cantidad Cargos'; sheet.getColumn(17).hidden = true;
  for(let i=0;i<parts;i++) {
    sheet.getCell(1,18+i).value = `Sustento Imagen ${i+1}`;
    sheet.getColumn(18+i).hidden = true;
  }
  const origins=docs.map(d=>d.claveOrigen?JSON.stringify({claveOrigen:d.claveOrigen,hojaOrigen:d.hojaOrigen,
    fechaOrigen:d.fechaOrigen,anioOrigen:d.anioOrigen,estadoOrigen:d.estadoOrigen,datosOrigen:d.datosOrigen||{}}):'');
  const originParts=Math.max(0,...origins.map(value=>Math.ceil(value.length/32000)));
  for(let i=0;i<originParts;i++){sheet.getCell(1,18+parts+i).value=`Origen JSON ${i+1}`;sheet.getColumn(18+parts+i).hidden=true;}
  docs.forEach((d,index)=>{
    const row = sheet.getRow(index+2), image = d.sustentoImagen||'';
    for(let i=0;i<originParts;i++)row.getCell(18+parts+i).value=origins[index].slice(i*32000,(i+1)*32000);
    row.getCell(16).value = JSON.stringify(d.cargos||[]);
    row.getCell(17).value = (d.cargos||[]).length;
    for(let i=0;i<parts;i++) row.getCell(18+i).value = image.slice(i*32000,(i+1)*32000);
  });
}
function normalizeSummary(wb, docs, last, firstYear, lastYear) {
  const res = wb.getWorksheet('Resumen');
  const a=`Cargos!A2:A${last}`, f=`Cargos!F2:F${last}`, l=`Cargos!L2:L${last}`,
    m=`Cargos!M2:M${last}`, q=`Cargos!Q2:Q${last}`, d=`Cargos!D2:D${last}`;
  const cargos = arr=>arr.reduce((sum,x)=>sum+(x.cargos||[]).length,0);
  const folios = arr=>arr.reduce((sum,x)=>sum+(Number(x.folios)||0),0);
  const display = arr=>`${cargos(arr)} (${folios(arr).toLocaleString('en-US')} folios)`;
  const cached = (cell,formula,result)=>{res.getCell(cell).value={formula,result};};
  const total = cargos(docs);
  cached('B7',`IF(COUNTIF(${a},"<>")=0,"0 (0 folios)",SUM(${q})&" ("&TEXT(SUM(${f}),"#,##0")&" folios)")`,display(docs));
  res.getCell('B8').value = total ? 1 : 0;
  const states=['Enviado a Iron Mountain','En Proceso de Acondicionamiento','Pendiente de Envío'];
  ['C','D','E'].forEach((col,index)=>{
    const state=states[index], group=docs.filter(x=>x.estado===state);
    cached(`${col}7`,`SUMIF(${l},"${state}",${q})&" ("&TEXT(SUMIF(${l},"${state}",${f}),"#,##0")&" folios)"`,display(group));
    cached(`${col}8`,`IFERROR(SUMIF(${l},"${state}",${q})/SUM(${q}),0)`,total?cargos(group)/total:0);
  });
  const noSent=docs.filter(x=>x.estado!==states[0] && typeof x.antiguedad==='number');
  const base=cargos(noSent);
  ['B','C'].forEach((col,index)=>{
    const op=index?'>6':'<=6', group=noSent.filter(x=>index?x.antiguedad>6:x.antiguedad<=6);
    const count=`IF(COUNTIFS(${a},"<>",${l},"<>${states[0]}",${m},"${op}")=0,0,SUMPRODUCT((${a}<>"")*(${l}<>"${states[0]}")*ISNUMBER(${m})*(${m}${op})*${q}))`;
    const denominator=`SUMPRODUCT((${a}<>"")*(${l}<>"${states[0]}")*ISNUMBER(${m})*${q})`;
    cached(`${col}13`,`${count}&" ("&TEXT(SUMIFS(${f},${a},"<>",${l},"<>${states[0]}",${m},"${op}"),"#,##0")&" folios)"`,display(group));
    cached(`${col}14`,`IFERROR(${count}/${denominator},0)`,base?cargos(group)/base:0);
  });
  for(let year=firstYear;year<=lastYear;year++) {
    const group=docs.filter(x=>x.periodo?.startsWith(`${year}-`));
    cached(`C${19+year-firstYear}`,`SUMPRODUCT((RIGHT(${d},4)="${year}")*${q})`,cargos(group));
  }
}

function text(value) { return String(value??'').trim(); }
function excelDate(value,label,required=false) {
  if(value===undefined || value===null || value==='') {
    if(required) throw new Error(`Falta ${label}.`);
    return '';
  }
  let date;
  if(value instanceof Date) date=`${value.getUTCFullYear()}-${String(value.getUTCMonth()+1).padStart(2,'0')}-${String(value.getUTCDate()).padStart(2,'0')}`;
  else if(typeof value==='number') {
    const parsed=XLSX.SSF.parse_date_code(value);
    if(parsed) date=`${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`;
  } else {
    const input=text(value);
    if(/^\d{4}-\d{2}-\d{2}$/.test(input)) date=input;
    else {
      const match=input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if(match) date=`${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
    }
  }
  if(!date || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date) throw new Error(`${label}: fecha no válida.`);
  return date;
}
function count(value,label,required=false) {
  if(value===undefined||value===null||value==='') {
    if(required) throw new Error(`Falta ${label}.`);
    return '';
  }
  const n=Number(value);
  if(!Number.isInteger(n)||n<0||n>2147483647) throw new Error(`${label}: usa un entero desde cero.`);
  return n;
}
function requiredText(value,label) {
  const v=text(value); if(!v) throw new Error(`Falta ${label}.`); return v;
}
function choice(value,choices,fallback,label) {
  const v=text(value)||fallback;
  if(!choices.includes(v)) throw new Error(`${label}: valor no reconocido "${v}".`);
  return v;
}
function uniqueCode(value,prefix,seen,label) {
  const v=requiredText(value,label);
  if(!new RegExp(`^${prefix}-[0-9]{5,15}$`).test(v)) throw new Error(`${label}: correlativo inválido "${v}".`);
  if(seen.has(v)) throw new Error(`${label}: correlativo duplicado "${v}".`);
  seen.add(v); return v;
}
function rowsFor(wb,sheet,mandatoryHeaders) {
  const raw=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,defval:''});
  if(!raw.length || mandatoryHeaders.some(h=>!raw[0].includes(h))) throw new Error(`La hoja ${sheet} no tiene los encabezados requeridos.`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet],{defval:''});
}
export function parseWorkbook(buffer) {
  const workbook=XLSX.read(buffer,{type:'array'});
  const docSheet=workbook.SheetNames.includes('Cargos')?'Cargos':workbook.SheetNames.includes('Documentos')?'Documentos':null;
  if(!docSheet || !workbook.SheetNames.includes('Requerimientos')) {
    throw new Error('El archivo debe contener Cargos (o Documentos) y Requerimientos. No se modificó la base de datos.');
  }
  const seenReq=new Set(), seenDoc=new Set();
  const reqs=rowsFor(workbook,'Requerimientos',['Nº Requerimiento','Tipo','Fecha Solicitud','Usuario'])
    .filter(row=>text(row['Nº Requerimiento'])).map((row,index)=>{
      const label=`Requerimientos, fila ${index+2}`;
      const tipo=choice(row.Tipo,REQ_TYPES,REQ_TYPES[0],label);
      return {
        id:crypto.randomUUID(), numero:uniqueCode(row['Nº Requerimiento'],'REQ',seenReq,label),tipo,
        fechaSolicitud:excelDate(row['Fecha Solicitud'],`${label}, Fecha Solicitud`,true),
        cantidadCajas:count(row['Cantidad Cajas'],`${label}, Cantidad Cajas`,tipo===REQ_TYPES[0]),
        numerosCargo:tipo===REQ_TYPES[0]?text(row['Números de Cargo']):requiredText(row['Números de Cargo'],`${label}, Números de Cargo`),
        fechaRecepcion:excelDate(row['Fecha Recepción'],`${label}, Fecha Recepción`),
        fechaDevolucion:excelDate(row['Fecha Devolución'],`${label}, Fecha Devolución`),
        usuario:requiredText(row.Usuario,`${label}, Usuario`)
      };
    });
  const reqIds=new Map(reqs.map(r=>[r.numero,r.id]));
  const facturas=new Map();
  if(workbook.SheetNames.includes('Detalle por Cargo')) {
    rowsFor(workbook,'Detalle por Cargo',['Kardex Nº','Nº de Facturas']).forEach(row=>{
      const kardex=text(row['Kardex Nº']);
      const parts=Object.keys(row).filter(k=>/^Facturas completas \d+$/.test(k))
        .sort((a,b)=>Number(a.split(' ').at(-1))-Number(b.split(' ').at(-1)));
      const invoices=parts.length?parts.map(k=>String(row[k]||'')).join(''):text(row['Nº de Facturas']);
      if(kardex&&invoices)facturas.set(kardex,[facturas.get(kardex),invoices].filter(Boolean).join(', '));
    });
  }
  const docs=rowsFor(workbook,docSheet,['Kardex Nº','Período Contable','Usuario Registro'])
    .filter(row=>text(row['Kardex Nº'])).map((row,index)=>{
      const label=`${docSheet}, fila ${index+2}`;
      const originKeys=Object.keys(row).filter(k=>/^Origen JSON \d+$/.test(k)).sort((a,b)=>Number(a.split(' ').at(-1))-Number(b.split(' ').at(-1)));
      const originString=originKeys.map(k=>String(row[k]||'')).join('');
      let origin={};
      if(originString){try{origin=JSON.parse(originString);}catch{throw new Error(`${label}: datos de origen inválidos.`);}}
      const fromHistory=!!origin.claveOrigen;
      const kardex=uniqueCode(row['Kardex Nº'],'SA',seenDoc,label);
      const assigned=text(row['Requerimiento Asignado']);
      if(assigned && !reqIds.has(assigned)) throw new Error(`${label}: el requerimiento ${assigned} no existe en la hoja Requerimientos.`);
      let cargos=text(row['Nº Cargo']).split(/[,;\n]/).map(s=>s.trim()).filter(Boolean);
      if(row['Cargos JSON']) {
        try { cargos=JSON.parse(row['Cargos JSON']); } catch { throw new Error(`${label}: Cargos JSON no válido.`); }
        if(!Array.isArray(cargos)||cargos.some(c=>typeof c!=='string')) throw new Error(`${label}: Cargos JSON debe ser un arreglo de textos.`);
      }
      const keys=Object.keys(row).filter(k=>/^Sustento Imagen \d+$/.test(k)).sort((a,b)=>Number(a.split(' ').at(-1))-Number(b.split(' ').at(-1)));
      const image=keys.map(k=>String(row[k]||'')).join('');
      if(image && !safeImage(image)) throw new Error(`${label}: imagen de sustento no válida.`);
      return {
        id:crypto.randomUUID(),kardex,fechaRegistro:excelDate(row['Fecha Registro'],`${label}, Fecha Registro`)||limaDate(),
        tipoDoc:choice(row['Tipo de Documento'],DOC_TYPES,DOC_TYPES[0],label),
        periodo:excelDate(row['Período Contable'],`${label}, Período Contable`,!fromHistory),
        ubicacion:fromHistory&&!text(row.Ubicación)?'':choice(row.Ubicación,LOCATIONS,LOCATIONS[0],label),
        folios:count(row['Cantidad Folios'],`${label}, Cantidad Folios`),cargos,
        cajaAsignada:assigned?reqIds.get(assigned):'',fEnvio:excelDate(row['Fecha de Envío'],`${label}, Fecha de Envío`),
        sustento:text(row['Sustento (Guía de Traslado)']),sustentoImagen:image,
        usuario:requiredText(row['Usuario Registro'],`${label}, Usuario Registro`),
        facturas:facturas.get(kardex)||text(row['Nº de Facturas']),obs:text(row.Observaciones),...origin
      };
    });
  if(!reqs.length&&!docs.length) throw new Error('El archivo no contiene registros. Usa Restablecer datos si deseas borrar la base compartida.');
  return {reqs,docs};
}
