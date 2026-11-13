import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {PDFDocument} from 'pdf-lib';
import {composePickupMail} from '../src/pickup-mail-template.js';
import {createDemoPickupWorkflow,demoPickupBoxes,validatePickupPdf} from '../src/pickup-workflow-demo.js';
import {pickupAttachments} from '../server/pickup-workbook.js';
import {writeDemoPickupWorkbooks} from '../server/pickup-demo-workbooks.js';

const templates=type=>readFile(new URL('../server/templates/pickup-'+type.toLowerCase()+'.xlsx',import.meta.url));
const byType=type=>demoPickupBoxes.filter(box=>box.type===type);
for(const [newCount,returns] of [[30,30],[8,12],[0,7],[18,0]]){
  test('un correo y un formato por tipo: '+newCount+' nuevas, '+returns+' devolución',async()=>{
    const boxes=[...byType('NUEVAS').slice(0,newCount),...byType('DEVOLUCION').slice(0,returns)]
      .map(box=>({...box,box_created_at:'2026-11-06',cargos:['300','400'],documents:['NO-VA-EN-EL-EXCEL']}));
    const detail={boxes,created_at:'2026-11-09T03:00:00Z',subject:'Recojo {{nuevas}}/{{devoluciones}}',
      sender:'sender@example.invalid',to:['receiver@example.invalid'],cc:[],id:crypto.randomUUID(),
      signature:{name:'Prueba',company:'Kárdex'}};
    const files=await pickupAttachments(detail,templates);
    const mail=composePickupMail(detail,files);
    assert.equal(mail.subject,'Recojo '+newCount+'/'+returns);
    assert.doesNotMatch(mail.text,/TD9900|T9800|300-400/);
    assert.doesNotMatch(mail.html,/TD9900|T9800|300-400/);
    if(newCount)assert.ok(mail.text.includes(newCount+' cajas nuevas'));
    if(returns)assert.ok(mail.text.includes(returns+' cajas para devolución'));
    assert.equal((mail.eml.match(/X-Unsent: 1/g)||[]).length,1);
    assert.equal((mail.eml.match(/Content-Disposition: attachment;/g)||[]).length,files.length);
    assert.equal(files.length,Number(!!newCount)+Number(!!returns));
    for(const file of files){
      const book=await new ExcelJS.Workbook().xlsx.load(file.bytes);
      const sheet=book.getWorksheet('Numero de Orden ');
      const type=file.filename.includes('NUEVAS')?'NUEVAS':'DEVOLUCION';
      const expected=boxes.filter(box=>box.type===type);
      assert.match(file.filename,/8-11\.xlsx$/);
      assert.deepEqual(sheet.getColumn('A').values.slice(2).filter(Boolean),expected.map(box=>box.code));
      for(const [i,box] of expected.entries()){
        const row=i+2;
        assert.equal(sheet.getCell('C'+row).value,box.code);
        assert.equal(sheet.getCell('B'+row).value,'PY809');
        const fields=type==='NUEVAS'
          ? {D:'-',E:'-',F:'LGT',G:'FACTURA/GUIA',J:'300-400',K:'-'}
          : {D:box.code,E:'PY809',F:box.code,G:'-',H:'-',I:'LGT',J:'FACTURA/GUIA',M:'300-400',N:'-'};
        for(const [col,value] of Object.entries(fields))assert.equal(sheet.getCell(col+row).value,value);
        for(const col of type==='NUEVAS'?['H','I']:['K','L']){
          assert.equal(sheet.getCell(col+row).value.toISOString().slice(0,10),box.box_created_at);
        }
      }
    }
  });
}

