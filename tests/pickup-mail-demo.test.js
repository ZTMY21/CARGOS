import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPickupSample,pickupMailSubject,pickupMailGreeting,PICKUP_TO,PICKUP_CC} from '../src/pickup-mail-demo.js';

test('simulación dentro de Ver correo generado muestra los dos tipos de cajas, asunto y destinatarios',()=>{
 const at=new Date('2026-11-03T20:00:00Z'); // 15:00 Lima
 const html=renderPickupSample({name:'Angelo',company:'Farmacias Peruanas',
  position:'Operador Integral | BPDT - Liquidaciones'},at);
 assert.equal(pickupMailSubject(at),'IM-20261103 II INGRESO DE CAJAS A IRON MOUNTAIN');
 assert.equal(pickupMailGreeting(at),'Buenas tardes');
 assert.match(html,/SIMULACIÓN INTERNA/);
 assert.match(html,/IM-20261103 II INGRESO DE CAJAS A IRON MOUNTAIN/);
 assert.match(html,/30 cajas nuevas para almacenamiento/);
 assert.match(html,/30 cajas de retorno para rearchivamiento/);
 assert.match(html,/Formato IM-DYT \(NUEVAS\)\.xlsx/);
 assert.match(html,/Formato IM-DYT \(DEVOLUCIONES\)\.xlsx/);
 assert.match(html,/no generados ni adjuntados/);
 for(const address of [...PICKUP_TO,...PICKUP_CC])assert.ok(html.includes(address));
 assert.match(html,/TD-DEMO-030/);
 assert.match(html,/Angelo/);
 assert.match(html,/BPDT - Liquidaciones/);
 assert.equal((html.match(/Cargo de ejemplo /g)||[]).length,30);
 assert.doesNotMatch(html,/dcieza@|chtransa|AXL-818/);
});
test('asunto usa calendario de Lima y cambia con la fecha, no con UTC',()=>{
 assert.equal(pickupMailSubject(new Date('2026-11-09T01:00:00Z')),
  'IM-20261108 II INGRESO DE CAJAS A IRON MOUNTAIN');
 assert.equal(pickupMailSubject(new Date('2026-11-09T05:00:00Z')),
  'IM-20261109 II INGRESO DE CAJAS A IRON MOUNTAIN');
 assert.equal(pickupMailGreeting(new Date('2026-11-09T01:00:00Z')),'Buenas noches');
});
test('simulación impide HTML inyectado y acepta logo PNG opcional',()=>{
 const html=renderPickupSample({name:'<script>alert(1)</script>',
  introduction:'<img src=x onerror=alert(1)>'});
 assert.doesNotMatch(html,/<script>|<img src=x/);
 assert.match(html,/&lt;script&gt;/);
 const logo='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
 assert.match(renderPickupSample({logo}),/data:image\/png;base64,/);
});
