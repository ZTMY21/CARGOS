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
function setup({historical=[],preview=false}={}){
 const env={SUPABASE_URL:'https://uhjwhamzjxhjqlrhgxho.supabase.co',SUPABASE_ANON_KEY:'pub',
  KARDEX_DRIVE_ENABLED:'true',KARDEX_DRIVE_AUTHORIZATION_REF:'approved',VERCEL_ENV:preview?'preview':'production',
  KARDEX_DRIVE_RELEASE_APPROVED:'true',SUPABASE_SERVICE_ROLE_KEY:'secret',GOOGLE_DRIVE_REFRESH_TOKEN:'refresh',
  GOOGLE_DRIVE_CLIENT_ID:'id',GOOGLE_DRIVE_CLIENT_SECRET:'secret',GOOGLE_DRIVE_ROOT_FOLDER_ID:'root123456789',
  GOOGLE_DRIVE_OWNER_EMAIL:'jaguliquidacion@gmail.com',KARDEX_DRIVE_SESSION_KEY:Buffer.alloc(32,1).toString('base64'),
  GOOGLE_DRIVE_FOLDER_IDS_JSON:JSON.stringify(Object.fromEntries(['scans','originals','backups','history','manifests'].map((x,i)=>[x,'folder_'+i+'_abcdefghi'])))};
 let writes=0,rows=[SCAN_HEADERS,row('AB111','940','1')],audit=[],hasAudit=false;
 const fetcher=async(url,opts={})=>{
  if(url.includes('/auth/v1/user'))return Response.json({id:'admin-user'});
  if(url.includes('/rpc/kardex_access'))return Response.json({allowed:true,is_admin:true});
  if(url.includes('/rest/v1/documentos?'))return Response.json(historical);
  if(url.includes('oauth2.googleapis.com/token'))return Response.json({access_token:'token',expires_in:3600});
  if(url.includes('/drive/v3/files/'))return Response.json({id:'18TbKWiVUWKfkJOXvR0kGEMb5eVKTDCfoXAUtD5rCxts',mimeType:'application/vnd.google-apps.spreadsheet',capabilities:{canEdit:true}});
  if(url.includes('sheets.googleapis.com')&&url.endsWith(':batchUpdate')&&opts.method==='POST'){
    writes++;const input=JSON.parse(opts.body);
    for(const request of input.requests){
      if(request.addSheet){hasAudit=true;continue;}
      if(request.appendCells){
        const target=request.appendCells.sheetId===17?rows:audit;
        for(const item of request.appendCells.rows)
          target.push(item.values.map(v=>v.userEnteredValue?.stringValue||''));
      }
      if(request.updateCells){
        const cell=request.updateCells,range=cell.range;
        rows[range.startRowIndex][range.startColumnIndex]=cell.rows[0].values[0].userEnteredValue.stringValue;
      }
    }
    return Response.json({replies:input.requests.map(()=>({}))});
  }
  if(url.includes('sheets.googleapis.com')&&url.includes('?fields=sheets(')){
    return Response.json({sheets:[{properties:{sheetId:17,title:'CARGOS NUEVOS'}},
      ...(hasAudit?[{properties:{sheetId:2401102,title:'AUDITORIA CARGA'}}]:[])]});
  }
  if(url.includes('sheets.googleapis.com')&&url.includes('A1%3AK1'))return Response.json({values:[SCAN_HEADERS]});
  if(url.includes('sheets.googleapis.com')&&url.includes('A2%3AK50000'))
    return Response.json({values:rows.slice(1).map(r=>[...r])});
  throw new Error('Unexpected: '+url);
 };
 const invoke=async(method,body)=>{
  const req={method,headers:{authorization:'Bearer valid.user.token',host:'example.vercel.app'},query:{},body};
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(text){this.text=text;}};
  await createScanHandler({env,fetcher})(req,res);return {status:res.statusCode,value:JSON.parse(res.text)};
 };
 return {invoke,getWrites:()=>writes,getRows:()=>rows,getAudit:()=>audit};
}
test('servidor distingue idénticos, agrega solo nuevos y no duplica al repetir',async()=>{
 const t=setup();
 const preview=await t.invoke('POST',{action:'preview',rows:[row('AB111','940','1'),row('AB112','941','1')]});
 assert.equal(preview.status,200);
 assert.equal(preview.value.accepted,1);
 assert.equal(preview.value.duplicates.length,1);
 assert.equal(t.getWrites(),0);
 const save=await t.invoke('POST',{action:'commit',rows:[row('AB111','940','1'),row('AB112','941','1')]});
 assert.equal(save.status,200);assert.equal(save.value.saved,1);assert.equal(save.value.googleVerified,true);
 assert.equal(t.getWrites(),1);
 const again=await t.invoke('POST',{action:'commit',rows:[row('AB112','941','1')]});
 assert.equal(again.status,200);assert.equal(again.value.saved,0);assert.equal(t.getWrites(),1);
 const bad=await t.invoke('POST',{action:'commit',rows:[['30/10/2026','932','1','AB113']]});
 assert.equal(bad.status,422);assert.equal(t.getWrites(),1);
});
test('completa solo PDF vacío, guarda auditoría, y no reescribe al repetir la carga',async()=>{
 const t=setup();t.getRows()[1][5]='';
 const incoming=row('AB111','940','1');
 const check=await t.invoke('POST',{action:'preview',rows:[incoming]});
 assert.equal(check.status,200);assert.equal(check.value.updates,1);assert.equal(check.value.updateCells,1);
 const saved=await t.invoke('POST',{action:'commit',rows:[incoming]});
 assert.equal(saved.status,200);assert.equal(saved.value.saved,0);assert.equal(saved.value.updated,1);
 assert.equal(t.getRows().length,2);assert.equal(t.getRows()[1][5],incoming[5]);
 assert.equal(t.getAudit().filter(r=>r[2]==='COMPLETAR').length,1);
 const second=await t.invoke('POST',{action:'commit',rows:[incoming]});
 assert.equal(second.value.updated,0);assert.equal(t.getWrites(),1);
});
test('un conflicto jamás sobrescribe información existente ni escribe un registro',async()=>{
 const t=setup(),incoming=row('AB111','940','1');
 incoming[5]='otro_archivo.pdf';
 const check=await t.invoke('POST',{action:'preview',rows:[incoming]});
 assert.equal(check.status,200);assert.equal(check.value.conflicts.length,1);
 const save=await t.invoke('POST',{action:'commit',rows:[incoming]});
 assert.equal(save.status,409);assert.equal(t.getRows()[1][5],row('AB111','940','1')[5]);
 assert.equal(t.getWrites(),0);
});
test('la limpieza de Google Sheets no permite reincorporar un código del histórico',async()=>{
 const t=setup({historical:[{cargos:['955'],facturas:'AA999, BB999'}]});
 const attempt=row('AA999','955','1','Imagen2.jpg','Documento.pdf');
 const result=await t.invoke('POST',{action:'preview',rows:[attempt]});
 assert.equal(result.status,200);assert.equal(result.value.accepted,0);assert.equal(result.value.conflicts.length,1);
 const save=await t.invoke('POST',{action:'commit',rows:[attempt]});
 assert.equal(save.status,409);assert.equal(t.getWrites(),0);
});
test('vista preview no habilita la conexión productiva ni permite escritura',async()=>{
 const t=setup({preview:true});
 const candidate=row('NEW999','955','1');
 const result=await t.invoke('POST',{action:'preview',rows:[candidate]});
 assert.equal(result.status,503); // Falta autorización explícita de copia aislada.
 const save=await t.invoke('POST',{action:'commit',rows:[candidate]});
 assert.equal(save.status,503);
 assert.equal(t.getWrites(),0);
});
test('sube 3.000 facturas en ocho lotes y al repetir no agrega otras filas',async()=>{
 const t=setup(),total=3000,batch=400;
 const rows=Array.from({length:total},(_,i)=>row('01-0FF01-'+String(i+1).padStart(7,'0'),String(941+Math.floor(i/500)),String(i%14+1)));
 const preview=await t.invoke('POST',{action:'preview',rows});
 assert.equal(preview.status,200);assert.equal(preview.value.accepted,total);
 let written=0;
 for(let i=0;i<rows.length;i+=batch){
  const r=await t.invoke('POST',{action:'commit',rows:rows.slice(i,i+batch)});
  assert.equal(r.status,200);assert.equal(r.value.googleVerified,true);
  written+=r.value.saved;
 }
 assert.equal(written,total);assert.equal(t.getWrites(),Math.ceil(total/batch));
 for(let i=0;i<rows.length;i+=batch){
  const r=await t.invoke('POST',{action:'commit',rows:rows.slice(i,i+batch)});
  assert.equal(r.status,200);assert.equal(r.value.saved,0);
 }
 assert.equal(t.getWrites(),Math.ceil(total/batch));
});
test('diferentes archivos JPG del mismo código son documentos legítimos independientes',()=>{
 const ready=validateScanRows([row('AB100','941','1'),row('AB100','941','1')]).ready;
 ready[1].values[4]='otro.jpg';ready[1].values[5]='otro.pdf';
 const r=compareScanRows(ready,[]);
 assert.equal(r.newRows.length,2);assert.equal(r.duplicates.length,0);assert.equal(r.conflicts.length,0);
});
