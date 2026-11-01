import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScanPaste,validateScanRows,compareScanRows,normalizeInvoice,normalizeDate,SCAN_HEADERS} from '../src/scan-rows.js';
import {createScanHandler} from '../api/scan-ingest.js';
const row=(code='01-0FF01-0217573',cargo='941',group='1')=>['30/10/2026',cargo,group,code,'Document_1.jpg','Documento.pdf','2','Fact / GR / BV','Escáner','',''];
test('lee pegado de Excel de 4 u 11 columnas sin cambiar los ceros iniciales',()=>{
 const paste='Fecha\tCargo\tGrupo\tCodigo\n30/10/2026\t941\t1\t01-0FF01-0217573\n';
 const data=parseScanPaste(paste),v=validateScanRows(data);assert.equal(data.length,1);assert.equal(v.errors.length,0);assert.equal(v.ready[0].values[3],'01-0FF01-0217573');assert.equal(v.ready[0].values[4],'');
 const full=validateScanRows([row()]);assert.equal(full.ready[0].values[4],'Document_1.jpg');assert.equal(full.ready[0].values.length,11);
 assert.equal(normalizeInvoice('01-0FF01-0217573'),'010FF010217573');
 assert.equal(normalizeDate('30/10/2026').iso,'2026-10-30');
});
test('rechaza fechas, cargos protegidos, fórmulas y códigos inválidos',()=>{
 const rows=[['30/10/2025','941','1','AB12'],['30/10/2026','932','1','AB12'],['31/02/2026','941','1','AB12'],['30/10/2026','941','1','=1+1'],['30/10/2026','941','1','A B']];
 const result=validateScanRows(rows);assert.equal(result.errors.length,5);assert.equal(result.ready.length,0);
});
test('omite duplicados exactos sin destruir coincidencias legítimas de otro cargo',()=>{
 const a=validateScanRows([row('01-0FF01-0217573','941','1'),row('010FF010217573','941','1'),row('01-0FF01-0217573','942','1')]).ready;
 const existing=[['30/10/2026','940','1','01-0FF01-0217573']];
 const result=compareScanRows(a,existing);assert.equal(result.newRows.length,2);assert.equal(result.duplicates.length,1);assert.equal(result.otherCargos.length,2);
});
function setup(){
 const env={SUPABASE_URL:'https://uhjwhamzjxhjqlrhgxho.supabase.co',SUPABASE_ANON_KEY:'pub',
  KARDEX_DRIVE_ENABLED:'true',KARDEX_DRIVE_AUTHORIZATION_REF:'approved',VERCEL_ENV:'production',
  KARDEX_DRIVE_RELEASE_APPROVED:'true',SUPABASE_SERVICE_ROLE_KEY:'secret',GOOGLE_DRIVE_REFRESH_TOKEN:'refresh',
  GOOGLE_DRIVE_CLIENT_ID:'id',GOOGLE_DRIVE_CLIENT_SECRET:'secret',GOOGLE_DRIVE_ROOT_FOLDER_ID:'root123456789',
  GOOGLE_DRIVE_OWNER_EMAIL:'jaguliquidacion@gmail.com',KARDEX_DRIVE_SESSION_KEY:Buffer.alloc(32,1).toString('base64'),
  GOOGLE_DRIVE_FOLDER_IDS_JSON:JSON.stringify(Object.fromEntries(['scans','originals','backups','history','manifests'].map((x,i)=>[x,'folder_'+i+'_abcdefghi'])))};
 let appends=0,rows=[SCAN_HEADERS, row('AB111','940','1').slice(0,4)];
 const fetcher=async(url,opts={})=>{
  if(url.includes('/auth/v1/user'))return Response.json({id:'admin-user'});
  if(url.includes('/rpc/kardex_access'))return Response.json({allowed:true,is_admin:true});
  if(url.includes('oauth2.googleapis.com/token'))return Response.json({access_token:'token',expires_in:3600});
  if(url.includes('/drive/v3/files/'))return Response.json({id:'18TbKWiVUWKfkJOXvR0kGEMb5eVKTDCfoXAUtD5rCxts',mimeType:'application/vnd.google-apps.spreadsheet',capabilities:{canEdit:true}});
  if(url.includes('sheets.googleapis.com')&&opts.method==='POST'){
    appends++;const payload=JSON.parse(opts.body);
    const first=rows.length+1;rows.push(...payload.values);
    return Response.json({updates:{updatedRows:payload.values.length,updatedRange:"'CARGOS NUEVOS'!A"+first+":K"+rows.length,updatedData:{values:payload.values}}});
  }
  if(url.includes('sheets.googleapis.com')){
    if(url.includes('A1%3AK1'))return Response.json({values:[SCAN_HEADERS]});
    if(url.includes('A2%3AD50000'))return Response.json({values:rows.slice(1).map(r=>r.slice(0,4))});
  }
  throw new Error('Unexpected: '+url);
 };
 const invoke=async(method,body)=>{
  const req={method,headers:{authorization:'Bearer valid.user.token',host:'example.vercel.app'},query:{},body};
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(text){this.text=text;}};
  await createScanHandler({env,fetcher})(req,res);return {status:res.statusCode,value:JSON.parse(res.text)};
 };
 return {invoke,getWrites:()=>appends};
}
test('servidor exige rol administrador, revisa la fuente, y valida antes de escribir',async()=>{
 const t=setup();
 const preview=await t.invoke('POST',{action:'preview',rows:[row('AB111','940','1'),row('AB112','941','1')]});
 assert.equal(preview.status,200);assert.equal(preview.value.accepted,1);assert.equal(preview.value.duplicates.length,1);assert.equal(t.getWrites(),0);
 const save=await t.invoke('POST',{action:'commit',rows:[row('AB111','940','1'),row('AB112','941','1')]});
 assert.equal(save.status,200);assert.equal(save.value.saved,1);assert.equal(save.value.googleVerified,true);assert.equal(t.getWrites(),1);
 const again=await t.invoke('POST',{action:'commit',rows:[row('AB112','941','1')]});
 assert.equal(again.status,200);assert.equal(again.value.saved,0);assert.equal(t.getWrites(),1);
 const bad=await t.invoke('POST',{action:'commit',rows:[['30/10/2026','932','1','AB113']]});
 assert.equal(bad.status,422);assert.equal(t.getWrites(),1);
});
