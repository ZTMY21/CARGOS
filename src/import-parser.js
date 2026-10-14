import * as XLSX from 'xlsx';
import { parseWorkbook } from './excel.js';
import { parseHistoricalWorkbook } from './historical.js';

export async function parseImport(buffer) {
  const workbook=XLSX.read(buffer,{type:'array',cellDates:false,cellNF:true,dense:true});
  if(workbook.SheetNames.includes('Requerimientos')&&workbook.SheetNames.some(s=>['Cargos','Documentos'].includes(s))) {
    return {...parseWorkbook(buffer),format:'kardex'};
  }
  return parseHistoricalWorkbook(workbook,XLSX);
}
