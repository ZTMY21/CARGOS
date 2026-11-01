import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {attachInterventionExperience} from '../src/intervention-experience.js';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const premiumCSS=readFileSync(new URL('../src/intervention-premium.css',import.meta.url),'utf8');
const ids=['grp-escaneos','grp-cajas','grp-acondicionamiento','grp-correos'];
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));

test('cuatro módulos de la intervención llevan diseños propios, iconos, acciones y datos originales',()=>{
 const dom=new JSDOM(html);const d=dom.window.document;
 for(const id of ids){
  const section=d.getElementById(id);
  assert.ok(section.querySelector('.iv-premium .iv-hero'),id+' hero');
  assert.ok(section.querySelector('.iv-hero .iv-icon'),id+' icono');
  assert.ok(section.querySelector('.iv-panel'),id+' contenido');
 }
 assert.ok(d.querySelector('#grp-escaneos #ivDropzone'));
 assert.ok(d.querySelector('#grp-escaneos #scanFile'));
 assert.ok(d.querySelector('#grp-escaneos #scanValidate'));
 assert.ok(d.querySelector('#grp-escaneos #scanSave'));
 assert.ok(d.querySelector('#grp-cajas #ivScannerVisual'));
 assert.ok(d.querySelector('#grp-cajas #boxScanResult'));
 assert.ok(d.querySelector('#grp-acondicionamiento #ivConditionProgressTrack'));
 assert.ok(d.querySelector('#grp-acondicionamiento #conditionFinish'));
 assert.ok(d.querySelector('#grp-correos #ivMailProgressTrack'));
 assert.ok(d.querySelector('#grp-correos #pickupMailBatches'));
 assert.ok(d.querySelector('#grp-correos #pickupSample'));
 assert.ok(d.querySelector('#grp-correos #pickupMailPreview'));
 assert.ok(d.querySelector('link[href="/src/intervention-premium.css"]'));
 assert.equal(d.querySelectorAll('#scanFile').length,1);
 assert.equal(d.querySelectorAll('#boxScanInput').length,1);
 assert.equal(d.querySelectorAll('#conditionScanInput').length,1);
 assert.equal(d.querySelectorAll('#pickupMailCounts').length,1);
 dom.window.close();
});

test('CSS premium solo contiene selectores de intervención, no cambia menús ni Resumen',()=>{
 for(const rule of ['#workspaceTabs','#grp-resumen','#grp-requerimientos','#grp-existencias','.header-logo','.header-row']){
  assert.ok(!premiumCSS.includes(rule),rule);
 }
 assert.match(premiumCSS,/iv-dropzone/);
 assert.match(premiumCSS,/iv-scanner-visual/);
 assert.match(premiumCSS,/iv-flowsteps/);
 assert.match(premiumCSS,/iv-mail-progress|iv-mail-count/);
});

test('consulta escaneada actualiza la ficha visual sin crear ni guardar una caja',async()=>{
 const dom=new JSDOM(html);
 const doc=dom.window.document,ui=attachInterventionExperience({doc});
 try{
  const d=id=>doc.getElementById(id);
  assert.equal(d('ivBoxEmpty').hidden,false);
  const result=d('boxScanResult');
  result.append(Object.assign(doc.createElement('h3'),{textContent:'Caja TD00990011'}));
  result.append(Object.assign(doc.createElement('p'),{textContent:'Cargos: 933, 934'}));
  result.append(Object.assign(doc.createElement('p'),{textContent:'Clasificación: POR SOLICITUD'}));
  await settle();
  assert.equal(d('ivBoxEmpty').hidden,true);
  assert.equal(d('ivBoxMatch').dataset.state,'success');
  assert.equal(d('ivBoxMatch').textContent,'Caja identificada');
  assert.equal(d('ivScannerVisual').classList.contains('has-read'),true);
 }finally{ui.disconnect();dom.window.close();}
});

test('el progreso de acondicionamiento se deriva de estados reales y nunca inventa cajas',async()=>{
 const dom=new JSDOM(html);
 const doc=dom.window.document,ui=attachInterventionExperience({doc});
 try{
  const d=id=>doc.getElementById(id);
  assert.equal(d('ivConditionState').textContent,'Sin caja');
  d('conditionCode').value='TD00990011';
  d('conditionDetail').textContent='En acondicionamiento · Cargos 933';
  await settle();
  assert.equal(d('ivConditionState').textContent,'En preparación');
  assert.equal(d('ivConditionProgressTrack').getAttribute('aria-valuenow'),'65');
  d('conditionDetail').textContent='Observada · Incidencia: Precinto dañado';
  await settle();
  assert.equal(d('ivConditionState').dataset.state,'warning');
  d('conditionDetail').textContent='Lista para recojo · Preparación terminada';
  await settle();
  assert.equal(d('ivConditionProgressTrack').getAttribute('aria-valuenow'),'100');
  assert.equal(d('ivConditionState').dataset.state,'success');
 }finally{ui.disconnect();dom.window.close();}
});

test('avisos reflejan solo el contador real y la simulación reutiliza el botón existente',async()=>{
 const dom=new JSDOM(html);
 const doc=dom.window.document,ui=attachInterventionExperience({doc});
 try{
  const d=id=>doc.getElementById(id);
  assert.equal(d('ivMailCount').textContent,'—');
  d('pickupMailCounts').textContent='27 cajas nuevas listas sin comunicar · Faltan 3 para el aviso.';
  await settle();
  assert.equal(d('ivMailCount').textContent,'27');
  assert.equal(d('ivMailProgressTrack').getAttribute('aria-valuenow'),'27');
  assert.match(d('ivMailHelp').textContent,/Faltan 3/);
  d('pickupMailCounts').textContent='30 cajas nuevas listas sin comunicar · Puedes preparar un aviso.';
  await settle();
  assert.equal(d('ivMailChip').dataset.state,'success');
  assert.equal(d('ivMailProgressTrack').getAttribute('aria-valuenow'),'30');
  let sampleClicks=0;
  d('pickupSample').addEventListener('click',()=>{sampleClicks++;});
  d('ivMailSimShortcut').click();
  assert.equal(sampleClicks,1);
 }finally{ui.disconnect();dom.window.close();}
});

test('un archivo seleccionado se muestra en la zona Excel y no se carga automáticamente',async()=>{
 const dom=new JSDOM(html);
 const doc=dom.window.document,ui=attachInterventionExperience({doc});
 try{
  const d=id=>doc.getElementById(id),file=d('scanFile');
  Object.defineProperty(file,'files',{configurable:true,value:[{name:'digitalizacion.xlsx'}]});
  file.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await settle();
  assert.match(d('ivFileStatus').textContent,/Archivo detectado/);
  assert.equal(d('scanSave').disabled,true);
  assert.equal(d('scanSummary').hidden,true);
  assert.equal(d('ivStepSelect').classList.contains('active'),true);
 }finally{ui.disconnect();dom.window.close();}
});
