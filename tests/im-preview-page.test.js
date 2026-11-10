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
  delete globalThis.document;
  delete globalThis.window;
}

test('la ruta IM muestra el formulario correcto sin sesión de usuario ni datos reales',async()=>{
  const html=await readFile(htmlUrl,'utf8');
  assert.match(html,/id="req4Workspace" data-im-preview="1"/);
  assert.match(html,/src="\/src\/im-preview-entry\.js"/);
  assert.doesNotMatch(html,/supabase\.co|sb_secret_|sb_publishable_/);
  const dom=setup(html,'https://preview-ztmy1.vercel.app/im-preview.html?reqMail=im');
  try{
    mountImRequestPreview(dom.window.document);
    assert.equal(dom.window.document.querySelector('#req4Kind').value,'prestamo');
    assert.equal(dom.window.document.querySelector('#req4TabPrestamo').getAttribute('aria-selected'),'true');
    assert.equal(dom.window.document.querySelector('#req4Loan').hidden,false);
    assert.equal(dom.window.document.querySelector('#req4Form').hidden,false);
    assert.equal(dom.window.document.querySelector('#req4Mail').hidden,true);
    const demo=dom.window.document.querySelector('#req4ImMailResult');
    assert.equal(demo.hidden,false);
    assert.equal(dom.window.document.querySelector('#req4ImMailSubject').textContent,
      'Solicitud de 3 cajas a IM | CD Santa Anita |');
    assert.match(dom.window.document.querySelector('#req4ImMailBody').textContent,
      /T00045\r\nTD00046\r\nP00078/);
    assert.equal(dom.window.document.querySelector('#req4ImMailOutlook').disabled,true);
    assert.match(dom.window.document.querySelector('.im-demo-banner').textContent,/No conecta con solicitudes reales/);
  }finally{cleanup(dom);}
});

test('la demo IM permite buscar y seleccionar códigos sin enviar solicitudes',async()=>{
  const html=await readFile(htmlUrl,'utf8');
  const dom=setup(html,'https://preview-ztmy1.vercel.app/im-preview.html?reqMail=im');
  try{
    mountImRequestPreview(dom.window.document);
    const doc=dom.window.document;
    doc.querySelector('#req4Query').value='T';
    doc.querySelector('#req4Search').click();
    await tick();
    const choices=doc.querySelectorAll('[data-req-select]');
    assert.equal(choices.length,2);
    choices[0].click();choices[1].click();
    doc.querySelector('#req4ImMailGenerate').click();
    assert.equal(doc.querySelector('#req4ImMailSubject').textContent,
      'Solicitud de 2 cajas a IM | CD Santa Anita |');
    assert.match(doc.querySelector('#req4ImMailBody').textContent,/T00045\r\nTD00046/);
    assert.doesNotMatch(doc.querySelector('#req4ImMailBody').textContent,/Cargos|300|301|Factura|Guía/);
    assert.equal(doc.querySelector('#req4ImMailOutlook').disabled,true);
    doc.querySelector('#req4Form').dispatchEvent(new dom.window.Event('submit',{
      bubbles:true,cancelable:true
    }));
    await tick();
    assert.match(doc.querySelector('#req4Status').textContent,/no se guardan solicitudes reales/);
  }finally{cleanup(dom);}
});
