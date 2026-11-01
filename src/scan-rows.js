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
export function validateScanRows(input){
  if(!Array.isArray(input)||input.length<1||input.length>SCAN_LIMIT)throw Error('El lote debe contener entre 1 y 500 filas.');
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
export function compareScanRows(ready,sheetRows=[]){
  const existingExact=new Set(),existingCargoCodes=new Map(),within=new Set();
  for(const r of sheetRows){
    if(!Array.isArray(r)||r.length<4)continue;
    const fecha=normalizeDate(r[0])?.iso,cargo=clean(r[1]),grupo=clean(r[2]),codigo=normalizeInvoice(r[3]);
    if(!fecha||!codigo||!cargo)continue;
    existingExact.add([fecha,cargo,grupo,codigo].join('|'));
    const list=existingCargoCodes.get(codigo)||new Set();list.add(fecha+'|'+cargo);existingCargoCodes.set(codigo,list);
  }
  const newRows=[],duplicates=[],otherCargos=[];
  for(const row of ready){
    if(existingExact.has(row.key)||within.has(row.key)){duplicates.push({line:row.line,reason:'La misma factura, cargo, grupo y fecha ya está registrada.'});continue;}
    within.add(row.key);
    const others=existingCargoCodes.get(normalizeInvoice(row.codigo));
    if(others&&[...others].some(x=>x!==row.iso+'|'+row.cargo))otherCargos.push({line:row.line,reason:'Código presente en otro cargo; se conserva la relación legítima.'});
    newRows.push(row);
  }
  return {newRows,duplicates,otherCargos};
}
