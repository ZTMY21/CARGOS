import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {REQ_TYPES} from '../src/rules.js';
import {composeImMail,imMailCodes,imMailto} from '../src/requirements-im-mail.js';
import {setupRequirementsImMail} from '../src/requirements-im-mail-ui.js';
import {setupRequirements} from '../src/requirements-ui.js';
import {mountImMailDemo} from '../src/requirements-im-demo.js';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const config={mailAccess:true,mailPreviewMode:true,allowed:true,id:'admin-im',name:'Administrador'};
const ctx=()=>config;
const loan={id:'11111111-1111-4111-8111-111111111111',numero:'REQ-IM-001',tipo:REQ_TYPES[1],cantidadCajas:2,fechaSolicitud:'2026-11-10',usuario:'Administrador'};
const newBoxes={id:'22222222-2222-4222-8222-222222222222',numero:'REQ-NEW-001',tipo:REQ_TYPES[0],cantidadCajas:100};
const tracking={cajas:[
  {requerimiento:loan.id,codigo:'T00045',cargos:['444','445'],factura:'FF00991'},
  {requerimiento:loan.id,codigo:'TD00046',cargos:['446'],guia:'GR-23'}
]};
let dom;
function mount(markup='<div id="root"></div>',url='https://preview-ztmy1.vercel.app/?reqMail=im'){
  dom=new JSDOM('<!doctype html><html><body>'+markup+'</body></html>',{url});
  globalThis.document=dom.window.document;
  globalThis.window=dom.window;
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  return dom.window.document;
}
afterEach(()=>{dom?.window.close();delete globalThis.document;delete globalThis.window;});

