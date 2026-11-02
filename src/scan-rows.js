// Funciones puras para carga de facturas escaneadas. No cambia ni sustituye el histórico.
export const SCAN_SHEET_ID='18TbKWiVUWKfkJOXvR0kGEMb5eVKTDCfoXAUtD5rCxts';
export const SCAN_HEADERS=['Fecha','Cargo','Grupo','Codigo','Archivo_Principal','PDF','Total_Paginas','Tipo','Fuente','Observaciones','ESTADO_REGULARIZADO'];
export const SCAN_LIMIT=500;
const clean=value=>String(value??'').trim();
export function normalizeInvoice(value){
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
}
export function normalizeDate(input){
  const value=clean(input),m=/^(\d{2})[\/-](\d{2})[\/-](20\d{2})$/.exec(value),n=/^(20\d{2})-(\d{2})-(\d{2})$/.exec(value);
  if(!m&&!n)return null;
  const yyyy=m?m[3]:n[1],mm=m?m[2]:n[2],dd=m?m[1]:n[3];
  const date=new Date(yyyy+'-'+mm+'-'+dd+'T00:00:00Z');
  if(Number.isNaN(+date)||date.toISOString().slice(0,10)!==yyyy+'-'+mm+'-'+dd)return null;
  return {iso:yyyy+'-'+mm+'-'+dd,display:dd+'/'+mm+'/'+yyyy};
}
function header(row){
  return clean(row[0]).toLowerCase()==='fecha'&&clean(row[1]).toLowerCase()==='cargo'&&clean(row[2]).toLowerCase()==='grupo'&&/c[oó]digo/i.test(clean(row[3]));
}
export function parseScanPaste(input){
  if(typeof input!=='string'||input.length>450000)throw Error('El texto es demasiado grande (máximo 450 KB).');
  const delimiter=input.includes('\t')?'\t':';';
  const lines=input.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim()!=='');
  if(lines.length>SCAN_LIMIT+1)throw Error('Carga máxima: 500 filas por lote.');
  const cells=lines.map(line=>line.split(delimiter));
  if(cells.length&&header(cells[0]))cells.shift();
  if(!cells.length)throw Error('Pega al menos una factura.');
  return cells;
}
export function validateScanRows(input,maxRows=SCAN_LIMIT){
  if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>10000)throw Error('Límite de carga incorrecto.');
  if(!Array.isArray(input)||input.length<1||input.length>maxRows)throw Error('El lote debe contener entre 1 y '+maxRows.toLocaleString('es-PE')+' filas.');
  const ready=[],errors=[];
  input.forEach((raw,index)=>{
    const row=Array.isArray(raw)?raw.map(clean):[];
    const line=index+1;
    if(row.length<4||row.length>14){errors.push({line,reason:'Se esperan 4 a 11 columnas de datos (o 14 con estados técnicos).'});return;}
    const [fecha,cargo,grupo,codigo]=row,parsed=normalizeDate(fecha);
    if(!parsed){errors.push({line,reason:'Fecha inválida: use dd/mm/aaaa.'});return;}
    if(Number(parsed.iso.slice(0,4))<2026){errors.push({line,reason:'No modificar cargos históricos anteriores a 2026.'});return;}
    if(!/^\d{1,7}A?$/.test(cargo)||(parsed.iso.startsWith('2026')&&Number(cargo.replace(/A$/,''))<933)){
      errors.push({line,reason:'Cargo inválido o reservado para el histórico.'});return;
    }
    if(grupo.length>30||!/^[\p{L}\p{N} ._/-]*$/u.test(grupo)){errors.push({line,reason:'Grupo inválido.'});return;}
    if(!codigo||codigo.length>150||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(codigo)){errors.push({line,reason:'Código de factura/guía inválido.'});return;}
    const payload=Array.from({length:11},(_,i)=>row[i]??'');
    if(payload.some((cell,i)=>cell.length>(i===4||i===5?300:200)||/^[=+@\t\r\n]/.test(cell))){errors.push({line,reason:'Valor no permitido o demasiado largo.'});return;}
    payload[0]=parsed.display;
    ready.push({line,iso:parsed.iso,cargo,grupo,codigo,values:payload,key:[parsed.iso,cargo,grupo,normalizeInvoice(codigo)].join('|'),
      cargoCode:[parsed.iso,cargo,normalizeInvoice(codigo)].join('|')});
  });
  return {ready,errors};
}
// Una factura puede tener varios archivos digitalizados. La identidad incluye el
// archivo; el cargo/código por sí solos NO son una clave única.
const coreKey=values=>{
  const date=normalizeDate(values[0])?.iso||'';
  return [date,clean(values[1]),clean(values[2]),normalizeInvoice(values[3])].join('|');
};
const asset=value=>clean(value).toLocaleLowerCase('es-PE');
function sameDocument(a,b){
  return (asset(a[4])!=='' && asset(a[4])===asset(b[4]))
    || (asset(a[5])!=='' && asset(a[5])===asset(b[5]));
}
function hasAsset(v){return !!(asset(v[4])||asset(v[5]));}
function distinctDocument(a,b){
  // Solo se reconoce un segundo documento cuando ambos tienen archivo principal
  // explícito y diferente. Un PDF cambiado de un mismo JPG no crea otra factura.
  return !!(asset(a[4])&&asset(b[4])&&asset(a[4])!==asset(b[4])
    && (!asset(a[5])||!asset(b[5])||asset(a[5])!==asset(b[5])));
}
function differences(oldValues,newValues){
  const patches=[],conflicting=[];
  for(let i=4;i<SCAN_HEADERS.length;i++){
    const before=clean(oldValues[i]),after=clean(newValues[i]);
    if(!after||before===after)continue; // Nunca borrar datos ni reescribir iguales.
    if(before)conflicting.push({column:i,field:SCAN_HEADERS[i],from:before,to:after});
    else patches.push({column:i,field:SCAN_HEADERS[i],from:'',to:after});
  }
  return {patches,conflicting};
}
/**
 * Clasifica sin modificar datos. sheetRows representa las filas A:K a partir de
 * la segunda fila; los números son absolutos para una actualización puntual.
 * No se borran repetidos legítimos con distinto archivo digitalizado.
 * Nota: es indispensable contrastar también el histórico ANTES de confirmar.
 */
