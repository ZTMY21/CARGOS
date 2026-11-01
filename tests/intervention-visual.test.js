import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../src/intervention-ui.css',import.meta.url),'utf8');
const doc=new JSDOM(html).window.document;

test('la intervención conserva cuatro formularios y sus identificadores originales',()=>{
 for(const id of ['grp-escaneos','grp-cajas','grp-acondicionamiento','grp-correos']){
  assert.ok(doc.getElementById(id),id);
 }
 const selectors={
  'grp-escaneos':['scanFile','scanPaste','scanValidate','scanSave','scanSummary','scanSample','scanReceipt'],
  'grp-cajas':['boxScanInput','boxScanSubmit','boxScanRefresh','boxScanClear','boxScanResult','boxScanHistory','boxSheetsStatus'],
  'grp-acondicionamiento':['conditionScanInput','conditionStart','conditionObserve','conditionResolve','conditionFinish','conditionRetryDrive','conditionSheetsStatus'],
  'grp-correos':['pickupPrepare','pickupReload','pickupMailBatches','pickupPreviewDetails','pickupMailPreview','pickupSample','pickupSaveConfig']
 };
 for(const [module,ids] of Object.entries(selectors)){
  const root=doc.getElementById(module);
  for(const id of ids)assert.ok(root.querySelector('#'+id),module+' → '+id);
 }
});
test('solo Acondicionamiento contiene indicadores reales y el registro de preparación',()=>{
 const cond=doc.getElementById('grp-acondicionamiento');
 for(const id of ['conditionKpiPreparing','conditionKpiObserved','conditionKpiReady','boxConditionPanel']){
  assert.ok(cond.querySelector('#'+id),id);
 }
 assert.equal(doc.querySelector('#grp-cajas #boxConditionPanel'),null);
 assert.ok(doc.querySelector('#grp-cajas #boxScanInput'));
});
test('los demás módulos y la navegación se mantienen intactos',()=>{
 for(const id of ['grp-resumen','grp-requerimientos','grp-existencias','workspaceTabs','headerLogo']){
  if(id==='headerLogo')continue; // El logo original usa clase, no id.
  assert.ok(doc.getElementById(id),id);
 }
 assert.ok(doc.querySelector('img.header-logo'));
 assert.ok(doc.querySelector('#workspaceTabs [data-workspace="resumen"]'));
 assert.ok(doc.querySelector('#workspaceTabs [data-workspace="existencias"]'));
 assert.ok(doc.querySelector('link[href="/src/intervention-ui.css"]'));
 for(const blocked of ['#workspaceTabs','#grp-resumen','#grp-requerimientos','#grp-existencias','.header-logo']){
  assert.equal(css.includes(blocked),false,'CSS de intervención no debe alcanzar '+blocked);
 }
});
test('el correo deja de mostrar un iframe gigante vacío; vista cerrada hasta pedirla',()=>{
 const mail=doc.getElementById('grp-correos');
 const detail=mail.querySelector('#pickupPreviewDetails');
 assert.ok(detail);
 assert.equal(detail.hasAttribute('open'),false);
 assert.ok(detail.contains(mail.querySelector('#pickupMailPreview')));
 assert.ok(mail.querySelector('.intervention-config-panel #pickupSaveConfig'));
});
