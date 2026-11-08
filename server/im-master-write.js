import JSZip from 'jszip';
import {displayExcelDate} from './workbook-cells.js';
import {readMasterRows} from './im-master-workbook.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const stamp = iso => {
  const d=new Date(iso+'T00:00:00Z');
  if (Number.isNaN(d.getTime())) throw Error('IM_MASTER_DATE_INVALID');
  return Math.round((d.getTime()-Date.UTC(1899,11,30))/86400000);
};
const textCell = (col,row,style,val) => {
  const value=String(val??'');
  return '<c r="'+col+row+'" s="'+style+'" t="inlineStr"><is><t>'+esc(value)+'</t></is></c>';
};
const nCell = (col,row,style,val) =>
  '<c r="'+col+row+'" s="'+style+'"><v>'+Number(val)+'</v></c>';
const emptyCell = (col,row,style) => '<c r="'+col+row+'" s="'+style+'"/>';

export async function appendPreparedBoxToMaster(bytes,box,{preparacion,responsable,minimumBoxes=49}={}) {
  const rows=await readMasterRows(bytes,{minimumBoxes});
  const num=String(box.original_code||box.code||'').replace(/[^0-9]/g,'');
  const existing=rows.find(row=>row.caja.replace(/[^0-9]/g,'')===num);
  const cargos=[...new Set((box.cargos||[]).map(x=>String(x).trim().toUpperCase()))];
  if (!num || !cargos.length || cargos.some(x=>(x.length>30||!/^0*\d{1,7}A?$/.test(x))))
    throw Error('IM_MASTER_INVALID_CONDITIONING');
  if (existing?.receivedOnly) {
    const index=existing.row;
    const zip=await JSZip.loadAsync(bytes);
    const path='xl/worksheets/sheet1.xml';
    const file=zip.file(path);
    if(!file)throw Error('IM_MASTER_STRUCTURE_CHANGED');
    const sheet=await file.async('string');
    const pattern=new RegExp('<row\\b[^>]*\\br="'+index+'"[^>]*>[\\s\\S]*?<\\/row>');
    const original=sheet.match(pattern)?.[0];
    if(!original)throw Error('IM_MASTER_STRUCTURE_CHANGED');
    const cells=new Map([...original.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)]
      .map(match=>[match[1],match[0]]));
    const style=(col,fallback)=>cells.get(col)?.match(/\bs="(\d+)"/)?.[1]||(minimumBoxes===49 ? fallback : 0);
    const dateStyle=style('B',4);
    cells.set('B',Number(dateStyle)>0?nCell('B',index,dateStyle,stamp(preparacion))
      :textCell('B',index,0,displayExcelDate(preparacion)));
    cells.set('C',textCell('C',index,style('C',5),responsable));
    cells.set('E',textCell('E',index,style('E',5),cargos.join('-')));
    cells.set('F',textCell('F',index,style('F',5),box.classification||'Cajas Nuevas'));
    const replacement=original.match(/^<row\b[^>]*>/)[0]+[...cells.keys()].sort().map(col=>cells.get(col)).join('')+'</row>';
    zip.file(path,sheet.replace(original,replacement));
    const result=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
    const next=await readMasterRows(result,{minimumBoxes});
    const verified=next.find(row=>row.row===index);
    if(!verified || verified.receivedOnly || verified.caja!==existing.caja || verified.numero!==existing.numero ||
      verified.celda!==cargos.join('-') || verified.envio || next.length!==rows.length ||
      rows.some((row,i)=>row.row!==index&&JSON.stringify(row)!==JSON.stringify(next[i])))
      throw Error('IM_MASTER_WRITE_NOT_VERIFIED');
    return {bytes:result,rows:next,changed:true};
  }
  if (existing) {
    const sameCargos=existing.cargos.length===cargos.length &&
      existing.cargos.every(cargo=>cargos.includes(cargo));
    if (!sameCargos || existing.clasificacion.toUpperCase().trim() !==
       String(box.classification||'').toUpperCase().trim()) throw Error('IM_MASTER_EXISTING_BOX_CONFLICT');
    return {bytes,rows,changed:false};
  }
  const index=Math.max(...rows.map(row=>row.row))+1;
  if (index>10000) throw Error('IM_MASTER_ROW_LIMIT');
  const number=Math.max(0,...rows.map(row=>Number(row.numero)||0))+1;
  const rowXml='<row r="'+index+'" ht="15.75" customHeight="1">'+
    nCell('A',index,2,number)+nCell('B',index,4,stamp(preparacion))+
    textCell('C',index,5,responsable)+textCell('D',index,5,box.original_code||box.code)+
    textCell('E',index,5,cargos.join('-'))+textCell('F',index,5,box.classification||'Cajas Nuevas')+
    emptyCell('G',index,6)+emptyCell('H',index,5)+emptyCell('I',index,5)+emptyCell('J',index,5)+'</row>';
  const zip=await JSZip.loadAsync(bytes);
  const file=zip.file('xl/worksheets/sheet1.xml');
  const table=zip.file('xl/tables/table1.xml');
  if (!file || !table) throw Error('IM_MASTER_STRUCTURE_CHANGED');
  const sheetXml=await file.async('string');
  const rowPlaceholder=new RegExp('<row\\b[^>]*\\br="'+index+'"[^>]*/>');
  if (!rowPlaceholder.test(sheetXml)) throw Error('IM_MASTER_EXPECTED_EMPTY_ROW_MISSING');
  zip.file('xl/worksheets/sheet1.xml',sheetXml.replace(rowPlaceholder,rowXml));
  const tableXml=await table.async('string');
  const oldRef='ref="A1:J'+(index-1)+'"';
  if (!tableXml.includes(oldRef)) throw Error('IM_MASTER_TABLE_CHANGED');
  zip.file('xl/tables/table1.xml',tableXml.replaceAll(oldRef,'ref="A1:J'+index+'"'));
  const result=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const next=await readMasterRows(result,{minimumBoxes});
  if (next.length!==rows.length+1 || !next.some(row=>row.row===index&&
      row.caja.replace(/[^0-9]/g,'')===num)) throw Error('IM_MASTER_WRITE_NOT_VERIFIED');
  return {bytes:result,rows:next,changed:true};
}
