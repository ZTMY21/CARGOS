import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeBoxPreparationBatch} from '../src/conditioning-batch-summary.js';

const request={id:'lote-100',tipo:'Cajas nuevas para acondicionar',cantidadCajas:100,recibidoV4:0};
const codes=Array.from({length:32},(_,i)=>String(1000000000+i));
const readings=codes.map(codigo=>({codigo,guardado:true}));
const reception={id:'lote-100',cantidad:100,lecturas:readings};
const movements=codes.slice(0,12).map((codigo,i)=>({
 codigo:i%2?'TD'+codigo:'T'+codigo,origen:'nueva',preparada:'2026-11-09',
 solicitud:i%3?'lote-100':null,enviada:i%4?'':'2026-11-09'
}));
test('100 solicitadas, 32 registradas, 12 preparadas producen 32% y 12%',()=>{
 const state=summarizeBoxPreparationBatch(request,null,reception,movements);
 assert.equal(state.total,100);
 assert.equal(state.registered,32);
 assert.equal(state.registeredPct,32);
 assert.equal(state.prepared,12);
 assert.equal(state.preparedPct,12);
});
test('prefijos T TD P y lecturas repetidas no incrementan el conteo',()=>{
 const duplicate={...reception,lecturas:[...readings,{codigo:'P'+codes[0]}]};
 const list=[...movements,{...movements[0],codigo:'P'+codes[0]}];
 const state=summarizeBoxPreparationBatch(request,null,duplicate,list);
 assert.equal(state.registered,32);assert.equal(state.prepared,12);
});
test('no mezcla preparaciones de solicitudes anteriores',()=>{
 const list=[...movements,{codigo:'T9999999999',origen:'nueva',
 solicitud:'solicitud-anterior',preparada:'2026-11-09'}];
 assert.equal(summarizeBoxPreparationBatch(request,null,reception,list).prepared,12);
});
test('si falla la lectura de preparaciones, evita mostrar un falso cero',()=>{
 const result=summarizeBoxPreparationBatch(request,null,reception,null);
 assert.equal(result.prepared,null);assert.equal(result.registered,32);
});
test('sin registro de control puede usar el conteo verificado de seguimiento',()=>{
 const tracking={suministro:{solicitudes:[{id:'lote-100',leidas:32}]}};
 const result=summarizeBoxPreparationBatch(request,tracking,null,[]);
 assert.equal(result.registered,32);assert.equal(result.prepared,0);
});