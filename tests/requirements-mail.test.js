import test from 'node:test';
import assert from 'node:assert/strict';
import {composeRequirementsMail} from '../src/requirements-mail-template.js';
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
  assert.match(mail.subject,/100 cajas nuevas/);
  assert.deepEqual(mail.to,config.to);
  assert.deepEqual(mail.cc,config.cc);
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
  assert.match(mail.subject,/2 cajas en préstamo/);
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
test('Rechaza destinatarios sin configurar y cantidades fuera de la regla de 100',()=>{
  assert.throws(()=>composeRequirementsMail(newBoxes,[],{}),/destinatarios/i);
  assert.throws(()=>composeRequirementsMail({...newBoxes,cantidadCajas:101},[],config),/entre 1 y 100/i);
  assert.throws(()=>composeRequirementsMail({...newBoxes,tipo:REQ_TYPES[1]},[],config),/No hay cajas registradas/i);
});
test('Rechaza requerimientos de otro tipo',()=>{
  assert.throws(()=>composeRequirementsMail({...newBoxes,tipo:'Otros'},[],config),/requerimiento válido/i);
});
