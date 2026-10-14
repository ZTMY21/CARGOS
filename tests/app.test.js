import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {computeReqEstado as reqEstado,computeDocEstado as docEstado,fmtDate,escapeHtml} from '../src/rules.js';
import {reqFromDb,docFromDb,KardexRepository} from '../src/repository.js';
import {buildWorkbook,parseWorkbook} from '../src/excel.js';
import {highlightMatch,filterDocuments,filterRequirements} from '../src/search.js';

const flush=()=>new Promise(resolve=>setTimeout(resolve,20));
const reqRow={id:randomUUID(),numero:'REQ-00001',tipo:'Cajas nuevas para acondicionar',fecha_solicitud:'2026-10-01',cantidad_cajas:2,numeros_cargo:'',fecha_recepcion:'2026-10-02',fecha_devolucion:null,usuario:'Juan',updated_at:'2026-10-13T00:00:00.123456Z'};
const docRow={id:randomUUID(),kardex:'SA-00001',fecha_registro:'2026-10-13',tipo_doc:'Facturas-Guia',periodo:'2026-01-01',ubicacion:'Santa Anita',folios:30,cargos:['C001'],caja_asignada:reqRow.id,f_envio:null,sustento:'',sustento_imagen:'',usuario:'Juan',facturas:'F-001',obs:'',updated_at:'2026-10-13T00:00:00.123456Z'};

