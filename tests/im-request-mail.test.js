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

beforeEach(()=>{
  dom=new JSDOM('<!doctype html><body><div id="host"></div></body>',{url:'https://kardex-preview.example/?reqMail=im'});
  globalThis.document=dom.window.document;
  globalThis.window=dom.window;
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  root=document.querySelector('#host');
});
afterEach(()=>{dom.window.close();delete globalThis.document;delete globalThis.window;});

test('usa solamente los códigos de cajas seleccionadas y no información documental',()=>{
  const mail=composeImRequestMail([
    {codigo:'T0045',cargos:['440','441'],factura:'FF0099',guia:'G012'},
    {codigo:'TD00046',cargos:['435'],descripcion:'dato privado'},
    {codigo:'P00078',cargos:['442'],cliente:'No revelar'}
  ]);
  assert.equal(mail.subject,'Solicitud de 3 cajas a IM | CD Santa Anita |');
  assert.deepEqual(mail.to,to);
  assert.deepEqual(mail.cc,cc);
  assert.deepEqual(mail.codes,['T0045','TD00046','P00078']);
  assert.match(mail.text,/T0045\r\nTD00046\r\nP00078/);
  assert.doesNotMatch(mail.text,/440|441|442|435|FF0099|G012|dato privado|No revelar|Cargos|Factura|Guía|Solicitante|Cantidad solicitada|Requerimiento:/);
  assert.doesNotMatch(mail.text,/Solicitud de 3 cajas a IM \| CD Santa Anita \|/);
  assert.match(mail.text,/Buenas tardes, estimados:/);
});

test('elimina duplicados por código sin mezclar cargos ni cambiar prefijos',()=>{
  assert.deepEqual(imRequestCodes([
    {codigo:'TD0021',cargos:['500']},{codigo:'td0021',cargos:['501']},
    {codigo:'P0022'}, {codigo:'   '},{codigo:'TO0023'}, {codigo:'T0024'}
  ]),['TD0021','P0022','TO0023','T0024']);
  assert.throws(()=>composeImRequestMail([{codigo:'',cargos:['444']}]),/Selecciona al menos una caja/);
  assert.equal(composeImRequestMail(['T0045']).subject,'Solicitud de 1 caja a IM | CD Santa Anita |');
});

test('Outlook conserva espacios y tildes sin signos + y mantiene CC',()=>{
  const mail=composeImRequestMail(['T0045','TD00046']);
  const url=imRequestMailto(mail);
  assert.match(url,/^mailto:joramos@farmaciasperuanas\.pe,alopezv@farmaciasperuanas\.pe,bsalvador@farmaciasperuanas\.pe\?/);
  assert.doesNotMatch(url,/\+/);
  assert.match(url,/subject=Solicitud%20de%202%20cajas%20a%20IM/);
  assert.match(url,/%0D%0A/);
  const parsed=new URL(url);
  assert.equal(parsed.searchParams.get('cc'),'fp-qs-liquidaciones@intercorpretail.pe');
  assert.equal(parsed.searchParams.get('subject'),'Solicitud de 2 cajas a IM | CD Santa Anita |');
  assert.match(parsed.searchParams.get('body'),/siguientes códigos:/);
});

test('la simulación en la pestaña IM es visible sin permiso de escritura, pero nunca abre Outlook',()=>{
  const ui=setupImRequestMail(root,{context:()=>({...context(),allowed:false})});
  assert.equal(root.hidden,false);
  document.querySelector('#req4ImMailExample').click();
  assert.equal(document.querySelector('#req4ImMailResult').hidden,false);
  assert.equal(document.querySelector('#req4ImMailOutlook').disabled,true);
  assert.equal(document.querySelector('#req4ImMailSubject').textContent,'Solicitud de 3 cajas a IM | CD Santa Anita |');
  const body=document.querySelector('#req4ImMailBody').textContent;
  assert.match(body,/T00045\r\nTD00046\r\nP00078/);
  assert.doesNotMatch(body,/Factura|Guía|Cargos|Requerimiento:/);
});

