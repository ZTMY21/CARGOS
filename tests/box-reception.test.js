import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import JSZip from 'jszip';
import {JSDOM} from 'jsdom';
import {renderReceptionOverview,requestReception,receptionTime,receptionStatus} from '../src/box-reception-ui.js';
import {REQ_TYPES} from '../src/rules.js';
import {setupRequirements} from '../src/requirements-ui.js';
import {parseReceptionScan} from '../src/box-scanner.js';
import {createReceptionFixture,appendReceivedBoxes} from '../server/reception-workbook.js';
import {appendPreparedBoxToMaster} from '../server/im-master-write.js';
import {createBoxReceptionHandler} from '../api/box-reception.js';

const settings={minimumBoxes:1};
const testCode=n=>'940021'+String(n).padStart(4,'0');
const codes=Array.from({length:100},(_,i)=>({clave:testCode(i+1),codigo:'T'+testCode(i+1)}));
const excelFields=['preparacion','responsable','celda','clasificacion','envio','entrega','recibe','placa'];

test('recepción requiere un código completo incluso cuando termina sin Enter',()=>{
  for(const code of ['T940021000','94002100','TD94002100011','T94002100-01','A9400210001','S/N']) {
    assert.equal(parseReceptionScan(code).ok,false,code);
  }
  for(const prefix of ['','T','TD','P','t','td','p']){
    assert.deepEqual(parseReceptionScan(prefix+'9400210001'),{
      ok:true,normalized:'9400210001',original:prefix+'9400210001'
    });
  }
});

test('el Maestro recibe exactamente 55 y 45 filas, preserva las partes del libro y acepta acondicionar la misma fila',async()=>{
  const fixture=await createReceptionFixture();
  const zip=await JSZip.loadAsync(fixture.bytes);
  const macroSentinel=Buffer.from('VBA de prueba para comprobar preservación de bytes');
  zip.file('xl/vbaProject.bin',macroSentinel);
  const fixtureWithVba=await zip.generateAsync({type:'nodebuffer'});
  const first=await appendReceivedBoxes(fixtureWithVba,codes.slice(0,55),settings);
  assert.equal(first.rows.length,57);
  assert.equal(Object.keys(first.added).length,55);
  assert.equal(first.rows[2].numero,'901');
  const saved=codes.slice(0,55).map(r=>({...r,guardado:'2026-11-07T15:00:00Z',correlativo:first.added[r.clave]}));
  const repeated=await appendReceivedBoxes(first.bytes,saved,settings);
  assert.equal(Object.keys(repeated.added).length,0);
  assert.deepEqual(repeated.bytes,first.bytes);
  const second=await appendReceivedBoxes(first.bytes,[...saved,...codes.slice(55)],settings);
  assert.equal(Object.keys(second.added).length,45);
  assert.equal(second.rows.length,102);
  for(const row of second.rows.slice(2)){
    assert.equal(row.receivedOnly,true);
    assert.deepEqual(row.cargos,[]);
    for(const field of excelFields) assert.equal(row[field],'',field);
  }
  assert.equal(new Set(second.rows.map(r=>r.numero)).size,102);
  assert.deepEqual(second.rows.slice(0,2),first.rows.slice(0,2));
  const modified=await JSZip.loadAsync(second.bytes);
  for(const path of Object.keys(zip.files).filter(path=>!zip.files[path].dir &&
    !['xl/worksheets/sheet1.xml','xl/tables/table1.xml'].includes(path))) {
    assert.deepEqual(await modified.file(path).async('nodebuffer'),await zip.file(path).async('nodebuffer'),path);
  }
  await assert.rejects(appendReceivedBoxes(first.bytes,codes.slice(0,55),settings),/IM_MASTER_EXISTING_BOX_CONFLICT/);
  await assert.rejects(appendReceivedBoxes(second.bytes,[{...saved[0],correlativo:1}],settings),/IM_MASTER_RECEIPT_NOT_VERIFIED/);
  const conditioned=await appendPreparedBoxToMaster(second.bytes,{
    code:codes[0].clave,cargos:['9876540'],classification:'Cajas Nuevas'
  },{...settings,preparacion:'2026-11-07',responsable:'Operador sintético'});
  assert.equal(conditioned.rows.length,second.rows.length);
  const prepared=conditioned.rows.find(row=>row.caja===codes[0].codigo);
  assert.equal(prepared.numero,'901');
  assert.deepEqual(prepared.cargos,['9876540']);
  assert.equal(prepared.envio,'');
});