export function compareScanRows(ready,sheetRows=[]){
  const existing=[],byCore=new Map(),byCode=new Map();
  for(let i=0;i<sheetRows.length;i++){
    const raw=sheetRows[i];
    if(!Array.isArray(raw)||raw.length<4||!normalizeDate(raw[0]))continue;
    const values=Array.from({length:SCAN_HEADERS.length},(_,c)=>clean(raw[c]));
    const key=coreKey(values);
    if(!clean(values[1])||!normalizeInvoice(values[3]))continue;
    const item={values,rowNumber:i+2,key};
    existing.push(item);
    if(!byCore.has(key))byCore.set(key,[]);
    byCore.get(key).push(item);
    const code=normalizeInvoice(values[3]);
    if(!byCode.has(code))byCode.set(code,new Set());
    byCode.get(code).add(normalizeDate(values[0]).iso+'|'+values[1]);
  }
  // Conciliación dentro del Excel antes de compararlo con la hoja de destino.
  const local=[],localByCore=new Map(),duplicates=[],conflicts=[];
  for(const row of ready){
    const values=Array.from({length:SCAN_HEADERS.length},(_,i)=>clean(row.values[i]));
    const key=coreKey(values),group=localByCore.get(key)||[];
    const matches=group.filter(x=>sameDocument(x.values,values));
    if(matches.length>1){
      conflicts.push({line:row.line,reason:'Archivo coincidente con varios registros del mismo Excel; revisar.'});
      matches.forEach(x=>{x.blocked=true;});continue;
    }
    if(matches.length===1){
      const match=matches[0],delta=differences(match.values,values);
      if(delta.conflicting.length){
        match.blocked=true;
        conflicts.push({line:row.line,reason:'El mismo documento tiene valores diferentes dentro del Excel.',fields:delta.conflicting});
      }else{
        for(const patch of delta.patches)match.values[patch.column]=patch.to;
        duplicates.push({line:row.line,reason:delta.patches.length?'Se complementó el registro del mismo Excel.':'Registro idéntico en el mismo Excel.'});
      }
      continue;
    }
    // Con nombres ausentes no es posible afirmar que se trata de otro archivo.
    if(group.some(x=>!hasAsset(x.values)||!hasAsset(values))){
      group.forEach(x=>{x.blocked=true;});
      conflicts.push({line:row.line,reason:'No se puede diferenciar el documento: faltan nombres de archivo.'});
      continue;
    }
    const item={...row,values,key};
    local.push(item);group.push(item);localByCore.set(key,group);
  }
  const newRows=[],updates=[],otherCargos=[];
  for(const row of local){
    if(row.blocked)continue;
    const group=byCore.get(row.key)||[];
    const matches=group.filter(x=>sameDocument(x.values,row.values));
    const blanks=group.filter(x=>!hasAsset(x.values));
    let match;
    if(matches.length===1)match=matches[0];
    else if(matches.length>1){
      conflicts.push({line:row.line,reason:'El documento coincide con múltiples filas existentes.'});continue;
    }else if(blanks.length===1&&group.length===1)match=blanks[0];
    else if(group.length===1&&!hasAsset(row.values))match=group[0];
    else if(blanks.length||group.some(x=>!hasAsset(row.values)||!distinctDocument(x.values,row.values))){
      conflicts.push({line:row.line,reason:'El mismo cargo/código tiene archivos no identificables o incompatibles; requiere revisión.'});continue;
    }
    if(match){
      const delta=differences(match.values,row.values);
      if(delta.conflicting.length){
        conflicts.push({line:row.line,rowNumber:match.rowNumber,reason:'Hay valores distintos en celdas ya ocupadas; no se sobrescriben.',fields:delta.conflicting});
      }else if(delta.patches.length){
        updates.push({line:row.line,rowNumber:match.rowNumber,key:row.key,patches:delta.patches});
      }else{
        duplicates.push({line:row.line,rowNumber:match.rowNumber,reason:'El documento y sus valores ya están registrados.'});
      }
      continue;
    }
    const others=byCode.get(normalizeInvoice(row.values[3]));
    const place=normalizeDate(row.values[0]).iso+'|'+row.values[1];
    if(others&&[...others].some(x=>x!==place))
      otherCargos.push({line:row.line,reason:'Código en otro cargo; se conserva como relación legítima.'});
    newRows.push(row);
  }
  return {newRows,updates,duplicates,conflicts,otherCargos};
}