test('retiro 25 + 8, falla de sincronización, reintento, PDF único e idempotencia',async()=>{
  const doc=await PDFDocument.create();
  doc.addPage();doc.addPage();
  const bytes=await doc.save();
  const file={name:'Prueba.pdf',arrayBuffer:async()=>bytes.buffer};
  let rejectOnce=true;
  const flow=createDemoPickupWorkflow({renderMail:async()=>({}),clock:()=>new Date('2026-11-08T20:00:00Z'),
    async writeWorkbooks(visits){
      if(rejectOnce){rejectOnce=false;throw Error('Fallo simulado');}
      return writeDemoPickupWorkbooks(visits);
    }});
  const newBoxes=byType('NUEVAS'),returned=byType('DEVOLUCION');
  await assert.rejects(flow.prepare({keys:newBoxes.map(box=>box.key)}),/máximo de 30/);
  const boxes=[...newBoxes.slice(0,30),...returned.slice(0,12)];
  const batch=await flow.prepare({keys:boxes.map(box=>box.key)});
  assert.equal((await flow.state()).available.filter(box=>box.type==='NUEVAS').length,5);
  await assert.rejects(flow.prepare({keys:[boxes[0].key]}),/códigos elegidos/);
  await flow.mail('download',batch.id);
  await flow.mark(batch.id,'CONFIRMADO');
  await flow.schedule(batch.id,{NUEVAS:'2026-11-08',DEVOLUCION:'2026-11-09'});
  assert.equal(batch.visits.length,0);
  await flow.schedule(batch.id,{NUEVAS:'2026-11-08',DEVOLUCION:'2026-11-08'});
  assert.equal(batch.events.length,2);
  const codes=[...boxes.slice(0,25),...boxes.slice(30,38)].map(box=>box.code);
  const visitId=crypto.randomUUID();
  await assert.rejects(flow.confirm(batch.id,{visitId,codes,date:'2026-11-08'}),/Adjunta el PDF/);
  await assert.rejects(flow.confirm(batch.id,{visitId,codes,date:'2026-11-08',file}),/Fallo simulado/);
  assert.equal(batch.visits[0].synced,false);
  const success=await flow.retry(batch.id,visitId);
  assert.equal(success.count,33);
  assert.equal(batch.boxes.length-batch.visits[0].codes.length,9);
  assert.equal(batch.visits[0].synced,true);
  await flow.schedule(batch.id,{NUEVAS:'2026-11-10',DEVOLUCION:'2026-11-08'});
  assert.equal(batch.visits[0].date,'2026-11-08');
  assert.equal(batch.schedule.NUEVAS,'2026-11-10');
  const duplicate=await flow.confirm(batch.id,{visitId,codes,date:'2026-11-08',file});
  assert.equal(duplicate.count,33);
  assert.equal(batch.visits.length,1);
  assert.equal((await flow.pdf(batch.id,visitId)).size,bytes.length);
  assert.equal(success.files.length,2);
});

test('el PDF se analiza, debe tener 1 o 2 páginas y máximo 5 MB',async()=>{
  await assert.rejects(validatePickupPdf(new TextEncoder().encode('texto')),/PDF válido/);
  await assert.rejects(validatePickupPdf(new Uint8Array(5*1024*1024+1)),/5 MB/);
  const doc=await PDFDocument.create();
  for(let i=0;i<3;i++)doc.addPage();
  await assert.rejects(validatePickupPdf(await doc.save()),/1 o 2 páginas/);
});

test('el formulario conserva el sustento y reintenta la misma visita si falla la carga',async()=>{
  const {JSDOM}=await import('jsdom');
  const {attachPickupWorkflow}=await import('../src/pickup-workflow-ui.js');
  const {createLivePickupWorkflow}=await import('../src/pickup-workflow-live.js');
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
  globalThis.document=dom.window.document;
  const dialog=document.getElementById('pickupDialog');
  dialog.showModal=()=>dialog.setAttribute('open','');
  dialog.close=()=>dialog.removeAttribute('open');
  const id=crypto.randomUUID(),user=crypto.randomUUID(),job=crypto.randomUUID();
  const box=byType('NUEVAS')[0];
  const batch={id,status:'CONFIRMADO',boxes:[box],visits:[],schedule:{NUEVAS:'2026-11-13'}};
  const doc=await PDFDocument.create();
  doc.addPage();
  const file=new Blob([await doc.save()],{type:'application/pdf'});
  const messages=[],sources=[];
  let firstReadback=true,archiveInput;
  const workflow=createLivePickupWorkflow({
    auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:user}}}})},
    rpc:async()=>{
      if(sources.length===1&&firstReadback){firstReadback=false;throw Error('No se pudo leer el historial');}
      return {data:{available:[],batches:[batch]}};
    }
  });
  globalThis.fetch=async(path,options)=>{
    if(path.includes('action=start')){
      archiveInput=JSON.parse(options.body);
      sources.push(archiveInput.sourceKey);
      return sources.length===1?Response.json({error:'ARCHIVE_GATEWAY_UNAVAILABLE'},{status:503}):
        Response.json({id:job,status:'uploading',offset:0});
    }
    if(path.includes('action=chunk')){
      assert.equal(options.body.byteLength,file.size);
      return Response.json({id:job,status:'uploaded',offset:file.size});
    }
    if(path.includes('action=finish')){
      return Response.json({id:job,status:'verified',backendVerified:true,sha256:archiveInput.sha256});
    }
    assert.equal(path,'/api/pickup-mail');
    const visit=sources[0].split(':')[2];
    assert.deepEqual(JSON.parse(options.body),{action:'confirm',id,visit,codes:[box.code],date:'2026-11-13',job});
    batch.visits.push({id:visit,date:'2026-11-13',codes:[box.code],actor:'Prueba',synced:true});
    return Response.json({id:visit,verified:true});
  };
  const waitFor=async predicate=>{
    for(let attempt=0;attempt<50&&!predicate();attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(predicate());
  };
  try{
    const ui=attachPickupWorkflow({workflow,showPreview(){},notify:message=>messages.push(message)});
    await ui.activate();
    [...document.querySelectorAll('#pickupMailBatches button')].find(b=>b.textContent==='Adjuntar sustento PDF').click();
    const form=dialog.querySelector('form');
    const submit=form.querySelector('button[type=submit]');
    form.querySelector('input[type=date]').value='2026-11-13';
    const group=form.querySelector('input[value=NUEVAS]');
    group.checked=true;
    form.querySelector('input[required][type=checkbox]').checked=true;
    const input=form.querySelector('input[type=file]');
    Object.defineProperty(input,'files',{value:[file]});
    form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    await waitFor(()=>form.textContent.includes('Pulsa Confirmar recojo para reintentar.')&&!submit.disabled);
    assert.ok(dialog.open&&group.checked);
    assert.equal(input.files[0],file);
    assert.deepEqual(messages,[]);
    form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    await waitFor(()=>messages.includes('Recojo confirmado · Sincronizado.'));
    assert.equal(dialog.open,false);
    assert.deepEqual(sources,[sources[0],sources[0]]);
    assert.equal(batch.visits.length,1);
  }finally{
    globalThis.document=oldDocument;
    globalThis.fetch=oldFetch;
    dom.window.close();
  }
});

