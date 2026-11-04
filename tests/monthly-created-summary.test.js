import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCreatedCargos } from '../src/monthly-created-summary.js';

const oct=new Date('2026-10-19T12:00:00Z');
const nov=new Date('2026-11-04T12:00:00Z');
const row=(cargo,fecha,more={})=>({anioOrigen:2026,claveOrigen:'google-live|cargo',
  fechaOrigen:fecha,cargos:[cargo],...more});
test('alta en hoja Google Sheets aumenta el contador, mes, año y comparación',()=>{
 const original=[row('901','2026-09-30')],after=[...original,row('902','2026-10-19')];
 const before=summarizeCreatedCargos(original,oct);
 const next=summarizeCreatedCargos(after,oct);
 assert.equal(before.currentCount,0);
 assert.equal(next.currentCount,1);
 assert.equal(next.monthly[9].count,1);
 assert.equal(next.comparison.at(-1).values[9],1);
 assert.equal(next.annual.at(-1).count,2);
});
test('eliminar un cargo confirmado en Sheets resta de todo el panel',()=>{
 const all=[row('100','2026-10-02'),row('101','2026-10-19')];
 const before=summarizeCreatedCargos(all,oct);
 const after=summarizeCreatedCargos(all.slice(0,1),oct);
 assert.equal(before.currentCount,2);
 assert.equal(after.currentCount,1);
 assert.equal(after.monthlyTotal,before.monthlyTotal-1);
 assert.equal(after.annual.at(-1).count,before.annual.at(-1).count-1);
 assert.equal(after.comparison.at(-1).values[9],1);
});
test('cambiar la fecha del cargo entre meses mueve el punto correspondiente',()=>{
 const before=summarizeCreatedCargos([row('700','2026-09-24')],oct);
 const after=summarizeCreatedCargos([row('700','2026-10-04')],oct);
 assert.equal(before.monthly[8].count,1);
 assert.equal(before.currentCount,0);
 assert.equal(after.monthly[8].count,0);
 assert.equal(after.currentCount,1);
 assert.equal(after.annual.at(-1).count,before.annual.at(-1).count);
});
test('al cambiar de octubre a noviembre se reinicia el mes sin borrar octubre',()=>{
 const data=[row('700','2026-10-19')];
 const octStats=summarizeCreatedCargos(data,oct);
 const novStats=summarizeCreatedCargos(data,nov);
 assert.equal(octStats.currentCount,1);
 assert.equal(novStats.currentMonth,11);
 assert.equal(novStats.currentCount,0);
 assert.equal(novStats.monthly[9].count,1);
 assert.equal(novStats.monthly[10].count,0);
 assert.equal(novStats.comparison.at(-1).values[11],null);
});
test('eliminar la última referencia baja una vez; facturas duplicadas no cuentan doble',()=>{
 const first=row('0755','2026-10-05');
 const duplicate=row('755','2026-10-05');
 assert.equal(summarizeCreatedCargos([first,duplicate],oct).currentCount,1);
 assert.equal(summarizeCreatedCargos([duplicate],oct).currentCount,1);
 assert.equal(summarizeCreatedCargos([],oct).currentCount,0);
});
test('cargos históricos sin fecha NO se cuentan por fecha de importación',()=>{
 const historical={anioOrigen:2026,claveOrigen:'histórico',fechaRegistro:'2026-10-19',
   fechaOrigen:null,cargos:['760']};
 const stats=summarizeCreatedCargos([historical],oct);
 assert.equal(stats.currentCount,0);
 assert.equal(stats.annual.at(-1).count,1);
 assert.equal(stats.undatedInCurrentYear,1);
});
test('fechas octubre anteriores no falsean 2026; el año futuro se incorpora solo al llegar',()=>{
 const previous={anioOrigen:2025,fechaOrigen:'2025-10-08',cargos:['33']};
 const docs=[previous,row('888','2026-10-19')];
 assert.equal(summarizeCreatedCargos(docs,oct).currentCount,1);
 const next=summarizeCreatedCargos([{anioOrigen:2027,fechaOrigen:'2027-01-03',cargos:['10']}],
   new Date('2027-01-19T12:00:00Z'));
 assert.equal(next.annual.at(-1).year,2027);
 assert.equal(next.currentCount,1);
 assert.equal(next.comparison.at(-1).values[1],null);
});

test('los Excel confirmados en noviembre aumentan cargos incorporados del mes y total anual',()=>{
 const documents=[
  {anioOrigen:2026,claveOrigen:'google-live|antiguo',fechaOrigen:'2026-10-30',cargos:['941']},
  {anioOrigen:2026,claveOrigen:'excel-drive|2026|942',
   fechaOrigen:'2026-10-31',fechaRegistro:'2026-11-03',cargos:['942']},
  {anioOrigen:2026,claveOrigen:'excel-drive|2026|943',
   fechaOrigen:'2026-11-02',fechaRegistro:'2026-11-03',cargos:['943']},
  {anioOrigen:2026,claveOrigen:'excel-drive|2026|944',
   fechaOrigen:'2026-11-02',fechaRegistro:'2026-11-03',cargos:['944']}
 ];
 const s=summarizeCreatedCargos(documents,new Date('2026-11-04T15:00:00Z'));
 assert.equal(s.currentCount,3);
 assert.equal(s.annual.at(-1).count,4);
 assert.equal(s.comparison.at(-1).values[10],3);
 // La antigüedad del 942 seguirá desde 31/10; el mes de ingreso es 03/11.
 assert.equal(documents[1].fechaOrigen,'2026-10-31');
});

test('los 32 cargos de diciembre 2025 se contabilizan en 2025 aunque provengan de hoja 2026',()=>{
 const historical=Array.from({length:32},(_,i)=>row(String(705+i),
   i===31?'2025-12-31':'2025-12-30',{claveOrigen:'historico|CARGOS NUEVOS 2026'}));
 const docs=[...historical,row('800','2026-03-03')];
 const s=summarizeCreatedCargos(docs,nov);
 assert.equal(s.annual.find(x=>x.year===2025).count,32);
 assert.equal(s.annual.find(x=>x.year===2026).count,1);
 assert.equal(s.annualTotal,33);
 assert.equal(s.monthlyTotal,1);
 assert.equal(s.comparison.find(x=>x.year===2025).values[11],32);
});
test('en el histórico 2024 0028 y 28 son registros distintos y ambos suman al total',()=>{
 const docs=[
  {anioOrigen:2024,fechaOrigen:'2024-08-04',cargos:['0028']},
  {anioOrigen:2024,fechaOrigen:'2024-05-07',cargos:['28']}
 ];
 const s=summarizeCreatedCargos(docs,nov);
 assert.equal(s.annual.find(x=>x.year===2024).count,2);
 assert.equal(s.annualTotal,2);
 assert.equal(s.comparison.find(x=>x.year===2024).values[4],1);
 assert.equal(s.comparison.find(x=>x.year===2024).values[7],1);
});
