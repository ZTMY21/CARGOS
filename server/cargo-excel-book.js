import JSZip from 'jszip';
import {createHash} from 'node:crypto';

export const MASTERS=Object.freeze({
  original:{id:'1E4wmCkdei32i6NEcLh4ztQaK8_fOz5u3',name:'Lista de Cargos 2021-2026(2).xlsm',
    mime:'application/vnd.ms-excel.sheet.macroenabled.12'},
  depurado:{id:'16s2rreNgACVhPsckh8-vSFUwWMjcpvwr',name:'Lista_de_Cargos_2021-2026_DEPURADO_2026_SIN_MACROS.xlsx',
    mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
});
const SHEET='xl/worksheets/sheet1.xml',TABLE='xl/tables/table1.xml';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const normalizedCode=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const escapeXml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

const normalizeInputRow=row=>row.map((v,index)=>{
  const value=String(v??'').trim();
  if([1,2,6].includes(index)&&/^\d+$/.test(value))return String(Number(value));
  return index===0?value.replace(/\//g,'-'):value;
});
export function cargoFingerprint(rows){
  return createHash('sha256').update(JSON.stringify(rows.map(normalizeInputRow))).digest('hex');
}
function decodeCellXml(xml){
  const v=xml.match(/<is><t(?:\s[^>]*)?>([\s\S]*?)<\/t><\/is>/)?.[1]??
    xml.match(/<v>([\s\S]*?)<\/v>/)?.[1]??'';
  return v.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}
function rawRowValues(xml,rowNumber){
  return [...'ABCDEFGHIJK'].map(col=>{
    const regex=new RegExp('<c\\b[^>]*r="'+col+rowNumber+'"[^>]*(?:\\/>|>([\\s\\S]*?)<\\/c>)');
    return decodeCellXml(xml.match(regex)?.[1]||'');
  });
}

function extractBook(xml){
  const dimension=xml.match(/<dimension\s+ref="A1:K(\d+)"\s*\/>/);
  if(!dimension)throw Error('CABECERAS_MAESTRAS_INCOMPATIBLES');
  const count=Number(dimension[1]);
  if(count<1||count>1048576)throw Error('RANGO_MAESTRO_INVALIDO');
  const cargoRows=new Map(),codes=new Map(),details=new Map();
  for(const match of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)){
    const rowNumber=Number(match[1]),part=match[2];
    if(rowNumber<2)continue;
    const cargo=Number(part.match(/<c\s+[^>]*r="B\d+"[^>]*><v>(\d+)<\/v><\/c>/)?.[1]);
    if(!Number.isSafeInteger(cargo)||cargo<1)throw Error('CARGO_INVALIDO_EN_MAESTRO');
    cargoRows.set(cargo,(cargoRows.get(cargo)||0)+1);
    if(cargo>=942){
      const rows=details.get(cargo)||[];rows.push(rawRowValues(part,rowNumber));details.set(cargo,rows);
      const code=part.match(/<c\s+[^>]*r="D\d+"[^>]*>(?:<is><t[^>]*>([\s\S]*?)<\/t><\/is>|<v>([^<]*)<\/v>)<\/c>/);
      if(code){
        const set=codes.get(cargo)||new Set();set.add(normalizedCode(code[1]||code[2]));codes.set(cargo,set);
      }
    }
  }
  return {rows:count,cargos:[...cargoRows.keys()].sort((a,b)=>a-b),
    counts:Object.fromEntries(cargoRows),distinctCodes:Object.fromEntries([...codes].map(([n,set])=>[n,set.size])),
    fingerprints:Object.fromEntries([...details].map(([n,rows])=>[n,cargoFingerprint(rows)])),
    lastCargo:Math.max(0,...cargoRows.keys())};
}
export async function inspectMaster(bytes,target){
  if(!MASTERS[target])throw Error('MAESTRO_DESCONOCIDO');
  const zip=await JSZip.loadAsync(bytes);
  const files=[SHEET,TABLE,'xl/workbook.xml'];
  if(files.some(f=>!zip.file(f)))throw Error('ESTRUCTURA_MAESTRA_INVALIDA');
  if(target==='original'&&!zip.file('xl/vbaProject.bin'))throw Error('MACRO_HISTORICA_AUSENTE');
  if(target==='depurado'&&zip.file('xl/vbaProject.bin'))throw Error('DEPURADO_CONTIENE_MACROS');
  const xml=await zip.file(SHEET).async('string'),table=await zip.file(TABLE).async('string');
  const workbook=await zip.file('xl/workbook.xml').async('string');
  if(!workbook.includes('CARGOS NUEVOS 2026'))throw Error('HOJA_2026_NO_IDENTIFICADA');
  const info=extractBook(xml);
  const ref='A1:K'+info.rows;
  if(!table.includes('name="TablaConsolidada"')||!table.includes('ref="'+ref+'"'))
    throw Error('TABLA_MAESTRA_NO_COINCIDE');
  return {zip,xml,table,...info};
}
function cell(column,row,value){
  const r=column+row,v=String(value??'').trim();
  if(!v)return '<c r="'+r+'" s="2"/>';
  if(['B','C','G'].includes(column)&&/^\d+$/.test(v))return '<c r="'+r+'" s="3"><v>'+Number(v)+'</v></c>';
  const text=column==='A'?v.replace(/\//g,'-'):v;
  return '<c r="'+r+'" s="2" t="inlineStr"><is><t xml:space="preserve">'+escapeXml(text)+'</t></is></c>';
}
export async function appendMasterCargo(bytes,target,cargo,rows){
  const info=await inspectMaster(bytes,target);
  if(info.cargos.includes(cargo))return {alreadyExists:true,cargo,rowsAdded:0,originalCount:info.counts[cargo],
    bytes:null,sha256:null,lastCargo:info.lastCargo};
  if(info.lastCargo!==cargo-1)throw Error('CARGO_NO_CORRELATIVO: siguiente '+(info.lastCargo+1));
  if(!Array.isArray(rows)||!rows.length||rows.length>15000||info.rows+rows.length>1048576)
    throw Error('FILAS_CARGO_INVALIDAS');
  if(rows.some(r=>!Array.isArray(r)||r.length!==11||Number(r[1])!==cargo))
    throw Error('DATOS_CARGO_NO_COINCIDEN');
  const append=rows.map((data,index)=>{
    const line=info.rows+1+index;
    return '<row r="'+line+'" spans="1:11">'+[...'ABCDEFGHIJK']
      .map((col,i)=>cell(col,line,data[i])).join('')+'</row>';
  }).join('');
  const after=info.rows+rows.length;
  const oldRef='A1:K'+info.rows,newRef='A1:K'+after;
  let patched=info.xml.replace('<dimension ref="'+oldRef+'"/>','<dimension ref="'+newRef+'"/>');
  if(patched===info.xml)throw Error('DIMENSION_NO_ACTUALIZADA');
  if(patched.split('</sheetData>').length!==2)throw Error('HOJA_MAESTRA_INESPERADA');
  patched=patched.replace('</sheetData>',append+'</sheetData>');
  patched=patched.replaceAll('ref="'+oldRef+'"','ref="'+newRef+'"');
  const table=info.table.replaceAll('ref="'+oldRef+'"','ref="'+newRef+'"');
  if(table===info.table)throw Error('FILTRO_MAESTRO_NO_ACTUALIZADO');
  info.zip.file(SHEET,patched);info.zip.file(TABLE,table);
  const output=await info.zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});
  const check=await inspectMaster(output,target);
  if(check.rows!==after||check.counts[cargo]!==rows.length)throw Error('VERIFICACION_DE_CARGO_FALLIDA');
  return {alreadyExists:false,cargo,rowsAdded:rows.length,bytes:output,sha256:digest(output),
    lastCargo:check.lastCargo,newSize:output.length};
}


