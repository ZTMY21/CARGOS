import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {attachConditioningWorkspace} from '../src/conditioning-workspace.js';
import {JSDOM} from 'jsdom';
import ExcelJS from 'exceljs';
import {drawBoxBarcode} from '../src/box-code128.js';
import {physicalBoxKey,matchesAssignedBoxCode} from '../src/search.js';
import {createReceptionFixture,appendReceivedBoxes} from '../server/reception-workbook.js';
import {readMasterRows} from '../server/im-master-workbook.js';
import {updateConditioningWorkbooks} from '../server/conditioning-workbooks.js';

test('Code 128 representa el código completo y conserva sus ceros',()=>{
  const dom=new JSDOM('<svg hidden></svg>');
  const svg=dom.window.document.querySelector('svg');
  drawBoxBarcode(svg,'TD0900000019');
  assert.equal(svg.hasAttribute('hidden'),false);
  assert.equal(svg.getAttribute('viewBox'),'0 0 187 58');
  assert.equal(svg.getAttribute('aria-label'),'Código de barras TD0900000019');
  assert.equal(svg.querySelectorAll('rect').length,46);
  for(const code of ['TD0900000019','T0900000019','D0900000019','P 0900-000019','0900000019']){
    assert.equal(physicalBoxKey(code),'0900000019');
    assert.equal(matchesAssignedBoxCode('TD0900000019',code,true),true);
  }
  assert.equal(matchesAssignedBoxCode('TD0900000019','900000019',true),false);
  drawBoxBarcode(svg,'');
  assert.equal(svg.hasAttribute('hidden'),true);
  dom.window.close();
});

test('preparación, primer despacho y retorno actualizan copias sin duplicar filas',async()=>{
  const fixture=await createReceptionFixture();
  const reception=await appendReceivedBoxes(fixture.bytes,[{clave:'9000000200',codigo:'TD9000000200'}],{minimumBoxes:1});
  const archive=new ExcelJS.Workbook(),sheet=archive.addWorksheet('REGISTRO');
  sheet.addRow(['N°','FECHA DE PREPARACIÓN','RESPONSABLE','CÓDIGO DE BARRAS','CARGOS','FECHA DE ENVÍO','ENTREGA','RECIBE','PLACA']);
  sheet.addRow([1,'20/06/2025','OPERADOR','TD0900000019','00123-124-125-126','20/06/2025']);
  const historical=Buffer.from(await archive.xlsx.writeBuffer());
  const common={preparada:'2026-11-08',responsable:'Operador de prueba'};
  const newBox={...common,id:'nueva',codigo:'TD9000000200',origen:'nueva',cargos:['00943','942']};
  const requested={...common,id:'retorno-1',solicitud:'solicitud-1',codigo:'TD0900000019',origen:'solicitada',
    cargos:['00123','124','125','126'],solicitada:'2026-11-02'};
  const first=await updateConditioningWorkbooks(reception.bytes,historical,[newBox,requested]);
  const rows=await readMasterRows(first.maestro,{minimumBoxes:1});
  assert.equal(rows.at(-1).celda,'00943-942');
  assert.equal(rows.at(-1).preparacion,'2026-11-08');
  assert.equal(rows.at(-1).envio,'');
  assert.deepEqual(first.historico,historical);
  const shipment=[{...newBox,enviada:'2026-11-08'},{...requested,enviada:'2026-11-08',placa:'ABC-123'}];
  const sent=await updateConditioningWorkbooks(first.maestro,first.historico,shipment);
  const retry=await updateConditioningWorkbooks(sent.maestro,sent.historico,shipment);
  const result=new ExcelJS.Workbook();
  await result.xlsx.load(retry.historico);
  assert.equal(result.worksheets[0].getCell('F2').value,'20/06/2025');
  assert.equal(result.worksheets[0].getCell('K2').value,'08/11/2026');
  assert.equal(result.worksheets[0].getCell('Q2').value,'ABC-123');
  assert.equal(result.worksheets[0].getCell('D3').value,newBox.codigo);
  assert.deepEqual(retry.historico,sent.historico);
});

