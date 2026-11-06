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
  cell('B',row,11,serial(item.preparacion),true),
  cell('C',row,9,item.responsable),
  cell('D',row,9,item.caja),
  cell('E',row,9,item.celda),
  cell('F',row,11,serial(item.envio),true),
  cell('G',row,9,item.entrega||''),
  cell('H',row,9,item.recibe||''),
  cell('I',row,9,item.placa||'')
];

function extractHistory(sheet){
  const header=Array.from({length:9},(_,i)=>norm(valueText(sheet.getRow(1).getCell(i+1).value)));
  if(!header[3].includes('CODIGO DE BARRAS')||!header[4].includes('CARGOS')||
     !header[5].includes('FECHA DE ENVIO'))throw Error('IM_HISTORY_HEADERS_CHANGED');
  const existing=new Set();
  let lastOccupied=1,maxNumber=0;
  for(let r=2;r<=sheet.rowCount;r++){
    const row=sheet.getRow(r);
    const key=boxKey(row.getCell(4).value);
    if(!key)continue;
    lastOccupied=r;
    const number=Number(row.getCell(1).value);
    if(Number.isFinite(number))maxNumber=Math.max(maxNumber,number);
    let sent='';
    try{sent=dateISO(row.getCell(6).value);}catch{/* Registro histórico antiguo incompleto. */}
    if(sent)existing.add(key+'|'+sent);
  }
  return {existing,lastOccupied,maxNumber};
}

export async function mergeIronMountainHistory(historyBytes,masterRows){
  if(!Buffer.isBuffer(historyBytes)||!Array.isArray(masterRows))
    throw Error('IM_HISTORY_INVALID_INPUT');
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(historyBytes);
  if(workbook.worksheets[0]?.name!=='REGISTRO'||!workbook.getWorksheet('REGISTRO'))
    throw Error('IM_HISTORY_SHEET_NOT_FOUND');
  const sheet=workbook.getWorksheet('REGISTRO');
  const {existing,lastOccupied,maxNumber}=extractHistory(sheet);
  const pending=[],seen=new Set(existing),sent=masterRows.filter(row=>row.envio);
  for(const row of sent){
    const key=boxKey(row.caja)+'|'+dateISO(row.envio);
    if(!boxKey(row.caja)||!row.preparacion||!row.responsable||!row.celda)
      throw Error('IM_HISTORY_INCOMPLETE_SHIPMENT');
    if(seen.has(key))continue;
    seen.add(key);
    pending.push(row);
  }
  if(!pending.length)return {changed:false,bytes:historyBytes,added:0,alreadyRegistered:sent.length,
    totalSent:sent.length,entries:[]};
  if(pending.length>500)throw Error('IM_HISTORY_TOO_MANY_WRITES');
  if(lastOccupied+pending.length>50000)throw Error('IM_HISTORY_CAPACITY_EXCEEDED');

  const zip=await JSZip.loadAsync(historyBytes);
  const file=zip.file('xl/worksheets/sheet1.xml');
  if(!file)throw Error('IM_HISTORY_WORKSHEET_MISSING');
  let xml=await file.async('string'), addOutside='';
  const entries=[];
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
  return {changed:true,bytes,added:entries.length,alreadyRegistered:sent.length-entries.length,
    totalSent:sent.length,entries};
}
