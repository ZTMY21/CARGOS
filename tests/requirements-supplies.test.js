import test from 'node:test';
import assert from 'node:assert/strict';
import {validarPrecintos,precintosRegistrados,PRECINTOS_MAX} from '../src/requirements-supplies.js';

test('precintos opcionales, enteros y tope 250',()=>{
 assert.equal(PRECINTOS_MAX,250);
 for(const value of ['',null,undefined,0,'0',250,'250'])assert.equal(validarPrecintos(value),Number(value)||0);
 for(const value of [-1,251,2.4,'250.5','errado',Infinity])assert.throws(()=>validarPrecintos(value),/0 y 250/i);
});
test('la referencia de precintos se recupera de la operación crear sin tocar cajas',()=>{
 const row={id:'req-a',numero:'REQ-00003',cantidadCajas:100};
 const tracking={movimientos:[
  {requerimiento:'req-antiguo',tipo:'crear',datos:{tipo:'nuevas',cantidad:100}},
  {requerimiento:'req-a',tipo:'crear',datos:{tipo:'nuevas',cantidad:100,precintos:200}},
  {requerimiento:'req-a',tipo:'recibir',datos:{cantidad:40}}
 ]};
 assert.equal(precintosRegistrados(row,tracking),200);
 assert.equal(row.cantidadCajas,100);
 assert.equal(tracking.movimientos[1].datos.cantidad,100);
});
test('requerimientos antiguos sin precintos no se completan con datos inventados',()=>{
 const row={id:'req-antiguo',cantidadCajas:100};
 const tracking={movimientos:[{requerimiento:'req-antiguo',tipo:'crear',datos:{tipo:'nuevas',cantidad:100}}]};
 assert.equal(precintosRegistrados(row,tracking),null);
 assert.equal(precintosRegistrados(row,null),null);
});