test('pantalla recibe Enter, habilita el guardado por año y muestra reintento si falla Excel',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html);
  globalThis.document=dom.window.document;
  let outcome='inexistente',saves=0,scan;
  const prepared={codigo:'TD0900000019',origen:'nueva',cargos:['00943','942'],preparada:'2026-11-08',
    responsable:'Operador',revision:1,sincronizada:0};
  const repository={
    async conditioning(action,data){
      if(action==='listar')return {nuevas:1,solicitadas:0,preparadas:saves,listado:saves?[prepared]:[]};
      if(action==='buscar'){
        scan=data.p_codigo;
        if(scan==='TD0900000018')return {codigo:scan,origen:'solicitada',status:'no_recibida',cargos:['00943']};
        return {codigo:prepared.codigo,origen:'nueva',status:'disponible'};
      }
      if(action==='cargo'){
        assert.equal(data.p_anio,2025);
        return {status:outcome,codigo:'00943'};
      }
      saves++;
      return prepared;
    },
    async reception(){return null;},
    async conditioningExcel(){throw Error('network');}
  };
  const controller=attachConditioningWorkspace({repository});
  try{
    const get=id=>document.getElementById(id);
    const settle=()=>new Promise(resolve=>setImmediate(resolve));
    controller.activate();
    assert.equal(get('acondCargo1').readOnly,true);
    assert.match(get('acondCargoHint').textContent,/Primero consulta/);
    get('acondScan').value='TD0900000018';
    get('acondScanForm').requestSubmit();
    await settle();
    assert.equal(get('acondCargo1').readOnly,true);
    assert.match(get('acondCargoHint').textContent,/Confirma la recepción/);
    get('acondScan').value='P0900000019';
    get('acondScanForm').requestSubmit();
    await settle();
    assert.equal(scan,'P0900000019');
    assert.equal(get('acondBarcodeCode').textContent,prepared.codigo);
    assert.equal(get('acondBarcode').hasAttribute('hidden'),false);
    assert.equal(get('acondCargo1').readOnly,false);
    assert.match(get('acondCargoHint').textContent,/Enter o la flecha/);
    get('acondYears').querySelector('[value="2025"]').click();
    const cargo=get('acondCargo1');
    cargo.value='943';
    cargo.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter'}));
    await settle();
    assert.match(cargo.parentElement.textContent,/No existe el cargo/);
    assert.equal(get('acondSave').disabled,true);
    outcome='disponible';
    cargo.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter'}));
    await settle();
    get('acondSave').click();
    await settle();
    assert.equal(saves,1);
    assert.equal(get('acondScan').value,'');
    assert.equal(get('acondCargo1').value,'');
    assert.equal(get('acondCargo2').value,'');
    assert.equal(get('acondPrepared').textContent,'1');
    assert.equal(get('acondProgressTrack').hidden,true);
    assert.equal(get('acondRetry').hidden,false);
    assert.match(get('acondList').textContent,/00943-94208\/11\/2026/);
    assert.equal(get('acondSave').disabled,true);
    assert.equal(document.querySelectorAll('#grp-acondicionamiento progress').length,1);
  }finally{
    controller.reset();
    dom.window.close();
    delete globalThis.document;
  }
});

test('avance de preparación usa la misma solicitud y el total del Centro de escaneo',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html);
  globalThis.document=dom.window.document;
  const lecturas=Array.from({length:30},(_,i)=>({
    codigo:'T'+String(9400000000+i),guardado:'2026-11-08',origen:'maestro'
  }));
  const listado=lecturas.slice(0,7).map(({codigo},i)=>({
    codigo:codigo.replace(/^T/,'TD'),origen:'nueva',...(i===0?{}:{solicitud:'vigente'})
  }));
  listado.push({codigo:lecturas[7].codigo,origen:'nueva',solicitud:'anterior'});
  listado.push({codigo:lecturas[8].codigo,origen:'solicitada'});
  const repository={
    async conditioning(){return {nuevas:30,solicitadas:1,preparadas:9,listado};},
    async reception(){return {id:'vigente',cantidad:100,lecturas};}
  };
  const controller=attachConditioningWorkspace({repository});
  try{
    const el=id=>document.getElementById(id);
    const settle=()=>new Promise(resolve=>setImmediate(resolve));
    controller.activate();
    await settle();
    assert.equal(el('acondNew').textContent,'100');
    assert.equal(el('acondReceptionCount').textContent,'30 de 100 registradas · 70 por registrar');
    assert.equal(el('acondPrepared').textContent,'7 de 100');
    assert.equal(el('acondPercent').textContent,'7%');

    const codigo='T9400000080';
    lecturas.push({codigo,guardado:null,origen:'escaneo'});
    listado.push({codigo,origen:'nueva',solicitud:'vigente'});
    controller.activate();
    await settle();
    assert.equal(el('acondReceptionCount').textContent,'31 de 100 registradas · 69 por registrar');
    assert.equal(el('acondPrepared').textContent,'7 de 100');
    lecturas.at(-1).guardado='2026-11-08';
    controller.activate();
    await settle();
    assert.equal(el('acondPrepared').textContent,'8 de 100');
  }finally{
    controller.reset();
    dom.window.close();
    delete globalThis.document;
  }
});

