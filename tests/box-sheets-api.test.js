import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoxSheetsHandler} from '../api/box-sheets.js';
import {BOX_CONTROL_TAB,BOX_SOURCE_TAB,BOX_HEADERS,BOX_SHEET_ID} from '../src/box-sheet-sync.js';

const IM_HEADER=['N°','FECHA DE PREPARACION\nDE CAJAS','RESPONSABLE',
 'CODIGO DE BARRAS\nDE CAJAS','NUMERO DE\nCARGOS','CLASIFICACIÓN DE\nCAJA',
 'FECHA DE ENVIO A\nIRON MOUNTAIN','RESPONSABLE EN ENTREGAR','RESPONSABLE EN RECIBIR','PLACA'];
const env={
 SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'pub',
 KARDEX_DRIVE_ENABLED:'true',KARDEX_DRIVE_AUTHORIZATION_REF:'approved',
 KARDEX_DRIVE_RELEASE_APPROVED:'true',VERCEL_ENV:'production',
 SUPABASE_SERVICE_ROLE_KEY:'secret',GOOGLE_DRIVE_REFRESH_TOKEN:'refresh',
 GOOGLE_DRIVE_CLIENT_ID:'id',GOOGLE_DRIVE_CLIENT_SECRET:'secret',
 GOOGLE_DRIVE_ROOT_FOLDER_ID:'folder_root_123456789',GOOGLE_DRIVE_OWNER_EMAIL:'jaguliquidacion@gmail.com',
 KARDEX_DRIVE_SESSION_KEY:Buffer.alloc(32,1).toString('base64'),
 GOOGLE_DRIVE_FOLDER_IDS_JSON:JSON.stringify(
 Object.fromEntries(['scans','originals','backups','history','manifests'].map((x,i)=>[x,'folder_'+i+'_abcdefghi'])))
};
function mock(preview=false,blocked=false){
 const config={...env,VERCEL_ENV:preview?'preview':'production'};
 const tabs={
  [BOX_CONTROL_TAB]:[BOX_HEADERS],
  [BOX_SOURCE_TAB]:[IM_HEADER]
 };
 let appends=0,updates=0,logs=[],condition=null;
 const fetcher=async(uri,options={})=>{
  const url=String(uri),method=options.method||'GET';
  logs.push([method,url]);
  if(url.includes('/auth/v1/user'))return Response.json({id:'admin-user',email:'admin@example.com'});
  if(url.includes('/rpc/kardex_access'))return Response.json({allowed:!blocked,is_admin:!blocked});
  if(url.includes('/rpc/kardex_box_conditioning_list'))return Response.json(condition?[condition]:[]);
  if(url.includes('oauth2.googleapis.com/token'))return Response.json({access_token:'fake',expires_in:3600});
  if(url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/'+BOX_SHEET_ID)){
   const decoded=decodeURIComponent(url);
   if(!decoded.includes('/values/')&&method==='GET')
    return Response.json({spreadsheetId:BOX_SHEET_ID,sheets:[
      {properties:{title:BOX_SOURCE_TAB}},{properties:{title:'INSTRUCCIONES'}},
      {properties:{title:BOX_CONTROL_TAB}}]});
   if(decoded.includes('/values/')){
    const dest=decoded.includes("'"+BOX_CONTROL_TAB+"'")?BOX_CONTROL_TAB:BOX_SOURCE_TAB;
    const source=tabs[dest];
    const match=decoded.match(/!'?([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?/);
    if(method==='GET'){
      const start=match?Number(match[2]):1;
      const finish=match&&match[4]?Number(match[4]):start;
      const startCol=match?match[1].charCodeAt(0)-65:0;
      const endCol=match&&match[3]?match[3].charCodeAt(0)-65:startCol;
      return Response.json({values:source.slice(start-1,finish).map(r=>(r||[]).slice(startCol,endCol+1))});
    }
    const values=JSON.parse(options.body).values;
    if(method==='PUT'){
      const m=decoded.match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)/);
      assert.ok(m,'PUT range must be bounded');
      const idx=Number(m[2])-1,col=m[1].charCodeAt(0)-65;
      while(source.length<=idx)source.push([]);
      for(let i=0;i<values[0].length;i++)source[idx][col+i]=values[0][i];
      updates++;
      return Response.json({updatedRows:1,updatedData:{values}});
    }
    if(method==='POST'&&decoded.includes(':append')){
      source.push(...values.map(r=>[...r]));appends++;
      return Response.json({updates:{updatedRows:values.length,updatedData:{values}}});
    }
   }
  }
  throw Error('Unexpected request '+method+' '+url);
 };
 const invoke=async(body,authorization=true)=>{
  const req={method:'POST',headers:{authorization:authorization?'Bearer valid.user.token':'',
   host:'app.example.com'},body};
  const res={setHeader(){},end(v){this.data=JSON.parse(v);}};
  await createBoxSheetsHandler({env:config,fetcher})(req,res);
  return {status:res.statusCode,...res.data};
 };
 return {tabs,invoke,setCondition:x=>condition=x,stats:()=>({appends,updates,logs})};
}
const cond={code:'00990011',original_code:'TD00990011',cargos:['933','934'],
 classification:'Cajas Nuevas',status:'EN_PREPARACION',observation:'',
 started_at:'2026-11-01T12:00:00Z',finished_at:null};