test('producción muestra el avance existente sin habilitar acciones de recepción de prueba',async()=>{
  const markup=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(markup);
  try{
    const doc=dom.window.document, root=doc.getElementById('grp-cajas');
    const el=id=>doc.getElementById(id);
    const row={id:'solicitud',numero:'REQ-00001',tipo:REQ_TYPES[0],cantidadCajas:100,recibidoV4:55};
    renderReceptionOverview(root,[],true);
    assert.match(el('boxReceptionCount').textContent,/Sin solicitud activa/);
    renderReceptionOverview(root,[row],true);
    assert.match(el('boxReceptionCount').textContent,/55\/100/);
    assert.equal(el('boxReceptionBar').value,55);
    assert.equal(el('boxReceptionModeLabel').hidden,true);
    assert.equal(el('boxReceptionSave').disabled,true);
    assert.equal(el('boxReceptionConfirm').disabled,true);
    assert.equal(el('boxReceptionOpenExcel').href,
      'https://drive.google.com/file/d/14tW2-XqukNYozn4P67A7lrhjFfPveAmv/view?usp=drivesdk');
    assert.equal(el('boxReceptionOpenExcel').target,'_blank');
    assert.equal(el('boxReceptionOpenExcel').closest('#boxReceptionProgress'),null);
    assert.match(el('boxReceptionPending').textContent,/conciliación/);
    assert.deepEqual(requestReception(row,{suministro:{solicitudes:[{id:row.id,enviadas:55}]}}),
      {id:row.id,enviadas:55,confirmada:null,leidas:55});
    assert.equal(receptionTime('2026-11-07'),'07/11/2026 (Lima)');
    const matched=requestReception({...row,recibidoV4:30},{movimientos:[
      {requerimiento:row.id,tipo:'recepcion_fisica_informada',datos:{cantidad:100}}
    ]});
    assert.equal(matched.recepcion_fisica,100);
    assert.equal(matched.leidas,30);
    assert.equal(receptionStatus(matched),'Registro de cajas en proceso');
    assert.equal(receptionTime('2026-10-15'),'15/10/2026 (Lima)');
    renderReceptionOverview(root,[row],false);
    assert.equal(el('boxReceptionProgress').hidden,true);
  }finally{dom.window.close();}
});

test('Resumen separa el guardado en Excel de la confirmación completa',()=>{
  const dom=new JSDOM('<div id="workspace"></div>');
  try{
    const {document,HTMLDialogElement}=dom.window;
    HTMLDialogElement.prototype.close=function(){this.open=false;};
    HTMLDialogElement.prototype.showModal=function(){this.open=true;};
    const ui=setupRequirements(document.getElementById('workspace'),{
      context:()=>({allowed:true,id:'review'}),receptionEnabled:true
    });
    const row={id:'req',tipo:REQ_TYPES[0],numero:'REQ-00008',usuario:'Administrador de prueba',
      fechaSolicitud:'2026-10-15',cantidadCajas:100};
    const movement=(tipo,cantidad)=>({requerimiento:row.id,tipo,datos:{cantidad},registrado:'2026-11-07T22:00:00Z'});
    const movements=[movement('recepcion_fisica_informada',100),movement('recepcion_conciliada',30)];
    const show=(leidas,guardadas,extra=[])=>{
      ui.update([row],{cajas:[],suministro:{solicitudes:[{id:row.id,leidas,guardadas}]},
        movimientos:[...movements,...extra]});
      ui.showCard('nuevas');
      return [...document.querySelectorAll('.req-reception-timeline li strong')].map(node=>node.textContent);
    };
    const partial=['Solicitud de cajas nuevas','Guardado parcial de recepción'];
    const icons=()=>[...document.querySelectorAll('.req-reception-event-icon use')].map(node=>node.getAttribute('href'));
    assert.deepEqual(show(30,30),partial);
    assert.deepEqual(icons(),['#iv-box','#iv-box-receive']);
    assert.match(document.getElementById('req4DialogBody').textContent,/30 de 100 cajas registradas en el Excel/);
    assert.match(document.getElementById('req4DialogBody').textContent,/70 pendientes de registrar/);
    assert.doesNotMatch(document.getElementById('req4DialogBody').textContent,/Recepción física informada/);
    assert.deepEqual(show(100,30),partial);
    assert.equal(document.querySelector('.req-reception-progress').value,30);
    assert.deepEqual(show(100,100,[movement('recepcion_parcial',100)]),partial);
    assert.deepEqual(show(100,100,[movement('recepcion_parcial',100),movement('recepcion_completa',100)]),
      [...partial,'Se recibieron las 100 cajas']);
    assert.match(document.querySelector('.req-reception-timeline li[data-state="complete"]').textContent,
      /100 de 100 cajas registradas en el Excel/);
    assert.deepEqual(icons(),['#iv-box','#iv-box-receive','#iv-check']);
  }finally{dom.window.close();}
});

