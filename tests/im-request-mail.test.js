import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {REQ_TYPES} from '../src/rules.js';
import {imRequestCodes,composeImRequestMail,imRequestMailto} from '../src/im-request-mail.js';
import {setupImRequestMail} from '../src/im-request-mail-ui.js';
import {setupRequirements} from '../src/requirements-ui.js';

let dom,root;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const to=['joramos@farmaciasperuanas.pe','alopezv@farmaciasperuanas.pe','bsalvador@farmaciasperuanas.pe'];
const cc=['fp-qs-liquidaciones@intercorpretail.pe'];
const context=()=>({allowed:true,mailAccess:true,mailPreviewMode:true,id:'admin',name:'Administrador'});
const boxes=[
  {clave:'cl1',codigo:'T00045',cargos:['300'],solicitable:true,prestamo:null,estado:'Enviado a IM',ubicacion:'Iron Mountain'},
  {clave:'cl2',codigo:'TD00046',cargos:['301'],solicitable:true,prestamo:null,estado:'Enviado a IM',ubicacion:'Iron Mountain'}
];

beforeEach(()=>{
  dom=new JSDOM('<!doctype html><body><div id="host"></div></body>',{url:'https://kardex-preview.example/?reqMail=im'});
  globalThis.document=dom.window.document;
  globalThis.window=dom.window;
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  root=document.querySelector('#host');
});
afterEach(()=>{dom.window.close();delete globalThis.document;delete globalThis.window;});

test('correo IM contiene solo códigos sin cargos, facturas, guías ni metadatos',()=>{
  const mail=composeImRequestMail([
    {codigo:'T0045',cargos:['440','441'],factura:'FF0099'},
    {codigo:'TD00046',cargos:['435'],guia:'G012'},
    {codigo:'P00078',cargos:['442'],cliente:'No mostrar'}
  ]);
  assert.equal(mail.subject,'Solicitud de 3 cajas a IM | CD Santa Anita |');
  assert.deepEqual(mail.to,to); assert.deepEqual(mail.cc,cc);
  assert.deepEqual(mail.codes,['T0045','TD00046','P00078']);
  assert.match(mail.text,/T0045\r\nTD00046\r\nP00078/);
  assert.doesNotMatch(mail.text,/440|441|442|435|FF0099|G012|No mostrar|Cargos|Factura|Guía|Solicitante|Cantidad solicitada|Requerimiento:/);
  assert.doesNotMatch(mail.text,/Solicitud de 3 cajas a IM \| CD Santa Anita \|/);
});

test('códigos IM únicos conservan los prefijos',()=>{
  assert.deepEqual(imRequestCodes([
    {codigo:'TD0021',cargos:['500']},{codigo:'td0021',cargos:['501']},
    {codigo:'P0022'}, {codigo:'   '},{codigo:'TO0023'}, {codigo:'T0024'}
  ]),['TD0021','P0022','TO0023','T0024']);
  assert.throws(()=>composeImRequestMail([{codigo:'',cargos:['444']}]),/Selecciona al menos una caja/);
  assert.equal(composeImRequestMail(['T0045']).subject,'Solicitud de 1 caja a IM | CD Santa Anita |');
});

test('enlace Outlook conserva espacios y tildes sin signos + y mantiene CC',()=>{
  const url=imRequestMailto(composeImRequestMail(['T0045','TD00046']));
  assert.doesNotMatch(url,/\+/);
  assert.match(url,/subject=Solicitud%20de%202%20cajas%20a%20IM/);
  assert.match(url,/%0D%0A/);
  const parsed=new URL(url);
  assert.equal(parsed.searchParams.get('cc'),'fp-qs-liquidaciones@intercorpretail.pe');
  assert.match(parsed.searchParams.get('body'),/siguientes códigos:/);
});

test('el panel de correo no aparece antes de Solicitar ni repite botones',()=>{
  const im=setupImRequestMail(root,{context});
  im.selectionChanged(boxes);
  assert.equal(root.hidden,true);
  assert.equal(root.querySelector('#req4ImMailOutlook').disabled,false); // La tarjeta está oculta hasta guardar
  assert.equal(root.querySelector('#req4ImMailGenerate'),null);
  assert.equal(root.querySelector('#req4ImMailExample'),null);
  assert.equal(root.querySelector('#req4ImMailView'),null);
});

