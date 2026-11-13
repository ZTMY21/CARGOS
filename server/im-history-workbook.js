import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {checkHeaders,displayExcelDate,writeWorksheetCells} from './workbook-cells.js';

export const IM_HISTORY_FILE_ID='1YKp7q-CPOHI6R7RwJ-ekgrpb5KEIloP9';
export const IM_HISTORY_PARENT_ID='1ShNyHqhO-mD7bWmI-fkPSjR2K0Za4kyo';
export const IM_HISTORY_FILE_NAME='REGISTRO DE FACTURAS ENVIADOS A IRON MOUNTAIN 2.xlsx';

const norm=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/\s+/g,' ').toUpperCase().trim();
const valueText=value=>{
  if(value==null)return '';
  if(value instanceof Date)return value.toISOString().slice(0,10);
  if(typeof value==='object'){
    if('result' in value)return valueText(value.result);
    if('text' in value)return valueText(value.text);
    if(Array.isArray(value.richText))return value.richText.map(e=>valueText(e.text)).join('');
  }
  return String(value).trim();
};
const boxKey=value=>valueText(value).replace(/[^0-9]/g,'');
const dateISO=value=>{
  if(value==null||value==='')return '';
  if(value instanceof Date&&!isNaN(value.getTime()))return value.toISOString().slice(0,10);
  if(typeof value==='number'&&value>30000&&value<90000)
    return new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000).toISOString().slice(0,10);
  const raw=valueText(value);
  if(/^20\d{2}-[01]\d-[0-3]\d$/.test(raw))return raw;
  const m=raw.match(/^([0-3]?\d)\/([01]?\d)\/(20\d{2})$/);
  if(m)return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
  throw Error('IM_HISTORY_DATE_INVALID');
};
const serial=iso=>{
  if(!/^20\d{2}-[01]\d-[0-3]\d$/.test(iso||''))throw Error('IM_HISTORY_DATE_REQUIRED');
  const timestamp=Date.parse(iso+'T00:00:00Z');
  if(Number.isNaN(timestamp)||new Date(timestamp).toISOString().slice(0,10)!==iso)
    throw Error('IM_HISTORY_DATE_INVALID');
  return Math.round((timestamp-Date.UTC(1899,11,30))/86400000);
};
// Las facturas antiguas usan separadores distintos y, a veces, un (A) final.
// El cotejo es por CONJUNTO de cargos, no por su posición ni por ceros iniciales.
function historicalCargoTokens(value){
  const raw=norm(valueText(value)).replace(/[–—]/g,'-');
  const suffix=raw.match(/\(\s*([A-Z])\s*\)\s*$/);
  const content=suffix?raw.slice(0,suffix.index).trim():raw;
  const parts=content.split(/[\s,;/\-]+/).filter(Boolean);
  const result=[];
  for(const part of parts){
    const match=part.match(/^(0*[0-9]{1,7})([A-Z]?)$/);
    if(!match || match[1].length>30)return [];
    result.push(match[1]+(match[2]||suffix?.[1]||''));
  }
  return result;
}

export function normalizedCargoSet(value){
  return [...new Set(historicalCargoTokens(value).map(cargo=>cargo.replace(/^0+(?=\d)/,'')))].sort().join('|');
}

// Some Drive exports qualify shared-string and style elements. Normalize
// only the reader's copy so the actual workbook keeps its original parts.
export async function loadHistoryWorkbook(bytes){
  const zip=await JSZip.loadAsync(bytes);
  let changed=false;
  for(const path of ['xl/sharedStrings.xml','xl/styles.xml']){
    const file=zip.file(path);
    if(!file)continue;
    const xml=await file.async('string');
    if(!xml.includes('xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'))continue;
    zip.file(path,xml.replace(/(<\/?)(?:x:)(?=[A-Za-z])/g,'$1').replace('xmlns:x=','xmlns='));
    changed=true;
  }
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(changed?await zip.generateAsync({type:'nodebuffer'}):bytes);
  return workbook;
}

