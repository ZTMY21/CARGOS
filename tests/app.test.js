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

async function app({allowed=true,isAdmin=true,failSave=false,signedIn=true,recovery=false,loginError=null}={}) {
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const source=(await readFile(new URL('../src/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const dom=new JSDOM(html,{url:'https://kardex.example.test'+(recovery?'#type=recovery':''),runScripts:'outside-only'});
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const state={reqs:[structuredClone(reqRow)],docs:[structuredClone(docRow)],updates:[],snapshots:0,events:[],status:null,authCallback:null};
  state.session=signedIn?{user:{id:'owner',email:'owner@example.test'}}:null;
  state.authCalls=[];
  const client={
    channel:()=>({on(event,filter,callback){state.events.push({filter,callback});return this;},subscribe(callback){state.status=callback;callback('SUBSCRIBED');return this;}}),
    removeChannel:async()=>{},
    auth:{getSession:async()=>({data:{session:state.session},error:null}),
      onAuthStateChange:callback=>{state.authCallback=callback;},
      signInWithPassword:async input=>{state.authCalls.push(['login',input]);if(loginError)return {error:loginError};state.session={user:{id:'owner',email:input.email}};state.authCallback('SIGNED_IN',state.session);return {error:null};},
      signInWithOtp:async input=>{state.authCalls.push(['link',input]);return {error:null};},
      resetPasswordForEmail:async(email,options)=>{state.authCalls.push(['recovery',email,options]);return {error:null};},
      updateUser:async input=>{state.authCalls.push(['updatePassword',input]);return {error:null};},
      signOut:async()=>{state.session=null;state.authCallback('SIGNED_OUT',null);return {error:null};}}
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

test('blank login page hides the entire Kardex until successful authentication and hides it on sign-out',async()=>{
 const a=await app({signedIn:false});
 try{
  assert.equal(a.node('appShell').hidden,true);assert.equal(a.node('authOverlay').hidden,false);
  assert.equal(a.node('authEmail').value,'');assert.equal(a.node('authPassword').value,'');
  assert.equal(a.state.snapshots,0);
  a.node('authEmail').value='JUANALEXIS717@GMAIL.COM';a.node('authPassword').value='test-password';
  a.node('authForm').dispatchEvent(new a.dom.window.Event('submit',{cancelable:true}));await flush();
  assert.equal(a.state.authCalls[0][1].email,'juanalexis717@gmail.com');
  assert.equal(a.node('authPassword').value,'');assert.equal(a.node('appShell').hidden,false);
  a.node('btnSignOut').click();await flush();
  assert.equal(a.node('appShell').hidden,true);assert.equal(a.node('authOverlay').hidden,false);
 }finally{a.close();}
});

test('invalid credentials explain recovery and leave the application hidden',async()=>{
 const a=await app({signedIn:false,loginError:{code:'invalid_credentials',message:'Invalid login credentials'}});
 try{
  a.node('authEmail').value='owner@example.test';a.node('authPassword').value='incorrect';
  a.node('authForm').dispatchEvent(new a.dom.window.Event('submit',{cancelable:true}));await flush();
  assert.match(a.node('authMessage').textContent,/Olvidé mi contraseña/);
  assert.equal(a.node('appShell').hidden,true);assert.equal(a.state.snapshots,0);
 }finally{a.close();}
});

test('recovery and email links use normalized email and never create new users',async()=>{
 const a=await app({signedIn:false});
 try{
  a.node('authEmail').value='OWNER@EXAMPLE.TEST';a.node('btnForgotPassword').click();await flush();
  assert.equal(a.state.authCalls[0][0],'recovery');assert.equal(a.state.authCalls[0][1],'owner@example.test');
  assert.equal(a.state.authCalls[0][2].redirectTo,'https://kardex.example.test/');
  assert.match(a.node('authMessage').textContent,/Spam/);
  a.node('btnMagicLink').click();await flush();
  assert.equal(a.state.authCalls[1][1].options.shouldCreateUser,false);
 }finally{a.close();}
});

test('recovery callback requires matching new passwords before loading the authorized application',async()=>{
 const a=await app({recovery:true});
 try{
  assert.equal(a.node('appShell').hidden,true);assert.equal(a.node('resetPasswordForm').hidden,false);
  assert.equal(a.state.snapshots,0);
  a.node('newPassword').value='new-password';a.node('confirmPassword').value='different';
  a.node('resetPasswordForm').dispatchEvent(new a.dom.window.Event('submit',{cancelable:true}));await flush();
  assert.match(a.node('authMessage').textContent,/no coinciden/);assert.equal(a.state.authCalls.length,0);
  a.node('confirmPassword').value='new-password';
  a.node('resetPasswordForm').dispatchEvent(new a.dom.window.Event('submit',{cancelable:true}));await flush();
  assert.equal(a.state.authCalls[0][0],'updatePassword');assert.equal(a.node('appShell').hidden,false);
  assert.equal(a.node('newPassword').value,'');assert.equal(a.node('confirmPassword').value,'');
 }finally{a.close();}
});

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
