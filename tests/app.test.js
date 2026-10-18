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
import {createIdleSession} from '../src/idle-session.js';
import {cargoYear,invoiceLocation,locationLabel,groupsForCodes} from '../src/cargo-details.js';

const flush=()=>new Promise(resolve=>setTimeout(resolve,20));
const reqRow={id:randomUUID(),numero:'REQ-00001',tipo:'Cajas nuevas para acondicionar',fecha_solicitud:'2026-10-01',cantidad_cajas:2,numeros_cargo:'',fecha_recepcion:'2026-10-02',fecha_devolucion:null,usuario:'Juan',updated_at:'2026-10-13T00:00:00.123456Z'};
const docRow={id:randomUUID(),kardex:'SA-00001',fecha_registro:'2026-10-13',tipo_doc:'Facturas-Guia',periodo:'2026-01-01',ubicacion:'Santa Anita',folios:30,cargos:['C001'],caja_asignada:reqRow.id,f_envio:null,sustento:'',sustento_imagen:'',usuario:'Juan',facturas:'F-001',obs:'',updated_at:'2026-10-13T00:00:00.123456Z'};

async function app({allowed=true,isAdmin=true,failSave=false,signedIn=true,recovery=false,loginError=null,enableSearch=false}={}) {
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const source=(await readFile(new URL('../src/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const dom=new JSDOM(html,{url:'https://kardex.example.test'+(recovery?'#type=recovery':''),runScripts:'outside-only'});
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  const state={reqs:[structuredClone(reqRow)],docs:[structuredClone(docRow)],updates:[],snapshots:0,events:[],status:null,authCallback:null};
  state.session=signedIn?{user:{id:'owner',email:'owner@example.test'}}:null;
  state.syncRow={enabled:true,status:'Revisión completada: 276 cargos ya registrados. 1480 filas pendientes.',
    last_checked_at:'2026-10-17T03:09:17Z',
    last_result:{groups:276,pending_rows:1480,conflictos:0,cargos_nuevos:0,cargos_actualizados:0}};
  state.authCalls=[];state.exportCalls=[];state.searchCalls=[];state.now=Date.now();
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
  Object.assign(context,{createIdleSession:options=>createIdleSession({...options,now:()=>state.now}),createClient:()=>client,KardexRepository:FakeRepository,reqFromDb,docFromDb,reqEstado,docEstado,fmtDate,escapeHtml,buildWorkbook:async(...args)=>{state.exportCalls.push(args);return {xlsx:{writeBuffer:async()=>new Uint8Array([1])}};},buildCargoWorkbook:async(cargo)=>{state.guestExport=cargo;return {xlsx:{writeBuffer:async()=>new Uint8Array([1])}};},parseWorkbook,highlightMatch,filterDocuments,filterRequirements,cargoYear,invoiceLocation,locationLabel,groupsForCodes,
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

test('guest registration requires a password and does not authorize the account',async()=>{
 const a=await app({signedIn:false});
 try{
  a.node('authEmail').value='GUEST@EXAMPLE.TEST';a.node('authPassword').value='short';
  a.node('btnRegister').click();await flush();assert.equal(a.state.authCalls.length,0);
  a.node('authPassword').value='test-password';a.node('btnRegister').click();await flush();
  assert.equal(a.state.authCalls[0][0],'signup');assert.equal(a.state.authCalls[0][1].email,'guest@example.test');
  assert.equal(a.node('appShell').hidden,true);assert.equal(a.state.snapshots,0);
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
  assert.match(a.node('btnOpenIronMountainExcel').href,/1ap1GzGd3HBvkV2N7p6dvkFIYwHS_cIqO/);
  assert.equal(a.node('btnOpenIronMountainExcel').target,'_blank');
  assert.match(a.node('btnOpenGoogleExcel').href,/1GvTelpW7OQnt4sl_e-AfmWnNdSFQnL7E/);
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
    assert.doesNotMatch(a.node('sessionProfile').textContent,/Administrador|Invitado|[0-9]{2}\\/[0-9]{2}\\/20[0-9]{2}/);
    assert.equal(a.node('googleSyncPanel').hidden,false);
    assert.equal(a.node('googleSyncBadgeText').textContent,'ACTIVA');
    assert.equal(a.node('googleSyncRegistered').textContent,'276');
    assert.equal(a.node('googleSyncPending').textContent,'1,480');
    assert.equal(a.node('googleSyncConflicts').textContent,'0');
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
  assert.match(cells[6].textContent,/Ubicación: Grupo 2, Grupo 17/);
  assert.equal(a.node('sustentoHeader'),null);
  assert.doesNotMatch(a.node('tbody').textContent,/PRIVATE-SUPPORT|Fecha en origen/);
 }finally{a.close();}
 }
});

test('loading shell hides login before JavaScript and authenticated loading never shows the login panel',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const dom=new JSDOM(html);try{
  assert.equal(dom.window.document.getElementById('authOverlay').hidden,true);
  assert.equal(dom.window.document.getElementById('sessionLoading').hidden,false);
 }finally{dom.window.close();}
 const a=await app();try{
  assert.equal(a.node('sessionLoading').hidden,true);
  assert.equal(a.node('authOverlay').hidden,true);
  assert.deepEqual(a.state.loadingDuringAccess,{loading:true,login:false});
 }finally{a.close();}
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
    const rows=()=>[...a.dom.window.document.querySelectorAll('.periodo-box .periodo-fila')]
      .map(row=>row.textContent.replace(/\s+/g,' ').trim());
    await refresh();
    assert.deepEqual(rows(),['2020 1 cargos','2024 2 cargos','2025 1 cargos','2026 1 cargos']);
    assert.match(a.node('resumenTablas').textContent,/Cargos por Año/);
    assert.match(a.node('resumenTablas').textContent,/2026 se actualiza desde Google Sheets/);
    a.state.docs.push(current('N2'));
    await refresh();
    assert.deepEqual(rows(),['2020 1 cargos','2024 2 cargos','2025 1 cargos','2026 2 cargos']);
    assert.match(a.node('resumenTablas').querySelector('.kpis .kpi .n').textContent,/^6\b/);
  }finally{a.close();}
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
      assert.equal(a.node('tbody').querySelector('tr').cells[11].textContent.trim(),'Sin Responsable');

      a.state.docs[0].usuario='Importacion Excel';
      a.node('btnReconnect').click();await flush();
      assert.equal(a.node('tbody').querySelector('tr').cells[11].textContent.trim(),'Sin Responsable');

      a.state.docs[0].usuario='RESPONSABLE REAL';
      a.node('btnReconnect').click();await flush();
      assert.equal(a.node('tbody').querySelector('tr').cells[11].textContent.trim(),'RESPONSABLE REAL');
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
      assert.equal(cells[5].textContent.trim(),'3384A');
      assert.equal(cells[7].textContent.trim(),'2032192096');
      assert.equal(cells[8].textContent.trim(),'12/06/2024');
      assert.match(cells[9].textContent,/Enviado/);
      assert.match(cells[9].querySelector('.badge').className,/b-enviado/);
      assert.equal(cells[9].textContent.trim(),'Enviado');
      assert.equal(cells[11].textContent.trim(),'BILLY SALVADOR');
      assert.doesNotMatch(a.node('tbody').textContent,/La hoja de origen declara cargos enviados|Cargos enviados 2023/);
      assert.match(a.node('resumenTablas').textContent,/Enviado Iron Mountain[\\s\\S]*1/);
      assert.match(a.node('resumenTablas').textContent,/Pendiente de Envío a IM[\\s\\S]*0/);
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
