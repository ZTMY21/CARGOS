import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBoxCode, cargoCodes, buildBoxIndex} from '../src/box-classification.js';
import {computeDocEstado} from '../src/rules.js';

test('box matching ignores any alphabetic prefix but retains exact numeric sequence',()=>{
  assert.equal(normalizeBoxCode('T2044084017'), '2044084017');
  assert.equal(normalizeBoxCode('TD2044084017'), '2044084017');
  assert.equal(normalizeBoxCode('P2044084017'), '2044084017');
  assert.notEqual(normalizeBoxCode('2044084017'),normalizeBoxCode('2044084018'));
});
test('suffix A on grouped cargos is retained across all codes',()=>{
  assert.deepEqual(cargoCodes('3382-3383-3384 (A)'),['3382A','3383A','3384A']);
});
test('same numeric barcode merges prefix aliases instead of duplicating boxes',()=>{
  const result=buildBoxIndex([
    {codigoCaja:'T2044084017',cargos:['0324'],anio:2025,fechaEnvio:'2025-06-26'},
    {codigoCaja:'TD2044084017',cargos:['0325'],anio:2025,fechaEnvio:'2025-06-26'}
  ]);
  assert.equal(result.boxes.length,1);
  assert.deepEqual(result.boxes[0].cargos,['324','325']);
  assert.equal(result.boxes[0].estadoEnvio,'Enviado');
});
test('solicitud requires numeric barcode and exact cargo counts/set',()=>{
  const original=[{codigoCaja:'TD123456',cargos:['0324','0325'],clasificacion:'por solicitud'}];
  const requested=[{codigoCaja:'P123456',cargos:['0324','0325'],cantidadCargos:2}];
  const ok=buildBoxIndex(original,requested);
  assert.equal(ok.solicitadas.length,1);
  const wrong=buildBoxIndex([{codigoCaja:'TD123456',cargos:['0324','0325']}],
    [{codigoCaja:'T123456',cargos:['0324'],cantidadCargos:1}]);
  assert.equal(wrong.solicitadas.length,0);
  assert.equal(wrong.revisiones.length,1);
});
test('changed boxes show old code and never count physical replacement twice',()=>{
  const result=buildBoxIndex([
    {codigoCaja:'T100004',cargos:['0324','0325'],anio:2026,orden:1},
    {codigoCaja:'TD100005',cargos:['0324','0325'],anio:2026,orden:2,
      codigoCajaAntiguo:'T100004',fechaPreparacion:'2026-10-19'}
  ]);
  assert.equal(result.boxes.length,1);
  assert.equal(result.boxes[0].clasificacion,'Caja Cambiada');
  assert.equal(result.boxes[0].antiguo,'T100004');
  assert.equal(result.boxes[0].estadoEnvio,'Pendiente de envío');
});
test('different cargo sets do not create changed boxes, and preparation is not shipment',()=>{
  const result=buildBoxIndex([
    {codigoCaja:'T11111',cargos:['120'],fechaPreparacion:'2026-10-18'},
    {codigoCaja:'P22222',cargos:['120','121'],fechaPreparacion:'2026-10-18'}
  ]);
  assert.equal(result.boxes.length,2);
  assert.equal(result.boxes[0].clasificacion,'Caja Preparada para Envío');
  assert.equal(result.boxes[0].estadoEnvio,'Pendiente de envío');
});
test('any entered date makes doc sent even without sustento',()=>{
  assert.equal(computeDocEstado({fEnvio:'2026-10-20',sustento:'',cargos:['10']}).estado,
    'Enviado a Iron Mountain');
  assert.equal(computeDocEstado({fEnvio:'',cargos:['10']}).estado,'Pendiente de Envío');
});
