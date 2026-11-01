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
 'boxScannerSource','boxScannerStatus','boxScanSubmit','boxScanRefresh','boxScanClear'];
 const dom=new JSDOM('<!doctype html><html><body>'+ids.map(id=>
   id==='boxScanInput'?'<input id="'+id+'">':
   id==='boxScanHistory'?'<ol id="'+id+'"></ol>':
   id.endsWith('Submit')||id.endsWith('Refresh')||id.endsWith('Clear')?
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
  assert.equal(dom.window.document.getElementById('boxScannerModel').textContent,'');
  assert.equal(dom.window.document.getElementById('boxScannerStatus').textContent,'Sin lecturas');
  const input=dom.window.document.getElementById('boxScanInput');
  input.value='T00990011';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  assert.match(dom.window.document.getElementById('boxScanResult').textContent,/933, 934/);
  assert.equal(dom.window.document.getElementById('boxScannerStatus').textContent,'Código recibido');
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

test('muestra modelo automáticamente solo si WebHID confirma un lector previamente autorizado',async()=>{
 const ids=['boxScanInput','boxScanFeedback','boxScanResult','boxScanHistory','boxScanCount',
  'boxScannerModel','boxScannerStatus','boxScannerSource','boxScanSubmit','boxScanRefresh','boxScanClear'];
 const dom=new JSDOM('<!doctype html><html><body>'+ids.map(id=>
  id==='boxScanInput'?'<input id="'+id+'">':
  id==='boxScanHistory'?'<ol id="'+id+'"></ol>':
  id.startsWith('boxScan')&&/(Submit|Refresh|Clear)$/.test(id)?'<button id="'+id+'"></button>':
  '<div id="'+id+'"'+(id==='boxScannerModel'?' hidden':'')+'></div>').join('')+'</body></html>',{url:'https://kardex.example/'});
 const oldDoc=globalThis.document,oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const listeners={};
 const reader={productName:'Symbol LS2208',vendorId:1504,productId:23};
 try{
  globalThis.document=dom.window.document;
  Object.defineProperty(dom.window.navigator,'hid',{configurable:true,value:{
   getDevices:async()=>[reader],
   addEventListener:(name,fn)=>{listeners[name]=fn;}
  }});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
  const ui=attachBoxScanner({repository:{preparedImDetails:async()=>[]},isAdmin:()=>true,appReady:()=>true});
  ui.activate();await new Promise(r=>setTimeout(r,0));
  assert.equal(dom.window.document.getElementById('boxScannerStatus').textContent,'Lector conectado');
  assert.equal(dom.window.document.getElementById('boxScannerModel').textContent,'Lector: Symbol LS2208');
  assert.equal(dom.window.document.getElementById('boxScannerModel').hidden,false);
  listeners.disconnect({device:reader});
  assert.equal(dom.window.document.getElementById('boxScannerStatus').textContent,'Lector desconectado');
  assert.equal(dom.window.document.getElementById('boxScannerModel').hidden,true);
 }finally{
  if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;
  dom.window.close();
 }
});
test('no atribuye otro dispositivo HID al lector ni muestra un modelo supuesto',async()=>{
 const ids=['boxScanInput','boxScanFeedback','boxScanResult','boxScanHistory','boxScanCount',
  'boxScannerModel','boxScannerStatus','boxScannerSource','boxScanSubmit','boxScanRefresh','boxScanClear'];
 const dom=new JSDOM('<!doctype html><html><body>'+ids.map(id=>
  id==='boxScanInput'?'<input id="'+id+'">':
  id==='boxScanHistory'?'<ol id="'+id+'"></ol>':
  id.startsWith('boxScan')&&/(Submit|Refresh|Clear)$/.test(id)?'<button id="'+id+'"></button>':
  '<div id="'+id+'" hidden></div>').join('')+'</body></html>',{url:'https://kardex.example/'});
 const oldDoc=globalThis.document,oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 try{
  globalThis.document=dom.window.document;
  Object.defineProperty(dom.window.navigator,'hid',{configurable:true,value:{getDevices:async()=>[
   {productName:'Generic USB keyboard',vendorId:123,productId:456}
  ]}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
  const ui=attachBoxScanner({repository:{preparedImDetails:async()=>[]},isAdmin:()=>true,appReady:()=>true});
  ui.activate();await new Promise(r=>setTimeout(r,0));
  assert.equal(dom.window.document.getElementById('boxScannerStatus').textContent,'Sin lecturas');
  assert.equal(dom.window.document.getElementById('boxScannerModel').textContent,'');
 }finally{
  if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;
  dom.window.close();
 }
});

test('escáner sin tecla Enter consulta automáticamente un código y permite el siguiente',async()=>{
 const ids=['boxScanInput','boxScanFeedback','boxScanResult','boxScanHistory','boxScanCount',
  'boxScannerModel','boxScannerStatus','boxScannerSource','boxScanSubmit','boxScanRefresh','boxScanClear'];
 const markup='<html><body>'+ids.map(id=>
  id==='boxScanInput'?'<input id="'+id+'">':
  id==='boxScanHistory'?'<ol id="'+id+'"></ol>':
  /(Submit|Refresh|Clear)$/.test(id)?'<button id="'+id+'"></button>':
  '<div id="'+id+'"></div>').join('')+'</body></html>';
 const dom=new JSDOM(markup,{url:'https://kardex.example/'});
 const oldDoc=globalThis.document,oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 try{
  globalThis.document=dom.window.document;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
  let requests=0;
  const ui=attachBoxScanner({repository:{preparedImDetails:async()=>{requests++;return [
   {codigo_caja:'TD00990011',cargos:['933','934'],clasificacion_caja:'Por solicitud'},
   {codigo_caja:'P00990012',cargos:['935'],clasificacion_caja:'Cajas nuevas'}
  ];}},isAdmin:()=>true,appReady:()=>true});
  ui.activate();await delay(0);
  const input=dom.window.document.getElementById('boxScanInput');
  const count=dom.window.document.getElementById('boxScanCount');
  const result=dom.window.document.getElementById('boxScanResult');
  const sendWithoutEnter=value=>{
    input.value=value;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  };
  assert.equal(dom.window.document.getElementById('boxScannerStatus').textContent,'Sin lecturas');
  sendWithoutEnter('T00990011');
  await delay(750);
  assert.equal(input.value,'');
  assert.equal(count.textContent,'1');
  assert.match(result.textContent,/933, 934/);
  assert.equal(dom.window.document.getElementById('boxScannerStatus').textContent,'Código recibido');
  sendWithoutEnter('P00990012');
  await delay(750);
  assert.equal(count.textContent,'2');
  assert.match(result.textContent,/935/);
  sendWithoutEnter('TD00990011');
  await delay(750);
  assert.equal(count.textContent,'2');
  assert.match(dom.window.document.getElementById('boxScanFeedback').textContent,/repetida/i);
  assert.equal(requests,1);
  ui.reset();
 }finally{
  if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;
  dom.window.close();
 }
});
test('la pausa entre caracteres no dispara una consulta prematura',async()=>{
 const ids=['boxScanInput','boxScanFeedback','boxScanResult','boxScanHistory','boxScanCount',
  'boxScannerModel','boxScannerStatus','boxScannerSource','boxScanSubmit','boxScanRefresh','boxScanClear'];
 const dom=new JSDOM('<html><body>'+ids.map(id=>
  id==='boxScanInput'?'<input id="'+id+'">':
  id==='boxScanHistory'?'<ol id="'+id+'"></ol>':
  /(Submit|Refresh|Clear)$/.test(id)?'<button id="'+id+'"></button>':'<div id="'+id+'"></div>').join('')+'</body></html>',{url:'https://kardex.example/'});
 const oldDoc=globalThis.document,oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 try{
  globalThis.document=dom.window.document;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
  const ui=attachBoxScanner({repository:{preparedImDetails:async()=>[]},isAdmin:()=>true,appReady:()=>true});
  ui.activate();await delay(0);
  const input=dom.window.document.getElementById('boxScanInput');
  input.value='TD009';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  await delay(200);
  input.value='TD00990011';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  await delay(500);
  assert.equal(Number(dom.window.document.getElementById('boxScanCount').textContent||'0'),0);
  await delay(260);
  assert.equal(dom.window.document.getElementById('boxScanCount').textContent,'1');
  ui.reset();
 }finally{
  if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;
  dom.window.close();
 }
});
