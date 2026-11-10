import test, {afterEach,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {setupRequirementsMail} from '../src/requirements-mail-ui.js';
import {REQ_TYPES} from '../src/rules.js';

let dom,root;
let actor='admin-uno';
const config={
  sender:'admin@example.com',
  to:['operaciones@example.com','archivo@example.com'],
  cc:['jefatura@example.com'],
  name:'Responsable de archivo',company:'Farmacias Peruanas',area:'Logística'
};
const supply={
  id:'11111111-1111-4111-8111-111111111111',numero:'RQ-2026-100',
  tipo:REQ_TYPES[0],cantidadCajas:100,fechaSolicitud:'2026-11-10',usuario:'Administrador'
};
const loan={
  id:'22222222-2222-4222-8222-222222222222',numero:'RQ-PRE-01',
  tipo:REQ_TYPES[1],cantidadCajas:2,fechaSolicitud:'2026-11-10',usuario:'Administrador'
};
const tracking={cajas:[
  {requerimiento:loan.id,codigo:'T00045',cargos:['306','307']},
  {requerimiento:loan.id,codigo:'TD00046',cargos:['318']}
]};
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const mount=(repo={pickupMailConfig:async()=>config})=>{
  const ui=setupRequirementsMail(root,{repository:repo,
    context:()=>({mailAccess:true,id:actor})});
  ui.update([supply,loan],tracking);
  return ui;
};
beforeEach(()=>{
  actor='admin-uno';
  dom=new JSDOM('<!doctype html><body><div id="mail"></div></body>',{url:'https://preview.example'});
  globalThis.document=dom.window.document;
  root=document.querySelector('#mail');
});
afterEach(()=>{dom.window.close();delete globalThis.document;});

test('genera correo de solicitud registrada, con destinatarios de recojo y sin Excel',async()=>{
  let requests=0,mutations=0;
  mount({pickupMailConfig:async()=>{requests++;return config;},requestAction:async()=>{mutations++;}});
  document.querySelector('#req4MailGenerate').click();
  await flush();
  assert.equal(requests,1);
  assert.equal(mutations,0);
  assert.equal(document.querySelector('#req4MailResult').hidden,false);
  assert.match(document.querySelector('#req4MailSubject').textContent,/100 cajas nuevas/);
  assert.match(document.querySelector('#req4MailTo').textContent,/operaciones@example.com/);
  assert.match(document.querySelector('#req4MailCc').textContent,/jefatura@example.com/);
  assert.match(document.querySelector('#req4MailBody').textContent,/Responsable de archivo/);
  assert.doesNotMatch(document.querySelector('#req4MailBody').textContent,/Excel|adjunto/);
  document.querySelector('#req4MailMark').click();
  assert.match(document.querySelector('#req4MailBadge').textContent,/Envío simulado/);
  assert.equal(mutations,0);
});

test('desde solicitud específica se muestran caja y cargos del préstamo',async()=>{
  const ui=mount();
  await ui.selectRequest(loan.id,{generate:true});
  assert.equal(document.querySelector('#req4MailSelect').value,loan.id);
  assert.match(document.querySelector('#req4MailSubject').textContent,/2 cajas en préstamo/);
  assert.match(document.querySelector('#req4MailBody').textContent,/Caja T00045 · Cargos: 306 - 307/);
  assert.match(document.querySelector('#req4MailBody').textContent,/Caja TD00046 · Cargos: 318/);
});

test('cambio de cuenta durante carga descarta correo y destinatarios anteriores',async()=>{
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  const ui=mount({pickupMailConfig:()=>promise});
  document.querySelector('#req4MailGenerate').click();
  actor='admin-dos';
  ui.update([supply],{cajas:[]});
  resolve(config);
  await flush();
  assert.equal(document.querySelector('#req4MailResult').hidden,true);
  assert.equal(document.querySelector('#req4MailTo').textContent,'');
});

test('simular con datos ficticios funciona incluso si la configuración falla',async()=>{
  mount({pickupMailConfig:async()=>{throw Error('Sin conexión');}});
  document.querySelector('#req4MailExample').click();
  await flush();
  assert.equal(document.querySelector('#req4MailResult').hidden,false);
  assert.match(document.querySelector('#req4MailSubject').textContent,/SIMULACIÓN-100/);
  assert.equal(document.querySelector('#req4MailTo').textContent,'destinatario@example.invalid');
  assert.match(document.querySelector('#req4MailStatus').textContent,/Simulación con datos ficticios/);
});

test('no permite generar un correo de préstamo sin cajas registradas',async()=>{
  const ui=setupRequirementsMail(root,{
    repository:{pickupMailConfig:async()=>config},
    context:()=>({mailAccess:true,id:actor})
  });
  ui.update([loan],{cajas:[]});
  document.querySelector('#req4MailGenerate').click();
  await flush();
  assert.equal(document.querySelector('#req4MailResult').hidden,true);
  assert.match(document.querySelector('#req4MailStatus').textContent,/No hay cajas registradas/);
});
