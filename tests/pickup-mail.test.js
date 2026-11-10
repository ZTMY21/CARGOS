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
 assert.doesNotMatch(built.text,/TD2030000029/);
 assert.match(built.text,/Persona de prueba/);
 assert.match(built.html,/max-width:640px/);
 assert.match(built.html,/Empresa de prueba/);
 assert.match(built.eml,/Content-ID: <farmacias-peruanas-logo>/);
 assert.match(built.previewHtml,/data:image\/png;base64,/);
 assert.doesNotMatch(built.html,/Código de caja|Cargos/);
 assert.match(built.text,/Buenas tardes, estimado:/);
 assert.match(built.filename,/\.eml$/);
 assert.ok(!built.eml.includes('microsoft.com'));
});
test('no genera correo si faltan destinatarios, firma o cajas',()=>{
 assert.throws(()=>composePickupMail({...detail,to:[]}),/remitente/);
 assert.throws(()=>composePickupMail({...detail,signature:{}}),/firma/);
 assert.throws(()=>composePickupMail({...detail,boxes:[]}),/al menos una caja/);
 assert.throws(()=>composePickupMail({...detail,to:['victim@example.com\r\nBcc: malicious@example.com']}),
   /destinatarios/);
});
test('escapa contenido del usuario en HTML y mantiene el MIME',()=>{
 const data={...detail,signature:{...detail.signature,name:'Prueba <img src=x onerror=alert(1)>'}};
 const generated=composePickupMail(data);
 assert.ok(!generated.html.includes('<img src=x'));
 assert.match(generated.html,/&lt;img/);
 assert.match(generated.eml,/Content-Transfer-Encoding: base64/);
});
function server(preview=false,guest=false,storedDetail=detail){
 const calls=[];
 const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'key',VERCEL_ENV:preview?'preview':'production'};
 const fetcher=async(url,options={})=>{
  calls.push({url:String(url),method:options.method});
  if(String(url).includes('/auth/v1/user'))return Response.json({id:'test-admin'});
  if(String(url).includes('/rpc/kardex_access'))return Response.json({allowed:!guest,is_admin:!guest});
  if(String(url).includes('/rpc/kardex_pickup_mail_detail'))return Response.json(storedDetail);
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
test('un aviso oficial confirmado se puede revisar con los destinatarios guardados y sin firma personalizada',async()=>{
 const subject='IM-20261101 II INGRESO DE CAJAS A IRON MOUNTAIN';
 const t=server(false,false,{...detail,workflow:true,status:'CONFIRMADO',signature:{},subject});
 const res=await t.invoke('preview');
 assert.equal(res.statusCode,200);
 const mail=JSON.parse(res.body);
 assert.equal(mail.subject,subject);
 assert.equal(mail.from,detail.sender);
 assert.deepEqual(mail.to,detail.to);
 assert.deepEqual(mail.cc,detail.cc);
 assert.match(mail.text,/30 cajas para almacenamiento/);
 assert.equal(mail.boxDetails.length,30);
 assert.equal(mail.attachments.length,1);
 assert.ok(t.calls.every(call=>!call.url.includes('pickup_mail_mark')));
});
test('simula un correo mixto sin datos de un aviso guardado ni escrituras',async()=>{
 const t=server();
 const res=await t.invoke('sample');
 assert.equal(res.statusCode,200);
 const mail=JSON.parse(res.body);
 assert.match(mail.subject,/^IM-\d{8} II INGRESO DE CAJAS A IRON MOUNTAIN$/);
 assert.match(mail.text,/almacenamiento/);
 assert.match(mail.text,/rearchivamiento/);
 assert.deepEqual(new Set(mail.boxDetails.map(box=>box.type)),new Set(['NUEVAS','DEVOLUCION']));
 assert.equal(mail.attachments.length,2);
 assert.deepEqual(mail.to,['destinatario@example.invalid']);
 assert.match(mail.eml,/^To: destinatario@example\.invalid$/m);
 assert.ok(t.calls.every(call=>/\/auth\/v1\/user|\/rpc\/kardex_access/.test(call.url)));
});
test('vista previa usa datos persistidos sin enviar ni confirmar correo',async()=>{
 const t=server();
 const res=await t.invoke('preview');
 assert.equal(res.statusCode,200);
 const response=JSON.parse(res.body);
 assert.equal(response.boxes,30);
 assert.deepEqual(response.boxDetails,detail.boxes.map(box=>({code:box.code,type:'NUEVAS'})));
 assert.match(response.text,/30 cajas nuevas/);
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
 assert.match(res.body,/Content-Type: multipart\/mixed/);
 assert.match(res.body,/filename="Formato IM-DYT \(NUEVAS\).*\.xlsx"/);
 assert.equal(t.calls.filter(x=>x.url.includes('pickup_mail_mark')).length,1);
 assert.equal(t.calls.filter(x=>/outlook|graph\.microsoft|smtp/.test(x.url)).length,0);
});
test('bloquea descarga desde Preview y a usuarios sin privilegios',async()=>{
 const t=server(true);const a=await t.invoke('download');assert.equal(a.statusCode,403);
 assert.equal(t.calls.filter(x=>x.url.includes('pickup_mail_mark')).length,0);
 const g=server(false,true);const b=await g.invoke('download');assert.equal(b.statusCode,403);
});


test('logo PNG incrustado por Content-ID y mensaje editable en Outlook',()=>{
 // PNG mínimo sintético; el logotipo real se carga por la configuración del administrador.
 const logo='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
 const customized={...detail,signature:{
  ...detail.signature,
  logo_png_base64:logo,
  greeting:'Buenas tardes,',
  introduction:'Se informa que {{cantidad}} cajas están listas en {{sede}}.',
  request:'Solicitar recojo para el {{fecha}}.',
  closing:'Atentos a su confirmación.',
  sede:'CD Santa Anita'
 }};
 const built=composePickupMail(customized);
 assert.match(built.text,/30 cajas están listas en CD Santa Anita/);
 assert.match(built.text,/Buenas tardes,/);
 assert.match(built.text,/Atentos a su confirmación/);
 assert.match(built.eml,/Content-Type: multipart\/related/);
 assert.match(built.eml,/Content-ID: <farmacias-peruanas-logo>/);
 assert.match(built.eml,/Content-Type: image\/png/);
 assert.match(built.html,/src="cid:farmacias-peruanas-logo"/);
 assert.match(built.previewHtml,/data:image\/png;base64,/);
 assert.ok(!built.previewHtml.includes('cid:farmacias-peruanas-logo'));
});
test('rechaza logotipos mayores del límite y código HTML no confiable',()=>{
 const tooBig='iVBORw0KGgo'+ 'A'.repeat(170001);
 assert.throws(()=>composePickupMail({...detail,signature:{...detail.signature,logo_png_base64:tooBig}}),
  /logotipo PNG/);
 const crafted=composePickupMail({...detail,signature:{
  ...detail.signature,
  introduction:'<img src=x onerror=alert(1)> {{cantidad}} cajas',
  greeting:'Hola <script>alert(1)</script>'
 }});
 assert.ok(!crafted.html.includes('<script>'));
 assert.match(crafted.html,/&lt;script&gt;/);
 assert.match(crafted.html,/&lt;img/);
});
