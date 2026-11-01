import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {readScanWorkbook,resolveScanHeaders,SCAN_FILE_ROWS} from '../src/scan-workbook.js';
import {validateScanRows,compareScanRows} from '../src/scan-rows.js';
function workbookFile(lines,name='facturas-semana.xlsx'){
  const wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet(lines);
  XLSX.utils.book_append_sheet(wb,ws,'CARGOS DEL DIA');
  const bytes=XLSX.write(wb,{type:'array',bookType:'xlsx'});
  const data=bytes instanceof ArrayBuffer?new Uint8Array(bytes):new Uint8Array(bytes);
  return {name,size:data.byteLength,lastModified:1,arrayBuffer:async()=>data.slice().buffer};
}
test('reconoce encabezados en el Excel original aunque haya columnas reordenadas',()=>{
  const map=resolveScanHeaders(['Observaciones','Código','Número Cargo','Grupo','Fecha','PDF']);
  assert.deepEqual(map.slice(0,4),[4,2,3,1]);
  assert.equal(map[5],5);
});
test('procesa 3.000 líneas en un único archivo, conserva los ceros y agrupa cargos',async()=>{
  const rows=[['Fecha','Cargo','Grupo','Codigo','Archivo_Principal','PDF','Total_Paginas','Tipo','Fuente','Observaciones','ESTADO_REGULARIZADO']];
  for(let i=0;i<3000;i++)rows.push(['30/10/2026',String(941+Math.floor(i/500)),String(i%14+1),'01-0FF01-'+String(i+1).padStart(7,'0'),'Document_'+i+'.jpg','Scanned_'+i+'.pdf','2','Factura','Escáner','','']);
  const file=workbookFile(rows);
  const result=await readScanWorkbook(file);
  assert.equal(result.count,3000);assert.equal(result.rows[0][3],'01-0FF01-0000001');
  assert.equal(result.rows.at(-1)[1],'946');
  const checked=validateScanRows(result.rows,SCAN_FILE_ROWS);
  assert.equal(checked.errors.length,0);assert.equal(checked.ready.length,3000);
  assert.equal(compareScanRows(checked.ready,[]).newRows.length,3000);
});
test('reconoce columnas esenciales en orden diferente sin inventar campos',async()=>{
  const source=[
    ['Comentario inicial'],
    ['Codigo','Grupo','Cargo','Fecha','Archivo Principal'],
    ['01-0FF01-0000001','8','941','30/10/2026','Document_1.jpg']
  ];
  const result=await readScanWorkbook(workbookFile(source));
  assert.deepEqual(result.rows[0].slice(0,5),['30/10/2026','941','8','01-0FF01-0000001','Document_1.jpg']);
});
test('rechaza Excel sin los encabezados mínimos de cargos nuevos',async()=>{
  await assert.rejects(readScanWorkbook(workbookFile([['Producto','Precio'],['A','1']])),/No se encontró/);
});
test('rechaza documentos sin fecha o con cargo histórico sin modificar datos',async()=>{
  const rows=[['Fecha','Cargo','Grupo','Codigo'],['30/10/2025','932','1','01-0FF01-1111111']];
  const workbook=await readScanWorkbook(workbookFile(rows));
  const validation=validateScanRows(workbook.rows,SCAN_FILE_ROWS);
  assert.equal(validation.errors.length,1);
});
