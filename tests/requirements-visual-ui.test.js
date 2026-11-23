import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {setupRequirements} from '../src/requirements-ui.js';
import {REQ_TYPES} from '../src/rules.js';

test('Requerimientos: 200 precintos visibles en correo sin crear ni modificar cajas recibidas', async()=>{
 const dom=new JSDOM('<!doctype html><html><body><main id="work"></main></body></html>',{url:'https://example.test/'});
 const root=dom.window.document.getElementById('work');
 const row={
  id:'f0ca8384-4239-4baa-b41e-409127ad0002',numero:'REQ-00002',tipo:REQ_TYPES[0],
  fechaSolicitud:'2026-11-16',cantidadCajas:100,usuario:'Juan Alexis',
  estadoV4:'Solicitado',recibidoV4:0,fechaRecepcion:null
 };
 let writes=0;
 const repository={
  async requestAction(){writes++;throw Error('No debería grabar la solicitud bloqueada');},
  async pickupMailConfig(){return {};},
  async requirementsMail(){return {estado:'PENDIENTE'};}
 };
 const ctx=()=>({allowed:true,mailAccess:true,mailPreviewMode:false,id:'usuario',name:'Juan Alexis'});
 const api=setupRequirements(root,{repository,context:ctx,refresh:async()=>{},receptionEnabled:true});
 const dialog=dom.window.document.getElementById('req4Dialog');
 dialog.showModal=()=>dialog.setAttribute('open','');
 dialog.close=()=>dialog.removeAttribute('open');
 const track={suministro:{solicitudes:[{id:row.id,guardadas:0,confirmada:null,pendientes:100}]},movimientos:[
  {requerimiento:row.id,tipo:'crear',datos:{tipo:'nuevas',cantidad:100}}
 ]};
 api.update([row],track);
 const el=id=>dom.window.document.getElementById(id);
 assert.equal(el('req4Qty').disabled,true);
 assert.equal(el('req4Submit').disabled,true);
 assert.equal(el('req4Precintos').disabled,false);
 el('req4Precintos').value='200';
 el('req4Precintos').dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 const detail=root.querySelector('button[data-req-open]');
 detail.click();
 assert.match(el('req4DialogBody').textContent,/200 \(solo borrador del correo; sin registrar\)/);
 dialog.close();
 const view=root.querySelector('button[data-req-mail]');
 view.click();
 for(let n=0;n<30&&!el('req4MailBody').textContent.includes('200 precintos');n++){
  await new Promise(resolve=>setTimeout(resolve,0));
 }
 assert.match(el('req4MailBody').textContent,/Estimado @Jorge Ramos/);
 assert.match(el('req4MailBody').textContent,/• 100 Cajas nuevas/);
 assert.match(el('req4MailBody').textContent,/• 200 precintos/);
 assert.equal(row.cantidadCajas,100);
 assert.equal(row.recibidoV4,0);
 assert.equal(writes,0);
 dom.window.close();
});
