import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parseBoxScan,findPreparedBox,probableRapidScan} from '../src/box-scanner.js';
import {attachBoxScanner} from '../src/box-scanner-ui.js';

test('acepta códigos originales T/TD/P o numéricos y conserva ceros iniciales',()=>{
  assert.deepEqual(parseBoxScan('TD00990011'),{ok:true,original:'TD00990011',normalized:'00990011'});
  assert.equal(parseBoxScan('T00990011').normalized,'00990011');
  assert.equal(parseBoxScan('P00990011').normalized,'00990011');
  assert.equal(parseBoxScan('00990011').normalized,'00990011');
  assert.equal(parseBoxScan('XYZ00990011').ok,false);
  assert.equal(parseBoxScan('T1234').ok,false);
  assert.equal(parseBoxScan('01-02-00334').normalized,'010200334');
});
test('consulta varias relaciones de una caja y no inventa relaciones para otra',()=>{
  const records=[
    {codigo_caja:'T00990011',cargos:['933','934'],clasificacion_caja:'Por solicitud'},
    {codigo_caja:'TD00990011',cargos:['935'],clasificacion_caja:'Por solicitud'},
    {codigo_caja:'P00990012',cargos:['936'],clasificacion_caja:'Cajas nuevas'}
  ];
  const match=findPreparedBox(records,'00990011');
  assert.equal(match.found,true);assert.equal(match.matches.length,2);
  assert.deepEqual(match.cargos,['933','934','935']);
  assert.equal(findPreparedBox(records,'T00990013').found,false);
});
test('autolectura solo para ráfagas de teclas compatibles con un lector',()=>{
  assert.equal(probableRapidScan([5,4,8,3,9,10],7),true);
  assert.equal(probableRapidScan([100,130,90,95,110,180],7),false);
  assert.equal(probableRapidScan([],12),false);
});
test('interfaz escanea caja pendiente y rechaza duplicidad por prefijo sin modificar base',async()=>{
 const ids=['boxScanInput','boxScanFeedback','boxScanResult','boxScanHistory','boxScanCount','boxScannerModel',
 'boxScannerSource','boxScannerDetect','boxScanEnable','boxScanSubmit','boxScanRefresh','boxScanClear'];
 const dom=new JSDOM('<!doctype html><html><body>'+ids.map(id=>
   id==='boxScanInput'?'<input id="'+id+'">':
   id==='boxScanHistory'?'<ol id="'+id+'"></ol>':
   id.endsWith('Detect')||id.endsWith('Enable')||id.endsWith('Submit')||id.endsWith('Refresh')||id.endsWith('Clear')?
     '<button id="'+id+'"></button>':'<div id="'+id+'"></div>').join('')+'</body></html>',{url:'https://kardex.example/'});
 const oldDocument=globalThis.document,oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 try{
  globalThis.document=dom.window.document;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
  let reads=0,writes=0;
  const repository={preparedImDetails:async()=>{reads++;return [{codigo_caja:'TD00990011',cargos:['933','934'],clasificacion_caja:'Por solicitud'}];}};
  const ui=attachBoxScanner({repository,isAdmin:()=>true,appReady:()=>true});
  ui.activate();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(reads,1);
  const input=dom.window.document.getElementById('boxScanInput');
  input.value='T00990011';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  assert.match(dom.window.document.getElementById('boxScanResult').textContent,/933, 934/);
  assert.equal(dom.window.document.getElementById('boxScanCount').textContent,'1');
  input.value='P00990011';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  assert.equal(dom.window.document.getElementById('boxScanCount').textContent,'1');
  assert.match(dom.window.document.getElementById('boxScanFeedback').textContent,/repetida/);
  assert.equal(writes,0);
  ui.reset();assert.equal(dom.window.document.getElementById('boxScanCount').textContent,'0');
 }finally{
  if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;
  dom.window.close();
 }
});