export async function readHistoryBoxes(bytes){
  const workbook=await loadHistoryWorkbook(bytes);
  const sheet=workbook.getWorksheet('REGISTRO');
  if(!sheet||workbook.worksheets[0]!==sheet)throw Error('IM_HISTORY_SHEET_NOT_FOUND');
  const {byBox}=extractHistory(sheet);
  return [...byBox].flatMap(([clave,entries])=>entries.flatMap(entry=>{
    const row=sheet.getRow(entry.row);
    const codigo=valueText(row.getCell(4).value);
    const cargos=historicalCargoTokens(row.getCell(5).value);
    return cargos.length&&/^[A-Z\s]*[0-9][0-9. _/-]*$/i.test(codigo)
      ? [{clave,codigo,cargos,envio:entry.envio||null}] : [];
  }));
}

function extractHistory(sheet){
  const header=Array.from({length:9},(_,i)=>norm(valueText(sheet.getRow(1).getCell(i+1).value)));
  if(!header[3].includes('CODIGO DE BARRAS')||!header[4].includes('CARGOS')||
     !header[5].includes('FECHA DE ENVIO'))throw Error('IM_HISTORY_HEADERS_CHANGED');
  const byBox=new Map();
  let lastOccupied=1,maxNumber=0;
  for(let r=2;r<=sheet.rowCount;r++){
    const row=sheet.getRow(r);
    const key=boxKey(row.getCell(4).value);
    if(!key)continue;
    lastOccupied=r;
    const number=Number(row.getCell(1).value);
    if(Number.isFinite(number))maxNumber=Math.max(maxNumber,number);
    let envio='';
    try{envio=dateISO(row.getCell(6).value);}catch{/* Fecha antigua no verificada. */}
    const entry={row:r,cargos:normalizedCargoSet(row.getCell(5).value),envio};
    if(!byBox.has(key))byBox.set(key,[]);
    byBox.get(key).push(entry);
  }
  return {byBox,lastOccupied,maxNumber};
}

const movementHeaders={
  J:'FECHA DE SOLICITUD',K:'ÚLTIMO RETORNO A IM',L:'ID DE MOVIMIENTO',M:'CÓDIGO DE CAJA',
  N:'ID DE SOLICITUD',O:'FECHA DE SOLICITUD DEL MOVIMIENTO',P:'FECHA REAL DE RETORNO',
  Q:'PLACA DEL RETORNO',R:'RESPONSABLE DE ENTREGA DEL RETORNO',
  S:'RESPONSABLE DE RECEPCIÓN DEL RETORNO',T:'CARGOS DEL RETORNO'
};

const sheetPath='xl/worksheets/sheet1.xml';
const shipmentRowPattern=row=>new RegExp('<row\\b[^>]*\\br="'+row+'"[^>]*>[\\s\\S]*?<\\/row>');
const showsFullDate=cell=>['d','m','y'].every(part=>cell.numFmt?.toLowerCase().includes(part));

function shipmentFormat(sheet,xml,before){
  for(let row=before-1;row>1;row--){
    if(!boxKey(sheet.getCell('D'+row).value)||
      !['B','F'].every(column=>showsFullDate(sheet.getCell(column+row))))continue;
    const source=xml.match(shipmentRowPattern(row))?.[0];
    if(!source)continue;
    const styles=Object.fromEntries([...source.matchAll(/<c\b[^>]*\br="([A-I])\d+"[^>]*>/g)]
      .map(match=>[match[1],Number(match[0].match(/\bs="(\d+)"/)?.[1]||0)]));
    for(const column of 'ABCDEFGHI')styles[column]??=0;
    const height=source.match(/^<row\b[^>]*>/)?.[0].match(/\s(?:ht|customHeight)="[^"]*"/g)?.join('')||'';
    return {styles,height};
  }
  return null;
}

