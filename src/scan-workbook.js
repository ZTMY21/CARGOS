import * as XLSX from 'xlsx';
import {readSelectedExcelRows} from './scan-zip-reader.js';
import {SCAN_HEADERS} from './scan-rows.js';
export const SCAN_FILE_ROWS=50000;
export const SCAN_FILE_BYTES=500*1024*1024;
const normalize=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9]/g,'').toLowerCase();
const aliases=[
  ['fecha','fecharegistro','fechaescaneo','fechadigitalizacion'],
  ['cargo','numerocargo','nrocargo','ncargo','correlativocargo'],
  ['grupo','ubicaciongrupo','nrogrupo','numerogrupo'],
  ['codigo','codigofactura','codigodocumento','factura','nrofactura','numerofactura','codigobarras','codigodebarras','facturaguia'],
  ['archivoprincipal','archivo','imagen','archivojpg'],
  ['pdf','archivopdf'],
  ['totalpaginas','paginas','numeropaginas'],
  ['tipo','tipodocumento'],
  ['fuente','tipofuente'],
  ['observaciones','observacion'],
  ['estadoregularizado','regularizado']
];
export function resolveScanHeaders(row){
  const keys=row.map(normalize),result=[];
  for(const group of aliases){
    const at=keys.findIndex(x=>group.includes(x));
    result.push(at);
  }
  return result.slice(0,4).every(index=>index>=0)&&new Set(result.slice(0,4)).size===4?result:null;
}
export async function readScanWorkbook(file,{minCargo=0}={}){
  if(!file||!/\.(xlsx|xlsm)$/i.test(file.name||''))throw Error('Selecciona un archivo Excel .xlsx o .xlsm.');
  if(!Number.isSafeInteger(file.size)||file.size<1||file.size>SCAN_FILE_BYTES)throw Error('El Excel debe pesar entre 1 byte y 500 MB.');
  // File/Blob real: ZIP selectivo; no se extraen ni analizan 2021-2025.
  if(typeof file.slice==='function')return readSelectedExcelRows(file,{minCargo,resolveHeaders:resolveScanHeaders,maxNewRows:SCAN_FILE_ROWS});
  // Compatibilidad con fuentes virtuales de pruebas y cargas antiguas.
  const buffer=await file.arrayBuffer();
  const book=XLSX.read(buffer,{type:'array',cellDates:false,dense:true,bookVBA:false});
  let result=null;
  for(const sheetName of book.SheetNames){
    const grid=XLSX.utils.sheet_to_json(book.Sheets[sheetName],{header:1,defval:'',blankrows:false,raw:false});
    for(let i=0;i<Math.min(25,grid.length);i++){
      const mapping=resolveScanHeaders(grid[i]||[]);
      if(!mapping)continue;
      const rows=[];
      for(let j=i+1;j<grid.length;j++){
        const source=grid[j]||[], record=mapping.map(at=>at<0?'':String(source[at]??'').trim());
        if(record.every(x=>x===''))continue;
        if(Number(record[1])<=minCargo)continue;
        rows.push(record);
        if(rows.length>SCAN_FILE_ROWS)throw Error('Más de '+SCAN_FILE_ROWS.toLocaleString('es-PE')+' filas nuevas; divide el Excel por cargos.');
      }
      // Un Excel totalmente histórico es válido y simplemente no incorpora cargos.
      result={sheetName,fileName:file.name,rows,headers:SCAN_HEADERS,count:rows.length};
      break;
    }
    if(result)break;
  }
  if(!result)throw Error('No se encontró una hoja con Fecha, Cargo, Grupo y Código. No se importó nada.');
  return result;
}