test('modo celular corta lecturas repetidas, valida las filas y confirma solo después del guardado',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html);
  globalThis.document=dom.window.document;
  let captures,signal,lookups=0,saves=0,releaseSave;
  const code='TD0900000019';
  const repository={
    async conditioning(action,data){
      if(action==='listar')return {nuevas:1,solicitadas:0,preparadas:0,listado:[]};
      if(action==='buscar'){
        lookups++;
        assert.equal(data.p_codigo,'P0900000019');
        return {codigo:code,origen:'nueva',status:'disponible'};
      }
      if(action==='cargo'){
        const cargo=data.p_cargos[0];
        return cargo==='946'?{status:'inexistente'}:{status:'disponible',codigo:cargo};
      }
      assert.equal(action,'preparar');
      assert.equal(data.p_codigo,code);
      assert.equal(data.p_anio,2025);
      assert.deepEqual(data.p_cargos,['945','947']);
      saves++;
      return new Promise(resolve=>{releaseSave=resolve;});
    },
    async reception(){return null;},
    async conditioningExcel(){return {verified:true,count:1};}
  };
  const controller=attachConditioningWorkspace({repository,scanCamera:async(_video,abort,onCode)=>{
    signal=abort;
    captures=onCode;
  }});
  try{
    const el=id=>document.getElementById(id);
    const settle=()=>new Promise(resolve=>setImmediate(resolve));
    controller.activate();
    el('acondMobile').click();
    assert.equal(el('acondKpis').hidden,false);
    el('acondOpenCamera').click();
    assert.equal(el('acondCamera').hidden,false);
    captures('P0900000019');
    captures('P0900000019');
    await settle();
    assert.equal(signal.aborted,true);
    assert.equal(lookups,1);
    assert.match(el('acondReadCode').textContent,/P0900000019.*TD0900000019/);
    el('acondContinue').click();
    el('acondYears').querySelector('[value="2025"]').click();
    el('acondCargo1').value='945';
    el('acondCargo2').value='946';
    el('acondNext').click();
    await settle();
    assert.equal(el('acondSave').hidden,true);
    assert.match(el('acondCargo2').parentElement.textContent,/No existe/);
    el('acondCargo2').value='0945';
    el('acondNext').click();
    await settle();
    assert.equal(el('acondSave').hidden,true);
    assert.match(el('acondCargo2').parentElement.textContent,/Cargo duplicado/);
    el('acondCargo2').value='947';
    el('acondNext').click();
    await settle();
    assert.equal(el('acondSave').hidden,false);
    assert.equal(saves,0);
    el('acondSave').click();
    el('acondSave').click();
    assert.equal(saves,1);
    assert.equal(el('acondDone').hidden,true);
    releaseSave({codigo:code,origen:'nueva',cargos:['945','947'],anios:[2025]});
    await settle();
    assert.equal(el('acondDone').hidden,false);
    assert.equal(el('acondDoneCount').textContent,'2');
    assert.equal(el('acondScan').value,'');
    assert.equal(el('acondCargo1').value,'');
    assert.equal(el('acondCargo2').value,'');
    el('acondAnother').click();
    assert.equal(el('acondOpenCamera').hidden,false);
    assert.equal(el('acondCargo1').value,'');
    el('acondLaptop').click();
    assert.equal(el('acondLaptop').getAttribute('aria-pressed'),'true');
    assert.equal(el('acondPreparation').hidden,false);
  }finally{
    controller.reset();
    dom.window.close();
    delete globalThis.document;
  }
});
