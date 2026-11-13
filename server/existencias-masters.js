import JSZip from 'jszip';
import {posix} from 'node:path';
import {ORIGINAL_COLUMNS, masterDate, reportCargoKey} from '../src/existencias-data.js';

const name2026='CARGOS NUEVOS 2026';
const charEntities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
const decode=value=>value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,(_,entity)=>
  entity[0]==='#'?String.fromCodePoint(entity[1]==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1))):charEntities[entity]);
const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w:.-]+)="([^"]*)"/g)].map(([,k,v])=>[k,decode(v)]));
const spreadsheetText=xml=>[...xml.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g,'')
  .matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match=>decode(match[1])).join('')
  .replace(/_x([0-9a-f]{4})_/gi,(_,n)=>String.fromCharCode(parseInt(n,16)));
const textPart=async(zip,path)=>{
  const file=zip.file(path);
  if(!file)throw Error('El maestro no contiene '+path+'.');
  return file.async('string');
};

export async function readExistenciasMaster(bytes){
  const zip=await JSZip.loadAsync(bytes);
  const book=await textPart(zip,'xl/workbook.xml');
  const rels=await textPart(zip,'xl/_rels/workbook.xml.rels');
  const sheet=[...book.matchAll(/<sheet\b[^>]*>/g)].map(x=>attrs(x[0])).find(x=>x.name===name2026);
  const rel=[...rels.matchAll(/<Relationship\b[^>]*>/g)].map(x=>attrs(x[0])).find(x=>x.Id===sheet?.['r:id']);
  if(!rel?.Target||!rel.Type.endsWith('/worksheet'))throw Error('No se encontró la hoja '+name2026+'.');
  const path=rel.Target.startsWith('/')?rel.Target.slice(1):posix.join('xl',rel.Target);
  const xml=await textPart(zip,path);
  if(!/<\/sheetData>/.test(xml))throw Error('El detalle del maestro está incompleto.');
  const rows=[], required=new Map();
  let previous=0;
  for(const match of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)){
    const position=Number(match[1].match(/(?:^|\s)r="(\d+)"/)?.[1]);
    if(!Number.isSafeInteger(position)||position<=previous)throw Error('Orden de filas inválido en el maestro.');
    previous=position;
    const cells=Array(11).fill('');
    for(const cell of (match[2]||'').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      if(!cell[2])continue;
      const ref=cell[1].match(/(?:^|\s)r="([A-K])(\d+)"/);
      if(!ref)continue;
      if(Number(ref[2])!==position)throw Error('La referencia de una celda no coincide con su fila.');
      const col=ref[1].charCodeAt(0)-65;
      const raw=cell[2].match(/<v>([^<]*)<\/v>/)?.[1];
      const type=cell[1].match(/(?:^|\s)t="([^"]+)"/)?.[1];
      if(type==='s'&&raw!==undefined){
        const index=Number(raw);
        if(!Number.isSafeInteger(index)||index<0)throw Error('Referencia de texto inválida en el maestro.');
        required.set(index,null);
        cells[col]=-index-1;
      }else if(type==='inlineStr')cells[col]=spreadsheetText(cell[2]);
      else if(raw!==undefined){
        if(type==='e')throw Error('Error de Excel en '+ref[1]+position+' del maestro.');
        cells[col]=[1,2].includes(col)&&(!type||type==='n')&&/^\d+(?:\.0+)?$/.test(raw)
          ?Number(raw):decode(raw);
      }else if(/<f\b/.test(cell[2]))throw Error('Fórmula sin valor en '+ref[1]+position+' del maestro.');
    }
    if(cells.some(v=>v!==''))rows.push(cells);
  }
  if(required.size){
    const shared=await textPart(zip,'xl/sharedStrings.xml');
    let index=0,remaining=required.size;
    for(const match of shared.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)){
      if(required.has(index)){
        required.set(index,spreadsheetText(match[1]||''));
        if(--remaining===0)break;
      }
      index++;
    }
    if(remaining)throw Error('Faltan valores en la tabla de textos del maestro.');
    for(const cells of rows)for(let col=0;col<cells.length;col++){
      if(typeof cells[col]==='number'&&cells[col]<0)cells[col]=required.get(-cells[col]-1);
    }
  }
  if(rows.shift()?.some((v,i)=>v!==ORIGINAL_COLUMNS[i])!==false)
    throw Error('Los encabezados A–K del maestro cambiaron.');
  return rows.filter(r=>r.some(v=>v!==''));
}

const integerText=value=>/^\d+(?:\.0+)?$/.test(value)?String(Number(value)):value;
const normalizedRow=row=>row.map((v,i)=>i===0?masterDate(v):[1,2,6].includes(i)?integerText(v):v);

export function reconcileExistenciasMasters(original,clean){
  const counted=new Map();
  for(const row of clean){
    const id=JSON.stringify(normalizedRow(row));
    counted.set(id,(counted.get(id)||0)+1);
  }
  const discrepancies=new Set();
  for(const row of original){
    const id=JSON.stringify(normalizedRow(row));
    const n=counted.get(id)||0;
    if(n===1)counted.delete(id);
    else if(n>1)counted.set(id,n-1);
    else if(row[3].trim())discrepancies.add(reportCargoKey(row[0],row[1]));
  }
  for(const id of counted.keys()){
    const row=JSON.parse(id);
    discrepancies.add(reportCargoKey(row[0],row[1]));
  }
  if(discrepancies.size)throw Error('Los maestros de Drive difieren en '+[...discrepancies].slice(0,10).join(', ')+'. Revisa las filas de esos cargos.');
  if(!original.length)throw Error('La hoja 2026 del maestro no contiene cargos.');
  return original;
}
