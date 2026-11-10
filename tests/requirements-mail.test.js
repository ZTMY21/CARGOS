import test from 'node:test';
import assert from 'node:assert/strict';
import {composeRequirementsMail,REQUEST_MAIL_TO,REQUEST_MAIL_CC} from '../src/requirements-mail-template.js';
import {REQ_TYPES} from '../src/rules.js';

const config={
  sender:'administracion@example.com',
  to:['operaciones@example.com','archivo@example.com'],
  cc:['supervision@example.com'],
  name:'Responsable de archivo',position:'Logística',
  area:'Gestión documental',company:'Farmacias Peruanas',contact:'CD Santa Anita'
};
const newBoxes={
  id:'requerimiento-1',numero:'REQ-2026-15',tipo:REQ_TYPES[0],
  fechaSolicitud:'2026-11-10',usuario:'Administrador',cantidadCajas:100
};
test('Correo de 100 cajas nuevas conserva destinatarios, copias y firma y NO adjunta Excel',()=>{
  const mail=composeRequirementsMail(newBoxes,[],config);
  assert.equal(mail.count,100);
  assert.equal(mail.subject,'Solicitud de 100 cajas nuevas a IM | CD Santa Anita |');
  assert.deepEqual(mail.to,[...REQUEST_MAIL_TO]);
  assert.deepEqual(mail.cc,[...REQUEST_MAIL_CC]);
  assert.equal(mail.from,config.sender);
  assert.match(mail.text,/Responsable de archivo/);
  assert.match(mail.text,/Agradeceremos confirmar la disponibilidad y la fecha programada de entrega/);
  assert.match(mail.eml,/X-Unsent: 1/);
  assert.doesNotMatch(mail.eml,/spreadsheet|\.xlsx|Content-Disposition: attachment/i);
});
test('El préstamo incluye las cajas y sus cargos en el texto, nunca en Excel',()=>{
  const row={...newBoxes,id:'prestamo-1',numero:'PRE-123',tipo:REQ_TYPES[1],cantidadCajas:''};
  const mail=composeRequirementsMail(row,[
    {codigo:'T0045',cargos:['401','402']},{codigo:'P010',cargos:['450']}
  ],config);
  assert.equal(mail.count,2);
  assert.equal(mail.subject,'Solicitud de 2 cajas en préstamo a IM | CD Santa Anita |');
  assert.match(mail.text,/Caja T0045 · Cargos: 401 - 402/);
  assert.match(mail.text,/Caja P010 · Cargos: 450/);
  assert.doesNotMatch(mail.eml,/attachment|xlsx/i);
});
test('Simular Outlook nunca incluye las direcciones reales y marca el asunto como prueba',()=>{
  const mail=composeRequirementsMail(newBoxes,[],config,{simulation:true});
  assert.deepEqual(mail.to,['destinatario@example.invalid']);
  assert.deepEqual(mail.cc,[]);
  assert.equal(mail.from,'remitente@example.invalid');
  assert.doesNotMatch(mail.eml,/operaciones@example.com|archivo@example.com|administracion@example.com/);
  assert.match(mail.eml,/X-Unsent: 1/);
  assert.match(mail.filename,/_PRUEBA\.eml$/);
});
test('Rechaza remitente no configurado en producción y cantidades fuera de 100',()=>{
  assert.throws(()=>composeRequirementsMail(newBoxes,[],{}),/remitente/i);
  assert.throws(()=>composeRequirementsMail({...newBoxes,cantidadCajas:101},[],config),/entre 1 y 100/i);
  assert.throws(()=>composeRequirementsMail({...newBoxes,tipo:REQ_TYPES[1]},[],config),/No hay cajas registradas/i);
});
test('Rechaza requerimientos de otro tipo',()=>{
  assert.throws(()=>composeRequirementsMail({...newBoxes,tipo:'Otros'},[],config),/requerimiento válido/i);
});

test('La preview muestra los destinatarios reales indicados incluso si no hay cuenta configurada',()=>{
  const mail=composeRequirementsMail(newBoxes,[],{},{preview:true});
  assert.deepEqual(mail.to,[
    'joramos@farmaciasperuanas.pe',
    'alopezv@farmaciasperuanas.pe',
    'bsalvador@farmaciasperuanas.pe'
  ]);
  assert.deepEqual(mail.cc,['fp-qs-liquidaciones@intercorpretail.pe']);
  assert.equal(mail.senderConfigured,false);
  assert.equal(mail.subject,'Solicitud de 100 cajas nuevas a IM | CD Santa Anita |');
  assert.equal(mail.from,'remitente@example.invalid');
});
test('La cantidad solicitada cambia automáticamente en el asunto',()=>{
  const mail=composeRequirementsMail({...newBoxes,cantidadCajas:32},[],config);
  assert.equal(mail.subject,'Solicitud de 32 cajas nuevas a IM | CD Santa Anita |');
  assert.match(mail.text,/solicitamos 32 cajas nuevas/);
  assert.doesNotMatch(mail.text,/Cantidad solicitada:/);
});

test('No muestra firma provisional, empresa aislada ni metadatos internos en la vista previa',()=>{
  const mail=composeRequirementsMail({
    ...newBoxes,numero:'REQ-00001',fechaSolicitud:'2026-10-15',usuario:'Juan Alexis'
  },[],{},{preview:true});
  const hidden=/Firma pendiente de confirmar|Requerimiento:|Fecha de solicitud:|Solicitante:|Cantidad solicitada:/;
  assert.doesNotMatch(mail.text,hidden);
  assert.doesNotMatch(mail.html,hidden);
  assert.doesNotMatch(mail.text,/Farmacias Peruanas/);
  assert.match(mail.text,/solicitamos 100 cajas nuevas/);
  assert.match(mail.text,/Agradeceremos confirmar la disponibilidad/);
});
test('El HTML y el texto de Outlook omiten todos los campos eliminados, incluso con firma configurada',()=>{
  const mail=composeRequirementsMail({
    ...newBoxes,numero:'REQ-00001',fechaSolicitud:'2026-10-15',usuario:'Juan Alexis'
  },[],config);
  for(const body of [mail.text,mail.html]){
    assert.doesNotMatch(body,/Requerimiento: REQ-00001|Fecha de solicitud: 2026-10-15|Solicitante: Juan Alexis|Cantidad solicitada: 100 cajas|Firma pendiente de confirmar/);
  }
  assert.match(mail.text,/Responsable de archivo/);
});

test('El HTML del correo empieza con el saludo, sin cabecera de empresa ni asunto repetido',()=>{
  const mail=composeRequirementsMail(newBoxes,[],{},{preview:true});
  assert.doesNotMatch(mail.html,/<h[1-6]\b|Gestión documental · CD Santa Anita|<[^>]+>Farmacias Peruanas<\/h2>/);
  assert.doesNotMatch(mail.html,/Solicitud de 100 cajas nuevas a IM \| CD Santa Anita \|/);
  assert.match(mail.html,/<p>Buenas tardes, estimados:<\/p>/);
  assert.equal(mail.subject,'Solicitud de 100 cajas nuevas a IM | CD Santa Anita |');
});
