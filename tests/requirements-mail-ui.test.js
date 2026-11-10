import test, {afterEach,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {setupRequirementsMail} from '../src/requirements-mail-ui.js';
import {setupRequirements} from '../src/requirements-ui.js';
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
  globalThis.window=dom.window;
  root=document.querySelector('#mail');
});
afterEach(()=>{dom.window.close();delete globalThis.document;delete globalThis.window;});

test('genera correo de solicitud registrada, con destinatarios de recojo y sin Excel',async()=>{
  let requests=0,mutations=0;
  const ui=mount({pickupMailConfig:async()=>{requests++;return config;},requestAction:async()=>{mutations++;}});
  await ui.selectRequest(supply.id);
  document.querySelector('#req4MailGenerate').click();
  await flush();
  assert.ok(requests>=1);
  assert.equal(mutations,0);
  assert.equal(document.querySelector('#req4MailResult').hidden,false);
  assert.match(document.querySelector('#req4MailSubject').textContent,/100 cajas nuevas/);
  assert.equal(document.querySelector('#req4MailTo').textContent,'joramos@farmaciasperuanas.pe; alopezv@farmaciasperuanas.pe; bsalvador@farmaciasperuanas.pe');
  assert.equal(document.querySelector('#req4MailCc').textContent,'fp-qs-liquidaciones@intercorpretail.pe');
  assert.equal(document.querySelector('#req4MailSubject').textContent,'Solicitud de 100 cajas nuevas a IM | CD Santa Anita |');
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
  assert.equal(document.querySelector('#req4MailResult').hidden,false);
  assert.equal(document.querySelector('#req4MailFrom').textContent,'admin@example.com');
  assert.equal(document.querySelector('#req4MailTo').textContent,'joramos@farmaciasperuanas.pe; alopezv@farmaciasperuanas.pe; bsalvador@farmaciasperuanas.pe');
});

