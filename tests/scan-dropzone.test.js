import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import * as XLSX from 'xlsx';
import {attachScanImport} from '../src/scan-import-ui.js';
import {attachInterventionExperience} from '../src/intervention-experience.js';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function exampleFile(){
 const book=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
  ['Fecha','Cargo','Grupo','Codigo'],
  ['30/10/2026','941','1','01-0FF01-0217573'],
  ['31/10/2026','942','1','01-0FF01-0217573'],
  ['31/10/2026','942','1','01-0FF01-0217574']
 ]),'CARGOS NUEVOS 2026');
 const raw=XLSX.write(book,{type:'array',bookType:'xlsx'});
 const bytes=new Uint8Array(raw);
 return {name:'facturas-hoy.xlsx',size:bytes.byteLength,lastModified:17,
  arrayBuffer:async()=>bytes.slice().buffer};
}
function setPayload(event,key,payload){
 Object.defineProperty(event,key,{configurable:true,value:payload});
 return event;
}
async function withApp(work){
 const dom=new JSDOM(html);
 const saved=globalThis.document;
 globalThis.document=dom.window.document;
 let called=0;
 try{
  attachScanImport({supabase:{auth:{getSession:async()=>{called++;throw Error('No debe llamarse la API en preview');}}},
   isAdmin:()=>true,appReady:()=>true,isPreview:()=>true});
  const ui=attachInterventionExperience({doc:dom.window.document});
  try{await work({dom,doc:dom.window.document,apiCalls:()=>called});}
  finally{ui.disconnect();}
 }finally{globalThis.document=saved;dom.window.close();}
}
async function until(condition){
 for(let i=0;i<150;i++){
  if(condition())return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw Error('La validación del Excel no terminó.');
}
test('arrastrar un Excel al cuadro lo selecciona y permite validar 942, sin carga automática',async()=>{
 await withApp(async({dom,doc,apiCalls})=>{
  const zone=doc.getElementById('ivDropzone'),excel=exampleFile();
  const drag=new dom.window.Event('dragover',{bubbles:true,cancelable:true});
  setPayload(drag,'dataTransfer',{files:[excel],dropEffect:'none'});
  zone.dispatchEvent(drag);
  assert.equal(drag.defaultPrevented,true);
  assert.equal(zone.classList.contains('is-dragging'),true);
  const drop=setPayload(new dom.window.Event('drop',{bubbles:true,cancelable:true}),
    'dataTransfer',{files:[excel]});
  zone.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented,true);
  assert.equal(zone.classList.contains('is-dragging'),false);
  assert.equal(zone.dataset.droppedFileName,'facturas-hoy.xlsx');
  assert.equal(doc.getElementById('scanFileName').textContent,'facturas-hoy.xlsx');
  assert.equal(doc.getElementById('scanSave').disabled,true);
  assert.equal(doc.getElementById('scanSummary').hidden,true);
  doc.getElementById('scanValidate').click();
  await until(()=>doc.getElementById('scanStage').textContent.includes('Validación completa'));
  assert.equal(doc.getElementById('scanCrossCargo').textContent,'1');
  assert.equal(doc.getElementById('scanValid').textContent,'2');
  assert.match(doc.getElementById('scanSample').textContent,/942/);
  assert.equal(doc.getElementById('scanSave').disabled,true);
  assert.equal(apiCalls(),0);
 });
});
test('pegar un archivo con Ctrl+V en el cuadro lo selecciona sin crear cargos',async()=>{
 await withApp(async({dom,doc})=>{
  const zone=doc.getElementById('ivDropzone'),excel=exampleFile();
  const paste=setPayload(new dom.window.Event('paste',{bubbles:true,cancelable:true}),
    'clipboardData',{files:[excel]});
  zone.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented,true);
  assert.equal(doc.getElementById('scanFileName').textContent,'facturas-hoy.xlsx');
  assert.equal(doc.getElementById('scanSave').disabled,true);
  assert.equal(doc.getElementById('scanSummary').hidden,true);
 });
});
test('rechaza tipos inválidos y múltiples archivos sin perder el archivo anterior',async()=>{
 await withApp(async({dom,doc})=>{
  const zone=doc.getElementById('ivDropzone'),excel=exampleFile();
  zone.dispatchEvent(setPayload(new dom.window.Event('drop',{bubbles:true,cancelable:true}),
    'dataTransfer',{files:[excel]}));
  const dropped=doc.getElementById('scanFileName').textContent;
  zone.dispatchEvent(setPayload(new dom.window.Event('drop',{bubbles:true,cancelable:true}),
    'dataTransfer',{files:[{...excel,name:'archivo.pdf'}]}));
  assert.match(doc.getElementById('ivFileStatus').textContent,/Solo se permiten/);
  assert.equal(doc.getElementById('scanFileName').textContent,dropped);
  zone.dispatchEvent(setPayload(new dom.window.Event('drop',{bubbles:true,cancelable:true}),
    'dataTransfer',{files:[excel,excel]}));
  assert.match(doc.getElementById('ivFileStatus').textContent,/único archivo/);
  assert.equal(doc.getElementById('scanSave').disabled,true);
 });
});
test('el selector normal sigue funcionando y reemplaza al Excel arrastrado',async()=>{
 await withApp(async({dom,doc})=>{
  const zone=doc.getElementById('ivDropzone'),input=doc.getElementById('scanFile');
  zone.dispatchEvent(setPayload(new dom.window.Event('drop',{bubbles:true,cancelable:true}),
    'dataTransfer',{files:[exampleFile()]}));
  Object.defineProperty(input,'files',{configurable:true,value:[{name:'nuevo.xlsx',size:100,lastModified:23}]});
  input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.equal(zone.dataset.droppedFileName,undefined);
  assert.equal(doc.getElementById('scanFileName').textContent,'nuevo.xlsx');
  assert.equal(doc.getElementById('scanSave').disabled,true);
 });
});
