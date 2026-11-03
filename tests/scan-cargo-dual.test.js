import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {readScanWorkbook} from '../src/scan-workbook.js';
import {validateScanRows} from '../src/scan-rows.js';
import {planCargoImport} from '../src/scan-cargo-plan.js';
import {appendMasterCargo,inspectMaster,cargoFingerprint} from '../server/cargo-excel-book.js';

function sourceFile(data,bookSST=false){
  const book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(data),'CARGOS NUEVOS 2026');
  const bytes=XLSX.write(book,{type:'array',bookType:'xlsx',bookSST});
  return new File([bytes],'digitalizacion-2026.xlsx',{
    type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    lastModified:1
  });
}
const head=['Fecha','Cargo','Grupo','Codigo','Archivo_Principal','PDF','Total_Paginas','Tipo','Fuente','Observaciones','ESTADO_REGULARIZADO'];
test('lector selectivo no devuelve filas del 941 aunque estén al inicio de un Excel grande',async()=>{
  const file=sourceFile([head,
    ['30/10/2026',941,1,'01-0FF01-0217573'],
    ['31/10/2026',942,1,'01-0FF01-0217573'],
    ['31/10/2026',943,3,'01-0FF01-0219999']]);
  const r=await readScanWorkbook(file,{minCargo:941});
  assert.equal(r.count,2);
  assert.deepEqual(r.rows.map(x=>x[1]),['942','943']);
  assert.equal(r.rows[0][3],'01-0FF01-0217573');
  const checked=validateScanRows(r.rows,50000);
  const plan=planCargoImport(checked.ready,{original:{cargos:[941]},depurado:{cargos:[941]}});
  assert.deepEqual(plan.cargos.map(x=>[x.cargo,x.count,x.codes]),[[942,1,1],[943,1,1]]);
});
test('lector selectivo resuelve cadena compartida, fechas y encabezados reordenados',async()=>{
  const file=sourceFile([['Código','Cargo','Grupo','Fecha','PDF'],
    ['01-0FF01-0220001',941,1,'30/10/2026','a.pdf'],
    ['01-0FF01-0220002',942,1,'31/10/2026','b.pdf']],true);
  const r=await readScanWorkbook(file,{minCargo:941});
  assert.equal(r.count,1);
  assert.deepEqual(r.rows[0].slice(0,4),['31/10/2026','942','1','01-0FF01-0220002']);
});
test('no reaparece un cargo ya confirmado; un cargo parcial se recupera solo en el segundo libro',()=>{
  const ready=validateScanRows([
    ['30/10/2026','941','1','01-0FF01-0217573'],
    ['31/10/2026','942','1','01-0FF01-0217573']
  ],50000).ready;
  const p=planCargoImport(ready,{original:{cargos:[941,942]},depurado:{cargos:[941]}});
  assert.equal(p.ignoredRows,1);assert.equal(p.cargos.length,1);
  assert.deepEqual(p.cargos[0].missing,{original:false,depurado:true});
});
test('retoma solamente indexación cuando cargo 942 ya fue escrito en los dos libros',()=>{
  const ready=validateScanRows([['31/10/2026','942','1','01-0FF01-0217573']],50000).ready;
  const p=planCargoImport(ready,{original:{cargos:[941,942]},depurado:{cargos:[941,942]},
    indexedLastCargo:941,indexedCargos:[]});
  assert.equal(p.cargos.length,1);
  assert.deepEqual(p.cargos[0].missing,{original:false,depurado:false});
  const indexed=planCargoImport(ready,{original:{cargos:[941,942]},depurado:{cargos:[941,942]},
    indexedLastCargo:942,indexedCargos:[942]});
  assert.equal(indexed.cargos.length,0);
});
test('rechaza saltar correlativo aunque la factura ya esté registrada en un cargo anterior',()=>{
  const ready=validateScanRows([['31/10/2026','944','1','01-0FF01-0217573']],50000).ready;
  assert.throws(()=>planCargoImport(ready,{original:{cargos:[941]},depurado:{cargos:[941]}}),/Falta el cargo 942/);
});
function baseZip({macro}){
  const zip=new JSZip();
  const row=(n,cargo)=>'<row r="'+n+'"><c r="B'+n+'" s="3"><v>'+cargo+'</v></c></row>';
  const xml='<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
    '<dimension ref="A1:K2"/><sheetData>'+row(2,941)+'</sheetData><pageMargins left="0.5"/></worksheet>';
  zip.file('xl/workbook.xml','<workbook><sheets><sheet name="CARGOS NUEVOS 2026"/></sheets></workbook>');
  zip.file('xl/worksheets/sheet1.xml',xml);
  zip.file('xl/worksheets/sheet2.xml','<worksheet><sheetData>DOCUMENTO HISTORICO QUE NO SE TOCA</sheetData></worksheet>');
  zip.file('xl/tables/table1.xml','<table name="TablaConsolidada" ref="A1:K2"><autoFilter ref="A1:K2"/></table>');
  if(macro)zip.file('xl/vbaProject.bin',new Uint8Array([1,2,3,4]));
  return zip.generateAsync({type:'nodebuffer'});
}
test('ambos libros conservan hojas ajenas, macros originales y actualizan solo la tabla 2026',async()=>{
  const records=[
    ['31/10/2026','942','1','01-0FF01-0217573','Documento.jpg','a.pdf','2','Factura','Escáner','',''],
    ['31/10/2026','942','2','01-0FF01-0217573','Documento2.jpg','b.pdf','1','Factura','Escáner','','']
  ];
  for(const target of ['original','depurado']){
    const before=await baseZip({macro:target==='original'});
    const result=await appendMasterCargo(before,target,942,records);
    assert.equal(result.rowsAdded,2);assert.equal(result.lastCargo,942);
    const inspected=await inspectMaster(result.bytes,target);
    assert.equal(inspected.fingerprints[942],cargoFingerprint(records));
    const zipBefore=await JSZip.loadAsync(before),zipAfter=await JSZip.loadAsync(result.bytes);
    assert.equal(await zipBefore.file('xl/worksheets/sheet2.xml').async('string'),
      await zipAfter.file('xl/worksheets/sheet2.xml').async('string'));
    assert.equal(Boolean(zipAfter.file('xl/vbaProject.bin')),target==='original');
    const sheet=await zipAfter.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(sheet,/<dimension ref="A1:K4"/);
    assert.match(sheet,/01-0FF01-0217573/);
    const table=await zipAfter.file('xl/tables/table1.xml').async('string');
    assert.match(table,/<autoFilter ref="A1:K4"/);
    const duplicate=await appendMasterCargo(result.bytes,target,942,records);
    assert.equal(duplicate.alreadyExists,true);
    await assert.rejects(appendMasterCargo(result.bytes,target,944,records),/NO_CORRELATIVO|DATOS_CARGO/);
  }
});