test('correo de IM usa los tres Para, CC, asunto variable y únicamente códigos',()=>{
  const mail=composeImMail([{codigo:'T00045',cargos:['444'],factura:'FF991'},{codigo:'TD00046',cargos:['445'],guia:'GR44'}]);
  assert.deepEqual(mail.to,['joramos@farmaciasperuanas.pe','alopezv@farmaciasperuanas.pe','bsalvador@farmaciasperuanas.pe']);
  assert.deepEqual(mail.cc,['fp-qs-liquidaciones@intercorpretail.pe']);
  assert.equal(mail.subject,'Solicitud de 2 cajas a IM | CD Santa Anita |');
  assert.match(mail.text,/T00045\r\nTD00046/);
  assert.doesNotMatch(mail.text,/444|445|FF991|GR44|Cargos|Factura|Guía|Requerimiento:|Solicitante:|Cantidad solicitada:/i);
  assert.doesNotMatch(mail.text,/Solicitud de 2 cajas a IM \| CD Santa Anita \|/);
});
test('códigos únicos sin duplicados, sin reemplazar prefijos',()=>{
  assert.deepEqual(imMailCodes([{codigo:'TD001'},{codigo:'td001'},{codigo:'P002'},{codigo:'T003'},{codigo:''}]),['TD001','P002','T003']);
  assert.equal(composeImMail(['T003']).subject,'Solicitud de 1 caja a IM | CD Santa Anita |');
  assert.throws(()=>composeImMail([{codigo:''}]),/códigos de cajas/);
});
test('Outlook no convierte los espacios en signos +',()=>{
  const href=imMailto(composeImMail(['T00045','TD00046']));
  assert.doesNotMatch(href,/\+/);
  assert.match(href,/subject=Solicitud%20de%202%20cajas%20a%20IM/);
  assert.match(href,/%0D%0A/);
  assert.equal(new URL(href).searchParams.get('cc'),'fp-qs-liquidaciones@intercorpretail.pe');
});
test('muestra correo como el de cajas nuevas, sin pedir cargos',async()=>{
  const doc=mount();
  const root=doc.getElementById('root');
  const ui=setupRequirementsImMail(root,{repository:{requirementsMail:async()=>({estado:'NO_ENVIADO'})},context:ctx});
  ui.update([newBoxes,loan],tracking);
  assert.equal(doc.getElementById('req4ImMailSelect').value,loan.id);
  doc.getElementById('req4ImMailGenerate').click();
  await flush();
  assert.equal(doc.getElementById('req4ImMailResult').hidden,false);
  assert.equal(doc.getElementById('req4ImMailSubject').textContent,'Solicitud de 2 cajas a IM | CD Santa Anita |');
  assert.match(doc.getElementById('req4ImMailBody').textContent,/T00045\r\nTD00046/);
  assert.doesNotMatch(doc.getElementById('req4ImMailBody').textContent,/444|445|446|FF00991|GR-23|Cargos|Factura|Guía/);
  assert.equal(doc.getElementById('req4ImMailOutlook').disabled,true);
  assert.equal(doc.getElementById('req4ImMailMark').hidden,true);
});
test('el panel IM no se inserta dentro de Cajas nuevas; ambas pestañas conservan su correo',async()=>{
  const doc=mount();
  const root=doc.getElementById('root');
  const ui=setupRequirements(root,{
    repository:{pickupMailConfig:async()=>({})},
    context:ctx,refresh:async()=>{}
  });
  ui.update([newBoxes,loan],tracking);
  assert.equal(doc.getElementById('req4Kind').value,'prestamo');
  assert.equal(doc.getElementById('req4Loan').hidden,false);
  assert.equal(doc.getElementById('req4Supply').hidden,true);
  assert.equal(doc.getElementById('req4Mail').hidden,true);
  assert.equal(doc.getElementById('req4ImMail').hidden,false);
  assert.equal(doc.getElementById('req4ImMailSelect').value,loan.id);
  doc.getElementById('req4TabNuevas').click();
  assert.equal(doc.getElementById('req4Mail').hidden,false);
  assert.equal(doc.getElementById('req4ImMail').hidden,true);
  assert.equal(doc.getElementById('req4Supply').hidden,false);
  assert.equal(doc.getElementById('req4FormTitle').textContent,'Solicitar cajas nuevas');
  assert.ok(doc.getElementById('req4MailExample'));
});
test('desde el historial de Solicitudes a IM abre el correo correcto',async()=>{
  const doc=mount();
  const root=doc.getElementById('root');
  const ui=setupRequirements(root,{repository:{pickupMailConfig:async()=>({})},context:ctx,refresh:async()=>{}});
  ui.update([newBoxes,loan],tracking);
  const button=doc.createElement('button');
  button.dataset.reqMail=loan.id;root.append(button);button.click();
  await flush();
  assert.equal(doc.getElementById('req4Kind').value,'prestamo');
  assert.equal(doc.getElementById('req4Mail').hidden,true);
  assert.equal(doc.getElementById('req4ImMail').hidden,false);
  assert.match(doc.getElementById('req4ImMailBody').textContent,/T00045\r\nTD00046/);
});
test('en producción genera borrador para Outlook sin enviar automáticamente',async()=>{
  const doc=mount('<div id="root"></div>','https://kardex-digital-santa-anita.vercel.app/');
  let opened='',writes=0;
  dom.window.HTMLAnchorElement.prototype.click=function(){opened=this.href;};
  const ui=setupRequirementsImMail(doc.getElementById('root'),{
    repository:{requirementsMail:async(action)=>{
      if(action==='estado')return {estado:'NO_ENVIADO'};
      writes++;return {estado:'ENVIADO'};
    }},
    context:()=>({...config,mailPreviewMode:false})
  });
  ui.update([loan],tracking);
  doc.getElementById('req4ImMailGenerate').click();
  await flush();
  doc.getElementById('req4ImMailOutlook').click();
  assert.match(opened,/^mailto:joramos@farmaciasperuanas\.pe/);
  assert.doesNotMatch(opened,/\+/);
  assert.equal(writes,0);
});
test('demo abre HTML REAL del Kárdex en Requerimientos / Solicitudes a IM, sin autenticación',async()=>{
  const raw=await readFile(new URL('../index.html',import.meta.url),'utf8');
  dom=new JSDOM(raw,{url:'https://kardex-digital-santa-anita-ztmy1.vercel.app/?reqMail=im&demoIm=1'});
  globalThis.document=dom.window.document;globalThis.window=dom.window;
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  const demo=mountImMailDemo(dom.window.document);
  const doc=dom.window.document;
  assert.equal(doc.getElementById('appShell').hidden,false);
  assert.equal(doc.getElementById('authOverlay').hidden,true);
  assert.equal(doc.getElementById('grp-requerimientos').hidden,false);
  assert.equal(doc.getElementById('req4Kind').value,'prestamo');
  assert.equal(doc.getElementById('req4ImMail').hidden,false);
  assert.match(doc.getElementById('req4ImMailBody').textContent,/T00045\r\nTD00046\r\nP00078/);
  assert.ok(demo.repository.requestBoxes);
  assert.equal(doc.getElementById('req4ImMailOutlook').disabled,true);
});
test('demo busca y solicita cajas solo en memoria; el correo muestra los códigos seleccionados',async()=>{
  const raw=await readFile(new URL('../index.html',import.meta.url),'utf8');
  dom=new JSDOM(raw,{url:'https://kardex-digital-santa-anita-ztmy1.vercel.app/?reqMail=im&demoIm=1'});
  globalThis.document=dom.window.document;globalThis.window=dom.window;
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  mountImMailDemo(dom.window.document);
  const doc=dom.window.document;
  doc.getElementById('req4Query').value='T';
  doc.getElementById('req4Search').click();await flush();
  const add=[...doc.querySelectorAll('[data-req-select]')];
  assert.equal(add.length,2);
  for(const button of add)button.click();
  doc.getElementById('req4Form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await flush();await flush();
  assert.equal(doc.getElementById('req4ImMailSubject').textContent,'Solicitud de 2 cajas a IM | CD Santa Anita |');
  assert.match(doc.getElementById('req4ImMailBody').textContent,/T00045\r\nTD00046/);
  assert.doesNotMatch(doc.getElementById('req4ImMailBody').textContent,/Cargos|300|301/);
  assert.equal(doc.getElementById('req4ImMailOutlook').disabled,true);
});
