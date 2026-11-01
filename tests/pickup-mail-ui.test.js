import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {attachPickupMail} from '../src/pickup-mail-ui.js';

const ids=['pickupMailStatus','pickupMailCounts','pickupMailBatches','pickupMailPreview',
 'pickupMailPreviewMeta','pickupSender','pickupTo','pickupCc','pickupName','pickupPosition',
 'pickupArea','pickupCompany','pickupContact','pickupSaveConfig','pickupPrepare','pickupReload',
 'pickupSubject','pickupGreeting','pickupIntroduction','pickupRequest','pickupClosing',
 'pickupLogoFile','pickupLogoPreview','pickupLogoStatus','pickupLogoClear','pickupSample'];
function createDom(){
 const markup='<html><body>'+ids.map(id=>id==='pickupLogoPreview'
 ?'<img id="'+id+'">'
 :id==='pickupLogoFile'?'<input id="'+id+'" type="file">'
 :['pickupIntroduction','pickupRequest','pickupClosing'].includes(id)
 ?'<textarea id="'+id+'"></textarea>'
 :id==='pickupMailPreview'
 ?'<iframe id="'+id+'"></iframe>'
 :['pickupSaveConfig','pickupPrepare','pickupReload','pickupLogoClear','pickupSample'].includes(id)
 ?'<button id="'+id+'"></button>'
 :['pickupMailStatus','pickupMailCounts','pickupMailBatches','pickupMailPreviewMeta','pickupLogoStatus'].includes(id)
 ?'<div id="'+id+'"></div>'
 :'<input id="'+id+'">').join('')+'</body></html>';
 return new JSDOM(markup,{url:'https://app.example.com/'});
}
async function make({preview=false,ready=30,configured=true}={}){
 const dom=createDom(),prevDoc=globalThis.document,prevConfirm=globalThis.confirm;
 globalThis.document=dom.window.document;globalThis.confirm=()=>true;
 const calls=[];let batches=[];
 const cfg=configured?{sender:'remitente@example.com',to:['jorge@example.com'],cc:[],
   name:'Nombre de prueba',position:'Logística',area:'Archivo',company:'Empresa de prueba',contact:'123'}:
   {sender:'',to:[],cc:[],name:'',company:''};
 const supabase={rpc:async(name,args)=>{
  calls.push({name,args});
  if(name==='kardex_pickup_mail_state')return {data:{ready,config:cfg,batches},error:null};
  if(name==='kardex_pickup_mail_configure')return {data:{saved:true},error:null};
  if(name==='kardex_pickup_mail_prepare'){
    batches=[{id:'123e4567-e89b-12d3-a456-426614174000',
      subject:'Solicitud de recojo de 30 cajas nuevas',created_at:'2026-11-01T15:00:00Z',
      status:'PENDIENTE',boxes:30}];
    return {data:{count:30,id:batches[0].id,status:'PENDIENTE'},error:null};
  }
  if(name==='kardex_pickup_mail_mark'){
    batches[0].status='CONFIRMADO';return {data:{status:'CONFIRMADO'},error:null};
  }
  throw Error('RPC inesperada '+name);
 }};
 const requests=[];
 const mailRequest=async(action,id)=>{
  requests.push({action,id});
  if(action==='preview')return {to:['jorge@example.com'],cc:[],boxes:30,
    subject:'Solicitud de recojo',html:'<p>Vista previa de prueba</p>'};
  throw Error('No enviar ni descargar en esta prueba');
 };
 const ui=attachPickupMail({supabase,isAdmin:()=>true,appReady:()=>true,isPreview:()=>preview,mailRequest});
 const node=id=>dom.window.document.getElementById(id);
 ui.activate();await new Promise(resolve=>setTimeout(resolve,0));
 return {
  ui,dom,node,calls,requests,
  async click(id){node(id).click();await new Promise(resolve=>setTimeout(resolve,0));},
  cleanup(){ui.reset();dom.window.close();
   if(prevDoc===undefined)delete globalThis.document;else globalThis.document=prevDoc;
   if(prevConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=prevConfirm;}
 };
}
test('30 cajas: prepara borrador y vista previa sin enviar correo real',async()=>{
 const t=await make();
 try{
  assert.match(t.node('pickupMailCounts').textContent,/30 cajas nuevas/);
  assert.equal(t.node('pickupPrepare').disabled,false);
  await t.click('pickupPrepare');
  assert.equal(t.calls.filter(x=>x.name==='kardex_pickup_mail_prepare').length,1);
  assert.match(t.node('pickupMailBatches').textContent,/Solicitud de recojo/);
  const button=[...t.node('pickupMailBatches').querySelectorAll('button')]
    .find(x=>x.textContent==='Vista previa');
  button.click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(t.requests[0].action,'preview');
  assert.match(t.node('pickupMailPreviewMeta').textContent,/jorge@example.com/);
  assert.equal(t.calls.filter(x=>x.name==='kardex_pickup_mail_mark').length,0);
 }finally{t.cleanup();}
});
test('con menos de 30 cajas no crea un aviso',async()=>{
 const t=await make({ready:29});
 try{
  assert.match(t.node('pickupMailCounts').textContent,/Faltan 1/);
  assert.equal(t.node('pickupPrepare').disabled,true);
  await t.click('pickupPrepare');
  assert.equal(t.calls.filter(x=>x.name==='kardex_pickup_mail_prepare').length,0);
 }finally{t.cleanup();}
});
test('Preview muestra datos pero nunca prepara ni configura ni confirma',async()=>{
 const t=await make({preview:true});
 try{
  assert.equal(t.node('pickupPrepare').disabled,true);
  assert.equal(t.node('pickupSaveConfig').disabled,true);
  await t.click('pickupPrepare');await t.click('pickupSaveConfig');
  assert.equal(t.calls.filter(x=>x.name==='kardex_pickup_mail_prepare').length,0);
  assert.equal(t.calls.filter(x=>x.name==='kardex_pickup_mail_configure').length,0);
 }finally{t.cleanup();}
});


test('vista simulada usa 30 cajas ficticias sin confirmar ni escribir registros',async()=>{
 const t=await make();
 try{
  t.node('pickupName').value='Angelo';
  t.node('pickupPosition').value='Operador Integral | BPDT - Liquidaciones';
  await t.click('pickupSample');
  assert.match(t.node('pickupMailPreviewMeta').textContent,/Simulación/);
  assert.match(t.node('pickupMailPreview').srcdoc,/SIMULACIÓN INTERNA/);
  assert.match(t.node('pickupMailPreview').srcdoc,/TD-DEMO-030/);
  assert.match(t.node('pickupMailPreview').srcdoc,/Angelo/);
  assert.equal(t.calls.filter(x=>x.name==='kardex_pickup_mail_prepare').length,0);
  assert.equal(t.calls.filter(x=>x.name==='kardex_pickup_mail_mark').length,0);
  assert.equal(t.requests.length,0);
 }finally{t.cleanup();}
});
