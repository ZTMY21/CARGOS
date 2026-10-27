import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {computeReqEstado as reqEstado,computeDocEstado as docEstado,fmtDate,escapeHtml,limaDate} from '../src/rules.js';
import {reqFromDb,docFromDb,KardexRepository} from '../src/repository.js';
import {buildWorkbook,parseWorkbook} from '../src/excel.js';
import {highlightMatch,filterDocuments,filterRequirements,invoiceSearchPresentation,assignedBoxCode} from '../src/search.js';
import {createIdleSession} from '../src/idle-session.js';
import {cargoYear,invoiceLocation,locationLabel,groupsForCodes} from '../src/cargo-details.js';
import {cargoExpiryGroups,formatCargoDuration} from '../src/cargo-expiry.js';
import {requestedIMBoxes,countRequestedCargos,summarizePreparedIm} from '../src/im-requests.js';
import {summarizeShippedBoxes} from '../src/im-shipped-summary.js';
import {summarizeCreatedCargos} from '../src/monthly-created-summary.js';
import {renderImBarChart} from '../src/im-bar-chart.js';
import {renderCargoLineChart} from '../src/cargo-line-chart.js';

const flush=()=>new Promise(resolve=>setTimeout(resolve,20));
const reqRow={id:randomUUID(),numero:'REQ-00001',tipo:'Cajas nuevas para acondicionar',fecha_solicitud:'2026-10-01',cantidad_cajas:2,numeros_cargo:'',fecha_recepcion:'2026-10-02',fecha_devolucion:null,usuario:'Juan',updated_at:'2026-10-13T00:00:00.123456Z'};
const docRow={id:randomUUID(),kardex:'SA-00001',fecha_registro:'2026-10-13',tipo_doc:'Facturas-Guia',periodo:'2026-01-01',ubicacion:'Santa Anita',folios:30,cargos:['C001'],caja_asignada:reqRow.id,f_envio:null,sustento:'',sustento_imagen:'',usuario:'Juan',facturas:'F-001',obs:'',updated_at:'2026-10-13T00:00:00.123456Z'};

