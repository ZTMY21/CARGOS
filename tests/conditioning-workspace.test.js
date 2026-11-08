import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import ExcelJS from 'exceljs';
import {drawBoxBarcode} from '../src/box-code128.js';
import {physicalBoxKey,matchesAssignedBoxCode} from '../src/search.js';
import {createReceptionFixture,appendReceivedBoxes} from '../server/reception-workbook.js';
import {readMasterRows} from '../server/im-master-workbook.js';
import {updateConditioningWorkbooks} from '../server/conditioning-workbooks.js';

test('Code 128 representa el código completo y conserva sus ceros',()=>{
  const dom=new JSDOM('<svg hidden></svg>');
  const svg=dom.window.document.querySelector('svg');
  drawBoxBarcode(svg,'TD0900000019');
  assert.equal(svg.hasAttribute('hidden'),false);
  assert.equal(svg.getAttribute('viewBox'),'0 0 187 58');
  assert.equal(svg.getAttribute('aria-label'),'Código de barras TD0900000019');
  assert.equal(svg.querySelectorAll('rect').length,46);
  for(const code of ['TD0900000019','T0900000019','D0900000019','P 0900-000019','0900000019']){
    assert.equal(physicalBoxKey(code),'0900000019');
    assert.equal(matchesAssignedBoxCode('TD0900000019',code,true),true);
  }
  assert.equal(matchesAssignedBoxCode('TD0900000019','900000019',true),false);
  drawBoxBarcode(svg,'');
  assert.equal(svg.hasAttribute('hidden'),true);
  dom.window.close();
});

test('preparación, primer despacho y retorno actualizan copias sin duplicar filas',async()=>{
  const fixture=await createReceptionFixture();
  const reception=await appendReceivedBoxes(fixture.bytes,[{clave:'9000000200',codigo:'TD9000000200'}],{minimumBoxes:1});
  const archive=new ExcelJS.Workbook(),sheet=archive.addWorksheet('REGISTRO');
  sheet.addRow(['N°','FECHA DE PREPARACIÓN','RESPONSABLE','CÓDIGO DE BARRAS','CARGOS','FECHA DE ENVÍO','ENTREGA','RECIBE','PLACA']);
  sheet.addRow([1,'20/06/2025','OPERADOR','TD0900000019','00123-124-125-126','20/06/2025']);
  const historical=Buffer.from(await archive.xlsx.writeBuffer());
  const common={preparada:'2026-11-08',responsable:'Operador de prueba'};
  const newBox={...common,id:'nueva',codigo:'TD9000000200',origen:'nueva',cargos:['00943','942']};
  const requested={...common,id:'retorno-1',solicitud:'solicitud-1',codigo:'TD0900000019',origen:'solicitada',
    cargos:['00123','124','125','126'],solicitada:'2026-11-02'};
  const first=await updateConditioningWorkbooks(reception.bytes,historical,[newBox,requested]);
  const rows=await readMasterRows(first.maestro,{minimumBoxes:1});
  assert.equal(rows.at(-1).celda,'00943-942');
  assert.equal(rows.at(-1).preparacion,'2026-11-08');
  assert.equal(rows.at(-1).envio,'');
  assert.deepEqual(first.historico,historical);
  const shipment=[{...newBox,enviada:'2026-11-08'},{...requested,enviada:'2026-11-08',placa:'ABC-123'}];
  const sent=await updateConditioningWorkbooks(first.maestro,first.historico,shipment);
  const retry=await updateConditioningWorkbooks(sent.maestro,sent.historico,shipment);
  const result=new ExcelJS.Workbook();
  await result.xlsx.load(retry.historico);
  assert.equal(result.worksheets[0].getCell('F2').value,'20/06/2025');
  assert.equal(result.worksheets[0].getCell('K2').value,'08/11/2026');
  assert.equal(result.worksheets[0].getCell('Q2').value,'ABC-123');
  assert.equal(result.worksheets[0].getCell('D3').value,newBox.codigo);
  assert.deepEqual(retry.historico,sent.historico);
});
