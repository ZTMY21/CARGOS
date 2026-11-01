import test from 'node:test';
import assert from 'node:assert/strict';
import {composePickupMail} from '../src/pickup-mail-template.js';
import {createPickupMailHandler} from '../api/pickup-mail.js';

const id='123e4567-e89b-12d3-a456-426614174000';
const detail={
 id,status:'PENDIENTE',created_at:'2026-11-01T15:00:00Z',
 sender:'trabajo@example.com',to:['jorge@example.com'],cc:['copia@example.com'],
 subject:'Solicitud de recojo de 30 cajas nuevas | CD Santa Anita',
 signature:{name:'Persona de prueba',position:'Operaciones',area:'Archivo',
  company:'Empresa de prueba',contact:'Central 123'},
 boxes:Array.from({length:30},(_,i)=>({
  code:'TD'+String(2030000000+i),
  cargos:[String(933+i),String(1033+i)],
  classification:'Cajas Nuevas',finished_at:'2026-11-01T15:00:00Z'
 }))
};
test('genera EML multipart/alternative UTF-8 y HTML para 30 cajas con firma configurable',()=>{
 const built=composePickupMail(detail);
 assert.match(built.eml,/Content-Type: multipart\/alternative/);
 assert.match(built.eml,/From: trabajo@example.com/);
 assert.match(built.eml,/To: jorge@example.com/);
 assert.match(built.eml,/Cc: copia@example.com/);
 assert.match(built.eml,/X-Kardex-Batch: 123e4567/);
 assert.match(built.text,/30 cajas nuevas/);
 assert.match(built.text,/TD2030000029/);
 assert.match(built.text,/Persona de prueba/);
 assert.match(built.html,/max-width:640px/);
 assert.match(built.html,/Empresa de prueba/);
 assert.match(built.html,/Cargos/);
 assert.equal((built.text.match(/Cargos: /g)||[]).length,30);
 assert.match(built.filename,/\.eml$/);
 assert.ok(!built.eml.includes('microsoft.com'));
});
test('no genera correo si faltan destinatarios, firma o una caja',()=>{
 assert.throws(()=>composePickupMail({...detail,to:[]}),/remitente/);
 assert.throws(()=>composePickupMail({...detail,signature:{}}),/firma/);
 assert.throws(()=>composePickupMail({...detail,boxes:detail.boxes.slice(0,29)}),/30 cajas/);
 assert.throws(()=>composePickupMail({...detail,to:['victim@example.com\r\nBcc: malicious@example.com']}),
   /destinatarios/);
});
test('escapa contenido del usuario en HTML y mantiene el MIME',()=>{
 const data={...detail,signature:{...detail.signature,name:'Prueba <img src=x onerror=alert(1)>'}};
 const generated=composePickupMail(data);
 assert.ok(!generated.html.includes('<img'));
 assert.match(generated.html,/&lt;img/);
 assert.match(generated.eml,/Content-Transfer-Encoding: base64/);
});
function server(preview=false,guest=false){
 const calls=[];
 const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'key',VERCEL_ENV:preview?'preview':'production'};
 const fetcher=async(url,options={})=>{
  calls.push({url:String(url),method:options.method});
  if(String(url).includes('/auth/v1/user'))return Response.json({id:'test-admin'});
  if(String(url).includes('/rpc/kardex_access'))return Response.json({allowed:!guest,is_admin:!guest});
  if(String(url).includes('/rpc/kardex_pickup_mail_detail'))return Response.json(detail);
  if(String(url).includes('/rpc/kardex_pickup_mail_mark'))return Response.json({status:'PREPARADO'});
  throw new Error('Unexpected API');
 };
 const invoke=async(action,idParam=id)=>{
  const req={method:'POST',headers:{authorization:'Bearer test-token',host:'app.example.com'},body:{action,id:idParam}};
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;}};
  await createPickupMailHandler({env,fetcher})(req,res);
  return res;
 };
 return {invoke,calls};
}
test('vista previa usa datos persistidos sin enviar ni confirmar correo',async()=>{
 const t=server();
 const res=await t.invoke('preview');
 assert.equal(res.statusCode,200);
 const response=JSON.parse(res.body);
 assert.equal(response.boxes,30);
 assert.match(response.html,/Persona de prueba/);
 assert.equal(t.calls.filter(x=>x.url.includes('pickup_mail_mark')).length,0);
 assert.equal(t.calls.filter(x=>/outlook|graph\.microsoft|smtp/.test(x.url)).length,0);
});
test('descarga EML marca solo PREPARADO, nunca CONFIRMADO ni envía por Outlook',async()=>{
 const t=server();
 const res=await t.invoke('download');
 assert.equal(res.statusCode,200);
 assert.match(res.headers['Content-Type'],/message\/rfc822/);
 assert.match(res.headers['Content-Disposition'],/\.eml/);
 assert.match(res.body,/Content-Type: multipart\/alternative/);
 assert.equal(t.calls.filter(x=>x.url.includes('pickup_mail_mark')).length,1);
 assert.equal(t.calls.filter(x=>/outlook|graph\.microsoft|smtp/.test(x.url)).length,0);
});
test('bloquea descarga desde Preview y a usuarios sin privilegios',async()=>{
 const t=server(true);const a=await t.invoke('download');assert.equal(a.statusCode,403);
 assert.equal(t.calls.filter(x=>x.url.includes('pickup_mail_mark')).length,0);
 const g=server(false,true);const b=await g.invoke('download');assert.equal(b.statusCode,403);
});
