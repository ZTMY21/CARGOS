import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoxSheetsHandler} from '../api/box-sheets.js';

function response(){
  return {
    headers:{},
    setHeader(key,value){this.headers[key]=value;},
    end(value){this.body=JSON.parse(value);}
  };
}
test('la API antigua de CARGOS ENVIADOS rechaza cualquier escritura',async()=>{
  for(const action of ['scan','sync','check']){
    const res=response();
    await createBoxSheetsHandler()({
      method:'POST',
      body:{action,code:'T9000000001'},
      headers:{authorization:'Bearer test',host:'app.example.com'}
    },res);
    assert.equal(res.statusCode,410);
    assert.equal(res.body.error,'IM_LEGACY_GOOGLE_SHEETS_RETIRED');
    assert.equal(res.headers['Cache-Control'],'private, no-store');
  }
});


test('SIMULACIÓN INTERNA: 30 cajas, 6 reescaneos, 20 listas, 5 observadas, 5 en preparación, histórico intacto',async()=>{
 const t=mock();
 const historical=['1','10/10/2026','usuario anterior','T991000001','111-112','POR SOLICITUD',
   '11/10/2026','entregado','recibido','PLACA-DEMO'];
 t.tabs[BOX_SOURCE_TAB].push([...historical]);
 const boxCodes=[];
 for(let i=0;i<30;i++){
  const digits=String(310000001+i).padStart(10,'0');
  boxCodes.push(digits);
  const scan=await t.invoke({action:'scan',code:'TD'+digits});
  assert.equal(scan.status,200,'escaneo '+i);
  assert.equal(scan.googleVerified,true);
 }
 assert.equal(t.tabs[BOX_CONTROL_TAB].length,31,'solo una fila por cada una de las 30 cajas');
 assert.equal(t.tabs[BOX_SOURCE_TAB].length,2,'escanear no debe crear una caja enviada');
 for(let i=0;i<30;i+=5){
  const again=await t.invoke({action:'scan',code:'P'+boxCodes[i]});
  assert.equal(again.status,200);
  assert.equal(t.tabs[BOX_CONTROL_TAB].length,31,'el prefijo alternativo no crea duplicados');
 }
 for(let i=0;i<30;i++){
  const digits=boxCodes[i],ready=i<20,observed=i>=20&&i<25;
  t.setCondition({
   code:digits,original_code:'TD'+digits,
   cargos:[String(933+i),String(1033+i)],
   classification:i%2?'POR SOLICITUD':'Cajas Nuevas',
   status:ready?'LISTA':observed?'OBSERVADA':'EN_PREPARACION',
   observation:observed?'Etiqueta ilegible':'',
   started_at:'2026-11-01T12:00:00Z',
   finished_at:ready?'2026-11-01T12:15:00Z':null
  });
  const saved=await t.invoke({action:'sync',code:'T'+digits});
  assert.equal(saved.status,200,'acondicionamiento '+i+' '+JSON.stringify(saved));
  assert.equal(saved.googleVerified,true);
  assert.equal(saved.sourceSynced,ready);
 }
 assert.equal(t.tabs[BOX_CONTROL_TAB].length,31,'mantener 30 cajas únicas tras sincronizar');
 assert.equal(t.tabs[BOX_SOURCE_TAB].length,22,'solo las 20 cajas listas se agregan a enviados');
 assert.deepEqual(t.tabs[BOX_SOURCE_TAB][1],historical,'histórico y fechas de envío intocables');
 for(const row of t.tabs[BOX_SOURCE_TAB].slice(2)){
  assert.equal(row.length,6,'solo se escriben columnas A:F, jamás fecha de envío G');
  assert.match(row[3],/^TD0\d{9}$/);
  assert.ok(row[4].includes('-'));
 }
 const states=t.tabs[BOX_CONTROL_TAB].slice(1).reduce((acc,row)=>{
  acc[row[2]]=(acc[row[2]]||0)+1;return acc;
 },{});
 assert.deepEqual(states,{'Lista para recojo':20,'Observada':5,'En preparación':5});
 const appendsBefore=t.stats().appends;
 for(let i=0;i<20;i++){
  const digits=boxCodes[i];
  t.setCondition({
   code:digits,original_code:'TD'+digits,
   cargos:[String(933+i),String(1033+i)],
   classification:i%2?'POR SOLICITUD':'Cajas Nuevas',
   status:'LISTA',observation:'',
   started_at:'2026-11-01T12:00:00Z',
   finished_at:'2026-11-01T12:15:00Z'
  });
  const repeat=await t.invoke({action:'sync',code:'P'+digits});
  assert.equal(repeat.status,200,'repetición segura '+i);
  assert.equal(repeat.source,'existing');
 }
 assert.equal(t.tabs[BOX_SOURCE_TAB].length,22,'repetir sincronización no duplica cajas');
 assert.equal(t.stats().appends,appendsBefore,'no hay appends nuevos al repetir');
 assert.equal(t.stats().logs.filter(([method,url])=>/sharepoint/i.test(url)).length,0,
   'ninguna llamada a SharePoint');
});
