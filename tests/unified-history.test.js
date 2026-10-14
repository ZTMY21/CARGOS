import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoricalAccumulator} from '../src/historical.js';

test('unified historical tables keep invoices, dates, leading zeroes and source rows across all years', async()=>{
 const a=new HistoricalAccumulator();
 for(let year=2020;year<=2026;year++) {
  a.beginSheet(year===2026?'CARGOS NUEVOS 2026':`Cargos enviados ${year}`);
  a.addRow(1,[{col:1,value:'Fecha'},{col:2,value:'Cargo'},{col:3,value:'Grupo'},{col:4,value:'Codigo'}]);
  a.addRow(2,[{col:1,value:`06-01-${year}`},{col:2,value:'0008'},{col:3,value:'2'},{col:4,value:`F001-${year}`}]);
  a.addRow(3,[{col:1,value:`06-01-${year}`},{col:2,value:'0008'},{col:4,value:`GR001-${year}`}]);
 }
 const result=await a.finish();
 assert.equal(result.docs.length,7);
 for(const d of result.docs){
  assert.deepEqual(d.cargos,['0008']);
  assert.equal(d.fechaOrigen,`${d.anioOrigen}-01-06`);
  assert.equal(d.facturas,`F001-${d.anioOrigen}, GR001-${d.anioOrigen}`);
  assert.equal(d.datosOrigen.registros.length,2);
 }
});

test('missing cargo rows never merge into an invented cargo',async()=>{
 const a=new HistoricalAccumulator();a.beginSheet('Cargos enviados 2024');
 a.addRow(1,[{col:1,value:'Fecha'},{col:2,value:'Cargo'},{col:4,value:'Codigo'}]);
 a.addRow(2,[{col:4,value:'F001-1'}]);a.addRow(3,[{col:4,value:'F001-2'}]);
 const r=await a.finish();assert.equal(r.docs.length,2);
 for(const d of r.docs){assert.deepEqual(d.cargos,[]);assert.match(d.obs,/no indica número de cargo/);}
});

test('legacy matrix format remains supported',async()=>{
 const a=new HistoricalAccumulator();a.beginSheet('Cargos enviados 2021');
 a.addRow(4,[{col:1,value:'Source.xlsx · Invoices'}]);
 a.addRow(5,[{col:1,value:'01/01/2021'},{col:2,value:'CARGO 15'}]);
 a.addRow(6,[{col:1,value:'F001-55'}]);
 const r=await a.finish();assert.equal(r.docs.length,1);assert.deepEqual(r.docs[0].cargos,['15']);
 assert.equal(r.docs[0].facturas,'F001-55');
});