test('los códigos elegidos preparan el cuerpo y solo un requerimiento guardado habilita Outlook',()=>{
  let href='';
  window.HTMLAnchorElement.prototype.click=function(){href=this.href;};
  const ui=setupImRequestMail(root,{context:()=>({...context(),mailPreviewMode:false})});
  ui.selectionChanged([{codigo:'T00045',cargos:['445']},{codigo:'TD00046',cargos:['448']}]);
  document.querySelector('#req4ImMailGenerate').click();
  assert.equal(document.querySelector('#req4ImMailOutlook').disabled,true);
  assert.match(document.querySelector('#req4ImMailBody').textContent,/T00045\r\nTD00046/);
  assert.doesNotMatch(document.querySelector('#req4ImMailBody').textContent,/445|448|Cargos/);
  ui.selectionChanged([]);
  ui.showSaved({id:'req-001',numero:'REQ-001'},['T00045','TD00046']);
  assert.equal(document.querySelector('#req4ImMailOutlook').disabled,false);
  document.querySelector('#req4ImMailOutlook').click();
  assert.match(href,/subject=Solicitud%20de%202%20cajas%20a%20IM/);
  assert.doesNotMatch(href,/\+/);
  assert.match(document.querySelector('#req4ImMailStatus').textContent,/no lo envía/);
});

test('el módulo de correo aparece dentro de Solicitudes a IM y no modifica Cajas nuevas',async()=>{
  const req=setupRequirements(root,{
    repository:{pickupMailConfig:async()=>({})},
    context,refresh:async()=>{}
  });
  req.update([],{cajas:[]});
  assert.equal(document.querySelector('#req4Kind').value,'prestamo');
  assert.equal(document.querySelector('#req4Supply').hidden,true);
  assert.equal(document.querySelector('#req4Loan').hidden,false);
  assert.ok(document.querySelector('#req4Loan #req4ImMail'));
  assert.equal(document.querySelector('#req4ImMailResult').hidden,false);
  assert.equal(document.querySelector('#req4Mail').hidden,true);
  document.querySelector('#req4TabNuevas').click();
  assert.equal(document.querySelector('#req4Supply').hidden,false);
  assert.equal(document.querySelector('#req4Loan').hidden,true);
  assert.equal(document.querySelector('#req4Mail').hidden,false);
  assert.equal(document.querySelector('#req4FormTitle').textContent,'Solicitar cajas nuevas');
  assert.ok(document.querySelector('#req4Qty'));
  assert.ok(document.querySelector('#req4Submit'));
});

test('búsqueda, selección, solicitud registrada y correo IM reutilizan los mismos códigos',async()=>{
  let action=null,href='';
  window.HTMLAnchorElement.prototype.click=function(){href=this.href;};
  const repo={
    pickupMailConfig:async()=>({}),
    requirementsMail:async()=>({estado:'NO_ENVIADO'}),
    requestBoxes:async()=>[
      {clave:'cl1',codigo:'T00045',cargos:['300'],solicitable:true,prestamo:null,estado:'En IM',ubicacion:'Iron Mountain'},
      {clave:'cl2',codigo:'TD00046',cargos:['301'],solicitable:true,prestamo:null,estado:'En IM',ubicacion:'Iron Mountain'}
    ],
    requestAction:async(id,op,data)=>{
      action={id,op,data};
      return {id,numero:'REQ-IM-001',tipo:REQ_TYPES[1],cantidadCajas:2,fechaSolicitud:'2026-11-10',usuario:'Administrador',estadoV4:'Pendiente'};
    }
  };
  const req=setupRequirements(root,{repository:repo,context:()=>({...context(),mailPreviewMode:false}),refresh:async()=>{}});
  req.update([],{cajas:[]});
  document.querySelector('#req4TabPrestamo').click();
  document.querySelector('#req4Query').value='T00045';
  document.querySelector('#req4Search').click();
  await tick();
  for(const button of [...root.querySelectorAll('[data-req-select]')])button.click();
  document.querySelector('#req4ImMailGenerate').click();
  assert.match(document.querySelector('#req4ImMailBody').textContent,/T00045\r\nTD00046/);
  assert.equal(document.querySelector('#req4ImMailOutlook').disabled,true);
  const form=document.querySelector('#req4Form');
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await tick();await tick();
  assert.deepEqual(action.data,{tipo:'prestamo',cajas:['T00045','TD00046']});
  assert.equal(document.querySelector('#req4ImMailOutlook').disabled,false);
  assert.match(document.querySelector('#req4ImMailBody').textContent,/T00045\r\nTD00046/);
  assert.doesNotMatch(document.querySelector('#req4ImMailBody').textContent,/300|301|Cargos/);
  document.querySelector('#req4ImMailOutlook').click();
  assert.match(href,/subject=Solicitud%20de%202%20cajas%20a%20IM/);
});