async function app({allowed=true,isAdmin=true,failSave=false,signedIn=true,recovery=false,adminLink='',loginError=null,enableSearch=false,username='',now=Date.now()}={}) {
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const source=(await readFile(new URL('../src/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const dom=new JSDOM(html,{url:'https://kardex.example.test'+adminLink+(recovery?'#type=recovery':''),runScripts:'outside-only'});
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){if(this.open){this.open=false;this.dispatchEvent(new dom.window.Event('close'));}};
  const state={reqs:[structuredClone(reqRow)],docs:[structuredClone(docRow)],updates:[],snapshots:0,events:[],status:null,authCallback:null};
  state.session=signedIn?{user:{id:'owner',email:'owner@example.test',user_metadata:username?{kardex_username:username}:{}}}:null;
  state.syncRow={enabled:true,status:'Revisión completada: 276 cargos ya registrados. 1480 filas pendientes.',
    last_checked_at:'2026-10-17T03:09:17Z',
    last_result:{groups:276,pending_rows:1480,conflictos:0,cargos_nuevos:0,cargos_actualizados:0}};
  state.authCalls=[];state.exportCalls=[];state.searchCalls=[];state.now=now;
  dom.window.URL.createObjectURL=()=> 'blob:test';dom.window.URL.revokeObjectURL=()=>{};
  dom.window.HTMLAnchorElement.prototype.click=function(){state.downloadName=this.download;};
  const client={
    channel:()=>({on(event,filter,callback){state.events.push({filter,callback});return this;},subscribe(callback){state.status=callback;callback('SUBSCRIBED');return this;}}),
    removeChannel:async()=>{},
    from:()=>({select(){return this;},eq(){return this;},update(next){Object.assign(state.syncRow,next);return this;},async single(){return {data:structuredClone(state.syncRow),error:null};}}),
    rpc:async()=>({data:[],error:null}),
    auth:{getSession:async()=>({data:{session:state.session},error:null}),
      onAuthStateChange:callback=>{state.authCallback=callback;},
      signInWithPassword:async input=>{state.authCalls.push(['login',input]);if(loginError)return {error:loginError};state.session={user:{id:'owner',email:input.email}};state.authCallback('SIGNED_IN',state.session);return {error:null};},
      signUp:async input=>{state.authCalls.push(['signup',input]);return {error:null};},
      signInWithOtp:async input=>{state.authCalls.push(['link',input]);return {error:null};},
      resetPasswordForEmail:async(email,options)=>{state.authCalls.push(['recovery',email,options]);return {error:null};},
      updateUser:async input=>{state.authCalls.push(['updatePassword',input]);return {error:null};},
      signOut:async()=>{state.session=null;state.authCallback('SIGNED_OUT',null);return {error:null};}}
  };
  class FakeRepository {
    async fetchDoc(id){state.fetchedId=id;return docFromDb({...state.docs.find(d=>d.id===id),facturas:'F-001, F-002, F-003, F-004'});}
    async access(){state.loadingDuringAccess={loading:!dom.window.document.getElementById('sessionLoading').hidden,login:!dom.window.document.getElementById('authOverlay').hidden};return {allowed,is_admin:isAdmin};}
    async preparedImDetails(){state.preparedImCalls=(state.preparedImCalls||0)+1;return structuredClone(state.preparedImRows||[]);}
    async requestedIMDetails(){state.requestedImCalls=(state.requestedImCalls||0)+1;return structuredClone(state.requestedImRows||[]);}
    async shippedIMBoxesMonthly(){state.shippedImCalls=(state.shippedImCalls||0)+1;return structuredClone(state.shippedIMRows||[]);}
    async requestAdminAccess(){state.adminApplications=(state.adminApplications||0)+1;return {estado:'pendiente'};}
    async pendingAdminRequests(){if(state.adminRequestsError)throw new Error('Sin conexión');return state.adminPendingRequests||[];}
    async reviewAdminRequest(id,approved){(state.adminDecisions??=[]).push({id,approved});state.adminPendingRequests=(state.adminPendingRequests||[]).filter(req=>req.id!==id);return {estado:approved?'aprobado':'rechazado'};}
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
  if(enableSearch) FakeRepository.prototype.search=async(filters,offset,limit)=>{
    state.searchCalls.push({...filters});
    const found=filterDocuments(state.docs.map(docFromDb),state.reqs.map(reqFromDb),filters);
    const selected=found.slice(offset,offset+limit);
    return {rows:selected.map(row=>({...state.docs.find(d=>d.id===row.id)})),total:found.length,folios:found.reduce((n,d)=>n+(Number(d.folios)||0),0)};
  };
  const context=dom.getInternalVMContext();
  const scheduleInterval=dom.window.setInterval.bind(dom.window);
  state.intervals=[];
  context.setInterval=(callback,delay)=>{state.intervals.push({callback,delay});return scheduleInterval(callback,delay);};
  context.Date=class extends Date {constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}};
  Object.assign(context,{cargoExpiryGroups,formatCargoDuration,limaDate,requestedIMBoxes,countRequestedCargos,summarizePreparedIm,summarizeShippedBoxes,summarizeCreatedCargos,renderImBarChart,renderCargoLineChart});
  Object.assign(context,{createIdleSession:options=>createIdleSession({...options,now:()=>state.now}),createClient:()=>client,KardexRepository:FakeRepository,reqFromDb,docFromDb,reqEstado,docEstado,fmtDate,escapeHtml,invoiceSearchPresentation,buildWorkbook:async(...args)=>{state.exportCalls.push(args);return {xlsx:{writeBuffer:async()=>new Uint8Array([1])}};},buildCargoWorkbook:async(cargo)=>{state.guestExport=cargo;return {xlsx:{writeBuffer:async()=>new Uint8Array([1])}};},parseWorkbook,highlightMatch,filterDocuments,filterRequirements,assignedBoxCode,cargoYear,invoiceLocation,locationLabel,groupsForCodes,
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

test('el nombre de usuario se muestra en el encabezado sin alterar permisos',async()=>{
 const a=await app({username:'Juan Alexis'});
 try {
   assert.equal(a.node('sessionUser').textContent,'Juan Alexis');
   assert.equal(a.node('appShell').hidden,false);
 } finally {a.close();}
});

test('login uses Farmacias Peruanas reference layout without changing access actions',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const css=await readFile(new URL('../src/connection.css',import.meta.url),'utf8');
 const dom=new JSDOM(html);
 try {
   const d=dom.window.document;
   assert.equal(d.getElementById('authOverlay').hidden,true);
   assert.equal(d.querySelector('#authOverlay .auth-card').getAttribute('aria-labelledby'),'authTitle');
   const logo=d.getElementById('authLogo');
   assert.equal(logo.alt,'Farmacias Peruanas');
   assert.equal(logo.getAttribute('src'),d.querySelector('#sessionLoading .loading-brand').getAttribute('src'));
   assert.match(d.querySelector('.auth-brand').textContent,/CD SANTA ANITA/);
   assert.equal(d.getElementById('authTitle').textContent,'Iniciar sesión');
   assert.equal(d.getElementById('btnLogin').textContent,'Ingresar');
   assert.equal(d.getElementById('btnRegister').textContent,'Crear una cuenta');
    assert.ok(d.getElementById('registerOverlay').hidden);
    assert.ok(d.getElementById('registerForm'));
   assert.equal(d.getElementById('btnForgotPassword').textContent,'Olvidé mi contraseña');
   assert.equal(d.getElementById('btnMagicLink').textContent,'Recibir enlace de acceso por correo');
   assert.equal(d.querySelectorAll('#authOverlay .auth-decoration').length,1);
   assert.equal(d.querySelector('.auth-decoration').getAttribute('aria-hidden'),'true');
   assert.ok(d.getElementById('resetPasswordForm').hidden);
   assert.match(css,/\.auth-overlay\{[^}]*background:#fff/);
   assert.match(css,/\.auth-logo\{[^}]*margin:0 auto/);
   assert.match(css,/#btnLogin[^}]*background:#d9291e/);
   assert.match(css,/@media\(max-width:480px\)/);
 } finally {dom.window.close();}
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
  assert.equal(a.dom.window.location.hash,'','El enlace de recuperación se debe borrar al guardar la contraseña');
  assert.equal(a.node('newPassword').value,'');assert.equal(a.node('confirmPassword').value,'');
  // Un evento retrasado no debe volver a solicitar otra contraseña.
  a.state.authCallback('PASSWORD_RECOVERY',a.state.session);
  await flush();
  assert.equal(a.node('resetPasswordForm').hidden,true);
  assert.equal(a.node('appShell').hidden,false);
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
    a.node('buscar').value='F-001';a.node('btnBuscar').click();
    assert.ok(a.node('tbody').textContent.includes('SA-00001'));
    a.node('buscar').value='no existe';a.node('btnBuscar').click();
    assert.ok(a.node('tbody').textContent.includes('Sin registros'));
    a.node('btnLimpiarFiltros').click();
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
  try {assert.equal(editor.node('btnGuardar').disabled,true);assert.equal(editor.node('grp-documentos').hidden,true);assert.equal(editor.node('tbody').querySelector('[data-edit]'),null);assert.ok(editor.node('tbody').textContent.includes('F-001'));assert.equal(editor.node('btnReset').disabled,true);assert.equal(editor.node('btnImportar').disabled,true);}finally{editor.close();}
});
test('repository update always filters by the original timestamp and asks Supabase to confirm the result',async()=>{
  const calls=[];
  const builder={update(data){calls.push(['update',data]);return this;},eq(key,value){calls.push(['eq',key,value]);return this;},async select(){return {data:[],error:null};}};
  const repo=new KardexRepository({from:table=>{calls.push(['from',table]);return builder;}});
  await assert.rejects(repo.saveDoc(docFromDb(docRow),{id:docRow.id,updatedAt:docRow.updated_at}),/Otro usuario/);
  assert.deepEqual(calls.filter(c=>c[0]==='eq'),[['eq','id',docRow.id],['eq','updated_at',docRow.updated_at]]);
});

test('registro de invitado se abre aparte, valida datos y envía enlace',async()=>{
  const a=await app({signedIn:false});
  try{
    a.node('btnRegister').click();
    assert.equal(a.node('authOverlay').hidden,true);
    assert.equal(a.node('registerOverlay').hidden,false);
    assert.equal(a.node('appShell').hidden,true);
    a.node('registerUsername').value='Invitado Prueba';
    a.node('registerEmail').value='GUEST@EXAMPLE.TEST';
    a.node('registerPassword').value='short';
    a.node('registerConfirmPassword').value='short';
    a.node('registerForm').dispatchEvent(new a.dom.window.Event('submit',{cancelable:true}));await flush();
    assert.equal(a.state.authCalls.length,0);
    a.node('registerPassword').value='test-password';
    a.node('registerConfirmPassword').value='test-password';
    a.node('registerForm').dispatchEvent(new a.dom.window.Event('submit',{cancelable:true}));await flush();
    assert.equal(a.state.authCalls[0][0],'signup');
    const signup=a.state.authCalls[0][1];
    assert.equal(signup.email,'guest@example.test');
    assert.equal(signup.options.data.kardex_username,'Invitado Prueba');
    assert.equal(signup.options.emailRedirectTo,'https://kardex.example.test/');
    assert.equal(a.node('appShell').hidden,true);
    assert.match(a.node('registerMessage').textContent,/Revisa tu correo/);
    a.node('btnBackLogin').click();
    assert.equal(a.node('authOverlay').hidden,false);
    assert.equal(a.node('registerOverlay').hidden,true);
  }finally{a.close();}
});

test('admin and guest export only the selected cargo with its complete invoices',async()=>{
 for(const isAdmin of [true,false]){
  const a=await app({isAdmin});
  try {
   a.state.docs.push({...docRow,id:randomUUID(),kardex:'SA-99999',cargos:['UNRELATED']});
   assert.equal(a.node('btnExportar').hidden,true);
   const button=a.node('tbody').querySelector('[data-export-cargo]');assert.ok(button);assert.equal(button.disabled,false);
   button.click();await flush();
   assert.equal(a.state.fetchedId,docRow.id);
   assert.equal(a.state.exportCalls.length,0);assert.equal(a.state.guestExport.id,docRow.id);assert.equal(a.state.guestExport.facturas,'F-001, F-002, F-003, F-004');
   assert.match(a.state.downloadName,/Cargo_C001_SA-00001/);
  }finally{a.close();}
 }
});

test('sync status is inline and the Excel button opens the original file for admins',async()=>{
 const a=await app();try{
  assert.equal(a.node('btnRefreshGoogleSync'),null);
  assert.equal(a.node('googleSyncDialog'),null);
  assert.equal(a.node('btnOpenGoogleExcel').textContent,'Cargos Actuales');
  assert.equal(a.node('btnOpenIronMountainExcel').textContent,'Cargos Enviados');
  assert.match(a.node('btnOpenIronMountainExcel').href,/1aWqIoj5UXAeyKhNN1paoYnTa4jdfN8LhDEcdH_lQ4mk/);
  assert.match(a.node('btnOpenIronMountainHistorical').href,/1ap1GzGd3HBvkV2N7p6dvkFIYwHS_cIqO/);
  assert.equal(a.node('btnOpenIronMountainExcel').target,'_blank');
  assert.match(a.node('btnOpenGoogleExcel').href,/18TbKWiVUWKfkJOXvR0kGEMb5eVKTDCfoXAUtD5rCxts/);
  assert.equal(a.node('btnOpenGoogleExcel').target,'_blank');
  assert.match(a.node('googleSyncStatus').textContent,/Revisión completada/);
  assert.match(a.node('googleSyncDetails').textContent,/276 cargos revisados/);
 }finally{a.close();}
 const guest=await app({isAdmin:false});try{
  assert.equal(guest.node('googleSyncPanel').hidden,true);
 }finally{guest.close();}
});

test('admin sync cards always use the latest Supabase readings and account header shows email only',async()=>{
  const a=await app({isAdmin:true});
  try {
    await flush();
    assert.equal(a.node('sessionProfile').hidden,false);
    assert.equal(a.node('sessionUser').textContent,'owner@example.test');
    assert.equal(a.node('sessionProfile').querySelectorAll('svg').length,1);
    assert.doesNotMatch(a.node('sessionProfile').textContent,/Administrador|Invitado|20[0-9]{2}/);
    assert.equal(a.node('googleSyncPanel').hidden,false);
    assert.equal(a.node('googleSyncBadgeText').textContent,'ACTIVA');
    assert.equal(a.node('googleSyncRegistered').previousElementSibling.textContent,'Cargos Actuales 2026');
    assert.equal(a.node('googleSyncRegistered').textContent,'276');
    assert.equal(a.node('googleSyncPending').textContent,'1,480');
    assert.equal(a.node('googleSyncConflicts').textContent,'0');
    assert.equal(a.node('googleSyncRegisteredNote'),null);
    assert.equal(a.node('googleSyncPendingNote'),null);
    assert.equal(a.node('googleSyncConflictsNote'),null);
    assert.equal(a.dom.window.document.querySelectorAll('#googleSyncPanel .sync-stat-detail').length,0);
    assert.match(a.node('googleSyncLastReview').textContent,/Última revisión:.*Lima/);
    assert.match(a.node('googleSyncDetails').textContent,/276 cargos revisados; 0 nuevos; 0 actualizados; 1,480 filas pendientes; 0 conflictos/);

    a.state.syncRow.last_result={groups:281,pending_rows:1320,conflictos:2,cargos_nuevos:5,cargos_actualizados:1};
    a.state.syncRow.enabled=false;
    Object.defineProperty(a.dom.window.document,'hidden',{configurable:true,value:false});
    a.dom.window.document.dispatchEvent(new a.dom.window.Event('visibilitychange'));
    await flush();
    assert.equal(a.node('googleSyncBadgeText').textContent,'PAUSADA');
    assert.equal(a.node('googleSyncRegistered').textContent,'281');
    assert.equal(a.node('googleSyncPending').textContent,'1,320');
    assert.equal(a.node('googleSyncConflicts').textContent,'2');
    assert.match(a.node('googleSyncDetails').textContent,/281 cargos revisados; 5 nuevos; 1 actualizados; 1,320 filas pendientes; 2 conflictos/);
  }finally{a.close();}
  const guest=await app({isAdmin:false});
  try{
    assert.equal(guest.node('sessionUser').textContent,'owner@example.test');
    assert.equal(guest.node('googleSyncPanel').hidden,true);
  }finally{guest.close();}
});

test('top scrollbar stays synchronized with the retained bottom scrollbar',async()=>{
 const a=await app();
 try {
  const top=a.node('docsTopScroll'),bottom=a.node('docsTableScroll');
  assert.ok(top && bottom);
  top.scrollLeft=420;top.dispatchEvent(new a.dom.window.Event('scroll'));
  assert.equal(bottom.scrollLeft,420);
  bottom.scrollLeft=175;bottom.dispatchEvent(new a.dom.window.Event('scroll'));
  assert.equal(top.scrollLeft,175);
 }finally{a.close();}
});

 test('unfiltered browsing shows random cargos and searching keeps real match results',async()=>{
 const a=await app();
 try {
  assert.match(a.node('conteoResultados').textContent,/Cargos aleatorios/);
  a.node('buscar').value='NO-EXISTE-999';a.node('buscar').dispatchEvent(new a.dom.window.Event('input'));await flush();
  assert.match(a.node('conteoResultados').textContent,/Cargos aleatorios/);
  assert.equal(a.state.searchCalls.length,0);
  a.node('btnBuscar').click();await flush();
  assert.doesNotMatch(a.node('conteoResultados').textContent,/Cargos aleatorios/);
  assert.match(a.node('tbody').textContent,/Sin registros/);
 }finally{a.close();}
});

 test('admin and guest periods show only year and search locations follow each invoice without sustento',async()=>{
 for(const isAdmin of [true,false]){
 const a=await app({isAdmin});try{
  Object.assign(a.state.docs[0],{periodo:null,anio_origen:2023,fecha_origen:'2023-08-28',sustento:'PRIVATE-SUPPORT',ubicaciones_codigo:{f001:['2','17']}});
  a.node('btnReconnect').click();await flush();
  a.node('buscar').value='F-001';a.node('btnBuscar').click();await flush();
  const cells=a.node('tbody').querySelector('tr').cells;
  assert.equal(cells[3].textContent,'2023');assert.equal(cells.length,13);
  assert.match(cells[4].textContent,/Grupo 2, Grupo 17/);
  assert.equal(cells[6].textContent,'F-001');
  assert.equal(cells[6].querySelectorAll('mark').length,1);
  assert.doesNotMatch(cells[6].textContent,/Ubicación|códigos en este registro/);
  assert.equal(a.node('sustentoHeader'),null);
  assert.doesNotMatch(a.node('tbody').textContent,/PRIVATE-SUPPORT|Fecha en origen/);
 }finally{a.close();}
 }
});

test('Facturas column shows only matching invoice, GR or BV; cargo queries show only the total, for both roles',async()=>{
 for(const isAdmin of [true,false]){
  const a=await app({isAdmin,enableSearch:true});
  try {
   Object.assign(a.state.docs[0],{
    cargos:['3388A'],facturas:'F-001, GR-002, BV-003, F-004',cantidad_facturas:4,
    ubicaciones_codigo:{f001:['2','17'],gr002:['14'],bv003:['21'],f004:['4']}
   });
   a.node('btnReconnect').click();await flush();
   const headers=()=>[...a.dom.window.document.querySelectorAll('#docsTable thead th')].map(th=>th.textContent.trim());
   assert.equal(headers().length,12); // Random cargo list has no Ubicación column.
   assert.equal(a.node('tbody').querySelector('tr').cells.length,12);
   a.node('buscar').value='3388A';a.node('btnBuscar').click();await flush();
   let cells=a.node('tbody').querySelector('tr').cells;
   assert.equal(headers().length,12);
   assert.ok(!headers().includes('Ubicación'));
   assert.equal(cells.length,12);
   assert.equal(cells[4].textContent,'3388A');
   assert.equal(cells[5].textContent,'4 códigos en este registro');
   assert.doesNotMatch(cells[5].textContent,/F-001|GR-002|BV-003|Ubicación/);
   assert.ok(cells[11].querySelector('button[data-export-cargo]'));
   for(const [query,code,group] of [
    ['F-001','F-001','Grupo 2, Grupo 17'],
    ['GR-002','GR-002','Grupo 14'],
    ['BV-003','BV-003','Grupo 21']
   ]){
    a.node('buscar').value=query;a.node('btnBuscar').click();await flush();
    cells=a.node('tbody').querySelector('tr').cells;
    assert.equal(headers().length,13);
    assert.equal(headers()[4],'Ubicación');
    assert.equal(cells.length,13);
    assert.equal(cells[6].textContent,code);
    assert.equal(cells[6].querySelectorAll('mark').length,1);
    assert.doesNotMatch(cells[6].textContent,/Ubicación|códigos en este registro|F-004/);
    assert.equal(cells[4].textContent,group);
    assert.ok(cells[12].querySelector('button[data-export-cargo]'));
   }
   a.node('btnLimpiarFiltros').click();await flush();
   assert.equal(headers().length,12);
   assert.ok(!headers().includes('Ubicación'));
   assert.equal(a.node('tbody').querySelector('tr').cells.length,12);
  } finally {a.close();}
 }
});

test('admin e invitados encuentran facturas por código con guiones, sin guiones o terminación',async()=>{
  for(const isAdmin of [true,false]){
    const a=await app({isAdmin,enableSearch:true});
    try{
      a.state.docs[0].facturas='01-0FF01-0217573, 01-0FF01-0217574';
      a.state.docs[0].cargos=['688'];
      a.node('btnReconnect').click();await flush();
      const invoiceColumn=()=>{
        const tr=a.node('tbody').querySelector('tr');
        const head=a.dom.window.document.querySelector('#docsTable thead tr');
        const invoiceIndex=[...head.children].findIndex(th=>th.textContent.trim()==='Facturas');
        return tr?.cells[invoiceIndex]?.textContent || '';
      };
      for(const code of ['01-0FF01-0217573','010FF010217573','217573']){
        a.node('buscar').value=code;
        a.node('buscar').dispatchEvent(new a.dom.window.Event('input'));
        await flush();
        const before=a.state.searchCalls.length;
        a.node('btnBuscar').click();await flush();
        assert.equal(a.state.searchCalls.length,before+1);
        assert.equal(a.node('tbody').querySelectorAll('tr').length,1,code);
        assert.equal(invoiceColumn(),'01-0FF01-0217573',code);
      }
      a.node('filtroFactura').value='exacta';
      a.node('buscar').value='010FF010217573';
      a.node('btnBuscar').click();await flush();
      assert.equal(invoiceColumn(),'01-0FF01-0217573');
      a.node('buscar').value='217573';
      a.node('btnBuscar').click();await flush();
      assert.match(a.node('tbody').textContent,/Sin registros/);
      a.node('btnLimpiarFiltros').click();await flush();
      assert.equal(a.node('filtroFactura').value,'');
      assert.equal(a.node('filtroTipo').value,'');
    }finally{a.close();}
  }
});

test('search summaries respect server-side document counts without downloading full invoice lists',()=>{
 const document={cargos:['3388A'],facturas:'',facturasEncontradas:['F-001','GR-002','BV-003'],
  cantidadFacturas:156};
 assert.deepEqual(invoiceSearchPresentation(document,'3388A'),{kind:'cargo',codes:[],total:156});
 assert.deepEqual(invoiceSearchPresentation(document,'GR-002'),{kind:'invoice',codes:['GR-002'],total:156});
 assert.deepEqual(invoiceSearchPresentation(document,'BV003'),{kind:'invoice',codes:['BV-003'],total:156});
 assert.deepEqual(invoiceSearchPresentation(document,'SA-00001'),{kind:'other',codes:[],total:156});
 assert.deepEqual(invoiceSearchPresentation(document,''),{kind:'browse',codes:['F-001','GR-002','BV-003'],total:156});
});

test('loading shell hides login before JavaScript and authenticated loading never shows the login panel',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const dom=new JSDOM(html);try{
  assert.equal(dom.window.document.getElementById('authOverlay').hidden,true);
  const loading=dom.window.document.getElementById('sessionLoading');
  assert.equal(loading.hidden,false);
  assert.equal(loading.getAttribute('aria-label'),'Cargando Kardex Digital');
  assert.equal(loading.querySelector('img.loading-brand').getAttribute('alt'),'Farmacias Peruanas');
  assert.ok(loading.querySelector('img.loading-brand').getAttribute('src').startsWith('data:image/png;base64,'));
  assert.equal(loading.querySelectorAll('.loading-dots span').length,3);
  assert.match(html,/#sessionLoading\{[^}]*background:#fff/);
  assert.match(html,/#sessionLoading \.loading-brand\{[^}]*width:min\(240px,70vw\)/);
  assert.match(html,/@media\(max-width:768px\)\{#sessionLoading \.loading-brand\{width:min\(180px,65vw\)/);
  assert.match(html,/@keyframes kardex-loading-dot/);
  assert.match(html,/prefers-reduced-motion:reduce/);
 }finally{dom.window.close();}
 const a=await app();try{
  assert.equal(a.node('sessionLoading').hidden,true);
  assert.equal(a.node('authOverlay').hidden,true);
  assert.deepEqual(a.state.loadingDuringAccess,{loading:true,login:false});
 }finally{a.close();}
});
test('administrator summary shows white colored cards and transparent heart logo, without changing guest access',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const svg=await readFile(new URL('../public/farmacias-heart.svg',import.meta.url),'utf8');
  const dom=new JSDOM(html);
  try {
    assert.equal(dom.window.document.querySelector('#appShell img.header-logo').getAttribute('src'),'/farmacias-heart.svg');
    assert.equal(dom.window.document.querySelectorAll('.brand-lockup').length,2);
    assert.equal(dom.window.document.querySelector('#appShell .header-lockup'),null);
    assert.match(svg,/viewBox="0 50 512 400"/);
    assert.match(svg,/fill="#e30613"/);
    assert.match(svg,/fill="#878786"/);
    assert.doesNotMatch(svg,/<rect[^>]+fill="#000"/);
    assert.match(html,/#grp-resumen \.kpi\{/);
    assert.match(html,/background:#fff/);
    assert.match(html,/background:url\("\/farmacias-heart\.svg"\)/);
    assert.match(html,/#grp-resumen \.year-grid\{/);
    assert.match(html,/#grp-resumen \.kpi-summary-total\{--accent:#111111;\}/);
    assert.match(html,/#grp-resumen \.kpi-summary-process\{--accent:#0284c7;\}/);
  } finally {dom.window.close();}

  const admin=await app({isAdmin:true});
  try {
    const cards=admin.node('resumenTablas').querySelectorAll('.kpis > .kpi');
    assert.equal(cards.length,6);
    assert.equal(admin.node('resumenTablas').querySelectorAll('.kpi-summary-total').length,1);
    assert.equal(admin.node('resumenTablas').querySelectorAll('.kpi-summary-sent').length,1);
    assert.equal(admin.node('resumenTablas').querySelectorAll('.kpi-summary-process').length,1);
    assert.equal(admin.node('resumenTablas').querySelectorAll('.kpi-summary-pending').length,1);
    const summary=admin.node('grp-resumen');
    assert.equal(summary.querySelector('summary .stitle').textContent,'ResumenIndicadores generales');
    assert.doesNotMatch(summary.querySelector('summary').textContent,/se actualizan solos/i);
    const total=summary.querySelector('.kpi-summary-total .n');
    const sent=summary.querySelector('.kpi-summary-sent .n');
    const process=summary.querySelector('.kpi-summary-process .n');
    const pending=summary.querySelector('.kpi-summary-pending .n');
    assert.match(total.textContent,/folios/);
    assert.match(pending.textContent,/folios/);
    assert.doesNotMatch(sent.textContent,/folios/);
    assert.doesNotMatch(process.textContent,/folios/);
    assert.equal(sent.querySelector('.folios-inline'),null);
    assert.equal(process.querySelector('.folios-inline'),null);
    assert.equal(admin.node('resumenTablas').querySelectorAll('#yearSummaryGrid .periodo-fila').length,1);
    assert.equal(admin.node('resumenTablas').querySelectorAll('#imYearSummaryGrid .periodo-fila').length,7);
  }finally{admin.close();}
  const guest=await app({isAdmin:false});
  try {assert.equal(guest.node('grp-resumen').hidden,true);}
  finally{guest.close();}
});

test('admin summary groups Excel cargo years and refreshes 2026 after Google-sync events',async()=>{
  const a=await app({isAdmin:true});
  try {
    const base=a.state.docs[0];
    const historical=(year,cargos)=>({...structuredClone(base),id:randomUUID(),periodo:null,
      anio_origen:year,hoja_origen:'Cargos enviados '+year,cargos});
    const current=(cargo)=>({...structuredClone(base),id:randomUUID(),periodo:null,
      anio_origen:2026,hoja_origen:'CARGOS NUEVOS 2026',cargos:[cargo]});
    a.state.docs=[historical(2020,['H1']),historical(2024,['H2','H3']),
      historical(2025,['H4']),current('N1')];
    const notify=a.state.events.find(x=>x.filter.table==='kardex_eventos').callback;
    const refresh=async()=>{notify();await new Promise(resolve=>setTimeout(resolve,270));};
    const rows=()=>[...a.dom.window.document.querySelectorAll('#yearSummaryGrid .periodo-fila')]
      .map(row=>row.textContent.replace(/\s+/g,' ').trim());
    await refresh();
    assert.deepEqual(rows(),['2020 1 cargos','2024 2 cargos','2025 1 cargos','2026 1 cargos']);
    assert.match(a.node('resumenTablas').textContent,/Cargos por Año/);
    assert.doesNotMatch(a.node('resumenTablas').textContent,/2026 se actualiza desde Google Sheets/);
    a.state.docs.push(current('N2'));
    await refresh();
    assert.deepEqual(rows(),['2020 1 cargos','2024 2 cargos','2025 1 cargos','2026 2 cargos']);
    assert.match(a.node('resumenTablas').querySelector('.kpis .kpi .n').textContent,/^6\b/);
  }finally{a.close();}
});

test('expiry cards and in-app sheet share 2025/2026 counts and update after shipment',async()=>{
  const a=await app({now:Date.parse('2026-10-18T08:25:00Z')});
  try {
    const base=a.state.docs[0];
    const cargo=(code,date,extra={})=>({...structuredClone(base),id:randomUUID(),cargos:[code],
      periodo:null,fecha_origen:date,anio_origen:2026,...extra});
    a.state.docs=[cargo('OLD','2024-01-01',{anio_origen:2024}),
      cargo('001A','2025-08-18',{anio_origen:2025}),cargo('LATE','2026-04-17'),
      cargo('TODAY','2026-04-18'),cargo('NEXT','2026-09-18'),
      cargo('SENT','2026-01-01',{im_confirmado:true}),cargo('NO-DATE',null)];
    a.node('btnReconnect').click();await flush();
    const number=selector=>a.node('resumenTablas').querySelector(selector+' .n').textContent;
    assert.match(number('.kpi-summary-overdue'),/^2\b/);
    assert.match(number('.kpi-summary-expiring'),/^2\b/);
    assert.match(a.node('resumenTablas').textContent,/1 cargos de 2025\/2026 sin fecha válida/);
    // A search filter must not shrink the global alert counts or detail list.
    a.node('buscar').value='no-match';a.node('btnBuscar').click();
    a.node('btnCargosVencidos').click();
    assert.equal(a.node('cargoExpirySheet').open,true);
    assert.equal(a.node('cargoExpiryTitle').textContent,'Cargos Vencidos');
    assert.equal(a.node('cargoExpiryLegend').hidden,true);
    assert.equal(a.node('cargoExpirySheet').querySelectorAll('button[data-expiry]').length,0);
    assert.equal(a.node('cargoExpiryBody').rows.length,2);
    assert.match(a.node('cargoExpiryBody').textContent,/001A/);
    assert.match(a.node('cargoExpiryBody').textContent,/8 meses/);
    assert.match(a.node('cargoExpiryBody').textContent,/0 meses y 1 día/);
    assert.doesNotMatch(a.node('cargoExpiryBody').textContent,/OLD|SENT|NO-DATE|NEXT/);
    assert.match(a.node('cargoExpiryUnknown').textContent,/NO-DATE \(2026\)/);
    a.node('btnCloseCargoExpiry').click();
    assert.equal(a.dom.window.document.activeElement.id,'btnCargosVencidos');
    a.node('btnCargosPorVencer').click();
    assert.equal(a.node('cargoExpiryTimeHeading').textContent,'Falta para vencer');
    assert.equal(a.node('cargoExpiryLegend').hidden,false);
    assert.equal(a.node('cargoExpirySheet').querySelectorAll('button[data-expiry]').length,0);
    assert.equal(a.node('cargoExpiryBody').rows.length,2);
    assert.match(a.node('cargoExpiryBody').textContent,/Cumple 6 meses hoy/);
    assert.match(a.node('cargoExpiryBody').textContent,/5 meses/);
    a.state.docs.find(d=>d.cargos[0]==='TODAY').im_confirmado=true;
    a.state.events.find(x=>x.filter.table==='kardex_eventos').callback();
    await new Promise(resolve=>setTimeout(resolve,270));
    assert.equal(a.node('cargoExpiryBody').rows.length,1);
    assert.match(number('.kpi-summary-expiring'),/^1\b/);
    a.node('btnCloseCargoExpiry').click();
    assert.equal(a.node('cargoExpirySheet').open,false);
    assert.equal(a.dom.window.document.activeElement.id,'btnCargosPorVencer');
    a.node('btnCargosPorVencer').click();
    assert.equal(a.node('cargoExpiryTitle').textContent,'Cargos por Vencer');
    a.node('btnSignOut').click();await flush();
    assert.equal(a.node('cargoExpirySheet').open,false);
    assert.equal(a.node('cargoExpiryBody').textContent,'');
  } finally {a.close();}
  const guest=await app({isAdmin:false});
  try {
    guest.node('btnCargosVencidos').click();
    assert.equal(guest.node('cargoExpirySheet').open,false);
    assert.equal(guest.node('cargoExpiryBody').textContent,'');
  } finally {guest.close();}
});

test('expiry detail paginates every cargo, escapes source values and refreshes at the six-month boundary',async()=>{
  const a=await app({now:Date.parse('2026-10-18T08:25:00Z')});
  try {
    const base=a.state.docs[0];
    a.state.docs=Array.from({length:101},(_,i)=>({...structuredClone(base),id:randomUUID(),
      kardex:`SA-${String(i).padStart(5,'0')}`,periodo:null,anio_origen:2026,fecha_origen:'2026-04-18',
      cargos:[i===100?'<img src=x onerror=alert(1)>':`C${i}`]}));
    a.node('btnReconnect').click();await flush();
    a.node('btnCargosPorVencer').click();
    assert.equal(a.node('cargoExpiryBody').rows.length,100);
    assert.equal(a.node('cargoExpiryPage').textContent,'Página 1 de 2');
    assert.equal(a.node('btnExpiryPrevious').disabled,true);
    a.node('btnExpiryNext').click();
    assert.equal(a.node('cargoExpiryBody').rows.length,1);
    assert.equal(a.node('cargoExpiryPage').textContent,'Página 2 de 2');
    assert.equal(a.node('btnExpiryNext').disabled,true);
    assert.equal(a.node('cargoExpiryBody').querySelectorAll('img').length,0);
    assert.match(a.node('cargoExpiryBody').textContent,/<img src=x/);
    a.state.now=Date.parse('2026-10-19T05:00:00Z');
    a.node('btnCloseCargoExpiry').click();
    a.node('btnCargosVencidos').click();
    assert.match(a.node('cargoExpiryCount').textContent,/101 cargos/);
    assert.match(a.node('cargoExpiryBody').textContent,/0 meses y 1 día/);
    a.node('btnCloseCargoExpiry').click();
    a.node('btnCargosPorVencer').click();
    assert.match(a.node('cargoExpiryBody').textContent,/No hay cargos por vencer/);
    assert.equal(a.node('btnExpiryNext').disabled,true);
  } finally {a.close();}
});

test('new Google cargos receive colors on arrival and move automatically at Lima midnight in the open detail',async()=>{
  const a=await app({now:Date.parse('2026-10-19T04:59:00Z')});
  try {
    Object.defineProperty(a.dom.window.document,'hidden',{configurable:true,get:()=>false});
    const base=a.state.docs[0];
    a.state.docs=[];
    a.node('btnReconnect').click();await flush();
    a.node('btnCargosPorVencer').click();
    assert.match(a.node('cargoExpiryBody').textContent,/No hay cargos/);
    // These are the fields supplied by the existing Google Sheets ingestion.
    a.state.docs=[['C-HOY','2026-04-18'],['C-8DIAS','2026-04-26'],
      ['C-3MESES','2026-07-18'],['C-NUEVO','2026-10-18']].map(([code,date])=>({
        ...structuredClone(base),id:randomUUID(),periodo:null,anio_origen:2026,
        fecha_origen:date,cargos:[code],usuario:'Sincronización Google Drive'}));
    a.state.events.find(x=>x.filter.table==='kardex_eventos').callback();
    await new Promise(resolve=>setTimeout(resolve,270));
    const row=code=>[...a.node('cargoExpiryBody').rows].find(r=>r.cells[0].textContent===code);
    assert.equal(a.node('cargoExpiryBody').rows.length,4);
    assert.ok(row('C-HOY').querySelector('.expiry-red'));
    assert.ok(row('C-8DIAS').querySelector('.expiry-yellow'));
    assert.ok(row('C-3MESES').querySelector('.expiry-green'));
    assert.ok(row('C-NUEVO').querySelector('.expiry-green'));
    assert.match(row('C-NUEVO').textContent,/6 meses/);
    a.state.now=Date.parse('2026-10-19T05:00:01Z');
    // Invoke the same scheduled refresh that runs every minute, without a click.
    a.state.intervals.filter(timer=>timer.delay===60000).forEach(timer=>timer.callback());
    await flush();
    assert.equal(a.node('cargoExpiryTitle').textContent,'Cargos por Vencer');
    assert.equal(a.node('cargoExpiryBody').rows.length,3);
    assert.equal(row('C-HOY'),undefined);
    assert.ok(row('C-8DIAS').querySelector('.expiry-red'));
    assert.match(row('C-8DIAS').textContent,/0 meses y 7 días/);
    assert.ok(row('C-3MESES').querySelector('.expiry-yellow'));
    assert.ok(row('C-NUEVO').querySelector('.expiry-green'));
    assert.match(a.node('resumenTablas').querySelector('.kpi-summary-overdue .n').textContent,/^1\b/);
    a.node('btnCloseCargoExpiry').click();a.node('btnCargosVencidos').click();
    assert.equal(a.node('cargoExpiryBody').rows.length,1);
    assert.ok(row('C-HOY').querySelector('.expiry-red'));
    assert.match(row('C-HOY').textContent,/0 meses y 1 día/);
    assert.equal(a.node('cargoExpiryLegend').hidden,true);
  } finally {a.close();}
});

test('search hides irrelevant locations, uses Sin Responsable, and clarifies guest export-only access',async()=>{
  for (const isAdmin of [true,false]) {
    const a=await app({isAdmin});
    try {
      const locations=[...a.node('filtroUbicacion').options].map(o=>o.textContent.trim());
      assert.deepEqual(locations,[
        'Todas las ubicaciones','Santa Anita','Iron Mountain','Sin ubicación registrada'
      ]);
      assert.equal(a.node('existenciasSubtitulo').textContent,
        isAdmin ? 'Consulta, búsqueda, exportación e importación de documentos'
          : 'Consulta, búsqueda y exportación de documentos');

      a.state.docs[0].usuario='Importación Excel';
      a.node('btnReconnect').click();await flush();
      assert.equal(a.node('tbody').querySelector('tr').cells[10].textContent.trim(),'Sin Responsable');

      a.state.docs[0].usuario='Importacion Excel';
      a.node('btnReconnect').click();await flush();
      assert.equal(a.node('tbody').querySelector('tr').cells[10].textContent.trim(),'Sin Responsable');

      a.state.docs[0].usuario='RESPONSABLE REAL';
      a.node('btnReconnect').click();await flush();
      assert.equal(a.node('tbody').querySelector('tr').cells[10].textContent.trim(),'RESPONSABLE REAL');
      if (isAdmin) {
        assert.ok([...a.node('f_ubicacion').options].some(o=>o.value==='CD Arequipa'));
      }
    } finally { a.close(); }
  }
});

test('administrator and guest both display reconciled Iron Mountain box, sent date and responsible',async()=>{
  for(const isAdmin of [true,false]){
    const a=await app({isAdmin});try{
      Object.assign(a.state.docs[0],{
        periodo:null,anio_origen:2023,cargos:['3384A'],
        im_confirmado:true,im_codigo_caja:'2032192096',
        im_fecha_envio:'2024-06-12',im_responsable:'BILLY SALVADOR',
        estado_origen:'La hoja de origen declara cargos enviados',
        hoja_origen:'Cargos enviados 2023'
      });
      a.node('btnReconnect').click();await flush();
      const cells=a.node('tbody').querySelector('tr').cells;
      assert.equal(cells.length,12);
      assert.equal(cells[4].textContent.trim(),'3384A');
      assert.equal(cells[6].textContent.trim(),'2032192096');
      assert.equal(cells[7].textContent.trim(),'12/06/2024');
      assert.match(cells[8].textContent,/Enviado/);
      assert.match(cells[8].querySelector('.badge').className,/b-enviado/);
      assert.equal(cells[8].textContent.trim(),'Enviado');
      assert.equal(cells[10].textContent.trim(),'BILLY SALVADOR');
      assert.doesNotMatch(a.node('tbody').textContent,/La hoja de origen declara cargos enviados|Cargos enviados 2023/);
      assert.match(a.node('resumenTablas').querySelector('.kpi-summary-sent .n').textContent,/^1\b/);
      assert.match(a.node('resumenTablas').querySelector('.kpi-summary-pending .n').textContent,/^0\b/);
      assert.match(a.dom.window.document.querySelector('#docsTable thead').textContent,/Responsable/);
    }finally{a.close();}
  }
});

test('admin and guest filter only pending red and sent green via the full synchronized snapshot on Buscar',async()=>{
  for (const isAdmin of [true,false]) {
    const a=await app({isAdmin,enableSearch:true});
    try {
      const pending={...structuredClone(a.state.docs[0]),caja_asignada:null,im_confirmado:false};
      const sent={...structuredClone(pending),id:randomUUID(),kardex:'SA-00002',
        cargos:['3384A'],im_confirmado:true,im_codigo_caja:'2032192096',
        im_fecha_envio:'2024-06-12',im_responsable:'BILLY SALVADOR'};
      a.state.docs=[pending,sent];
      a.node('btnReconnect').click();await flush();
      const filter=a.node('filtroEstado');
      assert.deepEqual([...filter.options].slice(0,3).map(o=>[o.textContent,o.value]),[
        ['Todos los estados',''],
        ['Pendiente de envío','Pendiente de Envío'],
        ['Enviado','Enviado a Iron Mountain']
      ]);
      const assertOne=(kardex,badge,count)=>{
        assert.equal(a.node('tbody').rows.length,1);
        assert.match(a.node('tbody').textContent,new RegExp(kardex));
        assert.match(a.node('tbody').querySelector('.badge').className,new RegExp(badge));
        assert.match(a.node('conteoResultados').textContent,new RegExp(count+' registros'));
      };
      filter.value='Pendiente de Envío';
      filter.dispatchEvent(new a.dom.window.Event('change'));
      await flush();
      assert.match(a.node('tbody').textContent,/SA-00001/);
      assert.match(a.node('tbody').textContent,/SA-00002/);
      a.node('btnBuscar').click();await flush();
      assert.equal(a.state.searchCalls.length,0);
      assertOne('SA-00001','b-pendiente',1);
      assert.doesNotMatch(a.node('tbody').textContent,/SA-00002/);

      filter.value='Enviado a Iron Mountain';
      filter.dispatchEvent(new a.dom.window.Event('change'));
      await flush();
      assert.match(a.node('tbody').textContent,/SA-00001/);
      a.node('btnBuscar').click();await flush();
      assert.equal(a.state.searchCalls.length,0);
      assertOne('SA-00002','b-enviado',1);
      assert.doesNotMatch(a.node('tbody').textContent,/SA-00001/);
      assert.equal(a.node('tbody').querySelector('.badge').textContent.trim(),'Enviado');

      // Combined cargo-number + state searches still use the server.
      a.node('buscar').value='3384A';
      a.node('btnBuscar').click();await flush();
      assert.equal(a.state.searchCalls.length,1);
      assert.equal(a.state.searchCalls[0].state,'Enviado a Iron Mountain');
      assertOne('SA-00002','b-enviado',1);
      a.node('btnLimpiarFiltros').click();
      assert.equal(a.state.searchCalls.length,1);
      assert.equal(filter.value,'');
      assert.match(a.node('tbody').textContent,/SA-00001/);
      assert.match(a.node('tbody').textContent,/SA-00002/);
    }finally{a.close();}
  }
});

test('only Buscar runs the query; typing, Enter and filter changes wait for the button',async()=>{
 const a=await app({enableSearch:true});try{
  assert.equal(a.node('btnBuscar').nextElementSibling,a.node('btnLimpiarFiltros'));
  a.node('buscar').value='NO-MATCH';
  a.node('buscar').dispatchEvent(new a.dom.window.Event('input'));
  a.node('buscar').dispatchEvent(new a.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  a.node('filtroEstado').value='En Proceso de Acondicionamiento';
  a.node('filtroEstado').dispatchEvent(new a.dom.window.Event('change'));
  await new Promise(resolve=>setTimeout(resolve,180));
  assert.match(a.node('tbody').textContent,/SA-00001/);
  assert.match(a.node('conteoResultados').textContent,/Cargos aleatorios/);
  assert.equal(a.state.searchCalls.length,0);
  a.node('btnBuscar').click();await flush();
  assert.match(a.node('tbody').textContent,/Sin registros/);
  a.node('buscar').value='F-001';
  a.node('buscar').dispatchEvent(new a.dom.window.Event('input'));
  assert.match(a.node('tbody').textContent,/Sin registros/);
  assert.equal(a.state.searchCalls.length,1);
  a.node('btnBuscar').click();await flush();
  assert.equal(a.state.searchCalls.length,2);
  assert.match(a.node('tbody').textContent,/SA-00001/);
  a.state.events.find(x=>x.filter.table==='kardex_eventos').callback();
  await new Promise(resolve=>setTimeout(resolve,240));
  assert.equal(a.state.searchCalls.length,2);
  a.node('buscar').value='not found';a.node('btnLimpiarFiltros').click();
  assert.equal(a.state.searchCalls.length,2);
  assert.equal(a.node('buscar').value,'');
  assert.match(a.node('tbody').textContent,/SA-00001/);
  assert.match(a.node('conteoResultados').textContent,/Cargos aleatorios/);
 }finally{a.close();}
});

test('one hour of inactivity signs out the account and hides data before another interaction',async()=>{
 const a=await app();try{
  a.state.now+=3600000;
  a.dom.window.dispatchEvent(new a.dom.window.Event('focus'));
  assert.equal(a.node('appShell').hidden,true);
  await flush();
  assert.equal(a.state.session,null);
  assert.equal(a.node('authOverlay').hidden,false);
  assert.match(a.node('authMessage').textContent,/una hora de inactividad/);
 }finally{a.close();}
});


test('contador de 2026 suma históricos y cargos nuevos únicos por edición sin contar otra factura como cargo',async()=>{
  const a=await app({isAdmin:true});
  try {
    const base={...structuredClone(a.state.docs[0]),periodo:null,fecha_origen:'2026-09-25',anio_origen:2026,
      cargos:['930'],clave_origen:'historico|2026|930',facturas:'F-HISTORICO'};
    a.state.docs=[base];
    a.state.syncRow.last_result={mode:'onedit',verified:false,groups:0,pending_rows:null,conflictos:0};
    a.node('btnReconnect').click();
    await flush();
    assert.equal(a.node('googleSyncRegistered').textContent,'1');
    assert.match(a.node('googleSyncDetails').textContent,/1 del Excel base \+ 0 incorporados/);
    const newCargo={...structuredClone(base),id:randomUUID(),cargos:['0933'],
      clave_origen:'google-live|sheet|2026|933',fecha_origen:'2026-10-18',facturas:'F-REAL'};
    a.state.docs.push(newCargo);
    a.state.events.find(x=>x.filter.table==='kardex_eventos').callback();
    await new Promise(resolve=>setTimeout(resolve,280));
    assert.equal(a.node('googleSyncRegistered').textContent,'2');
    assert.match(a.node('googleSyncDetails').textContent,/1 del Excel base \+ 1 incorporados/);
    assert.match(a.node('resumenTablas').querySelector('.year-current .year-value').textContent,/^2\s*cargos/);
    a.state.docs.push({...structuredClone(newCargo),id:randomUUID(),cargos:['933'],facturas:'F-OTRA'});
    a.state.events.find(x=>x.filter.table==='kardex_eventos').callback();
    await new Promise(resolve=>setTimeout(resolve,280));
    assert.equal(a.node('googleSyncRegistered').textContent,'2');
    assert.match(a.node('googleSyncDetails').textContent,/1 del Excel base \+ 1 incorporados/);
  } finally {a.close();}
});


test('botón de refrescar cargos nuevos es exclusivo del administrador y consulta datos al pulsar',async()=>{
 const a=await app({isAdmin:true});
 try {
  await flush();
  const button=a.node('btnRefreshNewCargos');
  assert.equal(button.hidden,false);
  const initial=a.state.snapshots;
  button.click();
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.ok(a.state.snapshots>initial);
  assert.match(a.node('connectionStatus').textContent,/Cargos verificados|Cargos 2026 actualizados/);
  assert.equal(button.disabled,false);
  assert.match(button.textContent,/Refrescar cargos nuevos/);
 } finally {a.close();}
 const guest=await app({isAdmin:false});
 try{assert.equal(guest.node('btnRefreshNewCargos').hidden,true);}
 finally{guest.close();}
});


test('panel distingue altas recibidas de bajas no confirmadas y da instrucciones',async()=>{
 const a=await app({isAdmin:true});
 try {
  a.state.syncRow.last_result={mode:'onedit',verified:true,delete_verified:false,
    groups:1,total_2026:277,cargos_nuevos:1};
  Object.defineProperty(a.dom.window.document,'hidden',{configurable:true,value:false});
  a.dom.window.document.dispatchEvent(new a.dom.window.Event('visibilitychange'));
  await flush();
  assert.equal(a.node('googleSyncBadgeText').textContent,'BAJAS POR ACTIVAR');
  assert.match(a.node('googleSyncStatus').textContent,/NO se ha confirmado/);
  a.state.syncRow.last_result.delete_verified=true;
  a.dom.window.document.dispatchEvent(new a.dom.window.Event('visibilitychange'));
  await flush();
  assert.equal(a.node('googleSyncBadgeText').textContent,'ALTAS Y BAJAS ACTIVAS');
 } finally {a.close();}
});


test('Caja asignada busca instantaneamente por T, TD o numero para admin e invitados',async()=>{
  for (const isAdmin of [true,false]) {
    const a=await app({isAdmin,enableSearch:true});
    try {
      a.state.docs=[
        {...structuredClone(docRow),id:randomUUID(),kardex:'SA-00001',im_confirmado:true,
          im_codigo_caja:'T203258116',caja_asignada:null,facturas:'F-001'},
        {...structuredClone(docRow),id:randomUUID(),kardex:'SA-00002',im_confirmado:true,
          im_codigo_caja:'TD203258116',caja_asignada:null,facturas:'F-002'},
        {...structuredClone(docRow),id:randomUUID(),kardex:'SA-00003',im_confirmado:true,
          im_codigo_caja:'T2032581167',caja_asignada:null,facturas:'F-003'},
        {...structuredClone(docRow),id:randomUUID(),kardex:'SA-00004',
          im_confirmado:false,im_codigo_caja:'',caja_asignada:null,
          cargos:['203258116'],facturas:'203258116'}
      ];
      a.node('btnReconnect').click();await flush();
      assert.equal(a.node('filtroTipo').querySelector('option[value="solo-cajas"]').textContent,'Caja asignada');
      a.node('filtroTipo').value='solo-cajas';
      a.node('buscar').value='203258116';
      a.node('buscar').dispatchEvent(new a.dom.window.Event('input'));await flush();
      assert.equal(a.state.searchCalls.length,0);
      a.node('btnBuscar').click();await flush();
      let rows=a.node('tbody').querySelectorAll('tr');
      assert.equal(a.state.searchCalls.length,0,'La caja se filtra en el snapshot, no en el RPC');
      assert.equal(rows.length,2,'El codigo exacto evita coincidencias numericas parciales');
      assert.ok(a.node('tbody').textContent.includes('T203258116'));
      assert.ok(a.node('tbody').textContent.includes('TD203258116'));
      assert.ok(!a.node('tbody').textContent.includes('SA-00004'));
      assert.equal(a.node('ubicacionHeader'),null);
      assert.equal(a.node('tbody').querySelectorAll('[data-export-cargo]').length,2);
      a.node('buscar').value='TD203258116';
      a.node('btnBuscar').click();await flush();
      rows=a.node('tbody').querySelectorAll('tr');
      assert.equal(rows.length,2,'El prefijo TD debe encontrar también cajas T con iguales dígitos');
      assert.ok(a.node('tbody').textContent.includes('T203258116'));
      assert.ok(a.node('tbody').textContent.includes('TD203258116'));
      a.node('btnLimpiarFiltros').click();
      assert.equal(a.node('filtroTipo').value,'');
    }finally{a.close();}
  }
});

test('Solo cargos busca por numero de cargo, no por numero de factura ni guia',()=>{
 const cargo=(number,invoice,extras={})=>({
   id:number,cargos:[number],facturas:invoice,fechaOrigen:'2026-09-01',
   anioOrigen:2026,tipoDoc:'Facturas-Guia',periodo:null,ubicacion:null,...extras
 });
 const records=[cargo('490','F-100'),cargo('1490','F-200'),cargo('300','F-490')];
 const filters={query:'490',state:'',type:'solo-cargos',location:'',year:'',invoiceExact:false};
 assert.deepEqual(filterDocuments(records,[],filters).map(d=>d.cargos[0]),['490']);
 assert.deepEqual(filterDocuments(records,[],{...filters,query:'999'}),[]);
 assert.deepEqual(filterDocuments(records,[],{...filters,query:'49'}).map(d=>d.cargos[0]),['490','1490']);
 assert.deepEqual(filterDocuments(records,[],{...filters,query:'',invoiceExact:true}).map(d=>d.cargos[0]),
   ['490','1490','300']);
 assert.deepEqual(filterDocuments(records,[],{...filters,query:'490',year:'origen:2025'}),[]);
});

test('Solo cargos permite revisar enviado, responsable, y alertas se reducen al enviar',async()=>{
 const a=await app({isAdmin:true,enableSearch:true,now:Date.parse('2026-10-18T12:00:00Z')});
 try {
  const raw={...structuredClone(docRow),id:randomUUID(),periodo:null,fecha_origen:'2026-03-01',
    anio_origen:2026,cargos:['490'],facturas:'F-999999',caja_asignada:null,
    im_confirmado:false,im_responsable:'',usuario:'Importación Excel'};
  a.state.docs=[raw];
  const event=a.state.events.find(e=>e.filter.table==='kardex_eventos');
  event?.callback();
  await new Promise(resolve=>setTimeout(resolve,280));
  a.node('filtroTipo').value='solo-cargos';
  a.node('buscar').value='490';
  a.node('btnBuscar').click();
  await flush();
  assert.equal(a.state.searchCalls.length,0,'La busqueda de cargos usa el snapshot, no la consulta de facturas');
  assert.match(a.node('tbody').textContent,/Pendiente de Envío/);
  assert.match(a.node('resumenTablas').textContent,/Cargos Vencidos/);
  raw.im_confirmado=true;raw.im_codigo_caja='TEST-CAJA';raw.im_fecha_envio='2026-10-18';
  raw.im_responsable='ENTREGA DE PRUEBA';
  event?.callback();await new Promise(resolve=>setTimeout(resolve,280));
  assert.match(a.node('tbody').textContent,/Enviado/);
  assert.match(a.node('tbody').textContent,/ENTREGA DE PRUEBA/);
  assert.match(a.node('tbody').textContent,/TEST-CAJA/);
 } finally {a.close();}
});


test('Caja preparada para envío cuenta cajas únicas y cambia a enviado cuando F tenga fecha',async()=>{
 const a=await app({isAdmin:true,now:Date.parse('2026-10-18T17:00:00Z')});
 try{
  const row=(cargo,kardex)=>({...structuredClone(docRow),id:randomUUID(),kardex,
    cargos:[cargo],facturas:'FACT-'+cargo,anio_origen:2025,fecha_origen:'2025-02-10',
    periodo:null,caja_asignada:null,f_envio:null,sustento:'',sustento_imagen:'',
    im_preparado:true,im_caja_preparada:'CAJA-PRUEBA-001',
    im_responsable_preparacion:'PREPARADOR',im_confirmado:false});
  a.state.docs=[row('0323','SA-03111'),row('0347','SA-03112')];
  const e=a.state.events.find(e=>e.filter.table==='kardex_eventos');
  e?.callback();
  await new Promise(resolve=>setTimeout(resolve,280));
  const prepared=()=>a.node('resumenTablas').querySelector('.kpi-summary-prepared');
  const overdue=()=>a.node('resumenTablas').querySelector('.kpi-summary-overdue .n').textContent;
  assert.match(prepared().textContent,/Caja preparada para envío/);
  assert.match(prepared().textContent,/1 \(2 cargos\)/);
  assert.match(overdue(),/^2/);
  assert.match(a.node('tbody').textContent,/CAJA-PRUEBA-001/);
  assert.match(a.node('tbody').textContent,/PREPARADOR/);
  for(const d of a.state.docs){d.im_preparado=false;d.im_confirmado=true;d.im_codigo_caja='CAJA-PRUEBA-001';
    d.im_fecha_envio='2026-10-18';d.im_responsable='RESPONSABLE EN ENTREGAR';}
  e?.callback();await new Promise(resolve=>setTimeout(resolve,280));
  assert.match(prepared().textContent,/0 \(0 cargos\)/);
  assert.match(overdue(),/^0/);
  assert.match(a.node('resumenTablas').querySelector('.kpi-summary-sent .n').textContent,/^2/);
  assert.match(a.node('tbody').textContent,/RESPONSABLE EN ENTREGAR/);
  a.state.docs[0].im_confirmado=false;a.state.docs[0].im_codigo_caja='';
  a.state.docs[0].im_fecha_envio=null;a.state.docs[0].im_responsable='';
  e?.callback();await new Promise(resolve=>setTimeout(resolve,280));
  assert.match(overdue(),/^1/);
  assert.match(a.node('resumenTablas').querySelector('.kpi-summary-sent .n').textContent,/^1/);
 }finally{a.close();}
});


test('Enviados Iron Mountain por año coinciden con indicador superior y reaccionan a nuevas altas/bajas',async()=>{
  const a=await app({isAdmin:true,now:Date.parse('2026-10-18T18:40:00Z')});
  try{
    const base=structuredClone(docRow);
    const cargo=(year,code,sent=false,prepared=false)=>({...structuredClone(base),id:randomUUID(),
      kardex:'SA-'+code,anio_origen:year,periodo:null,fecha_origen:year+'-02-15',
      cargos:[code],caja_asignada:null,im_confirmado:sent,im_preparado:prepared});
    a.state.docs=[cargo(2020,'100'),cargo(2021,'200',true),
      cargo(2024,'300',true),cargo(2025,'400',true),
      cargo(2026,'500',false,true),cargo(2026,'600')];
    const notify=a.state.events.find(x=>x.filter.table==='kardex_eventos').callback;
    const refresh=async()=>{notify();await new Promise(resolve=>setTimeout(resolve,280));};
    const rows=()=>[...a.node('imYearSummaryGrid').querySelectorAll('.periodo-fila')]
      .map(row=>row.textContent.replace(/\s+/g,' ').trim());
    const total=()=>Number(a.node('resumenTablas').querySelector('.kpi-summary-sent .n').textContent.replace(/[^0-9]/g,''));
    await refresh();
    assert.deepEqual(rows(),['2020 0 cargos','2021 1 cargos','2022 0 cargos','2023 0 cargos',
      '2024 1 cargos','2025 1 cargos','2026 0 cargos']);
    assert.equal(total(),3);
    assert.match(a.node('im-year-summary-heading').textContent,/Cargos Enviados a Iron Mountain por Año/);
    const updated=a.state.docs.find(d=>d.cargos[0]==='500');
    updated.im_preparado=false;updated.im_confirmado=true;
    await refresh();
    assert.equal(rows().at(-1),'2026 1 cargos');
    assert.equal(total(),4);
    updated.im_confirmado=false;
    await refresh();
    assert.equal(rows().at(-1),'2026 0 cargos');
    assert.equal(total(),3);
  }finally{a.close();}
});


test('ojo muestra y oculta contraseña sin cambiar los valores ni ejecutar login',async()=>{
 const a=await app({signedIn:false});
 try{
  a.node('authPassword').value='mi_contrasena_prueba';
  const button=a.node('toggleAuthPassword');
  assert.equal(a.node('authPassword').type,'password');
  button.click();
  assert.equal(a.node('authPassword').type,'text');
  assert.equal(button.getAttribute('aria-label'),'Ocultar contraseña');
  assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.equal(a.node('authPassword').value,'mi_contrasena_prueba');
  button.click();
  assert.equal(a.node('authPassword').type,'password');
  assert.equal(a.state.authCalls.length,0);
 }finally{a.close();}
});

test('registro administrativo incluye nombre y requiere aprobación sin asignar permisos',async()=>{
  const a=await app({signedIn:false});
  try{
    a.node('btnRegister').click();
    a.node('registerRole').value='admin';
    a.node('registerUsername').value='Administrador Nuevo';
    a.node('registerEmail').value='NUEVO@EXAMPLE.TEST';
    a.node('registerPassword').value='UnaClaveSegura123';
    a.node('registerConfirmPassword').value='Diferente';
    a.node('registerForm').dispatchEvent(new a.dom.window.Event('submit',{cancelable:true}));await flush();
    assert.equal(a.state.authCalls.length,0);
    assert.match(a.node('registerMessage').textContent,/no coinciden/i);
    a.node('registerConfirmPassword').value='UnaClaveSegura123';
    a.node('registerForm').dispatchEvent(new a.dom.window.Event('submit',{cancelable:true}));await flush();
    assert.equal(a.state.authCalls.length,1);
    assert.equal(a.state.authCalls[0][0],'signup');
    const signup=a.state.authCalls[0][1];
    assert.equal(signup.email,'nuevo@example.test');
    assert.equal(signup.options.data.kardex_username,'Administrador Nuevo');
    assert.equal(signup.options.data.kardex_admin_request_code,'FPCARGOS');
    assert.equal(a.node('appShell').hidden,true);
    assert.match(a.node('registerMessage').textContent,/cuenta principal apruebe/i);
  }finally{a.close();}
});

test('cuenta principal aprueba o rechaza desde Solicitudes y el contador vuelve a cero',async()=>{
 const a=await app({isAdmin:true});
 try{
   a.state.adminPendingRequests=[{id:'11111111-1111-4111-8111-111111111111',email:'autorizado@example.test',created_at:'2026-10-18T19:00:00Z'},
     {id:'22222222-2222-4222-8222-222222222222',email:'otro@example.test',created_at:'2026-10-18T19:00:00Z'}];
   assert.equal(a.node('adminRequestsPanel').closest('#grp-resumen'),null);
   assert.equal(a.node('adminRequestsPanel').closest('#grp-solicitudes'),a.node('grp-solicitudes'));
   a.node('workspaceTabSolicitudes').click();await flush();
   const panel=a.node('adminRequestsPanel'),badge=a.node('adminRequestsBadge');
   assert.equal(panel.hidden,false);
   assert.equal(a.node('grp-resumen').hidden,true);
   assert.equal(a.node('grp-solicitudes').hidden,false);
   assert.equal(badge.textContent,'2');
   assert.ok(badge.classList.contains('pending'));
   assert.match(panel.textContent,/autorizado@example.test/);
   panel.querySelector('[data-admin-approve]').click();await flush();
   assert.deepEqual(a.state.adminDecisions[0],{id:'11111111-1111-4111-8111-111111111111',approved:true});
   assert.doesNotMatch(panel.textContent,/autorizado@example.test/);
   assert.equal(badge.textContent,'1');
   assert.ok(badge.classList.contains('pending'));
   panel.querySelector('[data-admin-reject]').click();await flush();
   assert.deepEqual(a.state.adminDecisions[1],{id:'22222222-2222-4222-8222-222222222222',approved:false});
   assert.equal(badge.textContent,'0');
   assert.equal(badge.getAttribute('aria-label'),'0 solicitudes pendientes');
   assert.equal(badge.classList.contains('pending'),false);
   assert.equal(badge.classList.contains('unavailable'),false);
 }finally{a.close();}
});

test('el indicador de solicitudes se actualiza al volver a la pestaña y no pinta verde sin conexión',async()=>{
  const a=await app({isAdmin:true});
  try {
    const badge=a.node('adminRequestsBadge');
    await flush();
    assert.equal(badge.textContent,'0');
    assert.ok(!badge.classList.contains('pending'));
    a.state.adminPendingRequests=[{id:'33333333-3333-4333-8333-333333333333',email:'pendiente@example.test'}];
    a.node('workspaceTabSolicitudes').click();await flush();
    assert.equal(badge.textContent,'1');
    assert.ok(badge.classList.contains('pending'));
    a.state.adminPendingRequests=[];
    a.node('btnAdminRequestsRefresh').click();await flush();
    assert.equal(badge.textContent,'0');
    assert.ok(!badge.classList.contains('pending'));
    assert.match(a.node('adminRequestsList').textContent,/No hay solicitudes/);
    a.state.adminRequestsError=true;
    a.node('btnAdminRequestsRefresh').click();await flush();
    assert.equal(badge.textContent,'–');
    assert.ok(badge.classList.contains('unavailable'),'Un error no se muestra como cero confirmado');
    assert.match(a.node('adminRequestsList').textContent,/No se pudieron consultar/);
    a.state.adminRequestsError=false;
    a.node('btnAdminRequestsRefresh').click();await flush();
    assert.equal(badge.textContent,'0');
    assert.ok(!badge.classList.contains('unavailable'));
    assert.ok(a.state.intervals.some(item=>item.delay===60000),
      'Se consulta el contador periódicamente mientras el administrador está conectado');
  }finally{a.close();}
});

test('enlace de Gmail permite decidir sobre solicitud solo tras sesión del administrador principal',async()=>{
 const requestId='c72aa724-4a35-4ea8-943e-763503e35a98';
 const a=await app({isAdmin:true,adminLink:'/?solicitud_admin='+requestId+'&accion=aprobar'});
 try{
  a.state.adminPendingRequests=[{id:requestId,email:'solicitante@example.test',created_at:'2026-10-18T19:30:00Z'}];
  a.node('btnAdminRequestsRefresh').click();
  await flush();
  assert.deepEqual(a.state.adminDecisions,[{id:requestId,approved:true}]);
  assert.equal(a.state.adminPendingRequests.length,0);
  assert.equal(a.dom.window.location.search,'');
  // Se procesa solamente una vez.
  a.node('btnAdminRequestsRefresh').click();await flush();
  assert.equal(a.state.adminDecisions.length,1);
 }finally{a.close();}
});
test('enlace no permite aprobar cuenta administrativa desde invitado',async()=>{
 const requestId='725b775e-7b3e-4ea8-9c74-0aa492b80f1f';
 const a=await app({isAdmin:false,adminLink:'/?solicitud_admin='+requestId+'&accion=aprobar'});
 try{
  a.state.adminPendingRequests=[{id:requestId,email:'solicitante@example.test',created_at:'2026-10-18T19:30:00Z'}];
  a.node('btnAdminRequestsRefresh').click();await flush();
  assert.equal(a.state.adminDecisions,undefined);
  assert.equal(a.node('adminRequestsPanel').hidden,true);
 }finally{a.close();}
});


test('Ver detalle de cajas preparadas muestra nueve campos y lleva a fila correcta del Excel',async()=>{
 const a=await app({isAdmin:true});
 try{
  Object.assign(a.state.docs[0],{anio_origen:2025,periodo:null,fecha_origen:'2025-05-01',
    cargos:['502','503'],im_preparado:true,im_confirmado:false,im_caja_preparada:'t2044084000',
    im_responsable_preparacion:'JUAN GALINDO'});
  a.state.preparedImRows=[{
    sheet_id:'1aWqIoj5UXAeyKhNN1paoYnTa4jdfN8LhDEcdH_lQ4mk',
    sheet_row:2,numero:'1',fecha_preparacion:'2026-10-18',
    responsable_preparacion:'JUAN GALINDO',codigo_caja:'t2044084000',
    numeros_cargos:'502-503',cargos:['502','503'],fecha_envio:null,
    responsable_entrega:'',responsable_recibe:'<img src=x onerror=alert(1)>',
    placa_transporte:''
  }];
  a.node('btnReconnect').click();await flush();
  const button=a.node('btnPreparedImDetail');
  assert.equal(button.textContent,'Ver detalle');
  button.click();await flush();
  assert.equal(a.node('preparedImSheet').open,true);
  assert.match(a.node('preparedImCount').textContent,/1 cajas · 2 cargos/);
  const detail=a.node('preparedImList');
  for(const label of ['Fecha de preparación','Responsable de preparación','Código de barras','Número de cargos',
    'Fecha de envío','Responsable en entregar','Responsable en recibir','Placa de unidad'])
    assert.match(detail.textContent,new RegExp(label));
  assert.match(detail.textContent,/t2044084000/);
  assert.match(detail.textContent,/502-503/);
  assert.match(detail.textContent,/JUAN GALINDO/);
  assert.match(detail.textContent,/Sin registrar/);
  assert.equal(detail.querySelectorAll('img').length,0);
  assert.match(detail.textContent,/<img src=x onerror=alert\(1\)>/);
  assert.match(detail.querySelector('.prepared-im-actions a').href,/range=A2:J2/);
  a.node('preparedImSearch').value='noexiste';
  a.node('preparedImSearch').dispatchEvent(new a.dom.window.Event('input'));
  assert.match(detail.textContent,/No hay cajas preparadas/);
  a.node('preparedImSearch').value='503';
  a.node('preparedImSearch').dispatchEvent(new a.dom.window.Event('input'));
  assert.equal(detail.querySelectorAll('.prepared-im-box').length,1);
  // Completar fecha G hace que la caja desaparezca del detalle tras actualizar.
  a.state.preparedImRows=[];
  a.state.docs[0].im_preparado=false;a.state.docs[0].im_confirmado=true;
  a.node('btnReconnect').click();await flush();
  assert.match(a.node('preparedImCount').textContent,/0 cajas · 0 cargos/);
  assert.equal(detail.querySelectorAll('.prepared-im-box').length,0);
  a.node('btnClosePreparedIm').click();
  assert.equal(a.node('preparedImSheet').open,false);
  assert.equal(a.node('preparedImList').textContent,'');
 }finally{a.close();}
});

test('detalle de cajas preparadas es solo administrativo y se cierra cuando termina sesión',async()=>{
 const guest=await app({isAdmin:false});
 try{
  assert.equal(guest.node('grp-resumen').hidden,true);
  guest.node('btnPreparedImDetail')?.click();
  await flush();
  assert.equal(guest.node('preparedImSheet').open,false);
  assert.equal(guest.state.preparedImCalls||0,0);
 }finally{guest.close();}
 const admin=await app({isAdmin:true});
 try{
  admin.node('btnPreparedImDetail').click();await flush();
  assert.equal(admin.node('preparedImSheet').open,true);
  admin.node('btnSignOut').click();await flush();
  assert.equal(admin.node('preparedImSheet').open,false);
 }finally{admin.close();}
});



test('indicador IM solicitado conserva diseño y despliega cargos del Sheet con cruce',async()=>{
  const a=await app({isAdmin:true});
  try {
    assert.match(a.node('btnRequestedIMDetail').textContent,/Ver detalle/);
    assert.match(a.node('btnRequestedIMDetail').closest('article').textContent,/CARGOS SOLICITADOS IM/);
    a.state.docs[0].cargos=['933'];
    a.state.requestedImRows=[
      {codigo_caja:'TD990011',codigo_cargo:'0933',clasificacion_caja:'Por solicitud',fecha_envio:null},
      {codigo_caja:'T990011',codigo_cargo:'0934',clasificacion_caja:'Por solicitud',fecha_envio:null},
      {codigo_caja:'P990012',codigo_cargo:'0935',clasificacion_caja:'Cajas nuevas',fecha_envio:null}
    ];
    a.node('btnReconnect').click();await flush();await flush();
    assert.equal(a.node('monthlyCargosRequested').textContent,'1');
    assert.equal(a.node('requestedIMNote').textContent,'2 cargos');
    a.node('btnRequestedIMDetail').click();
    assert.equal(a.node('requestedIMSheet').open,true);
    assert.match(a.node('requestedIMList').textContent,/Caja TD990011/);
    assert.doesNotMatch(a.node('requestedIMList').textContent,/P990012/);
    assert.match(a.node('requestedIMList').textContent,/2 cargos/);
    a.node('btnCloseRequestedIM').click();
    assert.equal(a.node('requestedIMSheet').open,false);
  } finally {a.close();}
});

test('una contraseña recién cambiada no vuelve a pedirse al actualizar la página',async()=>{
 const recovery=await app({recovery:true,adminLink:'/?origen=verificacion'});
 try {
   assert.equal(recovery.node('resetPasswordForm').hidden,false);
   recovery.node('newPassword').value='MiClaveNueva2026';
   recovery.node('confirmPassword').value='MiClaveNueva2026';
   recovery.node('resetPasswordForm').dispatchEvent(
     new recovery.dom.window.Event('submit',{cancelable:true}));
   await flush();
   assert.equal(recovery.dom.window.location.hash,'');
   assert.equal(recovery.dom.window.location.search,'?origen=verificacion');
   assert.equal(recovery.node('resetPasswordForm').hidden,true);
   assert.equal(recovery.state.authCalls.filter(c=>c[0]==='updatePassword').length,1);
 } finally {recovery.close();}
 const reloaded=await app({signedIn:true});
 try {
   assert.equal(reloaded.node('resetPasswordForm').hidden,true);
   assert.equal(reloaded.node('authTitle').textContent,'Iniciar sesión');
   assert.equal(reloaded.node('appShell').hidden,false);
   assert.equal(reloaded.state.authCalls.filter(c=>c[0]==='updatePassword').length,0);
 } finally {reloaded.close();}
});


test('admin e invitado ven el corazón en encabezado sin textos repetidos, botones limpios y sin documentos nuevos',async()=>{
 for(const isAdmin of [true,false]){
  const a=await app({isAdmin});
  try{
    const d=a.dom.window.document;
    assert.equal(d.querySelectorAll('#appShell .header-row img.header-logo').length,1);
    assert.equal(d.querySelector('#appShell .header-row img.header-logo').getAttribute('src'),'/farmacias-heart.svg');
    assert.equal(d.querySelector('#appShell .header-row .brand-kardex'),null);
    assert.equal(a.node('btnReconnect').hidden,true);
    assert.equal(a.node('grp-documentos').hidden,true);
    assert.equal(d.querySelector('#grp-documentos').getAttribute('aria-hidden'),'true');
    assert.equal(a.node('btnSignOut').hidden,false);
    if(isAdmin){
      assert.equal(a.node('btnRefreshNewCargos').hidden,false);
      assert.equal(a.node('btnOpenGoogleExcel').textContent,'Cargos Actuales');
      const links=a.node('btnOpenGoogleExcel').closest('.google-excel-links');
      assert.equal(links.querySelectorAll('a').length,3);
      assert.equal(links.nextElementSibling,a.node('btnToggleGoogleSync'));
      assert.equal(a.node('googleSyncLastReview').hidden,true);
      assert.equal(a.node('googleSyncDetails').hidden,true);
      assert.ok(a.node('googleSyncPanel').hidden===false);
      assert.equal(a.node('resumenTablas').querySelector('.periodo-nota'),null);
    } else {
      assert.equal(a.node('btnRefreshNewCargos').hidden,true);
      assert.equal(a.node('googleSyncPanel').hidden,true);
    }
  } finally {a.close();}
 }
});


test('las cuatro pestañas administrativas conservan Resumen, Requerimientos, Existencias y Solicitudes',async()=>{
  const a=await app({isAdmin:true,enableSearch:true});
  try {
    const tabs=a.node('workspaceTabs'),badge=a.node('googleSyncBadge');
    const shown=id=>!a.node(id).hidden;
    assert.equal(tabs.parentElement.id,'googleSyncPanel');
    assert.ok(tabs.compareDocumentPosition(badge)&a.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(tabs.getAttribute('role'),'tablist');
    assert.equal(tabs.querySelectorAll('[role="tab"]').length,4);
    assert.deepEqual([...tabs.querySelectorAll('[data-workspace]')].map(tab=>tab.dataset.workspace),
      ['resumen','requerimientos','existencias','solicitudes']);
    assert.equal(a.node('workspaceTabResumen').getAttribute('aria-selected'),'true');
    assert.equal(a.node('googleSyncContent').hidden,false,'Resumen muestra panel Google Sheets');
    assert.deepEqual([shown('grp-resumen'),shown('grp-requerimientos'),shown('grp-existencias')],[true,false,false]);
    const snapshots=a.state.snapshots;
    const originalResumen=a.node('resumenTablas').textContent;
    a.node('workspaceTabRequerimientos').click();
    assert.deepEqual([shown('grp-resumen'),shown('grp-requerimientos'),shown('grp-existencias')],[false,true,false]);
    assert.equal(a.node('grp-requerimientos').open,true);
    assert.equal(a.node('reqFormTitle').textContent,'Nuevo Requerimiento');
    assert.equal(a.node('workspaceTabRequerimientos').getAttribute('aria-selected'),'true');
    assert.equal(a.node('workspaceTabResumen').tabIndex,-1);
    a.node('workspaceTabExistencias').click();
    assert.deepEqual([shown('grp-resumen'),shown('grp-requerimientos'),shown('grp-existencias'),shown('grp-solicitudes')],[false,false,true,false]);
    assert.equal(a.node('grp-existencias').open,true);
    a.node('workspaceTabSolicitudes').click();await flush();
    assert.deepEqual([shown('grp-resumen'),shown('grp-requerimientos'),shown('grp-existencias'),shown('grp-solicitudes')],[false,false,false,true]);
    assert.equal(a.node('googleSyncContent').hidden,true);
    assert.equal(a.node('workspaceTabSolicitudes').getAttribute('aria-selected'),'true');
    a.node('workspaceTabExistencias').click();
    assert.ok(a.node('buscar'));
    assert.ok(a.node('btnBuscar'));
    assert.equal(a.node('filtroTipo').querySelector('option[value="solo-cargos"]').textContent,'Solo cargos');
    a.node('buscar').value='503';
    a.node('workspaceTabResumen').click();
    assert.deepEqual([shown('grp-resumen'),shown('grp-requerimientos'),shown('grp-existencias')],[true,false,false]);
    assert.equal(a.node('resumenTablas').textContent,originalResumen);
    assert.equal(a.node('buscar').value,'503','La búsqueda no pierde su contenido al cambiar pestañas');
    assert.equal(a.state.snapshots,snapshots,'Cambiar pestaña no consulta nuevamente Supabase');
    assert.equal(a.node('googleSyncPanel').hidden,false);
  }finally{a.close();}
});

test('la navegación admite teclado y conserva pestaña elegida después de refrescar datos',async()=>{
  const a=await app({isAdmin:true});
  try {
    const el=a.node('workspaceTabResumen');
    el.dispatchEvent(new a.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
    assert.equal(a.node('workspaceTabRequerimientos').getAttribute('aria-selected'),'true');
    const selected=a.node('workspaceTabRequerimientos');
    selected.dispatchEvent(new a.dom.window.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));
    assert.equal(a.node('workspaceTabSolicitudes').getAttribute('aria-selected'),'true');
    a.node('btnReconnect').click();await flush();
    assert.equal(a.node('grp-solicitudes').hidden,false);
    assert.equal(a.node('grp-resumen').hidden,true);
    const right=a.node('workspaceTabSolicitudes');
    right.dispatchEvent(new a.dom.window.KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));
    assert.equal(a.node('workspaceTabResumen').getAttribute('aria-selected'),'true');
  }finally{a.close();}
});

test('invitados mantienen Existencias sin pestañas ni acceso a formularios administrativos',async()=>{
  const a=await app({isAdmin:false});
  try {
    assert.equal(a.node('googleSyncPanel').hidden,true);
    assert.equal(a.node('grp-resumen').hidden,true);
    assert.equal(a.node('grp-requerimientos').hidden,true);
    assert.equal(a.node('grp-documentos').hidden,true);
    assert.equal(a.node('grp-existencias').hidden,false);
    assert.equal(a.node('grp-solicitudes').hidden,true);
    a.node('workspaceTabSolicitudes').click();
    assert.equal(a.node('grp-solicitudes').hidden,true);
    a.node('workspaceTabRequerimientos').click();
    assert.equal(a.node('grp-requerimientos').hidden,true);
    assert.equal(a.node('grp-existencias').hidden,false);
    assert.equal(a.node('btnBuscar').disabled,false);
  }finally{a.close();}
});


test('sincronización solo aparece en Resumen mientras la barra permanece visible',async()=>{
 const admin=await app({isAdmin:true});
 try {
  const panel=admin.node('googleSyncPanel'),nav=admin.node('workspaceTabs');
  const content=admin.node('googleSyncContent'),badge=admin.node('googleSyncBadge');
  const links=['btnOpenGoogleExcel','btnOpenIronMountainExcel','btnOpenIronMountainHistorical'];
  const hrefs=links.map(id=>admin.node(id).href);
  assert.equal(panel.hidden,false);
  assert.equal(content.hidden,false);
  assert.equal(panel.classList.contains('workspace-tabs-only'),false);
  assert.ok(nav.compareDocumentPosition(content)&admin.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(badge.closest('#googleSyncContent'),content);
  admin.node('workspaceTabRequerimientos').click();
  assert.equal(panel.hidden,false,'El menú sigue visible en Requerimientos');
  assert.equal(content.hidden,true,'No mostrar estado ni enlaces de Excel');
  assert.equal(panel.classList.contains('workspace-tabs-only'),true);
  assert.equal(admin.node('grp-requerimientos').hidden,false);
  assert.equal(admin.node('googleSyncPanel').contains(nav),true);
  admin.node('workspaceTabExistencias').click();
  assert.equal(content.hidden,true,'No mostrar Google Sheets en Existencias');
  assert.equal(panel.hidden,false);
  assert.equal(admin.node('grp-existencias').hidden,false);
  // El recálculo no debe forzar la reaparición del cuadro.
  admin.node('btnReconnect').click();await flush();
  assert.equal(content.hidden,true);
  assert.equal(admin.node('grp-existencias').hidden,false);
  admin.node('workspaceTabResumen').click();
  assert.equal(content.hidden,false,'Resumen restaura los controles originales');
  assert.equal(panel.classList.contains('workspace-tabs-only'),false);
  assert.deepEqual(links.map(id=>admin.node(id).href),hrefs,'No se modifican enlaces');
  assert.equal(admin.node('btnToggleGoogleSync').closest('#googleSyncContent'),content);
 } finally {admin.close();}
 const guest=await app({isAdmin:false});
 try {
  assert.equal(guest.node('googleSyncPanel').hidden,true);
  assert.equal(guest.node('googleSyncContent').hidden,true);
  assert.equal(guest.node('grp-existencias').hidden,false);
 } finally {guest.close();}
});


test('fecha de envío IM resta caja solicitada y preparada, y suma una caja enviada este mes',async()=>{
  const fixed=Date.UTC(2026,9,21,19,0,0),a=await app({isAdmin:true,now:fixed});
  try{
    const prepared={codigo_caja:'T2032192124',cargos:['933','934'],
      clasificacion_caja:'POR SOLICITUD',fecha_envio:null};
    a.state.requestedImRows=['933','934'].map(c=>({...prepared,codigo_cargo:c}));
    a.state.preparedImRows=[prepared];
    a.state.shippedIMRows=[];
    a.node('btnReconnect').click();await flush();await flush();
    assert.equal(a.node('monthlyCargosRequested').textContent,'1');
    assert.equal(a.node('requestedIMNote').textContent,'2 cargos');
    assert.match(a.node('preparedImSummaryMetric').textContent,/1\s*\(2 cargos\)/);
    assert.equal(a.node('monthlyCargosShipped').textContent,'0');

    // La fila ya tiene G: fecha de envío y la RPC deja de listarla como pendiente.
    a.state.requestedImRows=[];
    a.state.preparedImRows=[];
    a.state.shippedIMRows=[{year:2026,month:10,count:1,latest:'2026-10-21'}];
    a.node('btnReconnect').click();await flush();await flush();
    assert.equal(a.node('monthlyCargosRequested').textContent,'0');
    assert.equal(a.node('requestedIMNote').textContent,'0 cargos');
    assert.match(a.node('preparedImSummaryMetric').textContent,/0\s*\(0 cargos\)/);
    assert.equal(a.node('monthlyCargosShipped').textContent,'1');
  }finally{a.close();}
});


test('gráficos IM muestran el histórico de cajas por mes y año al abrir detalle',async()=>{
 const a=await app({isAdmin:true,now:Date.UTC(2026,9,21,21,0,0)});
 try{
  a.state.shippedIMRows=[
   {year:2024,month:6,count:418,latest:'2024-06-30'},
   {year:2024,month:7,count:23,latest:'2024-07-23'},
   {year:2025,month:4,count:50,latest:'2025-04-15'},
   {year:2025,month:6,count:130,latest:'2025-06-26'}
  ];
  a.node('btnReconnect').click();await flush();await flush();
  a.node('btnMonthlyShippedDetail').click();await flush();await flush();
  assert.equal(a.node('monthlyShippedSheet').open,true);
  assert.equal(a.node('imShippedYearSelect').value,'2025');
  assert.equal(a.node('imShippedLoadStatus').hidden,true);
  assert.match(a.node('imShippedMonthTitle').textContent,/Cajas enviadas por mes \(2025\)/);
  assert.equal(a.node('imShippedTotalValue').textContent,'180');
  assert.ok(a.node('imShippedMonthChart').querySelector('svg'));
  assert.ok(a.node('imShippedYearChart').querySelector('svg'));
  assert.match(a.node('imShippedYearChart').textContent,/418/);
  a.node('imShippedYearSelect').value='2024';
  a.node('imShippedYearSelect').dispatchEvent(new a.dom.window.Event('change'));
  assert.equal(a.node('imShippedTotalValue').textContent,'441');
 }finally{a.close();}
});