test('después del guardado se muestra correo limpio, sin permitir envíos en preview',()=>{
  const im=setupImRequestMail(root,{context});
  im.showSaved({id:'req-001',numero:'REQ-001'},boxes);
  assert.equal(root.hidden,false);
  assert.equal(root.querySelector('#req4ImMailOutlook').disabled,true);
  assert.equal(root.querySelector('#req4ImMailSubject').textContent,'Solicitud de 2 cajas a IM | CD Santa Anita |');
  assert.equal(root.querySelector('#req4ImMailTo').textContent,to.join('; '));
  assert.equal(root.querySelector('#req4ImMailCc').textContent,cc.join('; '));
  assert.match(root.querySelector('#req4ImMailBody').textContent,/T00045\r\nTD00046/);
  assert.doesNotMatch(root.querySelector('#req4ImMailBody').textContent,/Cargos|300|301|Factura|Guía/);
  im.selectionChanged([{codigo:'P00078'}]);
  assert.equal(root.hidden,true);
});

test('en modo principal la apertura de Outlook solo sucede después de guardar',()=>{
  let href='';
  dom.window.HTMLAnchorElement.prototype.click=function(){href=this.href;};
  const im=setupImRequestMail(root,{context:()=>({...context(),mailPreviewMode:false})});
  assert.equal(root.hidden,true);
  im.showSaved({id:'req-001',numero:'REQ-001'},boxes);
  assert.equal(root.hidden,false);
  assert.equal(root.querySelector('#req4ImMailOutlook').disabled,false);
  root.querySelector('#req4ImMailOutlook').click();
  assert.match(href,/subject=Solicitud%20de%202%20cajas%20a%20IM/);
  assert.doesNotMatch(href,/\+/);
});

test('correo exclusivo de Solicitudes a IM aparece después del formulario',()=>{
  const ui=setupRequirements(root,{
    repository:{pickupMailConfig:async()=>({})},context,refresh:async()=>{},isPreview:true
  });
  ui.update([],{cajas:[]});
  assert.equal(document.querySelector('#req4Kind').value,'prestamo');
  assert.equal(document.querySelector('#req4TabPrestamo').getAttribute('aria-selected'),'true');
  assert.ok(document.querySelector('#req4Loan'));
  assert.equal(document.querySelector('#req4ImMail').hidden,true);
  assert.equal(document.querySelector('#req4Mail').hidden,true);
  const form=document.querySelector('#req4Form'),email=document.querySelector('#req4ImMail');
  assert.ok(form.compareDocumentPosition(email) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(form.querySelector('#req4ImMail'),null);
  document.querySelector('#req4TabNuevas').click();
  assert.equal(document.querySelector('#req4Loan').hidden,true);
  assert.equal(document.querySelector('#req4Mail').hidden,false);
  assert.equal(document.querySelector('#req4FormTitle').textContent,'Solicitar cajas nuevas');
  assert.ok(document.querySelector('#req4Qty'));
  assert.ok(document.querySelector('#req4Submit'));
});

test('misma búsqueda, selección y Solicitar: el correo usa solo los códigos registrados',async()=>{
  let action=null,href='';
  dom.window.HTMLAnchorElement.prototype.click=function(){href=this.href;};
  const repo={
    pickupMailConfig:async()=>({}),
    requirementsMail:async()=>({estado:'NO_ENVIADO'}),
    requestBoxes:async()=>boxes,
    requestAction:async(id,op,data)=>{
      action={id,op,data};
      return {id,numero:'REQ-IM-001',tipo:REQ_TYPES[1],cantidadCajas:2,fechaSolicitud:'2026-11-10',usuario:'Administrador',estadoV4:'Pendiente'};
    }
  };
  const ui=setupRequirements(root,{repository:repo,context:()=>({...context(),mailPreviewMode:false}),refresh:async()=>{}});
  ui.update([],{cajas:[]});
  document.querySelector('#req4TabPrestamo').click();
  document.querySelector('#req4Query').value='T00045';
  document.querySelector('#req4Search').click();await tick();
  [...root.querySelectorAll('[data-req-select]')].forEach(button=>button.click());
  assert.equal(document.querySelector('#req4ImMail').hidden,true);
  document.querySelector('#req4Form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await tick();await tick();
  assert.deepEqual(action.data,{tipo:'prestamo',cajas:['T00045','TD00046']});
  assert.equal(document.querySelector('#req4ImMail').hidden,false);
  assert.match(document.querySelector('#req4ImMailBody').textContent,/T00045\r\nTD00046/);
  assert.doesNotMatch(document.querySelector('#req4ImMailBody').textContent,/300|301|Cargos/);
  document.querySelector('#req4ImMailOutlook').click();
  assert.match(href,/subject=Solicitud%20de%202%20cajas%20a%20IM/);
});