test('simular con los destinatarios indicados funciona incluso si la configuración falla',async()=>{
  mount({pickupMailConfig:async()=>{throw Error('Sin conexión');}});
  document.querySelector('#req4MailExample').click();
  await flush();
  assert.equal(document.querySelector('#req4MailResult').hidden,false);
  assert.equal(document.querySelector('#req4MailSubject').textContent,'Solicitud de 100 cajas nuevas a IM | CD Santa Anita |');
  assert.doesNotMatch(document.querySelector('#req4MailBody').textContent,/Requerimiento:|Fecha de solicitud:|Solicitante:|Cantidad solicitada:|Firma pendiente de confirmar|Farmacias Peruanas/);
  assert.equal(document.querySelector('#req4MailTo').textContent,'joramos@farmaciasperuanas.pe; alopezv@farmaciasperuanas.pe; bsalvador@farmaciasperuanas.pe');
  assert.equal(document.querySelector('#req4MailCc').textContent,'fp-qs-liquidaciones@intercorpretail.pe');
  assert.match(document.querySelector('#req4MailStatus').textContent,/Falta confirmar el remitente/);
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

test('en modo de publicación el correo conserva los destinatarios y registra solo tras confirmar Outlook',async()=>{
  let saved=0,statusChecks=0;
  const repo={
    pickupMailConfig:async()=>config,
    requirementsMail:async(action,request,subject)=>{
      assert.equal(request,supply.id);
      if(action==='estado'){statusChecks++;return {estado:'NO_ENVIADO'};}
      assert.equal(action,'confirmar');
      assert.match(subject,/100 cajas nuevas/);
      saved++;
      return {estado:'ENVIADO',ya_registrado:false};
    }
  };
  window.confirm=()=>true;
  const ui=setupRequirementsMail(root,{repository:repo,context:()=>({mailAccess:true,mailPreviewMode:false,id:actor})});
  ui.update([supply],{cajas:[]});
  assert.equal(document.querySelector('#req4MailExample').hidden,true);
  assert.equal(document.querySelector('#req4MailPreviewBadge').hidden,true);
  document.querySelector('#req4MailGenerate').click();
  await flush();
  assert.equal(statusChecks,1);
  assert.equal(document.querySelector('#req4MailOutlook').disabled,false);
  assert.equal(document.querySelector('#req4MailMark').disabled,false);
  assert.match(document.querySelector('#req4MailTo').textContent,/joramos@farmaciasperuanas.pe/);
  document.querySelector('#req4MailMark').click();
  await flush();
  assert.equal(saved,1);
  assert.match(document.querySelector('#req4MailBadge').textContent,/Correo enviado · registrado/);
  assert.equal(document.querySelector('#req4MailMark').disabled,true);
  assert.equal(document.querySelector('#req4MailOutlook').disabled,true);
});

test('envíos registrados anteriormente bloquean crear un borrador duplicado',async()=>{
  const ui=setupRequirementsMail(root,{repository:{
    pickupMailConfig:async()=>config,
    requirementsMail:async()=>({estado:'ENVIADO',enviado_at:'2026-11-10T12:00:00Z'})
  },context:()=>({mailAccess:true,mailPreviewMode:false,id:actor})});
  ui.update([supply],{cajas:[]});
  document.querySelector('#req4MailGenerate').click();
  await flush();
  assert.match(document.querySelector('#req4MailStatus').textContent,/ya tiene un correo registrado/);
  assert.equal(document.querySelector('#req4MailOutlook').disabled,true);
});

test('Ver correo generado funciona sin solicitudes y sin respuesta remota',async()=>{
  const repo={pickupMailConfig:()=>new Promise(()=>{})};
  const ui=setupRequirementsMail(root,{repository:repo,context:()=>({mailAccess:true,mailPreviewMode:true,id:actor})});
  ui.update([],{cajas:[]});
  await flush();
  assert.equal(document.querySelector('#req4MailResult').hidden,false);
  assert.equal(document.querySelector('#req4MailSubject').textContent,'Solicitud de 100 cajas nuevas a IM | CD Santa Anita |');
  assert.equal(document.querySelector('#req4MailCc').textContent,'fp-qs-liquidaciones@intercorpretail.pe');
  assert.equal(document.querySelector('#req4MailFrom').textContent,'Pendiente de confirmar (sin remitente configurado)');
  document.querySelector('#req4MailViewTop').click();
  assert.equal(document.querySelector('#req4MailResult').hidden,false);
});
test('Seleccionar otra cantidad cambia el asunto en el correo generado',async()=>{
  const ui=setupRequirementsMail(root,{repository:{pickupMailConfig:async()=>config},
    context:()=>({mailAccess:true,mailPreviewMode:true,id:actor})});
  const row={...supply,id:'33333333-3333-4333-8333-333333333333',cantidadCajas:32};
  ui.update([row],{cajas:[]});
  await flush();
  assert.equal(document.querySelector('#req4MailSubject').textContent,'Solicitud de 32 cajas nuevas a IM | CD Santa Anita |');
  assert.match(document.querySelector('#req4MailBody').textContent,/solicitamos 32 cajas nuevas/);
  assert.doesNotMatch(document.querySelector('#req4MailBody').textContent,/Requerimiento:|Fecha de solicitud:|Solicitante:|Cantidad solicitada:|Firma pendiente de confirmar/);
});
test('Los pasos para solicitar cajas se mantienen: Cantidad, Solicitar y búsqueda para préstamos',()=>{
  const reqRoot=document.createElement('div');
  reqRoot.id='req4-root';document.body.append(reqRoot);
  setupRequirements(reqRoot,{
    repository:{pickupMailConfig:async()=>config},
    context:()=>({allowed:true,mailAccess:true,mailPreviewMode:true,id:actor,name:'Administrador'}),
    refresh:async()=>{}
  });
  const steps=document.querySelector('#req4Steps');
  assert.match(steps.textContent,/Cantidad/);
  assert.match(steps.textContent,/Solicitar/);
  assert.ok(reqRoot.querySelector('#req4Form'));
  assert.ok(reqRoot.querySelector('#req4Submit'));
  reqRoot.querySelector('#req4TabPrestamo').click();
  assert.match(steps.textContent,/Buscar/);
  assert.match(steps.textContent,/Seleccionar/);
  assert.match(steps.textContent,/Solicitar/);
  assert.ok(reqRoot.querySelector('#req4Search'));
});

test('Ver correo generado no repite marca ni asunto dentro del cuerpo',async()=>{
  const ui=setupRequirementsMail(root,{repository:{pickupMailConfig:async()=>config},
    context:()=>({mailAccess:true,mailPreviewMode:true,id:actor})});
  ui.update([supply],{cajas:[]});
  await flush();
  const body=document.querySelector('.req4-mail-content');
  assert.equal(body.querySelector('.req4-mail-brand'),null);
  assert.equal(body.querySelector('h3'),null);
  assert.equal(body.querySelector('h2'),null);
  assert.doesNotMatch(body.textContent,/Solicitud de 100 cajas nuevas a IM \| CD Santa Anita \|/);
  assert.equal(document.querySelector('#req4MailSubject').textContent,
    'Solicitud de 100 cajas nuevas a IM | CD Santa Anita |');
});

test('sin configuración previa muestra correo real y abre Outlook con cuenta activa sin enviar automáticamente',async()=>{
  let writes=0,opened=null;
  window.HTMLAnchorElement.prototype.click=function(){opened=this.href;};
  const repo={
    pickupMailConfig:async()=>({sender:'',name:'',company:''}),
    requirementsMail:async(action)=>{
      if(action==='estado')return {estado:'NO_ENVIADO'};
      writes++;
      return {estado:'ENVIADO'};
    }
  };
  const ui=setupRequirementsMail(root,{repository:repo,
    context:()=>({mailAccess:true,mailPreviewMode:false,id:actor})});
  ui.update([supply],{cajas:[]});
  document.querySelector('#req4MailGenerate').click();
  await flush();
  assert.equal(document.querySelector('#req4MailResult').hidden,false);
  assert.equal(document.querySelector('#req4MailOutlook').textContent,'Abrir correo en Outlook');
  assert.equal(document.querySelector('#req4MailFrom').textContent,'Cuenta activa de Outlook al redactar');
  document.querySelector('#req4MailOutlook').click();
  assert.ok(opened?.startsWith('mailto:joramos@farmaciasperuanas.pe,alopezv@farmaciasperuanas.pe,bsalvador@farmaciasperuanas.pe?'));
  const query=new URL(opened).searchParams;
  assert.equal(query.get('cc'),'fp-qs-liquidaciones@intercorpretail.pe');
  assert.equal(query.get('subject'),'Solicitud de 100 cajas nuevas a IM | CD Santa Anita |');
  assert.match(query.get('body'),/Buenas tardes, estimados:/);
  assert.doesNotMatch(query.get('body'),/Requerimiento:|Fecha de solicitud:|Solicitante:|Cantidad solicitada:|Firma pendiente de confirmar/);
  assert.equal(writes,0);
  assert.equal(document.querySelector('#req4MailBadge').textContent,'No enviado');
});