test('la bandeja permite seleccionar ambas clases aunque la consulta a Drive falle',async()=>{
  const {JSDOM}=await import('jsdom');
  const {attachPickupWorkflow}=await import('../src/pickup-workflow-ui.js');
  const {createLivePickupWorkflow}=await import('../src/pickup-workflow-live.js');
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html);
  const oldDocument=globalThis.document,oldConfirm=globalThis.confirm;
  globalThis.document=dom.window.document;
  globalThis.confirm=()=>true;
  const dialog=document.getElementById('pickupDialog');
  dialog.showModal=()=>dialog.setAttribute('open','');
  dialog.close=()=>dialog.removeAttribute('open');
  const boxes=[byType('NUEVAS')[0],byType('DEVOLUCION')[0]];
  const batches=[];
  const client={rpc:async(_name,args)=>{
    if(args.p_action==='state')return {data:{available:batches.length?[]:boxes,batches}};
    assert.equal(args.p_action,'register_sent');
    assert.deepEqual(args.p_data.keys,boxes.map(box=>box.key).sort());
    batches.push({id:args.p_id,status:'CONFIRMADO',external_mail:true,boxes,visits:[]});
    return {data:{id:args.p_id}};
  }};
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  let failDrive;
  const drive=new Promise((_,reject)=>{failDrive=reject;});
  const workflow=createLivePickupWorkflow(client,{refreshMaster:()=>drive});
  const ui=attachPickupWorkflow({workflow,showPreview(){},notify(){},config:()=>({})});
  try{
    const activating=ui.activate();
    await tick();
    const choices=[...document.querySelectorAll('#pickupSelections button')];
    assert.equal(choices.length,2);
    assert.ok(choices.every(button=>!button.disabled));
    failDrive(Error('Drive temporalmente inaccesible'));
    await activating;
    assert.match(document.getElementById('pickupSelections').textContent,/último corte verificado/);
    document.querySelector('#pickupSelections button').click();
    for(const check of dialog.querySelectorAll('.pickup-box-row input'))check.click();
    [...dialog.querySelectorAll('button')].find(b=>b.textContent==='Continuar a un solo correo').click();
    assert.equal(document.getElementById('pickupPrepare').disabled,false);
    document.getElementById('pickupRegisterSent').click();
    await tick();
    assert.match(document.getElementById('pickupMailBatches').textContent,/Registrar fecha de recojo/);
  }finally{
    globalThis.document=oldDocument;
    globalThis.confirm=oldConfirm;
    dom.window.close();
  }
});

