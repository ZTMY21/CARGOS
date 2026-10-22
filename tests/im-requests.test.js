import test from 'node:test';
import assert from 'node:assert/strict';
import {computeDocEstado} from '../src/rules.js';
import {normalizeBoxBarcode,normalizeCargoIM,parseCargoCell,requestedIMBoxes,countRequestedCargos,summarizePreparedIm} from '../src/im-requests.js';

test('prefijos T, TD y P convergen en un único código de barras numérico',()=>{
  assert.equal(normalizeBoxBarcode('T00990011'),'00990011');
  assert.equal(normalizeBoxBarcode('TD00990011'),'00990011');
  assert.equal(normalizeBoxBarcode('P00990011'),'00990011');
  assert.notEqual(normalizeBoxBarcode('T00990011'),normalizeBoxBarcode('T00990012'));
});
test('el sufijo A de una celda grupal aplica a cada cargo',()=>{
  assert.deepEqual(parseCargoCell('3382-3383-3384 (A)'),['3382A','3383A','3384A']);
  assert.equal(normalizeCargoIM('003382 (A)'),'3382A');
});
test('solo clasifica como solicitado un valor Por solicitud',()=>{
  const boxes=requestedIMBoxes([
    {codigo_caja:'T1001',codigo_cargo:'933',clasificacion_caja:'Caja nueva'},
    {codigo_caja:'TD1002',codigo_cargo:'934',clasificacion_caja:'Por solicitud'}
  ],[{kardex:'SA-1',cargos:['934']}]);
  assert.equal(boxes.length,1);
  assert.equal(boxes[0].codigo,'TD1002');
  assert.equal(boxes[0].coincidencias,1);
});
test('agrupa prefijos distintos de la misma caja y mantiene cargos únicos',()=>{
  const rows=[
    {codigo_caja:'T00990011',codigo_cargo:'0933',clasificacion_caja:'Por solicitud'},
    {codigo_caja:'TD00990011',codigo_cargo:'0934',clasificacion_caja:'Por solicitud'},
    {codigo_caja:'P00990011',codigo_cargo:'0934',clasificacion_caja:'Por solicitud'}
  ];
  const doc=[{kardex:'SA-1',cargos:['933']},{kardex:'SA-2',cargos:['934']}];
  const boxes=requestedIMBoxes(rows,doc);
  assert.equal(boxes.length,1);
  assert.equal(boxes[0].cargos.length,2);
  assert.equal(countRequestedCargos(boxes),2);
  assert.equal(boxes[0].revisar,0);
});
test('cargo ausente o ambiguo no se muestra como validado',()=>{
  const doc=[{kardex:'SA-1',cargos:['933']},{kardex:'SA-2',cargos:['933']}];
  const box=requestedIMBoxes([{codigo_caja:'P500',codigo_cargo:'933-934',clasificacion_caja:'por solicitud'}],doc)[0];
  assert.equal(box.revisar,2);
  assert.equal(box.coincidencias,0);
});
test('si la fecha de envío existe la caja sale de solicitudes y queda solo la pendiente',()=>{
  const rows=[
    {codigo_caja:'T700',codigo_cargo:'933',clasificacion_caja:'Por solicitud',fecha_envio:'2026-10-20'},
    {codigo_caja:'T800',codigo_cargo:'934',clasificacion_caja:'Por solicitud',fecha_envio:null}
  ];
  const boxes=requestedIMBoxes(rows,[]);
  assert.equal(boxes.length,1);
  assert.equal(boxes[0].codigo,'T800');
  assert.equal(boxes[0].estado,'Caja solicitada');
  assert.equal(countRequestedCargos(boxes),1);
});
test('al borrar una fila sincronizada desaparece de solicitudes',()=>{
  const row={codigo_caja:'T2032477010',codigo_cargo:'4768',clasificacion_caja:'POR SOLICITUD'};
  assert.equal(requestedIMBoxes([row],[]).length,1);
  assert.equal(requestedIMBoxes([],[]).length,0);
});

test('Existencias da prioridad al estado activo sin borrar el envío histórico',()=>{
  const historical={imConfirmado:true,imCodigoCaja:'2032477010',imFechaEnvio:'2024-06-12',
    imLiveCodigoCaja:'T2032477010',imLiveClasificacion:'POR SOLICITUD',imLiveFechaEnvio:''};
  assert.equal(computeDocEstado(historical).estado,'Caja solicitada');
  assert.equal(computeDocEstado({...historical,imLiveFechaEnvio:'2026-10-21'}).estado,'Enviado a Iron Mountain');
  assert.equal(computeDocEstado({...historical,imLiveCodigoCaja:'',imLiveClasificacion:'',imLiveFechaEnvio:''}).estado,'Enviado a Iron Mountain');
});
test('caja preparada sin fecha de envío conserva estado pendiente',()=>{
  const base={imLiveCodigoCaja:'TD123',imLiveClasificacion:'Caja nueva',imLiveFechaEnvio:''};
  assert.equal(computeDocEstado(base).estado,'Caja preparada para envío');
  assert.equal(computeDocEstado({...base,imLiveFechaEnvio:'2026-10-21'}).estado,'Enviado a Iron Mountain');
});


test('al poner fecha de envío se descuentan caja y cargos del KPI preparado',()=>{
  const boxes=[
    {codigo_caja:'T2032192124',cargos:['3368A','3365A','3366A','3367A'],fecha_envio:null},
    {codigo_caja:'P2032192048',cargos:['4676','4673'],fecha_envio:null}
  ];
  assert.deepEqual(summarizePreparedIm(boxes),{cajas:2,cargos:6});
  assert.deepEqual(summarizePreparedIm([{...boxes[0],fecha_envio:'2026-10-21'},boxes[1]]),
    {cajas:1,cargos:2});
  assert.deepEqual(summarizePreparedIm(boxes.map(b=>({...b,fecha_envio:'2026-10-21'}))),
    {cajas:0,cargos:0});
});
test('no duplica cajas por prefijos de escaneo T, TD, P',()=>{
  const rows=[
    {codigo_caja:'T2032192124',cargos:['933'],fecha_envio:null},
    {codigo_caja:'TD2032192124',cargos:['934'],fecha_envio:null},
    {codigo_caja:'P2032192124',cargos:['934'],fecha_envio:null}
  ];
  assert.deepEqual(summarizePreparedIm(rows),{cajas:1,cargos:2});
});
test('fechar una caja POR SOLICITUD actualiza solicitudes, preparadas y estado',()=>{
  const base={codigo_caja:'T2032192124',codigo_cargo:'3365A',cargos:['3365A'],
    clasificacion_caja:'POR SOLICITUD',fecha_envio:null};
  assert.equal(countRequestedCargos(requestedIMBoxes([base])),1);
  assert.equal(summarizePreparedIm([base]).cajas,1);
  const sent={...base,fecha_envio:'2026-10-21'};
  assert.equal(countRequestedCargos(requestedIMBoxes([sent])),0);
  assert.equal(summarizePreparedIm([sent]).cajas,0);
  assert.equal(computeDocEstado({imLiveCodigoCaja:base.codigo_caja,
    imLiveClasificacion:'POR SOLICITUD',imLiveFechaEnvio:sent.fecha_envio}).estado,
    'Enviado a Iron Mountain');
});
