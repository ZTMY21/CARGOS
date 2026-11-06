import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {mergeIronMountainHistory} from '../server/im-history-workbook.js';

const HEADERS=[
 'N°','FECHA DE PREPARACION DE CAJAS','RESPONSABLE',
 'CODIGO DE BARRAS DE CAJAS','NUMERO DE CARGOS',
 'FECHA DE ENVIO A IRON MOUNTAIN','RESPONSABLE EN ENTREGAR',
 'RESPONSABLE EN RECIBIR DE I. M.','PLACA DE UNIDAD'
];
async function sourceWorkbook(){
  const wb=new ExcelJS.Workbook();
  const sheet=wb.addWorksheet('REGISTRO');
  sheet.addRow(HEADERS);
  sheet.addRow([625,new Date('2025-10-18T00:00:00Z'),'ANTERIOR','T2044084018',
      '0326-0325-0324',new Date('2025-06-27T00:00:00Z'),'','','']);
  const extra=wb.addWorksheet('Hoja1');
  extra.getCell('A1').value='CONSERVAR SEGUNDA HOJA';
  const raw=Buffer.from(await wb.xlsx.writeBuffer());
  const zip=await JSZip.loadAsync(raw);
  const xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  const blank=[3,4,5].map(row=>'<row r="'+row+'">'+
    Array.from({length:26},(_,i)=>'<c r="'+String.fromCharCode(65+i)+row+'" s="0"/>').join('')+
    '</row>').join('');
  zip.file('xl/worksheets/sheet1.xml',xml.replace('</sheetData>',blank+'</sheetData>'));
  return zip.generateAsync({type:'nodebuffer'});
}
const box=(caja,envio,extra={})=>({
  caja,envio,preparacion:'2026-10-30',responsable:'ALEXIS',
  celda:'945-946',entrega:'ENCARGADO',recibe:'IRON MOUNTAIN',placa:'ABC-123',...extra
});
test('registra una caja confirmada, conserva la otra hoja y respeta columnas',async()=>{
  const original=await sourceWorkbook();
  const result=await mergeIronMountainHistory(original,[
    box('T2044084018','2025-06-27',{celda:'0326-0325-0324'}),
    box('T2044202150','2026-11-05'),
    box('T2044202151','')
  ]);
  assert.equal(result.changed,true);
  assert.equal(result.added,1);
  assert.equal(result.alreadyRegistered,1);
  assert.equal(result.entries[0].row,3);
  const wb=new ExcelJS.Workbook();
  await wb.xlsx.load(result.bytes);
  assert.deepEqual(wb.worksheets.map(s=>s.name),['REGISTRO','Hoja1']);
  assert.equal(wb.getWorksheet('Hoja1').getCell('A1').value,'CONSERVAR SEGUNDA HOJA');
  const sh=wb.getWorksheet('REGISTRO');
  assert.equal(sh.getCell('A3').value,626);
  assert.equal(sh.getCell('C3').value,'ALEXIS');
  assert.equal(sh.getCell('D3').value,'T2044202150');
  assert.equal(sh.getCell('E3').value,'945-946');
  assert.equal(sh.getCell('G3').value,'ENCARGADO');
  assert.equal(sh.getCell('H3').value,'IRON MOUNTAIN');
  assert.equal(sh.getCell('I3').value,'ABC-123');
  const again=await mergeIronMountainHistory(result.bytes,[
    box('T2044202150','2026-11-05'),box('T2044202151','')
  ]);
  assert.equal(again.changed,false);
  assert.equal(again.added,0);
  assert.equal(Buffer.compare(again.bytes,result.bytes),0);
});
test('permite otra salida de la misma caja en fecha distinta, pero no duplica una salida',async()=>{
  const first=await mergeIronMountainHistory(await sourceWorkbook(),[
    box('T2044202152','2026-11-05')]);
  const second=await mergeIronMountainHistory(first.bytes,[
    box('P2044202152','2026-11-05'),
    box('T2044202152','2026-11-06')
  ]);
  assert.equal(second.added,1);
  assert.equal(second.alreadyRegistered,1);
  assert.equal(second.entries[0].row,4);
});
test('no altera el archivo cuando falta un dato obligatorio del envío',async()=>{
  const original=await sourceWorkbook();
  await assert.rejects(
    mergeIronMountainHistory(original,[box('T2044202155','2026-11-05',{responsable:''})]),
    /IM_HISTORY_INCOMPLETE_SHIPMENT/
  );
});