test('verifica conexión de Google Drive sin escribir ni depender de SharePoint',async()=>{
 const t=mock();
 const ok=await t.invoke({action:'check'});
 assert.equal(ok.status,200);assert.equal(ok.ready,true);
 assert.deepEqual(t.stats().logs.filter(x=>x[0]==='POST'&&x[1].includes('sheets.googleapis.com')),[]);
 assert.equal(t.tabs[BOX_SOURCE_TAB].length,1);
});
test('escaneo se guarda en CONTROL DE CAJAS sin duplicar por prefijos',async()=>{
 const t=mock();
 const first=await t.invoke({action:'scan',code:'TD00990011'});
 assert.equal(first.status,200);assert.equal(first.googleVerified,true);
 assert.equal(t.tabs[BOX_CONTROL_TAB].length,2);
 assert.equal(t.tabs[BOX_SOURCE_TAB].length,1);
 const again=await t.invoke({action:'scan',code:'T00990011'});
 assert.equal(again.status,200);assert.equal(t.tabs[BOX_CONTROL_TAB].length,2);
 assert.equal(t.tabs[BOX_CONTROL_TAB][1][1],'00990011');
 assert.equal(t.stats().appends,1);
});
test('acondicionamiento se refleja en Drive; solo listo entra a CARGOS ENVIADOS',async()=>{
 const t=mock();t.setCondition(cond);
 let a=await t.invoke({action:'sync',code:'00990011'});
 assert.equal(a.status,200);assert.equal(a.googleVerified,true);
 assert.equal(a.sourceSynced,false);
 assert.equal(t.tabs[BOX_CONTROL_TAB][1][2],'En preparación');
 assert.equal(t.tabs[BOX_SOURCE_TAB].length,1);
 t.setCondition({...cond,status:'LISTA',finished_at:'2026-11-01T12:15:00Z'});
 a=await t.invoke({action:'sync',code:'T00990011'});
 assert.equal(a.status,200);assert.equal(a.sourceSynced,true);
 assert.equal(t.tabs[BOX_CONTROL_TAB][1][2],'Lista para recojo');
 assert.equal(t.tabs[BOX_SOURCE_TAB].length,2);
 assert.equal(t.tabs[BOX_SOURCE_TAB][1][3],'TD00990011');
 assert.deepEqual(t.tabs[BOX_SOURCE_TAB][1].slice(6),[]);
 a=await t.invoke({action:'sync',code:'P00990011'});
 assert.equal(a.status,200);assert.equal(a.source,'existing');
 assert.equal(t.tabs[BOX_SOURCE_TAB].length,2);
});
test('conflicto en hoja original no modifica envíos ni sobrescribe cargos',async()=>{
 const t=mock();t.setCondition({...cond,status:'LISTA',finished_at:'2026-11-01T12:15:00Z'});
 t.tabs[BOX_SOURCE_TAB].push(['49','20/10/2026','old','T00990011','933-935','Cajas Nuevas','','','','']);
 const before=JSON.stringify(t.tabs[BOX_SOURCE_TAB]);
 const result=await t.invoke({action:'sync',code:'TD00990011'});
 assert.equal(result.status,409);assert.equal(result.error,'IM_SOURCE_CONFLICT');
 assert.equal(JSON.stringify(t.tabs[BOX_SOURCE_TAB]),before);
});
test('preview, visitantes y código inválido nunca escriben en Google Sheets',async()=>{
 for(const [instance,data] of [
  [mock(true),{action:'scan',code:'TD00990011'}],
  [mock(false,true),{action:'scan',code:'TD00990011'}],
  [mock(),{action:'scan',code:'DROP TABLE'}]
 ]){
  const result=await instance.invoke(data);
  assert.notEqual(result.status,200);
  assert.equal(instance.stats().appends,0);
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
