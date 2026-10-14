import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import {buildWorkbook,parseWorkbook} from '../src/excel.js';
import {REQ_TYPES,computeReqEstado,computeDocEstado,escapeHtml,limaDate} from '../src/rules.js';

const req={id:'44444444-4444-4444-8444-444444444444',numero:'REQ-00008',tipo:REQ_TYPES[0],fechaSolicitud:'2026-09-01',cantidadCajas:2,numerosCargo:'',fechaRecepcion:'2026-09-02',fechaDevolucion:'',usuario:'Juan'};
const now=new Date('2026-10-14T00:30:00Z');
const documentBase={id:'55555555-5555-4555-8555-555555555555',kardex:'SA-00012',fechaRegistro:'2026-10-01',tipoDoc:'Facturas-Guia',periodo:'2026-01-01',ubicacion:'Santa Anita',folios:80,cargos:['00123','A-987'],cajaAsignada:req.id,fEnvio:'',sustento:'',sustentoImagen:'',usuario:'Juan',facturas:'F001-0001, F001-0002',obs:'Observación con ñ y <texto>'};

test('all requirement types, reception, return and zero-capacity boundaries keep the required rules',()=>{
  assert.equal(computeReqEstado({...req,fechaRecepcion:''}),'Solicitado');
  assert.equal(computeReqEstado(req),'Recibido');
  assert.equal(computeReqEstado(req,[documentBase,documentBase]),'Completado');
  assert.equal(computeReqEstado({...req,cantidadCajas:0}),'Completado');
  const loan={...req,tipo:REQ_TYPES[1]};
  assert.equal(computeReqEstado({...loan,fechaRecepcion:''}),'Solicitado');
  assert.equal(computeReqEstado(loan),'Prestado');
  assert.equal(computeReqEstado({...loan,fechaDevolucion:'2026-10-01'}),'Devuelto');
  REQ_TYPES.slice(2).forEach(tipo=>{
    assert.equal(computeReqEstado({...req,tipo,fechaRecepcion:''}),'Solicitado');
    assert.equal(computeReqEstado({...req,tipo}),'Completado');
  });
});
test('document status precedence and five/six/seven-month boundary use Lima date',()=>{
  assert.equal(limaDate(now),'2026-10-13');
  assert.equal(computeDocEstado({...documentBase,cajaAsignada:''},now).estado,'Pendiente de Envío');
  assert.equal(computeDocEstado(documentBase,now).estado,'En Proceso de Acondicionamiento');
  assert.equal(computeDocEstado({...documentBase,fEnvio:'2026-10-13'},now).estado,'En Proceso de Acondicionamiento');
  for(const proof of [{sustento:'Guía'},{sustentoImagen:'data:image/jpeg;base64,YWJj'}]) {
    assert.deepEqual(computeDocEstado({...documentBase,fEnvio:'2026-10-13',...proof},now),{estado:'Enviado a Iron Mountain',antiguedad:'-'});
  }
  for(const [periodo,months] of [['2026-05-13',5],['2026-04-13',6],['2026-03-13',7],['2026-04-14',5]])
    assert.equal(computeDocEstado({...documentBase,periodo},now).antiguedad,months);
});
test('CSS, Base64 logo and the four groups are identical to the supplied baseline',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const hash=s=>createHash('sha256').update(s).digest('hex');
  assert.equal(hash(html.match(/<style>([\s\S]*?)<\/style>/)[1]),'178aa536195e5684f40469632e61b74c0993b5dcbf51008ee66ce6155f5726df');
  assert.equal(hash(html.match(/<img[^>]+src="(data:[^"]+)"/)[1]),'3d9a0f7a2ea7f7b877732a10deb358760d12fe05293aa5159184b5b23617dbfc');
  assert.equal((html.match(/<details class="group"/g)||[]).length,4);
  assert.ok(!html.includes('storageWarning')); assert.ok(!html.includes('artefacto compartido'));
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});
test('Excel round trip keeps four sheets, formulas, cargo arrays, links, invoices and long images',async()=>{
  const image='data:image/jpeg;base64,'+'Y'.repeat(72000);
  const doc={...documentBase,sustentoImagen:image,fEnvio:'2026-10-13'};
  const wb=buildWorkbook([req],[doc],[doc],now);
  const buffer=await wb.xlsx.writeBuffer();
  const saved=new ExcelJS.Workbook(); await saved.xlsx.load(buffer);
  assert.deepEqual(saved.worksheets.map(s=>s.name),['Resumen','Cargos','Detalle por Cargo','Requerimientos']);
  assert.equal(saved.getWorksheet('Cargos').getCell('L1').value,'Estado');
  assert.equal(saved.getWorksheet('Cargos').getCell('M1').value,'Antigüedad (Meses)');
  assert.ok(saved.getWorksheet('Cargos').getColumn(18).hidden);
  const summary=saved.getWorksheet('Resumen');
  assert.equal(summary.getCell('B7').value.result,'2 (80 folios)');
  assert.equal(summary.getCell('C8').value.result,1);
  assert.ok(summary.getCell('C7').value.formula.includes('Cargos!L2:L'));
  assert.ok(summary.getCell('B13').value.formula.includes('Cargos!M2:M'));
  const formulas=[]; summary.eachRow(row=>row.eachCell(cell=>{if(cell.value?.formula)formulas.push(cell.value.formula);}));
  for(const name of ['COUNTIF','COUNTIFS','SUMIF','SUMPRODUCT']) assert.ok(formulas.some(f=>f.includes(name)));
  const imported=parseWorkbook(buffer);
  assert.deepEqual(imported.docs[0].cargos,doc.cargos);
  assert.equal(imported.docs[0].sustentoImagen,image);
  assert.equal(imported.docs[0].facturas,doc.facturas);
  assert.equal(imported.docs[0].obs,doc.obs);
  assert.equal(imported.docs[0].cajaAsignada,imported.reqs[0].id);
  assert.equal(imported.docs[0].periodo,doc.periodo);
  assert.equal(imported.reqs[0].numero,req.numero); assert.equal(imported.docs[0].kardex,doc.kardex);
});
test('filtered exports keep real requirement usage and formulas include more than 1000 rows',()=>{
  const one={...documentBase,cargos:['C1']};
  const second={...documentBase,id:'second',kardex:'SA-00013'};
  const filtered=buildWorkbook([req],[one],[one,second],now);
  assert.equal(filtered.getWorksheet('Requerimientos').getCell('H2').value,2);
  assert.equal(filtered.getWorksheet('Requerimientos').getCell('I2').value,'Completado');
  const many=Array.from({length:1002},(_,i)=>({...one,kardex:`SA-${String(i+1).padStart(5,'0')}`}));
  const large=buildWorkbook([req],many,many,now);
  assert.ok(large.getWorksheet('Resumen').getCell('B7').value.formula.includes('A2:A1003'));
  assert.equal(large.getWorksheet('Resumen').getCell('B7').value.result,'1002 (80,160 folios)');
});
test('invalid schemas, duplicate codes and unresolved requirement references are rejected before replacement',async()=>{
  const blank=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(blank,XLSX.utils.aoa_to_sheet([['Hola']]),'Datos');
  assert.throws(()=>parseWorkbook(XLSX.write(blank,{type:'buffer',bookType:'xlsx'})),/debe contener/);
  const wb=buildWorkbook([req],[documentBase],[documentBase],now);
  wb.getWorksheet('Cargos').getCell('H2').value='REQ-99999';
  const bad=await wb.xlsx.writeBuffer();
  assert.throws(()=>parseWorkbook(bad),/no existe/);
  wb.getWorksheet('Cargos').getCell('H2').value=req.numero;
  wb.getWorksheet('Cargos').getRow(3).values=wb.getWorksheet('Cargos').getRow(2).values;
  const duplicate=await wb.xlsx.writeBuffer();
  assert.throws(()=>parseWorkbook(duplicate),/duplicado/);
});
test('numeric Excel dates and zero boxes are preserved',async()=>{
  const zero={...req,cantidadCajas:0};
  const wb=buildWorkbook([zero],[{...documentBase,cajaAsignada:''}],[],now);
  wb.getWorksheet('Cargos').getCell('D2').value=46296;
  const buffer=await wb.xlsx.writeBuffer();
  const imported=parseWorkbook(buffer);
  assert.equal(imported.reqs[0].cantidadCajas,0);
  const parsed=XLSX.SSF.parse_date_code(46296);
  assert.equal(imported.docs[0].periodo,`${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`);
});


test('large historical exports preserve every invoice and source field with unknown periods',async()=>{
  const invoices=Array.from({length:7000},(_,i)=>`F001-${String(i).padStart(7,'0')}`).join(', ');
  const historical={...documentBase,facturas:invoices,periodo:'',ubicacion:'',cajaAsignada:'',claveOrigen:'historico|source|cargo',
   hojaOrigen:'Cargos enviados 2024',anioOrigen:2024,fechaOrigen:'2024-01-01',estadoOrigen:'Origen histórico',datosOrigen:{notas:'dato de origen '.repeat(3000)}};
  const workbook=buildWorkbook([], [historical], [historical], now);
  const buffer=await workbook.xlsx.writeBuffer();
  const result=parseWorkbook(buffer);
  assert.equal(result.docs[0].facturas,invoices);assert.equal(result.docs[0].periodo,'');assert.equal(result.docs[0].ubicacion,'');
  assert.equal(result.docs[0].claveOrigen,historical.claveOrigen);assert.deepEqual(result.docs[0].datosOrigen,historical.datosOrigen);
});
