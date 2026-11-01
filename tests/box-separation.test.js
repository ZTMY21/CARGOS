import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {attachBoxScanSheets} from '../src/box-scan-sheet-ui.js';

test('Control y Acondicionamiento son módulos independientes con sus propios lectores',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const doc=new JSDOM(html).window.document;
 const control=doc.getElementById('grp-cajas');
 const conditioning=doc.getElementById('grp-acondicionamiento');
 assert.ok(control&&conditioning);
 assert.equal(control.contains(doc.getElementById('boxScanInput')),true);
 assert.equal(control.contains(doc.getElementById('boxConditionPanel')),false);
 assert.equal(control.contains(doc.getElementById('conditionScanInput')),false);
 assert.equal(conditioning.contains(doc.getElementById('conditionScanInput')),true);
 assert.equal(conditioning.contains(doc.getElementById('boxConditionPanel')),true);
 assert.equal(conditioning.contains(doc.getElementById('conditionStart')),true);
 assert.equal(conditioning.contains(doc.getElementById('conditionFinish')),true);
 const controlTab=doc.getElementById('workspaceTabCajas');
 const conditioningTab=doc.getElementById('workspaceTabAcondicionamiento');
 assert.equal(controlTab.getAttribute('aria-controls'),'grp-cajas');
 assert.equal(conditioningTab.getAttribute('aria-controls'),'grp-acondicionamiento');
 assert.equal(doc.querySelectorAll('#boxConditionPanel').length,1);
 assert.equal(doc.querySelectorAll('#conditionScanInput').length,1);
});
test('el escaneo de consulta se registra independientemente, sin preparar cajas',async()=>{
 const oldDoc=globalThis.document;
 const dom=new JSDOM('<div id="boxSheetsStatus"></div>');
 globalThis.document=dom.window.document;
 try{
  const calls=[];
  const controller=attachBoxScanSheets({supabase:{},isAdmin:()=>true,appReady:()=>true,isPreview:()=>false,
   requestSheet:async(code)=>{calls.push(code);return {googleVerified:true};}});
  controller.scan({scan:{ok:true,original:'TD00990011',normalized:'00990011'}});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls,['TD00990011']);
  assert.match(dom.window.document.getElementById('boxSheetsStatus').textContent,/registrada/);
  controller.reset();
 }finally{
  if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
  dom.window.close();
 }
});
test('Preview no escribe lecturas en Google Sheets',async()=>{
 const oldDoc=globalThis.document;
 const dom=new JSDOM('<div id="boxSheetsStatus"></div>');
 globalThis.document=dom.window.document;
 try{
  let count=0;
  const controller=attachBoxScanSheets({supabase:{},isAdmin:()=>true,appReady:()=>true,isPreview:()=>true,
   requestSheet:async()=>{count++;}});
  controller.scan({scan:{ok:true,original:'T00990011'}});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(count,0);
  assert.match(dom.window.document.getElementById('boxSheetsStatus').textContent,/Preview/);
 }finally{
  if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;
  dom.window.close();
 }
});
