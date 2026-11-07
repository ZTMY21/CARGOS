import ExcelJS from 'exceljs';
import JSZip from 'jszip';

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
const xmlEscape=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const cell=(name,row,style,value,numeric=false)=>numeric?
  '<c r="'+name+row+'" s="'+style+'"><v>'+Number(value)+'</v></c>':
  '<c r="'+name+row+'" s="'+style+'" t="inlineStr"><is><t>'+xmlEscape(value)+'</t></is></c>';
const newRow=(row,number,item)=>[
  cell('A',row,9,number,true),
  cell('B',row,33,serial(item.preparacion),true),
  cell('C',row,9,item.responsable),
  cell('D',row,9,item.caja),
  cell('E',row,9,item.celda),
  cell('F',row,33,serial(item.envio),true),
  cell('G',row,9,item.entrega||''),
  cell('H',row,9,item.recibe||''),
  cell('I',row,9,item.placa||'')
];


// Las facturas antiguas usan separadores distintos y, a veces, un (A) final.
// El cotejo es por CONJUNTO de cargos, no por su posición ni por ceros iniciales.
export function normalizedCargoSet(value){
  const raw=norm(valueText(value)).replace(/[–—]/g,'-');
  const suffix=raw.match(/\(\s*([A-Z])\s*\)\s*$/);
  const content=suffix?raw.slice(0,suffix.index).trim():raw;
  const parts=content.split(/[\s,;/\-]+/).filter(Boolean);
  if(!parts.length)return '';
  const result=[];
  for(const part of parts){
    const match=part.match(/^0*(\d{1,7})([A-Z]?)$/);
    if(!match)return '';
    result.push(String(Number(match[1]))+(match[2]||suffix?.[1]||''));
  }
  return [...new Set(result)].sort().join('|');
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

// Actualiza exclusivamente la celda F de una fila ya identificada.
// El estilo 33 del libro aprobado es fecha en negro (11 está en rojo y exige revisión).
function updateExistingDate(xml,entry){
  const rowPattern=new RegExp('(<row\\s[^>]*\\br="'+entry.row+'"[^>]*>)([\\s\\S]*?)(<\\/row>)');
  const found=xml.match(rowPattern);
  if(!found)throw Error('IM_HISTORY_RESHIP_ROW_MISSING');
  const cellPattern=new RegExp('<c\\b[^>]*\\br="F'+entry.row+'"[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)');
  if(!cellPattern.test(found[2]))throw Error('IM_HISTORY_RESHIP_DATE_CELL_MISSING');
  const onlyF=found[2].replace(cellPattern,cell('F',entry.row,33,serial(entry.envio),true));
  return xml.replace(rowPattern,found[1]+onlyF+found[3]);
}

export async function mergeIronMountainHistory(historyBytes,masterRows){
  if(!Buffer.isBuffer(historyBytes)||!Array.isArray(masterRows))
    throw Error('IM_HISTORY_INVALID_INPUT');
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(historyBytes);
  if(workbook.worksheets[0]?.name!=='REGISTRO'||!workbook.getWorksheet('REGISTRO'))
    throw Error('IM_HISTORY_SHEET_NOT_FOUND');
  const sheet=workbook.getWorksheet('REGISTRO');
  const {byBox,lastOccupied,maxNumber}=extractHistory(sheet);
  const pending=[],updates=[],reviews=[],entries=[];
  const processed=new Set();
  let alreadyRegistered=0;
  const sent=masterRows.filter(row=>row.envio);
  for(const item of sent){
    const key=boxKey(item.caja),newDate=dateISO(item.envio);
    const cargos=normalizedCargoSet((item.cargos||[]).join('-')||item.celda);
    const classification=norm(item.clasificacion);
    if(!key||!cargos||!newDate)throw Error('IM_HISTORY_INCOMPLETE_SHIPMENT');
    if(processed.has(key))throw Error('IM_HISTORY_DUPLICATED_MASTER_BOX');
    processed.add(key);
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
      if(exact[0].envio===newDate){alreadyRegistered++;continue;}
      updates.push({row:exact[0].row,caja:item.caja,envio:newDate,
        previous:exact[0].envio,cargos});
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
  const file=zip.file('xl/worksheets/sheet1.xml');
  if(!file)throw Error('IM_HISTORY_WORKSHEET_MISSING');
  let xml=await file.async('string'),addOutside='';
  for(const item of updates)xml=updateExistingDate(xml,item);
  for(const [i,item] of pending.entries()){
    const row=lastOccupied+i+1;
    const number=maxNumber+i+1;
    const columns=newRow(row,number,item);
    const rowPattern=new RegExp('(<row\\s[^>]*\\br="'+row+'"[^>]*>)([\\s\\S]*?)(<\\/row>)');
    const found=xml.match(rowPattern);
    if(found){
      let inner=found[2];
      if(/<(?:v|is|f)(?:\s|>)/.test(inner))
        throw Error('IM_HISTORY_TARGET_ROW_POPULATED');
      for(let c=0;c<9;c++){
        const letter=String.fromCharCode(65+c);
        const placeholder=new RegExp('<c\\s+r="'+letter+row+'"[^>]*\\/>');
        if(!placeholder.test(inner))throw Error('IM_HISTORY_PLACEHOLDER_MISSING');
        inner=inner.replace(placeholder,columns[c]);
      }
      xml=xml.replace(rowPattern,found[1]+inner+found[3]);
    }else{
      addOutside+='<row r="'+row+'" ht="13.5" customHeight="1">'+columns.join('')+'</row>';
    }
    entries.push({row,caja:item.caja,fecha_envio:item.envio});
  }
  if(addOutside){
    if(!xml.includes('</sheetData>'))throw Error('IM_HISTORY_SHEETDATA_MISSING');
    xml=xml.replace('</sheetData>',addOutside+'</sheetData>');
  }
  zip.file('xl/worksheets/sheet1.xml',xml);
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const verify=new ExcelJS.Workbook();
  await verify.xlsx.load(bytes);
  if(verify.worksheets.length!==workbook.worksheets.length)
    throw Error('IM_HISTORY_SHEETS_CHANGED');
  const sh=verify.getWorksheet('REGISTRO');
  for(const entry of entries){
    if(boxKey(sh.getRow(entry.row).getCell(4).value)!==boxKey(entry.caja) ||
       dateISO(sh.getRow(entry.row).getCell(6).value)!==entry.fecha_envio)
      throw Error('IM_HISTORY_READBACK_FAILED');
  }
  for(const entry of updates){
    const before=sheet.getRow(entry.row),after=sh.getRow(entry.row);
    if(dateISO(after.getCell(6).value)!==entry.envio)
      throw Error('IM_HISTORY_RESHIP_READBACK_FAILED');
    for(const col of [1,2,3,4,5,7,8,9]){
      if(valueText(after.getCell(col).value)!==valueText(before.getCell(col).value))
        throw Error('IM_HISTORY_RESHIP_UNEXPECTED_CHANGE');
    }
  }
  return {changed:true,bytes,added:entries.length,updated:updates.length,
    alreadyRegistered,totalSent:sent.length,reviewRequired:reviews.length,
    reviews,entries,updatedEntries:updates};
}
