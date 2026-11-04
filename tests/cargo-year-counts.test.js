import test from 'node:test';
import assert from 'node:assert/strict';
import { cargoYear, cargoTotalsByYear } from '../src/cargo-year.js';
import { filterDocuments } from '../src/search.js';

const doc=(code,year,date)=>({cargos:[code],anioOrigen:year,fechaOrigen:date,
  fechaRegistro:'2026-10-14',periodo:null});
test('fecha de realización prevalece sobre año de procedencia y filtro de Existencias',()=>{
  const docs=[doc('705',2026,'2025-12-30'),doc('736',2026,'2025-12-31'),
    doc('800',2026,'2026-10-15')];
  assert.equal(cargoYear(docs[0]),'2025');
  assert.equal(filterDocuments(docs,[],{query:'',type:'solo-cargos',year:'2025'}).length,2);
  assert.equal(filterDocuments(docs,[],{query:'',type:'solo-cargos',year:'2026'}).length,1);
});
test('totales consistentes: históricos completos, 2026 sin repetir una factura',()=>{
  const docs=[doc('0028',2024,'2024-08-04'),doc('28',2024,'2024-05-07'),
    doc('705',2026,'2025-12-30'),doc('736',2026,'2025-12-31'),
    doc('800',2026,'2026-01-01'),doc('0800',2026,'2026-01-01')];
  const byYear=cargoTotalsByYear(docs);
  assert.equal(byYear.get('2024'),2);
  assert.equal(byYear.get('2025'),2);
  assert.equal(byYear.get('2026'),1);
  assert.equal([...byYear.values()].reduce((n,v)=>n+v,0),5);
});