function applyShipmentHeight(xml,row,height){
  return xml.replace(shipmentRowPattern(row),record=>record.replace(/^<row\b[^>]*>/,head=>
    head.replace(/\s(?:ht|customHeight)="[^"]*"/g,'').replace(/>$/,height+'>')));
}

export async function mergeIronMountainHistory(historyBytes,masterRows){
  if(!Buffer.isBuffer(historyBytes)||!Array.isArray(masterRows))
    throw Error('IM_HISTORY_INVALID_INPUT');
  const workbook=await loadHistoryWorkbook(historyBytes);
  if(workbook.worksheets[0]?.name!=='REGISTRO'||!workbook.getWorksheet('REGISTRO'))
    throw Error('IM_HISTORY_SHEET_NOT_FOUND');
  const sheet=workbook.getWorksheet('REGISTRO');
  const {byBox,lastOccupied,maxNumber}=extractHistory(sheet);
  const pending=[],updates=[],reviews=[],entries=[];
  const processed=new Set(),movements=new Map();
  let movementEnd=1;
  for(let row=2;row<=sheet.rowCount;row++){
    const id=valueText(sheet.getCell('L'+row).value);
    if(id){movements.set(id,row);movementEnd=row;}
  }
  let alreadyRegistered=0;
  const sent=masterRows.filter(row=>row.envio);
  for(const item of sent){
    const key=boxKey(item.caja),newDate=dateISO(item.envio);
    const cargos=normalizedCargoSet((item.cargos||[]).join('-')||item.celda);
    const classification=norm(item.clasificacion);
    if(!key||!cargos||!newDate)throw Error('IM_HISTORY_INCOMPLETE_SHIPMENT');
    const movementKey=item.movementId||key;
    if(processed.has(movementKey))throw Error('IM_HISTORY_DUPLICATED_MASTER_BOX');
    processed.add(movementKey);
    const historical=byBox.get(key)||[];
    const exact=historical.filter(row=>row.cargos && row.cargos===cargos);
    const requested=/\bPOR SOLICITUD\b/.test(classification);
    const newBox=/\bCAJAS? NUEVAS?\b/.test(classification);

    if(requested){
      // Los reenvíos nunca crean filas: código y todos los cargos deben coincidir.
      if(exact.length!==1){
        reviews.push({caja:item.caja,motivo:exact.length?'COINCIDENCIA_AMBIGUA':
          historical.length?'CARGOS_NO_COINCIDEN':'CAJA_NO_ENCONTRADA'});
        continue;
      }
      if(!item.movementId||(!item.masterPrepared&&(!item.requestId||!item.requestDate))){
        if(exact[0].envio===newDate)alreadyRegistered++;
        else reviews.push({caja:item.caja,motivo:'RETORNO_SIN_SOLICITUD_VERIFICADA'});
        continue;
      }
      const prior=movements.get(item.movementId);
      if(prior){
        if(valueText(sheet.getCell('M'+prior).value)!==item.caja ||
           valueText(sheet.getCell('N'+prior).value)!==(item.requestId||'') ||
           dateISO(sheet.getCell('P'+prior).value)!==newDate ||
           dateISO(sheet.getCell('O'+prior).value)!==dateISO(item.requestDate) ||
           valueText(sheet.getCell('Q'+prior).value)!==(item.placa||'') ||
           valueText(sheet.getCell('R'+prior).value)!==(item.entrega||'') ||
           valueText(sheet.getCell('S'+prior).value)!==(item.recibe||''))
          throw Error('IM_HISTORY_RETURN_CONFLICT');
        alreadyRegistered++;continue;
      }
      updates.push({...item,row:exact[0].row,envio:newDate,previous:exact[0].envio,cargos});
      continue;
    }
    if(newBox){
      if(historical.length){
        if(exact.length===1&&exact[0].envio===newDate){alreadyRegistered++;continue;}
        reviews.push({caja:item.caja,motivo:'CAJA_YA_EXISTE_EN_HISTORICO'});
        continue;
      }
      if(!item.preparacion||!item.responsable||!item.celda)
        throw Error('IM_HISTORY_INCOMPLETE_SHIPMENT');
      pending.push(item);
      continue;
    }
    reviews.push({caja:item.caja,motivo:'CLASIFICACION_PENDIENTE_DE_REVISION'});
  }
  if(pending.length+updates.length>500)throw Error('IM_HISTORY_TOO_MANY_WRITES');
  if(lastOccupied+pending.length>50000)throw Error('IM_HISTORY_CAPACITY_EXCEEDED');
  if(!pending.length&&!updates.length)return {
    changed:false,bytes:historyBytes,added:0,updated:0,alreadyRegistered,
    totalSent:sent.length,reviewRequired:reviews.length,reviews,entries:[],updatedEntries:[]
  };

  // Escribir solo sheet1.xml conserva las otras hojas, estilos, fórmulas y relaciones.
  const zip=await JSZip.loadAsync(historyBytes);
  const file=zip.file(sheetPath);
  if(!file)throw Error('IM_HISTORY_WORKSHEET_MISSING');
  let xml=await file.async('string');
  const format=pending.length?shipmentFormat(sheet,xml,lastOccupied+1):null;
  if(updates.length)checkHeaders(sheet,movementHeaders);
  for(const [i,item] of pending.entries()){
    const row=lastOccupied+i+1;
    if(Array.from({length:9},(_,j)=>sheet.getRow(row).getCell(j+1).value)
      .some(value=>value!=null&&value!==''))throw Error('IM_HISTORY_TARGET_ROW_POPULATED');
    xml=writeWorksheetCells(xml,row,{
      A:maxNumber+i+1,B:format?serial(item.preparacion):displayExcelDate(item.preparacion),
      C:item.responsable,D:item.caja,E:item.celda,F:format?serial(item.envio):displayExcelDate(item.envio),
      G:item.entrega||'',H:item.recibe||'',I:item.placa||''
    },format?.styles);
    if(format)xml=applyShipmentHeight(xml,row,format.height);
    entries.push({row,caja:item.caja,fecha_envio:dateISO(item.envio)});
  }
  if(updates.length){
    xml=writeWorksheetCells(xml,1,movementHeaders);
    const latest=new Map();
    for(const item of updates){
      item.logRow=++movementEnd;
      xml=writeWorksheetCells(xml,item.logRow,{
        L:item.movementId,M:item.caja,N:item.requestId||'',O:displayExcelDate(dateISO(item.requestDate)),
        P:displayExcelDate(item.envio),Q:item.placa||'',R:item.entrega||'',S:item.recibe||'',T:item.celda
      });
      const previous=latest.get(item.row)||dateISO(sheet.getCell('K'+item.row).value);
      if(item.envio>=previous){
        latest.set(item.row,item.envio);
        const dates={K:displayExcelDate(item.envio)};
        if(item.requestDate)dates.J=displayExcelDate(dateISO(item.requestDate));
        xml=writeWorksheetCells(xml,item.row,dates);
      }
    }
  }
  zip.file(sheetPath,xml);
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const verify=await loadHistoryWorkbook(bytes);
  if(verify.worksheets.length!==workbook.worksheets.length)
    throw Error('IM_HISTORY_SHEETS_CHANGED');
  const sh=verify.getWorksheet('REGISTRO');
  for(const [index,entry] of entries.entries()){
    const row=sh.getRow(entry.row);
    if(boxKey(row.getCell('D').value)!==boxKey(entry.caja) ||
       dateISO(row.getCell('B').value)!==dateISO(pending[index].preparacion) ||
       dateISO(row.getCell('F').value)!==entry.fecha_envio ||
       (format&&!['B','F'].every(column=>showsFullDate(row.getCell(column)))))
      throw Error('IM_HISTORY_READBACK_FAILED');
  }
  for(const entry of updates){
    const before=sheet.getRow(entry.row),after=sh.getRow(entry.row);
    if(valueText(sh.getCell('L'+entry.logRow).value)!==entry.movementId ||
       dateISO(sh.getCell('P'+entry.logRow).value)!==entry.envio)
      throw Error('IM_HISTORY_RESHIP_READBACK_FAILED');
    for(const col of [1,2,3,4,5,6,7,8,9]){
      if(valueText(after.getCell(col).value)!==valueText(before.getCell(col).value))
        throw Error('IM_HISTORY_RESHIP_UNEXPECTED_CHANGE');
    }
  }
  return {changed:true,bytes,added:entries.length,updated:updates.length,
    alreadyRegistered,totalSent:sent.length,reviewRequired:reviews.length,
    reviews,entries,updatedEntries:updates};
}
