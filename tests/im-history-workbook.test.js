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
  celda:'945-946',clasificacion:'Cajas Nuevas',entrega:'ENCARGADO',recibe:'IRON MOUNTAIN',placa:'ABC-123',...extra
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

test('reenvío por solicitud modifica solo fecha F y no agrega un nuevo correlativo',async()=>{
  const original=await sourceWorkbook();
  const data=[box('P2044084018','2026-11-05',{
    clasificacion:'POR SOLICITUD',celda:'0324-0325-0326'
  })];
  const first=await mergeIronMountainHistory(original,data);
  assert.equal(first.added,0);
  assert.equal(first.updated,1);
  assert.equal(first.reviewRequired,0);
  assert.deepEqual(first.updatedEntries.map(x=>x.row),[2]);
  const before=new ExcelJS.Workbook(),after=new ExcelJS.Workbook();
  await before.xlsx.load(original);await after.xlsx.load(first.bytes);
  assert.equal(after.getWorksheet('REGISTRO').getRow(2).getCell(6).value instanceof Date ||
    typeof after.getWorksheet('REGISTRO').getRow(2).getCell(6).value==='number',true);
  for(const col of [1,2,3,4,5,7,8,9]){
    assert.deepEqual(after.getWorksheet('REGISTRO').getRow(2).getCell(col).value,
      before.getWorksheet('REGISTRO').getRow(2).getCell(col).value);
  }
  assert.equal(after.getWorksheet('REGISTRO').getRow(3).getCell(4).value,null);
  const again=await mergeIronMountainHistory(first.bytes,data);
  assert.equal(again.changed,false);
  assert.equal(again.updated,0);
  assert.equal(Buffer.compare(again.bytes,first.bytes),0);
});
test('caja solicitada sin coincidencia de cargos queda para revisión y no modifica histórico',async()=>{
  const original=await sourceWorkbook();
  const result=await mergeIronMountainHistory(original,[
    box('T2044084018','2026-11-05',{
      clasificacion:'POR SOLICITUD',celda:'0326-0325-9999'
    }),
    box('T9999999999','2026-11-05',{
      clasificacion:'POR SOLICITUD',celda:'945-946'
    })
  ]);
  assert.equal(result.changed,false);
  assert.equal(result.reviewRequired,2);
  assert.deepEqual(result.reviews.map(x=>x.motivo),['CARGOS_NO_COINCIDEN','CAJA_NO_ENCONTRADA']);
  assert.equal(Buffer.compare(result.bytes,original),0);
});
test('caja nueva duplica ni correlativo ni fecha y reenvío se distingue por clasificación',async()=>{
  const original=await sourceWorkbook();
  const first=await mergeIronMountainHistory(original,[box('T2044202150','2026-11-05')]);
  assert.equal(first.added,1);
  const suspicious=await mergeIronMountainHistory(first.bytes,[box('T2044202150','2026-11-06')]);
  assert.equal(suspicious.added,0);
  assert.equal(suspicious.reviewRequired,1);
  assert.equal(suspicious.changed,false);
  const requested=await mergeIronMountainHistory(first.bytes,[
    box('P2044202150','2026-11-06',{clasificacion:'POR SOLICITUD'})
  ]);
  assert.equal(requested.updated,1);
  assert.equal(requested.added,0);
  assert.equal(requested.updatedEntries[0].row,3);
});
test('cargos con cero inicial y (A) coinciden sin modificar otros campos',async()=>{
  const wb=new ExcelJS.Workbook(),sheet=wb.addWorksheet('REGISTRO');
  sheet.addRow(HEADERS);
  sheet.addRow([1,new Date('2024-06-12T00:00:00Z'),'ANTERIOR','T2032192124',
    '3365-3366-3367-3368 (A)',new Date('2024-06-12T00:00:00Z'),'','','']);
  sheet.getCell('F2').font={color:{argb:'FFFF0000'}};
  const result=await mergeIronMountainHistory(Buffer.from(await wb.xlsx.writeBuffer()),[
    box('T2032192124','2026-10-22',{
      clasificacion:'POR SOLICITUD',celda:'3368A-3365A-3366A-3367A'
    })
  ]);
  assert.equal(result.updated,1);
  assert.equal(result.added,0);
  assert.equal(result.reviewRequired,0);
  const after=new ExcelJS.Workbook();
  await after.xlsx.load(result.bytes);
  assert.equal(after.getWorksheet('REGISTRO').getCell('E2').value,'3365-3366-3367-3368 (A)');
});
test('no altera el archivo cuando falta un dato obligatorio del envío',async()=>{
  const original=await sourceWorkbook();
  await assert.rejects(
    mergeIronMountainHistory(original,[box('T2044202155','2026-11-05',{responsable:''})]),
    /IM_HISTORY_INCOMPLETE_SHIPMENT/
  );
});
