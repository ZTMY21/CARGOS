import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeShippedCargos,summarizeShippedBoxes} from '../src/im-shipped-summary.js';
const at=(date)=>new Date(date+'T12:00:00Z');
const shipment=(code,send,more={})=>({
 anioOrigen:2025,cargos:[code],imConfirmado:true,imFechaEnvio:send,
 fEnvio:'',...more
});
test('envíos cuentan en el mes efectivo, no fecha de creación',()=>{
 const docs=[shipment('10','2025-03-12',{fechaRegistro:'2026-10-05'})];
 const s=summarizeShippedCargos(docs,at('2026-10-19'));
 assert.equal(s.currentCount,0);
 assert.equal(s.annual.find(x=>x.year===2025).months[2],1);
 assert.equal(s.annual.find(x=>x.year===2026).count,0);
});
test('dos facturas del mismo cargo no suman dos envíos',()=>{
 const docs=[shipment('0010','2025-03-12'),shipment('10','2025-03-12')];
 assert.equal(summarizeShippedCargos(docs,at('2026-10-19')).total,1);
});
test('alta, baja y cambio de mes recalculan las cifras',()=>{
 const a=shipment('100','2026-10-08',{anioOrigen:2026});
 const b=shipment('101','2026-10-10',{anioOrigen:2026});
 assert.equal(summarizeShippedCargos([a],at('2026-10-19')).currentCount,1);
 assert.equal(summarizeShippedCargos([a,b],at('2026-10-19')).currentCount,2);
 assert.equal(summarizeShippedCargos([b],at('2026-10-19')).currentCount,1);
 const nov=summarizeShippedCargos([b],at('2026-11-02'));
 assert.equal(nov.currentCount,0);
 assert.equal(nov.annual.at(-1).months[9],1);
 assert.equal(nov.annual.at(-1).months[10],0);
 assert.equal(summarizeShippedCargos([b],at('2026-10-19')).annual.at(-1).months[10],null);
});
test('no cuenta una caja preparada ni un cargo sin fecha de envío',()=>{
 const prepared={anioOrigen:2026,cargos:['12'],imPreparado:true,imConfirmado:false,
   imFechaEnvio:'',fEnvio:''};
 const undated=shipment('13','');
 const s=summarizeShippedCargos([prepared,undated],at('2026-10-19'));
 assert.equal(s.total,0);
 assert.equal(s.undated,1);
});
test('admite envío con fecha fEnvio y sustento que acredita salida',()=>{
 const d={anioOrigen:2024,cargos:['15'],fEnvio:'2024-07-02',sustento:'Acta IM',imConfirmado:false};
 const s=summarizeShippedCargos([d],at('2026-10-19'));
 assert.equal(s.total,1);
 assert.equal(s.annual.find(x=>x.year===2024).months[6],1);
});
test('el total por año deriva de fecha de envío aunque el cargo pertenezca a otro año',()=>{
 const s=summarizeShippedCargos([shipment('16','2025-01-08',{anioOrigen:2022})],at('2026-10-19'));
 assert.equal(s.annual.find(x=>x.year===2025).count,1);
 assert.equal(s.annual.find(x=>x.year===2022).count,0);
});
test('el cambio de fecha mueve una barra y conserva el total',()=>{
 const first=summarizeShippedCargos([shipment('20','2025-04-01')],at('2026-10-19'));
 const second=summarizeShippedCargos([shipment('20','2025-05-02')],at('2026-10-19'));
 assert.equal(first.total,second.total);
 assert.equal(first.annual.find(x=>x.year===2025).months[3],1);
 assert.equal(second.annual.find(x=>x.year===2025).months[3],0);
 assert.equal(second.annual.find(x=>x.year===2025).months[4],1);
});
test('el año nuevo se incorpora y los meses futuros quedan vacíos',()=>{
 const s=summarizeShippedCargos([shipment('5','2027-01-03',{anioOrigen:2027})],at('2027-01-19'));
 assert.equal(s.annual.at(-1).year,2027);
 assert.equal(s.annual.at(-1).months[0],1);
 assert.equal(s.annual.at(-1).months[1],null);
});


test('cajas enviadas: una caja con cuatro cargos incrementa solo una unidad en octubre',()=>{
 const today=at('2026-10-21');
 const initial=summarizeShippedBoxes([],today);
 assert.equal(initial.currentCount,0);
 const sent=summarizeShippedBoxes([{year:2026,month:10,count:1,latest:'2026-10-21'}],today);
 assert.equal(sent.currentCount,1);
 assert.equal(sent.annual.find(x=>x.year===2026).months[9],1);
});
test('cajas por mes preservan histórico y no contabilizan mes futuro',()=>{
 const rows=[
  {year:2024,month:6,count:415,latest:'2024-06-12'},
  {year:2025,month:6,count:129,latest:'2025-06-26'},
  {year:2026,month:10,count:2,latest:'2026-10-21'},
  {year:2026,month:11,count:1,latest:'2026-11-01'}
 ];
 const today=at('2026-10-21'),s=summarizeShippedBoxes(rows,today);
 assert.equal(s.currentCount,2);
 assert.equal(s.annual.find(x=>x.year===2024).count,415);
 assert.equal(s.annual.find(x=>x.year===2025).count,129);
 assert.equal(s.annual.find(x=>x.year===2026).count,2);
 assert.equal(s.annual.find(x=>x.year===2026).months[10],null);
 const nov=summarizeShippedBoxes(rows,at('2026-11-03'));
 assert.equal(nov.currentCount,1);
 assert.equal(nov.annual.find(x=>x.year===2026).count,3);
});