/**
 * Reconcile an orphaned latest cargo: it is still present in this Excel master
 * but absent from the already-validated database index. Never replace history.
 * The caller must authorize an administrator, verify DB lastCargo=cargo-1,
 * hold the per-master lease, and back up the exact current Drive revision.
 */
export async function replaceLastMasterCargo(bytes,target,cargo,rows){
  const info=await inspectMaster(bytes,target);
  if(info.lastCargo!==cargo||!info.cargos.includes(cargo))
    throw Error('CORRECCION_SOLO_ULTIMO_CARGO');
  const oldCount=info.counts[cargo];
  if(!Number.isSafeInteger(oldCount)||oldCount<1)
    throw Error('CARGO_ANTERIOR_INCONSISTENTE');
  if(!Array.isArray(rows)||!rows.length||rows.length>15000||
     info.rows-oldCount+rows.length>1048576)
    throw Error('FILAS_CARGO_INVALIDAS');
  if(rows.some(r=>!Array.isArray(r)||r.length!==11||Number(r[1])!==cargo))
    throw Error('DATOS_CARGO_NO_COINCIDEN');

  // Only a contiguous tail containing this same cargo can be replaced.
  const first=info.rows-oldCount+1;
  const start=info.xml.indexOf('<row r="'+first+'"');
  const end=info.xml.indexOf('</sheetData>',start);
  if(start<0||end<0)throw Error('TRAMO_CARGO_NO_IDENTIFICADO');
  const oldTail=info.xml.slice(start,end);
  const existing=[...oldTail.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)];
  if(existing.length!==oldCount)throw Error('TRAMO_CARGO_INCOMPLETO');
  for(let i=0;i<existing.length;i++){
    const num=Number(existing[i][1]);
    const recorded=existing[i][2].match(/<c\s+[^>]*r="B\d+"[^>]*><v>(\d+)<\/v><\/c>/)?.[1];
    if(num!==first+i||Number(recorded)!==cargo)
      throw Error('OTROS_CARGOS_MEZCLADOS_EN_TRAMO');
  }

  const append=rows.map((data,index)=>{
    const line=first+index;
    return '<row r="'+line+'" spans="1:11">'+[...'ABCDEFGHIJK']
      .map((col,i)=>cell(col,line,data[i])).join('')+'</row>';
  }).join('');
  const last=first+rows.length-1;
  const oldRef='A1:K'+info.rows,newRef='A1:K'+last;
  let patched=info.xml.slice(0,start)+append+info.xml.slice(end);
  if(!patched.includes('<dimension ref="'+oldRef+'"/>'))
    throw Error('DIMENSION_NO_ACTUALIZADA');
  patched=patched.replaceAll('ref="'+oldRef+'"','ref="'+newRef+'"');
  const table=info.table.replaceAll('ref="'+oldRef+'"','ref="'+newRef+'"');
  if(table===info.table||!table.includes('ref="'+newRef+'"'))
    throw Error('FILTRO_MAESTRO_NO_ACTUALIZADO');
  info.zip.file(SHEET,patched);info.zip.file(TABLE,table);
  const output=await info.zip.generateAsync({
    type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}
  });
  const check=await inspectMaster(output,target);
  if(check.rows!==last||check.lastCargo!==cargo||
     check.counts[cargo]!==rows.length||
     info.cargos.some(n=>n!==cargo&&check.counts[n]!==info.counts[n]))
    throw Error('VERIFICACION_DE_CORRECCION_FALLIDA');
  return {alreadyExists:false,replaced:true,cargo,rowsAdded:rows.length,
    previousRows:oldCount,bytes:output,sha256:digest(output),
    lastCargo:check.lastCargo,newSize:output.length};
}
