import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {attachPickupWorkflow} from '../src/pickup-workflow-ui.js';

test('avisos: pendientes arriba, nuevas/devolucion separadas y PDF en ventana sin escrituras', async()=>{
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const previous=globalThis.document;
  globalThis.document=dom.window.document;
  const el=id=>document.getElementById(id);
  for(const id of ['pickupDialog','pickupPdfViewDialog','pickupMailViewDialog']){
    const dialog=el(id);
    dialog.showModal=()=>dialog.setAttribute('open','');
    dialog.close=()=>{dialog.removeAttribute('open');dialog.dispatchEvent(new dom.window.Event('close'));};
  }
  const newBox={type:'NUEVAS',code:'T2044202010',key:'2044202010'};
  const sentNew={type:'NUEVAS',code:'T2044202011',key:'2044202011'};
  const returned={type:'DEVOLUCION',code:'T2044202012',key:'2044202012'};
  const pending={id:'d222eae7-22ac-496b-ba22-d85f8579c05f',status:'CONFIRMADO',
    created_at:'2026-11-21T13:58:53Z',subject:'IM-20261121 II INGRESO DE CAJAS A IRON MOUNTAIN',
    boxes:[newBox],schedule:{},visits:[],events:[]};
  const complete={id:'b6bd8177-7f02-4dd9-9f4d-133e70d918cf',status:'CONFIRMADO',
    created_at:'2026-11-09T03:21:41Z',subject:'IM-20261108 II INGRESO DE CAJAS A IRON MOUNTAIN',
    boxes:[sentNew,returned],schedule:{NUEVAS:'2026-11-13',DEVOLUCION:'2026-11-16'},
    visits:[
      {id:'one',date:'2026-11-13',codes:[sentNew.code],actor:'Operador',synced:true,master:true,history:true,name:'nuevas.pdf'},
      {id:'two',date:'2026-11-16',codes:[returned.code],actor:'Operador',synced:true,master:true,history:true,name:'devolucion.pdf'}
    ],events:[]};
  let writes=0,pdfReads=0;
  const workflow={
    async state(){return {available:[],batches:[complete,pending]};},
    async pdf(){pdfReads++;return new Blob(['%PDF-1.7'],{type:'application/pdf'});},
    async confirm(){writes++;},async schedule(){writes++;},async prepare(){writes++;}
  };
  try{
    const ui=attachPickupWorkflow({workflow,showPreview(){},notify(){}});
    await ui.activate();
    const cards=[...document.querySelectorAll('#pickupMailBatches>.prepared-im-box')];
    assert.equal(cards.length,3);
    assert.match(cards[0].textContent,/AV-D222EAE7/);
    assert.match(cards[0].textContent,/Retiro pendiente/);
    assert.match(cards[1].textContent,/nuevas/i);
    assert.match(cards[2].textContent,/devolución/i);
    assert.match(cards[1].textContent,/Recojo confirmado/);
    assert.match(cards[2].textContent,/Recojo confirmado/);
    const button=[...cards[1].querySelectorAll('button')].find(x=>x.textContent==='Ver PDF');
    button.click();
    for(let i=0;i<12&&!el('pickupPdfViewDialog').open;i++)await new Promise(r=>setTimeout(r,0));
    assert.equal(el('pickupPdfViewDialog').open,true);
    assert.match(el('pickupPdfFrame').src,/^blob:/);
    assert.equal(pdfReads,1);
    el('pickupPdfClose').click();
    assert.equal(el('pickupPdfViewDialog').open,false);
    const filter=[...el('pickupViewFilters').querySelectorAll('button')].find(b=>b.textContent==='Devolución');
    filter.click();
    assert.equal(document.querySelectorAll('#pickupMailBatches>.prepared-im-box').length,1);
    el('pickupViewEmails').click();
    assert.match(el('pickupDialog').textContent,/AV-D222EAE7/);
    assert.equal(writes,0);
  }finally{
    globalThis.document=previous;
    dom.window.close();
  }
});