test('al generar un aviso, muestra el mensaje y todas las cajas del borrador por tipo',async()=>{
  const {JSDOM}=await import('jsdom');
  const {attachPickupMail}=await import('../src/pickup-mail-ui.js');
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const oldDocument=globalThis.document;
  globalThis.document=dom.window.document;
  const el=id=>document.getElementById(id);
  const dialog=el('pickupDialog');
  dialog.showModal=()=>dialog.setAttribute('open','');
  dialog.close=()=>dialog.removeAttribute('open');
  const boxes=[byType('NUEVAS')[0],byType('DEVOLUCION')[0],byType('DEVOLUCION')[1]];
  let prepared=false;
  const id=crypto.randomUUID();
  const message='Buenas tardes, Jorge:\r\n\r\n• 1 caja para almacenamiento\r\n• 2 cajas de retorno';
  const workflow={
    async state(){return {available:prepared?[]:boxes,batches:[]};},
    async prepare({keys}){
      assert.deepEqual(keys,boxes.map(box=>box.key).sort());
      prepared=true;
      return {id};
    },
    async mail(action,batchId){
      assert.equal(action,'preview');
      assert.equal(batchId,id);
      return {text:message,subject:'Ingreso de cajas',from:'test@example.invalid',to:['test@example.invalid'],
        attachments:['NUEVAS.xlsx','DEVOLUCION.xlsx'],boxDetails:boxes};
    }
  };
  const mail=attachPickupMail({workflow,isAdmin:()=>true,appReady:()=>true,isPreview:()=>false});
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  try{
    mail.activate();
    await tick();
    el('pickupSelections').querySelector('button').click();
    for(const checkbox of dialog.querySelectorAll('.pickup-box-row input'))checkbox.click();
    [...dialog.querySelectorAll('button')].find(button=>button.textContent==='Continuar a un solo correo').click();
    el('pickupPrepare').click();
    await tick();
    assert.equal(el('pickupPreviewDetails').open,true);
    assert.equal(el('pickupMailPreview').textContent,message);
    const list=el('pickupDraftFooter').querySelector('.pickup-mail-boxes');
    assert.deepEqual([...list.querySelectorAll('li')].map(box=>box.textContent),boxes.map(box=>box.code));
    assert.deepEqual([...list.querySelectorAll('h5')].map(title=>title.textContent),
      ['Cajas nuevas · 1','Cajas para devolución · 2']);
  }finally{
    globalThis.document=oldDocument;
    dom.window.close();
  }
});

test('Simular correo sin enviar abre Ver correo generado con ambos Excel y todas las cajas ficticias',async()=>{
  const {JSDOM}=await import('jsdom');
  const {attachPickupMail}=await import('../src/pickup-mail-ui.js');
  const {attachInterventionExperience}=await import('../src/intervention-experience.js');
  const {createLivePickupWorkflow}=await import('../src/pickup-workflow-live.js');
  const {createPickupMailHandler}=await import('../api/pickup-mail.js');
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
  globalThis.document=dom.window.document;
  const el=id=>document.getElementById(id);
  const requests=[];
  const handler=createPickupMailHandler({
    env:{VERCEL_ENV:'production',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'key'},
    fetcher:async url=>{
      requests.push(url);
      if(url.endsWith('/auth/v1/user'))return Response.json({id:'admin-fixture'});
      assert.match(url,/\/rpc\/kardex_access$/);
      return Response.json({allowed:true,is_admin:true});
    }
  });
  globalThis.fetch=async (path,{method,headers,body})=>{
    assert.equal(path,'/api/pickup-mail');
    assert.equal(JSON.parse(body).action,'sample');
    const response={setHeader(){},end(value){this.body=value;}};
    await handler({method,headers:{authorization:headers.Authorization},body},response);
    return new Response(response.body,{status:response.statusCode});
  };
  const workflow=createLivePickupWorkflow({
    auth:{getSession:async()=>({data:{session:{access_token:'fixture-token'}}})},
    rpc:async (_name,{p_action})=>{
      assert.equal(p_action,'state');
      return {data:{available:[],batches:[]}};
    }
  });
  const mail=attachPickupMail({workflow,isAdmin:()=>true,appReady:()=>true,isPreview:()=>false});
  const visuals=attachInterventionExperience({doc:document,simulatePickupMail:mail.simulate});
  try{
    mail.activate();
    await new Promise(resolve=>setImmediate(resolve));
    el('ivMailSimShortcut').click();
    for(let attempt=0;attempt<100&&!el('pickupPreviewDetails').open;attempt++){
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(el('pickupPreviewDetails').open,true);
    assert.match(el('pickupDraftCard').textContent,/SIMULACIÓN|Simulación/);
    assert.match(el('pickupDraftCard').textContent,/INGRESO DE CAJAS A IRON MOUNTAIN/);
    assert.match(el('pickupMailPreview').textContent,/almacenamiento[\s\S]*rearchivamiento/);
    assert.equal(el('pickupDraftFooter').querySelectorAll('.pickup-attachments button').length,2);
    assert.equal(el('pickupDraftFooter').querySelectorAll('.pickup-mail-boxes li').length,60);
    assert.equal(requests.length,2);
  }finally{
    visuals.disconnect();
    globalThis.document=oldDocument;
    globalThis.fetch=oldFetch;
    dom.window.close();
  }
});
