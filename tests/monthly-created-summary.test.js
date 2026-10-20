import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCreatedCargos } from '../src/monthly-created-summary.js';

const now=new Date('2026-10-19T12:00:00Z');
const doc=(year,date,cargos,extras={})=>({anioOrigen:year,fechaOrigen:date,cargos,...extras});
test('cuenta por fecha original, nunca por fecha de importación antigua',()=>{
  const docs=[
    doc(2026,'2026-10-03',['0881','0882']),
    doc(2026,'2026-09-14',['883']),
    doc(2025,'',['1500'],{fechaRegistro:'2026-10-19'})
  ];
  const data=summarizeCreatedCargos(docs,now);
  assert.equal(data.currentCount,2);
  assert.equal(data.monthly[8].count,1);
  assert.equal(data.annual.find(row=>row.year===2025).count,1);
  assert.equal(data.annual.find(row=>row.year===2026).count,3);
  assert.equal(data.monthly.length,10);
});
test('no duplica códigos al repetir facturas y resta cuando desaparecen todos los registros',()=>{
  const docs=[doc(2026,'2026-10-10',['0010']),doc(2026,'2026-10-10',['10'])];
  assert.equal(summarizeCreatedCargos(docs,now).currentCount,1);
  assert.equal(summarizeCreatedCargos(docs.slice(1),now).currentCount,1);
  assert.equal(summarizeCreatedCargos([],now).currentCount,0);
});
test('una fecha de año anterior no se asigna a octubre actual',()=>{
  const data=summarizeCreatedCargos([doc(2026,'2025-12-30',['0999'])],now);
  assert.equal(data.currentCount,0);
  assert.equal(data.annual.at(-1).count,1);
  assert.equal(data.undatedInCurrentYear,1);
});
test('tolera fechas DD-MM-AAAA y actualiza los años al avanzar el calendario',()=>{
 const data=summarizeCreatedCargos([doc(2027,'02-01-2027',['006'])],new Date('2027-01-14T11:00:00Z'));
 assert.equal(data.currentYear,2027);
 assert.equal(data.currentCount,1);
 assert.equal(data.monthly.length,1);
 assert.equal(data.annual.at(-1).year,2027);
});
