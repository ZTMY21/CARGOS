import test from 'node:test';
import assert from 'node:assert/strict';
import {limaDay,summarizeConditionedBoxes,mergeConditionedHistory,timeline,groupedChartSvg} from '../src/prepared-monthly-kpi.js';

const today=new Date('2026-11-09T20:00:00-05:00');
test('solo cuenta cajas preparadas del mes sin fecha de envío',()=>{
  const data=summarizeConditionedBoxes([
    {codigo:'T000123',origen:'nueva',preparada:'2026-11-09',enviada:null},
    {codigo:'TD123',origen:'nueva',preparada:'2026-11-09',enviada:null},
    {codigo:'P456',origen:'solicitada',preparada:'2026-11-08',enviada:null},
    {codigo:'T789',origen:'nueva',preparada:'2026-11-08',enviada:'2026-11-09'},
    {codigo:'T890',origen:'nueva',preparada:'2026-10-31',enviada:null},
    {codigo:'T999',origen:'nueva',preparada:null,enviada:null},
    {codigo:'T111',origen:'reparacion',preparada:'2026-11-09',enviada:null}
  ],today);
  assert.equal(data.mesPreparadas,3);
  assert.equal(data.mesPendientes,2);
  assert.equal(data.pendientesNuevas,1);
  assert.equal(data.pendientesSolicitadas,1);
  assert.equal(data.registros.length,4);
});
test('una caja solicitada nuevamente tiene ciclo de preparación separado',()=>{
  const data=summarizeConditionedBoxes([
    {codigo:'TD000123',origen:'solicitada',preparada:'2026-11-08',solicitud:'a',enviada:'2026-11-09'},
    {codigo:'P123',origen:'solicitada',preparada:'2026-11-09',solicitud:'b',enviada:null}
  ],today);
  assert.equal(data.mesPreparadas,2);
  assert.equal(data.mesPendientes,1);
});
test('usa el calendario de Lima y no el UTC para el día',()=>{
  assert.equal(limaDay(new Date('2026-11-10T02:00:00Z')),'2026-11-09');
});
test('completa 2026 desde el Maestro sin duplicar cajas del módulo',()=>{
  const primary=[{codigo:'TD000123',origen:'nueva',preparada:'2026-11-09',enviada:null}];
  const maestro=[
    {codigo:'T123',origen:'nueva',preparada:'2026-11-09',enviada:null},
    {codigo:'P456',origen:'solicitada',preparada:'2026-10-20',enviada:'2026-10-22'}
  ];
  const summary=summarizeConditionedBoxes(mergeConditionedHistory(primary,maestro),today);
  assert.equal(summary.registros.length,2);
  assert.equal(summary.mesPendientes,1);
  assert.equal(summary.registros.filter(r=>r.preparada.startsWith('2026')).length,2);
});
test('2024 y 2025 se muestran aparte como envíos sin fecha de preparación',()=>{
  const summary=summarizeConditionedBoxes([
    {codigo:'T123',origen:'nueva',preparada:'2026-11-09',enviada:null}
  ],today,[{anio:2024,cajas:417},{anio:2025,cajas:178},{anio:2026,cajas:0}]);
  const annual=timeline(summary,'anio');
  assert.equal(annual.find(r=>r.label==='2024').historicas,417);
  assert.equal(annual.find(r=>r.label==='2025').historicas,178);
  assert.equal(annual.find(r=>r.label==='2026').total,1);
  assert.equal(annual.find(r=>r.label==='2026').historicas,0);
  assert.equal(annual.find(r=>r.label==='2020').total,0);
  assert.match(groupedChartSvg(annual),/conditioned-bar-historical/);
  assert.equal(timeline(summary,'mes').every(r=>r.historicas===0),true);
});
