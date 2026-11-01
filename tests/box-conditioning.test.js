import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {attachBoxConditioning} from '../src/box-conditioning-ui.js';

const makeDom=()=>{
 const ids=['conditionCode','conditionClass','conditionCargos','conditionIssue','conditionMessage',
   'conditionDetail','conditionSummary','conditionStart','conditionObserve','conditionResolve',
   'conditionFinish','conditionReload','conditionRetryDrive','boxSheetsStatus'];
 const html='<html><body>'+ids.map(id=>{
  if(id==='conditionClass')return '<select id="'+id+'"><option value="Cajas Nuevas">Cajas nuevas</option><option value="POR SOLICITUD">Por solicitud</option><option value="Reparación">Reparación</option></select>';
  if(id==='conditionIssue')return '<textarea id="'+id+'"></textarea>';
  if(id.startsWith('condition')&&/(Start|Observe|Resolve|Finish|Reload)$/.test(id))return '<button id="'+id+'"></button>';
  if(/^(conditionCode|conditionCargos)$/.test(id))return '<input id="'+id+'">';
  return '<div id="'+id+'"></div>';
 }).join('')+'</body></html>';
 return new JSDOM(html,{url:'https://kardex.example/'});
};
async function setup(preview=false){
 const dom=makeDom(),prevDoc=globalThis.document,prevConfirm=globalThis.confirm;
 globalThis.document=dom.window.document;globalThis.confirm=()=>true;
 let calls=[],record=null,sheetCalls=[];
 const supabase={rpc:async(method,params)=>{
  calls.push({method,params});
  if(method==='kardex_box_conditioning_list')return {data:record?[record]:[],error:null};
  const action=params.p_action,previous=record||{};
  record={code:'00990011',original_code:'TD00990011',cargos:['933','934'],
   classification:'POR SOLICITUD',status:action==='iniciar'?'EN_PREPARACION':
    action==='observar'?'OBSERVADA':action==='resolver'?'EN_PREPARACION':'LISTA',
   started_at:previous.started_at||'2026-11-01T10:00:00Z',
   finished_at:action==='finalizar'?'2026-11-01T10:14:00Z':null,
   observation:action==='observar'?params.p_observation:'',responsible_id:'admin',
   updated_at:'2026-11-01T10:14:00Z'};
  return {data:record,error:null};
 }};
 const sheetRequest=async(action,code)=>{
  sheetCalls.push({action,code});
  return {googleVerified:true,sourceSynced:action==='sync'&&record?.status==='LISTA'};
 };
 const ctl=attachBoxConditioning({supabase,isAdmin:()=>true,appReady:()=>true,isPreview:()=>preview,sheetRequest});
 const node=id=>dom.window.document.getElementById(id);
 const click=id=>node(id).click();
 const cleanup=()=>{ctl.reset();dom.window.close();
  if(prevDoc===undefined)delete globalThis.document;else globalThis.document=prevDoc;
  if(prevConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=prevConfirm;
 };
 ctl.activate();await new Promise(resolve=>setTimeout(resolve,0));
 return {ctl,node,click,calls,sheetCalls,cleanup};
}
const scanned={scan:{ok:true,original:'TD00990011',normalized:'00990011'},
 found:{found:true,cargos:['933','934'],clasificaciones:['POR SOLICITUD']}};

test('solo registra la preparación cuando el administrador confirma, y no duplica cajas',async()=>{
 const t=await setup();
 try{
  t.ctl.scan(scanned);
  assert.equal(t.node('conditionCargos').value,'933, 934');
  assert.equal(t.node('conditionClass').value,'POR SOLICITUD');
  assert.equal(t.calls.filter(x=>x.method==='kardex_box_conditioning_write').length,0);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(t.sheetCalls[0]?.action,'scan');
  assert.equal(t.sheetCalls[0]?.code,'TD00990011');
  t.click('conditionStart');await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(t.calls.filter(x=>x.method==='kardex_box_conditioning_write').length,1);
  assert.equal(t.calls.at(-1).params.p_action,'iniciar');
  assert.deepEqual(t.calls.at(-1).params.p_cargos,['933','934']);
  assert.match(t.node('conditionSummary').textContent,/1 en preparación/);
  assert.equal(t.node('conditionStart').disabled,true);
  t.node('conditionIssue').value='Etiqueta dañada';
  t.click('conditionObserve');await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(t.calls.at(-1).params.p_action,'observar');
  assert.match(t.node('conditionDetail').textContent,/Etiqueta dañada/);
  assert.equal(t.node('conditionFinish').disabled,true);
  t.click('conditionResolve');await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(t.calls.at(-1).params.p_action,'resolver');
  t.click('conditionFinish');await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(t.calls.at(-1).params.p_action,'finalizar');
  assert.match(t.node('conditionSummary').textContent,/1 listas para recojo/);
  assert.match(t.node('conditionMessage').textContent,/No se ha registrado su envío/);
  assert.equal(t.sheetCalls.some(x=>x.action==='sync'),true);
  assert.match(t.node('boxSheetsStatus').textContent,/CARGOS ENVIADOS/);
  assert.equal(t.node('conditionFinish').disabled,true);
 }finally{t.cleanup();}
});
test('la versión Preview no permite registrar ni finalizar acondicionamientos',async()=>{
 const t=await setup(true);
 try{
  t.ctl.scan(scanned);
  assert.equal(t.node('conditionStart').disabled,true);
  t.click('conditionStart');await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(t.calls.filter(x=>x.method==='kardex_box_conditioning_write').length,0);
  assert.equal(t.sheetCalls.length,0);
 }finally{t.cleanup();}
});
test('si no hay caja seleccionada no guarda nada',async()=>{
 const t=await setup();
 try{
  t.click('conditionStart');await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(t.calls.filter(x=>x.method==='kardex_box_conditioning_write').length,0);
 }finally{t.cleanup();}
});