test('la API de recepción queda cerrada fuera de su rama y ante una base no aislada',async()=>{
  const env={VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'preview/recepcion-cajas-im',
    SUPABASE_URL:'https://qpbzfzcobkkfnoioqytb.supabase.co',KARDEX_RECEPCION_PRUEBA_SECRET:'a'.repeat(64)};
  for(const unsafe of [
    {...env,VERCEL_ENV:'production'},
    {...env,VERCEL_GIT_COMMIT_REF:'main'},
    {...env,SUPABASE_URL:'https://uhjwhamzjxhjqlrhgxho.supabase.co'},
    {...env,KARDEX_RECEPCION_PRUEBA_SECRET:''}
  ]){
    const res={setHeader(){},end(){},statusCode:0};
    await createBoxReceptionHandler({env:unsafe,fetcher:()=>assert.fail('contactó una dependencia externa')})({},res);
    assert.equal(res.statusCode,403);
  }
});

test('Supabase aplica propiedad, límite, conciliación idempotente y bloqueo hasta que todas las cajas estén listas',async()=>{
  const db=new PGlite();
  const owner='11111111-1111-4111-8111-111111111111';
  const stranger='22222222-2222-4222-8222-222222222222';
  const user='33333333-3333-4333-8333-333333333333';
  const migration = async name => db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  const one=async(sql,params=[]) => (await db.query(sql,params)).rows[0].result;
  const actor=id=>one("select set_config('request.jwt.claim.sub',$1,false) result",[id]);
  const req=(action,data,id=randomUUID())=>one('select public.kardex_req4_accion($1,$2,$3::jsonb) result',[id,action,JSON.stringify(data)]);
  const op=(action,id,code)=>one('select public.kardex_recepcion_operacion($1,$2,$3) result',[action,id,code]);
  const commit=(action,id,version,rows)=>one('select public.kardex_recepcion_prueba_excel($1,$2,$3,$4,$5,$6::jsonb) result',
    [action,id,'prueba-local',version,Buffer.from('bytes verificados por el API').toString('base64'),JSON.stringify(rows)]);
  try{
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        is_anonymous boolean default false,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated,anon;
      grant execute on function auth.uid() to authenticated,anon;
      insert into auth.users(id,email,email_confirmed_at) values
        ('${owner}','owner@example.test',now()),('${stranger}','other@example.test',now()),('${user}','guest@example.test',now());
    `);
    await migration('20261014013220_kardex_initial.sql');
    await db.exec(`
      insert into private.kardex_miembros(email,rol) values
        ('owner@example.test','admin'),('other@example.test','admin'),('guest@example.test','editor');
      create table public.im_envios_cargos_live(codigo_caja text,codigo_cargo text,fecha_envio date,fecha_preparacion date,clasificacion_caja text);
      alter table public.documentos add column fecha_origen date, add column anio_origen integer;
      create view public.kardex_documentos_resumen as
        select id,null::text im_live_codigo_caja,null::text im_codigo_caja,null::text im_caja_preparada,
          null::text im_historical_decision from public.documentos;
      create function private.req4_cargo(text) returns text language sql immutable as $$ select $1 $$;
      create view public.kardex_live_ingresos as select null::text cargo where false;
      create function private.req4_cargos_unicos(text[]) returns text[] language sql immutable as $$ select $1 $$;
    `);
    await migration('20261101195000_box_conditioning.sql');
    await migration('20261101200500_box_conditioning_rls.sql');
    await migration('20261104050000_requerimientos_intervencion_4.sql');
    await migration('20261106023211_req4_bloqueo_cajas_pendientes.sql');
    await migration('20261106023558_req4_codigos_suministro.sql');
    await migration('20261107172500_recepcion_cajas.sql');
    await migration('20261107175000_recepcion_prefijos.sql');
    await migration('20261107233000_recepcion_conciliada.sql');
    await migration('20261108001800_recepcion_maestro_drive.sql');
    await migration('20261108090000_acondicionamiento_integral.sql');
    await actor(owner);
    await db.exec(`
      insert into private.recepcion_maestro_prueba(archivo,secreto_hash,codigos)
        values(decode('0102','hex'),sha256(convert_to('prueba-local','UTF8')),'{"9900000700":700}');
      insert into public.documentos(cargos,usuario,periodo) values(array['9876540'],'Fixture','2026-11-01');
    `);
    const row=await req('crear',{tipo:'nuevas',cantidad:2});
    const id=row.id;
    assert.equal((await op('estado',null,null)).lecturas.length,0);
    await assert.rejects(req('recibir',{requerimiento:id,cantidad:2}),/Control de cajas/);
    await assert.rejects(op('leer',id,'T940021000'),/incompleto/);
    await assert.rejects(op('leer',id,'T9900000700'),/ya está registrada/);
    await actor(stranger);
    await assert.rejects(op('leer',id,codes[0].codigo),/otro administrador/);
    const other=await req('crear',{tipo:'nuevas',cantidad:1});
    await actor(user);
    await assert.rejects(op('leer',id,codes[0].codigo),/Solo administradores/);
    await actor(owner);
    assert.equal((await op('leer',id,codes[0].codigo)).lecturas.length,1);
    assert.equal((await op('leer',id,codes[0].clave)).duplicada,true);
    const lookup=code=>one("select public.kardex_acondicionamiento('buscar',$1) result",[code]);
    assert.equal((await lookup(codes[0].clave)).status,'inexistente');
    await actor(stranger);
    await assert.rejects(op('leer',other.id,codes[0].codigo),/otro requerimiento/);
    await actor(owner);
    await assert.rejects(commit('completa',id,0,{}),/todavía/);
    assert.equal((await commit('parcial',id,0,{[codes[0].clave]:901})).lecturas[0].correlativo,901);
    const box=await lookup('P'+codes[0].clave);
    assert.equal(box.status,'disponible');
    assert.equal(box.origen,'nueva');
    assert.equal(box.codigo,codes[0].codigo);
    const cargoInYear=year=>one("select public.kardex_acondicionamiento('cargo',$1,$2,array['9876540']) result",
      [box.codigo,year]);
    assert.equal((await cargoInYear(2026)).status,'disponible');
    assert.equal((await cargoInYear(2025)).status,'inexistente');
    await assert.rejects(commit('parcial',id,0,{[codes[0].clave]:901}),/Maestro cambió/);
    assert.equal((await op('estado',id,null)).lecturas.length,1);
    assert.equal((await op('leer',id,codes[1].codigo.toLowerCase())).lecturas[1].codigo,codes[1].codigo.toLowerCase());
    await assert.rejects(op('leer',id,codes[2].codigo),/cantidad solicitada/);
    const complete=await commit('completa',id,1,{[codes[1].clave]:902});
    assert.ok(complete.confirmada);
    assert.equal((await commit('completa',id,2,{})).confirmada,complete.confirmada);
    await assert.rejects(req('crear',{tipo:'nuevas',cantidad:100}),/No se pueden solicitar/);
    const condition=async({codigo})=>{
      for(const action of ['iniciar','finalizar'])await one(
        'select public.kardex_box_conditioning_write($1,$2,$3,$4,$5) result',
        [action,codigo,['9876540'],'Cajas Nuevas','']);
    };
    await condition(codes[0]);
    await assert.rejects(req('crear',{tipo:'nuevas',cantidad:1}),/No se pueden solicitar/);
    await condition(codes[1]);
    const live=await req('crear',{tipo:'nuevas',cantidad:100});
    assert.equal(live.cantidad_cajas,100);
    const detail=await one('select public.kardex_req4_detalle() result');
    assert.deepEqual(detail.movimientos.filter(x=>x.requerimiento===id).map(x=>x.tipo),
      ['crear','recepcion_parcial','recepcion_completa']);
    await db.exec("delete from private.recepcion_maestro_prueba; insert into private.recepcion_maestro_produccion(secreto_hash) values(sha256(convert_to('solo-prueba','UTF8')))");
    const lease=await one("select public.kardex_im_master_lock('tomar',null) result");
    const liveSave=(action,rows,token=lease.token)=>one(
      'select public.kardex_recepcion_produccion_excel($1,$2,$3,$4,$5,$6::jsonb) result',
      [action,live.id,'solo-prueba',token,'revision-drive',JSON.stringify(rows)]);
    await assert.rejects(liveSave('estado',{}),/no está habilitado/);
    await db.exec('update private.recepcion_maestro_produccion set habilitada=true');
    await assert.rejects(liveSave('estado',{},randomUUID()),/reserva del Excel/);
    assert.equal((await one("select public.kardex_im_master_lock('tomar',null) result")).token,null);
    await op('leer',live.id,codes[2].codigo);
    await assert.rejects(liveSave('completa',{[codes[2].clave]:903}),/aún no permite/);
    const productionSaved=await liveSave('parcial',{[codes[2].clave]:903});
    assert.equal(productionSaved.lecturas[0].correlativo,903);
    assert.equal(productionSaved.confirmada,null);
    assert.equal((await liveSave('parcial',{})).lecturas.length,1);
    await one("select public.kardex_im_master_lock('liberar',$1) result",[lease.token]);
    await assert.rejects(liveSave('estado',{}),/reserva del Excel/);

  }finally{await db.close();}
});
