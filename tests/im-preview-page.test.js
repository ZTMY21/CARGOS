import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {mountImRequestPreview} from '../src/im-preview-entry.js';

const htmlUrl=new URL('../im-preview.html',import.meta.url);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function setup(html,url){
  const dom=new JSDOM(html,{url});
  globalThis.document=dom.window.document;
  globalThis.window=dom.window;
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  return dom;
}
function cleanup(dom){
  dom.window.close();
  delete globalThis.document;delete globalThis.window;
}

test('la preview usa el mismo encabezado y estilos de Requerimientos, sin login ni Supabase',async()=>{
  const html=await readFile(htmlUrl,'utf8');
  assert.match(html,/Kardex Digital — Control de Existencias Documentos Contables \(CD Santa Anita\)/);
  assert.match(html,/href="\/src\/connection\.css"/);
  assert.match(html,/id="grp-requerimientos" open/);
  assert.match(html,/id="req4Workspace" data-im-preview="1"/);
  assert.match(html,/src="\/src\/im-preview-entry\.js"/);
  assert.doesNotMatch(html,/supabase\.co|sb_secret_|sb_publishable_|id="authOverlay"/);
  const dom=setup(html,'https://preview-ztmy1.vercel.app/im-preview.html?reqMail=im');
  try{
    mountImRequestPreview(dom.window.document);
    const doc=dom.window.document;
    assert.equal(doc.querySelector('#req4Kind').value,'prestamo');
    assert.equal(doc.querySelector('#req4TabPrestamo').getAttribute('aria-selected'),'true');
    assert.equal(doc.querySelector('#req4Supply').hidden,true);
    assert.equal(doc.querySelector('#req4Loan').hidden,false);
    assert.equal(doc.querySelector('#req4Mail').hidden,true);
    assert.equal(doc.querySelector('#req4ImMail').hidden,true);
    assert.equal(doc.querySelector('#req4Form').hidden,false);
    assert.match(doc.querySelector('#req4Steps').textContent,/Buscar/);
    assert.match(doc.querySelector('#req4Steps').textContent,/Seleccionar/);
    assert.match(doc.querySelector('#req4Steps').textContent,/Solicitar/);
    assert.match(doc.querySelector('.im-demo-banner').textContent,/botón Solicitar solo simula/);
  }finally{cleanup(dom);}
});

test('el correo aparece al final del flujo de Solicitudes a IM solo después de una solicitud simulada',async()=>{
  const html=await readFile(htmlUrl,'utf8');
  const dom=setup(html,'https://preview-ztmy1.vercel.app/im-preview.html?reqMail=im');
  try{
    mountImRequestPreview(dom.window.document);
    const doc=dom.window.document;
    doc.querySelector('#req4Query').value='T';
    doc.querySelector('#req4Search').click();
    await tick();
    const choices=[...doc.querySelectorAll('[data-req-select]')];
    assert.equal(choices.length,2);
    choices.forEach(button=>button.click());
    assert.equal(doc.querySelector('#req4ImMail').hidden,true);
    const selected=doc.querySelector('#req4Selected').textContent;
    assert.match(selected,/T00045/);
    assert.match(selected,/TD00046/);
    doc.querySelector('#req4Form').dispatchEvent(new dom.window.Event('submit',{
      bubbles:true,cancelable:true
    }));
    await tick();await tick();
    assert.equal(doc.querySelector('#req4ImMail').hidden,false);
    assert.equal(doc.querySelector('#req4ImMailSubject').textContent,'Solicitud de 2 cajas a IM | CD Santa Anita |');
    assert.equal(doc.querySelector('#req4ImMailTo').textContent,
      'joramos@farmaciasperuanas.pe; alopezv@farmaciasperuanas.pe; bsalvador@farmaciasperuanas.pe');
    assert.equal(doc.querySelector('#req4ImMailCc').textContent,'fp-qs-liquidaciones@intercorpretail.pe');
    assert.match(doc.querySelector('#req4ImMailBody').textContent,/T00045\r\nTD00046/);
    assert.doesNotMatch(doc.querySelector('#req4ImMailBody').textContent,/Cargos|300|301|Factura|Guía|Requerimiento:/);
    assert.equal(doc.querySelector('#req4ImMailOutlook').disabled,true);
    assert.match(doc.querySelector('#req4Status').textContent,/no se ha guardado en el aplicativo/i);
    assert.ok(doc.querySelector('#req4Form').compareDocumentPosition(doc.querySelector('#req4ImMail')) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  }finally{cleanup(dom);}
});

test('el correo no modifica la pestaña Cajas nuevas y su formulario original',async()=>{
  const html=await readFile(htmlUrl,'utf8');
  const dom=setup(html,'https://preview-ztmy1.vercel.app/im-preview.html?reqMail=im');
  try{
    mountImRequestPreview(dom.window.document);
    const doc=dom.window.document;
    doc.querySelector('#req4TabNuevas').click();
    assert.equal(doc.querySelector('#req4Supply').hidden,false);
    assert.equal(doc.querySelector('#req4Loan').hidden,true);
    assert.equal(doc.querySelector('#req4Mail').hidden,false);
    assert.equal(doc.querySelector('#req4ImMail').hidden,true);
    assert.equal(doc.querySelector('#req4FormTitle').textContent,'Solicitar cajas nuevas');
    assert.ok(doc.querySelector('#req4Qty'));
  }finally{cleanup(dom);}
});
