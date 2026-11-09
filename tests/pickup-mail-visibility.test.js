import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {attachPickupMail} from '../src/pickup-mail-ui.js';
import {attachInterventionExperience} from '../src/intervention-experience.js';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));

test('el ejemplo desde la bandeja aparece visible y no guarda ni envía ningún aviso',async()=>{
 const dom=new JSDOM(html,{url:'https://kardex.example/'});
 const old=globalThis.document;
 const d=dom.window.document;
 globalThis.document=d;
 const calls=[],details=d.getElementById('pickupPreviewDetails');
 let scrolled=0;
 details.scrollIntoView=()=>{scrolled++;};
 const supabase={rpc:async(name)=>{
  calls.push(name);
  if(name==='kardex_pickup_mail_state')return {data:{ready:0,config:{},batches:[]},error:null};
  if(name==='kardex_pickup_mail_brand_state')return {data:{},error:null};
  throw Error('No se puede escribir en esta prueba: '+name);
 }};
 const pickup=attachPickupMail({supabase,isAdmin:()=>true,appReady:()=>true,isPreview:()=>true,
  mailRequest:async()=>{throw Error('La simulación no llama a la API.');}});
 const enhanced=attachInterventionExperience({doc:d});
 try{
  pickup.activate();
  await settle();
  assert.equal(details.open,false);
  assert.equal(d.getElementById('pickupMailPreview').hidden,true);
  assert.equal(d.getElementById('pickupMailPreviewEmpty').hidden,false);
  assert.equal(d.getElementById('pickupMailBatches').textContent,'Sin correos preparados.');
  d.getElementById('ivMailSimShortcut').click();
  await settle();
  assert.equal(details.open,true);
  assert.equal(d.getElementById('pickupMailPreview').hidden,false);
  assert.equal(d.getElementById('pickupMailPreviewEmpty').hidden,true);
  assert.ok(scrolled>0,'debe llevar al usuario a donde aparece la simulación');
  assert.match(d.getElementById('pickupMailPreviewMeta').textContent,/SIMULACIÓN/);
  const doc=d.getElementById('pickupMailPreview').srcdoc;
  assert.match(doc,/SIMULACIÓN INTERNA/);
  assert.match(doc,/TD-DEMO-030/);
  assert.match(doc,/II INGRESO DE CAJAS A IRON MOUNTAIN/);
  assert.match(doc,/joramos@farmaciasperuanas\.pe/);
  assert.match(doc,/Formato IM-DYT \(DEVOLUCIONES\)\.xlsx/);
  assert.equal(d.getElementById('pickupOutlookProposal'),null,'no debe existir apartado duplicado');
  assert.ok(calls.every(n=>n==='kardex_pickup_mail_state'||n==='kardex_pickup_mail_brand_state'));
 }finally{
  enhanced.disconnect();
  pickup.reset();
  if(old===undefined)delete globalThis.document;
  else globalThis.document=old;
  dom.window.close();
 }
});

test('Ver correo sin avisos reales muestra instrucciones y permite simular desde el panel',async()=>{
 const dom=new JSDOM(html,{url:'https://kardex.example/'});
 const old=globalThis.document;globalThis.document=dom.window.document;
 const d=dom.window.document;
 const supabase={rpc:async name=>{
  if(name==='kardex_pickup_mail_state')return {data:{ready:0,config:{},batches:[]},error:null};
  if(name==='kardex_pickup_mail_brand_state')return {data:{},error:null};
  throw Error('Escritura no autorizada en prueba');
 }};
 const pickup=attachPickupMail({supabase,isAdmin:()=>true,appReady:()=>true,isPreview:()=>true});
 try{
  pickup.activate();
  await settle();
  const panel=d.getElementById('pickupPreviewDetails');
  panel.open=true;
  assert.equal(d.getElementById('pickupMailPreviewEmpty').hidden,false);
  assert.equal(d.getElementById('pickupMailPreview').hidden,true);
  d.getElementById('pickupPreviewTrySample').click();
  assert.equal(d.getElementById('pickupMailPreviewEmpty').hidden,true);
  assert.equal(d.getElementById('pickupMailPreview').hidden,false);
  assert.match(d.getElementById('pickupMailPreview').srcdoc,/SIMULACIÓN INTERNA/);
 }finally{
  pickup.reset();
  if(old===undefined)delete globalThis.document;else globalThis.document=old;
  dom.window.close();
 }
});

test('preview aislada sin RPC conserva la simulación en Ver correo generado sin preparar lotes',async()=>{
 const dom=new JSDOM(html,{url:'https://preview.example.com'});
 const old=globalThis.document;globalThis.document=dom.window.document;
 const d=dom.window.document;
 const calls=[];
 const supabase={rpc:async(name)=>{calls.push(name);return {data:null,error:{code:'PGRST202',message:'RPC unavailable in isolated preview'}};}};
 const pickup=attachPickupMail({supabase,isAdmin:()=>true,appReady:()=>true,isPreview:()=>true,
  mailRequest:async()=>{throw Error('La demo nunca solicita enviar un correo');}});
 try {
  pickup.activate();await settle();
  assert.match(d.getElementById('pickupMailCounts').textContent,/Sin datos reales/);
  assert.equal(d.getElementById('pickupPrepare').disabled,true);
  assert.equal(d.getElementById('pickupOutlookProposal'),null);
  d.getElementById('ivMailSimShortcut').click();
  await settle();
  const preview=d.getElementById('pickupMailPreview');
  assert.equal(d.getElementById('pickupPreviewDetails').open,true);
  assert.equal(preview.hidden,false);
  assert.match(preview.srcdoc,/IM-\d{8} II INGRESO DE CAJAS A IRON MOUNTAIN/);
  assert.match(preview.srcdoc,/bsalvador@farmaciasperuanas\.pe/);
  assert.match(preview.srcdoc,/fp-qs-liquidaciones@intercorpretail\.pe/);
  assert.equal(calls.filter(n=>/prepare|configure|mark/.test(n)).length,0);
 } finally {
  pickup.reset();
  if(old===undefined)delete globalThis.document;else globalThis.document=old;
  dom.window.close();
 }
});
