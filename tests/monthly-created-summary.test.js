import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCreatedCargos } from '../src/monthly-created-summary.js';

const now=new Date('2026-10-19T12:00:00Z');
const doc=(year,date,cargos,other={})=>({anioOrigen:year,fechaOrigen:date,cargos,...other});
test('la comparación presenta una línea por año, sin meses futuros',()=>{
 const data=summarizeCreatedCargos([
  doc(2024,'2024-06-05',['13','14']),
  doc(2025,'2025-01-15',['15']),
  doc(2026,'2026-09-22',['18']),
  doc(2026,'2026-10-03',['19'])
 ],now);
 assert.equal(data.comparison.length,7);
 assert.equal(data.comparison.find(x=>x.year===2024).values[5],2);
 assert.equal(data.comparison.find(x=>x.year===2025).values[0],1);
 assert.equal(data.comparison.find(x=>x.year===2026).values[9],1);
 assert.equal(data.comparison.find(x=>x.year===2026).values[10],null);
 assert.equal(data.currentCount,1);
});
test('al desaparecer un cargo único se reduce su punto y su total',()=>{
 const docs=[doc(2026,'2026-10-05',['100']),doc(2026,'2026-10-12',['101'])];
 assert.equal(summarizeCreatedCargos(docs,now).currentCount,2);
 assert.equal(summarizeCreatedCargos(docs.slice(0,1),now).currentCount,1);
 assert.equal(summarizeCreatedCargos([],now).currentCount,0);
});
test('facturas repetidas no duplican el cargo, por mes ni por año',()=>{
 const rows=[doc(2026,'2026-10-03',['007']),doc(2026,'2026-10-03',['7'])];
 const result=summarizeCreatedCargos(rows,now);
 assert.equal(result.currentCount,1);
 assert.equal(result.annual.at(-1).count,1);
 assert.equal(result.comparison.at(-1).values[9],1);
});
test('cargos antiguos importados hoy sin fecha original no aparecen en octubre de 2026',()=>{
 const row=doc(2024,'',['170'],{fechaRegistro:'2026-10-19'});
 const result=summarizeCreatedCargos([row],now);
 assert.equal(result.currentCount,0);
 assert.equal(result.annual.find(x=>x.year===2024).count,1);
 assert.equal(result.comparison.find(x=>x.year===2024).values[9],0);
});
test('fecha fuera del año de cargo se cuenta únicamente en el resumen anual',()=>{
 const row=doc(2026,'2025-12-30',['932']);
 const result=summarizeCreatedCargos([row],now);
 assert.equal(result.annual.at(-1).count,1);
 assert.equal(result.currentCount,0);
 assert.equal(result.comparison.at(-1).values[11],null);
});
test('al cambiar de año aparecen los nuevos meses y la nueva línea',()=>{
 const result=summarizeCreatedCargos([doc(2027,'2027-01-04',['1'])],new Date('2027-01-19T12:00:00Z'));
 assert.equal(result.currentYear,2027);
 assert.equal(result.comparison.at(-1).year,2027);
 assert.equal(result.comparison.at(-1).values[0],1);
 assert.equal(result.comparison.at(-1).values[1],null);
});
