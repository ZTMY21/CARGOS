import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPickupSample} from '../src/pickup-mail-demo.js';
test('vista previa de 30 cajas sin contactos reales, escritura ni envío',()=>{
 const html=renderPickupSample({name:'Angelo',company:'Farmacias Peruanas',
  position:'Operador Integral | BPDT - Liquidaciones',
  subject:'Solicitud de recojo | {{cantidad}} cajas nuevas | {{sede}} | {{fecha}}'});
 assert.match(html,/SIMULACIÓN INTERNA/);
 assert.match(html,/TD-DEMO-030/);
 assert.match(html,/Angelo/);
 assert.match(html,/BPDT - Liquidaciones/);
 assert.match(html,/Solicitud de recojo \| 30 cajas nuevas \| CD Santa Anita/);
 assert.equal((html.match(/Cargo de ejemplo /g)||[]).length,30);
 assert.doesNotMatch(html,/dcieza@|chtransa|AXL-818/);
});
test('simulación HTML escapa edición maliciosa y logo PNG es optativo',()=>{
 const html=renderPickupSample({name:'<script>alert(1)</script>',
  introduction:'<img src=x onerror=alert(1)>'});
 assert.doesNotMatch(html,/<script>|<img src=x/);
 assert.match(html,/&lt;script&gt;/);
 assert.match(html,/&lt;img/);
 const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
 const logoHtml=renderPickupSample({logo:image});
 assert.match(logoHtml,/data:image\/png;base64,/);
});