async function app({allowed=true,isAdmin=true,failSave=false}={}) {
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const source=(await readFile(new URL('../src/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const dom=new JSDOM(html,{url:'https://kardex.example.test',runScripts:'outside-only'});
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const state={reqs:[structuredClone(reqRow)],docs:[structuredClone(docRow)],updates:[],snapshots:0,events:[],status:null,authCallback:null};
  const client={
    channel:()=>({on(event,filter,callback){state.events.push({filter,callback});return this;},subscribe(callback){state.status=callback;callback('SUBSCRIBED');return this;}}),
    removeChannel:async()=>{},
    auth:{getSession:async()=>({data:{session:{user:{id:'owner',email:'owner@example.test'}}},error:null}),
      onAuthStateChange:callback=>{state.authCallback=callback;},signOut:async()=>{state.authCallback('SIGNED_OUT',null);return {error:null};}}
  };
  class FakeRepository {
    async access(){return {allowed,is_admin:isAdmin};}
    async snapshot(){state.snapshots++;return structuredClone({requerimientos:state.reqs,documentos:state.docs});}
    async saveDoc(data,editing){
      state.updates.push({data,editing});if(failSave)throw new Error('Servidor no disponible');
      if(editing){const existing=state.docs.find(r=>r.id===editing.id);if(existing.updated_at!==editing.updatedAt)throw new Error('Otro usuario modificó el registro');}
      return {...data,kardex:'SA-00002'};
    }
    async saveReq(data,editing){state.updates.push({data,editing});if(failSave)throw new Error('Servidor no disponible');return {...data,numero:'REQ-00002'};}
    async remove(table,row){
      if(table==='requerimientos'){state.reqs=state.reqs.filter(r=>r.id!==row.id);state.docs.forEach(d=>{if(d.caja_asignada===row.id)d.caja_asignada=null;});}
      else state.docs=state.docs.filter(d=>d.id!==row.id);
    }
  }
  const context=dom.getInternalVMContext();
  Object.assign(context,{createClient:()=>client,KardexRepository:FakeRepository,reqFromDb,docFromDb,reqEstado,docEstado,fmtDate,escapeHtml,buildWorkbook,parseWorkbook,highlightMatch,filterDocuments,filterRequirements,
    __SUPABASE_URL__:'https://example.supabase.co',__SUPABASE_ANON_KEY__:'sb_publishable_test',confirm:()=>true,alert:()=>{}});
  await vm.runInContext(`(async()=>{${source}})()`,context);
  const node=id=>dom.window.document.getElementById(id);
  return {dom,state,node,close(){dom.window.close();}};
}

test('connected screen preserves conditional fields, live indicators, search and XSS protection',async()=>{
  const a=await app();
  try {
    assert.equal(a.node('authOverlay').hidden,true);
    assert.equal(a.node('rq_wrap_cantidad').hidden,false);
    assert.equal(a.node('rq_wrap_cargos').hidden,true);
    assert.equal(a.node('rq_wrap_devolucion').hidden,true);
    a.node('rq_tipo').value='Préstamo de Cajas (búsqueda de documentos)';
    a.node('rq_tipo').dispatchEvent(new a.dom.window.Event('change'));
    assert.equal(a.node('rq_wrap_cantidad').hidden,true);
    assert.equal(a.node('rq_wrap_cargos').hidden,false);
    assert.equal(a.node('rq_wrap_devolucion').hidden,false);
    assert.ok(a.node('resumenTablas').textContent.includes('30 folios'));
    a.node('buscar').value='F-001';a.node('buscar').dispatchEvent(new a.dom.window.Event('input'));
    assert.ok(a.node('tbody').textContent.includes('SA-00001'));
    a.node('buscar').value='no existe';a.node('buscar').dispatchEvent(new a.dom.window.Event('input'));
    assert.ok(a.node('tbody').textContent.includes('Sin registros'));
    a.node('buscar').value='';
    a.state.docs[0].usuario='<img src=x onerror=alert(1)>';
    a.node('btnReconnect').click();await flush();
    assert.equal(a.node('tbody').querySelectorAll('img').length,0);
    assert.ok(a.node('tbody').textContent.includes('<img src=x'));
    const events=a.state.events.map(x=>x.filter.table);
    assert.ok(events.includes('kardex_eventos'));assert.ok(!events.includes('documentos'));
    a.state.docs[0].f_envio='2026-10-13';a.state.docs[0].sustento='Guía de Traslado';
    a.state.events.find(x=>x.filter.table==='kardex_eventos').callback();
    await new Promise(resolve=>setTimeout(resolve,240));
    assert.ok(a.node('tbody').textContent.includes('Enviado a Iron Mountain'));
    assert.equal(a.node('connectionStatus').textContent,'Conectado en línea — Sincronizado');
  } finally {a.close();}
});
test('edit retains original version when another screen changes the record',async()=>{
  const a=await app();
  try {
    a.node('tbody').querySelector('button.link').click();
    const originalVersion=a.state.docs[0].updated_at;
    a.state.docs[0].updated_at='2026-10-13T01:00:00.000001Z';
    a.state.docs[0].obs='Nota de otro usuario';
    a.node('btnReconnect').click();await flush();
    a.node('f_obs').value='Mi borrador';a.node('btnGuardar').click();await flush();
    assert.equal(a.state.updates[0].editing.updatedAt,originalVersion);
    assert.ok(a.node('msgGuardado').textContent.includes('Otro usuario'));
    assert.equal(a.node('f_obs').value,'Mi borrador');
  } finally {a.close();}
});
test('failed save keeps the form and never claims success; requirement deletion unlinks documents',async()=>{
  const a=await app({failSave:true});
  try {
    a.node('f_usuario').value='Juan';a.node('f_periodo').value='2026-09-01';a.node('f_cargo1').value='C-002';
    a.node('btnGuardar').click();await flush();
    assert.equal(a.node('f_cargo1').value,'C-002');
    assert.ok(a.node('msgGuardado').textContent.includes('Servidor no disponible'));
    assert.ok(!a.node('msgGuardado').textContent.includes('guardado.'));
    a.node('tbodyReq').querySelector('button.danger').click();await flush();
    assert.equal(a.state.reqs.length,0);assert.equal(a.state.docs[0].caja_asignada,null);
    assert.ok(a.node('tbody').textContent.includes('Pendiente de Envío'));
  } finally {a.close();}
});
test('unauthorized accounts remain blocked and editor cannot reset/import',async()=>{
  const denied=await app({allowed:false});
  try {assert.equal(denied.node('authOverlay').hidden,false);assert.equal(denied.node('btnGuardar').disabled,true);assert.ok(denied.node('authMessage').textContent.includes('no está autorizada'));}finally{denied.close();}
  const editor=await app({isAdmin:false});
  try {assert.equal(editor.node('btnGuardar').disabled,false);assert.equal(editor.node('btnReset').disabled,true);assert.equal(editor.node('btnImportar').disabled,true);}finally{editor.close();}
});
test('repository update always filters by the original timestamp and asks Supabase to confirm the result',async()=>{
  const calls=[];
  const builder={update(data){calls.push(['update',data]);return this;},eq(key,value){calls.push(['eq',key,value]);return this;},async select(){return {data:[],error:null};}};
  const repo=new KardexRepository({from:table=>{calls.push(['from',table]);return builder;}});
  await assert.rejects(repo.saveDoc(docFromDb(docRow),{id:docRow.id,updatedAt:docRow.updated_at}),/Otro usuario/);
  assert.deepEqual(calls.filter(c=>c[0]==='eq'),[['eq','id',docRow.id],['eq','updated_at',docRow.updated_at]]);
});
